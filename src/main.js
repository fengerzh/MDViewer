const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const content = document.getElementById('content');

async function dbg(msg) {
  try { await invoke('log_front', { msg }); } catch (_) { /* 日志失败不阻塞 */ }
}

// ---- 视口缩放（Cmd + / Cmd - / Cmd 0）------------------------------------
// 只对渲染结果做 transform: scale()，元素逻辑宽度不变，
// 所以字号视觉变大但换行、表格列宽、代码块宽度等排版完全不变。
// transform 不占布局尺寸，故用 #stage 的 margin-bottom + #zoom-spacer 的宽度补出滚动区。
const stage = document.getElementById('stage');
const zoomSpacer = document.getElementById('zoom-spacer');
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
let zoom = 1;

function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}

function layoutZoom() {
  if (!stage || !zoomSpacer) return;
  if (document.documentElement.classList.contains('pdf-capture')) return;
  // 分页视图下内容宽度固定为 A4 纸宽，否则取 #content 的自适应宽度
  const box = document.body.classList.contains('paged') ? document.getElementById('pages') : content;
  const vw = window.innerWidth;
  const cw = box ? box.offsetWidth : stage.offsetWidth;
  const left = box ? box.offsetLeft : 0;
  const visW = cw * zoom;
  // 缩小后正文比视口窄：水平居中；放大溢出：纸张左边界贴住视口左侧（阅读区最大化，
  // 行首仍在可视范围内）。分页纸堆 CSS 里已左对齐（left=0），故放大时无需再平移
  const dx = visW <= vw
    ? Math.round((vw - visW) / 2 - left * zoom)
    : -Math.round(left * zoom);
  stage.style.transform = 'translateX(' + dx + 'px) scale(' + zoom + ')';
  // 纵向：补足放大后多出的视觉高度，保证能滚到文档末尾
  stage.style.marginBottom = Math.round(stage.offsetHeight * (zoom - 1)) + 'px';
  // 横向：只在内容真的溢出视口时撑开滚动宽度
  zoomSpacer.style.width = (visW <= vw ? 0 : Math.ceil(cw * zoom)) + 'px';
}

function applyZoom(next) {
  const z = clampZoom(next);
  if (z === zoom) return zoom;
  // 纵向以视口中心为锚点，缩放后仍停在原阅读位置；
  // 横向保持左边界不动（中文/英文从左侧起读，横移会让人找不到行首）
  const ay = (window.scrollY + window.innerHeight / 2) / zoom;
  zoom = z;
  document.documentElement.style.setProperty('--zoom', String(z));
  layoutZoom();
  window.scrollTo(0, Math.max(0, Math.round(ay * z - window.innerHeight / 2)));
  try { localStorage.setItem('mdviewer.zoom', String(z)); } catch (_) { /* 忽略 */ }
  dbg('zoom => ' + z + ' | layoutH=' + (stage ? stage.offsetHeight : -1) + ' | contentW=' + (content ? content.offsetWidth : -1)
    + ' | scrollW=' + document.documentElement.scrollWidth + ' scrollH=' + document.documentElement.scrollHeight);
  return z;
}

window.addEventListener('keydown', (e) => {
  if (!e.metaKey && !e.ctrlKey) return;
  const k = e.key;
  let next = null;
  if (k === '=' || k === '+') next = zoom + ZOOM_STEP;
  else if (k === '-' || k === '_') next = zoom - ZOOM_STEP;
  else if (k === '0') next = 1;
  if (next === null) return;
  e.preventDefault();
  applyZoom(next);
}, true);

window.addEventListener('resize', layoutZoom);

// 内容高度变化（换文件、图片加载完成）后重新补滚动区
if (typeof ResizeObserver !== 'undefined' && stage) {
  new ResizeObserver(() => layoutZoom()).observe(stage);
}

(function initZoom() {
  try {
    const saved = parseFloat(localStorage.getItem('mdviewer.zoom'));
    if (saved && saved >= ZOOM_MIN && saved <= ZOOM_MAX) {
      zoom = saved;
      document.documentElement.style.setProperty('--zoom', String(zoom));
    }
  } catch (_) { /* 忽略 */ }
  layoutZoom();
})();

// ---- A4 分页视图 ---------------------------------------------------------
// Markdown/HTML 是连续流，本身没有"页"的概念。这里做的是「块级分页」：
// 把顶层块元素按一页的可用高度装箱，放不下就整块挪到下一页，绝不把段落/表格
// 拆到两页——视觉上等同 Word 页面视图，代价是长段落或超长表格会整块换页（A 档取舍）。
const pagesEl = document.getElementById('pages');
const PAGE_W = 794;   // A4 210mm @96dpi
const PAGE_H = 1123;  // A4 297mm @96dpi
const PAGE_PAD = 60;  // 页边距，约 16mm
const AVAIL_H = PAGE_H - PAGE_PAD * 2;
// 标题掉到页尾会与正文分家，剩余空间不足这么多时就整块换页
const ORPHAN_MIN = 96;
let paginated = false;

function newSheet() {
  const page = document.createElement('div');
  page.className = 'page';
  const inner = document.createElement('div');
  inner.className = 'doc page-inner';
  // docx 专属样式在分页后由每页的 .page-inner 继续承载
  if (content.classList.contains('docx-body')) inner.classList.add('docx-body');
  const num = document.createElement('div');
  num.className = 'page-num';
  page.appendChild(inner);
  page.appendChild(num);
  pagesEl.appendChild(page);
  return { page, inner, num };
}

// 把各页内容按原顺序搬回 #content，恢复成连续流（导出 PDF、空状态时用）
function unpaginate() {
  for (const page of Array.from(pagesEl.querySelectorAll('.page'))) {
    const inner = page.querySelector('.page-inner');
    while (inner.firstChild) content.appendChild(inner.firstChild);
  }
  pagesEl.textContent = '';
  document.body.classList.remove('paged');
  paginated = false;
}

// 空状态 / 错误提示不分页，直接铺满窗口居中显示
function isPlaceholderOnly() {
  const els = content.children;
  if (els.length !== 1) return false;
  const cls = els[0].className || '';
  return els[0].tagName === 'P' && (cls.indexOf('empty') >= 0 || cls.indexOf('error') >= 0);
}

function paginate() {
  if (document.documentElement.classList.contains('pdf-capture')) return;
  const wasAtTop = window.scrollY < 8;
  if (isPlaceholderOnly()) {
    unpaginate();
    layoutZoom();
    return;
  }
  unpaginate();
  const nodes = Array.from(content.childNodes);
  if (!nodes.length) {
    layoutZoom();
    return;
  }
  document.body.classList.add('paged');
  let cur = newSheet();
  for (const node of nodes) {
    cur.inner.appendChild(node);
    const single = cur.inner.childNodes.length === 1;
    // 本页装不下了：整块挪到新页（新页第一块不再回搬，避免死循环）
    if (!single && cur.inner.scrollHeight > AVAIL_H + 1) {
      cur.inner.removeChild(node);
      cur = newSheet();
      cur.inner.appendChild(node);
    }
    // 标题留在页尾：剩余空间连一段正文都放不下时，标题跟着换页
    if (/^H[1-6]$/.test(node.nodeName) && cur.inner.childNodes.length > 1) {
      if (AVAIL_H - cur.inner.scrollHeight < ORPHAN_MIN) {
        cur.inner.removeChild(node);
        cur = newSheet();
        cur.inner.appendChild(node);
      }
    }
    // 单块就超过一整页（长表格、长代码块）：这张纸拉长，宁可纸变长也不裁内容
    if (cur.inner.childNodes.length === 1 && cur.inner.scrollHeight > AVAIL_H + 1) {
      cur.page.classList.add('page--tall');
    }
  }
  const sheets = pagesEl.querySelectorAll('.page');
  sheets.forEach((p, i) => {
    p.querySelector('.page-num').textContent = (i + 1) + ' / ' + sheets.length;
  });
  paginated = true;
  if (wasAtTop) window.scrollTo(0, 0);
  layoutZoom();
  dbg('paginate => pages=' + sheets.length
    + ' availH=' + AVAIL_H
    + ' pageH=[' + Array.from(sheets).map((p) => p.offsetHeight).join(',') + ']'
    + ' innerH=[' + Array.from(sheets).map((p) => p.querySelector('.page-inner').scrollHeight).join(',') + ']');
}

// 图片参与布局，必须等解码完再量高度，否则分页位置会偏
async function waitImages() {
  const imgs = Array.from(content.querySelectorAll('img'));
  await Promise.all(imgs.map((img) => new Promise((res) => {
    if (img.complete) { res(); return; }
    img.addEventListener('load', res, { once: true });
    img.addEventListener('error', res, { once: true });
    setTimeout(res, 3000);  // 坏图不阻塞分页
  })));
}

// 导出 PDF 时 Rust 侧给 <html> 加 pdf-capture 类并直接测量 #content 高度，
// 所以捕获期间必须先还原成连续流，导出结束再重新分页
new MutationObserver(() => {
  const capturing = document.documentElement.classList.contains('pdf-capture');
  if (capturing) {
    if (paginated) {
      pagedBeforeCapture = true;
      unpaginate();
    }
  } else if (pagedBeforeCapture) {
    pagedBeforeCapture = false;
    paginate();
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

function stripFrontMatter(md) {
  if (!md) return md;
  // 剥离文档开头的元数据块（YAML/TOML front matter，--- 或 +++ 包裹），不修改源文档
  const m = md.match(/^\uFEFF?(---|\+\+\+)\s*[\r\n]+([\s\S]*?)[\r\n]+\1\s*(?:[\r\n]+|$)/);
  if (m) return md.slice(m[0].length);
  return md;
}

// 换文档时直接丢弃旧纸页（里面的内容本来就是旧文档的，不需要搬回）
function clearPages() {
  pagesEl.textContent = '';
  document.body.classList.remove('paged');
  content.classList.remove('docx-body');
  paginated = false;
}

async function renderHtml(md, path) {
  dbg('renderHtml enter, marked=' + typeof marked + ', mdLen=' + (md ? md.length : 0));
  clearPages();
  try {
    const html = marked.parse(stripFrontMatter(md), { gfm: true, breaks: true });
    dbg('marked.parse ok, htmlLen=' + (html ? html.length : 0));
    content.innerHTML = html;
    dbg('innerHTML set ok');
    content.querySelectorAll('pre code').forEach((b) => {
      try { hljs.highlightElement(b); } catch (_) { /* 高亮失败不阻塞 */ }
    });
    inlineImages(path);
  } catch (e) {
    dbg('renderHtml ERROR: ' + e.message + ' | stack=' + e.stack);
    content.innerHTML = '<p class="error">渲染错误：' + e.message + '</p>';
  }
  const name = path.split('/').pop();
  document.title = name ? name + ' - MDViewer' : 'MDViewer';
  await waitImages();
  paginate();
}

const IMG_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
};

// 页面源是 tauri://localhost，Markdown 里的相对路径图片无法按文档目录解析（屏幕和导出 PDF 都会破图），
// 这里把本地图片读成 base64 内联为 data URL
async function inlineImages(path) {
  const dir = path ? path.replace(/\/[^/]*$/, '') : '';
  for (const img of content.querySelectorAll('img')) {
    const raw = img.getAttribute('src') || '';
    if (!raw || /^(https?:|data:)/i.test(raw)) continue;
    let p = raw;
    try { p = decodeURI(raw); } catch (_) { /* 保留原样再试 */ }
    p = p.replace(/^file:\/\//, '');
    if (!p.startsWith('/')) {
      if (!dir) continue;
      p = dir + '/' + p;
    }
    const ext = p.includes('.') ? p.split('.').pop().toLowerCase() : '';
    const mime = IMG_MIME[ext];
    if (!mime) continue;
    try {
      const b64 = await invoke('read_file_base64', { path: p });
      if (b64) img.src = 'data:' + mime + ';base64,' + b64;
    } catch (e) {
      dbg('inlineImages fail: ' + p + ' ' + e);
    }
  }
}

function extOf(path) {
  const m = path.match(/\.([^./\\]+)$/);
  return m ? m[1].toLowerCase() : '';
}

// docx 走 mammoth 语义转换：保留标题/段落/列表/表格/内嵌图片（转 data URL），不追求版式还原
async function renderDocx(path) {
  dbg('renderDocx enter, mammoth=' + typeof mammoth);
  clearPages();
  try {
    const b64 = await invoke('read_file_base64', { path });
    dbg('docx read ok, b64Len=' + (b64 ? b64.length : 0));
    const bin = atob(b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const res = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
    // 不套 wrapper：直接把 mammoth 输出的多个块级元素铺进 #content，
    // 分页时才能逐块装页；docx 专属样式靠 #content 上的 docx-body 类承载
    content.classList.add('docx-body');
    content.innerHTML = res.value || '<p class="empty">空文档</p>';
    if (res.messages && res.messages.length) {
      const warn = res.messages.map((m) => m.message).join(' | ');
      dbg('docx warnings(' + res.messages.length + '): ' + warn.slice(0, 800));
    }
    dbg('docx converted, htmlLen=' + (res.value ? res.value.length : 0));
  } catch (e) {
    dbg('renderDocx ERROR: ' + e.message + ' | stack=' + e.stack);
    content.innerHTML = '<p class="error">docx 解析失败：' + e.message + '</p>';
  }
  const name = path.split('/').pop();
  document.title = name ? name + ' - MDViewer' : 'MDViewer';
  await waitImages();
  paginate();
}

async function openFile(path) {
  if (!path) {
    content.classList.remove('docx-body');
    content.innerHTML = '<p class="empty">没有打开的文件</p>';
    document.title = 'MDViewer';
    paginate();
    return;
  }
  if (extOf(path) === 'docx') {
    await renderDocx(path);
    return;
  }
  try {
    const md = await invoke('read_md_file', { path });
    dbg('read_md_file ok, path=' + path);
    await renderHtml(md, path);
  } catch (e) {
    content.innerHTML = '<p class="error">读取失败：' + e + '</p>';
    paginate();
  }
}

(async () => {
  dbg('main.js loaded, hasTauri=' + !!window.__TAURI__);
  const p = await invoke('get_initial_path');
  dbg('get_initial_path => ' + p);
  openFile(p);
  try {
    const unlisten = await listen('open-file', (ev) => openFile(ev.payload));
    dbg('listen open-file registered, unlisten=' + typeof unlisten);
  } catch (e) {
    dbg('listen open-file ERROR: ' + e.message + ' | stack=' + e.stack);
  }
  // 菜单「显示」→ 放大 / 缩小 / 实际大小
  try {
    await listen('zoom', (ev) => {
      const a = ev.payload;
      if (a === 'in') applyZoom(zoom + ZOOM_STEP);
      else if (a === 'out') applyZoom(zoom - ZOOM_STEP);
      else if (a === 'reset') applyZoom(1);
      else dbg('zoom event unknown payload: ' + a);
    });
    dbg('listen zoom registered');
  } catch (e) {
    dbg('listen zoom ERROR: ' + e.message);
  }
})();
