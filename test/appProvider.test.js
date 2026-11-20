'use strict';

/**
 * 应用 provider 单测。
 *
 * 用假的 fs（内存文件树）而非真实磁盘：测试不该依赖这台机器装了什么，
 * 也不该因为某个用户没装 Office 就红。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  scanApps,
  shortcutToCandidate,
  findShortcuts,
  startMenuRoots,
  buildSearchTags,
  createAppProvider,
} = require('../src/apps/appProvider');

const { HEADER_SIZE, makeLinkInfo, makeHeader } = require('./helpers/lnk-fixtures');

/**
 * 造一棵内存里的开始菜单。
 * @param {Record<string, Buffer|string>} files 路径 → .lnk 内容或原始字符串
 */
function fakeFs(files) {
  const dirs = new Set();
  for (const filePath of Object.keys(files)) {
    const parts = filePath.split('\\');
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(parts.slice(0, i).join('\\'));
    }
  }

  const byDir = new Map();
  const push = (dir, entry) => {
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(entry);
  };

  // 目录先入列：真实 readdirSync 的子目录一定出现在父目录的条目里。
  for (const dir of dirs) {
    const parts = dir.split('\\');
    const parent = parts.slice(0, -1).join('\\');
    const name = parts[parts.length - 1];
    if (parent) {
      push(parent, { name, isDirectory: () => true, isFile: () => false });
    }
  }
  for (const filePath of Object.keys(files)) {
    const parts = filePath.split('\\');
    const dir = parts.slice(0, -1).join('\\');
    const name = parts[parts.length - 1];
    if (dirs.has(filePath)) continue;
    push(dir, { name, isDirectory: () => false, isFile: () => true });
  }

  return {
    readdirSync(dir) {
      if (!byDir.has(dir)) {
        const error = new Error(`ENOENT: ${dir}`);
        error.code = 'ENOENT';
        throw error;
      }
      return byDir.get(dir);
    },
    readFileSync(p) {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      const value = files[p];
      return Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
    },
    existsSync(p) {
      return p in files || dirs.has(p);
    },
  };
}

test('startMenuRoots 同时给出系统级和用户级开始菜单', () => {
  const roots = startMenuRoots({ ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });
  assert.equal(roots.length, 2);
  assert.ok(roots[0].includes('ProgramData'));
  assert.ok(roots[1].includes('AppData\\Roaming'));
});

test('startMenuRoots 在没有 APPDATA 时只给系统级', () => {
  const roots = startMenuRoots({ ProgramData: 'C:\\ProgramData' });
  assert.deepEqual(roots, ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs']);
});

test('findShortcuts 递归找 .lnk，忽略其它文件', () => {
  const fs = fakeFs({
    'C:\\SM\\Programs\\a.lnk': 'x',
    'C:\\SM\\Programs\\readme.txt': 'x',
    'C:\\SM\\Programs\\Vendor\\b.lnk': 'x',
    'C:\\SM\\Programs\\Vendor\\deep\\c.lnk': 'x',
    'C:\\SM\\Programs\\Vendor\\icon.png': 'x',
  });
  const found = findShortcuts(['C:\\SM\\Programs'], {
    readdirSync: fs.readdirSync,
  });
  assert.equal(found.length, 3);
  assert.ok(found.some((p) => p.endsWith('a.lnk')));
  assert.ok(found.some((p) => p.endsWith('b.lnk')));
  assert.ok(found.some((p) => p.endsWith('c.lnk')));
});

test('findShortcuts 跳过读不了的目录，不让整次扫描失败', () => {
  const fs = fakeFs({ 'C:\\SM\\Programs\\a.lnk': 'x' });
  const found = findShortcuts(['C:\\Nope', 'C:\\SM\\Programs'], {
    readdirSync: fs.readdirSync,
  });
  assert.equal(found.length, 1);
});

test('findShortcuts 遵守 maxDepth', () => {
  const fs = fakeFs({
    'C:\\SM\\d1\\d2\\d3\\deep.lnk': 'x',
    'C:\\SM\\a.lnk': 'x',
  });
  const shallow = findShortcuts(['C:\\SM'], { readdirSync: fs.readdirSync, maxDepth: 1 });
  assert.equal(shallow.length, 1, 'maxDepth=1 时只应看到 a.lnk');
});

test('shortcutToCandidate 用 .lnk 文件名作为标题（不是目标名）', () => {
  const lnk = Buffer.concat([makeHeader(0x02), makeLinkInfo('C:\\Program Files\\App\\internal.exe')]);
  const fs = fakeFs({ 'C:\\SM\\Programs\\Visual Studio Code.lnk': lnk });
  const candidate = shortcutToCandidate('C:\\SM\\Programs\\Visual Studio Code.lnk', {
    readFile: fs.readFileSync,
    exists: fs.existsSync,
  });
  assert.equal(candidate.title, 'Visual Studio Code');
  assert.equal(candidate.targetPath, 'C:\\Program Files\\App\\internal.exe');
  assert.equal(candidate.path, 'C:\\SM\\Programs\\Visual Studio Code.lnk');
  assert.equal(candidate.kind, 'app');
});

test('shortcutToCandidate 的 id 基于小写路径，大小写不同视为同一个应用', () => {
  const lnk = Buffer.concat([makeHeader(0x02), makeLinkInfo('C:\\a.exe')]);
  const fs = fakeFs({ 'C:\\SM\\Programs\\App.lnk': lnk });
  const a = shortcutToCandidate('C:\\SM\\Programs\\App.lnk', { readFile: fs.readFileSync, exists: fs.existsSync });
  const b = shortcutToCandidate('c:\\sm\\programs\\app.lnk', { readFile: fs.readFileSync, exists: fs.existsSync });
  assert.equal(a.id, b.id);
});

test('.lnk 解析失败仍产出候选，只是没有目标路径', () => {
  // 关键约束：启动走 .lnk 本身，解析目标只是显示用，失败不能丢候选。
  const fs = fakeFs({ 'C:\\SM\\Programs\\Broken.lnk': 'not a real shortcut' });
  const candidate = shortcutToCandidate('C:\\SM\\Programs\\Broken.lnk', {
    readFile: fs.readFileSync,
    exists: fs.existsSync,
  });
  assert.equal(candidate.title, 'Broken');
  assert.equal(candidate.targetPath, null);
  assert.equal(candidate.path, 'C:\\SM\\Programs\\Broken.lnk');
});

test('buildSearchTags 收录目录名、目标名和目标路径', () => {
  const tags = buildSearchTags(
    'Adobe Acrobat DC',
    'C:\\ProgramData\\Start Menu\\Programs\\Adobe Acrobat DC.lnk',
    'C:\\Program Files\\Adobe\\Acrobat\\Acrobat.exe',
  );
  assert.ok(tags.includes('Adobe Acrobat DC') === false, '不应重复收录标题本身');
  assert.ok(tags.includes('Acrobat'), '应收录目标文件名');
  assert.ok(tags.some((t) => t.includes('Program Files')), '应收录完整目标路径');
});

test('buildSearchTags 在 Programs 目录时不把 "Programs" 当标签', () => {
  const tags = buildSearchTags('X', 'C:\\SM\\Programs\\X.lnk', null);
  assert.ok(!tags.includes('Programs'));
});

test('scanApps 汇总整棵开始菜单', () => {
  const lnkA = Buffer.concat([makeHeader(0x02), makeLinkInfo('C:\\a\\a.exe')]);
  const lnkB = Buffer.concat([makeHeader(0x02), makeLinkInfo('C:\\b\\b.exe')]);
  const fs = fakeFs({
    'C:\\SM\\Programs\\A.lnk': lnkA,
    'C:\\SM\\Programs\\Vendor\\B.lnk': lnkB,
  });
  // findShortcuts 需要注入 readdirSync，通过 options.findShortcuts 传进去。
  const result = scanApps({
    roots: ['C:\\SM\\Programs'],
    readFile: fs.readFileSync,
    exists: fs.existsSync,
    findShortcuts: (roots) => findShortcuts(roots, { readdirSync: fs.readdirSync }),
  });
  assert.equal(result.shortcutCount, 2);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((c) => c.title).sort(), ['A', 'B']);
});

test('应用 provider 的 activate 启动的是 .lnk 本身而不是目标文件', async () => {
  // 这是刻意的设计：.lnk 里带参数、工作目录、UAC 元数据，
  // 直接启动解析出的目标会丢这些信息。
  const launched = [];
  const provider = createAppProvider({
    scan: () => ({
      candidates: [
        { id: 'app:c:\\x.lnk', kind: 'app', title: 'X', path: 'C:\\x.lnk', targetPath: 'C:\\target.exe' },
      ],
      shortcutCount: 1,
    }),
    openPath: async (p) => {
      launched.push(p);
      return '';
    },
  });
  await provider.init();
  await provider.activate({ path: 'C:\\x.lnk', targetPath: 'C:\\target.exe' });
  assert.deepEqual(launched, ['C:\\x.lnk']);
});

test('activate 缺少路径时抛 invalid_item', async () => {
  const provider = createAppProvider({ scan: () => ({ candidates: [], shortcutCount: 0 }) });
  await provider.init();
  await assert.rejects(() => provider.activate({}), (error) => error.code === 'invalid_item');
});

test('activate 遇到 openPath 返回错误信息时抛 launch_failed', async () => {
  const provider = createAppProvider({
    scan: () => ({ candidates: [], shortcutCount: 0 }),
    openPath: async () => '权限被拒绝',
  });
  await provider.init();
  await assert.rejects(
    () => provider.activate({ path: 'C:\\x.lnk' }),
    (error) => error.code === 'launch_failed' && /权限被拒绝/.test(error.message),
  );
});

test('provider.search 返回全部候选（打分交给 engine）', async () => {
  const candidates = [
    { id: 'app:a', title: 'A', path: 'C:\\a.lnk' },
    { id: 'app:b', title: 'B', path: 'C:\\b.lnk' },
  ];
  const provider = createAppProvider({
    scan: () => ({ candidates, shortcutCount: 2 }),
    openPath: async () => '',
  });
  await provider.init();
  assert.equal(provider.search(['a']).length, 2);
  assert.deepEqual(provider.stats(), { shortcutCount: 2 });
});
