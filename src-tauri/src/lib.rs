use std::{fs, path::PathBuf, sync::Mutex};

use tauri::{Emitter, Manager, RunEvent};

/// 追加一行日志到 ~/Library/Logs/mdviewer.log，便于排查双击打开链路
fn log_line(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::home_dir().unwrap_or_default().join("Library/Logs/mdviewer.log"))
    {
        let _ = writeln!(f, "{}", msg);
    }
}

/// 当前要显示的文件（命令行参数或系统打开事件传入）
struct InitialFile(Mutex<Option<PathBuf>>);

/// 读取 markdown 文件内容
#[tauri::command]
fn read_md_file(path: String) -> Result<String, String> {
    let r = fs::read_to_string(&path).map_err(|e| e.to_string());
    log_line(&format!("[read_md_file] path={} result={:?}", path, r.as_ref().map(|s| s.len())));
    r
}

/// 返回初始打开的文件路径（如有）
#[tauri::command]
fn get_initial_path(state: tauri::State<'_, InitialFile>) -> Option<String> {
    let v = state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    log_line(&format!("[get_initial_path] value={:?}", v));
    v
}

/// 前端上报调试日志
#[tauri::command]
fn log_front(msg: String) {
    log_line(&format!("[front] {}", msg));
}

/// 读取本地文件返回 base64（前端把 Markdown 相对路径图片内联为 data URL）
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    log_line(&format!("[read_file_base64] path={} len={}", path, bytes.len()));
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn looks_like_md(p: &std::path::Path) -> bool {
    matches!(
        p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("md") | Some("markdown")
    )
}

/// A4 纸宽（pt），导出时 WebView 以此宽度重排，正文列宽 = 纸宽 - 两侧边距
#[cfg(target_os = "macos")]
const A4_WIDTH: f64 = 595.28;

/// 在主线程上短暂泵主 run loop（等待 WebKit 重排/回调）
#[cfg(target_os = "macos")]
fn pump_main_run_loop(seconds: f64) {
    use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSRunLoop};

    let run_loop = NSRunLoop::currentRunLoop();
    let date = NSDate::dateWithTimeIntervalSinceNow(seconds);
    unsafe {
        run_loop.runMode_beforeDate(NSDefaultRunLoopMode, &date);
    }
}

/// 带回调地执行 JS 并取返回字符串（JSON）
#[cfg(target_os = "macos")]
unsafe fn eval_js_sync(
    wk: &objc2_web_kit::WKWebView,
    js: &str,
    timeout_secs: f64,
) -> Result<String, String> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSError, NSString};

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let handler: block2::RcBlock<dyn Fn(*mut AnyObject, *mut NSError)> = block2::RcBlock::new(
        move |val: *mut AnyObject, err: *mut NSError| {
            let res = if !val.is_null() {
                let s = Retained::cast_unchecked::<NSString>(Retained::retain(val).unwrap());
                Ok(s.to_string())
            } else if !err.is_null() {
                Err((*err).localizedDescription().to_string())
            } else {
                Err("JS 求值无结果".into())
            };
            let _ = tx.send(res);
        },
    );
    wk.evaluateJavaScript_completionHandler(&NSString::from_str(js), Some(&handler));

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs_f64(timeout_secs);
    loop {
        match rx.try_recv() {
            Ok(v) => return v,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => return Err("JS 回调丢失".into()),
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                if std::time::Instant::now() > deadline {
                    return Err("JS 求值超时".into());
                }
                pump_main_run_loop(0.05);
            }
        }
    }
}

/// 把当前 Web 视图渲染内容导出为 A4 分页 PDF。
/// WebKit 打印管线（printOperationWithPrintInfo + 无面板落盘）实测静默输出空文件/死锁
/// （社区已知问题），故改用公开 API createPDF：
/// 切换 pdf-capture 样式类 → 视图宽度调成 A4 触发重排 → 测量内容高度/安全断点 →
/// 整页矢量捕获 → CoreGraphics 按安全断点切片成 A4 页 → 还原视图。
/// 必须在主线程调用（with_webview 已保证）。
#[cfg(target_os = "macos")]
unsafe fn print_webview_to_pdf(
    webview: &tauri::webview::PlatformWebview,
    pdf_path: &std::path::Path,
) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSView;
    use objc2_foundation::{NSError, NSPoint, NSRect, NSSize};
    use objc2_web_kit::{WKPDFConfiguration, WKWebView};

    // PlatformWebview::inner() 返回 WKWebView 裸指针
    let raw = webview.inner() as *mut WKWebView;
    let view = Retained::retain(raw).ok_or("无法获取 Web 视图")?;
    let mtm = MainThreadMarker::new_unchecked();
    let ns_view: Retained<NSView> = Retained::cast_unchecked(view.clone());
    let orig_frame = ns_view.frame();

    // 1) 切换导出样式（强制浅色、代码/表格折行）
    let _ = eval_js_sync(&view, "document.documentElement.classList.add('pdf-capture'); 'ok'", 5.0)?;
    pump_main_run_loop(0.3);

    // 1.5) 等待图片加载完成：轮询 document.images 的 complete 标志。
    // evaluateJavaScript 不支持 Promise 返回值（WebKit 会报 unsupported type），JS 必须保持纯同步。
    // 图片参与布局且影响内容高度与分页断点；超时继续导出（坏图不阻塞）
    {
        use std::time::Instant;
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let pending = eval_js_sync(
                &view,
                "[...document.images].filter(i => !i.complete).length + ''",
                5.0,
            )?
            .trim()
            .trim_matches('"')
            .to_string();
            if pending == "0" || Instant::now() > deadline {
                break;
            }
            pump_main_run_loop(0.1);
        }
    }

    // 2) 宽度调成 A4 触发重排
    ns_view.setFrame(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(A4_WIDTH, orig_frame.size.height),
    ));
    pump_main_run_loop(0.3);

    // 3) 测量内容总高与块级安全断点（相对文档顶部的 y 坐标）
    let layout_json = eval_js_sync(
        &view,
        r#"(() => {
            const c = document.getElementById('content');
            if (!c) return JSON.stringify({ h: 0, offsets: [] });
            const o = [];
            for (const el of c.children) {
                const r = el.getBoundingClientRect();
                o.push(Math.round(r.bottom + window.scrollY));
            }
            return JSON.stringify({ h: Math.round(document.documentElement.scrollHeight), offsets: o });
        })()"#,
        5.0,
    )?;
    let layout: serde_json::Value = serde_json::from_str(&layout_json).map_err(|e| e.to_string())?;
    let content_height = layout["h"].as_f64().unwrap_or(0.0);
    if content_height < 1.0 {
        return Err("页面内容为空".into());
    }
    log_line(&format!(
        "[export-pdf] content_height={} offsets={}",
        content_height,
        layout["offsets"]
    ));

    // 4) 高度拉到全内容高度（滚动条消失，避免进 PDF），等待重排
    ns_view.setFrame(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(A4_WIDTH, content_height),
    ));
    pump_main_run_loop(0.35);

    // 5) 整页矢量捕获（单张与内容等高的长页）
    let config = WKPDFConfiguration::new(mtm);
    config.setRect(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(A4_WIDTH, content_height),
    ));
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    let handler: block2::RcBlock<
        dyn Fn(*mut objc2_foundation::NSData, *mut NSError),
    > = block2::RcBlock::new(
        move |data: *mut objc2_foundation::NSData, err: *mut NSError| {
            let res = if !data.is_null() {
                let d = &*data;
                let mut buf = vec![0u8; d.length()];
                if !buf.is_empty() {
                    d.getBytes_length(std::ptr::NonNull::new_unchecked(buf.as_mut_ptr().cast()), buf.len());
                }
                Ok(buf)
            } else if !err.is_null() {
                Err((*err).localizedDescription().to_string())
            } else {
                Err("createPDF 返回空数据".into())
            };
            let _ = tx.send(res);
        },
    );
    view.createPDFWithConfiguration_completionHandler(Some(&config), &handler);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let pdf_data = loop {
        match rx.try_recv() {
            Ok(v) => break v,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                return Err("PDF 捕获回调丢失".into())
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                if std::time::Instant::now() > deadline {
                    return Err("PDF 捕获超时".into());
                }
                pump_main_run_loop(0.05);
            }
        }
    }?;

    // 6) 还原视图与样式
    ns_view.setFrame(orig_frame);
    let _ = eval_js_sync(
        &view,
        "document.documentElement.classList.remove('pdf-capture'); 'ok'",
        5.0,
    );

    // 7) 按安全断点切成 A4 页写出
    let offsets: Vec<f64> = layout["offsets"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_f64()).collect())
        .unwrap_or_default();
    slice_pdf_to_a4(&pdf_data, &offsets, content_height, pdf_path)?;
    Ok(())
}

/// 把整页捕获的长 PDF 按 A4 高度切片为多页。
/// 断点优先取 JS 测出的块级边界（safe_offsets，文档顶部向下的 y 坐标），
/// 避免文字行/表格被从中间切开；单块超过可打印高度时才硬切。
#[cfg(target_os = "macos")]
fn slice_pdf_to_a4(
    pdf_data: &[u8],
    safe_offsets: &[f64],
    content_height: f64,
    pdf_path: &std::path::Path,
) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2_core_foundation::{CFData, CFURL, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGContext, CGPDFBox, CGPDFContextCreateWithURL, CGDataProvider, CGPDFDocument, CGPDFPage,
    };
    use objc2_foundation::{NSData, NSString, NSURL};

    const A4_H: f64 = 841.89;
    const MARGIN_V: f64 = 48.0;
    let usable = A4_H - 2.0 * MARGIN_V;

    // 源文档：createPDF 产出的单张长页
    let ns_data =
        unsafe { NSData::dataWithBytes_length(pdf_data.as_ptr().cast(), pdf_data.len()) };
    // NSData/NSURL 与 CFData/CFURL 是 toll-free bridge，指针同体可安全互转
    let cf_data: Retained<CFData> = unsafe { Retained::cast_unchecked(ns_data) };
    let provider = CGDataProvider::with_cf_data(Some(&cf_data)).ok_or("无法读取捕获数据")?;
    let doc = CGPDFDocument::with_provider(Some(&provider)).ok_or("无法解析捕获 PDF")?;
    let page = CGPDFDocument::page(Some(&doc), 1).ok_or("捕获 PDF 无页面")?;
    let src_h = CGPDFPage::box_rect(Some(&page), CGPDFBox::MediaBox).size.height;

    // 分页断点
    let mut bands: Vec<(f64, f64)> = Vec::new();
    let mut y_t = 0.0f64;
    while content_height - y_t > usable + 0.5 {
        let ideal = y_t + usable;
        let mut next = ideal;
        for &o in safe_offsets {
            if o > y_t + 1.0 && o <= ideal {
                next = next.max(o);
            }
        }
        let next = next.min(content_height);
        bands.push((y_t, next));
        y_t = next;
    }
    bands.push((y_t, content_height));

    // 输出 A4 页
    let path_str = NSString::from_str(&pdf_path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path_str);
    let cf_url: Retained<CFURL> = unsafe { Retained::cast_unchecked(url) };
    let media_box = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(A4_WIDTH, A4_H));
    let ctx = unsafe { CGPDFContextCreateWithURL(Some(&cf_url), &media_box, None) }
        .ok_or("无法创建输出 PDF")?;

    for &(top, bottom) in &bands {
        let bh = (bottom - top).min(usable);
        // 目标页上：条带顶边距上边距 MARGIN_V；源页坐标原点在左下，需换算平移量
        let dest_bottom = A4_H - MARGIN_V - bh;
        let clip_rect = CGRect::new(CGPoint::new(0.0, dest_bottom), CGSize::new(A4_WIDTH, bh));
        let src_bottom = src_h - bottom;
        unsafe {
            CGContext::begin_page(Some(&ctx), std::ptr::null());
            CGContext::save_g_state(Some(&ctx));
            CGContext::clip_to_rect(Some(&ctx), clip_rect);
            CGContext::translate_ctm(Some(&ctx), 0.0, dest_bottom - src_bottom);
            CGContext::draw_pdf_page(Some(&ctx), Some(&page));
            CGContext::restore_g_state(Some(&ctx));
            CGContext::end_page(Some(&ctx));
        }
    }
    drop(ctx); // 释放 PDF 上下文，落盘

    log_line(&format!(
        "[export-pdf] sliced {} bands (src_h={} content_h={})",
        bands.len(),
        src_h,
        content_height
    ));
    Ok(())
}

/// 执行导出：把捕获/切片任务派发到主线程，等待结果并回执。
fn run_export(app: &tauri::AppHandle, pdf_path: PathBuf) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    let Some(webview) = app.get_webview_window("main") else {
        app.dialog()
            .message("找不到主窗口")
            .kind(MessageDialogKind::Error)
            .show(|_| {});
        return;
    };

    // 导出前把窗口拉到前台，保证渲染内容是最新的可见状态
    let _ = webview.show();
    let _ = webview.set_focus();

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let target = pdf_path.clone();
    if let Err(e) = webview.with_webview(move |wv| {
        #[cfg(target_os = "macos")]
        let res = unsafe { print_webview_to_pdf(&wv, &target) };
        #[cfg(not(target_os = "macos"))]
        let res = Err::<(), String>("仅 macOS 支持导出 PDF".into());
        let _ = tx.send(res);
    }) {
        log_line(&format!("[export-pdf] with_webview error: {e}"));
        app.dialog()
            .message(format!("导出失败：{e}"))
            .kind(MessageDialogKind::Error)
            .show(|_| {});
        return;
    }

    match rx.recv_timeout(std::time::Duration::from_secs(120)) {
        Ok(Ok(())) => {
            let size = fs::metadata(&pdf_path).map(|m| m.len()).unwrap_or(0);
            log_line(&format!("[export-pdf] ok -> {} ({} bytes)", pdf_path.display(), size));
            app.dialog()
                .message(format!("已导出到：\n{}", pdf_path.display()))
                .show(|_| {});
        }
        Ok(Err(e)) => {
            log_line(&format!("[export-pdf] error: {}", e));
            app.dialog()
                .message(format!("导出失败：{e}"))
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
        Err(_) => {
            log_line("[export-pdf] timeout");
            app.dialog()
                .message("导出超时，请重试")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    }
}

/// 导出入口：菜单事件在主线程触发，而 rfd 的 blocking 对话框禁止在主线程调用，
/// 整条导出链路（保存面板 -> 打印）放到独立线程执行。
/// preset_path 用于自动化测试（跳过保存面板直接写指定路径）。
fn start_export(app: tauri::AppHandle, preset_path: Option<PathBuf>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    std::thread::spawn(move || {
        let current = app
            .try_state::<InitialFile>()
            .and_then(|s| s.0.lock().unwrap().clone());
        let Some(src) = current else {
            app.dialog()
                .message("没有打开的文件")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
            return;
        };

        let pdf_path = match preset_path {
            Some(p) => p,
            None => {
                let default_name = format!(
                    "{}.pdf",
                    src.file_stem().and_then(|s| s.to_str()).unwrap_or("untitled")
                );
                let mut builder = app
                    .dialog()
                    .file()
                    .add_filter("PDF", &["pdf"])
                    .set_file_name(default_name);
                if let Some(dir) = src.parent() {
                    builder = builder.set_directory(dir);
                }
                match builder.blocking_save_file() {
                    Some(fp) => match fp.into_path() {
                        Ok(p) => p,
                        Err(e) => {
                            log_line(&format!("[export-pdf] invalid path: {e}"));
                            return;
                        }
                    },
                    None => return, // 用户取消
                }
            }
        };
        run_export(&app, pdf_path);
    });
}

/// 文件菜单：插入「导出为 PDF…」。保留 tauri 默认菜单（App/Edit/View 等），
/// macOS 上 Edit 菜单承载 ⌘C/⌘V 等快捷键，不能被自定义菜单替换掉。
/// 注意：默认 File 子菜单的 MenuId 是随机生成的，只能按标题文本查找，不能 get("File")。
#[cfg(target_os = "macos")]
fn setup_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    let menu = Menu::default(app)?;
    let export =
        MenuItem::with_id(app, "export-pdf", "导出为 PDF…", true, Some("CmdOrControl+Shift+S"))?;
    let mut inserted = false;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(s) = &item {
            let title = s.text().unwrap_or_default();
            log_line(&format!("[setup_menu] top-level submenu: {title:?}"));
            if title.trim() == "File" {
                s.insert(&export, 0)?;
                inserted = true;
                break;
            }
        }
    }
    log_line(&format!("[setup_menu] export item inserted={inserted}"));
    app.set_menu(menu)?;
    Ok(())
}

/// 自动化测试钩子：设置 MDVIEWER_EXPORT_PDF_ON_START=/path/out.pdf 时，
/// 启动 2.5 秒后（等前端渲染完）自动导出到指定路径，跳过保存面板。
#[cfg(target_os = "macos")]
fn maybe_auto_export(app: &tauri::AppHandle) {
    if let Ok(p) = std::env::var("MDVIEWER_EXPORT_PDF_ON_START") {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(2500));
            log_line(&format!("[auto-export] -> {}", p));
            start_export(app, Some(PathBuf::from(p)));
        });
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(InitialFile(Mutex::new(None)))
        .setup(|app| {
            // 命令行方式：mdviewer xxx.md
            let args: Vec<String> = std::env::args().collect();
            log_line(&format!("[setup] args={:?}", args));
            if let Some(p) = args
                .iter()
                .skip(1)
                .map(PathBuf::from)
                .find(|p| looks_like_md(p))
            {
                let abs = p.canonicalize().unwrap_or(p);
                log_line(&format!("[setup] found md from args: {}", abs.display()));
                *app.state::<InitialFile>().0.lock().unwrap() = Some(abs);
            }
            #[cfg(target_os = "macos")]
            {
                setup_menu(app.handle())?;
                maybe_auto_export(app.handle());
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            #[cfg(target_os = "macos")]
            if event.id().as_ref() == "export-pdf" {
                start_export(app.clone(), None);
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_md_file,
            get_initial_path,
            log_front,
            read_file_base64
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // macOS 系统打开文件事件（双击关联）
        if let RunEvent::Opened { urls } = event {
            log_line(&format!("[opened] urls={:?}", urls));
            for url in urls {
                if url.scheme() == "file" {
                    if let Ok(p) = url.to_file_path() {
                        if looks_like_md(&p) {
                            let abs = p.canonicalize().unwrap_or(p);
                            *app_handle.state::<InitialFile>().0.lock().unwrap() = Some(abs.clone());
                            let emit_ok = app_handle.emit("open-file", abs.to_string_lossy().to_string());
                            log_line(&format!("[opened] emit open-file {} ok={:?}", abs.display(), emit_ok));
                        } else {
                            log_line(&format!("[opened] skip non-md: {}", p.display()));
                        }
                    }
                }
            }
        }
    });
}
