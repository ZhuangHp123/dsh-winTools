'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pinyinInitials, initialOfChar } = require('../src/core/pinyin');

test('常见姓名的拼音首字母', () => {
  assert.equal(pinyinInitials('张三丰'), 'zsf');
  assert.equal(pinyinInitials('庄浩鹏'), 'zhp');
  assert.equal(pinyinInitials('欧阳锋'), 'oyf');
  assert.equal(pinyinInitials('王小明'), 'wxm');
  assert.equal(pinyinInitials('重庆'), 'zq');
});

test('多音字按 GB2312 排序取最常见读音：单/曾 都归 z', () => {
  // GB2312 表按常用读音排序，单田芳(dtf)、曾小贤(zxx) 与字典口径一致。
  assert.equal(pinyinInitials('单田芳'), 'dtf');
  assert.equal(pinyinInitials('曾小贤'), 'zxx');
});

test('非汉字被跳过，纯西文返回空串', () => {
  assert.equal(pinyinInitials('张 三'), 'zs');
  assert.equal(pinyinInitials('Alice Brown'), '');
  assert.equal(pinyinInitials(''), '');
  assert.equal(pinyinInitials(null), '');
});

test('生僻字（超出 GB2312 一级汉字）返回空串而不报错', () => {
  assert.equal(initialOfChar('龘'), '');
  assert.equal(pinyinInitials('龘'), '');
});
