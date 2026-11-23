'use strict';

/**
 * config.json 读写。
 *
 * 和 persistence.js 的缓存不同：配置文件是用户手写/程序改写共用的，
 * 所以写的时候要保住用户自己加的其他字段，且读坏了不能悄悄覆盖成空对象——
 * 那等于把用户手写的整份配置抹掉。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 读配置。
 * @returns {{ok:true, data:object} | {ok:false, message:string}}
 *          文件不存在视为空配置（首次启动的正常情况）。
 */
function readConfigFile(filePath, deps = {}) {
  const fsl = deps.fs ?? fs;
  try {
    const text = fsl.readFileSync(filePath, 'utf8');
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, message: '顶层必须是 JSON 对象' };
    }
    return { ok: true, data };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, data: {} };
    return { ok: false, message: String(error?.message ?? error) };
  }
}

/**
 * 原子写配置：先写 .tmp 再 rename。
 * @returns {{ok:true} | {ok:false, message:string}}
 */
function writeConfigFile(filePath, data, deps = {}) {
  const fsl = deps.fs ?? fs;
  const tmpPath = `${filePath}.tmp`;
  try {
    fsl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsl.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fsl.renameSync(tmpPath, filePath);
    return { ok: true };
  } catch (error) {
    try {
      fsl.unlinkSync(tmpPath);
    } catch {
      /* 清理失败无所谓 */
    }
    return { ok: false, message: String(error?.message ?? error) };
  }
}

module.exports = { readConfigFile, writeConfigFile };
