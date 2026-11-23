'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readConfigFile, writeConfigFile } = require('../src/main/configFile');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-config-'));
}

test('文件不存在时返回空对象而不是报错', () => {
  const dir = tempDir();
  const result = readConfigFile(path.join(dir, 'config.json'));
  assert.deepEqual(result, { ok: true, data: {} });
});

test('正常读取对象', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ hotkey: 'Ctrl+Alt+K' }), 'utf8');
  const result = readConfigFile(file);
  assert.equal(result.ok, true);
  assert.equal(result.data.hotkey, 'Ctrl+Alt+K');
});

test('坏 JSON 返回失败而不是空对象（避免覆盖用户配置）', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ "hotkey": ', 'utf8');
  const result = readConfigFile(file);
  assert.equal(result.ok, false);
  assert.match(result.message, /JSON|Unexpected/i);
});

test('顶层是数组或原始值时判为无效', () => {
  const dir = tempDir();
  for (const body of ['[]', '"x"', '42', 'null']) {
    const file = path.join(dir, `c-${body.length}.json`);
    fs.writeFileSync(file, body, 'utf8');
    assert.equal(readConfigFile(file).ok, false, `${body} 被当成有效配置`);
  }
});

test('写入后再读回内容一致，且是两空格缩进的 JSON', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'config.json');
  const data = { prefixes: { app: ['app'] }, hotkey: 'Alt+Space' };
  const written = writeConfigFile(file, data);
  assert.equal(written.ok, true);
  assert.equal(readConfigFile(file).data.hotkey, 'Alt+Space');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^\{\n {2}"prefixes"/);
  assert.ok(text.endsWith('\n'), '文件应以换行结尾');
});

test('写入失败时返回错误而不是抛异常', () => {
  const dir = tempDir();
  // 用一个已存在的文件当目录，mkdir 必然失败
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const result = writeConfigFile(path.join(blocker, 'config.json'), { a: 1 });
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, 'string');
});

test('写入不会留下 .tmp 残留', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  writeConfigFile(file, { a: 1 });
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
