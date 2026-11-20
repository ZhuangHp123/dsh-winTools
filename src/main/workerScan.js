'use strict';

/**
 * 把文件扫描丢进 worker 线程，并保持与 fileProvider 的 scan 接口一致：
 * ({ roots, onBatch }) => Promise<{stats}>
 *
 * worker 起不来（比如打包环境路径异常）时降级到主进程内扫描——
 * 慢一点，但功能不能丢。
 */

const path = require('node:path');

/**
 * @param {object} deps
 * @param {import('node:worker_threads').Worker} deps.Worker
 * @param {Function} deps.fallback 主进程内扫描实现
 * @param {string} [deps.workerPath]
 * @returns {(options:{roots:string[], extensions?:string[], excludes?:string[], maxEntries?:number, onBatch?:Function}) => Promise<object>}
 */
function createWorkerScan(deps) {
  const { Worker, fallback } = deps;
  const workerPath = deps.workerPath ?? path.join(__dirname, 'scanWorker.js');

  return (options) =>
    new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(workerPath, {
          workerData: {
            roots: options.roots ?? [],
            extensions: options.extensions,
            excludes: options.excludes,
            maxEntries: options.maxEntries,
          },
        });
      } catch {
        // 起不来就直接内联扫，至少功能还在。
        Promise.resolve(fallback(options)).then(resolve, reject);
        return;
      }

      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
        worker.terminate().catch(() => {});
      };

      worker.on('message', (message) => {
        // 结束后到达的批次是线程关闭前的尾巴，丢掉——索引已经 markBuilt，
        // 再塞进去会和"已完成"状态冲突。
        if (settled) return;
        if (message?.type === 'batch') {
          if (typeof options.onBatch === 'function') options.onBatch(message.entries);
        } else if (message?.type === 'done') {
          settle(resolve, { stats: message.stats });
        } else if (message?.type === 'error') {
          settle(reject, new Error(message.message));
        }
      });
      worker.on('error', (error) => {
        // worker 崩了：退回主进程内扫描，别让索引永远为空。
        if (settled) return;
        settled = true;
        worker.terminate().catch(() => {});
        Promise.resolve(fallback(options)).then(resolve, reject);
      });
      worker.on('exit', (code) => {
        if (settled) return;
        settle(resolve, { stats: { exitCode: code } });
      });
    });
}

module.exports = { createWorkerScan };
