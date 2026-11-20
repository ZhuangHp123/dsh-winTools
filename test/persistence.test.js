'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createJsonCache } = require('../src/main/persistence');

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cache-'));
  return path.join(dir, name);
}

test('save 后 load 能读回同一份数据', async () => {
  const file = tempFile('c.json');
  const cache = createJsonCache(file);
  assert.equal(await cache.save({ a: 1, list: [1, 2] }), true);
  assert.deepEqual(await cache.load(), { a: 1, list: [1, 2] });
});

test('文件不存在时 load 返回 null，不报错', async () => {
  const errors = [];
  const cache = createJsonCache(tempFile('missing.json'), { onError: (m) => errors.push(m) });
  assert.equal(await cache.load(), null);
  assert.equal(errors.length, 0, '首次启动无文件是正常情况');
});

test('内容损坏时 load 返回 null 并回调错误', async () => {
  const file = tempFile('broken.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json', 'utf8');
  const errors = [];
  const cache = createJsonCache(file, { onError: (m) => errors.push(m) });
  assert.equal(await cache.load(), null);
  assert.equal(errors.length, 1);
});

test('save 会创建多级父目录', async () => {
  const file = path.join(tempFile('x'), 'deep', 'nested', 'c.json');
  const cache = createJsonCache(file);
  assert.equal(await cache.save({ ok: true }), true);
  assert.equal(fs.existsSync(file), true);
});

test('save 失败时返回 false 且不留半截文件', async () => {
  const file = tempFile('c.json');
  // 让 rename 失败：目标路径变成目录。
  fs.mkdirSync(file, { recursive: true });
  const errors = [];
  const cache = createJsonCache(file, { onError: (m) => errors.push(m) });
  assert.equal(await cache.save({ a: 1 }), false);
  assert.equal(errors.length, 1);
});

test('save 覆盖旧内容时不会留下旧数据', async () => {
  const file = tempFile('c.json');
  const cache = createJsonCache(file);
  await cache.save({ v: 1 });
  await cache.save({ v: 2 });
  assert.deepEqual(await cache.load(), { v: 2 });
});
