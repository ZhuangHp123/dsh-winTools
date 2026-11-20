# dsh-winTools

Windows 启动器：一个热键唤起搜索框，搜**应用**、**文件**、**剪贴板历史**，回车直接打开/复用。

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
| 直接输入 | 应用 + 文件 + 剪贴板一起搜，应用优先 |
| `文件 xxx` | 锁定只搜文件（`应用` / `剪贴板` / `apps` / `clip` 同理） |
| `~ xxx` | 快捷锁定剪贴板 |
| `↑` `↓` / `Tab` | 上下移动 |
| `Enter` | 执行：打开应用、打开文件、把剪贴板内容写回剪贴板 |
| `Esc` | 清空输入；已为空时隐藏窗口 |
| 托盘图标 | 显示搜索 / 重新索引文件 / 退出 |

热键可通过 `%APPDATA%\dsh-wintools\config.json` 的 `hotkey` 字段或环境变量
`DSH_HOTKEY` 指定，例如 `{ "hotkey": "Ctrl+Alt+K" }`。

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
- **剪贴板**：Electron 没有剪贴板变更事件，只能轮询（600ms）。Electron 45 的
  `clipboard.readText()` 返回 Promise，轮询器对同步/异步两种返回都支持。
- **安全**：渲染进程 `contextIsolation: true` + `nodeIntegration: false`；
  界面只拿渲染需要的字段，"可执行项"完整对象留在主进程，按 id 取回。

## 开发环境注意

这台机器没有 `npm` / `npx`，且 `node`、`pnpm` 的实际可执行文件路径已变化，
以 `AGENTS.md` 的「Machine facts」为准。
