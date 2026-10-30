# MDViewer

极简、纯净、毫秒级响应的 macOS Markdown / Word 纯查看器。

> 双击即看，干干净净。不弹窗、不驻留、不联网、不上传，打开就用，看完就走。

## 为什么值得一试

网上常见的 Markdown 工具要么笨重（Electron 全家桶动辄几百 MB、启动 3 秒），要么花里胡哨（侧边栏、目录树、插件市场、账号体系），打开一个文件要先等半分钟。MDViewer 反着来：

| MDViewer | 常见 Markdown 工具 |
| --- | --- |
| 双击即看，毫秒级打开 | 启动慢，首次加载数秒 |
| 单文件 10.4 MB，自包含 | 安装包数百 MB，依赖一堆运行时 |
| 零前端框架、零构建链依赖 | 需 node_modules、构建、配置 |
| 纯查看，不碰源文档 | 经常要同步、索引、云端 |
| 无后台进程、无数据上报 | 常驻后台，行为不透明 |

## 特性

- **双击即看**：macOS 文件关联，双击 `.md` / `.docx` 直接打开渲染，无需先开应用再拖文件
- **极速渲染**：Rust 读文件 + 轻量 marked 渲染，大文档也是瞬间出内容
- **A4 页面视图**：默认按 A4 纸张分页呈现，白纸、页间距、页码 `1 / N`，观感接近 Word 页面视图；段落、表格、代码块整块装页不跨页拆分，不会被切成两半
- **Word 文档直读**：`.docx` 双击即看，mammoth 转成语义化 HTML，标题层级、列表、表格、图片都保留。已知边界：纯文本框/形状拼版式的文档（如套模板的简历）会丢失版式；旧版 `.doc`（97-2003）不支持
- **语法高亮**：内置 highlight.js，代码块自动着色
- **导出 PDF**：菜单「文件 → 导出为 PDF…」或 ⇧⌘S，A4 分页、固定浅色、文本矢量可选中；超长代码行与宽表格自动折行不截断，分页断点对齐段落/元素边界
- **视口缩放（不改排版）**：⌘+ / ⌘- 放大缩小、⌘0 回到 100%，也可用菜单「显示 → 放大 / 缩小 / 实际大小」。采用整体视觉缩放（transform）而非浏览器缩放，字号变大但换行位置、表格列宽、代码块宽度全部保持原样，不会因为放大而重新折行；放大后横向滚动查看右侧内容，缩放比例会在下次打开时记住
- **自适应深浅色**：跟随系统外观，护眼不刺眼
- **自动隐藏元数据**：文档开头的 YAML/TOML front matter（如 `AIGC` 标记）渲染时自动剥离，正文干净，源文件零改动
- **运行中无缝切换**：应用已打开时再双击其他文件，当前窗口立即切换内容
- **自包含**：单个 `.app`，10.4 MB，无运行时依赖，拷贝即用

## 下载安装

从 [GitHub Releases](https://github.com/fengerzh/MDViewer/releases) 下载最新的 `MDViewer_*.dmg`，打开后将 `MDViewer.app` 拖入「应用程序」即可，无需任何依赖。

> 未签名应用首次打开如被 Gatekeeper 拦截：右键 `MDViewer.app` → 打开；或终端执行 `xattr -cr /Applications/MDViewer.app`

## 使用

```bash
# 双击 .md / .docx 文件（推荐，需在 Finder 中设置默认打开方式为 MDViewer）

# 或命令行直接打开
open -a MDViewer 笔记.md
open -a MDViewer 报告.docx

# 或直接拖拽文件到 Dock 上的 MDViewer 图标

# 导出 PDF：菜单 文件 → 导出为 PDF…（⇧⌘S），默认文件名与原文档同名
```

### 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `⌘+` | 放大（最大 300%） |
| `⌘-` | 缩小（最小 50%） |
| `⌘0` | 恢复 100% |
| `⇧⌘S` | 导出 PDF |

## 实现要点

- **A4 分页**：把渲染结果切成纸张容器，逐块测量 `offsetHeight` 装页，超出可用页高（A4 减去上下页边距）就整体搬到下一页；分页后每页独立滚动区之外只留视觉页间距，缩放作用于整个纸张堆叠层
- **缩放不改排版**：容器套一层 `transform: scale(var(--zoom))`，DOM 布局尺寸始终不变，所以折行和列宽不会重算；用一层 spacer 撑开滚动区域，缩小后自动水平居中、放大后贴左便于从行首阅读
- **导出零干扰**：导出前给 `<html>` 加 `pdf-capture` 类，自动还原成连续流、隐藏分页层、取消缩放，让 Rust 侧量到的是 100% 布局下的真实高度

## 构建

环境要求：macOS（Apple Silicon / Intel 均可）、Rust、Node.js、Homebrew。

```bash
brew install rust node
# 安装 Tauri CLI
npm install -g @tauri-apps/cli
# 或本项目内已带 node_modules，直接：
npx tauri build
# 产物：src-tauri/target/release/bundle/macos/MDViewer.app
cp -R src-tauri/target/release/bundle/macos/MDViewer.app /Applications/
```

## 技术栈

- [Tauri 2](https://tauri.app/)（Rust 后端 + 系统 WebView，无 Chromium 打包）
- [marked](https://github.com/markedjs/marked)（Markdown 渲染）
- [highlight.js](https://highlightjs.org/)（代码高亮）
- [mammoth.js](https://github.com/mwilliamson/mammoth.js)（`.docx` → 语义化 HTML）

## 设计原则

- 极简：只有"打开、渲染、看"三个动作，不做编辑器、不做目录、不做同步
- 克制：不收集任何数据，不联网，无后台驻留
- 自包含：能静态放进去的绝不多引依赖

## License

MIT
