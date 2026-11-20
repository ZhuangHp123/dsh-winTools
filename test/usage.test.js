'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUsageStore, attachPersistence } = require('../src/core/usage');

const NOW = 1_700_000_000_000;

test('记录一次使用后 count 递增、lastUsed 更新', () => {
  const store = createUsageStore({ clock: { now: () => NOW } });
  assert.equal(store.get('a'), null);
  store.record('a');
  assert.deepEqual(store.get('a'), { count: 1, lastUsed: NOW });
  store.record('a');
  assert.equal(store.get('a').count, 2);
});

test('显式传入时间戳可以覆盖 clock', () => {
  const store = createUsageStore({ clock: { now: () => NOW } });
  store.record('a', NOW - 1000);
  assert.equal(store.get('a').lastUsed, NOW - 1000);
});

test('空 key 被忽略', () => {
  const store = createUsageStore();
  store.record('');
  store.record(null);
  assert.equal(store.size(), 0);
});

test('超过上限时淘汰最久未用的', () => {
  const store = createUsageStore({ limit: 3 });
  store.record('a', 1);
  store.record('b', 2);
  store.record('c', 3);
  store.record('d', 4);
  assert.equal(store.size(), 3);
  assert.equal(store.get('a'), null, '最早的应被淘汰');
  assert.ok(store.get('d'), '最新的应保留');
});

test('重新用到旧 key 会把它移到队尾，免于淘汰', () => {
  const store = createUsageStore({ limit: 2 });
  store.record('a', 1);
  store.record('b', 2);
  store.record('a', 3); // a 重新使用，应排到 b 后面
  store.record('c', 4); // 淘汰 b
  assert.ok(store.get('a'), 'a 刚用过，不该被淘汰');
  assert.equal(store.get('b'), null);
});

test('toJSON / load 往返一致', () => {
  const store = createUsageStore();
  store.record('x', 100);
  store.record('y', 200);
  const dump = store.toJSON();

  const restored = createUsageStore();
  restored.load(dump);
  assert.deepEqual(restored.toJSON(), dump);
});

test('load 会先清空既有数据', () => {
  const store = createUsageStore();
  store.record('old');
  store.load({ fresh: { count: 1, lastUsed: 1 } });
  assert.equal(store.get('old'), null);
  assert.ok(store.get('fresh'));
});

test('load 对脏数据容错', () => {
  const store = createUsageStore();
  store.load(null);
  assert.equal(store.size(), 0);
  store.load({ bad: null, alsoBad: 'x', ok: { count: 2, lastUsed: 5 } });
  assert.equal(store.size(), 1);
  assert.equal(store.get('ok').count, 2);
});

test('load 后顺序按 lastUsed 升序，保证 LRU 语义', () => {
  const store = createUsageStore({ limit: 2 });
  store.load({
    newer: { count: 1, lastUsed: 300 },
    oldest: { count: 1, lastUsed: 100 },
    middle: { count: 1, lastUsed: 200 },
  });
  // 装载 3 条、上限 2 条 → 淘汰 lastUsed 最小的那个。
  assert.equal(store.get('oldest'), null);
  assert.ok(store.get('newer'));
  assert.ok(store.get('middle'));
});

test('attachPersistence 读写真实文件（用临时目录）', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wintools-usage-'));
  const file = path.join(dir, 'nested', 'usage.json');
  try {
    const store = createUsageStore();
    store.record('app:code', 111);
    const persistence = attachPersistence(store, file);
    assert.equal(persistence.loadFromDisk(), false, '文件不存在时读取应返回 false');
    assert.equal(persistence.saveToDisk(), true);
    assert.ok(fs.existsSync(file), '嵌套目录应被自动创建');

    const other = createUsageStore();
    const reader = attachPersistence(other, file);
    assert.equal(reader.loadFromDisk(), true);
    assert.deepEqual(other.get('app:code'), { count: 1, lastUsed: 111 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('磁盘上是坏 JSON 时读取返回 false 而不是抛错', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wintools-usage-bad-'));
  const file = path.join(dir, 'usage.json');
  try {
    fs.writeFileSync(file, '{ not json', 'utf8');
    const store = createUsageStore();
    assert.equal(attachPersistence(store, file).loadFromDisk(), false);
    assert.equal(store.size(), 0, '坏文件不该污染内存状态');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
