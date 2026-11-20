'use strict';

/**
 * workerScan 单测。
 *
 * 用一个假的 Worker 类模拟线程行为（消息、错误、退出），
 * 不起真线程：测试要快且稳定。真实 worker 路径由 Electron 冒烟测试覆盖。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createWorkerScan } = require('../src/main/workerScan');

/** 假 Worker：手动触发 message/error/exit。 */
class FakeWorker extends EventEmitter {
  constructor(file, options) {
    super();
    this.file = file;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  terminate() {
    return Promise.resolve();
  }
}
FakeWorker.instances = [];

function makeScan(overrides = {}) {
  FakeWorker.instances = [];
  const fallback = overrides.fallback ?? (async () => ({ stats: { via: 'fallback' } }));
  const scan = createWorkerScan({ Worker: FakeWorker, fallback, workerPath: 'fake-worker.js' });
  return { scan, fallback };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('把 roots 等参数传给 worker', async () => {
  const { scan } = makeScan();
  const pending = scan({ roots: ['C:\\'], maxEntries: 10 });
  const worker = FakeWorker.instances[0];
  assert.deepEqual(worker.options.workerData.roots, ['C:\\']);
  assert.equal(worker.options.workerData.maxEntries, 10);
  worker.emit('message', { type: 'done', stats: { count: 1 } });
  const result = await pending;
  assert.deepEqual(result.stats, { count: 1 });
});

test('batch 消息回调 onBatch，done 才 resolve', async () => {
  const { scan } = makeScan();
  const batches = [];
  let resolved = false;
  const pending = scan({ roots: [], onBatch: (b) => batches.push(b) }).then((r) => {
    resolved = true;
    return r;
  });

  const worker = FakeWorker.instances[0];
  worker.emit('message', { type: 'batch', entries: [{ path: 'a' }] });
  await flush();
  assert.equal(resolved, false, '收到 done 之前不应 resolve');
  assert.deepEqual(batches, [[{ path: 'a' }]]);

  worker.emit('message', { type: 'done', stats: {} });
  await pending;
  assert.equal(resolved, true);
});

test('worker 报错误消息时 reject', async () => {
  const { scan } = makeScan();
  const pending = scan({ roots: [] });
  FakeWorker.instances[0].emit('message', { type: 'error', message: '扫描炸了' });
  await assert.rejects(pending, /扫描炸了/);
});

test('worker 起不来时降级到主进程内扫描', async () => {
  FakeWorker.instances = [];
  const fallback = async (options) => ({ stats: { roots: options.roots.length } });
  const scan = createWorkerScan({
    Worker: function BrokenWorker() {
      throw new Error('no threads');
    },
    fallback,
    workerPath: 'x.js',
  });
  const result = await scan({ roots: ['C:\\', 'D:\\'] });
  assert.deepEqual(result.stats, { roots: 2 });
});

test('worker 运行时崩溃也会退到 fallback', async () => {
  const { scan } = makeScan();
  const pending = scan({ roots: ['C:\\'] });
  FakeWorker.instances[0].emit('error', new Error('thread died'));
  const result = await pending;
  assert.deepEqual(result.stats, { via: 'fallback' });
});

test('done 之后重复的 message 被忽略', async () => {
  const { scan } = makeScan();
  const batches = [];
  const pending = scan({ roots: [], onBatch: (b) => batches.push(b) });
  const worker = FakeWorker.instances[0];
  worker.emit('message', { type: 'done', stats: {} });
  await pending;
  worker.emit('message', { type: 'batch', entries: [{ path: 'late' }] });
  await flush();
  assert.equal(batches.length, 0, '结束后的批次不应再回传');
});
