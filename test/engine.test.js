'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEngine,
  normalizeItems,
  withTimeout,
  TimeoutError,
} = require('../src/core/engine');

const NOW = 1_700_000_000_000;

function fakeProvider(id, items, overrides = {}) {
  return {
    id,
    search: async () => items,
    ...overrides,
  };
}

test('注册 provider 后能查到', () => {
  const engine = createEngine();
  const p = fakeProvider('app', []);
  engine.register(p);
  assert.equal(engine.get('app'), p);
  assert.equal(engine.list().length, 1);
});

test('注册非法 provider 直接抛错（早失败好过运行时静默）', () => {
  const engine = createEngine();
  assert.throws(() => engine.register(null), TypeError);
  assert.throws(() => engine.register({}), TypeError);
  assert.throws(() => engine.register({ id: 'x' }), TypeError, '没有 search 应报错');
});

test('重复 id 注册被拒绝', () => {
  const engine = createEngine();
  engine.register(fakeProvider('app', []));
  assert.throws(() => engine.register(fakeProvider('app', [])), /重复注册/);
});

test('多个 provider 的结果被汇总排序', async () => {
  const engine = createEngine({ limit: 10 });
  engine.register(fakeProvider('app', [{ title: 'chrome' }]));
  engine.register(fakeProvider('file', [{ title: 'chrome.txt' }]));

  const result = await engine.search('chrome');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].title, 'chrome', '应用权重更高应排前');
  assert.equal(result.errors.length, 0);
});

test('结果自动带上 provider 和 id', async () => {
  const engine = createEngine();
  engine.register(fakeProvider('app', [{ title: 'chrome' }]));
  const { items } = await engine.search('chrome');
  assert.equal(items[0].provider, 'app');
  assert.equal(items[0].id, 'app:chrome');
});

test('不匹配的候选被过滤掉', async () => {
  const engine = createEngine();
  engine.register(fakeProvider('app', [{ title: 'chrome' }, { title: 'firefox' }]));
  const { items } = await engine.search('chrome');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'chrome');
});

test('锁定的 provider 只查询它自己', async () => {
  let appCalled = false;
  let fileCalled = false;
  const engine = createEngine();
  engine.register(
    fakeProvider('app', [{ title: 'chrome' }], {
      aliases: ['a'],
      search: async () => {
        appCalled = true;
        return [{ title: 'chrome' }];
      },
    }),
  );
  engine.register(
    fakeProvider('file', [{ title: 'chrome.txt' }], {
      search: async () => {
        fileCalled = true;
        return [{ title: 'chrome.txt' }];
      },
    }),
  );

  const { items } = await engine.search('app chrome');
  assert.equal(appCalled, true);
  assert.equal(fileCalled, false, '限定 provider 时不该惊动其它 provider');
  assert.equal(items.length, 1);
  assert.equal(items[0].provider, 'app');
});

test('provider 抛错不会拖垮整轮查询', async () => {
  const engine = createEngine();
  engine.register(fakeProvider('app', [{ title: 'chrome' }]));
  engine.register({
    id: 'file',
    search: async () => {
      throw new Error('索引坏了');
    },
  });

  const result = await engine.search('chrome');
  assert.equal(result.items.length, 1, '好 provider 的结果应保留');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].provider, 'file');
  assert.match(result.errors[0].message, /索引坏了/);
});

test('慢 provider 超时被丢弃，快 provider 正常返回', async () => {
  const engine = createEngine({ providerTimeout: 50 });
  engine.register(fakeProvider('app', [{ title: 'chrome' }]));
  engine.register({
    id: 'file',
    search: () => new Promise(() => {}), // 永不 resolve
  });

  const started = Date.now();
  const result = await engine.search('chrome');
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, `不该被慢 provider 拖住，实际 ${elapsed}ms`);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].provider, 'app');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'timeout');
  assert.match(result.errors[0].message, /timeout/);
});

test('后发起的查询让前一轮作废（stale）', async () => {
  const engine = createEngine({ providerTimeout: 2000 });
  let resolveSlow;
  engine.register({
    id: 'app',
    search: (terms) => {
      if (terms[0] === 'slow') {
        return new Promise((resolve) => {
          resolveSlow = () => resolve([{ title: 'slow-result' }]);
        });
      }
      return [{ title: 'fast-result' }];
    },
  });

  const slowPromise = engine.search('slow');
  const fastResult = await engine.search('fast');

  assert.equal(fastResult.stale, false);
  assert.equal(fastResult.items[0].title, 'fast-result');

  // 现在让慢查询返回，它必须被标记 stale 且不带结果。
  resolveSlow();
  const slowResult = await slowPromise;
  assert.equal(slowResult.stale, true, '慢查询回来时已经过时了');
  assert.deepEqual(slowResult.items, [], '过时结果不该覆盖新结果');
});

test('空查询也走 provider（用于展示常用项）', async () => {
  let receivedEmpty = null;
  const engine = createEngine();
  engine.register({
    id: 'app',
    search: async (terms, ctx) => {
      receivedEmpty = ctx.empty;
      return [{ title: 'recent-app' }];
    },
  });

  const { items } = await engine.search('');
  assert.equal(receivedEmpty, true, 'provider 应知道这是空查询');
  assert.equal(items.length, 1, '空查询不该把候选过滤光');
});

test('activate 调用对应 provider 并记录使用', async () => {
  const recorded = [];
  const usageStore = { record: (key, at) => recorded.push([key, at]), get: () => null };
  const engine = createEngine({ usageStore, clock: { now: () => NOW } });

  let activated = null;
  engine.register({
    id: 'app',
    search: async () => [{ title: 'chrome' }],
    activate: async (item) => {
      activated = item;
      return { ok: true };
    },
  });

  const { items } = await engine.search('chrome');
  const result = await engine.activate(items[0]);

  assert.equal(result.ok, true);
  assert.equal(activated.title, 'chrome');
  assert.deepEqual(recorded, [['app:chrome', NOW]], '执行成功后应记一次使用');
});

test('activate 失败时不记录使用', async () => {
  const recorded = [];
  const usageStore = { record: (key) => recorded.push(key), get: () => null };
  const engine = createEngine({ usageStore });

  engine.register({
    id: 'app',
    search: async () => [{ title: 'chrome' }],
    activate: async () => ({ ok: false, message: '启动不了' }),
  });

  const { items } = await engine.search('chrome');
  const result = await engine.activate(items[0]);
  assert.equal(result.ok, false);
  assert.equal(result.message, '启动不了');
  assert.deepEqual(recorded, []);
});

test('activate 抛错被转换成失败结果', async () => {
  const engine = createEngine();
  engine.register({
    id: 'app',
    search: async () => [{ title: 'x' }],
    activate: async () => {
      throw new Error('炸了');
    },
  });
  const { items } = await engine.search('x');
  const result = await engine.activate(items[0]);
  assert.equal(result.ok, false);
  assert.match(result.message, /炸了/);
});

test('activate 未知 provider 或空项时给出清晰错误', async () => {
  const engine = createEngine();
  assert.equal((await engine.activate(null)).ok, false);
  assert.equal((await engine.activate({ provider: 'nope' })).ok, false);
});

test('没有 activate 的 provider 被调用时说明原因', async () => {
  const engine = createEngine();
  engine.register(fakeProvider('app', [{ title: 'x' }]));
  const { items } = await engine.search('x');
  const result = await engine.activate(items[0]);
  assert.equal(result.ok, false);
  assert.match(result.message, /不支持执行/);
});

test('initAll 收集初始化失败但不抛，坏 provider 不阻断启动', async () => {
  const engine = createEngine();
  engine.register({
    id: 'good',
    search: async () => [],
    init: async () => {},
  });
  engine.register({
    id: 'bad',
    search: async () => [],
    init: async () => {
      throw new Error('索引建不起来');
    },
  });

  const errors = await engine.initAll();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].provider, 'bad');
});

test('parse 暴露给 UI，提前知道锁定状态', () => {
  const engine = createEngine();
  engine.register(fakeProvider('app', [], { aliases: ['a'] }));
  assert.equal(engine.parse('a chrome').providerHint, 'app');
  assert.equal(engine.parse('chrome').providerHint, null);
});

test('normalizeItems 容错各种返回形态', () => {
  assert.deepEqual(normalizeItems(null, 'p'), []);
  assert.equal(normalizeItems({ title: 'single' }, 'p').length, 1, '单条对象应被包成数组');
  assert.equal(normalizeItems({ items: [{ title: 'x' }] }, 'p').length, 1);
  assert.equal(normalizeItems([{ title: 'a' }, { name: 'b' }, null, {}], 'p').length, 2);
  assert.equal(normalizeItems([{ title: 'a' }], 'p')[0].provider, 'p');
});

test('withTimeout 在超时时抛 TimeoutError，而不是伪装成普通结果', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 30),
    (error) => error.code === 'timeout' && error instanceof TimeoutError,
  );
});

test('withTimeout 保留 promise 自身的错误，不伪装成超时', async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error('索引坏了')), 1000),
    /索引坏了/,
  );
});

test('withTimeout 不改变正常结果', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 1000);
  assert.equal(result, 'ok');
});
