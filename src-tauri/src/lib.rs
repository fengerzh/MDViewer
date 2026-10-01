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

fn looks_like_md(p: &std::path::Path) -> bool {
    matches!(
        p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("md") | Some("markdown")
    )
}

pub fn run() {
    let app = tauri::Builder::default()
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![read_md_file, get_initial_path, log_front])
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
