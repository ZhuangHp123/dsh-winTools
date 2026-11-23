'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PREFIXES,
  SCOPE_LABEL,
  WEB_SCOPES,
  resolvePrefixes,
  aliasesFor,
  scopeForWord,
  shortAlias,
  hintEntries,
  diffPrefixes,
} = require('../src/core/prefixes');

test('不传覆盖时原样返回默认前缀', () => {
  const { prefixes, conflicts } = resolvePrefixes();
  assert.deepEqual(prefixes, DEFAULT_PREFIXES);
  assert.deepEqual(conflicts, []);
});

test('覆盖一个 scope 只改那一项', () => {
  const { prefixes } = resolvePrefixes({ app: ['程序', 'ap'] });
  assert.deepEqual(prefixes.app, ['程序', 'ap']);
  assert.deepEqual(prefixes.file, DEFAULT_PREFIXES.file);
});

test('未知 scope 被丢弃，不会凭空多出可锁定范围', () => {
  const { prefixes } = resolvePrefixes({ nosuch: ['zz'] });
  assert.equal('nosuch' in prefixes, false);
  assert.deepEqual(Object.keys(prefixes).sort(), Object.keys(DEFAULT_PREFIXES).sort());
});

test('非字符串数组的覆盖整项回退默认', () => {
  for (const bad of [null, 'a', 123, ['a', 1], [], ['  ']]) {
    const { prefixes } = resolvePrefixes({ app: bad });
    assert.deepEqual(prefixes.app, DEFAULT_PREFIXES.app, `覆盖值 ${JSON.stringify(bad)} 未回退`);
  }
});

test('自定义词去空白并去掉大小写重复项', () => {
  const { prefixes } = resolvePrefixes({ app: [' App ', 'app', '程序'] });
  assert.deepEqual(prefixes.app, ['App', '程序']);
});

test('同一个词被两个 scope 认领时先到先得，并报冲突', () => {
  const { prefixes, conflicts } = resolvePrefixes({ file: ['x'], clipboard: ['x'] });
  assert.deepEqual(prefixes.file, ['x']);
  assert.deepEqual(prefixes.clipboard, []);
  assert.deepEqual(conflicts, [{ word: 'x', kept: 'file', dropped: 'clipboard' }]);
});

test('默认表内部没有跨 scope 重名', () => {
  const { conflicts } = resolvePrefixes();
  assert.deepEqual(conflicts, []);
});

test('aliasesFor 合并多 scope 并保持顺序去重', () => {
  const { prefixes } = resolvePrefixes();
  const web = aliasesFor(prefixes, WEB_SCOPES);
  assert.equal(web[0], '网页');
  assert.ok(web.includes('b'));
  assert.ok(web.includes('w'));
  assert.equal(new Set(web.map((w) => w.toLowerCase())).size, web.length);
});

test('scopeForWord 大小写不敏感，未命中返回 null', () => {
  const { prefixes } = resolvePrefixes();
  assert.equal(scopeForWord(prefixes, 'A'), 'app');
  assert.equal(scopeForWord(prefixes, '书签'), 'bookmark');
  assert.equal(scopeForWord(prefixes, 'w'), 'tab');
  assert.equal(scopeForWord(prefixes, 'zzz'), null);
  assert.equal(scopeForWord(prefixes, ''), null);
});

test('自定义前缀立刻能被 scopeForWord 认出来', () => {
  const { prefixes } = resolvePrefixes({ bookmark: ['☆'] });
  assert.equal(scopeForWord(prefixes, '☆'), 'bookmark');
  assert.equal(scopeForWord(prefixes, 'b'), null, '旧词已被替换');
});

test('shortAlias 优先单字符 ASCII 缩写', () => {
  const { prefixes } = resolvePrefixes();
  assert.equal(shortAlias(prefixes, 'app'), 'a');
  assert.equal(shortAlias(prefixes, 'clipboard'), 'v');
  const custom = resolvePrefixes({ app: ['程序', 'tool'] }).prefixes;
  assert.equal(shortAlias(custom, 'app'), 'tool');
  const noAscii = resolvePrefixes({ app: ['程序'] }).prefixes;
  assert.equal(shortAlias(noAscii, 'app'), '程序');
});

test('hintEntries 覆盖全部 scope 并按默认顺序排列', () => {
  const { prefixes } = resolvePrefixes();
  const hint = hintEntries(prefixes);
  assert.deepEqual(
    hint.map((entry) => entry.scope),
    Object.keys(SCOPE_LABEL),
  );
  for (const entry of hint) {
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.alias.length > 0);
  }
});

test('把某一类前缀清空会回退默认，不会变成锁不上的死范围', () => {
  const { prefixes } = resolvePrefixes({ clipboard: [] });
  assert.deepEqual(prefixes.clipboard, DEFAULT_PREFIXES.clipboard);
  assert.ok(hintEntries(prefixes).some((entry) => entry.scope === 'clipboard'));
});

test('diffPrefixes 全默认时返回空对象', () => {
  const { prefixes } = resolvePrefixes();
  assert.deepEqual(diffPrefixes(prefixes), {});
});

test('diffPrefixes 只保留改过的 scope', () => {
  const { prefixes } = resolvePrefixes({ app: ['软件'], bookmark: ['收藏', 'bm'] });
  assert.deepEqual(diffPrefixes(prefixes), {
    app: ['软件'],
    bookmark: ['收藏', 'bm'],
  });
});

test('diffPrefixes 大小写不同不算改动', () => {
  const { prefixes } = resolvePrefixes({ app: ['应用', 'APPS', 'program', '程序', 'a'] });
  assert.equal('app' in diffPrefixes(prefixes), false);
});
