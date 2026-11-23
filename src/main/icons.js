'use strict';

/**
 * 列表前置图标。
 *
 * 有实体文件的条目（应用、项目、文件）从 Windows 自己的图标资源里抽，
 * 这样列表里直接是 IDEA / Cursor / Chrome 的图标，而不是统一糊一个"项目"。
 *
 * 尺寸取 48px（Electron 的 `large`）：渲染尺寸 26px，两倍屏刚好够清晰；
 * 再大 `app.getFileIcon` 就不给了。
 *
 * .lnk 不能直接抽——实测返回的是空白文档图标，所以先解析出目标 exe 再抽。
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { parseLnkTarget } = require('../apps/lnk');

/** 抽图标的实际尺寸。 */
const ICON_SIZE = 'large';

/** 进程内缓存：同一路径只抽一次。值是 Promise，避免并发重复抽。 */
const cache = new Map();

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * 决定从哪个文件抽图标。
 *
 * - .lnk → 解析出目标并抽目标的图标（快捷方式本身抽出来是空白文档）
 * - 目录/普通文件 → 直接用，拿到的就是文件夹/文件类型图标
 *
 * @param {string} file
 * @returns {string} 实际用于抽图标的路径
 */
function iconSourceFor(file) {
  if (!file || typeof file !== 'string') return '';
  if (!file.toLowerCase().endsWith('.lnk')) return file;
  try {
    const target = parseLnkTarget(fs.readFileSync(file), { lnkPath: file, exists });
    return target && exists(target) ? target : file;
  } catch {
    return file;
  }
}

/**
 * 抽一个文件的图标，返回 data URL；抽不到返回 null。
 * 结果缓存在进程内，重复请求同一路径不会重复抽。
 *
 * @param {string} file
 * @returns {Promise<string|null>}
 */
function iconDataUrl(file) {
  const source = iconSourceFor(file);
  if (!source) return Promise.resolve(null);
  if (cache.has(source)) return cache.get(source);

  const pending = app
    .getFileIcon(source, { size: ICON_SIZE })
    .then((image) => {
      const png = image?.toPNG?.();
      return png && png.length > 0 ? `data:image/png;base64,${png.toString('base64')}` : null;
    })
    .catch(() => null);
  cache.set(source, pending);
  return pending;
}

/** 预热：后台把一批路径抽好，用户看到列表时图标多半已经就绪。 */
function prefetchIcons(files) {
  for (const file of files ?? []) {
    if (file) iconDataUrl(file).catch(() => {});
  }
}

/** 测试用：清缓存。 */
function clearIconCache() {
  cache.clear();
}

module.exports = { iconDataUrl, iconSourceFor, prefetchIcons, clearIconCache, ICON_SIZE };
