'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  usageScore,
  scoreCandidate,
  rankCandidates,
  candidateKey,
  USAGE_LIMIT,
  DEFAULT_LIMIT,
} = require('../src/core/rank');

const NOW = 1_700_000_000_000;

function makeUsageStore(map = {}) {
  return {
    get: (key) => map[key] ?? null,
  };
}

test('没使用记录时使用分为 0', () => {
  assert.equal(usageScore(null, NOW), 0);
  assert.equal(usageScore({ count: 0, lastUsed: NOW }, NOW), 0);
});

test('用得越多分越高，但不超过上限', () => {
  const few = usageScore({ count: 2, lastUsed: NOW }, NOW);
  const many = usageScore({ count: 30, lastUsed: NOW }, NOW);
  const absurd = usageScore({ count: 100000, lastUsed: NOW }, NOW);
  assert.ok(few < many);
  assert.ok(many <= USAGE_LIMIT);
  assert.ok(absurd <= USAGE_LIMIT, '使用分必须有上限，否则历史会压掉一切');
});

test('同样次数下，最近用过的更高', () => {
  const fresh = usageScore({ count: 5, lastUsed: NOW }, NOW);
  const weekAgo = usageScore({ count: 5, lastUsed: NOW - 7 * 86400000 }, NOW);
  const longAgo = usageScore({ count: 5, lastUsed: NOW - 90 * 86400000 }, NOW);
  assert.ok(fresh > weekAgo);
  assert.ok(weekAgo > longAgo);
});

test('主字段命中才有分，只在次要字段命中的候选被淘汰', () => {
  const candidate = {
    title: 'report.docx',
    subtitle: '2024 年度报告',
    provider: 'file',
  };
  assert.ok(scoreCandidate(['report'], candidate, { now: NOW }) > 0);
  assert.equal(scoreCandidate(['2024'], candidate, { now: NOW }), null);
});

test('provider 权重把应用抬到文件之前', () => {
  const app = { title: 'code', provider: 'app', id: 'app:code' };
  const file = { title: 'code', provider: 'file', id: 'file:code' };
  const ranked = rankCandidates(['code'], [file, app], { now: NOW });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].provider, 'app', '同分时应用应排在文件前');
});

test('使用习惯可以改变同层近似结果之间的顺序', () => {
  // 同层：都以 chrome 开头，只是后缀不同——这种"差不多"才该由习惯决定。
  const a = { title: 'chrome-alpha', provider: 'app', id: 'app:chrome-alpha' };
  const b = { title: 'chrome-beta', provider: 'app', id: 'app:chrome-beta' };
  const store = makeUsageStore({ 'app:chrome-beta': { count: 20, lastUsed: NOW } });
  const ranked = rankCandidates(['chrome'], [a, b], { now: NOW, usageStore: store });
  assert.equal(ranked[0].id, 'app:chrome-beta', '常点的同层结果应顶上来');
});

test('但使用习惯翻不了质：完全匹配仍压过常点的部分匹配', () => {
  const exact = { title: 'code', provider: 'app', id: 'app:code' };
  const partial = { title: 'code-insiders', provider: 'app', id: 'app:code-insiders' };
  const store = makeUsageStore({ 'app:code-insiders': { count: 100, lastUsed: NOW } });
  const ranked = rankCandidates(['code'], [partial, exact], { now: NOW, usageStore: store });
  assert.equal(ranked[0].id, 'app:code', '精确命中的优先级必须稳');
});

test('同 key 的候选去重，保留分最高的', () => {
  const low = { title: 'chrome', provider: 'app', id: 'dup', subtitle: '' };
  const high = { title: 'chrome', provider: 'app', id: 'dup', subtitle: 'chrome' };
  const ranked = rankCandidates(['chrome'], [low, high], { now: NOW });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].subtitle, 'chrome');
});

test('结果被截断到 limit', () => {
  const candidates = Array.from({ length: 30 }, (_, i) => ({
    title: `item${i}`,
    provider: 'file',
    id: `f:${i}`,
  }));
  const ranked = rankCandidates(['item'], candidates, { now: NOW });
  assert.equal(ranked.length, DEFAULT_LIMIT);
});

test('自定义 limit 生效', () => {
  const candidates = Array.from({ length: 30 }, (_, i) => ({
    title: `item${i}`,
    provider: 'file',
    id: `f:${i}`,
  }));
  assert.equal(rankCandidates(['item'], candidates, { now: NOW, limit: 3 }).length, 3);
});

test('空查询按使用习惯排序，用于展示常用项', () => {
  const a = { title: 'a', provider: 'app', id: 'app:a' };
  const b = { title: 'b', provider: 'app', id: 'app:b' };
  const store = makeUsageStore({ 'app:b': { count: 10, lastUsed: NOW } });
  const ranked = rankCandidates([], [a, b], { now: NOW, usageStore: store });
  assert.equal(ranked[0].id, 'app:b');
});

test('空候选池返回空数组，不炸', () => {
  assert.deepEqual(rankCandidates(['a'], [], { now: NOW }), []);
  assert.deepEqual(rankCandidates(['a'], null, { now: NOW }), []);
});

test('candidateKey 优先用 id，否则由 provider+title 派生', () => {
  assert.equal(candidateKey({ id: 'x', provider: 'app', title: 't' }), 'x');
  assert.equal(candidateKey({ provider: 'app', title: 't' }), 'app:t');
  assert.equal(candidateKey({ title: 't' }), 'unknown:t');
});

test('每个结果都带上 score 字段供 UI 调试', () => {
  const ranked = rankCandidates(['code'], [{ title: 'code', provider: 'app', id: 'a' }], {
    now: NOW,
  });
  assert.equal(typeof ranked[0].score, 'number');
  assert.ok(ranked[0].score > 0);
});

test('serverMatched 的条目在本地匹配不上时也保留，但排在本地命中之后', () => {
  const ranked = rankCandidates(
    ['hp'],
    [
      { id: 'dingtalk:user:u9', provider: 'dingtalk', title: '庄浩鹏', serverMatched: true },
      { id: 'file:hp', provider: 'file', title: 'hp-notes.md' },
    ],
    { now: NOW },
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, 'file:hp');
  assert.equal(ranked[1].id, 'dingtalk:user:u9');
});

test('没有 serverMatched 标记的候选仍然要本地命中才保留', () => {
  const ranked = rankCandidates(['hp'], [{ id: 'x', provider: 'dingtalk', title: '庄浩鹏' }], { now: NOW });
  assert.deepEqual(ranked, []);
});
