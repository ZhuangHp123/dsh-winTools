# AGENTS.md

本工作区的操作说明。动手前先读——这台机器 PATH 不完整，很多"应该存在"的工具
实际不存在，或者存在但坏了。

## 这个仓库是什么

Windows 启动器：热键唤起 → 搜应用 / 文件 / 剪贴板 → 回车执行。
技术栈：Electron 45（运行时）+ 原生 JS，无框架、无打包步骤，`node --test` 跑单测。

```bash
pnpm start                              # 启动
node --test "test/*.test.js"            # 单测
DSH_SMOKE=1 node node_modules/electron/cli.js .   # 界面冒烟（截图到 tmp/）
```

## Machine facts

| 用途 | 用这个 |
| --- | --- |
| Node | `D:\env\node-v24.22.3-win-x64\node.exe`（v24.22.3，便携版）。2026-11-20 已加入用户级 PATH，新开的终端直接 `node` 可用；当前已打开的终端需重开 |
| npm / npx | 同上目录，`npm.cmd` 11.19.1 / `npx.cmd` |
| pnpm | 同上目录，`pnpm.exe` 12.21.0（原生 Rust 版）。`~/.local/bin/pnpm.cmd` 也已修好 |
| Electron 运行时 | `D:\dsh-winTools\node_modules\electron\dist\electron.exe`（45.3.4） |
| 测试（JS） | `node --test`（内置，零安装） |
| Python（通用） | `C:\Users\zhuanghp\AppData\Local\Programs\Python\Python313\python.exe`（装了 pytest、Pillow） |
| PowerShell | `pwsh`（7.x）；另有 Windows PowerShell 5.1，CurrentUser 策略已设 RemoteSigned，`.ps1` shim 可运行 |
| Shell | bash（MSYS）。不是 Linux：`/tmp` 不是真的临时目录，`D:/x` 可用 |

缺失，别再找：`docker`、`sqlite3` CLI、`unzip`/`7z`（Windows 自带 tar 不认 zip，
解 zip 用 Python 的 `zipfile`）、`gh`、Go、Rust。MySQL 没跑在 3306。

**系统 PATH 里仍有三条失效项**（`C:\nvm`、`C:\nvm4w\nodejs`、`C:\Users\wxj\...`）——
`nvm4w\nodejs` 是指向别的用户目录的符号链接，无权限。改机器级 PATH 需要管理员权限，
未动；靠用户级 PATH 里的新 Node 目录在前生效。

**`python3` 是 Microsoft Store 的占位 stub。** 退出码 0，什么都不打印——任何脚本
用它都会静默拿到空结果。永远用 `python` 或上表的绝对路径。

**pnpm 相关：**
- pnpm 12 不再读 `package.json` 的 `pnpm` 字段，配置写进 `pnpm-workspace.yaml`
  （本仓库已设 `verifyDepsBeforeRun: false`、`onlyBuiltDependencies: [electron]`）。
- 镜像在 `.npmrc`（npmmirror）。首次装 electron 时二进制要单独跑一次
  `node node_modules/.pnpm/electron@*/node_modules/electron/install.js`
  （设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`），
  因为 pnpm 从 store 复用包时会跳过它的 postinstall。
- **坑：Qoder CN 编辑器会长期锁定 `node_modules/electron/dist/resources/default_app.asar`**，
  导致 `pnpm install` 无法 swap 该目录（`ERR_PNPM_PACKAGE_MANAGER_SYMLINK_FAILED`）。
  遇到时关掉 Qoder 再装；或用 Resource Monitor 确认占用者。

**Electron 相关坑：**
- `clipboard.readText()` / `writeText()` 在 Electron 45 返回 **Promise**，不是同步值。
- 窗口 `transparent: true` 时，外部工具（PowerShell `CopyFromScreen`）截屏拿不到画面；
  用 `webContents.capturePage()`（见 `src/main/smoke.js`）。
- 热键 `Alt+Space` 本机可用（uTools 当时没跑）；注册失败时主进程会自动退到候选链。


## 工作区约定

- `tmp/` 放临时产物，已 gitignore。探测脚本不要留在仓库根目录。
- 代码按功能分层，不要出现 README 里没写过的顶层目录。
- 测试必须真跑过再报"通过"。跑不了就明说跑不了，不要含糊。
- 提交信息用 `type(scope): 中文描述` 格式（type = feat/fix/chore/docs/test）。

## 提交前

```bash
# node 不在 PATH 上，先把它加进来
export PATH="/d/cursor/resources/app/resources/helpers:$PATH"
node --test "test/*.test.js"
git status             # 确认没有把 tmp/ 或本机路径产物带进去
```

改动涉及界面（renderer/main）时，还要跑一次冒烟测试并看 `tmp/smoke-*.png`：

```bash
DSH_SMOKE=1 node node_modules/electron/cli.js .
```

## 跨工作区

机器层面的坑（工具链缺口、插件补丁）记在 `D:\deepseekDemo` 的记忆库里，
那边是配置仓库。本仓库只关心这个软件本身。
