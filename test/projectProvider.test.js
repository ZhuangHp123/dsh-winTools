'use strict';

/**
 * 项目 provider 单测。
 *
 * 不碰真实磁盘、不真的起 IDEA：readRecent / scan / spawn 全部注入。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  parseRecentProjectsXml,
  readRecentProjects,
  readVscodeRecentProjects,
  readRecentlyOpenedPaths,
  resolveProjectIde,
  scanProjectRoots,
  mergeProjects,
  projectToCandidate,
  createProjectProvider,
  findIdeaExecutable,
  editorExecutableCandidates,
  findEditorExecutable,
  launchIdea,
  toWindowsPath,
} = require('../src/projects/projectProvider');

const SAMPLE_XML = `<application>
  <component name="RecentProjectsManager">
    <option name="additionalInfo">
      <map>
        <entry key="D:/cfDev/cfmoto">
          <value>
            <RecentProjectMetaInfo frameTitle="cfmoto">
              <option name="projectOpenTimestamp" value="1795000000000" />
            </RecentProjectMetaInfo>
          </value>
        </entry>
        <entry key="D:/cfDev/low-code-support">
          <value>
            <RecentProjectMetaInfo frameTitle="secondev-demo">
              <option name="customProjectName" value="secondev-demo" />
              <option name="projectOpenTimestamp" value="1796000000000" />
            </RecentProjectMetaInfo>
          </value>
        </entry>
        <entry key="D:/cfDev/a&amp;b">
          <value>
            <RecentProjectMetaInfo />
          </value>
        </entry>
      </map>
    </option>
  </component>
</application>`;

function fakeReaddir(tree) {
  const map = new Map();
  for (const [dir, children] of Object.entries(tree)) {
    map.set(dir, children.map((raw) => {
      const isDir = raw.endsWith('/');
      return {
        name: isDir ? raw.slice(0, -1) : raw,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      };
    }));
  }
  return (dir) => {
    if (!map.has(dir)) {
      const error = new Error(`ENOENT: ${dir}`);
      error.code = 'ENOENT';
      throw error;
    }
    return map.get(dir);
  };
}

test('toWindowsPath 把 IDEA 的正斜杠路径转成 Windows 路径', () => {
  assert.equal(toWindowsPath('D:/cfDev/cfmoto'), 'D:\\cfDev\\cfmoto');
  assert.equal(toWindowsPath('D:/cfDev/cfmoto/'), 'D:\\cfDev\\cfmoto');
});

test('解析 recentProjects.xml：路径、自定义名、时间戳、XML 转义', () => {
  const entries = parseRecentProjectsXml(SAMPLE_XML);
  const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));

  assert.ok(byPath['D:\\cfDev\\cfmoto']);
  assert.equal(byPath['D:\\cfDev\\cfmoto'].customName, null);
  assert.equal(byPath['D:\\cfDev\\cfmoto'].openedAt, 1795000000000);

  assert.equal(byPath['D:\\cfDev\\low-code-support'].customName, 'secondev-demo');
  assert.equal(byPath['D:\\cfDev\\a&b'].openedAt, 0);
});

test('解析空字符串/无 entry 的 XML 返回空数组', () => {
  assert.deepEqual(parseRecentProjectsXml(''), []);
  assert.deepEqual(parseRecentProjectsXml('<application></application>'), []);
});

test('readRecentProjects 按最近打开排序并去掉已不存在的项目', () => {
  const existing = new Set(['D:\\cfDev\\cfmoto', 'D:\\cfDev\\low-code-support', 'D:\\cfDev\\a&b']);
  const projects = readRecentProjects({
    files: ['fake.xml'],
    readFile: () => SAMPLE_XML,
    exists: (p) => existing.has(p),
  });
  assert.equal(projects.length, 3);
  assert.equal(projects[0].path, 'D:\\cfDev\\low-code-support'); // 时间戳最大
});

test('readRecentProjects 读不了的文件直接跳过', () => {
  const projects = readRecentProjects({
    files: ['missing.xml', 'ok.xml'],
    readFile: (file) => {
      if (file === 'missing.xml') {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return SAMPLE_XML;
    },
    exists: () => true,
  });
  assert.equal(projects.length, 3);
});

test('scanProjectRoots 找到带 .idea 的目录，且不再往里钻', () => {
  const readdirSync = fakeReaddir({
    'D:\\cfDev': ['cfmoto/', 'docs/'],
    'D:\\cfDev\\cfmoto': ['.idea/', 'nested/'],
    'D:\\cfDev\\cfmoto\\nested': ['.idea/'],
    'D:\\cfDev\\docs': ['readme.md'],
  });
  const projects = scanProjectRoots({
    roots: ['D:\\cfDev'],
    exists: () => true,
    readdirSync,
  });
  assert.deepEqual(projects.map((p) => p.path), ['D:\\cfDev\\cfmoto']);
});

test('scanProjectRoots 跳过 node_modules / target / 点目录', () => {
  const readdirSync = fakeReaddir({
    'D:\\r': ['node_modules/', 'target/', '.git/', 'app/'],
    'D:\\r\\node_modules': ['.idea/'],
    'D:\\r\\target': ['.idea/'],
    'D:\\r\\app': ['.idea/'],
  });
  const projects = scanProjectRoots({ roots: ['D:\\r'], exists: () => true, readdirSync });
  assert.deepEqual(projects.map((p) => p.path), ['D:\\r\\app']);
});

test('scanProjectRoots 遵守深度上限', () => {
  const readdirSync = fakeReaddir({
    'D:\\r': ['a/'],
    'D:\\r\\a': ['b/'],
    'D:\\r\\a\\b': ['c/'],
    'D:\\r\\a\\b\\c': ['.idea/'],
  });
  const deep = scanProjectRoots({
    roots: ['D:\\r'],
    maxDepth: 3,
    exists: () => true,
    readdirSync,
  });
  assert.deepEqual(deep.map((p) => p.path), ['D:\\r\\a\\b\\c']);

  const shallow = scanProjectRoots({
    roots: ['D:\\r'],
    maxDepth: 1,
    exists: () => true,
    readdirSync,
  });
  assert.deepEqual(shallow, []);
});

test('scanProjectRoots 读不了的目录继续扫其它分支', () => {
  const readdirSync = fakeReaddir({
    'D:\\ok': ['.idea/'],
  });
  const projects = scanProjectRoots({
    roots: ['D:\\missing', 'D:\\ok'],
    exists: () => true,
    readdirSync,
  });
  assert.deepEqual(projects.map((p) => p.path), ['D:\\ok']);
});

test('mergeProjects 按路径去重，保留自定义名与双方 tags', () => {
  const merged = mergeProjects(
    [{ path: 'D:/cfDev/cfmoto', customName: null, openedAt: 100, tags: ['cfDev'] }],
    [
      { path: 'D:\\cfDev\\cfmoto', customName: 'cfmoto-main', openedAt: 50, tags: [] },
      { path: 'D:\\cfDev\\uip', customName: null, openedAt: 0, tags: ['cfDev'] },
    ],
  );
  assert.equal(merged.length, 2);
  const cfmoto = merged.find((p) => p.path.includes('cfmoto'));
  assert.equal(cfmoto.customName, 'cfmoto-main');
  assert.deepEqual(cfmoto.tags, ['cfDev']);
  assert.equal(cfmoto.openedAt, 100);
});

test('projectToCandidate：标题用目录名，自定义名和上级目录进 tags', () => {
  const candidate = projectToCandidate({
    path: 'D:\\cfDev\\low-code-support',
    customName: 'secondev-demo',
  });
  assert.equal(candidate.kind, 'project');
  assert.equal(candidate.title, 'low-code-support');
  assert.equal(candidate.subtitle, 'D:\\cfDev\\low-code-support');
  assert.equal(candidate.path, 'D:\\cfDev\\low-code-support');
  assert.ok(candidate.tags.includes('secondev-demo'));
  assert.ok(candidate.tags.includes('cfDev'));
  assert.equal(candidate.id, 'project:d:\\cfdev\\low-code-support');
});

test('projectToCandidate：自定义名与目录名相同时不重复加 tag', () => {
  const candidate = projectToCandidate({ path: 'D:\\p\\demo', customName: 'demo' });
  assert.ok(!candidate.tags.includes('demo'));
});

test('findIdeaExecutable 优先用显式配置，其次按候选列表找存在的', () => {
  assert.equal(
    findIdeaExecutable({
      ideaPath: 'D:\\Custom\\idea64.exe',
      exists: (p) => p === 'D:\\Custom\\idea64.exe',
    }),
    'D:\\Custom\\idea64.exe',
  );

  assert.equal(
    findIdeaExecutable({
      env: { ProgramFiles: 'C:\\Program Files' },
      listDirs: () => ['IntelliJ IDEA 2026.2.3'],
      exists: (p) => p === 'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.2.3\\bin\\idea64.exe',
      ideaPath: 'D:\\Nope\\idea64.exe',
    }),
    'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.2.3\\bin\\idea64.exe',
  );

  assert.equal(findIdeaExecutable({ env: {}, listDirs: () => [], exists: () => false }), null);
});

test('provider：init 合并两个来源，search 返回全量候选', async () => {
  const provider = createProjectProvider({
    readRecent: () => [
      { path: 'D:\\cfDev\\cfmoto', customName: null, openedAt: 200 },
      { path: 'D:\\cfDev\\uip', customName: null, openedAt: 100 },
    ],
    scan: () => [{ path: 'D:\\cfDev\\cfmoto', customName: null, openedAt: 0 }],
    findIdeaExecutable: () => 'D:\\idea\\idea64.exe',
  });

  const result = await provider.init();
  assert.equal(result.count, 2);
  assert.equal(result.ideaPath, 'D:\\idea\\idea64.exe');
  assert.equal(provider.search().length, 2);
  assert.equal(provider.stats().count, 2);
  assert.deepEqual(provider.aliases.includes('项目'), true);
});

test('provider：activate 用 idea64.exe 打开项目路径', async () => {
  const spawned = [];
  const provider = createProjectProvider({
    readRecent: () => [{ path: 'D:\\cfDev\\cfmoto', customName: null, openedAt: 1 }],
    scan: () => [],
    findIdeaExecutable: () => 'D:\\idea\\idea64.exe',
    spawn: (exe, args, opts) => {
      spawned.push({ exe, args, opts });
      return { unref() {}, on() {} };
    },
  });
  await provider.init();
  const [candidate] = provider.search();
  const result = await provider.activate(candidate);

  assert.deepEqual(result, { opened: 'D:\\cfDev\\cfmoto', ide: 'idea', exe: 'D:\\idea\\idea64.exe' });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].exe, 'D:\\idea\\idea64.exe');
  assert.deepEqual(spawned[0].args, ['D:\\cfDev\\cfmoto']);
  assert.equal(spawned[0].opts.detached, true);
});

test('provider：项目用 Cursor 打开时调 Cursor.exe，候选带 Cursor 图标源', async () => {
  const spawned = [];
  const provider = createProjectProvider({
    readRecent: () => [],
    readVscodeRecent: () => [
      { path: 'D:\\cfDev\\cfmoto', customName: null, openedAt: 0, ides: ['cursor'] },
    ],
    scan: () => [],
    findExecutable: (ide) =>
      ({ idea: 'D:\\idea\\idea64.exe', cursor: 'D:\\cursor\\Cursor.exe', vscode: null })[ide] ?? null,
    spawn: (exe, args) => {
      spawned.push({ exe, args });
      return { unref() {}, on() {} };
    },
  });
  await provider.init();
  const [candidate] = provider.search();
  assert.equal(candidate.ide, 'cursor');
  assert.equal(candidate.iconFile, 'D:\\cursor\\Cursor.exe');

  const result = await provider.activate(candidate);
  assert.equal(result.ide, 'cursor');
  assert.equal(spawned[0].exe, 'D:\\cursor\\Cursor.exe');
});

test('provider：Cursor 没装时 activate 报错并指向 cursorPath', async () => {
  const provider = createProjectProvider({
    readRecent: () => [],
    readVscodeRecent: () => [
      { path: 'D:\\cfDev\\cfmoto', customName: null, openedAt: 0, ides: ['cursor'] },
    ],
    scan: () => [],
    findExecutable: () => null,
  });
  await provider.init();
  await assert.rejects(() => provider.activate(provider.search()[0]), /cursorPath/);
});

test('provider：找不到 IDEA 时 activate 抛出可操作的错误', async () => {
  const provider = createProjectProvider({
    readRecent: () => [{ path: 'D:\\cfDev\\cfmoto', customName: null, openedAt: 1 }],
    scan: () => [],
    findIdeaExecutable: () => null,
  });
  await provider.init();
  await assert.rejects(() => provider.activate(provider.search()[0]), /IntelliJ IDEA/);
});

test('provider：缺少路径时 activate 抛 invalid_item', async () => {
  const provider = createProjectProvider({
    readRecent: () => [],
    scan: () => [],
    findIdeaExecutable: () => 'D:\\idea\\idea64.exe',
  });
  await provider.init();
  await assert.rejects(() => provider.activate({}), (error) => error.code === 'invalid_item');
});

test('scanProjectRoots 同时识别 .idea / .cursor / .vscode 标记', () => {
  const readdirSync = fakeReaddir({
    'D:\\r': ['a/', 'b/', 'c/', 'none/'],
    'D:\\r\\a': ['.idea/'],
    'D:\\r\\b': ['.cursor/', 'src/'],
    'D:\\r\\c': ['.vscode/', '.idea/'],
    'D:\\r\\none': ['src/'],
  });
  const projects = scanProjectRoots({ roots: ['D:\\r'], exists: () => true, readdirSync });
  const byName = Object.fromEntries(projects.map((p) => [p.path.slice(-1), p.ides.sort()]));
  assert.deepEqual(byName, { a: ['idea'], b: ['cursor'], c: ['idea', 'vscode'] });
});

test('resolveProjectIde：双标记时用编辑时间更新的那个 IDE', () => {
  const project = { path: 'D:\\p\\x', ides: ['idea', 'cursor'] };
  const newerCursor = (target) => ({
    mtimeMs: target.endsWith('.idea\\workspace.xml') ? 1000 : 2000,
  });
  assert.equal(resolveProjectIde(project, { statSync: newerCursor }), 'cursor');

  const newerIdea = (target) => ({ mtimeMs: target.endsWith('.cursor') ? 500 : 9000 });
  assert.equal(resolveProjectIde(project, { statSync: newerIdea }), 'idea');

  assert.equal(resolveProjectIde({ path: 'D:\\p\\y', ides: ['vscode'] }), 'vscode');
});

test('readRecentlyOpenedPaths：只认 folderUri，忽略单文件条目', () => {
  const db = {
    prepare: () => ({
      get: () => ({
        value: JSON.stringify({
          entries: [
            { folderUri: 'file:///d%3A/cfDev/cfmoto' },
            { fileUri: 'file:///c%3A/Desktop/a.sql' },
            { workspace: { configPath: 'file:///d%3A/cfDev/all.code-workspace' } },
          ],
        }),
      }),
    }),
    close() {},
  };
  const entries = readRecentlyOpenedPaths('fake.vscdb', () => db);
  assert.equal(entries.length, 3);

  const projects = readVscodeRecentProjects({
    appData: 'C:\\AppData',
    exists: (p) => !p.endsWith('Code\\User\\globalStorage\\state.vscdb') && !p.endsWith('.sql'),
    openDatabase: () => db,
  });
  const paths = projects.map((p) => p.path.toLowerCase()).sort();
  assert.deepEqual(paths, ['d:\\cfdev', 'd:\\cfdev\\cfmoto']);
  assert.deepEqual(projects.map((p) => p.ides[0]), ['cursor', 'cursor']);
});

test('editorExecutableCandidates：找到便携目录下的 Cursor / VS Code', () => {
  const listDirs = (dir) => ({ 'D:\\': ['cursor', 'Microsoft VS Code', 'other'] }[dir] ?? []);
  assert.deepEqual(editorExecutableCandidates('cursor', { SystemDrive: 'C:' }, listDirs), [
    'D:\\cursor\\Cursor.exe',
  ]);
  assert.deepEqual(editorExecutableCandidates('vscode', { SystemDrive: 'C:' }, listDirs), [
    'D:\\Microsoft VS Code\\Code.exe',
  ]);
  assert.equal(
    findEditorExecutable('cursor', {
      env: {},
      listDirs: () => [],
      exists: (p) => p === 'D:\\x\\Cursor.exe',
      cursorPath: 'D:\\x\\Cursor.exe',
    }),
    'D:\\x\\Cursor.exe',
  );
});

test('projectToCandidate：非 IDEA 的 IDE 名进 tags，ide/iconFile 一起带出', () => {
  const candidate = projectToCandidate({
    path: 'D:\\cfDev\\cfmoto',
    ide: 'cursor',
    iconFile: 'D:\\cursor\\Cursor.exe',
  });
  assert.equal(candidate.ide, 'cursor');
  assert.equal(candidate.iconFile, 'D:\\cursor\\Cursor.exe');
  assert.ok(candidate.tags.includes('cursor'));
});

test('mergeProjects 合并双方 ides', () => {
  const merged = mergeProjects(
    [{ path: 'D:/p/x', customName: null, openedAt: 1, ides: ['idea'] }],
    [{ path: 'D:\\p\\x', customName: null, openedAt: 0, ides: ['cursor'] }],
  );
  assert.deepEqual(merged[0].ides.sort(), ['cursor', 'idea']);
});

test('launchIdea 对 .bat 走 shell，对 exe 不走', () => {
  const calls = [];
  const fakeSpawn = (exe, args, opts) => {
    calls.push({ exe, opts });
    return { unref() {}, on() {} };
  };

  launchIdea('D:\\idea\\idea64.exe', 'D:\\p', { spawn: fakeSpawn });
  launchIdea('D:\\idea\\idea.bat', 'D:\\p', { spawn: fakeSpawn });

  assert.ok(!calls[0].opts.shell);
  assert.equal(calls[1].opts.shell, true);
  assert.equal(calls[0].opts.detached, true);
});
