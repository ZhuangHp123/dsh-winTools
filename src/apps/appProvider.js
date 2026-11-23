'use strict';

/**
 * 应用 provider：扫描开始菜单里的 .lnk，提供应用启动。
 *
 * 设计要点（踩过坑）：
 *   1. 启动**一律走 .lnk 文件本身**（shell.openPath），不走解析出来的目标路径。
 *      .lnk 里可能带参数、工作目录、提升权限等元数据，直接启动目标会丢。
 *      而且这样即使目标解析失败，启动功能依然可用。
 *   2. 解析目标只用于**显示和去重**，属于锦上添花，失败不影响主流程。
 *   3. 扫描是纯 IO + 纯函数变换，跑在 worker 线程里做成异步初始化，
 *      不阻塞 UI 首帧。
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseLnkTarget, displayNameFromPath } = require('./lnk');

/** 开始菜单里值得扫描的子目录。 */
const START_MENU_SUBDIRS = ['Programs'];

/**
 * 列出需要扫描的开始菜单根目录。
 * @param {object} [env]
 * @returns {string[]}
 */
function startMenuRoots(env = process.env) {
  const roots = [];
  const programData = env.ProgramData ?? 'C:\\ProgramData';
  roots.push(path.join(programData, 'Microsoft\\Windows\\Start Menu\\Programs'));
  if (env.APPDATA) {
    roots.push(path.join(env.APPDATA, 'Microsoft\\Windows\\Start Menu\\Programs'));
  }
  return roots;
}

/**
 * 递归列出目录下的 .lnk 文件（纯同步 IO，由调用方决定要不要放 worker）。
 *
 * 用迭代而非递归，避免深层目录栈溢出；符号链接不跟随（防止环）。
 *
 * @param {string[]} roots
 * @param {{maxDepth?:number, maxEntries?:number, readdirSync?:Function}} [options]
 * @returns {string[]}
 */
function findShortcuts(roots, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const maxEntries = options.maxEntries ?? 20000;
  const readdir = options.readdirSync ?? ((dir, opts) => fs.readdirSync(dir, opts));
  const found = [];
  const seen = new Set();

  for (const root of roots) {
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
      const { dir, depth } = stack.pop();
      if (depth > maxDepth) continue;
      let entries;
      try {
        entries = readdir(dir, { withFileTypes: true });
      } catch {
        // 没权限/不存在：跳过整个目录，绝不因为一个目录让整次扫描失败。
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (seen.has(full)) continue;
        seen.add(full);
        if (entry.isDirectory()) {
          stack.push({ dir: full, depth: depth + 1 });
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
          found.push(full);
          if (found.length >= maxEntries) return found;
        }
      }
    }
  }
  return found;
}

/**
 * 把一个 .lnk 变成候选对象。
 * @param {string} lnkPath
 * @param {{readFile?:(p:string)=>Buffer, exists?:(p:string)=>boolean}} [deps]
 * @returns {{id:string, kind:string, title:string, subtitle:string, targetPath:string|null, path:string}|null}
 */
function shortcutToCandidate(lnkPath, deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p));
  const exists = deps.exists ?? ((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  let targetPath = null;
  try {
    targetPath = parseLnkTarget(readFile(lnkPath), { lnkPath, exists });
  } catch {
    // 解析失败是允许的：启动走 .lnk 本身，解析结果只影响副标题。
    targetPath = null;
  }

  // 显示名优先用 .lnk 文件名（用户在开始菜单里看到的就是它），
  // 因为目标名可能是个 internal.exe 之类完全看不懂的东西。
  const title = displayNameFromPath(lnkPath);
  if (!title) return null;

  return {
    id: `app:${lnkPath.toLowerCase()}`,
    kind: 'app',
    title,
    subtitle: targetPath ?? lnkPath,
    // 次级检索词。rank.js 会给 tags 里的每一项按 0.3 权重参与打分，
    // 这样搜 "adobe"（目录名）或 "acrobat"（目标文件名）都能命中，
    // 而不会因为标签太弱把标题匹配挤下去。
    tags: buildSearchTags(title, lnkPath, targetPath),
    targetPath,
    path: lnkPath,
  };
}

/**
 * 拼次级检索词：目录名、目标文件名、目标路径。
 * @param {string} title
 * @param {string} lnkPath
 * @param {string|null} targetPath
 * @returns {string[]}
 */
function buildSearchTags(title, lnkPath, targetPath) {
  const tags = [];
  const parent = path.basename(path.dirname(lnkPath));
  if (parent && parent.toLowerCase() !== 'programs') tags.push(parent);
  if (targetPath) {
    const exeName = displayNameFromPath(targetPath);
    if (exeName && exeName.toLowerCase() !== title.toLowerCase()) tags.push(exeName);
    tags.push(targetPath);
  }
  return tags;
}

/**
 * 扫描开始菜单，构造全部应用候选。
 * @param {{roots?:string[], readFile?:Function, exists?:Function, findShortcuts?:Function}} [options]
 * @returns {{candidates:object[], shortcutCount:number}}
 */
function scanApps(options = {}) {
  const roots = options.roots ?? startMenuRoots();
  const finder = options.findShortcuts ?? findShortcuts;
  const shortcuts = finder(roots);
  const candidates = [];
  for (const lnkPath of shortcuts) {
    const candidate = shortcutToCandidate(lnkPath, options);
    if (candidate) candidates.push(candidate);
  }
  return { candidates, shortcutCount: shortcuts.length };
}

/** 应用 provider 接口实现，交给 engine 统一调度。 */
function createAppProvider(options = {}) {
  const scan = options.scan ?? scanApps;
  // 惰性取用：单测不需要 electron，构造 provider 时也不该 require 它。
  // 只有真的去 activate 时才加载，这样纯逻辑测试可以零依赖跑。
  let openPath = options.openPath ?? null;
  const getOpenPath = () => {
    if (!openPath) openPath = defaultOpenPath();
    return openPath;
  };
  let candidates = [];
  let stats = { shortcutCount: 0 };

  return {
    id: 'app',
    aliases: ['应用', 'apps', 'program', '程序', 'a'],
    label: '应用',

    async init() {
      const result = scan(options);
      candidates = result.candidates;
      stats = { shortcutCount: result.shortcutCount };
      return { count: candidates.length, shortcutCount: stats.shortcutCount };
    },

    /**
     * 应用是"全量内存匹配"型 provider：查询发生在本地数组上，
     * 所以 search 把候选全部返回，由 engine 统一打分排序。
     */
    search() {
      return candidates;
    },

    stats() {
      return stats;
    },

    async activate(item) {
      if (!item || !item.path) {
        const error = new Error('缺少快捷方式路径');
        error.code = 'invalid_item';
        throw error;
      }
      // 刻意启动 .lnk 本身：保留参数/工作目录/UAC 等元数据。
      const message = await getOpenPath()(item.path);
      if (message) {
        const error = new Error(`启动失败：${message}`);
        error.code = 'launch_failed';
        throw error;
      }
      return { launched: item.path };
    },
  };
}

let cachedOpenPath;
function defaultOpenPath() {
  if (!cachedOpenPath) {
    const { shell } = require('electron');
    cachedOpenPath = async (target) => {
      const message = await shell.openPath(target);
      return message || '';
    };
  }
  return cachedOpenPath;
}

module.exports = {
  createAppProvider,
  scanApps,
  shortcutToCandidate,
  findShortcuts,
  startMenuRoots,
  buildSearchTags,
  START_MENU_SUBDIRS,
};
