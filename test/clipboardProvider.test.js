'use strict';

/**
 * 剪贴板 provider 单测。
 *
 * 用假的 clipboard 对象（readText 返回预设值），不碰真实系统剪贴板：
 * 测试不该改动用户正在用的剪贴板内容。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createClipboardProvider,
  createClipboardStore,
  createClipboardWatcher,
  makePreview,
  fingerprint,
  isWorthKeeping,
  describeTime,
  DEFAULT_LIMIT,
  DEFAULT_MAX_TEXT_LENGTH,
} = require('../src/clipboard/clipboardProvider');

/** 可编程的假时钟。 */
function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

/** 可编程的假剪贴板。 */
function fakeClipboard(initial = '') {
  let content = initial;
  return {
    readText: () => content,
    set: (text) => {
      content = text;
    },
  };
}

test('makePreview 把多行压成单行并截断', () => {
  assert.equal(makePreview('line1\nline2\t\tline3'), 'line1 line2 line3');
  assert.equal(makePreview('  padded  '), 'padded');
  const long = 'x'.repeat(500);
  const preview = makePreview(long, 20);
  assert.equal(preview.length, 20);
  assert.ok(preview.endsWith('…'));
});

test('fingerprint 对不同内容不同、对相同内容稳定', () => {
  assert.equal(fingerprint('abc'), fingerprint('abc'));
  assert.notEqual(fingerprint('abc'), fingerprint('abd'));
  // 长度不同必须不同（防碰撞）
  assert.notEqual(fingerprint('a'), fingerprint('aa'));
});

test('isWorthKeeping 拒绝空白和超长内容', () => {
  assert.equal(isWorthKeeping('hello'), true);
  assert.equal(isWorthKeeping(''), false);
  assert.equal(isWorthKeeping('   \n\t '), false);
  assert.equal(isWorthKeeping(null), false);
  assert.equal(isWorthKeeping(123), false);
  assert.equal(isWorthKeeping('x'.repeat(100), 50), false);
});

test('store.record 把新内容放在最前', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ clock });
  store.record('first');
  clock.advance(1000);
  store.record('second');
  const items = store.list();
  assert.equal(items.length, 2);
  assert.equal(items[0].text, 'second');
  assert.equal(items[1].text, 'first');
});

test('连续复制同一内容不产生重复条目，也不更新时间戳', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ clock });
  store.record('same');
  const firstTime = store.list()[0].copiedAt;
  clock.advance(5000);
  const result = store.record('same');
  assert.equal(result.added, false);
  assert.equal(result.reason, 'consecutive-duplicate');
  assert.equal(store.size(), 1);
  assert.equal(store.list()[0].copiedAt, firstTime, '连续重复不应更新时间戳');
});

test('非连续重复把旧条目提到最前并更新时间戳', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ clock });
  store.record('A');
  clock.advance(1000);
  store.record('B');
  clock.advance(1000);
  const before = store.list()[0].copiedAt;

  clock.advance(1000);
  const result = store.record('A');
  assert.equal(result.added, false);
  assert.equal(result.moved, true);
  const items = store.list();
  assert.equal(items.length, 2, '不应该新增条目');
  assert.equal(items[0].text, 'A', 'A 应该被提到最前');
  assert.ok(items[0].copiedAt > before, '时间戳应更新');
});

test('超过容量时从最旧的一端淘汰', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ limit: 3, clock });
  for (const text of ['a', 'b', 'c', 'd']) {
    store.record(text);
    clock.advance(100);
  }
  const texts = store.list().map((item) => item.text);
  assert.deepEqual(texts, ['d', 'c', 'b'], '最旧的 a 应被淘汰');
});

test('置顶项不会被容量淘汰挤掉', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ limit: 3, clock });
  store.record('a');
  const pinnedId = store.list()[0].id;
  store.setPinned(pinnedId, true);
  for (const text of ['b', 'c', 'd', 'e']) {
    store.record(text);
    clock.advance(100);
  }
  assert.ok(store.list().some((item) => item.text === 'a'), '置顶的 a 必须还在');
  assert.equal(store.size(), 3);
});

test('list 支持多词过滤，要求全部命中', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ clock });
  store.record('annual report 2026');
  clock.advance(10);
  store.record('annual summary');
  clock.advance(10);
  store.record('other text');
  assert.equal(store.list(['annual']).length, 2);
  assert.equal(store.list(['annual', 'report']).length, 1);
  // list 没有 limit 参数，limit 由 provider.search 负责截断。
  assert.equal(store.list(['annual']).length, 2);
});

test('clear 默认保留置顶项，全清时一个不留', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ clock });
  store.record('a');
  store.setPinned(store.list()[0].id, true);
  clock.advance(10);
  store.record('b');

  assert.equal(store.clear(), 1, '默认只清掉非置顶的 b');
  assert.equal(store.size(), 1);
  assert.equal(store.list()[0].text, 'a');

  assert.equal(store.clear({ keepPinned: false }), 1);
  assert.equal(store.size(), 0);
});

test('remove 删除指定条目', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ clock });
  store.record('a');
  const id = store.list()[0].id;
  assert.equal(store.remove(id), true);
  assert.equal(store.size(), 0);
  assert.equal(store.remove('nonexistent'), false);
});

test('toJSON/loadFromJSON 往返一致', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ clock });
  store.record('hello');
  clock.advance(10);
  store.record('world');

  const dumped = JSON.parse(JSON.stringify(store.toJSON()));
  const restored = createClipboardStore({ clock });
  assert.equal(restored.loadFromJSON(dumped), true);
  assert.equal(restored.size(), 2);
  assert.equal(restored.list()[0].text, 'world');
});

test('loadFromJSON 恢复后不会把上次的末条当重复而漏记', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ clock });
  store.record('last before restart');

  const dumped = JSON.parse(JSON.stringify(store.toJSON()));
  const restored = createClipboardStore({ clock });
  restored.loadFromJSON(dumped);
  // 恢复后 lastFingerprint 就是缓存里的第一条，再次遇到同样内容算连续重复，
  // 这符合"重启后剪贴板没变就不该重复记"的直觉。
  const result = restored.record('last before restart');
  assert.equal(result.added, false);
  assert.equal(restored.size(), 1);
});

test('loadFromJSON 拒绝损坏的缓存', () => {
  const store = createClipboardStore();
  assert.equal(store.loadFromJSON(null), false);
  assert.equal(store.loadFromJSON({ version: 999, items: [] }), false);
  assert.equal(store.loadFromJSON({ version: 1, items: 'nope' }), false);
  assert.equal(store.loadFromJSON({ version: 1, items: [{}] }), false);
  assert.equal(store.size(), 0);
});

test('watcher 轮询到新内容时回调', () => {
  const clock = fakeClock();
  const store = createClipboardStore({ clock });
  const clipboard = fakeClipboard('initial');
  const changes = [];
  const watcher = createClipboardWatcher({
    clipboard,
    store,
    onChange: (result) => changes.push(result),
  });

  watcher.pollOnce();
  assert.equal(store.size(), 1);
  assert.equal(changes.length, 1);

  clipboard.set('second');
  clock.advance(1000);
  watcher.pollOnce();
  assert.equal(store.size(), 2);

  // 同一内容再轮询：不应产生变化
  watcher.pollOnce();
  assert.equal(changes.length, 2);
});

test('watcher 在剪贴板为空白时不记录', () => {
  const store = createClipboardStore();
  const clipboard = fakeClipboard('   ');
  const watcher = createClipboardWatcher({ clipboard, store });
  watcher.pollOnce();
  assert.equal(store.size(), 0);
});

test('watcher 在 readText 抛异常时安全跳过', () => {
  const store = createClipboardStore();
  const clipboard = {
    readText: () => {
      throw new Error('剪贴板被独占');
    },
  };
  const watcher = createClipboardWatcher({ clipboard, store });
  assert.doesNotThrow(() => watcher.pollOnce());
  assert.equal(store.size(), 0);
});

test('watcher 支持异步 readText（Electron 45+ 返回 Promise）', async () => {
  const store = createClipboardStore();
  let content = 'async-content';
  const clipboard = { readText: async () => content };
  const changes = [];
  const watcher = createClipboardWatcher({
    clipboard,
    store,
    onChange: (result) => changes.push(result),
  });

  const result = watcher.pollOnce();
  assert.equal(typeof result?.then, 'function', '异步剪贴板应返回 Promise');
  await result;
  assert.equal(store.size(), 1);
  assert.equal(store.list()[0].text, 'async-content');
  assert.equal(changes.length, 1);

  // 上一轮未返回时再次轮询要被跳过，避免并发读乱序。
  let resolveSlow;
  const slow = new Promise((resolve) => {
    resolveSlow = resolve;
  });
  clipboard.readText = () => slow;
  const pending = watcher.pollOnce();
  const skipped = watcher.pollOnce();
  assert.equal(skipped, null, '上一轮未完成时应跳过本轮');
  resolveSlow('later');
  await pending;
  assert.equal(store.list()[0].text, 'later');
});

test('watcher 异步 readText 拒绝时不炸，也不记录', async () => {
  const store = createClipboardStore();
  const clipboard = { readText: async () => { throw new Error('busy'); } };
  const watcher = createClipboardWatcher({ clipboard, store });
  await watcher.pollOnce();
  assert.equal(store.size(), 0);
});

test('watcher start/stop 幂等', () => {
  const store = createClipboardStore();
  const clipboard = fakeClipboard('');
  const watcher = createClipboardWatcher({ clipboard, store });
  assert.equal(watcher.isRunning(), false);
  watcher.start();
  assert.equal(watcher.isRunning(), true);
  watcher.start(); // 重复 start 不叠加定时器
  watcher.stop();
  assert.equal(watcher.isRunning(), false);
  watcher.stop(); // 重复 stop 不报错
});

test('provider 空查询返回历史，有查询词则过滤', async () => {
  const clock = fakeClock();
  const provider = createClipboardProvider({ clock, limit: 10 });
  await provider.init();
  provider.store.record('alpha beta');
  clock.advance(10);
  provider.store.record('gamma delta');

  const all = provider.search([]);
  assert.equal(all.length, 2);
  assert.equal(all[0].kind, 'clipboard');

  const filtered = provider.search(['alpha']);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].text, 'alpha beta');
});

test('provider 的候选把全文放进 tags 供 fuzzy 匹配', async () => {
  const provider = createClipboardProvider({ limit: 10 });
  await provider.init();
  provider.store.record('a very long text about kubernetes deployment');
  const items = provider.search([]);
  assert.ok(items[0].tags.some((tag) => tag.includes('kubernetes')), '长文本应可被搜索');
});

test('provider.activate 写回剪贴板并提到最前', async () => {
  const clock = fakeClock();
  const written = [];
  const provider = createClipboardProvider({
    clock,
    limit: 10,
    writeClipboard: async (text) => written.push(text),
  });
  await provider.init();
  provider.store.record('first');
  clock.advance(100);
  provider.store.record('second');

  const target = provider.search([]).find((item) => item.text === 'first');
  await provider.activate(target);
  assert.deepEqual(written, ['first']);
  assert.equal(provider.search([])[0].text, 'first', '激活后应提到最前');
});

test('provider.activate 缺少内容时抛 invalid_item', async () => {
  const provider = createClipboardProvider();
  await provider.init();
  await assert.rejects(() => provider.activate({}), (error) => error.code === 'invalid_item');
});

test('provider 没有 clipboard 模块时不启动轮询', async () => {
  const provider = createClipboardProvider();
  const info = await provider.init();
  assert.equal(info.watching, false);
  assert.equal(provider.stats().watching, false);
});

test('provider 有 clipboard 模块时启动轮询并在 dispose 停止', async () => {
  let reads = 0;
  const clipboard = {
    readText: () => {
      reads += 1;
      return '';
    },
  };
  const provider = createClipboardProvider({ clipboard, interval: 10_000 });
  const info = await provider.init();
  assert.equal(info.watching, true);
  assert.ok(reads >= 1, 'start 时应先读一次');
  await provider.dispose();
  assert.equal(provider.stats().watching, false);
});

test('provider dispose 时保存缓存，空历史则不存', async () => {
  const written = [];
  const provider = createClipboardProvider({
    cache: { save: async (data) => written.push(data) },
  });
  await provider.init();
  await provider.dispose();
  assert.equal(written.length, 0, '空历史不写缓存');

  provider.store.record('something');
  await provider.dispose();
  assert.equal(written.length, 1);
});

test('describeTime 给出中文相对时间', () => {
  const now = 1_700_000_000_000;
  assert.equal(describeTime(now - 30_000, now), '刚刚');
  assert.equal(describeTime(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(describeTime(now - 3 * 3600_000, now), '3 小时前');
  assert.equal(describeTime(now - 2 * 86400_000, now), '2 天前');
  assert.equal(describeTime(0, now), '');
});

test('默认常量合理', () => {
  assert.ok(DEFAULT_LIMIT >= 50);
  assert.ok(DEFAULT_MAX_TEXT_LENGTH >= 1000);
});
