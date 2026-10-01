const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const content = document.getElementById('content');

async function dbg(msg) {
  try { await invoke('log_front', { msg }); } catch (_) { /* 日志失败不阻塞 */ }
}

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
  } catch (e) {
    dbg('renderHtml ERROR: ' + e.message + ' | stack=' + e.stack);
    content.innerHTML = '<p class="error">渲染错误：' + e.message + '</p>';
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
})();
