'use strict';

/**
 * 钉钉头像。
 *
 * 客户端会把渲染过的头像缓存在 `<dataDir>/AvatarFiles`，文件名是
 * `<mediaId>_<原图宽>_<原图高>.<ext>`，旁边还有一个 `_60x60q90` 缩略图。
 * mediaId 就是数据库 `tbuser_profile_v2.iconMediaId` 去掉前导 `@`，
 * 所以大部分联系人不用联网就能拿到真实头像。
 *
 * 本地没有的人（客户端最近没渲染过 TA）从钉钉 CDN 补：
 *   https://static.dingtalk.com/media/<mediaId>_<w>_<h>.<ext>_75x75q90_xz.<ext>
 * 原图尺寸编在 mediaId 里：若干「0xCD + 大端 u16」对，最后两对是高度和宽度。
 * 不带尺寸后缀直接 404，所以必须先解出来。
 */

const fs = require('node:fs');
const path = require('node:path');

const CDN_BASE = 'https://static.dingtalk.com/media/';
/**
 * CDN 的缩放后缀随原图格式而变：jpg 认 `_75x75q90_xz`，png 认 `_60x60q90`，
 * 用错后缀一律 404。两个都试一遍，命中即止。
 */
const CDN_VARIANTS = [
  { ext: 'jpg', suffix: '_75x75q90_xz' },
  { ext: 'png', suffix: '_60x60q90' },
  { ext: 'jpg', suffix: '_60x60q90' },
  { ext: 'png', suffix: '_75x75q90_xz' },
];
const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const PREFETCH_CONCURRENCY = 4;

function normalize(mediaId) {
  return String(mediaId ?? '').trim().replace(/^@/, '');
}

/** 从 mediaId 里解出原图尺寸；解不出返回 null。 */
function dimensionsOf(mediaId) {
  const id = normalize(mediaId);
  if (!id) return null;
  let bytes;
  try {
    bytes = Buffer.from(id, 'base64');
  } catch {
    return null;
  }
  const found = [];
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] !== 0xcd) continue;
    const value = bytes.readUInt16BE(i + 1);
    if (value > 16 && value < 4096) found.push(value);
  }
  if (found.length < 2) return null;
  return { height: found[found.length - 2], width: found[found.length - 1] };
}

/** mediaId → 本地缩略图路径（优先 60x60，没有就取最小的那张）。 */
function indexLocalAvatars(dirs) {
  const index = new Map();
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const base = name.replace(/_60x60[^.]*\.[a-z]+$/i, '').replace(/_\d+_\d+\.[a-z]+$/i, '');
      if (!base || base === name) continue;
      const ext = (name.match(/\.([a-z]+)$/i)?.[1] ?? '').toLowerCase();
      if (!MIME[ext]) continue;
      let size = 0;
      try {
        size = fs.statSync(path.join(dir, name)).size;
      } catch {
        continue;
      }
      const isSmall = /_60x60/.test(name);
      const candidate = { file: path.join(dir, name), ext, size, isSmall };
      const existing = index.get(base);
      if (!existing || (isSmall && !existing.isSmall) || (isSmall === existing.isSmall && size < existing.size)) {
        index.set(base, candidate);
      }
    }
  }
  return index;
}

/**
 * @param {object} options
 * @param {string[]} [options.avatarDirs] 客户端的 AvatarFiles 目录
 * @param {string} [options.cacheDir] 我们自己的头像落盘目录
 * @param {Function} [options.fetch] 测试注入
 */
function createAvatarStore(options = {}) {
  const local = indexLocalAvatars(options.avatarDirs ?? []);
  const cacheDir = options.cacheDir;
  const doFetch = options.fetch ?? globalThis.fetch;
  /** mediaId → data URL，最多几百条，不做淘汰。 */
  const memory = new Map();
  /** 已经试过、确认拿不到的，别再反复试。 */
  const missing = new Set();
  const inflight = new Map();

  function cachedFile(id) {
    if (!cacheDir) return null;
    for (const ext of Object.keys(MIME)) {
      const file = path.join(cacheDir, `${id}.${ext}`);
      if (fs.existsSync(file)) return { file, ext };
    }
    return null;
  }

  function readAsDataUrl(file, ext) {
    const data = fs.readFileSync(file);
    return `data:${MIME[ext]};base64,${data.toString('base64')}`;
  }

  function localDataUrl(id) {
    const hit = cachedFile(id);
    if (hit) return readAsDataUrl(hit.file, hit.ext);
    const bundled = local.get(id);
    if (bundled) return readAsDataUrl(bundled.file, bundled.ext);
    return null;
  }

  /** 同步取：本地有就立刻给，没有返回 null（不阻塞搜索）。 */
  function dataUrl(mediaId) {
    const id = normalize(mediaId);
    if (!id || missing.has(id)) return null;
    if (memory.has(id)) return memory.get(id);
    try {
      const url = localDataUrl(id);
      if (url) {
        memory.set(id, url);
        return url;
      }
    } catch {
      /* 读不到就当没有 */
    }
    return null;
  }

  async function download(id) {
    const dims = dimensionsOf(id);
    if (!dims) return false;
    for (const { ext, suffix } of CDN_VARIANTS) {
      const url = `${CDN_BASE}${id}_${dims.width}_${dims.height}.${ext}${suffix}.${ext}`;
      let response;
      try {
        response = await doFetch(url);
      } catch {
        continue;
      }
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) continue;
      memory.set(id, `data:${MIME[ext]};base64,${buffer.toString('base64')}`);
      if (cacheDir) {
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(path.join(cacheDir, `${id}.${ext}`), buffer);
        } catch {
          /* 落盘失败不影响本次显示 */
        }
      }
      return true;
    }
    return false;
  }

  function ensure(mediaId) {
    const id = normalize(mediaId);
    if (!id || memory.has(id) || missing.has(id)) return Promise.resolve(Boolean(memory.has(id)));
    if (!inflight.has(id)) {
      const task = download(id)
        .then((ok) => {
          if (!ok) missing.add(id);
          return ok;
        })
        .catch(() => {
          missing.add(id);
          return false;
        })
        .finally(() => inflight.delete(id));
      inflight.set(id, task);
    }
    return inflight.get(id);
  }

  /** 后台补齐：给一批 mediaId 慢慢下，失败静默。 */
  async function prefetch(mediaIds) {
    const queue = [...new Set((mediaIds ?? []).map(normalize))].filter(
      (id) => id && !memory.has(id) && !missing.has(id) && !local.has(id),
    );
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const id = queue[cursor];
        cursor += 1;
        await ensure(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queue.length) }, worker));
  }

  return {
    dataUrl,
    ensure,
    prefetch,
    stats: () => ({ local: local.size, memory: memory.size, missing: missing.size }),
  };
}

module.exports = { createAvatarStore, dimensionsOf, normalize, indexLocalAvatars };
