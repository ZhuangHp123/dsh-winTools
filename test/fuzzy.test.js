'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TIER,
  isBoundary,
  subsequencePositions,
  scoreTerm,
  scoreTerms,
  scoreFields,
} = require('../src/core/fuzzy');

test('isBoundary 认得分隔符、驼峰和数字转折', () => {
  assert.equal(isBoundary('hello', 0), true, '开头是边界');
  assert.equal(isBoundary('hello world', 6), true, '空格之后是边界');
  assert.equal(isBoundary('a-b', 2), true, '连字符之后是边界');
  assert.equal(isBoundary('foo/bar', 4), true, '斜杠之后是边界');
  assert.equal(isBoundary('camelCase', 5), true, 'camelCase 转折是边界');
  assert.equal(isBoundary('hello', 2), false, '词中间不是边界');
  assert.equal(isBoundary('version2', 7), true, '数字转字母是边界');
});

test('subsequencePositions 按顺序匹配，匹配不上返回 null', () => {
  assert.deepEqual(subsequencePositions('abc', 'aXbXc'), [0, 2, 4]);
  assert.deepEqual(subsequencePositions('aa', 'aaa'), [0, 1]);
  assert.equal(subsequencePositions('abc', 'acb'), null, '顺序不对要失败');
  assert.equal(subsequencePositions('z', 'abc'), null);
});

test('完全匹配拿最高分层', () => {
  const hit = scoreTerm('chrome', 'chrome');
  assert.ok(hit);
  assert.equal(hit.score, TIER.EXACT);
});

test('前缀匹配优先于中间匹配', () => {
  const prefix = scoreTerm('chr', 'chrome');
  const middle = scoreTerm('chr', 'google-chrome');
  assert.ok(prefix && middle);
  assert.ok(prefix.score > middle.score, `前缀 ${prefix.score} 应高于中间 ${middle.score}`);
  assert.ok(prefix.score >= TIER.PREFIX);
  assert.ok(middle.score >= TIER.WORD_START, '分隔符后的命中应算词首');
});

test('词首匹配优于任意子串', () => {
  const wordStart = scoreTerm('view', 'code-view');
  const substring = scoreTerm('view', 'preview');
  assert.ok(wordStart && substring);
  assert.ok(wordStart.score > substring.score);
});

test('子序列匹配是兜底，分数低于子串', () => {
  const subseq = scoreTerm('gc', 'google chrome');
  const substr = scoreTerm('gle', 'google chrome');
  assert.ok(subseq && substr);
  assert.ok(subseq.score < substr.score, '子序列应低于子串');
  assert.ok(subseq.score >= TIER.SUBSEQUENCE);
});

test('匹配不上返回 null', () => {
  assert.equal(scoreTerm('xyz', 'chrome'), null);
  assert.equal(scoreTerm('', 'chrome'), null);
  assert.equal(scoreTerm('a', ''), null);
});

test('分层之间的间隙足够大，短目标的加成翻不了层', () => {
  // 最差的前缀分 vs 最好的词首分：前缀必须仍然更高。
  const worstPrefix = scoreTerm('chr', 'chrome-and-a-very-long-name-here');
  const bestWordStart = scoreTerm('chr', 'x-chr');
  assert.ok(worstPrefix.score > bestWordStart.score, '前缀加成不能被位置加成翻盘');
});

test('短目标优于长目标（同等匹配类型）', () => {
  const short = scoreTerm('code', 'code');
  const long = scoreTerm('code', 'code-something-really-long');
  assert.ok(short.score > long.score);
});

test('多词元必须全部命中', () => {
  const both = scoreTerms(['google', 'chrome'], 'Google Chrome');
  assert.ok(both, '两个词都命中应当有结果');
  assert.equal(scoreTerms(['google', 'firefox'], 'Google Chrome'), null, '缺一个词应失败');
});

test('多词元按顺序出现有额外加分', () => {
  const ordered = scoreTerms(['a', 'b'], 'a-x-b');
  const reversed = scoreTerms(['b', 'a'], 'a-x-b');
  assert.ok(ordered && reversed);
  assert.ok(ordered.score > reversed.score, '顺序命中应更靠前');
});

test('scoreFields 主字段必须命中，次字段只加分', () => {
  const fields = [
    { text: 'report.docx', weight: 1 },
    { text: 'D:/docs/2024/report.docx', weight: 0.25 },
  ];
  assert.ok(scoreFields(['report'], fields), '主字段命中即可');
  assert.equal(
    scoreFields(['2024'], fields),
    null,
    '只在次字段命中也应失败——否则搜目录名会炸出全部文件',
  );
});

test('大小写不敏感匹配，但大小写完全对上时略有加分', () => {
  const typedExactly = scoreTerm('Chrome', 'Chrome');
  const typedCaseWrong = scoreTerm('chrome', 'Chrome');
  assert.ok(typedExactly && typedCaseWrong, '大小写不同也要能匹配上');
  assert.ok(typedExactly.score > typedCaseWrong.score, '大小写对上说明用户瞄得准，应略靠前');
});
