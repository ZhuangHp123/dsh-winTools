'use strict';

/**
 * 渲染层。
 *
 * 只做三件事：把输入变成搜索请求、把结果画出来、把键盘操作映射成
 * 选中/隐藏。没有业务逻辑——排序在 core/rank.js，执行在主进程。
 */

const input = document.getElementById('query');
const launcherEl = document.getElementById('launcher');
const resultsEl = document.getElementById('results');
const emptyEl = document.getElementById('empty');
const modeEl = document.getElementById('mode');
const statusLeft = document.getElementById('status-left');
const statusRight = document.getElementById('status-right');
const searchRowEl = document.querySelector('.search-row');
const settingsEl = document.getElementById('settings');
const settingsListEl = document.getElementById('settings-list');
const settingsMsgEl = document.getElementById('settings-msg');
const gearBtn = document.getElementById('open-settings');

const KIND_LABEL = {
  app: '应用',
  project: '项目',
  web: '网页',
  contact: '联系人',
  doc: '文档',
  file: '文件',
  clipboard: '剪贴板',
};
const KIND_ORDER = { app: 0, project: 1, web: 2, contact: 3, doc: 4, file: 5, clipboard: 6 };

let items = [];
let activeIndex = -1;
let searchToken = 0;
/** 结果 id → 头像占位元素，补图回来后原地替换。 */
let pendingAvatars = new Map();
let status = { indexing: false, fileCount: 0, errors: [] };
let debounceTimer = null;
/** 当前是否处于"只有搜索框"的紧凑态。 */
let compact = false;
/** 设置视图是否打开。打开时它替换结果区，Esc 优先关它而不是清空搜索。 */
let settingsOpen = false;

const DEBOUNCE_MS = 60;

const AVATAR_TONES = 6;

/** 同一个名字永远落在同一个色号上，避免每次搜索换色。 */
function avatarTone(initials) {
  let sum = 0;
  for (const char of String(initials)) sum = (sum + char.codePointAt(0)) % 997;
  return sum % AVATAR_TONES;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * provider id → 显示用的 kind。搜索框右边的徽标按 kind 取标签，
 * 否则会显示 chrome / file 这类内部 id。
 */
const PROVIDER_KIND = { chrome: 'web', dingtalk: 'contact', dingdoc: 'doc' };

/** 配置里的前缀表：scope → 中文名、scope → 前缀、前缀 → scope。主进程随 status 下发。 */
let scopeLabel = {};
let scopePrefix = {};
let aliasScope = {};

function applyPrefixConfig(next) {
  if (Array.isArray(next?.hint)) {
    scopeLabel = {};
    scopePrefix = {};
    for (const entry of next.hint) {
      if (!entry?.scope) continue;
      scopeLabel[entry.scope] = entry.label;
      if (entry.prefix) scopePrefix[entry.scope] = entry.prefix;
    }
  }
  if (next?.aliasScope && typeof next.aliasScope === 'object') {
    aliasScope = next.aliasScope;
  }
}

function renderMode(providerHint, alias) {
  if (!providerHint) {
    modeEl.hidden = true;
    modeEl.textContent = '';
    return;
  }
  // 前缀可配置后，别名对应的子范围（收藏夹 / 标签页）由主进程的 aliasScope 决定；
  // 命中不到就退回 provider 级的中文名。
  const scope = alias ? aliasScope[String(alias).toLowerCase()] : null;
  const kind = PROVIDER_KIND[providerHint] ?? providerHint;
  modeEl.hidden = false;
  modeEl.textContent =
    (scope && scopeLabel[scope]) ?? scopeLabel[kind] ?? KIND_LABEL[kind] ?? providerHint;
}

/** 星形（收藏夹）和标签页形状，用内联 SVG 免得为两个图形引一套图标库。 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const WEB_GLYPHS = {
  // 星形：收藏夹
  bookmark: 'M12 3.2l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.7l6.1-.9z',
  // 窗口 + 标题栏：已打开的标签页，比纯方块更像"浏览器窗口"
  tab: 'M3.5 6.5h17v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 10.2h17',
};
/** 没有本地图标文件的类型，用同样的手法画一个。 */
const KIND_GLYPHS = {
  // 剪贴板：夹子 + 纸
  clipboard: 'M9 4.5h6M9 4.5a1.5 1.5 0 0 0-1.5 1.5v0A1.5 1.5 0 0 0 9 7.5h6a1.5 1.5 0 0 0 1.5-1.5v0A1.5 1.5 0 0 0 15 4.5M7 6.2H5.5A1.5 1.5 0 0 0 4 7.7v11.8A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V7.7a1.5 1.5 0 0 0-1.5-1.5H17',
  // 文档：折角纸
  doc: 'M6 3.5h8l4.5 4.5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1zM14 3.5V8h4.5',
};

function svgGlyph(pathData) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  return svg;
}

function webGlyph(source) {
  return svgGlyph(WEB_GLYPHS[source === 'bookmark' ? 'bookmark' : 'tab']);
}

function renderResults() {
  resultsEl.textContent = '';
  pendingAvatars = new Map();
  if (items.length === 0) {
    resultsEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  resultsEl.hidden = false;
  emptyEl.hidden = true;

  const frag = document.createDocumentFragment();
  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'row' + (index === activeIndex ? ' active' : '');
    li.setAttribute('role', 'option');
    li.dataset.index = String(index);
    li.dataset.id = item.id;

    const kind = item.kind ?? item.provider ?? '';
    const lead = document.createElement('span');
    if (item.avatar) {
      lead.className = 'row-avatar';
      const img = document.createElement('img');
      img.src = item.avatar;
      img.alt = '';
      img.draggable = false;
      lead.appendChild(img);
    } else if (item.initials) {
      // 真头像还没拿到时先用首字色块占位；补图回来会原地替换。
      lead.className = `row-avatar av-${avatarTone(item.initials)}`;
      lead.textContent = item.initials;
      if (item.avatarPending) pendingAvatars.set(item.id, lead);
    } else if (item.icon) {
      // 应用 / 项目 / 文件：真实程序图标，一眼分清 IDEA、Cursor、Chrome。
      lead.className = 'row-icon';
      const img = document.createElement('img');
      img.src = item.icon;
      img.alt = '';
      img.draggable = false;
      lead.appendChild(img);
    } else if (kind === 'web') {
      // 网页没有本地图标文件：收藏夹用金星，已打开标签页用窗口形状。
      lead.className = `row-glyph glyph-web-${item.source === 'bookmark' ? 'bookmark' : 'tab'}`;
      lead.appendChild(webGlyph(item.source));
    } else if (KIND_GLYPHS[kind]) {
      // 剪贴板 / 文档也没有磁盘实体，画个图形比塞"剪贴板"三个字干净。
      lead.className = `row-glyph glyph-kind-${escapeHtml(kind)}`;
      lead.appendChild(svgGlyph(KIND_GLYPHS[kind]));
    } else {
      // 图标抽失败时的最后兜底：文字标只占位，不当主信息。
      lead.className = `kind-tag ${escapeHtml(kind)}`;
      lead.textContent = KIND_LABEL[kind] ?? kind.slice(0, 2);
    }

    const text = document.createElement('div');
    text.className = 'row-text';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = item.title ?? '';
    text.appendChild(title);
    if (item.subtitle) {
      const sub = document.createElement('div');
      sub.className = 'row-sub';
      sub.textContent = item.subtitle;
      sub.title = item.subtitle;
      text.appendChild(sub);
    }

    li.append(lead, text);

    if (item.pinned) {
      const pin = document.createElement('span');
      pin.className = 'row-pin';
      pin.textContent = '置顶';
      li.appendChild(pin);
    }

    li.addEventListener('mousemove', () => setActive(index));
    li.addEventListener('click', () => activate(index));
    frag.appendChild(li);
  });
  resultsEl.appendChild(frag);
  scrollActiveIntoView();
  fillPendingAvatars();
}

/**
 * 缺图的联系人按顺序异步补，同一轮搜索只发一次请求。
 * 补回来时如果那个元素还在 DOM 里（没被下一轮搜索清掉）就原地换成 <img>。
 */
function fillPendingAvatars() {
  if (pendingAvatars.size === 0) return;
  const token = searchToken;
  for (const [id, node] of pendingAvatars) {
    window.launcher
      .avatar(id)
      .then((result) => {
        if (token !== searchToken || !result?.avatar) return;
        if (!node.isConnected) return;
        node.className = 'row-avatar';
        node.textContent = '';
        const img = document.createElement('img');
        img.src = result.avatar;
        img.alt = '';
        img.draggable = false;
        node.appendChild(img);
      })
      .catch(() => {});
  }
}

function setActive(index) {
  if (index === activeIndex) return;
  activeIndex = index;
  for (const row of resultsEl.children) {
    const rowIndex = Number(row.dataset.index);
    row.classList.toggle('active', rowIndex === activeIndex);
  }
  scrollActiveIntoView();
}

function scrollActiveIntoView() {
  const row = resultsEl.children[activeIndex];
  if (row && typeof row.scrollIntoView === 'function') {
    row.scrollIntoView({ block: 'nearest' });
  }
}

function renderEmpty(query) {
  if (items.length > 0) return;
  if (!query.trim()) {
    // 提示里列哪些前缀完全由配置决定：用户把 a 改成 app，这里就跟着显示 app。
    const hint = Array.isArray(status.hint) ? status.hint : [];
    emptyEl.textContent = hint.length > 0
      ? `输入关键字开始搜索；${hint.map((entry) => `${entry.prefix} ${entry.label}`).join(' / ')} 可锁定范围`
      : '输入关键字开始搜索';
  } else if (status.indexing) {
    emptyEl.textContent = '没有匹配结果（文件索引仍在构建中，稍后再试）';
  } else {
    emptyEl.textContent = '没有匹配结果';
  }
}

/**
 * 紧凑态：刚唤起、还没输入时把结果区、提示区和状态栏收起来，
 * 窗口高度跟着收成一行，屏幕上就只剩一个输入框。
 */
function setCompact(next) {
  if (compact === next) return;
  compact = next;
  launcherEl.classList.toggle('compact', compact);
  // 收起会连带把设置视图藏起来；状态要同步，否则下次唤起还停在设置页。
  if (compact && settingsOpen) {
    settingsOpen = false;
    launcherEl.classList.remove('settings-open');
  }
  // 展开时形状由 CSS 决定，主进程只需恢复默认高度；
  // 收起时把搜索行的真实高度报上去，避免不同 DPI 下留白或裁字。
  // +2 是容器上下各 1px 的边框，否则紧贴时会被裁掉一像素。
  const height = compact ? Math.ceil(searchRowEl.getBoundingClientRect().height) + 2 : null;
  window.launcher.setCompact({ compact, height }).catch(() => {});
}

function renderStatus() {
  const parts = [];
  if (status.indexing) {
    parts.push(
      status.fileCount > 0
        ? `索引中… ${status.fileCount.toLocaleString('zh-CN')}`
        : '索引中…',
    );
  } else if (status.fileCount > 0) {
    parts.push(`${status.fileCount.toLocaleString('zh-CN')} 个文件`);
  }
  if (status.projectCount > 0) parts.push(`项目 ${status.projectCount}`);
  if (status.tabCount > 0) parts.push(`标签页 ${status.tabCount}`);
  if (status.contactCount > 0) parts.push(`联系人 ${status.contactCount}`);
  if (status.docCount > 0) parts.push(`文档 ${status.docCount}`);
  if (status.clipboardCount > 0) parts.push(`剪贴板 ${status.clipboardCount}`);

  const errors = Array.isArray(status.errors) ? status.errors : [];
  if (errors.length > 0) {
    statusLeft.classList.add('warn');
    statusLeft.textContent = errors[0];
    statusLeft.title = errors.join('\n');
  } else {
    statusLeft.classList.remove('warn');
    statusLeft.textContent = parts.length > 0 ? parts.join(' · ') : '就绪';
    statusLeft.title = '';
  }

  statusRight.textContent = status.hotkey ? status.hotkey : status.trayAvailable ? '托盘' : '';
}

async function search() {
  const query = input.value;
  const token = (searchToken += 1);
  const response = await window.launcher.search(query);
  if (token !== searchToken) return; // 有更新的请求了
  if (response?.stale) return;

  items = (response?.items ?? []).slice().sort((a, b) => {
    // 分数相同时按类型稳定排序，避免同一份结果每次闪烁换位。
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
    return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
  });
  activeIndex = items.length > 0 ? 0 : -1;
  renderMode(response?.query?.providerHint ?? null, response?.query?.alias ?? null);
  renderResults();
  renderEmpty(query);
  // 纯空白输入也可能让 provider 吐默认条目，那种情况要展开，不能把结果裁在 52px 里。
  setCompact(!query.trim() && items.length === 0);

  if (response?.errors?.length) {
    statusLeft.classList.add('warn');
    statusLeft.textContent = response.errors.map((e) => `${e.provider}: ${e.message}`).join('；');
  } else {
    renderStatus();
  }
}

/**
 * 回到"刚打开"的样子：没有结果、没有徽标、窗口收成一行。
 * 空输入不发起搜索——provider 对空词元会返回"最近/全部"，那就又弹出整页了。
 */
function resetToCompact() {
  searchToken += 1; // 让在途请求的结果作废
  items = [];
  activeIndex = -1;
  resultsEl.textContent = '';
  resultsEl.hidden = true;
  emptyEl.hidden = false;
  renderMode(null);
  renderEmpty('');
  setCompact(true);
}

function scheduleSearch() {
  if (settingsOpen) {
    // 设置页里输入框当过滤器用：按范围名或已有前缀筛行。
    filterSettingsRows(input.value);
    return;
  }
  if (!input.value.trim()) {
    resetToCompact();
    return;
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    search().catch((error) => {
      statusLeft.classList.add('warn');
      statusLeft.textContent = `搜索失败：${error?.message ?? error}`;
    });
  }, DEBOUNCE_MS);
}

async function activate(index = activeIndex) {
  const item = items[index];
  if (!item) return;
  const result = await window.launcher.activate(item.id);
  if (result && result.ok === false) {
    statusLeft.classList.add('warn');
    statusLeft.textContent = result.message ?? '执行失败';
  }
}

function move(delta) {
  if (items.length === 0) return;
  const next = activeIndex + delta;
  if (next < 0) setActive(items.length - 1);
  else if (next >= items.length) setActive(0);
  else setActive(next);
}

/* ── 设置：自定义搜索前缀 ─────────────────────────────────── */

/** 一次编辑会话的快照：用来判断是否有未保存改动。 */
let settingsSnapshot = null;
let settingsDefaults = {};

/** 合法前缀：单个不含空白的词，中文英文符号都行，和后端校验保持一致。 */
function isValidPrefix(word) {
  return typeof word === 'string' && word.length > 0 && !/\s/.test(word);
}

function setSettingsMsg(text, tone) {
  settingsMsgEl.textContent = text ?? '';
  settingsMsgEl.classList.toggle('warn', tone === 'warn');
  settingsMsgEl.classList.toggle('ok', tone === 'ok');
}

function samePrefix(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

/**
 * 画设置表单。每类一行，只一个输入框。
 * 输入时立刻做本地校验：含空白就标红并提示，不用等保存才报错。
 */
function renderSettingsRows(prefixes) {
  settingsListEl.textContent = '';
  const order = Array.isArray(status.hint) && status.hint.length > 0
    ? status.hint.map((entry) => entry.scope)
    : Object.keys(prefixes);
  for (const scope of order) {
    const label = scopeLabel[scope] ?? scope;
    const li = document.createElement('li');
    li.className = 'settings-item';
    li.dataset.scope = scope;

    const name = document.createElement('span');
    name.className = 'settings-name';
    name.textContent = label;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'settings-input';
    input.id = `prefix-input-${scope}`;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = prefixes[scope] ?? '';
    input.placeholder = settingsDefaults[scope] ?? '';
    input.addEventListener('input', () => {
      const value = input.value.trim();
      const illegal = value.length > 0 && !isValidPrefix(value);
      input.classList.toggle('invalid', illegal);
      input.classList.toggle('changed', !illegal && !samePrefix(value, prefixes[scope]));
    });

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'settings-reset';
    reset.textContent = '默认';
    reset.title = `恢复为 ${settingsDefaults[scope] ?? ''}`;
    reset.addEventListener('click', () => {
      input.value = settingsDefaults[scope] ?? '';
      input.classList.remove('invalid');
      input.classList.remove('changed');
      input.focus();
    });

    li.append(name, input, reset);
    settingsListEl.appendChild(li);
  }
}

/** 收集表单值：空串表示用默认；有非法值就返回错误。 */
function collectSettings() {
  const out = {};
  for (const li of settingsListEl.children) {
    const scope = li.dataset.scope;
    const input = li.querySelector('.settings-input');
    const value = input.value.trim();
    if (value && !isValidPrefix(value)) {
      return { ok: false, message: `「${scopeLabel[scope] ?? scope}」只能填一个前缀，不能含空格` };
    }
    out[scope] = value;
  }
  return { ok: true, prefixes: out };
}

/** 把生效中的前缀表拍平成快照（用于判断改动）。 */
function collectSnapshotShape(prefixes) {
  const out = {};
  for (const [scope, word] of Object.entries(prefixes)) out[scope] = word ?? '';
  return out;
}

async function openSettings() {
  setSettingsMsg('');
  let data = null;
  try {
    data = await window.launcher.getPrefixes();
  } catch (error) {
    setSettingsMsg(`读取设置失败：${error?.message ?? error}`, 'warn');
  }
  const prefixes = data?.prefixes ?? {};
  settingsDefaults = data?.defaults ?? {};
  if (data?.labels && typeof data.labels === 'object') {
    // 范围中文名以主进程为准，界面不另存一份。
    for (const [scope, label] of Object.entries(data.labels)) scopeLabel[scope] = label;
  }
  settingsSnapshot = collectSnapshotShape(prefixes);

  input.value = '';
  input.placeholder = '输入关键字过滤…（回车保存，Esc 取消）';
  // 清掉上一轮搜索结果，避免关掉设置后残留旧列表。
  searchToken += 1;
  items = [];
  activeIndex = -1;
  resultsEl.textContent = '';
  renderMode(null);
  settingsOpen = true;
  launcherEl.classList.add('settings-open');
  settingsEl.hidden = false;
  setCompact(false); // 设置页需要整块高度
  renderSettingsRows(prefixes);
  const first = settingsListEl.querySelector('.settings-input');
  first?.focus();
  first?.select?.();
}

/** 设置页里的行过滤：按范围名或该行已有前缀匹配，空串显示全部。 */
function filterSettingsRows(text) {
  const needle = String(text ?? '').trim().toLowerCase();
  for (const li of settingsListEl.children) {
    const label = (scopeLabel[li.dataset.scope] ?? li.dataset.scope).toLowerCase();
    const value = (li.querySelector('.settings-input')?.value ?? '').toLowerCase();
    li.hidden = Boolean(needle) && !label.includes(needle) && !value.includes(needle);
  }
}

function closeSettings() {
  settingsOpen = false;
  launcherEl.classList.remove('settings-open');
  settingsEl.hidden = true;
  input.placeholder = '搜索应用、文件、剪贴板…';
  setSettingsMsg('');
  resetToCompact();
  input.focus();
}

async function saveSettings() {
  const collected = collectSettings();
  if (!collected.ok) {
    setSettingsMsg(collected.message, 'warn');
    return;
  }
  const prefixes = collected.prefixes;
  const changed = [];
  for (const [scope, word] of Object.entries(prefixes)) {
    if (!samePrefix(word, settingsSnapshot?.[scope])) changed.push(scopeLabel[scope] ?? scope);
  }
  if (changed.length === 0) {
    setSettingsMsg('没有改动', '');
    return;
  }

  const saveBtn = document.getElementById('settings-save');
  saveBtn.disabled = true;
  setSettingsMsg('保存中…', '');
  let result = null;
  try {
    result = await window.launcher.savePrefixes(prefixes);
  } catch (error) {
    result = { ok: false, message: String(error?.message ?? error) };
  } finally {
    saveBtn.disabled = false;
  }

  if (!result?.ok) {
    setSettingsMsg(result?.message ?? '保存失败', 'warn');
    return;
  }

  // 保存成功：主进程已热更新前缀表。刷新本地配置并同步提示文案。
  settingsSnapshot = collectSnapshotShape(result.prefixes ?? prefixes);
  const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((conflict) => `「${conflict.word}」已被「${scopeLabel[conflict.kept] ?? conflict.kept}」占用，${scopeLabel[conflict.dropped] ?? conflict.dropped} 回到默认`)
      .join('；');
    setSettingsMsg(`已保存；${detail}`, 'warn');
  } else {
    setSettingsMsg(`已保存：${changed.join('、')}`, 'ok');
  }
  // 让徽标和空状态提示立刻用上新前缀。
  try {
    const next = await window.launcher.status();
    if (next) {
      status = next;
      applyPrefixConfig(next);
      renderStatus();
      renderEmpty('');
    }
  } catch {
    /* 状态刷新失败不影响已保存的事实 */
  }
  renderSettingsRows(result.prefixes ?? prefixes);
}

input.addEventListener('input', scheduleSearch);

input.addEventListener('keydown', (event) => {
  // 设置页独立处理按键：输入框在这里只是过滤辅助，回车=保存，Esc=取消。
  if (settingsOpen) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSettings();
    }
    return;
  }
  // Ctrl/Cmd + 逗号打开设置，和多数 Windows 程序一致。
  if ((event.ctrlKey || event.metaKey) && event.key === ',') {
    event.preventDefault();
    openSettings();
    return;
  }
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      move(-1);
      break;
    case 'Enter':
      event.preventDefault();
      activate();
      break;
    case 'Escape':
      event.preventDefault();
      if (input.value) {
        input.value = '';
        scheduleSearch();
      } else {
        window.launcher.hide();
      }
      break;
    case 'Tab':
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
      break;
    default:
      break;
  }
});

// 再次唤起时清空并聚焦：启动器的直觉是"每次都是新的搜索"。
window.launcher.onShown(() => {
  // 唤起时若还停在设置页，先退出——用户按热键是想搜索，不是想继续编辑。
  if (settingsOpen) closeSettings();
  input.value = '';
  resetToCompact();
  input.focus();
  window.launcher.status().then((next) => {
    if (!next) return;
    status = next;
    applyPrefixConfig(next);
    renderStatus();
  });
});

window.launcher.onStatus((next) => {
  if (!next) return;
  status = next;
  applyPrefixConfig(next);
  renderStatus();
  if (items.length === 0) renderEmpty(input.value);
});

window.launcher
  .status()
  .then((next) => {
    if (!next) return;
    status = next;
    applyPrefixConfig(next);
    renderStatus();
    renderEmpty('');
  })
  .catch(() => {});

// 一加载就收成一行：窗口是按展开尺寸建的，等 launcher:shown 再收会闪一帧大空白。
setCompact(true);

/* ── 设置页按钮与快捷键 ───────────────────────────────────── */

gearBtn.addEventListener('click', (event) => {
  event.preventDefault();
  if (settingsOpen) closeSettings();
  else openSettings();
});

// 设置列表里的输入框：回车保存，Esc 取消。
settingsListEl.addEventListener('keydown', (event) => {
  if (!settingsOpen) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    saveSettings();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSettings();
  }
});

document.getElementById('settings-save').addEventListener('click', () => saveSettings());
document.getElementById('settings-cancel').addEventListener('click', () => closeSettings());

/**
 * 窗口四周留了一圈透明边给投影；那片区域不该吃鼠标。
 * 指针在卡片上就正常接收，跑到透明边上就穿透给桌面。
 * 穿透时用 forward，本进程仍能收到 mousemove，指针回到卡片会自动恢复。
 */
let ignoringMouse = null;
document.addEventListener('mousemove', (event) => {
  const onCard = event.target instanceof Node && launcherEl.contains(event.target);
  const ignore = !onCard;
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  // 冒烟测试靠这个属性断言穿透状态，不依赖截图。
  document.body.dataset.mouseIgnored = String(ignore);
  window.launcher.setIgnoreMouse(ignore);
});

input.focus();
