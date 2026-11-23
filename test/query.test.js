'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, parseQuery, findProvider } = require('../src/core/query');

const providers = [
  { id: 'app', aliases: ['a', '程序'] },
  { id: 'file', aliases: ['f', '文件'] },
  { id: 'clipboard', aliases: ['c', '剪贴板'] },
];

test('空输入解析成空词元', () => {
  const q = parseQuery('', providers);
  assert.deepEqual(q.terms, []);
  assert.equal(q.providerHint, null);
});

test('纯空白等于空输入', () => {
  const q = parseQuery('   \t  ', providers);
  assert.deepEqual(q.terms, []);
});

test('普通查询不锁定 provider', () => {
  const q = parseQuery('chrome', providers);
  assert.deepEqual(q.terms, ['chrome']);
  assert.equal(q.providerHint, null);
});

test('按空格切词', () => {
  const q = parseQuery('google chrome', providers);
  assert.deepEqual(q.terms, ['google', 'chrome']);
});

test('首词命中 provider id 时锁定该 provider 并剥离首词', () => {
  const q = parseQuery('app chrome', providers);
  assert.equal(q.providerHint, 'app');
  assert.deepEqual(q.terms, ['chrome']);
  assert.equal(q.keyword, 'chrome');
});

test('首词命中别名（含中文）也能锁定', () => {
  assert.equal(parseQuery('a chrome', providers).providerHint, 'app');
  assert.equal(parseQuery('程序 chrome', providers).providerHint, 'app');
  assert.deepEqual(parseQuery('程序 chrome', providers).terms, ['chrome']);
});

test('provider 名大小写不敏感', () => {
  assert.equal(parseQuery('APP chrome', providers).providerHint, 'app');
});

test('命中别名时回传命中的原词，大小写归一', () => {
  assert.equal(parseQuery('a chrome', providers).alias, 'a');
  assert.equal(parseQuery('程序 chrome', providers).alias, '程序');
  assert.equal(parseQuery('A chrome', providers).alias, 'a');
});

test('未锁定 provider 时 alias 为 null', () => {
  assert.equal(parseQuery('chrome', providers).alias, null);
  assert.equal(parseQuery('zzz chrome', providers).alias, null);
  assert.equal(parseQuery('', providers).alias, null);
  assert.equal(parseQuery('= 1+1', providers).alias, null);
});

test('单字母别名只在独立首词时生效，粘在一起不算', () => {
  // 搜以 a 开头的普通词，不该被当成「限定 app」
  for (const input of ['abc', 'b站', 'a软件', 'f文件']) {
    const q = parseQuery(input, providers);
    assert.equal(q.providerHint, null, `${input} 被误判成限定查询`);
    assert.deepEqual(q.terms, [input]);
  }
});

test('单独输入别名本身不锁定（保持普通查询）', () => {
  for (const input of ['a', 'f', 'App']) {
    const q = parseQuery(input, providers);
    assert.equal(q.providerHint, null, `${input} 被当成空查询`);
    assert.equal(q.keyword, input);
  }
});

test('别名 + 空格但没有查询词时，剥出空词元', () => {
  const q = parseQuery('a   ', providers);
  assert.equal(q.providerHint, null, '没有查询词就不锁定');
  assert.deepEqual(q.terms, ['a']);
});

test('只有一个词且是 provider 名时，也锁定但查询为空', () => {
  const q = parseQuery('file', providers);
  assert.equal(q.providerHint, null, '单词查询不该被当成限定了 provider 的空查询');
  assert.deepEqual(q.terms, ['file']);
});

test('触发字符 > 走 shell 并剥掉前缀', () => {
  const q = parseQuery('> ipconfig', providers);
  assert.equal(q.providerHint, 'shell');
  assert.deepEqual(q.terms, ['ipconfig']);
});

test('触发字符可以紧跟内容，不留空格', () => {
  const q = parseQuery('>ipconfig', providers);
  assert.equal(q.providerHint, 'shell');
  assert.deepEqual(q.terms, ['ipconfig']);
});

test('触发字符 = 走计算器', () => {
  const q = parseQuery('= 1+1', providers);
  assert.equal(q.providerHint, 'calc');
  assert.deepEqual(q.terms, ['1+1']);
});

test('引号保住带空格的短语', () => {
  assert.deepEqual(tokenize('"visual studio" code'), ['visual studio', 'code']);
  assert.deepEqual(tokenize("'a b'"), ['a b']);
});

test('未闭合的引号不至于丢内容', () => {
  assert.deepEqual(tokenize('"half open'), ['half open']);
});

test('连续空格不产生空词元', () => {
  assert.deepEqual(tokenize('a   b'), ['a', 'b']);
});

test('未知首词不影响普通查询', () => {
  const q = parseQuery('zzz chrome', providers);
  assert.equal(q.providerHint, null);
  assert.deepEqual(q.terms, ['zzz', 'chrome']);
});

test('findProvider 对非法输入返回 null', () => {
  assert.equal(findProvider('', providers), null);
  assert.equal(findProvider('x', []), null);
  assert.equal(findProvider('x', [{}, null, { id: 'y' }]), null);
});

test('原始输入被完整保留', () => {
  const q = parseQuery('  app chrome  ', providers);
  assert.equal(q.raw, '  app chrome  ');
});
