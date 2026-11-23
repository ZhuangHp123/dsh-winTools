'use strict';

/**
 * 文件搜索 provider（缓存式索引）。
 *
 * 为什么是"缓存式"而不是"实时查询"：
 *   Everything 靠的是 NTFS USN Journal（读系统日志，几乎零成本）；
 *   普通进程没有那个能力，只能自己扫盘。本机实测 D: 盘 12 万个文件
 *   同步扫完要 44 秒，所以不能等扫完才给结果。
 *
 * 策略：分层增量
 *   1. 启动时先索引用户高频目录（桌面/文档/下载），几十毫秒就有结果可用。
 *   2. 后台继续扫其它盘，边扫边可查（索引就是内存里的数组，随时能读）。
 *   3. 索引落盘做缓存，下次启动秒开，然后后台再校验/增量刷新。
 *
 * 这一层只做"索引 + 匹配"，不碰 Electron；worker 里跑扫描，
 * 主进程只收结果，UI 不会因为扫盘卡住。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 默认要排除的目录：装的东西多、搜出来也没用，还特别慢。
 *
 * 这份清单是按本机实测调的（全部为实测数字）：
 *   - 不排除任何东西扫 C:\ + D:\：12 万文件 / 44 秒
 *   - 排除 `dsh-home` 后 D: 从 12 万降到 4.7 万，扫描从 44 秒降到 6 秒
 *   - `%USERPROFILE%\AppData` 单独就有 10 万文件（占用户目录 90%），
 *     排除后用户目录从 11 万降到 1.1 万
 * 用户真正想找的文件（桌面/文档/下载/项目代码）一条都不受影响。
 */
const DEFAULT_EXCLUDES = [
  // 开发/版本控制
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.pnpm-store',
  '.gradle',
  '.m2',
  '.cache',
  '.venv',
  '__pycache__',
  // 系统
  'WinSxS',
  '$Recycle.Bin',
  'System Volume Information',
  'Windows\\Installer',
  'Windows\\Temp',
  'Windows\\WinSxS',
  'Windows\\SystemApps',
  // 用户配置/缓存：这里全是应用内部数据，不是用户的文件
  'AppData',
  '.workbuddy',
  '.qoder-cn',
  '.qoder-versions',
  '.dsh-wallpaper-engine',
  '.dsh.moved-backup-20261118-082534',
  // 各应用的内部实现目录
  'resources',
  'plugins',
  'locales',
  'configuration',
  'temp',
  'tmp',
  // 本机特定：运行时数据 / 缓存
  'dsh-home',
  'dsh-runtimes',
  'CursorData',
  'QoderCache',
  'wechatCache',
  'WorkBuddyCache',
  'CachedData',
  'GPUCache',
];

/** 只索引这些扩展名（有内容、用户会想找的文件）。空数组表示全都索引。 */
const DEFAULT_EXTENSIONS = [
  '.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico',
  '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wav', '.flac',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.iso',
  '.js', '.ts', '.jsx', '.tsx', '.json', '.yml', '.yaml', '.toml', '.ini',
  '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.sql',
  '.sh', '.bat', '.ps1', '.exe', '.msi', '.lnk',
];

/** 单个文件的索引条目上限，防止某个盘异常时吃爆内存。 */
const DEFAULT_MAX_ENTRIES = 200000;

/** 索引缓存版本号：结构变了就加一，让旧缓存自动失效。 */
const CACHE_VERSION = 1;

/**
 * 把排除规则编译成"这些路径前缀不要进"的判定函数。
 *
 * 用"路径里包含某个片段的完整目录名"来判断，而不是简单 includes：
 * 否则 `mysite.com` 会被 `.com` 之类的规则误伤。
 *
 * @param {string[]} [excludes]
 * @returns {(fullPath:string)=>boolean}
 */
function createExcludeMatcher(excludes = DEFAULT_EXCLUDES) {
  const names = new Set(excludes.map((e) => e.toLowerCase()));
  return (fullPath) => {
    const lower = fullPath.toLowerCase();
    for (const name of names) {
      // 目录名出现在路径尾部，或出现在 middle 且两侧都是分隔符。
      if (lower.endsWith(`\\${name}`) || lower.includes(`\\${name}\\`)) return true;
    }
    return false;
  };
}

/**
 * 同步扫描若干根目录，收集文件条目。
 *
 * 迭代而非递归（深层目录不爆栈），并且**每次返回一批就先交出去**，
 * 这样调用方能增量构建索引、边扫边用。
 *
 * @param {object} options
 * @param {string[]} options.roots
 * @param {string[]} [options.extensions]
 * @param {string[]} [options.excludes]
 * @param {number} [options.maxEntries]
 * @param {number} [options.maxDepth]
 * @param {AbortSignal} [options.signal]
 * @param {(batch:object[], stats:object)=>void} [options.onBatch] 每批回调
 * @returns {Promise<{entries:object[], stats:object}>}
 */
async function scanRoots(options) {
  const roots = options.roots ?? [];
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const extSet = extensions.length > 0 ? new Set(extensions.map((e) => e.toLowerCase())) : null;
  const isExcluded = createExcludeMatcher(options.excludes ?? DEFAULT_EXCLUDES);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? 24;
  const signal = options.signal;
  const onBatch = options.onBatch;
  const readdir = options.readdirSync ?? ((dir) => fs.readdirSync(dir, { withFileTypes: true }));

  const entries = [];
  const stats = { scannedDirs: 0, skippedDirs: 0, truncated: false, startedAt: Date.now() };

  let batch = [];
  const flush = () => {
    if (batch.length === 0) return;
    if (typeof onBatch === 'function') onBatch(batch, stats);
    batch = [];
  };

  const stack = roots.map((root) => ({ dir: root, depth: 0 }));
  while (stack.length > 0) {
    if (signal?.aborted) break;
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    if (isExcluded(dir)) {
      stats.skippedDirs += 1;
      continue;
    }

    let dirents;
    try {
      dirents = readdir(dir);
    } catch {
      stats.skippedDirs += 1;
      continue;
    }
    stats.scannedDirs += 1;

    for (const dirent of dirents) {
      const full = joinPath(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (isExcluded(full)) {
          stats.skippedDirs += 1;
          continue;
        }
        stack.push({ dir: full, depth: depth + 1 });
      } else if (dirent.isFile()) {
        if (extSet && !extSet.has(path.extname(dirent.name).toLowerCase())) continue;
        const entry = makeEntry(full);
        entries.push(entry);
        batch.push(entry);
        if (entries.length >= maxEntries) {
          stats.truncated = true;
          flush();
          return { entries, stats };
        }
        if (batch.length >= 500) flush();
      }
    }
    // 让出事件循环：扫盘是长任务，不能让 worker 里的消息、abort 信号饿死。
    if (stats.scannedDirs % 200 === 0) {
      flush();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  flush();
  stats.elapsedMs = Date.now() - stats.startedAt;
  return { entries, stats };
}

/** 拼路径，避免根目录（`D:\`）出现双反斜杠。 */
function joinPath(dir, name) {
  return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${name}` : `${dir}\\${name}`;
}

/**
 * 把一个文件路径变成索引条目。
 * 只存必要的字段：完整路径太长，存盘时占空间，但搜索又需要，所以留着；
 * 显示名和扩展名预先算好，渲染时不用再拆字符串。
 */
function makeEntry(fullPath) {
  const name = path.basename(fullPath);
  return {
    path: fullPath,
    name,
    dir: path.dirname(fullPath),
    ext: path.extname(name).toLowerCase(),
    // 小写索引文本：搜索时对每个文件做 lowerCase 太慢，预先算好。
    lower: fullPath.toLowerCase(),
  };
}

/**
 * 内存索引。
 *
 * 就是一个数组 + 一个"按需过滤"的查询。12 万条在内存里约 20MB，
 * 用 plain 对象而不是索引树，是因为模糊搜索本来就要扫全量，
 * 建倒排索引反而更慢（模糊匹配用不上前缀树）。
 */
function createFileIndex() {
  const entries = [];
  let built = false;
  const stats = { count: 0, truncated: false, roots: [] };

  return {
    /** 增量加入一批条目（边扫边可用）。 */
    add(batch) {
      for (const entry of batch) entries.push(entry);
      stats.count = entries.length;
    },

    /** 整体替换（从缓存加载时用）。 */
    set(nextEntries) {
      entries.length = 0;
      for (const entry of nextEntries) entries.push(entry);
      stats.count = entries.length;
      built = true;
    },

    /** 按子串预筛，再交给 fuzzy 精细打分。 */
    find(terms, limit = 200) {
      if (entries.length === 0) return [];
      const lowered = terms.map((t) => t.toLowerCase());
      const out = [];
      for (const entry of entries) {
        // 所有词都必须出现在路径里，否则淘汰——这是廉价的预筛，
        // 否则 12 万条全量跑模糊打分太慢。
        let all = true;
        for (const term of lowered) {
          if (!entry.lower.includes(term)) {
            all = false;
            break;
          }
        }
        if (!all) continue;
        out.push(entry);
        if (out.length >= limit) break;
      }
      return out;
    },

    size() {
      return entries.length;
    },

    isBuilt() {
      return built;
    },

    markBuilt() {
      built = true;
    },

    stats() {
      return { ...stats };
    },

    toJSON() {
      return {
        version: CACHE_VERSION,
        savedAt: Date.now(),
        entries,
      };
    },

    /** 从缓存恢复；版本不符或结构损坏时返回 false，不污染现有索引。 */
    loadFromJSON(data) {
      if (!data || data.version !== CACHE_VERSION || !Array.isArray(data.entries)) return false;
      const valid = data.entries.filter(
        (e) => e && typeof e.path === 'string' && typeof e.lower === 'string',
      );
      if (valid.length === 0) return false;
      this.set(valid);
      return true;
    },
  };
}

/** 文件候选的 kind 与显示信息。 */
function entryToCandidate(entry) {
  return {
    id: `file:${entry.lower}`,
    kind: 'file',
    title: entry.name,
    subtitle: entry.dir,
    path: entry.path,
    tags: [entry.ext.replace(/^\./, '')].filter(Boolean),
  };
}

/**
 * 文件 provider。
 * @param {object} [options]
 * @param {()=>string[]} [options.roots] 返回要扫描的根目录
 * @param {string} [options.cachePath] 索引缓存文件路径
 */
function createFileProvider(options = {}) {
  const index = createFileIndex();
  const rootsFn = options.roots ?? defaultRoots;
  const scan = options.scan ?? scanRoots;
  const limit = options.limit ?? 200;
  // 惰性取用：单测不该 require electron。真去 activate 时才加载。
  let openPath = options.openPath ?? null;
  const getOpenPath = () => {
    if (!openPath) openPath = defaultFileOpenPath();
    return openPath;
  };
  let scanning = null;
  let pending = [];
  let scanDone = false;
  const errors = [];

  return {
    id: 'file',
    aliases: options.aliases ?? ['文件', 'files', 'file', 'f'],
    label: '文件',

    async init() {
      // 重新 init（托盘"重新索引"）时要复位，否则 isIndexing() 永远报已完成。
      scanDone = false;
      // 重新扫描会重新灌入全部条目，不清空会重复累加。
      index.set([]);
      // 先尝试从缓存秒开，再后台刷新。
      if (options.cache?.load) {
        try {
          const cached = await options.cache.load();
          if (cached) index.loadFromJSON(cached);
        } catch (error) {
          errors.push(String(error?.message ?? error));
        }
      }
      // 后台扫描：不 await，UI 先用缓存和老索引。
      scanning = (async () => {
        try {
          const result = await scan({
            roots: rootsFn(),
            onBatch: (batch) => {
              index.add(batch);
              pending.push(...batch);
            },
          });
          index.markBuilt();
          return result.stats;
        } catch (error) {
          errors.push(String(error?.message ?? error));
          return null;
        } finally {
          scanDone = true;
        }
      })();
      return { cached: index.size(), scanning: true };
    },

    search(terms) {
      // 空查询不返回文件：打开瞬间应该显示应用和最近项，不是随机文件。
      if (!Array.isArray(terms) || terms.length === 0) return [];
      return index.find(terms, limit).map(entryToCandidate);
    },

    /** 用系统默认程序打开文件（ShellExecute 语义，保留文件关联）。 */
    async activate(item) {
      if (!item || !item.path) {
        const error = new Error('缺少文件路径');
        error.code = 'invalid_item';
        throw error;
      }
      const message = await getOpenPath()(item.path);
      if (message) {
        const error = new Error(`打开失败：${message}`);
        error.code = 'open_failed';
        throw error;
      }
      return { opened: item.path };
    },

    /** 索引是否还在构建（UI 可据此显示"索引中…"）。 */
    isIndexing() {
      return Boolean(scanning) && !scanDone;
    },    async whenScanDone() {
      if (scanning) await scanning;
    },

    stats() {
      return { ...index.stats(), indexing: this.isIndexing(), errors: errors.slice() };
    },

    async dispose() {
      if (options.cache?.save && index.size() > 0) {
        try {
          await options.cache.save(index.toJSON());
        } catch (error) {
          errors.push(String(error?.message ?? error));
        }
      }
    },
  };
}

/**
 * 默认扫描根目录：用户高频目录优先，然后才是整盘。
 * 顺序有意义——先扫的先出现在索引里，打开就能搜到。
 */
function defaultRoots(env = process.env) {
  const home = env.USERPROFILE;
  const roots = [];
  if (home) {
    for (const sub of ['Desktop', 'Documents', 'Downloads']) {
      roots.push(path.join(home, sub));
    }
  }
  // 其它盘（本机 D: 装了大量工具和项目）。
  for (const drive of ['C:\\', 'D:\\']) {
    roots.push(drive);
  }
  return roots;
}

let cachedOpenPath;
function defaultFileOpenPath() {
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
  createFileProvider,
  createFileIndex,
  createExcludeMatcher,
  scanRoots,
  makeEntry,
  entryToCandidate,
  joinPath,
  defaultRoots,
  DEFAULT_EXCLUDES,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAX_ENTRIES,
  CACHE_VERSION,
};
