# dsh-winTools

Windows 启动器：一个热键唤起搜索框，搜**应用**、**项目**、**网页**、**文件**、**剪贴板历史**，回车直接打开/复用。

## 快速开始

```bash
pnpm install     # 首次或依赖变更后
pnpm start       # 启动

# 开发期打开 DevTools（窗口失去焦点不隐藏）
DSH_DEVTOOLS=1 pnpm start

# 单元测试（纯 Node，不需要 Electron）
node --test "test/*.test.js"

# 界面冒烟测试：真实 Electron 里跑一遍 搜索/键盘/剪贴板/执行，截图存 tmp/
DSH_SMOKE=1 node node_modules/electron/cli.js .
```

> Node 24.22.3 便携版在 `D:\env\node-v24.22.3-win-x64`，已加入用户级 PATH
> （新开终端直接可用）。镜像走 npmmirror，配置见 `.npmrc` / `pnpm-workspace.yaml`。
> 环境细节与已知坑见 `AGENTS.md`。

## 用法

| 操作 | 说明 |
| --- | --- |
| `Alt+Space` | 唤起/隐藏（被占用时会自动退到 `Alt+Shift+Space` → `Ctrl+Shift+Space` → ``Alt+` ``） |
| 直接输入 | 应用 + 项目 + 网页 + 文件 + 剪贴板一起搜，应用优先 |
| `项目 xxx` | 锁定只搜 IDE 项目（`网页` / `文件` / `剪贴板` / `apps` / `clip` 同理） |
| `网页 xxx` | 锁定只搜 Chrome 已打开标签页与收藏夹 |
| `文件 xxx` | 锁定只搜文件 |
| `~ xxx` | 快捷锁定剪贴板 |
| `↑` `↓` / `Tab` | 上下移动 |
| `Enter` | 执行：打开应用、用 IDEA 打开项目、切换/新开网页、打开文件、把剪贴板内容写回剪贴板 |
| `Esc` | 清空输入；已为空时隐藏窗口 |
| 托盘图标 | 显示搜索 / 重新索引文件 / 退出 |

热键可通过 `%APPDATA%\dsh-wintools\config.json` 的 `hotkey` 字段或环境变量
`DSH_HOTKEY` 指定，例如 `{ "hotkey": "Ctrl+Alt+K" }`。

### 项目（IDEA）

项目来源：IDEA 的最近项目列表（`%APPDATA%\JetBrains\IntelliJIdea*\options\recentProjects.xml`）
加上配置根目录下带 `.idea` 的目录，合并去重。默认扫描
`%USERPROFILE%\IdeaProjects`、`D:\cfDev`、`D:\code`、`D:\dev`、`D:\projects`、`D:\workspace`。

```json
{
  "projectRoots": ["D:\\cfDev", "D:\\IdeaProjects"],
  "ideaPath": "D:\\IntelliJ IDEA 2026.2.3\\bin\\idea64.exe"
}
```

两个字段都可省略：`projectRoots` 省略用默认目录，`ideaPath` 省略时自动在
`Program Files\JetBrains`、`%LOCALAPPDATA%\Programs`、Toolbox 和盘符根目录下找。

### 网页（Chrome）

两类来源，行为不同：

- **已打开标签页** — 回车**切换过去**（选中该标签页并把 Chrome 窗口切到前台），不新开。
- **收藏夹** — 回车**新开一个标签页**打开。

标签页靠 Windows UI Automation 枚举（标题、位置），URL 从 Chrome 的 `History`
库补齐；收藏夹直接读 `Bookmarks` JSON（含文件夹层级，文件夹名进 tags）。
标签页列表每 15 秒后台刷新一次，窗口唤起时也会刷新一次。

```json
{
  "chromePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "tabRefreshInterval": 15000
}
```

两个字段都可省略：`chromePath` 省略时自动在 `Program Files`、`Program Files (x86)`、
`%LOCALAPPDATA%` 下找，也可用环境变量 `DSH_CHROME` 指定；`tabRefreshInterval`
为 0 表示关闭轮询（只在唤起时刷新）。多 profile（Default / Profile N）的收藏夹都会读。

> 为什么标题里搜不到域名也能命中 `cfmoto`：页面标题通常不含域名，URL 的域名和
> 路径段会作为次级检索词参与匹配，但单独命中时分数打折，标题命中仍优先。

## 数据位置

全部在 `%APPDATA%\dsh-wintools\`：

- `usage.json` — 使用频次（排序用的 frecency）
- `cache/file-index.json` — 文件索引缓存（下次启动秒开）
- `clipboard.json` — 剪贴板历史（最多 200 条，单条上限 8000 字符）
- `config.json` — 可选配置

## 目录

```
src/
├── core/          纯逻辑，无 Electron 依赖，全部可单测
│   ├── engine.js     provider 调度 + 超时 + 查询串行化
│   ├── query.js      输入解析（provider 锁定语法）
│   ├── fuzzy.js      模糊匹配打分
│   ├── rank.js       排序（匹配分 + frecency + provider 权重）
│   └── usage.js      使用频次存储
├── apps/          开始菜单 .lnk 扫描与启动
├── projects/      IDE 项目发现与用 IDEA 打开
├── web/           Chrome 标签页（UIA）与收藏夹搜索
├── files/         文件索引（缓存式，worker 后台扫盘）
├── clipboard/     剪贴板历史（轮询，去重，置顶）
├── main/          Electron 主进程
│   ├── main.js       窗口 / 热键 / 托盘 / IPC / 数据落盘
│   ├── preload.js    contextBridge 暴露的 4 个方法
│   ├── hotkey.js     热键候选链
│   ├── persistence.js JSON 缓存原子写
│   ├── workerScan.js 扫描 worker 封装（含降级）
│   ├── scanWorker.js worker 线程入口
│   └── smoke.js      界面冒烟脚本（DSH_SMOKE=1）
└── renderer/     搜索界面（HTML/CSS/JS，无框架）
assets/           托盘与应用图标
test/             node:test 单元测试
```

## 架构要点

- **provider 契约**：`{ id, aliases, label, init?, search(terms), activate?(item), stats?, dispose? }`。
  engine 对每个 provider 独立超时（1.5s），慢的不拖累快的；后用发起的查询作废前一轮结果。
- **文件索引**：启动先用缓存，同时在 worker 线程扫盘（桌面/文档/下载优先，再整盘，
  默认排除 `node_modules`/`.git`/`AppData` 等）。本机约 3.8 万文件、几秒完成。
- **项目**：启动时同步扫描（本机 5ms），来源为 IDEA 最近项目列表 + 带 `.idea`
  的目录；回车 `idea64.exe <路径>`，detached 启动，IDE 生命周期不挂在启动器上。
- **剪贴板**：Electron 没有剪贴板变更事件，只能轮询（600ms）。Electron 45 的
  `clipboard.readText()` 返回 Promise，轮询器对同步/异步两种返回都支持。
- **网页**：走三条本地通道，不依赖调试端口。标签页/位置用 UI Automation 枚举，
  URL 用 Chrome `History` 库按标题回填（`immutable=1` 只读打开，避开锁），
  收藏夹读 `Bookmarks` JSON。枚举时必须按 `Get-Process chrome` 的 PID 过滤窗口：
  Electron 系应用（VS Code/Cursor/Qoder）窗口类名同为 `Chrome_WidgetWin_1`，
  不加过滤会去遍历它们的无障碍树，卡死数十秒。切换标签页用
  `SelectionItemPattern.Select()` + `SetForegroundWindow`（配合 `AttachThreadInput`）。
- **安全**：渲染进程 `contextIsolation: true` + `nodeIntegration: false`；
  界面只拿渲染需要的字段，"可执行项"完整对象留在主进程，按 id 取回。

## 开发环境注意

这台机器没有 `npm` / `npx`，且 `node`、`pnpm` 的实际可执行文件路径已变化，
以 `AGENTS.md` 的「Machine facts」为准。
