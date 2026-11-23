'use strict';

/**
 * 项目 provider：把本机的 IDE 项目变成可搜索条目，回车用对应的 IDE 打开。
 *
 * 项目来源三条，合并去重：
 *   1. IDEA 自己的最近项目列表
 *      %APPDATA%\JetBrains\IntelliJIdea*\options\recentProjects.xml
 *      —— 覆盖"用户开过的所有项目"，包括不在配置根目录里的。
 *   2. Cursor / VS Code 的最近打开列表（User\globalStorage\state.vscdb 里的
 *      history.recentlyOpenedPathsList），只取文件夹条目。
 *   3. 配置根目录下带 IDE 标记目录（.idea / .cursor / .vscode）的项目，
 *      深度受限，绝不遍历整盘。
 *
 * 打开方式：项目的编辑历史说明用哪个 IDE 就用哪个——.idea 的 workspace.xml
 * 比 .cursor 新就用 IDEA，反之用 Cursor。图标也取该 IDE 自己的 exe 图标，
 * 这样列表里一眼看出"这个项目回车会开在哪个软件里"。
 */

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawn } = require('node:child_process');

/** IDE 标记目录：存在即认为是 IDE 项目；也是判断"最近用哪个 IDE 开的"的依据。 */
const IDE_MARKERS = [
  { ide: 'cursor', marker: '.cursor', workspaceFile: null },
  { ide: 'vscode', marker: '.vscode', workspaceFile: null },
  { ide: 'idea', marker: '.idea', workspaceFile: path.join('.idea', 'workspace.xml') },
];

/** 兼容旧导出：.idea 曾是这个模块唯一的项目标记。 */
const PROJECT_MARKER = '.idea';

/** 扫描深度：项目一般就在根目录下 1~3 层。 */
const DEFAULT_SCAN_DEPTH = 3;

/** 扫描时整棵跳过的目录：这些里面不可能有项目，白扫。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  'build',
  'out',
  'dist',
  'logs',
  '.git',
  '.gradle',
  '.next',
  'vendor',
  'bin',
  'obj',
]);

/**
 * 默认扫描根目录。只保留真实存在的，避免每次扫一堆不存在路径。
 * @param {object} [env]
 * @param {(p:string)=>boolean} [exists]
 * @returns {string[]}
 */
function defaultProjectRoots(env = process.env, exists = defaultExists) {
  const roots = [];
  if (env.USERPROFILE) roots.push(path.join(env.USERPROFILE, 'IdeaProjects'));
  for (const dir of ['D:\\cfDev', 'D:\\code', 'D:\\dev', 'D:\\projects', 'D:\\workspace']) {
    roots.push(dir);
  }
  return [...new Set(roots)].filter((dir) => exists(dir));
}

/**
 * 找 IDEA 的最近项目文件。装了多个大版本时全都要，由使用时间排序决定优先级。
 * @param {object} [env]
 * @returns {string[]}
 */
function defaultRecentProjectsFiles(env = process.env, listDirs = defaultListDirs) {
  const appData = env.APPDATA;
  if (!appData) return [];
  const jetbrains = path.join(appData, 'JetBrains');
  const files = [];
  for (const name of listDirs(jetbrains)) {
    if (!/^IntelliJIdea/i.test(name)) continue;
    files.push(path.join(jetbrains, name, 'options', 'recentProjects.xml'));
  }
  return files;
}

/** XML 里那点转义，路径一般用不到，但别让文件名带 & 的项目漏掉。 */
function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** IDEA 存的是正斜杠路径，转成 Windows 路径好显示、好传给 IDEA。 */
function toWindowsPath(value) {
  const replaced = String(value).replace(/\//g, '\\');
  return replaced.replace(/\\+$/, '') || replaced;
}

/**
 * 解析 recentProjects.xml。
 *
 * 只认 additionalInfo 里 map 的 entry：key 是项目路径，value 里可能带
 * customProjectName（IDEA 界面上显示的名字，例如 low-code-support 显示为
 * secondev-demo）和 projectOpenTimestamp（用于按最近使用排序）。
 *
 * @param {string} xml
 * @param {{toPath?:(p:string)=>string}} [options]
 * @returns {Array<{path:string, customName:string|null, openedAt:number}>}
 */
function parseRecentProjectsXml(xml, options = {}) {
  const toPath = options.toPath ?? toWindowsPath;
  const text = String(xml ?? '');
  const entries = [];
  const entryRe = /<entry\s+key="([^"]*)"\s*>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRe.exec(text)) !== null) {
    const rawKey = match[1];
    if (!rawKey) continue;
    const body = match[2];
    const custom = /<option\s+name="customProjectName"\s+value="([^"]*)"/.exec(body);
    const opened = /<option\s+name="projectOpenTimestamp"\s+value="(\d+)"/.exec(body);
    entries.push({
      path: toPath(decodeXml(rawKey)),
      customName: custom ? decodeXml(custom[1]) : null,
      openedAt: opened ? Number(opened[1]) : 0,
    });
  }
  return entries;
}

/**
 * 读 IDEA 最近项目列表（多个版本的文件合并），按最近打开排序，去掉不存在的。
 * @param {object} [options]
 * @returns {Array<{path:string, customName:string|null, openedAt:number}>}
 */
function readRecentProjects(options = {}) {
  const files = options.files ?? defaultRecentProjectsFiles(options.env);
  const readFile = options.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const exists = options.exists ?? defaultExists;

  const collected = [];
  for (const file of files) {
    let xml;
    try {
      xml = readFile(file);
    } catch {
      // 没装的版本、读不了的文件：跳过，不影响其它来源。
      continue;
    }
    collected.push(...parseRecentProjectsXml(xml, options));
  }

  collected.sort((a, b) => b.openedAt - a.openedAt);
  const seen = new Set();
  const out = [];
  for (const project of collected) {
    const key = project.path.toLowerCase();
    if (seen.has(key)) continue;
    if (!exists(project.path)) continue;
    seen.add(key);
    out.push({ ...project, openedBy: { idea: project.openedAt }, ides: ['idea'] });
  }
  return out;
}

/** VS Code 系（Cursor / Code）的最近列表文件位置。 */
const VSCODE_FAMILY = [
  { ide: 'cursor', appName: 'Cursor' },
  { ide: 'vscode', appName: 'Code' },
];

/**
 * 读 VS Code 系编辑器的最近打开列表（文件夹条目）。
 *
 * 数据在 User\globalStorage\state.vscdb 的 ItemTable 里，值是 JSON；
 * 只取 folderUri，单文件条目（用户随手双击打开的）不算项目。
 * 库被编辑器占着，和 Chrome 历史库一样用 immutable 只读打开。
 *
 * 同时扫 User\workspaceStorage\<hash>\workspace.json：每个项目一个目录，
 * workspace.json 的修改时间就是"这个项目最近一次在该编辑器里打开"的时间——
 * 这是唯一能和 IDEA 的 projectOpenTimestamp 直接比较的信号
 * （项目里的 .cursor 目录只反映配置改动，不代表打开过）。
 *
 * @param {object} [options]
 * @returns {Array<{path:string, customName:null, openedAt:number, openedBy:object, ides:string[]}>}
 */
function readVscodeRecentProjects(options = {}) {
  const appData = options.appData ?? (options.env ?? process.env).APPDATA;
  if (!appData) return [];
  const openDatabase = options.openDatabase ?? defaultOpenDatabase;
  const exists = options.exists ?? defaultExists;
  const statSync = options.statSync ?? defaultStatSync;
  const listDirs = options.listDirs ?? defaultListDirs;
  const out = [];

  for (const { ide, appName } of VSCODE_FAMILY) {
    const userDir = path.join(appData, appName, 'User');
    const openedByPath = readWorkspaceStorageTimes(path.join(userDir, 'workspaceStorage'), {
      exists,
      statSync,
      listDirs,
      readFile: options.readFile,
    });

    // workspaceStorage 才是主来源：每个打开过的项目一个目录，哪怕它已经从
    // 最近列表里滚出去了，这里仍然留着，并带最近打开时间。
    for (const opened of openedByPath.values()) {
      if (!exists(opened.path)) continue;
      out.push({
        path: opened.path,
        customName: null,
        openedAt: opened.openedAt,
        openedBy: { [ide]: opened.openedAt },
        ides: [ide],
      });
    }

    // 最近列表补漏：有项目可能还没写 workspaceStorage，时间记为 0（只用于收录）。
    const file = path.join(userDir, 'globalStorage', 'state.vscdb');
    if (!exists(file)) continue;
    let entries;
    try {
      entries = readRecentlyOpenedPaths(file, openDatabase);
    } catch {
      continue; // 带着锁/损坏：跳过这个编辑器，不影响其它来源
    }
    for (const entry of entries) {
      const target = entry.folderUri ?? entry.workspace?.configPath ?? null;
      if (!target || !target.startsWith('file:')) continue;
      let dir;
      try {
        dir = fileURLToPath(target);
      } catch {
        continue;
      }
      // workspace.json 指向 .code-workspace 文件，项目根是它的目录。
      if (entry.workspace?.configPath) dir = path.dirname(dir);
      if (!exists(dir)) continue;
      if (openedByPath.has(dir.toLowerCase())) continue;
      out.push({
        path: dir,
        customName: null,
        openedAt: 0,
        openedBy: { [ide]: 0 },
        ides: [ide],
      });
    }
  }
  return out;
}

/**
 * 扫 workspaceStorage，得到"项目路径 → 最近打开时间"。
 * 目录结构：<userData>\User\workspaceStorage\<hash>\workspace.json，
 * 内容 {"folder":"file:///d%3A/cfDev/cfmoto"}。
 * @returns {Map<string, {path:string, openedAt:number}>} key 是小写路径
 */
function readWorkspaceStorageTimes(root, deps) {
  const { exists, statSync, listDirs, readFile = (p) => fs.readFileSync(p, 'utf8') } = deps;
  const map = new Map();
  for (const name of listDirs(root)) {
    const file = path.join(root, name, 'workspace.json');
    if (!exists(file)) continue;
    let parsed;
    let mtime;
    try {
      parsed = JSON.parse(readFile(file));
      mtime = statSync(file).mtimeMs ?? 0;
    } catch {
      continue;
    }
    const target = parsed?.folder ?? parsed?.workspace;
    if (typeof target !== 'string' || !target.startsWith('file:')) continue;
    let dir;
    try {
      dir = fileURLToPath(target);
    } catch {
      continue;
    }
    const key = dir.toLowerCase();
    const previous = map.get(key);
    if (!previous || previous.openedAt < mtime) map.set(key, { path: dir, openedAt: mtime });
  }
  return map;
}

/** 默认的只读打开方式（node:sqlite，Electron 和 Node 24 都自带）。 */
function defaultOpenDatabase(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(`file:${file.split(path.sep).join('/')}?mode=ro&immutable=1`);
}

/** 从 state.vscdb 读 history.recentlyOpenedPathsList，返回 entries 数组。 */
function readRecentlyOpenedPaths(file, openDatabase = defaultOpenDatabase) {
  let db;
  try {
    db = openDatabase(file);
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
      .get();
    if (!row?.value) return [];
    const data = JSON.parse(typeof row.value === 'string' ? row.value : String(row.value));
    return Array.isArray(data?.entries) ? data.entries : [];
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 项目的 IDE 标记目录里最近一次更新的时间。
 * VS Code 系没有可用的打开时间（.cursor 只反映配置改动），退回到目录 mtime；
 * IDEA 优先用 workspace.xml——它只在真正打开项目时写。
 */
function markerMtime(projectDir, ide, statSync) {
  const entry = IDE_MARKERS.find((item) => item.ide === ide);
  if (!entry) return 0;
  const candidates = entry.workspaceFile
    ? [path.join(projectDir, entry.workspaceFile), path.join(projectDir, entry.marker)]
    : [path.join(projectDir, entry.marker)];
  for (const target of candidates) {
    try {
      return statSync(target).mtimeMs ?? 0;
    } catch {
      /* 下一个 */
    }
  }
  return 0;
}

/**
 * 决定项目用哪个 IDE 打开。
 *
 * 优先比较"各编辑器最近一次打开这个项目"的时间（IDEA 取 projectOpenTimestamp，
 * Cursor/VS Code 取 workspaceStorage 里 workspace.json 的 mtime）——谁最后开过用谁。
 * 没有任何打开时间时退回标记目录 mtime，再不行按 ides 顺序。
 *
 * @param {{path:string, ides?:string[], openedBy?:object}} project
 * @param {{statSync?:Function}} [options]
 * @returns {string} 'idea' | 'cursor' | 'vscode'
 */
function resolveProjectIde(project, options = {}) {
  const statSync = options.statSync ?? defaultStatSync;
  const ides = Array.isArray(project.ides) && project.ides.length > 0 ? project.ides : ['idea'];
  if (ides.length === 1) return ides[0];

  const openedBy = project.openedBy ?? {};
  const hasOpenedTime = ides.some((ide) => (openedBy[ide] ?? 0) > 0);
  const timeOf = (ide) => (hasOpenedTime ? openedBy[ide] ?? 0 : markerMtime(project.path, ide, statSync));

  let best = ides[0];
  let bestTime = -1;
  for (const ide of ides) {
    const time = timeOf(ide);
    if (time > bestTime) {
      bestTime = time;
      best = ide;
    }
  }
  return best;
}

function defaultStatSync(target) {
  return fs.statSync(target);
}

/**
 * 扫描根目录下带 IDE 标记目录（.idea / .cursor / .vscode）的项目目录。
 *
 * 找到项目就不再往里走——项目内部即便有子模块，打开项目根就够了。
 *
 * @param {object} [options]
 * @returns {Array<{path:string, customName:null, openedAt:number, ides:string[]}>}
 */
function scanProjectRoots(options = {}) {
  const roots = options.roots ?? defaultProjectRoots(options.env);
  const maxDepth = options.maxDepth ?? DEFAULT_SCAN_DEPTH;
  const readdirSync = options.readdirSync ?? ((dir, opts) => fs.readdirSync(dir, opts));
  const exists = options.exists ?? defaultExists;

  const projects = [];
  for (const root of roots) {
    if (!exists(root)) continue;
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
      const { dir, depth } = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // 没权限的目录跳过，不因为一个目录让整次扫描失败
      }
      const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
      const ides = IDE_MARKERS.filter(
        (entry) => names.has(entry.marker) && entries.find((e) => e.name.toLowerCase() === entry.marker).isDirectory(),
      ).map((entry) => entry.ide);
      if (ides.length > 0) {
        // 两条来源可能都发现同一个项目，交给 marker 去重时 IDE 列表会合并。
        projects.push({ path: dir, customName: null, openedAt: 0, ides });
        continue;
      }
      if (depth >= maxDepth) continue;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return projects;
}

/**
 * 合并多个来源的项目，按路径去重；重复时保留先出现的（最近使用的在前），
 * 但把对方独有的 tags / ides 并进来。
 * @param {...Array<object>} groups
 * @returns {Array<object>}
 */
function mergeProjects(...groups) {
  const byKey = new Map();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const project of group) {
      const key = path.resolve(project.path).toLowerCase();
      const existing = byKey.get(key);
      if (existing) {
        for (const tag of project.tags ?? []) {
          if (tag && !existing.tags.includes(tag)) existing.tags.push(tag);
        }
        for (const ide of project.ides ?? []) {
          if (!existing.ides.includes(ide)) existing.ides.push(ide);
        }
        for (const [ide, time] of Object.entries(project.openedBy ?? {})) {
          if ((existing.openedBy?.[ide] ?? 0) < time) {
            existing.openedBy = { ...existing.openedBy, [ide]: time };
          }
        }
        if (!existing.customName && project.customName) existing.customName = project.customName;
        if (project.openedAt > existing.openedAt) existing.openedAt = project.openedAt;
        continue;
      }
      byKey.set(key, {
        ...project,
        tags: [...(project.tags ?? [])],
        ides: [...(project.ides ?? [])],
        openedBy: { ...(project.openedBy ?? {}) },
      });
    }
  }
  return [...byKey.values()];
}

/**
 * 项目 → 候选条目。标题用目录名（用户认得的名字），IDEA 自定义项目名与
 * 上级目录名放进 tags，搜哪个都能命中。
 *
 * ide 决定图标和回车行为：两种 IDE 的标记目录都有时，用编辑时间更新的那个——
 * 那就是用户最近真正打开它的方式。
 *
 * @param {{path:string, customName?:string|null, ides?:string[], markers?:object}} project
 * @returns {object}
 */
function projectToCandidate(project) {
  const dir = project.path;
  const title = path.basename(dir) || dir;
  const tags = [];
  if (project.customName && project.customName !== title) tags.push(project.customName);
  const parent = path.basename(path.dirname(dir));
  if (parent && parent !== title) tags.push(parent);

  const ide = project.ide ?? 'idea';
  if (ide !== 'idea') tags.push(ide);

  return {
    id: `project:${dir.toLowerCase()}`,
    kind: 'project',
    title,
    subtitle: dir,
    tags,
    path: dir,
    ide,
    // 图标从 IDE 自己的 exe 抽，列表里才能分清 IDEA / Cursor / VS Code。
    iconFile: project.iconFile ?? null,
  };
}

/** 读目录名（只在需要发现候选可执行文件时用，失败返回空数组）。 */
function defaultListDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function defaultExists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * 列出可能的 idea64.exe 路径，按可信度排序。
 *
 * 本机是"解压到 D:\IntelliJ IDEA 2026.2.3"这种非标准安装，INSTALL 注册表
 * 里查不到，所以最后兜底扫一遍盘符根目录下的 IntelliJ IDEA* 目录（只读一层）。
 *
 * @param {object} [env]
 * @param {(dir:string)=>string[]} [listDirs]
 * @returns {string[]}
 */
function ideaExecutableCandidates(env = process.env, listDirs = defaultListDirs) {
  const list = [];
  if (env.DSH_IDEA) list.push(env.DSH_IDEA);

  for (const base of [
    env.ProgramFiles && path.join(env.ProgramFiles, 'JetBrains'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'JetBrains'),
  ]) {
    if (!base) continue;
    for (const name of listDirs(base)) {
      if (/^IntelliJ IDEA/i.test(name)) list.push(path.join(base, name, 'bin', 'idea64.exe'));
    }
  }

  if (env.LOCALAPPDATA) {
    const programs = path.join(env.LOCALAPPDATA, 'Programs');
    for (const name of listDirs(programs)) {
      if (/^IntelliJ IDEA/i.test(name)) list.push(path.join(programs, name, 'bin', 'idea64.exe'));
    }
    const toolbox = path.join(env.LOCALAPPDATA, 'JetBrains', 'Toolbox', 'apps');
    for (const app of listDirs(toolbox)) {
      if (!/^IDEA/i.test(app)) continue;
      const appDir = path.join(toolbox, app);
      for (const channel of listDirs(appDir)) {
        const channelDir = path.join(appDir, channel);
        for (const build of listDirs(channelDir)) {
          list.push(path.join(channelDir, build, 'bin', 'idea64.exe'));
        }
      }
    }
  }

  for (const drive of [env.SystemDrive ?? 'C:', 'D:']) {
    const root = `${drive}\\`;
    for (const name of listDirs(root)) {
      if (/^IntelliJ IDEA/i.test(name)) list.push(path.join(root, name, 'bin', 'idea64.exe'));
    }
  }

  return [...new Set(list)];
}

/**
 * 找到可用的 idea64.exe；找不到返回 null（由调用方给出可操作的报错）。
 * @param {object} [options]
 * @returns {string|null}
 */
function findIdeaExecutable(options = {}) {
  const exists = options.exists ?? defaultExists;
  const listDirs = options.listDirs ?? defaultListDirs;
  if (options.ideaPath && exists(options.ideaPath)) return options.ideaPath;
  return (
    ideaExecutableCandidates(options.env ?? process.env, listDirs).find((p) => exists(p)) ?? null
  );
}

/** VS Code 系编辑器的常见安装位置（相对各安装根目录的子路径 + 盘符根目录下的目录名）。 */
const EDITOR_LAYOUTS = {
  cursor: {
    envVar: 'DSH_CURSOR',
    appDirs: ['Cursor', 'cursor'],
    rootPattern: /^cursor$/i,
    exe: path.join('Cursor.exe'),
  },
  vscode: {
    envVar: 'DSH_VSCODE',
    appDirs: ['Microsoft VS Code', 'Microsoft VS Code Insiders'],
    rootPattern: /^microsoft vs code$/i,
    exe: path.join('Code.exe'),
  },
};

/**
 * 列出可能的 Cursor.exe / Code.exe 路径，按可信度排序。
 * @param {'cursor'|'vscode'} ide
 * @param {object} [env]
 * @param {(dir:string)=>string[]} [listDirs]
 * @returns {string[]}
 */
function editorExecutableCandidates(ide, env = process.env, listDirs = defaultListDirs) {
  const layout = EDITOR_LAYOUTS[ide];
  if (!layout) return [];
  const list = [];
  if (env[layout.envVar]) list.push(env[layout.envVar]);

  const bases = [];
  if (env.LOCALAPPDATA) bases.push(path.join(env.LOCALAPPDATA, 'Programs'));
  if (env.ProgramFiles) bases.push(env.ProgramFiles);
  if (env['ProgramFiles(x86)']) bases.push(env['ProgramFiles(x86)']);
  for (const base of bases) {
    for (const name of listDirs(base)) {
      if (!layout.appDirs.some((app) => app.toLowerCase() === name.toLowerCase())) continue;
      list.push(path.join(base, name, layout.exe));
    }
  }

  // 便携版：解压到 D:\cursor、D:\Microsoft VS Code 这种盘符根目录下。
  for (const drive of [env.SystemDrive ?? 'C:', 'D:']) {
    const root = `${drive}\\`;
    for (const name of listDirs(root)) {
      if (!layout.rootPattern.test(name)) continue;
      list.push(path.join(root, name, layout.exe));
    }
  }
  return [...new Set(list)];
}

/**
 * 找某个 IDE 的可执行文件；找不到返回 null。
 * @param {'idea'|'cursor'|'vscode'} ide
 * @param {object} [options]
 * @returns {string|null}
 */
function findEditorExecutable(ide, options = {}) {
  if (ide === 'idea') return findIdeaExecutable(options);
  const exists = options.exists ?? defaultExists;
  const listDirs = options.listDirs ?? defaultListDirs;
  const configured = options[`${ide}Path`];
  if (typeof configured === 'string' && exists(configured)) return configured;
  return (
    editorExecutableCandidates(ide, options.env ?? process.env, listDirs).find((p) =>
      exists(p),
    ) ?? null
  );
}

/**
 * 用 IDE 打开项目。
 *
 * detached + unref：IDE 的生命周期不能挂在启动器上，否则关掉启动器会把
 * IDE 一起带走。
 *
 * @param {string} exe idea64.exe / Cursor.exe / Code.exe（也接受 .bat）
 * @param {string} projectPath
 * @param {{spawn?:Function}} [options]
 */
function launchIdea(exe, projectPath, options = {}) {
  const spawnFn = options.spawn ?? spawn;
  const isScript = /\.(bat|cmd)$/i.test(exe);
  const child = spawnFn(exe, [projectPath], {
    detached: true,
    stdio: 'ignore',
    ...(isScript ? { shell: true } : {}),
  });
  // spawn 的失败是异步的（ENOENT 之类），不接住会变成主进程未捕获异常。
  // 可执行文件存在性已在调用侧先校验，这里的错误只做兜底。
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (child && typeof child.unref === 'function') child.unref();
  return child;
}

/**
 * 项目 provider。
 * @param {object} [options]
 * @param {()=>string[]} [options.roots] 扫描根目录（每次 init 取一次）
 * @param {string} [options.ideaPath] 指定 IDEA 可执行文件（config.json）
 * @param {string} [options.cursorPath] 指定 Cursor.exe（config.json）
 * @param {string} [options.vscodePath] 指定 Code.exe（config.json）
 * @param {(o?:object)=>Array} [options.readRecent] 注入 IDEA 最近项目读取（测试用）
 * @param {(o?:object)=>Array} [options.readVscodeRecent] 注入编辑器最近项目读取（测试用）
 * @param {(o?:object)=>Array} [options.scan] 注入目录扫描（测试用）
 * @param {(ide:string, o?:object)=>string|null} [options.findExecutable] 注入 IDE 查找（测试用）
 * @param {Function} [options.spawn] 注入进程启动（测试用）
 */
function createProjectProvider(options = {}) {
  const readRecent = options.readRecent ?? ((opts) => readRecentProjects(opts));
  const readVscodeRecent =
    options.readVscodeRecent ??
    // 注入了任意一个来源就当作"来源由调用方全权提供"（单测），不去读真实磁盘。
    (options.readRecent || options.scan
      ? () => []
      : (opts) => readVscodeRecentProjects({ ...options, ...opts }));
  const scan = options.scan ?? ((opts) => scanProjectRoots(opts));
  const findExecutable =
    options.findExecutable ??
    ((ide) =>
      // 兼容只注入 IDEA 查找的旧测试/调用方。
      ide === 'idea' && typeof options.findIdeaExecutable === 'function'
        ? options.findIdeaExecutable()
        : findEditorExecutable(ide, options));

  /** ide → 可执行文件；每个只查一次。 */
  let executableByIde = {};
  let candidates = [];
  let stats = { count: 0 };

  function resolveExecutable(ide) {
    if (!(ide in executableByIde)) executableByIde[ide] = findExecutable(ide);
    return executableByIde[ide];
  }

  return {
    id: 'project',
    aliases: options.aliases ?? ['项目', 'projects', 'project', 'proj', 'p'],
    label: '项目',

    async init() {
      const recent = readRecent();
      const vscodeRecent = readVscodeRecent();
      const roots = typeof options.roots === 'function' ? options.roots() : options.roots;
      const scanned = scan({ roots });
      const merged = mergeProjects(recent, vscodeRecent, scanned);

      candidates = merged.map((project) => {
        const ide = resolveProjectIde(project, options);
        const exe = resolveExecutable(ide);
        return projectToCandidate({ ...project, ide, iconFile: exe });
      });
      const ideaPath = executableByIde.idea ?? null;
      stats = {
        count: candidates.length,
        ideaPath,
        ides: [...new Set(candidates.map((item) => item.ide))],
      };
      return { count: candidates.length, ideaPath };
    },

    /** 和 app 一样是全量内存匹配，交给 engine 统一打分。 */
    search() {
      return candidates;
    },

    stats() {
      return stats;
    },

    async activate(item) {
      if (!item || !item.path) {
        const error = new Error('缺少项目路径');
        error.code = 'invalid_item';
        throw error;
      }
      const ide = item.ide ?? 'idea';
      const exe = resolveExecutable(ide);
      if (!exe) {
        const labels = { idea: ['IntelliJ IDEA', 'ideaPath'], cursor: ['Cursor', 'cursorPath'], vscode: ['VS Code', 'vscodePath'] };
        const [name, field] = labels[ide] ?? [ide, 'ideaPath'];
        const error = new Error(`未找到 ${name}，可在 config.json 里设置 ${field}`);
        error.code = 'ide_not_found';
        throw error;
      }
      launchIdea(exe, item.path, { spawn: options.spawn });
      return { opened: item.path, ide, exe };
    },
  };
}

module.exports = {
  createProjectProvider,
  parseRecentProjectsXml,
  readRecentProjects,
  readVscodeRecentProjects,
  readRecentlyOpenedPaths,
  readWorkspaceStorageTimes,
  resolveProjectIde,
  scanProjectRoots,
  mergeProjects,
  projectToCandidate,
  ideaExecutableCandidates,
  findIdeaExecutable,
  editorExecutableCandidates,
  findEditorExecutable,
  launchIdea,
  projectIdeFor,
  defaultProjectRoots,
  defaultRecentProjectsFiles,
  toWindowsPath,
  PROJECT_MARKER,
  IDE_MARKERS,
  DEFAULT_SCAN_DEPTH,
  SKIP_DIRS,
};

/** 候选项上给界面用的 IDE 显示名。 */
function projectIdeFor(ide) {
  return { idea: 'IDEA', cursor: 'Cursor', vscode: 'VS Code' }[ide] ?? String(ide ?? '');
}
