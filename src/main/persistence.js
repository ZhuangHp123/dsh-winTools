'use strict';

/**
 * JSON 缓存文件读写。
 *
 * fileProvider / clipboardProvider 都只要求一个 { load, save } 形状的 cache，
 * 这里把那套"读坏了不能炸、写的时候要原子"的细节收在一处。
 *
 * 原子写：先写 .tmp 再 rename。直接覆盖写如果在写一半时进程被杀，
 * 会留下半截 JSON，下次启动所有历史就没了。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} filePath
 * @param {object} [deps]
 * @param {object} [deps.fs] 注入文件系统（测试用）
 * @param {(message:string)=>void} [deps.onError]
 * @returns {{load:()=>Promise<object|null>, save:(data:object)=>Promise<boolean>, path:string}}
 */
function createJsonCache(filePath, deps = {}) {
  const fsl = deps.fs ?? fs;
  const onError = deps.onError ?? (() => {});

  async function load() {
    try {
      const text = await fsl.promises.readFile(filePath, 'utf8');
      const data = JSON.parse(text);
      return data && typeof data === 'object' ? data : null;
    } catch (error) {
      // 首次启动没有文件是正常的；损坏也当作"没有缓存"，不阻断启动。
      if (error?.code !== 'ENOENT') onError(`读取缓存失败 ${filePath}: ${error?.message ?? error}`);
      return null;
    }
  }

  async function save(data) {
    const tmpPath = `${filePath}.tmp`;
    try {
      await fsl.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fsl.promises.writeFile(tmpPath, JSON.stringify(data), 'utf8');
      await fsl.promises.rename(tmpPath, filePath);
      return true;
    } catch (error) {
      onError(`写入缓存失败 ${filePath}: ${error?.message ?? error}`);
      // 清理可能残留的临时文件；清理失败无所谓。
      try {
        await fsl.promises.unlink(tmpPath);
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  return { load, save, path: filePath };
}

module.exports = { createJsonCache };
