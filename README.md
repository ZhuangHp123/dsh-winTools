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
| 直接输入 | 应用 + 项目 + 网页 + 联系人 + 文档 + 文件 + 剪贴板一起搜，应用优先 |
| `项目 xxx` | 锁定只搜 IDE 项目（`网页` / `联系人` / `文档` / `文件` / `剪贴板` 同理） |
| `网页 xxx` | 锁定只搜 Chrome 已打开标签页与收藏夹 |
| `联系人 xxx` | 锁定搜钉钉同事（首次需要授权） |
| `文档 xxx` | 锁定搜钉钉文档（只返回你有权限的） |
| `文件 xxx` | 锁定只搜文件 |
| `~ xxx` | 快捷锁定剪贴板 |
| `↑` `↓` / `Tab` | 上下移动 |
| `Enter` | 执行：打开应用、用 IDEA 打开项目、切换/新开网页、打开钉钉聊天、打开文档、打开文件、把剪贴板内容写回剪贴板 |
| `Esc` | 清空输入；已为空时隐藏窗口 |
| 托盘图标 | 显示搜索 / 重新索引文件 / 登录钉钉 / 退出 |

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

### 钉钉（联系人 / 文档）

**联系人的数据来自本机钉钉客户端**：启动时解密 `%APPDATA%\DingTalk\<hash>_v3\DBFiles\dingtalk.db`
（AES-128-ECB，密钥由"自己的数字 uid + `user_config` 里的 salt"推出来，算法同开源项目
[dingwave-V3](https://github.com/E2ern1ty/dingwave-V3)），读出 500 多人的姓名、组织、
数字 uid。好处是搜索零延迟、不用授权，回车能**一步跳到会话**：
客户端内部的 `page/conversation?cid=<小uid>:<大uid>` 协议实测 150ms 就落到正确聊天，
不经过搜索面板，用户看不到任何中间过程。

以前走的搜索面板方案（点搜索框 → 粘姓名 → 等结果 → 回车，4~5 秒）仍然保留，
只作为兜底：本地没有这个人（比如别的组织的同事）时才用。

- **联系人** — 结果左边是该同事的**真实头像**（和钉钉客户端里一致）。头像资源名在
  本地库 `tbuser_profile_v2.iconMediaId`，客户端的 `AvatarFiles` 目录里缓存了渲染过的
  缩略图，命中就直接读本地文件；没缓存过的按 mediaId 里编码的原图尺寸从
  `static.dingtalk.com` 补，补齐后落盘复用。库里没有头像 ID 的（少数账号）退回
  名字首字色块（中文名取后两字，如 张三丰 → 三丰）。回车直接打开单聊；
  钉钉客户端需要在运行，没登录也没关系，协议会把登录页拉起来。
- **文档** — 走官方 MCP 网关（`https://mcp-gw.dingtalk.com/oauth/server/doc`），
  权限判断在服务端做，没权限的搜不到。回车先用钉钉内置浏览器打开（复用登录态），
  不行再退系统浏览器；真打不开时状态栏会报"可能没有访问权限"。

本地库里没有的人会退回 MCP 网关查（需要 OAuth，见下）。服务端的命中规则更宽松：
联系人支持拼音首字母（`hp` 能命中"庄浩鹏"），文档按正文检索（标题里可能完全没有
关键词）。这类结果本地模糊匹配不出来，所以远程结果会带一个保底分直接展示，
但仍排在本地标题命中之后。

首次使用需要授权一次（只有"本地没有的人/文档"才需要）：托盘菜单「登录钉钉」，
或者第一次远程搜索时自动弹出浏览器。流程是标准 OAuth 2.1：动态注册本机
客户端（RFC 7591）→ PKCE S256 → 回环回调 `http://127.0.0.1:<随机端口>/callback`
（RFC 8252），请求里带 `resource` 指示器（RFC 8707）。两个端点作用域独立，
各存一份 token 在 `%APPDATA%\dsh-wintools\cache\dingtalk-*-token.json`，过期自动刷新。

**性能**：联系人搜索全在内存里（本地库读一次约 700ms，之后零延迟）；
文档普通搜索（不锁定）只匹配本地缓存，只有 `文档 xxx` 才走网络，结果会写进缓存，
同一关键词 90 秒内不重复请求。文档命中过哪些关键词会一起记进缓存——服务端按正文
检索，标题里常常没有关键词，不记住就再也找不回来了。单字中文（`文档 需`）会查网络，
纯西文单字符不会。

两个端点默认已配好，`config.json` 里可以覆盖：

```json
{
  "dingtalk": {
    "contactsUrl": "https://mcp-gw.dingtalk.com/oauth/server/contact",
    "docsUrl": "https://mcp-gw.dingtalk.com/oauth/server/doc"
  }
}
```

> 为什么没有群聊搜索：网关的 `group` 端点实测只提供 `create_internal_org_group`
> （建群），没有群聊检索工具，`im` / `robot` 端点则不存在。群聊相关代码已移除。

## 数据位置

全部在 `%APPDATA%\dsh-wintools\`：

- `usage.json` — 使用频次（排序用的 frecency）
- `cache/file-index.json` — 文件索引缓存（下次启动秒开）
- `cache/dingtalk-*` — 钉钉 token 与联系人/文档缓存
- `cache/dingtalk-avatars/` — 从 CDN 补齐的钉钉头像（按 mediaId 命名）
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
├── dingtalk/      钉钉联系人/文档（本地库索引 + 头像 + MCP 网关兜底 + OAuth）
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
- **钉钉**：联系人读本地加密库（`localIndex.js`），文档走官方 MCP 网关。
  本地库是 AES-128-ECB，密钥 `MD5(PBKDF2(自己的数字 uid + salt, "666DingT"))`
  的十六进制前 16 位**当 ASCII 字节**用（不是 hex 解码，那样只有 8 字节，解密全错）。
  自己的数字 uid 不在任何明文配置里：先用日志中 `uid=` 出现次数最多的几个候选
  逐个试解 4KB 文件头，能解出 `SQLite format 3` 的就是。单聊 cid 是两人数字 uid
  **按数值升序**用冒号拼接，顺序反了客户端只显示空白会话面板。
  MCP 网关不接受静态 key，走标准 OAuth 2.1（动态注册 + PKCE + 回环回调，
  RFC 8252/7591/8707），只有本地查不到的人才用。权限判断全在服务端，天然不会越权。
  远程检索由服务端完成，命中规则比本地宽松：带 `serverMatched` 标记的条目走
  `rank.js` 的保底分，否则拼音/正文命中会被本地模糊匹配误杀。
- **头像**（`avatars.js`）：mediaId 前导 `@` 去掉就是资源名，客户端 `AvatarFiles`
  里缓存了 `<mediaId>_<原图宽>_<原图高>.<ext>` 和对应的 `_60x60q90` 缩略图，
  直接读文件转 data URL。没缓存的人从 CDN 补：原图尺寸编在 mediaId 里（若干
  `0xCD + 大端 u16` 对，最后两对是高和宽），拼成
  `media/<id>_<w>_<h>.<ext>_<缩放后缀>.<ext>`。缩放后缀随格式而变（jpg 用
  `_75x75q90_xz`、png 用 `_60x60q90`），带错了就 404，所以两种都试。
  搜索时本地命中的头像同步带上；没命中的异步补，不拖慢按键。

## 开发环境注意

这台机器没有 `npm` / `npx`，且 `node`、`pnpm` 的实际可执行文件路径已变化，
以 `AGENTS.md` 的「Machine facts」为准。
