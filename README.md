# MDViewer

极简、纯净、毫秒级响应的 macOS Markdown 纯查看器。

> 双击即看，干干净净。不弹窗、不驻留、不联网、不上传，打开就用，看完就走。

## 为什么值得一试

网上常见的 Markdown 工具要么笨重（Electron 全家桶动辄几百 MB、启动 3 秒），要么花里胡哨（侧边栏、目录树、插件市场、账号体系），打开一个文件要先等半分钟。MDViewer 反着来：

| MDViewer | 常见 Markdown 工具 |
| --- | --- |
| 双击即看，毫秒级打开 | 启动慢，首次加载数秒 |
| 单文件 9.5 MB，自包含 | 安装包数百 MB，依赖一堆运行时 |
| 零前端框架、零构建链依赖 | 需 node_modules、构建、配置 |
| 纯查看，不碰源文档 | 经常要同步、索引、云端 |
| 无后台进程、无数据上报 | 常驻后台，行为不透明 |

## 特性

- **双击即看**：macOS 文件关联，双击 `.md` 直接打开渲染，无需先开应用再拖文件
- **极速渲染**：Rust 读文件 + 轻量 marked 渲染，大文档也是瞬间出内容
- **语法高亮**：内置 highlight.js，代码块自动着色
- **自适应深浅色**：跟随系统外观，护眼不刺眼
- **自动隐藏元数据**：文档开头的 YAML/TOML front matter（如 `AIGC` 标记）渲染时自动剥离，正文干净，源文件零改动
- **运行中无缝切换**：应用已打开时再双击其他文件，当前窗口立即切换内容
- **自包含**：单个 `.app`，9.5 MB，无运行时依赖，拷贝即用

## 使用

```bash
# 双击 .md 文件（推荐，需在 Finder 中设置默认打开方式为 MDViewer）

# 或命令行直接打开
open -a MDViewer 笔记.md

# 或直接拖拽 .md 文件到 Dock 上的 MDViewer 图标
```

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

## 设计原则

- 极简：只有"打开、渲染、看"三个动作，不做编辑器、不做目录、不做同步
- 克制：不收集任何数据，不联网，无后台驻留
- 自包含：能静态放进去的绝不多引依赖

## License

MIT
