'use strict';

/**
 * Chrome provider 单测。
 *
 * UIA / sqlite / spawn 全部注入，测试不依赖本机 Chrome 是否在跑。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  cleanTabTitle,
  stripInvisible,
  siteName,
  urlSearchTerms,
  parseBookmarks,
  flattenBookmarks,
  bookmarkToCandidate,
  tabToCandidate,
  loadBookmarks,
  listProfiles,
  chromeExecutableCandidates,
  findChromeExecutable,
  parseUiaOutput,
  fillUrlsFromHistory,
  buildActivateScript,
  activateTab,
  openUrl,
  createChromeProvider,
} = require('../src/web/chromeProvider');

const BOOKMARKS_JSON = JSON.stringify({
  checksum: 'x',
  version: 1,
  roots: {
    bookmark_bar: {
      type: 'folder',
      name: '书签栏',
      children: [
        { type: 'url', name: 'GitLab 登录', url: 'https://cfgitlab.cfmoto.com:8443/users/sign_in' },
        {
          type: 'folder',
          name: '内部系统',
          children: [
            { type: 'url', name: '任务调度', url: 'http://192.168.1.27:9090/xxl-job-admin' },
            {
              type: 'folder',
              name: '数据库',
              children: [{ type: 'url', name: 'Archery', url: 'http://192.168.1.19:9123/sqlquery/' }],
            },
          ],
        },
      ],
    },
    other: {
      type: 'folder',
      name: '其他书签',
      children: [{ type: 'url', name: 'Bing', url: 'https://www.bing.com' }],
    },
    synced: { type: 'folder', name: '移动设备书签', children: [] },
  },
});

test('cleanTabTitle 去掉内存用量后缀', () => {
  assert.equal(cleanTabTitle('任务调度中心 - 内存用量 - 35.1 MB'), '任务调度中心');
  assert.equal(cleanTabTitle('某页面 - 内存用量高 - 1.7 GB'), '某页面');
  assert.equal(cleanTabTitle('没有后缀的标题'), '没有后缀的标题');
  assert.equal(cleanTabTitle(''), '');
});

test('stripInvisible 去掉变体选择符等不可见字符', () => {
  const dirty = '\u200B\u2060钉钉文档\uFEFF';
  assert.equal(stripInvisible(dirty), '钉钉文档');
});

test('siteName 提取主机名，非法 URL 原样返回', () => {
  assert.equal(siteName('https://cfgitlab.cfmoto.com:8443/x'), 'cfgitlab.cfmoto.com');
  assert.equal(siteName('http://10.32.4.199:8080/'), '10.32.4.199');
  assert.equal(siteName('not a url'), 'not a url');
});

test('flattenBookmarks 递归展开并记录文件夹层级', () => {
  const roots = JSON.parse(BOOKMARKS_JSON).roots;
  const bar = flattenBookmarks(roots.bookmark_bar);
  assert.equal(bar.length, 3);
  const archery = bar.find((b) => b.name === 'Archery');
  assert.deepEqual(archery.folderTags, ['内部系统', '数据库']);
  // 书签栏本层不加 tag
  assert.deepEqual(bar.find((b) => b.name === 'GitLab 登录').folderTags, []);
});

test('parseBookmarks 合并三个根、给 other 和 synced 打来源标签', () => {
  const all = parseBookmarks(BOOKMARKS_JSON);
  assert.equal(all.length, 4);
  const bing = all.find((b) => b.name === 'Bing');
  assert.deepEqual(bing.folderTags, ['其他书签']);
});

test('parseBookmarks 对坏 JSON / 无 roots 返回空数组', () => {
  assert.deepEqual(parseBookmarks('{not json'), []);
  assert.deepEqual(parseBookmarks('{}'), []);
  assert.deepEqual(parseBookmarks(''), []);
});

test('bookmarkToCandidate：副标题带主机名与来源，主机名进 tags', () => {
  const candidate = bookmarkToCandidate({
    name: '任务调度',
    url: 'http://192.168.1.27:9090/xxl-job-admin',
    folderTags: ['内部系统'],
  });
  assert.equal(candidate.kind, 'web');
  assert.equal(candidate.source, 'bookmark');
  assert.equal(candidate.title, '任务调度');
  assert.match(candidate.subtitle, /192\.168\.1\.27/);
  assert.match(candidate.subtitle, /收藏夹/);
  assert.ok(candidate.tags.includes('内部系统'));
  assert.ok(candidate.tags.includes('192.168.1.27'));
  assert.equal(candidate.id, 'chrome:bookmark:http://192.168.1.27:9090/xxl-job-admin');
});

test('tabToCandidate：标题清后缀，URL 进 tags 以便按域名搜索', () => {
  const candidate = tabToCandidate({
    title: '我的工作任务 | 工作包 - 内存用量 - 159 MB',
    url: 'http://10.32.4.199:8080/work_packages?query_id=1',
    hwnd: 12345,
    index: 2,
  });
  assert.equal(candidate.title, '我的工作任务 | 工作包');
  assert.equal(candidate.source, 'tab');
  assert.equal(candidate.hwnd, 12345);
  assert.equal(candidate.index, 2);
  assert.ok(candidate.tags.includes('10.32.4.199'));
  assert.ok(candidate.tags.some((tag) => tag.includes('work_packages')));
  assert.match(candidate.subtitle, /已打开/);
});

test('tabToCandidate：没有 URL 时仍可用标题生成条目', () => {
  const candidate = tabToCandidate({ title: '后台标签页', hwnd: 1, index: 0 });
  assert.equal(candidate.title, '后台标签页');
  assert.equal(candidate.url, false || null);
  assert.equal(candidate.subtitle, '已打开标签页');
  assert.equal(candidate.id, 'chrome:tab:1#0:后台标签页');
});

test('tabToCandidate：空标题返回 null', () => {
  assert.equal(tabToCandidate({ title: '', url: 'https://x.com' }), null);
  assert.equal(tabToCandidate({ title: '   ' }), null);
});

test('loadBookmarks 读多个 profile 并跳过缺失文件', () => {
  const result = loadBookmarks({
    userDataDirs: ['C:\\UD'],
    listDirs: () => ['Default', 'Profile 1', 'Crashpad'],
    exists: (p) => !p.endsWith('Crashpad') && !p.endsWith('Crashpad\\Bookmarks'),
    readFile: (file) => {
      if (file.endsWith('Profile 1\\Bookmarks')) return BOOKMARKS_JSON;
      if (file.endsWith('Default\\Bookmarks')) return BOOKMARKS_JSON;
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(result.candidates.length, 8); // 4 + 4
  assert.deepEqual(result.errors, []);
});

test('listProfiles 只认 Default 与 Profile N，且要求有标志文件', () => {
  const listed = listProfiles(
    'C:\\UD',
    () => ['Default', 'Profile 1', 'Profile 2', 'Crashpad', 'ShaderCache'],
    (p) => !p.includes('Profile 2'),
  );
  assert.deepEqual(
    listed.map((p) => p.split('\\').pop()),
    ['Default', 'Profile 1'],
  );
});

test('findChromeExecutable 优先显式路径，其次候选列表', () => {
  assert.equal(
    findChromeExecutable({ chromePath: 'D:\\Custom\\chrome.exe', exists: (p) => p === 'D:\\Custom\\chrome.exe' }),
    'D:\\Custom\\chrome.exe',
  );

  const env = { ProgramFiles: 'C:\\Program Files' };
  const expected = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(findChromeExecutable({ env, exists: (p) => p === expected }), expected);

  assert.equal(findChromeExecutable({ env: {}, exists: () => false }), null);
});

test('chromeExecutableCandidates 覆盖 Program Files / x86 / LocalAppData', () => {
  const candidates = chromeExecutableCandidates({
    ProgramFiles: 'C:\\PF',
    'ProgramFiles(x86)': 'C:\\PF86',
    LOCALAPPDATA: 'C:\\LAD',
  });
  assert.ok(candidates.includes('C:\\PF\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(candidates.includes('C:\\PF86\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(candidates.includes('C:\\LAD\\Google\\Chrome\\Application\\chrome.exe'));
});

test('parseUiaOutput 兼容数组、单对象、空输出与坏 JSON', () => {
  assert.deepEqual(parseUiaOutput('[]'), []);
  assert.deepEqual(parseUiaOutput(''), []);
  assert.deepEqual(parseUiaOutput('not json'), []);
  assert.equal(parseUiaOutput('[{"title":"a"}]').length, 1);
  assert.equal(parseUiaOutput('{"title":"a"}').length, 1);
  // 没有 title 的条目被过滤
  assert.equal(parseUiaOutput('[{"hwnd":1},{"title":"ok"}]').length, 1);
});

test('fillUrlsFromHistory 按标题精确补 URL', () => {
  const tabs = [{ title: '任务调度中心 - 内存用量 - 35.1 MB', url: null }];
  const result = fillUrlsFromHistory(tabs, {
    queryHistory: () => [{ title: '任务调度中心', url: 'http://scheduler.local/' }],
  });
  assert.equal(result[0].url, 'http://scheduler.local/');
});

test('fillUrlsFromHistory 前缀命中也补上，且优先最长的匹配', () => {
  const tabs = [{ title: '春节活动', url: null }];
  const result = fillUrlsFromHistory(tabs, {
    queryHistory: () => [
      { title: '春节活动', url: 'http://short/' },
      { title: '春节活动详情页', url: 'http://long/' },
    ],
  });
  // 精确匹配置信度最高，优先于前缀
  assert.equal(result[0].url, 'http://short/');
});

test('fillUrlsFromHistory 已有 URL 的标签页不覆盖', () => {
  const tabs = [{ title: 'x', url: 'https://keep/' }];
  const result = fillUrlsFromHistory(tabs, {
    queryHistory: () => [{ title: 'x', url: 'https://other/' }],
  });
  assert.equal(result[0].url, 'https://keep/');
});

test('fillUrlsFromHistory 历史库读失败时原样返回', () => {
  const tabs = [{ title: 'x', url: null }];
  const result = fillUrlsFromHistory(tabs, {
    queryHistory: () => {
      throw new Error('database is locked');
    },
  });
  assert.equal(result[0].url, null);
});

test('buildActivateScript 把 hwnd 与 index 写进脚本', () => {
  const script = buildActivateScript(123456, 3);
  assert.match(script, /\[int64\]123456/);
  assert.match(script, /\$index = 3/);
  assert.match(script, /SelectionItemPattern/);
  assert.match(script, /AttachThreadInput/);
});

test('buildActivateScript 只在最小化时才 SW_RESTORE，避免把最大化窗口缩回去', () => {
  const script = buildActivateScript(1, 0);
  assert.match(script, /IsIconic\(\$hwnd\)/, '缺少 IsIconic 判断');
  assert.match(script, /ShowWindow\(\$hwnd, 9\)/, '最小化时仍需 SW_RESTORE');
  // 不能出现无条件的 SW_RESTORE
  assert.ok(!/\n\[void\]\[Win32Fg\]::ShowWindow\(\$hwnd, 9\)/.test(script), '存在无条件 SW_RESTORE');
});

test('buildActivateScript 用 SW_SHOWNA 兜底可见性，且成功条件包含可见与前台', () => {
  const script = buildActivateScript(1, 0);
  assert.match(script, /ShowWindow\(\$hwnd, 8\)/, '缺少 SW_SHOWNA 兜底');
  assert.match(script, /IsWindowVisible\(\$hwnd\)/, '缺少可见性校验');
  assert.match(script, /\$ok = \$visible -and \$selected -and \$isForeground/, '成功条件不完整');
});

test('activateTab 调用脚本并解析结果', async () => {
  const calls = [];
  const result = await activateTab(
    { hwnd: 999, index: 1 },
    {
      runPowerShell: async (script) => {
        calls.push(script);
        return '{"ok":true,"selected":true,"index":1}';
      },
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
});

test('activateTab 缺少位置信息时不执行脚本', async () => {
  const result = await activateTab({ hwnd: 1, index: null }, { runPowerShell: async () => '{}' });
  assert.equal(result.ok, false);
  assert.match(result.message, /缺少/);
});

test('activateTab 脚本返回失败时透传 message', async () => {
  const result = await activateTab(
    { hwnd: 1, index: 0 },
    { runPowerShell: async () => '{"ok":false,"message":"tab index out of range","selected":false}' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.message, 'tab index out of range');
  assert.equal(result.switched, undefined);
});

test('activateTab 标签页已选中但窗口没显示时标记 switched，避免重复开页', async () => {
  const result = await activateTab(
    { hwnd: 1, index: 0 },
    {
      runPowerShell: async () =>
        '{"ok":false,"selected":true,"visible":false,"foreground":false,"message":"窗口未能显示","code":"not_visible"}',
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.switched, true);
  assert.match(result.message, /窗口未能显示/);
});

test('openUrl 以 detached 方式启动浏览器', () => {
  const calls = [];
  openUrl('C:\\chrome.exe', 'https://x.com', {
    spawn: (exe, args, opts) => {
      calls.push({ exe, args, opts });
      return { unref() {}, on() {} };
    },
  });
  assert.equal(calls[0].exe, 'C:\\chrome.exe');
  assert.deepEqual(calls[0].args, ['https://x.com']);
  assert.equal(calls[0].opts.detached, true);
});

/** 造一个 provider：标签页、收藏夹、chrome 路径全部注入。 */
function makeProvider(overrides = {}) {
  return createChromeProvider({
    listTabs: async () => [
      { hwnd: 100, index: 0, title: '接口管理 - 内存用量 - 165 MB', url: 'http://10.32.3.51:8221/#/welcome', selected: true },
      { hwnd: 100, index: 1, title: '任务调度中心 - 内存用量 - 35.1 MB', url: null, selected: false },
    ],
    fillUrls: (tabs) => {
      const second = tabs.find((tab) => tab.index === 1);
      if (second && !second.url) second.url = 'http://192.168.1.27:9090/xxl-job-admin';
      return tabs;
    },
    loadBookmarks: () => ({ candidates: parseBookmarks(BOOKMARKS_JSON).map(bookmarkToCandidate), errors: [] }),
    findChrome: () => 'C:\\chrome.exe',
    refreshInterval: 0,
    ...overrides,
  });
}

test('bookmarkToCandidate：没有标题的书签用域名当标题', () => {
  const bare = bookmarkToCandidate({ name: 'https://uiatest.cfmoto.com:9512/x', url: 'https://uiatest.cfmoto.com:9512/x' });
  assert.equal(bare.title, 'uiatest.cfmoto.com');

  const empty = bookmarkToCandidate({ name: '', url: 'http://10.32.3.51:8221/#/welcome' });
  assert.equal(empty.title, '10.32.3.51');

  const normal = bookmarkToCandidate({ name: 'GitLab', url: 'https://cfgitlab.cfmoto.com/' });
  assert.equal(normal.title, 'GitLab');

  // 无 scheme 的 URL 形态也是裸 URL：Chrome 存页面时会把这种串当名字。
  const noScheme = bookmarkToCandidate({
    name: 'uiatest.cfmoto.com:9512/esc-sso/login/page#id=1',
    url: 'https://uiatest.cfmoto.com:9512/esc-sso/login/page#id=1',
  });
  assert.equal(noScheme.title, 'uiatest.cfmoto.com');

  // 正常标题即便含点也不能误判（如版本号、文件名）。
  const dotted = bookmarkToCandidate({ name: 'IntelliJ IDEA 2026.2', url: 'https://example.com/idea' });
  assert.equal(dotted.title, 'IntelliJ IDEA 2026.2');
});

test('urlSearchTerms 拆出域名与路径段，跳过纯数字 id', () => {
  const terms = urlSearchTerms('https://alidocs.dingtalk.com/i/nodes/1234567890?x=1');
  assert.ok(terms.includes('alidocs.dingtalk.com'));
  assert.ok(terms.includes('nodes'));
  assert.ok(!terms.includes('1234567890'));
  assert.deepEqual(urlSearchTerms(''), []);
});

test('tabToCandidate：域名放进 altTitles，标题不含域名也能被主匹配', () => {
  const candidate = tabToCandidate({
    title: '任务调度中心',
    url: 'http://192.168.1.27:9090/xxl-job-admin/jobinfo?jobGroup=25',
    hwnd: 1,
    index: 0,
  });
  assert.ok(Array.isArray(candidate.altTitles));
  assert.ok(candidate.altTitles.includes('192.168.1.27'));
  assert.ok(candidate.altTitles.some((term) => term.includes('xxl-job-admin')));
});

test('fillUrlsFromHistory 应用到 activeUrl 兜底（历史库没有时）', () => {
  const tabs = [{ title: '刚开的页面', url: null, activeUrl: 'https://fresh.example/' }];
  fillUrlsFromHistory(tabs, { queryHistory: () => [] });
  assert.equal(tabs[0].url, 'https://fresh.example/');
});

test('provider：init 汇总标签页与收藏夹', async () => {
  const provider = makeProvider();
  const result = await provider.init();
  // 标签页在后台刷新；轮询关闭时手动等一轮。
  await provider.refresh();
  assert.equal(result.bookmarks, 4);
  assert.equal(provider.stats().tabs, 2);
  assert.equal(provider.search().length, 6);
  assert.equal(provider.aliases.includes('网页'), true);
  provider.dispose();
});

test('provider：激活收藏夹走新开标签页', async () => {
  const opened = [];
  const provider = makeProvider({
    openUrl: (exe, url) => {
      opened.push({ exe, url });
      return { unref() {}, on() {} };
    },
  });
  await provider.init();
  const bookmark = provider.search().find((item) => item.source === 'bookmark');
  const result = await provider.activate(bookmark);
  assert.equal(result.mode, 'new-tab');
  assert.deepEqual(opened, [{ exe: 'C:\\chrome.exe', url: bookmark.url }]);
  provider.dispose();
});

test('provider：激活已打开标签页优先切换', async () => {
  const switched = [];
  const opened = [];
  const provider = makeProvider({
    activateTab: async (tab) => {
      switched.push(tab);
      return { ok: true };
    },
    openUrl: (exe, url) => {
      opened.push(url);
      return { unref() {}, on() {} };
    },
  });
  await provider.init();
  const tab = provider.search().find((item) => item.source === 'tab');
  const result = await provider.activate(tab);
  assert.equal(result.switched, true);
  assert.equal(switched.length, 1);
  assert.equal(switched[0].hwnd, 100);
  assert.equal(opened.length, 0);
  provider.dispose();
});

test('provider：切换失败时退回新开标签页', async () => {
  const opened = [];
  const provider = makeProvider({
    activateTab: async () => ({ ok: false, message: '被占用' }),
    openUrl: (exe, url) => {
      opened.push(url);
      return { unref() {}, on() {} };
    },
  });
  await provider.init();
  const tab = provider.search().find((item) => item.source === 'tab');
  const result = await provider.activate(tab);
  assert.equal(result.fallback, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0], tab.url);
  provider.dispose();
});

test('provider：URL 与位置都缺失且缓存无此条时抛 stale_tab', async () => {
  const provider = makeProvider({
    listTabs: async () => [{ hwnd: 5, index: 0, title: '临时页', url: null }],
    fillUrls: (tabs) => tabs,
  });
  await provider.init();
  await assert.rejects(
    () =>
      provider.activate({
        id: 'chrome:tab:已关闭的页面',
        source: 'tab',
        title: '已关闭的页面',
        url: null,
        hwnd: null,
        index: null,
      }),
    (error) => error.code === 'stale_tab',
  );
  provider.dispose();
});

test('provider：找不到 Chrome 时收藏夹激活报可操作错误', async () => {
  const provider = makeProvider({ findChrome: () => null });
  await provider.init();
  const bookmark = provider.search().find((item) => item.source === 'bookmark');
  await assert.rejects(() => provider.activate(bookmark), /未找到 Chrome/);
  provider.dispose();
});

test('provider：标签页列表为空时不报错', async () => {
  const provider = makeProvider({ listTabs: async () => [] });
  await provider.init();
  await provider.refresh();
  assert.equal(provider.stats().tabs, 0);
  provider.dispose();
});

test('provider：refresh 同时更新标签页和收藏夹', async () => {
  let round = 0;
  const provider = makeProvider({
    listTabs: async () => {
      round += 1;
      return round === 1
        ? [{ hwnd: 1, index: 0, title: '第一轮', url: 'http://a/', selected: true }]
        : [
            { hwnd: 1, index: 0, title: '第二轮', url: 'http://b/', selected: true },
            { hwnd: 1, index: 1, title: '第二轮-2', url: 'http://c/', selected: false },
          ];
    },
    fillUrls: (tabs) => tabs,
  });
  await provider.init();
  assert.equal(provider.stats().tabs, 1);
  await provider.refresh();
  assert.equal(provider.stats().tabs, 2);
  provider.dispose();
});
