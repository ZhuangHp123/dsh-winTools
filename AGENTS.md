# AGENTS.md

本工作区的操作说明。动手前先读——这台机器 PATH 不完整，很多"应该存在"的工具
实际不存在，或者存在但坏了。

## 这个仓库是什么

Windows 小工具集合（具体形态待定：CLI / 桌面壳 / 本地服务）。技术栈尚未选定，
选定后在本节替换为本项目自己的架构约定、目录分层、接口约定。

## Machine facts

| 用途 | 用这个 |
| --- | --- |
| Node | PATH 上的 `node`（v24.x，DSH 运行时自带） |
| pnpm | PATH 上有。**没有 npm / npx**，指南里写 `npx` 的一律换成 `pnpm dlx <pkg>` |
| 测试（JS） | `node --test`（内置，零安装） |
| Python（通用） | `C:\Users\zhuanghp\AppData\Local\Programs\Python\Python313\python.exe`（装了 pytest） |
| Python（Office/图像） | `D:\deepseek-harness\dsh-home\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`（pandas/numpy/python-docx/python-pptx/openpyxl/Pillow/XlsxWriter/lxml/pytest） |
| uv / uvx | PATH 上有 |
| PowerShell | `pwsh`（7.x）；另有 Windows PowerShell 5.1 |
| Shell | bash（MSYS）。不是 Linux：`/tmp` 不是真的临时目录，`D:/x` 可用 |

缺失，别再找：`npm`、`npx`、`docker`、`sqlite3` CLI、`unzip`/`7z`（用 `tar -xf`）、
`gh`、Java（只有一个游离的 Java 8）、Go、Rust。MySQL 没跑在 3306。

**`python3` 是 Microsoft Store 的占位 stub。** 退出码 0，什么都不打印——任何脚本
用它都会静默拿到空结果。永远用 `python` 或上表的绝对路径。

## 工作区约定

- `tmp/` 放临时产物，已 gitignore。探测脚本不要留在仓库根目录。
- 代码按功能分层，不要出现 README 里没写过的顶层目录。
- 测试必须真跑过再报"通过"。跑不了就明说跑不了，不要含糊。
- 提交信息用 `type(scope): 中文描述` 格式（type = feat/fix/chore/docs/test）。

## 提交前

```bash
# 按技术栈替换成实际的测试/检查命令
node --test            # 或 python -m pytest -q
git status             # 确认没有把 tmp/ 或本机路径产物带进去
```

## 跨工作区

机器层面的坑（工具链缺口、插件补丁）记在 `D:\deepseekDemo` 的记忆库里，
那边是配置仓库。本仓库只关心这个软件本身。
