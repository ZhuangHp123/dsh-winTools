'use strict';

/**
 * Chrome provider：搜索已打开的标签页 + 收藏夹。
 *
 * 两类数据来源完全不同，因此分成两条链路：
 *
 *   1. 已打开的标签页 —— 只能走 Windows UI Automation。
 *      Chrome 没开远程调试端口时，进程外部拿不到标签页的 URL；UIA 能读到
 *      标签页标题，活动标签页还能从 Document 节点读到完整 URL。
 *      后台标签页只有标题，因此再用 Chrome 历史库按标题补 URL。
 *
 *   2. 收藏夹 —— 直接解析 User Data\<profile>\Bookmarks（JSON）。
 *
 * 执行：
 *   - 已打开标签页：在前台 Chrome 窗口里切到该标签页（UIA SelectionItem）。
 *   - 收藏夹：chrome.exe <url> 新开标签页。
 *
 * 所有外部依赖（UIA 脚本、sqlite、spawn）都可注入，纯逻辑部分全部可单测。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** UIA 单次枚举的默认超时：PowerShell 冷启动就要 ~1s。 */
const UIA_TIMEOUT = 8000;

/** 历史库补 URL 时扫描的最近记录条数。 */
const HISTORY_LOOKUP_LIMIT = 8000;

/** 标签页标题里 Chrome 附加的内存用量后缀，如 " - 内存用量 - 165 MB"。 */
const MEMORY_SUFFIX = /\s*-\s*内存用量(?:高|低)?\s*-\s*[\d.,]+\s*(?:MB|GB|KB)\s*$/i;

/**
 * 去掉标题里的内存用量后缀。UIA 给的是窗口标题形态，
 * 历史库里存的是页面标题，对不上就没法补 URL。
 * @param {string} title
 */
function cleanTabTitle(title) {
  return String(title ?? '').replace(MEMORY_SUFFIX, '').trim();
}

/** Chrome 会在标题里塞不可见的 Unicode 变体选择符，去掉才能和搜索结果对上。 */
function stripInvisible(text) {
  return String(text ?? '').replace(/[\u200B-\u200F\u2060-\u2064\uFEFF]/g, '');
}

/**
 * 把 Chrome 的 URL 变成可读的站点名，用于副标题和检索词。
 * @param {string} url
 */
function siteName(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return String(url ?? '');
  }
}

/**
 * 用户数据目录。多个人（Default / Profile 1 / …）时全部返回。
 * @param {object} [env]
 * @returns {string[]}
 */
function chromeUserDataDirs(env = process.env) {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return [];
  return [path.join(localAppData, 'Google', 'Chrome', 'User Data')];
}

/**
 * 列出所有 profile 目录（含 Default）。只认带 Bookmarks 或 Preferences 的目录，
 * 避免把 "Crashpad" 之类的子目录当成 profile。
 * @param {string} userDataDir
 * @param {(dir:string)=>string[]} [listDirs]
 * @param {(p:string)=>boolean} [exists]
 * @returns {string[]}
 */
function listProfiles(userDataDir, listDirs = defaultListDirs, exists = defaultExists) {
  const names = ['Default', ...listDirs(userDataDir).filter((n) => /^Profile \d+$/.test(n))];
  return names
    .map((name) => path.join(userDataDir, name))
    .filter(
      (dir) =>
        exists(path.join(dir, 'Bookmarks')) ||
        exists(path.join(dir, 'Preferences')) ||
        exists(dir),
    );
}

/**
 * 找 chrome.exe。
 * @param {object} [env]
 * @param {(dir:string)=>string[]} [listDirs]
 * @returns {string[]}
 */
function chromeExecutableCandidates(env = process.env) {
  const list = [];
  if (env.DSH_CHROME) list.push(env.DSH_CHROME);
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
    if (!base) continue;
    list.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  // Chrome 是通过用户级安装时还可能落在 LOCALAPPDATA\Google\Chrome\Application
  if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return [...new Set(list)];
}

/**
 * @param {object} [options]
 * @returns {string|null}
 */
function findChromeExecutable(options = {}) {
  const exists = options.exists ?? defaultExists;
  if (options.chromePath && exists(options.chromePath)) return options.chromePath;
  return chromeExecutableCandidates(options.env ?? process.env).find((p) => exists(p)) ?? null;
}

/**
 * 递归展开收藏夹树。
 *
 * 收藏夹里文件夹是可以无限嵌套的，标题只用书签名；文件夹名与父级目录名
 * 进 tags，这样搜 "工作" 也能把这层文件夹下的书签找出来。
 *
 * @param {object} node
 * @param {string[]} [ancestors] 上级文件夹名
 * @returns {Array<{name:string, url:string, folderTags:string[]}>}
 */
function flattenBookmarks(node, ancestors = []) {
  const out = [];
  if (!node || typeof node !== 'object') return out;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    if (child.type === 'url' && typeof child.url === 'string' && child.url) {
      out.push({
        name: String(child.name ?? child.url),
        url: child.url,
        folderTags: ancestors.slice(),
      });
    } else if (child.type === 'folder') {
      out.push(...flattenBookmarks(child, [...ancestors, String(child.name ?? '')].filter(Boolean)));
    }
  }
  return out;
}

/**
 * 解析 Bookmarks JSON。
 * @param {string|object} input JSON 文本或已解析对象
 * @returns {Array<{name:string, url:string, folderTags:string[]}>}
 */
function parseBookmarks(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (!data || typeof data !== 'object' || !data.roots) return [];
  const out = [];
  const roots = data.roots;
  // bookmark_bar 的父级名不必进 tags（人人都知道那是书签栏），other / synced 有意义。
  if (roots.bookmark_bar) out.push(...flattenBookmarks(roots.bookmark_bar));
  if (roots.other) out.push(...flattenBookmarks(roots.other, ['其他书签']));
  if (roots.synced) out.push(...flattenBookmarks(roots.synced, ['移动设备书签']));
  return out;
}

/**
 * 读所有 profile 的收藏夹并转成候选。
 * @param {object} [options]
 * @returns {{candidates:Array<object>, errors:string[]}}
 */
function loadBookmarks(options = {}) {
  const userDataDirs = options.userDataDirs ?? chromeUserDataDirs(options.env);
  const readFile = options.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const listDirs = options.listDirs ?? defaultListDirs;

  const candidates = [];
  const errors = [];
  const exists = options.exists ?? defaultExists;
  for (const userDataDir of userDataDirs) {
    for (const profileDir of listProfiles(userDataDir, listDirs, exists)) {
      const file = path.join(profileDir, 'Bookmarks');
      let text;
      try {
        text = readFile(file);
      } catch (error) {
        if (error?.code !== 'ENOENT') errors.push(`读取收藏夹失败 ${file}: ${error.message}`);
        continue;
      }
      for (const bookmark of parseBookmarks(text)) {
        candidates.push(bookmarkToCandidate(bookmark));
      }
    }
  }
  return { candidates, errors };
}

/**
 * URL 的备选检索串：域名、去掉协议与查询串的路径。
 * 标题往往不含站点名（"任务调度中心"），但用户会按域名搜（"xxl-job"、
 * "dingtalk"）。这些串作为 altTitles 参与主匹配，才能在标题不含这些词时命中。
 * @param {string} url
 * @returns {string[]}
 */
function urlSearchTerms(url) {
  if (!url) return [];
  const terms = [];
  try {
    const parsed = new URL(url);
    if (parsed.hostname) terms.push(parsed.hostname);
    // 路径拆成段，除了过短/纯数字的（如 "/i/nodes/123" 里的 id 段）
    for (const segment of parsed.pathname.split('/')) {
      if (segment.length >= 3 && !/^\d+$/.test(segment)) terms.push(segment);
    }
  } catch {
    /* 非法 URL 就只用原串 */
  }
  terms.push(String(url));
  return [...new Set(terms)];
}

/**
 * 收藏夹项 → 候选。
 * @param {{name:string, url:string, folderTags?:string[]}} bookmark
 * @returns {object}
 */
function bookmarkToCandidate(bookmark) {
  const host = siteName(bookmark.url);
  const tags = [...(bookmark.folderTags ?? [])];
  if (host && host !== bookmark.name) tags.push(host);
  // 没标题的书签（Chrome 里显示为裸 URL 那种）用域名当标题，比整条 URL 好读。
  // 裸 URL 有两类：带 scheme 的，以及 Chrome 里常见的无 scheme 形态
  // （"host:port/path#..."，用户存页面时 Chrome 会把域名当名字）。
  const rawName = String(bookmark.name ?? '').trim();
  const isBareUrl =
    !rawName ||
    /^(https?|file):\/\//i.test(rawName) ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(rawName);
  const title = isBareUrl ? host || bookmark.url : rawName;
  return {
    id: `chrome:bookmark:${bookmark.url}`,
    kind: 'web',
    title,
    subtitle: `${host}  ·  收藏夹`,
    tags,
    altTitles: urlSearchTerms(bookmark.url),
    url: bookmark.url,
    source: 'bookmark',
  };
}

/**
 * 已打开标签页 → 候选。
 * @param {{title:string, url?:string|null, windowId?:number, index?:number}} tab
 * @returns {object|null}
 */
function tabToCandidate(tab) {
  const title = cleanTabTitle(stripInvisible(tab.title));
  if (!title) return null;
  const url = tab.url ?? null;
  const host = url ? siteName(url) : '';
  const tags = [];
  if (host) tags.push(host);
  // 标题常常不含域名（例如 "我的工作任务 | 工作包"），把 URL 的域名与路径段
  // 放到 altTitles，让搜 "cfmoto" / "xxl-job" 能命中。
  if (url) tags.push(url);

  return {
    id: `chrome:tab:${url ?? `${tab.hwnd ?? ''}#${tab.index ?? ''}:${title}`}`,
    kind: 'web',
    title,
    subtitle: host ? `${host}  ·  已打开` : '已打开标签页',
    tags,
    altTitles: urlSearchTerms(url),
    url,
    source: 'tab',
    hwnd: tab.hwnd ?? null,
    windowId: tab.windowId ?? null,
    index: Number.isInteger(tab.index) ? tab.index : null,
    windowTitle: tab.windowTitle ?? null,
  };
}

/**
 * UIA 枚举脚本。
 *
 * 输出 JSON 数组，每项一个标签页：
 *   { hwnd, pid, windowTitle, index, title, url, selected }
 * url 只有活动标签页才拿得到（从 Document 节点的 ValuePattern 读）。
 *
 * 用 [Console]::Out.Write 输出纯 JSON，避免 Write-Output 加换行或格式化。
 */
const UIA_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Win32Pid { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }
"@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Chrome_WidgetWin_1')
$tabCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$docCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
# 必须按 chrome.exe 的 PID 过滤：Qoder / Cursor 等 Electron 应用也用
# Chrome_WidgetWin_1 类名，对它们查无障碍树会无限期挂起。
$chromePids = @(Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
$out = New-Object System.Collections.ArrayList
if ($chromePids.Count -eq 0) { [Console]::Out.Write('[]'); exit 0 }
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)) {
  $hwnd = $w.Current.NativeWindowHandle
  if ($hwnd -eq 0) { continue }
  $winPid = [uint32]0
  [void][Win32Pid]::GetWindowThreadProcessId([IntPtr]$hwnd, [ref]$winPid)
  if ($chromePids -notcontains [int]$winPid) { continue }
  $tabs = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
  if ($tabs.Count -eq 0) { continue }
  $winTitle = $w.Current.Name
  # 活动标签页的 URL 只能从 Document 节点读，但窗口里还有隐藏的文档节点
  # （例如 chrome://newtab-footer/），所以要挑名字和标签页标题对得上的那个。
  $docs = @()
  foreach ($d in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $docCond)) {
    try {
      $v = $d.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($v -and $v.Current.Value -match '^https?://') { $docs += [pscustomobject]@{ name = $d.Current.Name; value = $v.Current.Value } }
    } catch { }
  }
  for ($i = 0; $i -lt $tabs.Count; $i++) {
    $t = $tabs.Item($i)
    $isSel = $false
    try { $isSel = $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch { }
    $activeUrl = $null
    if ($isSel -and $docs.Count -gt 0) {
      $tabName = [string]$t.Current.Name
      $best = $docs | Where-Object { $tabName.StartsWith($_.name) -or $_.name.StartsWith($tabName) } | Select-Object -First 1
      if (-not $best) { $best = $docs[0] }
      $activeUrl = $best.value
    }
    [void]$out.Add([pscustomobject]@{
      hwnd = [int64]$hwnd
      windowTitle = $winTitle
      index = $i
      title = $t.Current.Name
      url = $null
      activeUrl = $activeUrl
      selected = $isSel
    })
  }
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($out) -Depth 4 -Compress))
`;

/**
 * 调用 PowerShell 跑 UIA 脚本，返回标签页数组。
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
function listTabsViaUia(options = {}) {
  const runPowerShell = options.runPowerShell ?? defaultRunPowerShell;
  return runPowerShell(UIA_SCRIPT, options.timeout ?? UIA_TIMEOUT).then(
    (stdout) => parseUiaOutput(stdout),
    () => [],
  );
}

/**
 * UIA 脚本输出 → 标签页数组。空输出 / 单个对象 / 数组都兼容。
 * @param {string} stdout
 * @returns {Array<object>}
 */
function parseUiaOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : [data];
  return list.filter((tab) => tab && typeof tab.title === 'string');
}

/**
 * 用 Chrome 历史库按标题补 URL（只读、immutable）。
 *
 * 历史库被 Chrome 打开着，普通只读模式会报 database is locked；
 * immutable=1 告诉 SQLite "文件不会变"，跳过加锁。
 *
 * 注意 last_visit_time 是 int64，超出 JS 安全整数范围，必须按字符串读。
 *
 * @param {Array<object>} tabs UIA 枚举出来的标签页
 * @param {object} [options]
 * @returns {Array<object>} 补完 URL 的标签页（原地补充 url 字段）
 */
function fillUrlsFromHistory(tabs, options = {}) {
  const missing = tabs.filter((tab) => !tab.url);
  if (missing.length === 0) return tabs;
  const queryHistory = options.queryHistory ?? defaultQueryHistory;
  let rows = [];
  try {
    rows = queryHistory(options);
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows)) rows = [];
  // 标题完全相等优先；找不到再退到"历史标题是标签页标题的前缀"。
  const exact = new Map();
  const loose = new Map();
  for (const row of rows) {
    const title = stripInvisible(row.title ?? '').trim();
    if (!title || !row.url) continue;
    if (!exact.has(title)) exact.set(title, row.url);
    const clean = cleanTabTitle(title);
    if (clean && !loose.has(clean)) loose.set(clean, row.url);
  }

  for (const tab of missing) {
    const title = stripInvisible(tab.title ?? '').trim();
    const clean = cleanTabTitle(title);
    let url = exact.get(title) ?? loose.get(clean);
    if (!url) {
      // 标题可能被 Chrome 截断，用前缀找最长命中（最长的前缀重合最可信）。
      let bestKeyLength = 0;
      for (const [key, value] of loose) {
        if (!key || !clean) continue;
        if (!key.startsWith(clean) && !clean.startsWith(key)) continue;
        if (key.length > bestKeyLength) {
          bestKeyLength = key.length;
          url = value;
        }
      }
    }
    if (url) tab.url = url;
  }

  // 历史库里没有的（刚打开的新页面），活动标签页还能用 UIA 读到的 URL 兜底。
  for (const tab of tabs) {
    if (!tab.url && tab.activeUrl) tab.url = tab.activeUrl;
  }
  return tabs;
}

/** 默认历史查询实现（Electron / Node 24 都自带 node:sqlite）。 */
function defaultQueryHistory(options = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const userDataDirs = options.userDataDirs ?? chromeUserDataDirs(options.env);
  const limit = options.historyLimit ?? HISTORY_LOOKUP_LIMIT;
  const exists = options.exists ?? defaultExists;
  const rows = [];
  for (const userDataDir of userDataDirs) {
    for (const profileDir of listProfiles(userDataDir, options.listDirs ?? defaultListDirs, exists)) {
      const file = path.join(profileDir, 'History');
      if (!exists(file)) continue;
      const uri = `file:${file.split(path.sep).join('/')}?mode=ro&immutable=1`;
      let db;
      try {
        db = new DatabaseSync(uri);
        const statement = db.prepare(
          `SELECT title, url FROM urls WHERE title != '' ORDER BY last_visit_time DESC LIMIT ${Number(limit)}`,
        );
        for (const row of statement.all()) rows.push({ title: row.title, url: row.url });
      } catch {
        /* 历史库读不了就算了，不影响标签页列表 */
      } finally {
        try {
          db?.close();
        } catch {
          /* ignore */
        }
      }
    }
  }
  return rows;
}

/**
 * 默认 PowerShell 执行器。
 *
 * 默认优先 pwsh（7.x）：枚举标签页时它比 5.1 快不少（UIA 遍历是主要耗时）。
 * 但切成前台是"用户按了回车就等着"的路径，瓶颈在进程启动而非脚本本身，
 * 这时 5.1 反而更快，所以激活传 `preferWindowsPowerShell: true`。
 */
function defaultRunPowerShell(script, timeout, options = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const attempt = (exe) =>
    new Promise((resolve, reject) => {
      execFile(
        exe,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  const order = options.preferWindowsPowerShell ? ['powershell.exe', 'pwsh'] : ['pwsh', 'powershell.exe'];
  const tryNext = (i) =>
    attempt(order[i]).catch((error) => {
      // 只有"该 exe 不存在"才换下一个；脚本自身失败必须原样上报，
      // 否则会在另一个解释器里把同一个操作再执行一遍。
      if (error?.code === 'ENOENT' && i + 1 < order.length) return tryNext(i + 1);
      throw error;
    });
  return tryNext(0);
}

/**
 * 切换标签页脚本：UIA SelectionItem.Select() + 把窗口拉到前台。
 *
 * SetForegroundWindow 在跨进程时经常失败（Windows 的焦点窃取保护），
 * 因此用 AttachThreadInput 临时共享输入队列——这是 UIA 自动化的标准做法。
 *
 * 还原窗口只能用 SW_RESTORE（9），但它对最大化窗口的语义是"变回普通尺寸"，
 * 用户最大化使用 Chrome 时一切标签页窗口就缩回去了。所以先看是否最小化：
 * 只有最小化才需要 SW_RESTORE。
 *
 * 跨窗口激活时 Chrome 可能把目标窗口的 WS_VISIBLE 清掉（表现为"窗口没了"，
 * 但 HWND 和标签页都还在），因此激活前后各用一次 SW_SHOWNA（8）——
 * 它只置可见位，不改尺寸、不改最大化状态、也不抢激活。
 *
 * 成功条件必须是"窗口可见 + 已在前台 + 目标标签页已选中"。只看 IsSelected
 * 会骗过调用方：窗口其实没显示出来，启动器却以为自己切成功然后隐藏了。
 */
/**
 * 切窗口要用的 Win32 P/Invoke 声明。
 * 单独抽成常量是为了能编译一次、缓存成 DLL 复用：PowerShell 7 上每次
 * Add-Type 现场编译要 450ms，而加载已有 DLL 只要 ~100ms。
 */
const FG_NATIVE_SOURCE = `
using System; using System.Runtime.InteropServices;
public class Win32Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
}
`;

/**
 * 生成加载 P/Invoke 类的脚本片段。
 *
 * 编译产物和运行时绑定：pwsh 7（.NET 8）编译的 DLL 不能被 PowerShell 5.1
 * 加载，反之亦然，所以按 PSEdition 分开缓存（.core.dll / .fx.dll）。
 * 任何一步失败都退回现场编译，保证功能不受影响。
 */
function buildNativePrologue(assemblyPath) {
  const b64 = Buffer.from(String(assemblyPath ?? ''), 'utf8').toString('base64');
  return `
$asmPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$src = @'
${FG_NATIVE_SOURCE}
'@
$loaded = $false
if ($asmPath) {
  if ($PSVersionTable.PSEdition -eq 'Core') { $asmPath = $asmPath -replace '\\.dll$', '.core.dll' }
  else { $asmPath = $asmPath -replace '\\.dll$', '.fx.dll' }
  if (Test-Path $asmPath) {
    try { Add-Type -Path $asmPath; $loaded = $true } catch { $loaded = $false }
  }
  if (-not $loaded) {
    try {
      Add-Type -TypeDefinition $src -OutputAssembly $asmPath -ErrorAction Stop
      Add-Type -Path $asmPath
      $loaded = $true
    } catch { $loaded = $false }
  }
}
if (-not $loaded) { Add-Type -TypeDefinition $src }
`;
}

function buildActivateScript(hwnd, index, options = {}) {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${buildNativePrologue(options.assemblyPath)}
$hwnd = [IntPtr][int64]${Number(hwnd)}
$index = ${Number(index)}
if (-not [Win32Fg]::IsWindow($hwnd)) { [Console]::Out.Write('{"ok":false,"message":"窗口已关闭"}'); exit 0 }
$winPid = [uint32]0
[void][Win32Fg]::GetWindowThreadProcessId($hwnd, [ref]$winPid)
$chromePids = @(Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
if ($chromePids -notcontains [int]$winPid) { [Console]::Out.Write('{"ok":false,"message":"目标窗口不是 Chrome"}'); exit 0 }
$el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$tabCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$tabs = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
if ($index -lt 0 -or $index -ge $tabs.Count) { [Console]::Out.Write('{"ok":false,"message":"tab index out of range"}'); exit 0 }
$sel = $tabs.Item($index).GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
$sel.Select()
# 9 = SW_RESTORE 会把最大化窗口还原成普通尺寸，只有最小化时才需要它。
if ([Win32Fg]::IsIconic($hwnd)) { [void][Win32Fg]::ShowWindow($hwnd, 9) }
# 8 = SW_SHOWNA：只置可见位，不改尺寸、不破坏最大化，也不抢激活。
[void][Win32Fg]::ShowWindow($hwnd, 8)
$fg = [Win32Fg]::GetForegroundWindow()
if ($fg -ne $hwnd) {
  $fgThread = [Win32Fg]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
  $myThread = [Win32Fg]::GetCurrentThreadId()
  [void][Win32Fg]::AttachThreadInput($myThread, $fgThread, $true)
  [void][Win32Fg]::BringWindowToTop($hwnd)
  [void][Win32Fg]::SetForegroundWindow($hwnd)
  [void][Win32Fg]::AttachThreadInput($myThread, $fgThread, $false)
}
# 还有一次机会：切前台期间 Chrome 可能又把可见位清掉。
if (-not [Win32Fg]::IsWindowVisible($hwnd)) {
  [void][Win32Fg]::ShowWindow($hwnd, 8)
  [void][Win32Fg]::SetForegroundWindow($hwnd)
}
# 短轮询而不是死等固定时长：条件一满足就返回，通常几十毫秒内。
# 上限兜住 Chrome 的慢响应，避免为了少数情况让每次激活都多等。
$deadline = [DateTime]::UtcNow.AddMilliseconds(250)
do {
  $visible = [Win32Fg]::IsWindowVisible($hwnd)
  $selected = $sel.Current.IsSelected
  $isForeground = ([Win32Fg]::GetForegroundWindow() -eq $hwnd)
  if ($visible -and $selected -and $isForeground) { break }
  Start-Sleep -Milliseconds 25
} while ([DateTime]::UtcNow -lt $deadline)
$ok = $visible -and $selected -and $isForeground
$msg = ''
$code = ''
if (-not $visible) { $msg = '窗口未能显示'; $code = 'not_visible' }
elseif (-not $isForeground) { $msg = '窗口未能切到前台'; $code = 'not_foreground' }
elseif (-not $selected) { $msg = '标签页未能选中'; $code = 'not_selected' }
[Console]::Out.Write((@{ ok = $ok; visible = $visible; foreground = $isForeground; selected = $selected; index = $index; message = $msg; code = $code } | ConvertTo-Json -Compress))
`;
}

/**
 * 切换到指定标签页。
 * @param {{hwnd:number, index:number}} tab
 * @param {object} [options]
 * @returns {Promise<{ok:boolean, message?:string}>}
 */
async function activateTab(tab, options = {}) {
  if (!tab || !Number.isFinite(tab.index) || tab.index < 0) {
    return { ok: false, message: '缺少标签页位置信息，请重新索引后再试' };
  }
  if (!tab.hwnd && !tab.windowId) {
    return { ok: false, message: '缺少窗口标识，请重新索引后再试' };
  }
  const runPowerShell = options.runPowerShell ?? defaultRunPowerShell;
  const script = buildActivateScript(tab.hwnd, tab.index, {
    assemblyPath: options.assemblyPath,
  });
  const stdout = await runPowerShell(script, options.timeout ?? UIA_TIMEOUT, {
    preferWindowsPowerShell: true,
  });
  try {
    const result = JSON.parse(String(stdout ?? '').trim());
    if (result?.ok) return { ok: true };
    // 标签页其实已经切过去了，只是窗口没显示/没到前台。这种情况不能退回
    // "新开标签页"——那会重复打开同一个页面。
    if (result?.selected) {
      return { ok: false, switched: true, message: result.message || '窗口未能切到前台' };
    }
    return { ok: false, message: result?.message || '切换标签页失败', code: result?.code };
  } catch {
    return { ok: false, message: '切换标签页失败' };
  }
}

/**
 * 用浏览器打开 URL（新标签页）。已打开浏览器的实例会接收它，不会开新窗口。
 * @param {string} exe
 * @param {string} url
 * @param {{spawn?:Function}} [options]
 */
function openUrl(exe, url, options = {}) {
  const spawnFn = options.spawn ?? require('node:child_process').spawn;
  const child = spawnFn(exe, [url], { detached: true, stdio: 'ignore' });
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (child && typeof child.unref === 'function') child.unref();
  return child;
}

/** 读目录名（只取子目录）。 */
function defaultListDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function defaultExists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * Chrome provider。
 * @param {object} [options]
 * @param {()=>Promise<Array<object>>} [options.listTabs] 注入标签页枚举
 * @param {(tabs:Array<object>, o?:object)=>Array<object>} [options.fillUrls] 注入 URL 补全
 * @param {()=>({candidates:Array<object>, errors:string[]})} [options.loadBookmarks] 注入收藏夹加载
 * @param {Function} [options.activateTab] 注入标签页切换
 * @param {Function} [options.openUrl] 注入 URL 打开
 * @param {()=>string|null} [options.findChrome] 注入 chrome.exe 查找
 * @param {number} [options.refreshInterval] 标签页刷新间隔（毫秒）
 * @param {string} [options.win32AssemblyPath] P/Invoke 类缓存 DLL 的路径
 */
function createChromeProvider(options = {}) {
  const listTabs = options.listTabs ?? ((o) => listTabsViaUia(o));
  const fillUrls = options.fillUrls ?? ((tabs, o) => fillUrlsFromHistory(tabs, o));
  const loadBook = options.loadBookmarks ?? (() => loadBookmarks(options));
  const activateTabFn =
    options.activateTab ??
    ((tab, o) => activateTab(tab, { ...o, assemblyPath: options.win32AssemblyPath }));
  const openUrlFn = options.openUrl ?? ((exe, url, o) => openUrl(exe, url, o));
  const findChrome = options.findChrome ?? (() => findChromeExecutable(options));
  const refreshInterval = options.refreshInterval ?? 15000;
  // 别名 → 子范围（收藏夹 / 标签页 / 两者）。每次都从 options 现取，
  // 这样用户改完前缀热更新时，闭包里拿到的也是最新判定。
  const resolveScope = (alias) => {
    const fn =
      options.scopeOf ??
      ((word) => {
        const key = String(word ?? '').toLowerCase();
        if (key === 'b' || key === '书签') return 'bookmark';
        if (key === 'w') return 'tab';
        return null;
      });
    return fn(alias);
  };

  let tabCandidates = [];
  let bookmarkCandidates = [];
  let chromePath = null;
  let timer = null;
  let refreshing = false;
  let lastError = null;
  const errors = [];

  /**
   * 刷新标签页列表。串行化——UIA 枚举要起 PowerShell，不能重叠跑；
   * 已有刷新在跑时返回同一个 promise，让调用方等到最新一轮结束。
   */
  function refreshTabs() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const tabs = await listTabs(options);
        if (!Array.isArray(tabs) || tabs.length === 0) {
          tabCandidates = [];
          lastError = null;
          return;
        }
        fillUrls(tabs, options);
        // 用 hwnd + index 作为位置标识：channel 变了（切页/关页）由下一轮纠正。
        tabCandidates = tabs
          .map((tab, fallbackIndex) =>
            tabToCandidate({
              ...tab,
              index: Number.isInteger(tab.index) ? tab.index : fallbackIndex,
            }),
          )
          .filter(Boolean);
        lastError = null;
      } catch (error) {
        lastError = String(error?.message ?? error);
        errors.push(lastError);
      } finally {
        refreshing = false;
      }
    })();
    return refreshing;
  }

  /** 把候选里的 windowId/index 补回完整的标签页位置信息。 */
  function attachPosition(candidate) {
    if (candidate.source !== 'tab') return candidate;
    // 候选本身已带 hwnd/index（tabToCandidate 写入）；缓存里再兜一层，防止
    // 渲染层只回传了 id 而丢了这些字段。
    if (candidate.hwnd != null && Number.isInteger(candidate.index)) return candidate;
    const match = tabCandidates.find((tab) => tab.id === candidate.id);
    return match ? { ...candidate, ...pickPosition(match) } : candidate;
  }

  return {
    id: 'chrome',
    // 'b' 只查收藏夹、'w' 只查已打开标签页，其余别名查两者。
    // 具体词来自 config.json 的 prefixes（见 core/prefixes.js），这里只留默认值兜底。
    aliases: options.aliases ?? ['网页', 'chrome', 'web', 'webpage', '浏览器', '书签', 'b', 'w'],
    label: '网页',
    kind: 'web',

    async init() {
      const book = loadBook();
      for (const message of book.errors ?? []) errors.push(message);
      bookmarkCandidates = book.candidates ?? [];
      chromePath = findChrome();
      // 标签页枚举要起 PowerShell（~1s），不能挡启动路径：先返回，后台补齐，
      // 轮询会顺带把第一轮结果拉进来。
      startPolling();
      refreshTabs().catch(() => {});
      return {
        bookmarks: bookmarkCandidates.length,
        chrome: chromePath,
      };
    },

    search(_terms, context = {}) {
      // 别名决定范围：按配置，收藏夹 / 标签页 各自的别名只看自己那一份。
      const scope = resolveScope(context.query?.alias);
      if (scope === 'bookmark') return [...bookmarkCandidates];
      if (scope === 'tab') return [...tabCandidates];
      return [...tabCandidates, ...bookmarkCandidates];
    },

    stats() {
      return {
        tabs: tabCandidates.length,
        bookmarks: bookmarkCandidates.length,
        chrome: chromePath,
        errors: errors.slice(),
      };
    },

    async activate(item) {
      if (!item) {
        const error = new Error('缺少条目');
        error.code = 'invalid_item';
        throw error;
      }
      if (item.source === 'bookmark') {
        if (!chromePath) chromePath = findChrome();
        if (!chromePath) {
          const error = new Error('未找到 Chrome，可在 config.json 里设置 chromePath');
          error.code = 'chrome_not_found';
          throw error;
        }
        openUrlFn(chromePath, item.url, options);
        return { opened: item.url, mode: 'new-tab' };
      }

      // 已打开标签页：优先切页；位置信息丢了就退回"新开标签页"。
      const target = attachPosition(item);
      if (target.hwnd && Number.isInteger(target.index)) {
        const result = await activateTabFn(
          { hwnd: target.hwnd, index: target.index, windowId: target.windowId },
          options,
        );
        if (result?.ok) return { switched: true, title: target.title };
        // 标签页已经选中、只是窗口没显示出来：报错即可，不要新开重复标签页。
        if (result?.switched) {
          const error = new Error(result.message ?? '窗口未能切到前台');
          error.code = 'switch_not_foreground';
          throw error;
        }
        if (target.url) {
          if (!chromePath) chromePath = findChrome();
          if (chromePath) {
            openUrlFn(chromePath, target.url, options);
            return { opened: target.url, mode: 'new-tab', fallback: true };
          }
        }
        const error = new Error(result?.message ?? '切换标签页失败');
        error.code = 'switch_failed';
        throw error;
      }
      if (target.url) {
        if (!chromePath) chromePath = findChrome();
        if (chromePath) {
          openUrlFn(chromePath, target.url, options);
          return { opened: target.url, mode: 'new-tab', fallback: true };
        }
      }
      const error = new Error('该标签页已关闭，请重新搜索');
      error.code = 'stale_tab';
      throw error;
    },

    /** 手动刷新（托盘"刷新标签页"或引擎调用）。 */
    async refresh() {
      await refreshTabs();
      const book = loadBook();
      bookmarkCandidates = book.candidates ?? [];
      return this.stats();
    },
    isRefreshing() {
      return refreshing;
    },

    /** 窗口隐藏时暂停定时刷新：每次枚举都要起 PowerShell，常驻后台纯属白烧。 */
    pausePolling() {
      stopPolling();
    },

    /** 窗口唤起时恢复定时刷新，并立刻补一轮（标题可能已经变了）。 */
    resumePolling() {
      startPolling();
      if (refreshInterval > 0) refreshTabs().catch(() => {});
    },

    dispose() {
      stopPolling();
    },
  };

  function startPolling() {
    if (timer || refreshInterval <= 0) return;
    timer = setInterval(() => {
      refreshTabs().catch(() => {});
    }, refreshInterval);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
}

/** 只取切换标签页需要的位置字段，避免把整个候选塞进结果。 */
function pickPosition(tab) {
  const position = {};
  if (tab.hwnd != null) position.hwnd = tab.hwnd;
  if (Number.isInteger(tab.index)) position.index = tab.index;
  if (tab.windowId != null) position.windowId = tab.windowId;
  return position;
}

module.exports = {
  createChromeProvider,
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
  chromeUserDataDirs,
  chromeExecutableCandidates,
  findChromeExecutable,
  parseUiaOutput,
  listTabsViaUia,
  fillUrlsFromHistory,
  buildActivateScript,
  activateTab,
  openUrl,
  UIA_SCRIPT,
};
