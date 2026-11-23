'use strict';

/**
 * 项目 provider：把本机的 IDE 项目变成可搜索条目，回车用 IntelliJ IDEA 打开。
 *
 * 项目来源两条，合并去重：
 *   1. IDEA 自己的最近项目列表
 *      %APPDATA%\JetBrains\IntelliJIdea*\options\recentProjects.xml
 *      —— 覆盖"用户开过的所有项目"，包括不在配置根目录里的。
 *   2. 配置根目录下带 .idea 的目录（深度受限，绝不遍历整盘）。
 *
 * 打开方式：idea64.exe <项目路径>。IDEA 已在运行时，这次调用会交给已有
 * 实例处理，不会起第二个 IDE 窗口。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** 项目标记目录：存在即认为是 IDE 项目。 */
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
    out.push(project);
  }
  return out;
}

/**
 * 扫描根目录下带 .idea 的项目目录。
 *
 * 找到项目就不再往里走——项目内部即便有子模块，打开项目根就够了。
 *
 * @param {object} [options]
 * @returns {Array<{path:string, customName:null, openedAt:number}>}
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
      const isProject = entries.some(
        (entry) => entry.name.toLowerCase() === PROJECT_MARKER && entry.isDirectory(),
      );
      if (isProject) {
        projects.push({ path: dir, customName: null, openedAt: 0 });
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
 * 但把对方独有的 tags 并进来。
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
        if (!existing.customName && project.customName) existing.customName = project.customName;
        if (project.openedAt > existing.openedAt) existing.openedAt = project.openedAt;
        continue;
      }
      byKey.set(key, { ...project, tags: [...(project.tags ?? [])] });
    }
  }
  return [...byKey.values()];
}

/**
 * 项目 → 候选条目。标题用目录名（用户认得的名字），IDEA 自定义项目名与
 * 上级目录名放进 tags，搜哪个都能命中。
 * @param {{path:string, customName?:string|null}} project
 * @returns {object}
 */
function projectToCandidate(project) {
  const dir = project.path;
  const title = path.basename(dir) || dir;
  const tags = [];
  if (project.customName && project.customName !== title) tags.push(project.customName);
  const parent = path.basename(path.dirname(dir));
  if (parent && parent !== title) tags.push(parent);

  return {
    id: `project:${dir.toLowerCase()}`,
    kind: 'project',
    title,
    subtitle: dir,
    tags,
    path: dir,
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

/**
 * 用 IDEA 打开项目。
 *
 * detached + unref：IDE 的生命周期不能挂在启动器上，否则关掉启动器会把
 * IDE 一起带走。
 *
 * @param {string} exe idea64.exe（也接受 idea.bat）
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
 * @param {(o?:object)=>Array} [options.readRecent] 注入最近项目读取（测试用）
 * @param {(o?:object)=>Array} [options.scan] 注入目录扫描（测试用）
 * @param {Function} [options.spawn] 注入进程启动（测试用）
 */
function createProjectProvider(options = {}) {
  const readRecent = options.readRecent ?? ((opts) => readRecentProjects(opts));
  const scan = options.scan ?? ((opts) => scanProjectRoots(opts));
  const findIdea = options.findIdeaExecutable ?? (() => findIdeaExecutable(options));

  let candidates = [];
  let ideaPath = null;
  let stats = { count: 0 };

  return {
    id: 'project',
    aliases: ['项目', 'projects', 'project', 'proj', 'p'],
    label: '项目',

    async init() {
      const recent = readRecent();
      const roots = typeof options.roots === 'function' ? options.roots() : options.roots;
      const scanned = scan({ roots });
      const merged = mergeProjects(recent, scanned);
      candidates = merged.map(projectToCandidate);
      ideaPath = ideaPath ?? findIdea();
      stats = { count: candidates.length, ideaPath };
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
      if (!ideaPath) ideaPath = findIdea();
      if (!ideaPath) {
        const error = new Error('未找到 IntelliJ IDEA，可在 config.json 里设置 ideaPath');
        error.code = 'idea_not_found';
        throw error;
      }
      launchIdea(ideaPath, item.path, { spawn: options.spawn });
      return { opened: item.path, idea: ideaPath };
    },
  };
}

module.exports = {
  createProjectProvider,
  parseRecentProjectsXml,
  readRecentProjects,
  scanProjectRoots,
  mergeProjects,
  projectToCandidate,
  ideaExecutableCandidates,
  findIdeaExecutable,
  launchIdea,
  defaultProjectRoots,
  defaultRecentProjectsFiles,
  toWindowsPath,
  PROJECT_MARKER,
  DEFAULT_SCAN_DEPTH,
  SKIP_DIRS,
};
