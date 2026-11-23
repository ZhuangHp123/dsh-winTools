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

/**
 * 单个字母别名对应的范围标签。同一个 provider 用别名切了子集时
 * （b = 收藏夹、w = 标签页），徽标要跟着变，否则两个都显示"网页"。
 */
const ALIAS_LABEL = { b: '收藏夹', w: '标签页', dc: '钉钉联系人', dd: '钉钉文档' };

function renderMode(providerHint, alias) {
  if (!providerHint) {
    modeEl.hidden = true;
    modeEl.textContent = '';
    return;
  }
  const kind = PROVIDER_KIND[providerHint] ?? providerHint;
  modeEl.hidden = false;
  modeEl.textContent = ALIAS_LABEL[alias] ?? KIND_LABEL[kind] ?? providerHint;
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
    } else {
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
    emptyEl.textContent =
      '输入关键字开始搜索；a 应用 / f 文件 / b 收藏夹 / w 标签页 / p 项目 / c 联系人 / dd 钉钉文档 / v 剪贴板 可锁定范围';
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

input.addEventListener('input', scheduleSearch);

input.addEventListener('keydown', (event) => {
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
  input.value = '';
  resetToCompact();
  input.focus();
  window.launcher.status().then((next) => {
    if (!next) return;
    status = next;
    renderStatus();
  });
});

window.launcher.onStatus((next) => {
  if (!next) return;
  status = next;
  renderStatus();
  if (items.length === 0) renderEmpty(input.value);
});

window.launcher
  .status()
  .then((next) => {
    if (!next) return;
    status = next;
    renderStatus();
  })
  .catch(() => {});

// 一加载就收成一行：窗口是按展开尺寸建的，等 launcher:shown 再收会闪一帧大空白。
setCompact(true);

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
