'use strict';

/**
 * 文件 provider 单测。
 *
 * 全部用注入的假 readdir，不碰真实磁盘：测试要能在任何机器上跑，
 * 而且不能因为某个人的 D 盘大小不同而变慢或变红。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createFileProvider,
  createFileIndex,
  createExcludeMatcher,
  scanRoots,
  makeEntry,
  entryToCandidate,
  joinPath,
  defaultRoots,
  DEFAULT_EXCLUDES,
  CACHE_VERSION,
} = require('../src/files/fileProvider');

/**
 * 造一棵磁盘树。
 * @param {Record<string, string[]>} tree 目录 → 子项名（以 / 结尾表示目录）
 */
function fakeReaddir(tree) {
  const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '');
  const map = new Map();
  for (const [dir, children] of Object.entries(tree)) {
    map.set(norm(dir), children.map((raw) => {
      // 真实的 Dirent.name 不带尾部分隔符，这里也去掉，
      // 否则 fake 比真实实现更宽松，会掩盖路径拼接的 bug。
      const isDir = raw.endsWith('/');
      const name = isDir ? raw.slice(0, -1) : raw;
      return {
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      };
    }));
  }
  return (dir) => {
    const key = norm(dir);
    if (!map.has(key)) {
      const error = new Error(`ENOENT: ${dir}`);
      error.code = 'ENOENT';
      throw error;
    }
    return map.get(key);
  };
}

test('joinPath 不会在根目录拼出双反斜杠', () => {
  assert.equal(joinPath('D:\\', 'file.txt'), 'D:\\file.txt');
  assert.equal(joinPath('D:\\sub', 'file.txt'), 'D:\\sub\\file.txt');
  assert.equal(joinPath('D:/', 'file.txt'), 'D:/file.txt');
});

test('makeEntry 预先算好小写路径与扩展名', () => {
  const entry = makeEntry('C:\\Users\\Me\\Report.PDF');
  assert.equal(entry.name, 'Report.PDF');
  assert.equal(entry.ext, '.pdf');
  assert.equal(entry.lower, 'c:\\users\\me\\report.pdf');
  assert.equal(entry.dir, 'C:\\Users\\Me');
});

test('scanRoots 只收指定扩展名', async () => {
  const readdirSync = fakeReaddir({
    'C:\\root': ['a.txt', 'b.exe', 'c.unknownext', 'sub/'],
    'C:\\root\\sub': ['d.md'],
  });
  const { entries } = await scanRoots({
    roots: ['C:\\root'],
    extensions: ['.txt', '.md', '.exe'],
    readdirSync,
  });
  assert.deepEqual(entries.map((e) => e.name).sort(), ['a.txt', 'b.exe', 'd.md']);
});

test('extensions 传空数组表示全都索引', async () => {
  const readdirSync = fakeReaddir({ 'C:\\root': ['a.txt', 'b.weird'] });
  const { entries } = await scanRoots({ roots: ['C:\\root'], extensions: [], readdirSync });
  assert.equal(entries.length, 2);
});

test('排除规则按完整目录名匹配，不做子串误伤', () => {
  const isExcluded = createExcludeMatcher(['node_modules', 'temp']);
  assert.ok(isExcluded('C:\\proj\\node_modules'));
  assert.ok(isExcluded('C:\\proj\\node_modules\\pkg'));
  assert.ok(isExcluded('C:\\temp'));
  // 不能误伤：名字里含 "temp" 但不是 temp 目录
  assert.ok(!isExcluded('C:\\proj\\templates'));
  assert.ok(!isExcluded('C:\\proj\\attempt'));
  assert.ok(!isExcluded('C:\\projects\\app'));
});

test('scanRoots 跳过被排除的目录子树', async () => {
  const readdirSync = fakeReaddir({
    'C:\\root': ['keep.txt', 'node_modules/'],
    'C:\\root\\node_modules': ['junk.txt'],
  });
  const { entries, stats } = await scanRoots({
    roots: ['C:\\root'],
    extensions: [],
    excludes: ['node_modules'],
    readdirSync,
  });
  assert.deepEqual(entries.map((e) => e.name), ['keep.txt']);
  assert.equal(stats.skippedDirs, 1);
});

test('scanRoots 遇到读不了的目录继续扫别的', async () => {
  const readdirSync = fakeReaddir({ 'C:\\good': ['a.txt'] });
  const { entries } = await scanRoots({
    roots: ['C:\\missing', 'C:\\good'],
    extensions: [],
    readdirSync,
  });
  assert.equal(entries.length, 1);
});

test('scanRoots 达到 maxEntries 就截断并标记', async () => {
  const readdirSync = fakeReaddir({
    'C:\\root': ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
  });
  const { entries, stats } = await scanRoots({
    roots: ['C:\\root'],
    extensions: [],
    maxEntries: 2,
    readdirSync,
  });
  assert.equal(entries.length, 2);
  assert.equal(stats.truncated, true);
});

test('scanRoots 通过 onBatch 增量交付，调用方可以边扫边用', async () => {
  const readdirSync = fakeReaddir({
    'C:\\root': Array.from({ length: 1200 }, (_, i) => `f${i}.txt`),
  });
  const batches = [];
  await scanRoots({
    roots: ['C:\\root'],
    extensions: [],
    readdirSync,
    onBatch: (batch) => batches.push(batch.length),
  });
  assert.ok(batches.length >= 2, '1200 个文件应分成多批交付');
  assert.equal(batches.reduce((a, b) => a + b, 0), 1200);
});

test('scanRoots 能被 AbortSignal 中断', async () => {
  const controller = new AbortController();
  const readdirSync = fakeReaddir({
    'C:\\root': ['a.txt', 'sub/'],
    'C:\\root\\sub': ['b.txt'],
  });
  controller.abort();
  const { entries } = await scanRoots({
    roots: ['C:\\root'],
    extensions: [],
    readdirSync,
    signal: controller.signal,
  });
  assert.equal(entries.length, 0, '已中断时不应产出任何条目');
});

test('索引 find 要求所有词都命中，且尊重 limit', () => {
  const index = createFileIndex();
  index.add([
    makeEntry('C:\\docs\\annual-report.pdf'),
    makeEntry('C:\\docs\\annual-summary.pdf'),
    makeEntry('C:\\docs\\other.txt'),
  ]);
  assert.equal(index.find(['annual']).length, 2);
  assert.equal(index.find(['annual', 'report']).length, 1);
  assert.equal(index.find(['annual'], 1).length, 1);
  assert.equal(index.find(['nonexistent']).length, 0);
});

test('索引 find 大小写不敏感', () => {
  const index = createFileIndex();
  index.add([makeEntry('C:\\Docs\\Annual.PDF')]);
  assert.equal(index.find(['ANNUAL']).length, 1);
  assert.equal(index.find(['annual']).length, 1);
});

test('索引 add 可增量、set 可整体替换', () => {
  const index = createFileIndex();
  index.add([makeEntry('C:\\a.txt')]);
  assert.equal(index.size(), 1);
  index.add([makeEntry('C:\\b.txt')]);
  assert.equal(index.size(), 2);
  index.set([makeEntry('C:\\c.txt')]);
  assert.equal(index.size(), 1);
  assert.ok(index.isBuilt());
});

test('索引 toJSON/loadFromJSON 往返一致', () => {
  const index = createFileIndex();
  index.add([makeEntry('C:\\a.txt'), makeEntry('C:\\b.pdf')]);
  const dumped = index.toJSON();
  assert.equal(dumped.version, CACHE_VERSION);

  const restored = createFileIndex();
  assert.equal(restored.loadFromJSON(JSON.parse(JSON.stringify(dumped))), true);
  assert.equal(restored.size(), 2);
  assert.equal(restored.find(['b.pdf']).length, 1);
});

test('loadFromJSON 拒绝版本不符的旧缓存', () => {
  const index = createFileIndex();
  assert.equal(index.loadFromJSON({ version: CACHE_VERSION + 1, entries: [makeEntry('C:\\a.txt')] }), false);
  assert.equal(index.size(), 0, '拒绝后不能污染现有索引');
});

test('loadFromJSON 拒绝结构损坏的缓存', () => {
  const index = createFileIndex();
  assert.equal(index.loadFromJSON(null), false);
  assert.equal(index.loadFromJSON({}), false);
  assert.equal(index.loadFromJSON({ version: CACHE_VERSION, entries: 'nope' }), false);
  assert.equal(index.loadFromJSON({ version: CACHE_VERSION, entries: [] }), false);
  // 条目字段缺失的会被过滤掉
  assert.equal(
    index.loadFromJSON({ version: CACHE_VERSION, entries: [{ path: 1 }, { path: 'C:\\x', lower: 'c:\\x' }] }),
    true,
  );
  assert.equal(index.size(), 1);
});

test('entryToCandidate 带上 id/kind/路径与扩展名标签', () => {
  const candidate = entryToCandidate(makeEntry('C:\\docs\\report.pdf'));
  assert.equal(candidate.kind, 'file');
  assert.equal(candidate.title, 'report.pdf');
  assert.equal(candidate.subtitle, 'C:\\docs');
  assert.equal(candidate.path, 'C:\\docs\\report.pdf');
  assert.deepEqual(candidate.tags, ['pdf']);
  assert.ok(candidate.id.startsWith('file:'));
});

test('文件 provider 空查询不返回文件（避免打开瞬间刷满屏幕）', async () => {
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    scan: async ({ onBatch }) => {
      onBatch([makeEntry('C:\\root\\a.txt')]);
      return { stats: {} };
    },
  });
  await provider.init();
  await provider.whenScanDone();
  assert.deepEqual(provider.search([]), []);
});

test('文件 provider 有查询词时返回匹配文件', async () => {
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    scan: async ({ onBatch }) => {
      onBatch([makeEntry('C:\\root\\annual-report.pdf'), makeEntry('C:\\root\\notes.txt')]);
      return { stats: {} };
    },
  });
  await provider.init();
  await provider.whenScanDone();
  const items = provider.search(['annual']);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'annual-report.pdf');
});

test('文件 provider 优先用缓存秒开，再后台刷新', async () => {
  const saved = { version: CACHE_VERSION, entries: [makeEntry('C:\\cached\\old.pdf')] };
  let loadCalled = false;
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    cache: {
      load: async () => {
        loadCalled = true;
        return saved;
      },
      save: async () => {},
    },
    scan: async () => ({ stats: {} }),
  });
  const result = await provider.init();
  assert.equal(loadCalled, true);
  assert.equal(result.cached, 1);
  // 缓存里的文件立即可搜
  assert.equal(provider.search(['old.pdf']).length, 1);
});

test('缓存加载失败不影响扫描', async () => {
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    cache: {
      load: async () => {
        throw new Error('缓存文件坏了');
      },
      save: async () => {},
    },
    scan: async ({ onBatch }) => {
      onBatch([makeEntry('C:\\root\\fresh.txt')]);
      return { stats: {} };
    },
  });
  await provider.init();
  await provider.whenScanDone();
  assert.equal(provider.search(['fresh']).length, 1);
  assert.ok(provider.stats().errors.some((e) => /缓存文件坏了/.test(e)));
});

test('扫描出错被记录但不抛出（不能因为扫盘失败就没法启动）', async () => {
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    scan: async () => {
      throw new Error('盘拔了');
    },
  });
  await provider.init();
  await provider.whenScanDone();
  assert.ok(provider.stats().errors.some((e) => /盘拔了/.test(e)));
});

test('indexing 状态反映后台扫描是否还在跑', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    scan: async () => {
      await gate;
      return { stats: {} };
    },
  });
  await provider.init();
  assert.equal(provider.isIndexing(), true);
  release();
  await provider.whenScanDone();
  assert.equal(provider.isIndexing(), false);
});

test('dispose 时把索引写入缓存', async () => {
  const written = [];
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    cache: { save: async (data) => written.push(data) },
    scan: async ({ onBatch }) => {
      onBatch([makeEntry('C:\\root\\x.txt')]);
      return { stats: {} };
    },
  });
  await provider.init();
  await provider.whenScanDone();
  await provider.dispose();
  assert.equal(written.length, 1);
  assert.equal(written[0].version, CACHE_VERSION);
  assert.equal(written[0].entries.length, 1);
});

test('索引为空时不写缓存（别用空索引覆盖掉好的）', async () => {
  const written = [];
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    cache: { save: async (data) => written.push(data) },
    scan: async () => ({ stats: {} }),
  });
  await provider.init();
  await provider.whenScanDone();
  await provider.dispose();
  assert.equal(written.length, 0);
});

test('defaultRoots 把用户高频目录排在整盘之前', () => {
  const roots = defaultRoots({ USERPROFILE: 'C:\\Users\\me' });
  const desktopIndex = roots.indexOf('C:\\Users\\me\\Desktop');
  const driveIndex = roots.indexOf('C:\\');
  assert.ok(desktopIndex >= 0);
  assert.ok(driveIndex > desktopIndex, '整盘应该排在高频目录之后');
});

test('DEFAULT_EXCLUDES 覆盖了会拖慢扫描的大目录', () => {
  for (const must of ['node_modules', '.git', 'AppData', 'dsh-home']) {
    assert.ok(DEFAULT_EXCLUDES.includes(must), `${must} 应该在默认排除清单里`);
  }
});

test('activate 走注入的 openPath 打开文件', async () => {
  const opened = [];
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    scan: async () => ({ stats: {} }),
    openPath: async (p) => {
      opened.push(p);
      return '';
    },
  });
  await provider.init();
  const result = await provider.activate({ path: 'C:\\root\\a.txt' });
  assert.deepEqual(opened, ['C:\\root\\a.txt']);
  assert.equal(result.opened, 'C:\\root\\a.txt');
});

test('activate 缺路径时报错，不静默成功', async () => {
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    scan: async () => ({ stats: {} }),
    openPath: async () => '',
  });
  await provider.init();
  await assert.rejects(() => provider.activate({}), /缺少文件路径/);
});

test('activate 打开失败时把系统消息带出来', async () => {
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    scan: async () => ({ stats: {} }),
    openPath: async () => '没有关联的程序',
  });
  await provider.init();
  await assert.rejects(() => provider.activate({ path: 'C:\\x.zzz' }), /没有关联的程序/);
});

test('重复 init 不会让索引条目重复累加', async () => {
  let round = 0;
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    scan: async ({ onBatch }) => {
      round += 1;
      onBatch([makeEntry(`C:\\root\\f${round}.txt`)]);
      return { stats: {} };
    },
  });
  await provider.init();
  await provider.whenScanDone();
  assert.equal(provider.stats().count, 1);

  await provider.init();
  await provider.whenScanDone();
  assert.equal(provider.stats().count, 1, '第二轮应是替换而不是叠加');
});

test('重新 init 期间 isIndexing 报 true', async () => {
  let release;
  let round = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = createFileProvider({
    roots: () => ['C:\\root'],
    scan: async () => {
      round += 1;
      if (round === 2) await gate;
      return { stats: {} };
    },
  });
  await provider.init();
  await provider.whenScanDone();
  assert.equal(provider.isIndexing(), false);

  await provider.init();
  assert.equal(provider.isIndexing(), true, '第二轮扫描未结束时应报索引中');
  release();
  await provider.whenScanDone();
  assert.equal(provider.isIndexing(), false);
});

