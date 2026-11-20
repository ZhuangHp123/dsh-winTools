'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_HOTKEYS, resolveHotkey, hotkeyCandidates } = require('../src/main/hotkey');

test('第一个候选可用时直接用', () => {
  const picked = resolveHotkey(['Alt+Space', 'Alt+X'], () => true);
  assert.equal(picked, 'Alt+Space');
});

test('第一个被占用时退到下一个', () => {
  const picked = resolveHotkey(['Alt+Space', 'Alt+X', 'Alt+Z'], (acc) => acc !== 'Alt+Space');
  assert.equal(picked, 'Alt+X');
});

test('全部被占用返回 null', () => {
  assert.equal(resolveHotkey(['Alt+Space'], () => false), null);
});

test('register 抛异常时继续试下一个，不中断启动', () => {
  const picked = resolveHotkey(['bad++', 'Alt+X'], (acc) => {
    if (acc === 'bad++') throw new Error('invalid accelerator');
    return true;
  });
  assert.equal(picked, 'Alt+X');
});

test('配置热键排在最前，且不重复默认值', () => {
  const list = hotkeyCandidates({ hotkey: 'Ctrl+Alt+K' });
  assert.equal(list[0], 'Ctrl+Alt+K');
  assert.equal(new Set(list).size, list.length, '不应有重复项');
});

test('没有配置时用环境变量 DSH_HOTKEY', () => {
  const list = hotkeyCandidates(null, { DSH_HOTKEY: 'Alt+G' });
  assert.equal(list[0], 'Alt+G');
});

test('什么都没有时落在默认链的第一项', () => {
  const list = hotkeyCandidates(null, {});
  assert.equal(list[0], DEFAULT_HOTKEYS[0]);
});

test('空字符串配置被忽略', () => {
  const list = hotkeyCandidates({ hotkey: '   ' }, { DSH_HOTKEY: '' });
  assert.equal(list[0], DEFAULT_HOTKEYS[0]);
});
