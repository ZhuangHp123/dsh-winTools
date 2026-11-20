'use strict';

/**
 * 使用习惯记录（frecency 的存储）。
 *
 * 只做两件事：记下"某个 key 被选中过几次、最后一次是什么时候"，
 * 以及把这份数据落盘/读回。
 *
 * 存储层是注入的（默认用 fs），所以单测不需要碰真实磁盘。
 */

const DEFAULT_LIMIT = 2000;

/**
 * @param {object} options
 * @param {number} [options.limit] 最多保留多少条（超出时丢弃最久未用的）
 * @param {{now:()=>number}} [options.clock]
 */
function createUsageStore(options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : DEFAULT_LIMIT;
  const now = typeof options.clock?.now === 'function' ? options.clock.now : () => Date.now();
  /** @type {Map<string, {count:number, lastUsed:number}>} */
  const entries = new Map();

  function get(key) {
    return entries.get(key) ?? null;
  }

  /** 记录一次使用。 */
  function record(key, at) {
    if (!key) return null;
    const timestamp = Number.isFinite(at) ? at : now();
    const existing = entries.get(key);
    const next = {
      count: (existing?.count ?? 0) + 1,
      lastUsed: timestamp,
    };
    // Map 保持插入顺序，删了重插相当于"移到队尾"，淘汰时直接取头部。
    entries.delete(key);
    entries.set(key, next);
    trim();
    return next;
  }

  /** 显式设置（用于导入历史）。 */
  function set(key, value) {
    if (!key) return;
    const count = Math.max(0, Math.floor(Number(value?.count) || 0));
    const lastUsed = Number(value?.lastUsed) || 0;
    entries.delete(key);
    if (count > 0) entries.set(key, { count, lastUsed });
    trim();
  }

  function trim() {
    while (entries.size > limit) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  function size() {
    return entries.size;
  }

  /** 导出为普通对象，便于 JSON 序列化。 */
  function toJSON() {
    const out = {};
    for (const [key, value] of entries) out[key] = value;
    return out;
  }

  /** 从普通对象装载（会先清空）。 */
  function load(data) {
    entries.clear();
    if (!data || typeof data !== 'object') return;
    const rows = Object.entries(data);
    // 按 lastUsed 升序插入，让 Map 顺序与 LRU 语义一致。
    rows.sort((a, b) => (Number(a[1]?.lastUsed) || 0) - (Number(b[1]?.lastUsed) || 0));
    for (const [key, value] of rows) set(key, value);
  }

  return { get, record, set, size, toJSON, load, limit };
}

/**
 * 把 store 挂到磁盘。
 * @param {object} store createUsageStore 的返回值
 * @param {string} filePath
 * @param {object} [fsLike] 默认 require('node:fs')
 */
function attachPersistence(store, filePath, fsLike, pathLike) {
  const fs = fsLike ?? require('node:fs');
  const path = pathLike ?? require('node:path');

  function loadFromDisk() {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      store.load(JSON.parse(text));
      return true;
    } catch {
      return false;
    }
  }

  function saveToDisk() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(store.toJSON()), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  return { loadFromDisk, saveToDisk };
}

module.exports = { createUsageStore, attachPersistence, DEFAULT_LIMIT };
