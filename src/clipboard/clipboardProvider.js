'use strict';

/**
 * 剪贴板历史 provider。
 *
 * Electron 的 clipboard 模块**没有变更事件**，只能用轮询。所以这里的
 * 结构是：
 *   - 纯逻辑层（历史列表、去重、容量控制）→ 可单测
 *   - 轮询 + 读写系统剪贴板 → 只在 Electron 里跑
 *
 * 去重策略是重点：用户的剪贴板里经常反复出现同一段文字（复制→粘贴→
 * 再复制），如果每次都记一条，历史列表会被同一个内容刷屏。所以：
 *   - 连续重复：忽略（不动时间戳，避免"假装刚用过"）
 *   - 非连续重复：把已有那条**移到最前**并更新时间戳（它是最近用的）
 */

/** 历史条数默认上限。 */
const DEFAULT_LIMIT = 200;

/** 单条内容最大长度：超长的（如整个文件）不记，避免内存爆掉。 */
const DEFAULT_MAX_TEXT_LENGTH = 8000;

/** 轮询间隔（毫秒）。太短浪费 CPU，太长会漏掉快速复制。 */
const DEFAULT_POLL_INTERVAL = 600;

/** 内容预览长度：列表里只显示一行，全文留在内存/磁盘。 */
const PREVIEW_LENGTH = 160;

/**
 * 把多行文本压成单行预览。
 * @param {string} text
 * @param {number} [maxLength]
 */
function makePreview(text, maxLength = PREVIEW_LENGTH) {
  const singleLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

/**
 * 内容指纹：用于判重。
 *
 * 用完整内容的简单哈希而不是直接比较字符串——内容可能很长，
 * 每次比较整串没必要。用 djb2 变体，够用且快。
 *
 * @param {string} text
 * @returns {string}
 */
function fingerprint(text) {
  const value = String(text ?? '');
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  // 带上长度，降低碰撞概率。
  return `${(hash >>> 0).toString(36)}-${value.length}`;
}

/**
 * 判断一段文本值不值得记进历史。
 * 空白、超长都不记——它们出现在列表里只会占位。
 * @param {string} text
 * @param {number} [maxLength]
 */
function isWorthKeeping(text, maxLength = DEFAULT_MAX_TEXT_LENGTH) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (text.length > maxLength) return false;
  return true;
}

/**
 * 创建剪贴板历史存储（纯内存，无 Electron 依赖）。
 *
 * @param {object} [options]
 * @param {number} [options.limit] 最多保留多少条
 * @param {number} [options.maxTextLength]
 * @param {{now:()=>number}} [options.clock]
 */
function createClipboardStore(options = {}) {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const now = typeof options.clock?.now === 'function' ? options.clock.now : () => Date.now();

  /**
   * 用数组而不是 Map：历史需要"最新在最前"的顺序，而且容量只有几百条，
   * 数组的插入/删除成本可以忽略，读起来也比 Map 转数组直接。
   * @type {Array<{id:string, text:string, preview:string, fingerprint:string, copiedAt:number, pinned?:boolean}>}
   */
  let items = [];
  let lastFingerprint = null;

  /**
   * 记录一次剪贴板内容。
   * @param {string} text
   * @returns {{added:boolean, moved:boolean, item?:object, reason?:string}}
   */
  function record(text) {
    if (!isWorthKeeping(text, maxTextLength)) {
      return { added: false, moved: false, reason: 'ignored' };
    }

    const fp = fingerprint(text);

    // 连续重复：完全不处理。用户在反复复制粘贴同一段内容时，
    // 历史列表不该有任何变化。
    if (fp === lastFingerprint) {
      return { added: false, moved: false, reason: 'consecutive-duplicate' };
    }
    lastFingerprint = fp;

    // 非连续重复：把旧条目提到最前（它确实是最近用过的）。
    const existingIndex = items.findIndex((item) => item.fingerprint === fp);
    if (existingIndex >= 0) {
      const [existing] = items.splice(existingIndex, 1);
      existing.copiedAt = now();
      items.unshift(existing);
      return { added: false, moved: true, item: existing };
    }

    const item = {
      id: `clipboard:${fp}`,
      text,
      preview: makePreview(text),
      fingerprint: fp,
      copiedAt: now(),
    };
    items.unshift(item);
    if (items.length > limit) {
      // 超出上限：从尾部淘汰，但保留置顶项——用户置顶就是不想它消失。
      const removed = evictOverflow();
      return { added: true, moved: false, item, removed };
    }
    return { added: true, moved: false, item };
  }

  /**
   * 淘汰超限的条目，优先删最旧的未置顶项。
   * @returns {string[]} 被删掉的 id
   */
  function evictOverflow() {
    const removed = [];
    // 从尾部往前找可以删的。
    for (let i = items.length - 1; i >= 0 && items.length > limit; i -= 1) {
      if (items[i].pinned) continue;
      removed.push(items[i].id);
      items.splice(i, 1);
    }
    return removed;
  }

  /** 列出历史（可选按关键词过滤）。 */
  function list(terms = []) {
    if (!Array.isArray(terms) || terms.length === 0) return items.slice();
    const lowered = terms.map((t) => String(t).toLowerCase());
    return items.filter((item) => {
      const haystack = item.text.toLowerCase();
      return lowered.every((term) => haystack.includes(term));
    });
  }

  function get(id) {
    return items.find((item) => item.id === id) ?? null;
  }

  /** 删除单条。 */
  function remove(id) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    items.splice(index, 1);
    return true;
  }

  /** 清空历史（保留置顶项，除非明确要求全清）。 */
  function clear({ keepPinned = true } = {}) {
    const before = items.length;
    items = keepPinned ? items.filter((item) => item.pinned) : [];
    lastFingerprint = null;
    return before - items.length;
  }

  /** 置顶/取消置顶。置顶项不会被容量淘汰挤掉。 */
  function setPinned(id, pinned) {
    const item = get(id);
    if (!item) return false;
    item.pinned = Boolean(pinned);
    return true;
  }

  function size() {
    return items.length;
  }

  /** 当前"最后一次见到的内容"，用于重启后避免立刻重复记录。 */
  function getLastFingerprint() {
    return lastFingerprint;
  }

  function setLastFingerprint(value) {
    lastFingerprint = value ?? null;
  }

  function toJSON() {
    return { version: 1, savedAt: now(), items };
  }

  /** 从缓存恢复；结构不对就返回 false，不污染内存。 */
  function loadFromJSON(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.items)) return false;
    const valid = data.items.filter(
      (item) =>
        item &&
        typeof item.text === 'string' &&
        typeof item.fingerprint === 'string' &&
        typeof item.id === 'string',
    );
    if (valid.length === 0) return false;
    items = valid.slice(0, limit);
    lastFingerprint = items[0]?.fingerprint ?? null;
    return true;
  }

  return {
    record,
    list,
    get,
    remove,
    clear,
    setPinned,
    size,
    getLastFingerprint,
    setLastFingerprint,
    toJSON,
    loadFromJSON,
  };
}

/**
 * 轮询剪贴板，有变化就记进 store。
 *
 * @param {object} options
 * @param {object} options.clipboard Electron clipboard 模块（或同接口的假对象）
 * @param {object} options.store createClipboardStore 的返回值
 * @param {number} [options.interval]
 * @param {(result:object)=>void} [options.onChange] 有新内容/移动时回调
 * @returns {{start:()=>void, stop:()=>void, pollOnce:()=>object|null, isRunning:()=>boolean}}
 */
function createClipboardWatcher(options) {
  const clipboard = options.clipboard;
  const store = options.store;
  const interval = options.interval ?? DEFAULT_POLL_INTERVAL;
  const onChange = options.onChange ?? (() => {});
  let timer = null;
  // 异步 readText（Electron 45+ 返回 Promise）时，上一轮还没回来就跳过本轮，
  // 否则慢盘或高延迟链路上会积压多个并发读，历史顺序被打乱。
  let busy = false;

  /** 处理读到的文本，返回 record 的结果（没变化返回 null）。 */
  function handleText(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    const result = store.record(text);
    if (result.added || result.moved) onChange(result);
    return result;
  }

  /**
   * 读一次剪贴板并处理。
   * 同步 clipboard（老 Electron / 单测假对象）直接返回结果；
   * 异步 clipboard 返回 Promise，调用方可以 await，也可以不管。
   */
  function pollOnce() {
    if (busy) return null;
    let text;
    try {
      text = clipboard.readText();
    } catch {
      // 剪贴板被别的进程独占时会抛，直接放弃这一轮。
      return null;
    }
    if (text && typeof text.then === 'function') {
      busy = true;
      return text
        .then(
          (value) => handleText(value),
          () => null, // 异步读取失败同样只跳过这一轮
        )
        .finally(() => {
          busy = false;
        });
    }
    return handleText(text);
  }

  function start() {
    if (timer) return;
    // 启动时先记一次当前内容，避免"复制了但没被记进来"的行为落差。
    pollOnce();
    timer = setInterval(pollOnce, interval);
    // 不让轮询定时器拖住进程退出。
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, pollOnce, isRunning: () => timer !== null };
}

/**
 * 剪贴板 provider。
 * @param {object} [options]
 * @param {object} [options.clipboard] Electron clipboard 模块
 * @param {object} [options.store]
 * @param {number} [options.limit] 结果条数上限
 * @param {(text:string)=>Promise<void>} [options.writeClipboard] 选中时写回剪贴板
 */
function createClipboardProvider(options = {}) {
  const store = options.store ?? createClipboardStore(options);
  const limit = options.limit ?? 15;
  let watcher = null;

  return {
    id: 'clipboard',
    aliases: ['剪贴板', 'clip', 'clipboard', 'cb', 'v'],
    label: '剪贴板',

    async init() {
      if (options.cache?.load) {
        try {
          const cached = await options.cache.load();
          if (cached) store.loadFromJSON(cached);
        } catch {
          /* 缓存坏了不影响使用 */
        }
      }
      // 没给 clipboard 模块就不轮询（单测/无 GUI 环境）。
      if (options.clipboard) {
        watcher = createClipboardWatcher({
          clipboard: options.clipboard,
          store,
          interval: options.interval,
          onChange: options.onChange,
        });
        watcher.start();
      }
      return { history: store.size(), watching: Boolean(watcher) };
    },

    /**
     * 空查询返回历史（最近复制的最靠前），有查询词则过滤。
     * 返回顺序即最终展示顺序，engine 排序时会因为 provider 权重
     * 和文本匹配重新排，但空查询时这里就是权威顺序。
     */
    search(terms = []) {
      const items = store.list(terms).slice(0, limit);
      return items.map((item, index) => ({
        id: item.id,
        kind: 'clipboard',
        title: item.preview || '(空白)',
        subtitle: describeTime(item.copiedAt),
        // 让 fuzzy 能匹配全文，而不是只匹配截断的预览
        tags: item.pinned ? [item.text, '置顶'] : [item.text],
        text: item.text,
        clipboardId: item.id,
        pinned: Boolean(item.pinned),
        // 保持历史顺序：engine 的空查询排序会参考它
        order: index,
      }));
    },

    async activate(item) {
      if (!item || typeof item.text !== 'string') {
        const error = new Error('缺少剪贴板内容');
        error.code = 'invalid_item';
        throw error;
      }
      if (options.writeClipboard) await options.writeClipboard(item.text);
      // 写回剪贴板后把它提到最前，符合"刚用过"的直觉。
      store.record(item.text);
      return { copied: true };
    },

    stats() {
      // 注意用 isRunning() 而不是 Boolean(watcher)：dispose 之后 watcher
      // 对象仍存在，但它已经不再轮询了，报告 watching:true 会骗人。
      return { history: store.size(), watching: Boolean(watcher?.isRunning()) };
    },

    async dispose() {
      watcher?.stop();
      if (options.cache?.save && store.size() > 0) {
        try {
          await options.cache.save(store.toJSON());
        } catch {
          /* 退出路径，忽略 */
        }
      }
    },

    /** 给 UI/测试用：底层存储。 */
    store,
  };
}

/** 相对时间描述，用于副标题。 */
function describeTime(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const diff = Math.max(0, now - timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

module.exports = {
  createClipboardProvider,
  createClipboardStore,
  createClipboardWatcher,
  makePreview,
  fingerprint,
  isWorthKeeping,
  describeTime,
  DEFAULT_LIMIT,
  DEFAULT_MAX_TEXT_LENGTH,
  DEFAULT_POLL_INTERVAL,
  PREVIEW_LENGTH,
};
