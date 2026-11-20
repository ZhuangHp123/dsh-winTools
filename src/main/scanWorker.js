'use strict';

/**
 * 文件扫描 worker。
 *
 * 文件扫描是本项目唯一的长任务（整盘几十万目录）。放在 worker 里，
 * 主进程只负责收批次、塞进索引——这样即使正在扫盘，窗口依然能秒开、能搜。
 *
 * 之前踩过的坑：在主进程里跑扫盘会让 UI 事件循环被 IO 回调挤占，
 * 窗口出现"打字半秒才出来"的卡顿。setImmediate 让出不够，必须换线程。
 */

const { parentPort, workerData } = require('node:worker_threads');
const { scanRoots } = require('../files/fileProvider');

async function run() {
  try {
    const result = await scanRoots({
      roots: workerData.roots,
      extensions: workerData.extensions,
      excludes: workerData.excludes,
      maxEntries: workerData.maxEntries,
      onBatch: (batch, stats) => {
        parentPort.postMessage({ type: 'batch', entries: batch, scannedDirs: stats.scannedDirs });
      },
    });
    parentPort.postMessage({ type: 'done', stats: result.stats, count: result.entries.length });
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: String(error?.message ?? error) });
  }
}

run();
