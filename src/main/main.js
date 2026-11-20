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

  engine = createEngine({
    usageStore,
    limit: 9,
    providerTimeout: 1500, // 文件检索是内存里的扫描，1.5 秒足够兜住慢盘
  });
  engine.register(appProvider);
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
      items: result.items.map((item) => ({
        id: item.id,
        provider: item.provider,
        kind: item.kind,
        title: item.title,
        subtitle: item.subtitle,
        score: item.score,
        pinned: item.pinned,
      })),
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
