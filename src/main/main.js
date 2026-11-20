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
const { createWorkerScan } = require('./workerScan');
const { resolveHotkey, hotkeyCandidates } = require('./hotkey');

const WINDOW_WIDTH = 680;
const WINDOW_HEIGHT = 440;

/** 收集启动期错误，界面底部显示，别让失败静默。 */
const startupErrors = [];

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
let saveUsageTimer = null;
/** 最近一轮搜索的完整条目，key 是 id。activate 用。 */
let lastResults = new Map();

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
            await Promise.all(Object.values(dingtalkOAuth ?? {}).map((manager) => manager.login()));
            startupErrors.push('钉钉：授权完成');
          } catch (error) {
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

  const usageStore = createUsageStore();
  usagePersist = attachPersistence(usageStore, userDataPath('usage.json'));
  usagePersist.loadFromDisk();

  fileProvider = createFileProvider({
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
    clipboard,
    limit: 15,
    interval: config.clipboardInterval,
    cache: createJsonCache(userDataPath('clipboard.json'), {
      onError: (message) => startupErrors.push(message),
    }),
    writeClipboard: async (text) => clipboard.writeText(text),
  });

  const appProvider = createAppProvider();

  projectProvider = createProjectProvider({
    // config.json 可选覆盖：projectRoots（数组）、ideaPath（字符串）
    roots: () =>
      Array.isArray(config.projectRoots) && config.projectRoots.length > 0
        ? config.projectRoots
        : defaultProjectRoots(),
    ideaPath: typeof config.ideaPath === 'string' ? config.ideaPath : undefined,
  });

  chromeProvider = createChromeProvider({
    // config.json 可选：chromePath（字符串）、tabRefreshInterval（毫秒，0 关闭轮询）
    chromePath: typeof config.chromePath === 'string' ? config.chromePath : undefined,
    refreshInterval:
      Number.isFinite(config.tabRefreshInterval) && config.tabRefreshInterval >= 0
        ? config.tabRefreshInterval
        : undefined,
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
      onNotice: (message) => startupErrors.push(`钉钉：${message}`),
    }),
    docs: createOAuthManager({
      mcpUrl: dingtalkUrls.docs,
      store: tokenCache('doc'),
      openBrowser,
      onNotice: (message) => startupErrors.push(`钉钉：${message}`),
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

function collectStatus() {
  const stats = fileProvider?.stats?.() ?? {};
  return {
    hotkey: registeredHotkey,
    errors: startupErrors.slice(),
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
  };
}

function registerIpc() {
  ipcMain.handle('launcher:search', async (_event, input) => {
    if (!engine) return { items: [], errors: [] };
    const result = await engine.search(typeof input === 'string' ? input : '');
    if (result.stale) return { items: [], errors: [], stale: true };

    // 完整条目留在主进程，界面只拿渲染需要的字段。
    // activate 时按 id 取回完整对象——渲染进程不该能把任意数据当"可执行项"塞进来。
    lastResults = new Map();
    for (const item of result.items) lastResults.set(item.id, item);

    return {
      items: result.items.map((item) => {
        // 头像：本地缓存命中就同步带上 data URL（几 KB），没命中先留空，
        // 由 launcher:avatar 异步补，不拖慢按键。
        const avatar = avatarStore?.dataUrl(item.avatarId) ?? null;
        return {
          id: item.id,
          provider: item.provider,
          kind: item.kind,
          title: item.title,
          subtitle: item.subtitle,
          initials: item.initials,
          avatar,
          // 有 avatarId 但图还没到，界面才会去要；远端联系人没有这个字段。
          avatarPending: Boolean(item.avatarId) && !avatar,
          score: item.score,
          pinned: item.pinned,
        };
      }),
      errors: result.errors,
      query: {
        providerHint: result.query.providerHint,
        keyword: result.query.keyword,
      },
    };
  });

  ipcMain.handle('launcher:activate', async (_event, payload) => {
    if (!engine || !payload?.id) return { ok: false, message: '无效条目' };
    const item = lastResults.get(payload.id);
    if (!item) return { ok: false, message: '结果已过期，请重新搜索' };
    const result = await engine.activate(item);
    if (result.ok) {
      hideWindow();
      scheduleUsageSave();
    }
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
      await Promise.all(Object.values(dingtalkOAuth ?? {}).map((manager) => manager.login()));
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
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

  win.webContents.once('did-finish-load', () => {
    sendStatus();
    showWindow();
  });

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
    win.webContents.once('did-finish-load', () => {
      run({ app, win, query: process.env.DSH_SMOKE_QUERY || 'code' })
        .catch((error) => console.error('[smoke] 失败:', error))
        .finally(() => quitApp());
    });
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
