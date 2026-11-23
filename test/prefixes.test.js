'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PREFIXES,
  SCOPE_LABEL,
  WEB_SCOPES,
  isPrefixWord,
  normalizePrefix,
  resolvePrefixes,
  aliasesFor,
  scopeForWord,
  prefixOf,
  hintEntries,
  isDefault,
  diffPrefixes,
} = require('../src/core/prefixes');

test('默认前缀每类都是单个词（默认给单字母英文）', () => {
  for (const [scope, word] of Object.entries(DEFAULT_PREFIXES)) {
    assert.equal(typeof word, 'string', `${scope} 不是字符串`);
    assert.ok(isPrefixWord(word), `${scope} 的默认值 ${word} 不是单个词`);
    assert.match(word, /^[a-z]+$/, `${scope} 的默认值应是纯英文小写`);
  }
});

test('默认前缀之间没有重复', () => {
  const words = Object.values(DEFAULT_PREFIXES).map((w) => w.toLowerCase());
  assert.equal(new Set(words).size, words.length);
});

test('不传覆盖时拿到全部默认值', () => {
  const { prefixes, conflicts, invalid } = resolvePrefixes();
  assert.deepEqual(prefixes, DEFAULT_PREFIXES);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(invalid, []);
});

test('覆盖一个范围只改那一项，其余沿用默认', () => {
  const { prefixes } = resolvePrefixes({ app: 'ap' });
  assert.equal(prefixes.app, 'ap');
  assert.equal(prefixes.file, DEFAULT_PREFIXES.file);
});

test('未知范围被丢弃', () => {
  const { prefixes } = resolvePrefixes({ nosuch: 'zz' });
  assert.equal('nosuch' in prefixes, false);
});

test('空串和空白视为用默认', () => {
  for (const blank of ['', '   ']) {
    const { prefixes, invalid } = resolvePrefixes({ app: blank });
    assert.equal(prefixes.app, DEFAULT_PREFIXES.app);
    assert.deepEqual(invalid, []);
  }
});

test('中文前缀是合法的（只要求是单个词）', () => {
  const { prefixes, invalid } = resolvePrefixes({ app: '应用', bookmark: '收藏' });
  assert.equal(prefixes.app, '应用');
  assert.equal(prefixes.bookmark, '收藏');
  assert.deepEqual(invalid, []);
});

test('多个词/带空格是非法值，回退默认并记 invalid', () => {
  for (const bad of ['a b', '应用 apps', '  a  b  ']) {
    const { prefixes, invalid } = resolvePrefixes({ app: bad });
    assert.equal(prefixes.app, DEFAULT_PREFIXES.app, `${bad} 未回退`);
    assert.deepEqual(invalid, [{ scope: 'app', value: bad }]);
  }
});

test('很长或带符号的前缀也合法（不限制字数和字符）', () => {
  const { prefixes, invalid } = resolvePrefixes({ app: 'applications', bookmark: '★' });
  assert.equal(prefixes.app, 'applications');
  assert.equal(prefixes.bookmark, '★');
  assert.deepEqual(invalid, []);
});

test('normalizePrefix 兼容旧版数组配置（挑第一个合法的单个词）', () => {
  assert.equal(normalizePrefix(['apps', 'a']), 'apps');
  assert.equal(normalizePrefix(['应用', 'ap']), '应用');
  assert.equal(normalizePrefix(['a b', '程序']), '程序');
  assert.equal(normalizePrefix([]), null);
  assert.equal(normalizePrefix(123), null);
});

test('isPrefixWord：非空且不含空白', () => {
  assert.equal(isPrefixWord('a'), true);
  assert.equal(isPrefixWord('应用'), true);
  assert.equal(isPrefixWord('applications'), true);
  assert.equal(isPrefixWord(''), false);
  assert.equal(isPrefixWord('a b'), false);
  assert.equal(isPrefixWord(' a'), false);
  assert.equal(isPrefixWord(123), false);
});

test('自定义前缀去空白并保留原大小写', () => {
  const { prefixes } = resolvePrefixes({ app: '  Ap  ' });
  assert.equal(prefixes.app, 'Ap');
});

test('和别的范围默认值撞车：自定义值被拒，回退本范围默认', () => {
  // file 的默认是 f，把 app 设成 f 应被拒
  const { prefixes, conflicts } = resolvePrefixes({ app: 'f' });
  assert.equal(prefixes.app, DEFAULT_PREFIXES.app);
  assert.equal(prefixes.file, 'f');
  assert.deepEqual(conflicts, [{ word: 'f', kept: 'file', dropped: 'app' }]);
});

test('两个范围填同一个自定义值：后者回退默认并报冲突', () => {
  const { prefixes, conflicts } = resolvePrefixes({ app: 'x', file: 'x' });
  assert.equal(prefixes.app, 'x');
  assert.equal(prefixes.file, DEFAULT_PREFIXES.file);
  assert.deepEqual(conflicts, [{ word: 'x', kept: 'app', dropped: 'file' }]);
});

test('解析结果里没有两个范围共用同一个前缀', () => {
  const { prefixes } = resolvePrefixes({ app: 'p', file: 'a', web: 'b' });
  const used = Object.values(prefixes).filter(Boolean).map((w) => w.toLowerCase());
  assert.equal(new Set(used).size, used.length);
});

test('大小写不同也算撞车', () => {
  const { prefixes, conflicts } = resolvePrefixes({ app: 'F' });
  assert.equal(prefixes.app, DEFAULT_PREFIXES.app);
  assert.equal(conflicts.length, 1);
});

test('aliasesFor 合并多范围并跳过 null', () => {
  const prefixes = { web: 'web', bookmark: 'b', tab: 'w' };
  assert.deepEqual(aliasesFor(prefixes, WEB_SCOPES), ['web', 'b', 'w']);
  const withNull = { web: 'web', bookmark: null, tab: 'w' };
  assert.deepEqual(aliasesFor(withNull, WEB_SCOPES), ['web', 'w']);
});

test('scopeForWord 大小写不敏感，未命中返回 null', () => {
  const { prefixes } = resolvePrefixes();
  assert.equal(scopeForWord(prefixes, 'A'), 'app');
  assert.equal(scopeForWord(prefixes, 'b'), 'bookmark');
  assert.equal(scopeForWord(prefixes, 'w'), 'tab');
  assert.equal(scopeForWord(prefixes, 'zzz'), null);
  assert.equal(scopeForWord(prefixes, ''), null);
});

test('自定义前缀立刻能被 scopeForWord 认出来，旧词失效', () => {
  const { prefixes } = resolvePrefixes({ app: 'ap' });
  assert.equal(scopeForWord(prefixes, 'ap'), 'app');
  assert.equal(scopeForWord(prefixes, 'a'), null);
});

test('prefixOf 对 null 返回空串', () => {
  assert.equal(prefixOf({ app: null }, 'app'), '');
  assert.equal(prefixOf({}, 'app'), '');
  assert.equal(prefixOf({ app: 'a' }, 'app'), 'a');
});

test('hintEntries 覆盖全部范围并按默认顺序排列', () => {
  const { prefixes } = resolvePrefixes();
  const hint = hintEntries(prefixes);
  assert.deepEqual(
    hint.map((entry) => entry.scope),
    Object.keys(SCOPE_LABEL),
  );
  for (const entry of hint) {
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.prefix.length > 0);
  }
});

test('isDefault 大小写不敏感', () => {
  assert.equal(isDefault({ app: 'A' }, 'app'), true);
  assert.equal(isDefault({ app: 'ap' }, 'app'), false);
});

test('diffPrefixes 全默认返回空对象', () => {
  assert.deepEqual(diffPrefixes(resolvePrefixes().prefixes), {});
});

test('diffPrefixes 只保留改过的范围，且是单个字符串', () => {
  const diff = diffPrefixes(resolvePrefixes({ app: 'ap', bookmark: 'bm' }).prefixes);
  assert.deepEqual(diff, { app: 'ap', bookmark: 'bm' });
  assert.equal(typeof diff.app, 'string');
});

test('diffPrefixes 跳过 null', () => {
  assert.deepEqual(diffPrefixes({ app: null }), {});
});
