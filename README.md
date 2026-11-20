# dsh-winTools

Windows 小工具集合。技术栈待定。

## 状态

仓库骨架已就位，尚未选定技术栈。选定后请回来更新本文件的项目描述、
运行方式和目录结构——本节及以下的"快速开始"是占位内容。

## 快速开始

```bash
git clone git@github.com:ZhuangHp123/dsh-winTools.git
cd dsh-winTools
```

具体构建/运行命令待技术栈确定后补充。

## 目录

```
.
├── AGENTS.md        本机环境事实与工作区约定（动手前先读）
├── .gitignore
├── .gitattributes
└── README.md
```

## 开发环境注意

这台机器没有 `npm` / `npx`（自带的 Node 只打包了 `node.exe`），用 `pnpm` /
`pnpm dlx` 代替。`python3` 是 Microsoft Store 的占位 stub，退出码 0 但无输出，
不要用它。完整清单见 `AGENTS.md`。

## 许可

未定。
