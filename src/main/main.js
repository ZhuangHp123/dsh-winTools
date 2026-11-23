'use strict';

/**
 * 主进程。
 *
 * 职责只有四件事：
 *   1. 窗口生命周期（热键唤起 / 失焦隐藏 / 托盘）
 *   2. 全局热键（候选链，见 hotkey.js）
 *   3. 把 engine + 三个 provider 接起来，处理渲染进程发来的 IPC
 *   4. 数据落盘（使用习惯、文件索引、剪贴板历史）
 *
 * 所有搜索逻辑都在 src/core 和 src/*Provider.js 里，是纯 Node 代码，
 * 可以直接 `node --test` 跑。这个文件不做业务判断。
 */

const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, screen, shell, clipboard, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');

const { createEngine } = require('../core/engine');
const { createUsageStore, attachPersistence } = require('../core/usage');
const {
  DEFAULT_PREFIXES,
  SCOPE_LABEL,
  resolvePrefixes,
  aliasesFor,
  scopeForWord,
  hintEntries,
  diffPrefixes,
  WEB_SCOPES,
} = require('../core/prefixes');
const { readConfigFile, writeConfigFile } = require('./configFile');
const { createAppProvider } = require('../apps/appProvider');
const { createFileProvider, scanRoots, defaultRoots } = require('../files/fileProvider');
const { createClipboardProvider } = require('../clipboard/clipboardProvider');
const { createProjectProvider, defaultProjectRoots } = require('../projects/projectProvider');
const { createChromeProvider } = require('../web/chromeProvider');
const { createContactProvider, createDocumentProvider } = require('../dingtalk/dingtalkProvider');
const { createChatOpener, createCidOpener } = require('../dingtalk/openChat');
const { findDataDir, loadLocalContacts, cidFor } = require('../dingtalk/localIndex');
const { createAvatarStore } = require('../dingtalk/avatars');
const { createOAuthManager } = require('../dingtalk/oauth');

/**
 * 钉钉 MCP 网关的端点。使用 OAuth 的回环流程，
 * 因此这里只需要端点本身，不需要用户在配置里贴 token。
 *
 * 只接联系人和文档：网关上的 group 端点只有建群工具、没有群聊检索，
 * 所以不做群聊搜索。
 */
const DINGTALK_MCP_ENDPOINTS = {
  contacts: 'https://mcp-gw.dingtalk.com/oauth/server/contact',
  docs: 'https://mcp-gw.dingtalk.com/oauth/server/doc',
};

/** 每个 MCP 端点一个 token（作用域独立），所以每个端点一个管理器。 */
let dingtalkOAuth = null;

const { createJsonCache } = require('./persistence');
const { iconDataUrl, prefetchIcons } = require('./icons');
const { createWorkerScan } = require('./workerScan');
const { resolveHotkey, hotkeyCandidates } = require('./hotkey');

/**
 * 哪些 kind 从左边的实体文件抽图标。
 * 联系人/文档/剪贴板没有磁盘实体，走各自的内联样式或头像。
 */
const ICON_KINDS = new Set(['app', 'project', 'file']);

const CONTENT_WIDTH = 680;
const CONTENT_HEIGHT = 440;
/** 窗口比内容多留的一圈透明边距，给卡片投影留出淡出的空间。 */
const SHADOW_PAD = 36;
const WINDOW_WIDTH = CONTENT_WIDTH + SHADOW_PAD * 2;
const WINDOW_HEIGHT = CONTENT_HEIGHT + SHADOW_PAD * 2;
/** 空状态只留搜索框时的高度下限（内容高度，不含边距）。渲染进程量出实际行高后会下发精确值。 */
const MIN_CONTENT_HEIGHT = 40;

/** 收集启动期错误，界面底部显示，别让失败静默。 */
const startupErrors = [];

/**
 * 钉钉登录期间的临时提示（"请在浏览器里完成授权…"）。
 * 它是一次性状态而不是错误：登录一结束就该消失，不能像 startupErrors 那样常驻。
 */
let dingtalkNotice = '';

function setDingtalkNotice(message) {
  dingtalkNotice = message ? `钉钉：${message}` : '';
}

let win = null;
let tray = null;
let engine = null;
let fileProvider = null;
let clipboardProvider = null;
let projectProvider = null;
let chromeProvider = null;
let contactProvider = null;
let documentProvider = null;
let avatarStore = null;
let usagePersist = null;
let registeredHotkey = null;
let isQuitting = false;
let mouseIgnored = false;
let pageReady = null;
/** 生效中的前缀表：渲染层画提示和徽标要用。 */
let prefixTable = null;
/** 上一次保存前缀算出的冲突，状态栏会带着显示。 */
let prefixConflicts = [];
let saveUsageTimer = null;
/** 最近一轮搜索的完整条目，key 是 id。activate 用。 */
let lastResults = new Map();

// 冒烟跑在固定名字的独立 userData 下：真实启动器可能正开着，共用目录会被单实例锁直接踢掉；
// 顺带也不会把冒烟写出来的剪贴板/用量记录塞进用户的真实数据。
// 不要每次清空——钉钉 token 存在这里，删了冒烟就会卡在等授权那一步。
if (process.env.DSH_SMOKE === '1') {
  app.setPath('userData', path.join(app.getPath('temp'), 'dsh-smoke'));
}

/** 单实例：第二次启动直接把已有窗口叫出来，不要开两个托盘图标。 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function userDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

/**
 * 读配置。配置文件不存在时返回 null（走默认值），坏文件也一样——
 * 配置文件写坏了不该让启动器起不来。
 */
function loadConfig() {
  const file = userDataPath('config.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch (error) {
    if (error?.code !== 'ENOENT') startupErrors.push(`配置文件读取失败：${error.message}`);
    return null;
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, '../../assets/icon.png');
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // 页面可能在 await engine.initAll() 期间就加载完，之后再挂 did-finish-load 会永远不触发，
  // 窗口就一直不显示。所以一开始就把完成信号存成 promise。
  pageReady = new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => resolve());
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // 失焦即隐藏，这是启动器该有的手感。
  // 但 DevTools 打开时（开发期）或冒烟测试时不要隐藏，否则没法调/没法截图。
  win.on('blur', () => {
    if (process.env.DSH_SMOKE === '1') return;
    if (win.webContents.isDevToolsOpened()) return;
    hideWindow();
  });

  // 关闭按钮等同隐藏，只有托盘"退出"才真的退。
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideWindow();
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
}

function positionWindow() {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2);
  const y = Math.round(workArea.y + workArea.height * 0.22);
  win.setPosition(x, y);
}

function showWindow() {
  if (!win) return;
  positionWindow();
  win.show();
  win.focus();
  win.webContents.send('launcher:shown');
  // 标签页变化频繁，唤起时顺手刷一轮，避免搜到过期标题。
  chromeProvider?.refresh?.().catch(() => {});
}

/**
 * 重新显示但不重置界面。执行失败时用：此时用户还停在原来的搜索结果上，
 * 清空输入（launcher:shown 的行为）等于让他重搜一遍。
 */
function resurfaceWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function hideWindow() {
  if (!win || !win.isVisible()) return;
  win.hide();
  flushUsage();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) hideWindow();
  else showWindow();
}

function createTray() {
  const candidates = ['tray-64.png', 'tray.png'];
  let image = nativeImage.createEmpty();
  for (const name of candidates) {
    const p = path.join(__dirname, '../../assets', name);
    if (fs.existsSync(p)) {
      image = nativeImage.createFromPath(p);
      break;
    }
  }
  try {
    tray = new Tray(image);
  } catch (error) {
    startupErrors.push(`托盘图标创建失败：${error.message}`);
    return;
  }
  tray.setToolTip(`dsh-winTools（${registeredHotkey ?? '无热键'}）`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示搜索', click: () => showWindow() },
      { label: '重新索引文件', click: () => reindexFiles() },
      {
        label: '登录钉钉（联系人/文档）',
        click: async () => {
          try {
            // 已有可用 token 的端点直接跳过：不然每点一次都要在浏览器里重新同意一遍。
            const managers = Object.values(dingtalkOAuth ?? {});
            const pending = [];
            for (const manager of managers) {
              const token = await manager.currentToken().catch(() => null);
              if (!token) pending.push(manager);
            }
            if (pending.length === 0) {
              setDingtalkNotice('已登录，无需重新授权');
            } else {
              setDingtalkNotice('请在浏览器里完成钉钉授权…');
              // 串行而不是并发：每个端点一个回调端口，同时开会连开多个授权页，
              // 用户不知道先点哪个。
              for (const manager of pending) await manager.login();
              setDingtalkNotice('');
            }
          } catch (error) {
            setDingtalkNotice('');
            startupErrors.push(`钉钉登录失败：${error?.message ?? error}`);
          }
          sendStatus();
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() },
    ]),
  );
  tray.on('click', () => showWindow());
}

/**
 * 注册热键。全被占用时保留托盘可用，并把情况告诉界面——
 * 用户至少知道"热键没生效"以及可选哪些键。
 */
function registerHotkey(config) {
  const candidates = hotkeyCandidates(config);
  const preferred = candidates[0];
  registeredHotkey = resolveHotkey(candidates, (accelerator) =>
    globalShortcut.register(accelerator, toggleWindow),
  );
  if (!registeredHotkey) {
    startupErrors.push(`热键全部被占用（${candidates.join(' / ')}），只能通过托盘打开`);
  } else if (registeredHotkey !== preferred) {
    startupErrors.push(`${preferred} 被占用，已改用 ${registeredHotkey}`);
  }
  return registeredHotkey;
}

function buildProviders() {
  const config = loadConfig() ?? {};

  // 前缀（锁定范围的首词）允许在 config.json 里改，也能在设置页里改。
  const { prefixes, conflicts } = resolvePrefixes(config.prefixes);
  for (const conflict of conflicts) {
    startupErrors.push(`前缀「${conflict.word}」同时给了「${conflict.kept}」和「${conflict.dropped}」，已按前者生效`);
  }
  prefixTable = prefixes;
  // 每次判定都读全局 prefixTable：设置页保存后热更新，不需要重建 provider。
  const chromeScope = (alias) => {
    const scope = scopeForWord(prefixTable, alias);
    return WEB_SCOPES.includes(scope) ? scope : null;
  };
  prefixConflicts = conflicts;

  const usageStore = createUsageStore();
  usagePersist = attachPersistence(usageStore, userDataPath('usage.json'));
  usagePersist.loadFromDisk();

  fileProvider = createFileProvider({
    aliases: () => aliasesFor(prefixTable, ['file']),
    roots: () => defaultRoots(),
    limit: 60,
    cache: createJsonCache(userDataPath('cache', 'file-index.json'), {
      onError: (message) => startupErrors.push(message),
    }),
    scan: createWorkerScan({
      Worker,
      fallback: (options) => scanRoots(options),
    }),
  });

  clipboardProvider = createClipboardProvider({
    aliases: () => aliasesFor(prefixTable, ['clipboard']),
    clipboard,
    limit: 15,
    interval: config.clipboardInterval,
    cache: createJsonCache(userDataPath('clipboard.json'), {
      onError: (message) => startupErrors.push(message),
    }),
    writeClipboard: async (text) => clipboard.writeText(text),
  });

  const appProvider = createAppProvider({ aliases: () => aliasesFor(prefixTable, ['app']) });

  projectProvider = createProjectProvider({
    aliases: () => aliasesFor(prefixTable, ['project']),
    // config.json 可选覆盖：projectRoots（数组）、ideaPath / cursorPath / vscodePath（字符串）
    roots: () =>
      Array.isArray(config.projectRoots) && config.projectRoots.length > 0
        ? config.projectRoots
        : defaultProjectRoots(),
    ideaPath: typeof config.ideaPath === 'string' ? config.ideaPath : undefined,
    cursorPath: typeof config.cursorPath === 'string' ? config.cursorPath : undefined,
    vscodePath: typeof config.vscodePath === 'string' ? config.vscodePath : undefined,
  });

  chromeProvider = createChromeProvider({
    aliases: () => aliasesFor(prefixTable, WEB_SCOPES),
    scopeOf: chromeScope,
    // config.json 可选：chromePath（字符串）、tabRefreshInterval（毫秒，0 关闭轮询）
    chromePath: typeof config.chromePath === 'string' ? config.chromePath : undefined,
    refreshInterval:
      Number.isFinite(config.tabRefreshInterval) && config.tabRefreshInterval >= 0
        ? config.tabRefreshInterval
        : undefined,
    // 切标签页的 P/Invoke 类编译一次缓存成 DLL，避免每次回车都在 PowerShell
    // 里现场编译（pwsh 7 上要 450ms）。
    win32AssemblyPath: userDataPath('cache', 'win32fg.dll'),
  });

  // 钉钉：走官方 MCP 网关的 OAuth 流程；config.dingtalk.*Url 可覆盖端点。
  const dingtalkConfig = config.dingtalk && typeof config.dingtalk === 'object' ? config.dingtalk : {};
  const dingtalkUrls = {
    contacts:
      typeof dingtalkConfig.contactsUrl === 'string' ? dingtalkConfig.contactsUrl : DINGTALK_MCP_ENDPOINTS.contacts,
    docs: typeof dingtalkConfig.docsUrl === 'string' ? dingtalkConfig.docsUrl : DINGTALK_MCP_ENDPOINTS.docs,
  };
  const openDeepLink = async (uri) => {
    // deep link 不是 http，必须走 openExternal；失败会 reject，由 provider 兜。
    await shell.openExternal(uri);
  };
  const openBrowser = async (uri) => {
    await shell.openExternal(uri);
  };
  const tokenCache = (name) =>
    createJsonCache(userDataPath('cache', `dingtalk-${name}-token.json`), {
      onError: (message) => startupErrors.push(message),
    });

  dingtalkOAuth = {
    contacts: createOAuthManager({
      mcpUrl: dingtalkUrls.contacts,
      store: tokenCache('contact'),
      openBrowser,
      onNotice: (message) => {
        setDingtalkNotice(message);
        sendStatus();
      },
    }),
    docs: createOAuthManager({
      mcpUrl: dingtalkUrls.docs,
      store: tokenCache('doc'),
      openBrowser,
      onNotice: (message) => {
        setDingtalkNotice(message);
        sendStatus();
      },
    }),
  };

  // 头像：客户端缓存的缩略图直接读，缺的从 CDN 后台补。
  // 目录扫描只 stat 两百来个文件，同步做不影响启动。
  const avatarDataDir = findDataDir();
  avatarStore = createAvatarStore({
    avatarDirs: avatarDataDir ? [path.join(avatarDataDir, 'AvatarFiles')] : [],
    cacheDir: userDataPath('cache', 'dingtalk-avatars'),
  });

  // 本地库解密是同步 IO（70MB 的库要几百毫秒），放进 setImmediate 里跑，
  // 免得卡住窗口首帧。
  let localContacts;
  let localPending = null;
  const loadLocal = () => {
    if (localContacts) return localContacts;
    if (!localPending) {
      localPending = new Promise((resolve) => {
        setImmediate(() => {
          try {
            const dataDir = findDataDir();
            localContacts = dataDir ? loadLocalContacts(dataDir) : null;
          } catch {
            localContacts = null;
          }
          resolve(localContacts);
        });
      });
      // 本地库一读完就把头像预热到磁盘：用户第一次搜人时图大多已经在本地，
      // 不用现场等网络。只在后台跑，失败无所谓。
      localPending
        .then((local) => {
          const ids = (local?.people ?? []).map((person) => person.avatarId);
          avatarStore?.prefetch(ids).catch(() => {});
        })
        .catch(() => {});
    }
    return localPending;
  };

  const openByUid = createCidOpener();
  const openCid = async (uid) => {
    const local = await loadLocal();
    if (!local?.selfUid) return { ok: false, message: '读不到钉钉本地账号信息，无法直接定位会话' };
    return openByUid(cidFor(local.selfUid, uid));
  };

  contactProvider = createContactProvider({
    aliases: () => aliasesFor(prefixTable, ['contact']),
    mcpUrl: dingtalkUrls.contacts,
    oauth: dingtalkOAuth.contacts,
    // 冒烟测试里不弹 OAuth，只验证界面能画出缓存结果或空状态。
    allowRemote: process.env.DSH_SMOKE !== '1',
    cache: createJsonCache(userDataPath('cache', 'dingtalk-contacts.json'), {
      onError: (message) => startupErrors.push(message),
    }),
    loadLocal,
    openByUid: openCid,
    openChat: createChatOpener(),
  });

  documentProvider = createDocumentProvider({
    aliases: () => aliasesFor(prefixTable, ['doc']),
    mcpUrl: dingtalkUrls.docs,
    oauth: dingtalkOAuth.docs,
    allowRemote: process.env.DSH_SMOKE !== '1',
    cache: createJsonCache(userDataPath('cache', 'dingtalk-docs.json'), {
      onError: (message) => startupErrors.push(message),
    }),
    openExternal: openDeepLink,
  });

  engine = createEngine({
    usageStore,
    limit: 9,
    providerTimeout: 1500, // 文件检索是内存里的扫描，1.5 秒足够兜住慢盘
  });
  engine.register(appProvider);
  engine.register(projectProvider);
  engine.register(chromeProvider);
  engine.register(contactProvider);
  engine.register(documentProvider);
  engine.register(fileProvider);
  engine.register(clipboardProvider);
  return engine;
}

function flushUsage() {
  if (saveUsageTimer) {
    clearTimeout(saveUsageTimer);
    saveUsageTimer = null;
  }
  usagePersist?.saveToDisk();
}

function scheduleUsageSave() {
  if (saveUsageTimer) return;
  saveUsageTimer = setTimeout(() => {
    saveUsageTimer = null;
    usagePersist?.saveToDisk();
  }, 1000);
  if (typeof saveUsageTimer.unref === 'function') saveUsageTimer.unref();
}

async function reindexFiles() {
  if (!fileProvider) return { ok: false };
  await fileProvider.dispose();
  const result = await fileProvider.init();
  sendStatus();
  return { ok: true, ...result };
}

/** 把索引状态推给界面（索引中/已完成）。 */
function sendStatus() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('launcher:status', collectStatus());
}

/**
 * 启动后空闲时把常用条目的图标先抽好：应用和项目各抽一批，
 * 用户第一次搜索时列表不用等磁盘读图标。
 */
function prefetchListIcons() {
  setImmediate(() => {
    try {
      const apps = engine?.get('app')?.search?.() ?? [];
      const projects = projectProvider?.search?.() ?? [];
      prefetchIcons(apps.slice(0, 400).map((item) => item.path));
      prefetchIcons(projects.map((item) => item.iconFile));
    } catch {
      /* 预热失败无所谓，搜索时会现抽 */
    }
  });
}

function collectStatus() {
  const stats = fileProvider?.stats?.() ?? {};
  return {
    hotkey: registeredHotkey,
    // 临时提示排在错误前面显示，登录结束后自动清空。
    errors: [
      dingtalkNotice,
      ...startupErrors,
      ...prefixConflicts.map(
        (conflict) => `前缀「${conflict.word}」冲突：保留了「${conflict.kept}」`,
      ),
    ].filter(Boolean),
    indexing: Boolean(fileProvider?.isIndexing?.()),
    fileCount: stats.count ?? 0,
    clipboardCount: clipboardProvider?.stats?.().history ?? 0,
    appCount: engine?.get('app')?.stats?.()?.shortcutCount ?? 0,
    projectCount: projectProvider?.stats?.().count ?? 0,
    tabCount: chromeProvider?.stats?.().tabs ?? 0,
    bookmarkCount: chromeProvider?.stats?.().bookmarks ?? 0,
    contactCount: contactProvider?.stats?.().contacts ?? 0,
    dingtalkConfigured: Boolean(contactProvider?.stats?.().configured),
    docCount: documentProvider?.stats?.().documents ?? 0,
    docsConfigured: Boolean(documentProvider?.stats?.().configured),
    trayAvailable: Boolean(tray),
    userData: app.getPath('userData'),
    // 渲染层用：空状态提示的「a 应用 / f 文件 …」和锁定徽标都跟着实际配置走，
    // 用户在前缀里加了新词就能立刻看到，不需要界面各存一份。
    hint: prefixTable ? hintEntries(prefixTable) : [],
    aliasScope: prefixAliasScope(),
  };
}

/** alias（小写原词）→ scope，例如 a→app、b→bookmark。徽标按它取中文名。 */
function prefixAliasScope() {
  const map = {};
  if (!prefixTable) return map;
  for (const [scope, words] of Object.entries(prefixTable)) {
    for (const word of words) map[String(word).toLowerCase()] = scope;
  }
  return map;
}

function registerIpc() {
  // 窗口四周有一圈透明边，那片区域不该吃掉鼠标事件（点它会触发 blur 把窗口藏掉）。
  // 渲染进程按指针是否落在卡片上来切换。
  ipcMain.on('launcher:setIgnoreMouse', (_event, ignore) => {
    if (!win) return;
    mouseIgnored = Boolean(ignore);
    win.setIgnoreMouseEvents(mouseIgnored, { forward: true });
  });
  ipcMain.handle('launcher:setCompact', (_event, payload) => {
    if (!win) return { ok: false };
    const compact = Boolean(payload?.compact);
    // 渲染进程量出的内容行高优先；异常值夹在合理范围内，别把窗口缩没了。
    const measured = Math.round(Number(payload?.height));
    const content = compact
      ? Math.min(CONTENT_HEIGHT, Math.max(MIN_CONTENT_HEIGHT, measured || MIN_CONTENT_HEIGHT))
      : CONTENT_HEIGHT;
    const bounds = win.getBounds();
    win.setBounds(
      { x: bounds.x, y: bounds.y, width: WINDOW_WIDTH, height: content + SHADOW_PAD * 2 },
      false,
    );
    return { ok: true, height: content };
  });

  ipcMain.handle('launcher:search', async (_event, input) => {
    if (!engine) return { items: [], errors: [] };
    const result = await engine.search(typeof input === 'string' ? input : '');
    if (result.stale) return { items: [], errors: [], stale: true };

    // 完整条目留在主进程，界面只拿渲染需要的字段。
    // activate 时按 id 取回完整对象——渲染进程不该能把任意数据当"可执行项"塞进来。
    lastResults = new Map();
    for (const item of result.items) lastResults.set(item.id, item);

    // 图标：应用/项目/文件抽真实文件图标（进程内缓存，重复路径不重复抽）。
    // 首轮是磁盘 IO，但 9 条、每条几毫秒，值得等——否则列表会先糊一片占位再跳图。
    const items = await Promise.all(
      result.items.map(async (item) => {
        // 头像：本地缓存命中就同步带上 data URL（几 KB），没命中先留空，
        // 由 launcher:avatar 异步补，不拖慢按键。
        const avatar = avatarStore?.dataUrl(item.avatarId) ?? null;
        const iconFile = ICON_KINDS.has(item.kind) ? item.iconFile ?? item.path : null;
        const icon = iconFile ? await iconDataUrl(iconFile) : null;
        return {
          id: item.id,
          provider: item.provider,
          kind: item.kind,
          title: item.title,
          subtitle: item.subtitle,
          initials: item.initials,
          avatar,
          icon,
          // 网页条目要区分「已打开标签页」和「收藏夹」，列表前置图标不同。
          source: item.source ?? null,
          // 有 avatarId 但图还没到，界面才会去要；远端联系人没有这个字段。
          avatarPending: Boolean(item.avatarId) && !avatar,
          score: item.score,
          pinned: item.pinned,
        };
      }),
    );

    return {
      items,
      errors: result.errors,
      query: {
        providerHint: result.query.providerHint,
        alias: result.query.alias ?? null,
        keyword: result.query.keyword,
      },
    };
  });

  ipcMain.handle('launcher:activate', async (_event, payload) => {
    if (!engine || !payload?.id) return { ok: false, message: '无效条目' };
    const item = lastResults.get(payload.id);
    if (!item) return { ok: false, message: '结果已过期，请重新搜索' };
    // 先收起窗口再执行：切标签页要起 PowerShell，几百毫秒到一秒；
    // 等它跑完再隐藏，用户会觉得"按了回车没反应"。失败时再把界面叫回来显示错误。
    const wasVisible = Boolean(win?.isVisible());
    hideWindow();
    const result = await engine.activate(item);
    if (result.ok) {
      scheduleUsageSave();
      return result;
    }
    if (wasVisible) resurfaceWindow();
    return result;
  });

  // 头像异步补图：搜索先返回文字，缺图的再单独要。
  // 只有主进程存的 avatarId 算数，渲染进程传什么 id 都不会被当成路径用。
  ipcMain.handle('launcher:avatar', async (_event, id) => {
    const item = lastResults.get(id);
    const mediaId = item?.avatarId;
    if (!mediaId || !avatarStore) return { avatar: null };
    await avatarStore.ensure(mediaId);
    return { avatar: avatarStore.dataUrl(mediaId) };
  });

  ipcMain.handle('launcher:status', async () => collectStatus());
  ipcMain.handle('launcher:hide', async () => {
    hideWindow();
    return { ok: true };
  });
  ipcMain.handle('launcher:reindex', async () => reindexFiles());
  ipcMain.handle('launcher:openExternal', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.handle('launcher:dingtalkLogin', async () => {
    try {
      // 同托盘菜单：已有 token 的端点不重复授权，剩下的一个一个来。
      const managers = Object.values(dingtalkOAuth ?? {});
      const pending = [];
      for (const manager of managers) {
        const token = await manager.currentToken().catch(() => null);
        if (!token) pending.push(manager);
      }
      for (const manager of pending) await manager.login();
      return { ok: true, alreadyLoggedIn: pending.length === 0 };
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
  });

  // 设置页：读取当前生效的前缀 + 每个范围的默认值，供界面「恢复默认」用。
  ipcMain.handle('launcher:getPrefixes', async () => ({
    ok: true,
    prefixes: prefixTable ?? resolvePrefixes().prefixes,
    defaults: DEFAULT_PREFIXES,
    labels: SCOPE_LABEL,
  }));

  /**
   * 保存前缀。
   * 界面传来的是整套前缀；这里先校验、算冲突，再只把「与默认不同」的部分
   * 写回 config.json（不覆盖用户手写的其他字段），最后热更新内存里的表。
   */
  ipcMain.handle('launcher:savePrefixes', async (_event, payload) => {
    const overrides = payload?.prefixes;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return { ok: false, message: '前缀格式不正确' };
    }

    // 先做静态校验：每一项都该是非空字符串数组，坏数据不落盘。
    for (const scope of Object.keys(DEFAULT_PREFIXES)) {
      const list = overrides[scope];
      if (list == null) continue;
      if (!Array.isArray(list)) return { ok: false, message: `「${SCOPE_LABEL[scope]}」必须是字符串数组` };
      if (!list.every((entry) => typeof entry === 'string' && entry.trim())) {
        return { ok: false, message: `「${SCOPE_LABEL[scope]}」里有空项或非字符串` };
      }
    }

    const { prefixes, conflicts } = resolvePrefixes(overrides);

    const filePath = userDataPath('config.json');
    const existing = readConfigFile(filePath);
    if (!existing.ok) {
      // 配置文件坏了就拒绝写，避免把用户手写的内容抹成只剩 prefixes。
      return { ok: false, message: `现有 config.json 无法解析，未保存：${existing.message}` };
    }
    const nextConfig = { ...existing.data };
    const diff = diffPrefixes(prefixes);
    if (Object.keys(diff).length > 0) nextConfig.prefixes = diff;
    else delete nextConfig.prefixes;

    const written = writeConfigFile(filePath, nextConfig);
    if (!written.ok) return { ok: false, message: `写入 config.json 失败：${written.message}` };

    // 热更新：别名是 getter、Chrome 范围判定也读全局表，下一轮搜索就生效。
    prefixTable = prefixes;
    prefixConflicts = conflicts;
    sendStatus();
    return {
      ok: true,
      prefixes,
      conflicts,
      // 提示界面：真正落盘的只有这几项（其余沿用默认）。
      saved: diff,
    };
  });
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

app.whenReady().then(async () => {
  registerIpc();
  buildProviders();
  createWindow();

  const config = loadConfig();
  registerHotkey(config);
  createTray();

  // 已存的 OAuth token 先读出来；没有也不阻塞启动，等真正搜钉钉时再走登录。
  for (const manager of Object.values(dingtalkOAuth ?? {})) {
    await manager.load().catch(() => {});
  }

  // provider 初始化不阻塞窗口显示：先把空壳亮出来，索引在后台长。
  const initErrors = await engine.initAll();
  for (const error of initErrors) startupErrors.push(`${error.provider} 初始化失败：${error.message}`);
  prefetchListIcons();

  await pageReady;
  sendStatus();
  // 冒烟自己会 show() 并驱动界面；这里再走一遍 showWindow 会多发一次
  // launcher:shown，把冒烟刚输入的查询清掉（两者是竞态）。
  if (process.env.DSH_SMOKE !== '1') showWindow();

  // 索引构建期间定期推状态，让底部能显示"索引中… 3.8 万"而不是干等。
  const statusTimer = setInterval(() => {
    if (!fileProvider?.isIndexing?.()) {
      clearInterval(statusTimer);
      sendStatus();
      return;
    }
    sendStatus();
  }, 3000);
  if (typeof statusTimer.unref === 'function') statusTimer.unref();

  // 索引构建完成后通知界面刷新底部状态。
  fileProvider?.whenScanDone?.().then(() => {
    clearInterval(statusTimer);
    sendStatus();
  });

  if (process.env.DSH_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });

  if (process.env.DSH_SMOKE === '1') {
    const { run } = require('./smoke');
    pageReady
      .then(() => run({ app, win, query: process.env.DSH_SMOKE_QUERY || 'code' }))
      .catch((error) => console.error('[smoke] 失败:', error))
      .finally(() => quitApp());
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  flushUsage();
  engine?.disposeAll?.();
});

app.on('window-all-closed', () => {
  // 托盘常驻，不在这里退出。真正退出走 quitApp。
});

process.on('uncaughtException', (error) => {
  startupErrors.push(`未捕获异常：${error?.message ?? error}`);
  // 启动器不能因为单个 provider 的异步错误整个挂掉。
});

process.on('unhandledRejection', (reason) => {
  startupErrors.push(`未处理的 Promise 拒绝：${String(reason?.message ?? reason)}`);
});
