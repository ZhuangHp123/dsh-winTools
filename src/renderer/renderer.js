'use strict';

/**
 * 渲染层。
 *
 * 只做三件事：把输入变成搜索请求、把结果画出来、把键盘操作映射成
 * 选中/隐藏。没有业务逻辑——排序在 core/rank.js，执行在主进程。
 */

const input = document.getElementById('query');
const resultsEl = document.getElementById('results');
const emptyEl = document.getElementById('empty');
const modeEl = document.getElementById('mode');
const statusLeft = document.getElementById('status-left');
const statusRight = document.getElementById('status-right');

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
let status = { indexing: false, fileCount: 0, errors: [] };
let debounceTimer = null;

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

function renderMode(hint) {
  if (!hint) {
    modeEl.hidden = true;
    modeEl.textContent = '';
    return;
  }
  const kind = PROVIDER_KIND[hint] ?? hint;
  modeEl.hidden = false;
  modeEl.textContent = KIND_LABEL[kind] ?? hint;
}

function renderResults() {
  resultsEl.textContent = '';
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
    if (item.initials) {
      // 联系人用首字色块当头像（拿不到真人头像 URL），顶掉左边的类别标签。
      lead.className = `row-avatar av-${avatarTone(item.initials)}`;
      lead.textContent = item.initials;
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
    emptyEl.textContent = '输入关键字开始搜索；应用/项目/网页/联系人/文档/文件/剪贴板 可锁定搜索范围';
  } else if (status.indexing) {
    emptyEl.textContent = '没有匹配结果（文件索引仍在构建中，稍后再试）';
  } else {
    emptyEl.textContent = '没有匹配结果';
  }
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
  renderMode(response?.query?.providerHint ?? null);
  renderResults();
  renderEmpty(query);

  if (response?.errors?.length) {
    statusLeft.classList.add('warn');
    statusLeft.textContent = response.errors.map((e) => `${e.provider}: ${e.message}`).join('；');
  } else {
    renderStatus();
  }
}

function scheduleSearch() {
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
  items = [];
  activeIndex = -1;
  resultsEl.textContent = '';
  resultsEl.hidden = true;
  emptyEl.hidden = false;
  renderMode(null);
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

input.focus();
