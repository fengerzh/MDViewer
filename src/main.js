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
  const vw = window.innerWidth;
  const cw = content ? content.offsetWidth : stage.offsetWidth;
  const left = content ? content.offsetLeft : 0;
  const visW = cw * zoom;
  // 缩小后正文比视口窄：水平居中；放大溢出：保持左上原点，向右下方扩展以便滚动查看
  const dx = visW <= vw ? Math.round((vw - visW) / 2 - left * zoom) : 0;
  stage.style.transform = 'translateX(' + dx + 'px) scale(' + zoom + ')';
  // 纵向：补足放大后多出的视觉高度，保证能滚到文档末尾
  stage.style.marginBottom = Math.round(stage.offsetHeight * (zoom - 1)) + 'px';
  // 横向：只在内容真的溢出视口时撑开滚动宽度
  zoomSpacer.style.width = (dx > 0 ? 0 : Math.max(0, Math.ceil((left + cw) * zoom))) + 'px';
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

function stripFrontMatter(md) {
  if (!md) return md;
  // 剥离文档开头的元数据块（YAML/TOML front matter，--- 或 +++ 包裹），不修改源文档
  const m = md.match(/^\uFEFF?(---|\+\+\+)\s*[\r\n]+([\s\S]*?)[\r\n]+\1\s*(?:[\r\n]+|$)/);
  if (m) return md.slice(m[0].length);
  return md;
}

function renderHtml(md, path) {
  dbg('renderHtml enter, marked=' + typeof marked + ', mdLen=' + (md ? md.length : 0));
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
  try {
    const b64 = await invoke('read_file_base64', { path });
    dbg('docx read ok, b64Len=' + (b64 ? b64.length : 0));
    const bin = atob(b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const res = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
    content.innerHTML = '<div class="docx-body">' + res.value + '</div>';
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
}

async function openFile(path) {
  if (!path) {
    content.innerHTML = '<p class="empty">没有打开的文件</p>';
    document.title = 'MDViewer';
    return;
  }
  if (extOf(path) === 'docx') {
    await renderDocx(path);
    return;
  }
  try {
    const md = await invoke('read_md_file', { path });
    dbg('read_md_file ok, path=' + path);
    renderHtml(md, path);
  } catch (e) {
    content.innerHTML = '<p class="error">读取失败：' + e + '</p>';
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
