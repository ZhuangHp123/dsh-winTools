'use strict';

/**
 * 搜索前缀（锁定范围的「首词」）。
 *
 * provider 自己只认"我有哪些别名"，具体别名从这份配置来：
 * 默认值就是以前写死在每个 provider 里的那套，用户可以在 config.json
 * 的 prefixes 字段里覆盖任意一项，改完重启生效。
 *
 * 一个 scope 对应一个"可锁定范围"，和 provider 不是一一对应：
 * chrome 一个 provider 带 网页 / 收藏夹 / 标签页 三个 scope。
 */

/** scope → 默认前缀。顺序有意义：越靠前的越容易被推荐展示。 */
const DEFAULT_PREFIXES = {
  app: ['应用', 'apps', 'program', '程序', 'a'],
  project: ['项目', 'projects', 'project', 'proj', 'p'],
  web: ['网页', 'chrome', 'web', 'webpage', '浏览器'],
  bookmark: ['收藏夹', '书签', 'b'],
  tab: ['标签页', 'w'],
  contact: ['联系人', '通讯录', '钉钉', 'dingtalk', 'contact', 'contacts', 'c', 'dc'],
  doc: ['文档', '钉钉文档', 'dingdoc', 'doc', 'docs', 'dd'],
  file: ['文件', 'files', 'file', 'f'],
  clipboard: ['剪贴板', 'clip', 'clipboard', 'cb', 'v'],
};

/** scope → 界面上的显示名（徽标、提示文案都用它）。 */
const SCOPE_LABEL = {
  app: '应用',
  project: '项目',
  web: '网页',
  bookmark: '收藏夹',
  tab: '标签页',
  contact: '联系人',
  doc: '钉钉文档',
  file: '文件',
  clipboard: '剪贴板',
};

/** chrome 一个 provider 覆盖的三个 scope。 */
const WEB_SCOPES = ['web', 'bookmark', 'tab'];

/**
 * 合并用户配置与默认值。
 *
 * 规则刻意保守：
 * - 只认已知 scope，未知键丢弃（写错名字不该凭空多出个能锁定的范围）；
 * - 值必须是字符串数组，非空才生效，否则整项回退默认；
 * - 大小写不同的重复项只留第一个；
 * - 同一个词被两个 scope 认领时，按 SCOPE_ORDER 先到先得，后者剔除并记一条冲突。
 */
function resolvePrefixes(overrides = {}) {
  const prefixes = {};
  const conflicts = [];
  const owner = new Map();

  for (const scope of Object.keys(DEFAULT_PREFIXES)) {
    const custom = overrides?.[scope];
    const trimmed =
      Array.isArray(custom) && custom.every((entry) => typeof entry === 'string')
        ? custom.map((entry) => entry.trim()).filter(Boolean)
        : [];
    // 空数组也算"没配好"：把某一类的前缀清空等于让它彻底锁不上，
    // 这通常不是用户本意，回退默认更安全。
    const list = trimmed.length > 0 ? trimmed : DEFAULT_PREFIXES[scope];

    const seen = new Set();
    const kept = [];
    for (const word of list) {
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const takenBy = owner.get(key);
      if (takenBy && takenBy !== scope) {
        conflicts.push({ word, kept: takenBy, dropped: scope });
        continue;
      }
      owner.set(key, scope);
      kept.push(word);
    }
    prefixes[scope] = kept;
  }

  return { prefixes, conflicts };
}

/** 某个 provider 要注册的全部别名（多 scope 的取并集）。 */
function aliasesFor(prefixes, scopes) {
  const out = [];
  const seen = new Set();
  for (const scope of scopes) {
    for (const word of prefixes[scope] ?? []) {
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
    }
  }
  return out;
}

/** 首词命中哪个 scope；没命中返回 null。 */
function scopeForWord(prefixes, word) {
  const key = String(word ?? '').trim().toLowerCase();
  if (!key) return null;
  for (const [scope, list] of Object.entries(prefixes)) {
    if (list.some((entry) => entry.toLowerCase() === key)) return scope;
  }
  return null;
}

/**
 * 提示文案用的短前缀：优先取单字符 ASCII 别名（a / f / b …），
 * 没有就取最短的 ASCII 词，再没有就退回列表第一个（可能是中文）。
 */
function shortAlias(prefixes, scope) {
  const list = prefixes[scope] ?? [];
  const ascii = list.filter((word) => /^[a-z0-9]+$/i.test(word));
  const single = ascii.find((word) => word.length === 1);
  if (single) return single;
  if (ascii.length > 0) return ascii.reduce((best, word) => (word.length < best.length ? word : best));
  return list[0] ?? '';
}

/** 空状态提示需要的 [{scope,label,alias}]，顺序固定，便于界面和测试对齐。 */
function hintEntries(prefixes) {
  return Object.keys(SCOPE_LABEL)
    .map((scope) => ({ scope, label: SCOPE_LABEL[scope], alias: shortAlias(prefixes, scope) }))
    .filter((entry) => entry.alias);
}

/** 两个前缀列表是否等价（大小写不敏感、顺序敏感）。 */
function sameList(a, b) {
  if (a.length !== b.length) return false;
  return a.every((word, index) => word.toLowerCase() === String(b[index]).toLowerCase());
}

/**
 * 只挑出与默认值不同的 scope，用来写回 config.json。
 * 全默认时返回空对象——配置文件里不需要留一份九项默认值的副本。
 */
function diffPrefixes(prefixes) {
  const out = {};
  for (const scope of Object.keys(DEFAULT_PREFIXES)) {
    const list = prefixes[scope] ?? [];
    if (!sameList(list, DEFAULT_PREFIXES[scope])) out[scope] = [...list];
  }
  return out;
}

module.exports = {
  DEFAULT_PREFIXES,
  SCOPE_LABEL,
  WEB_SCOPES,
  resolvePrefixes,
  aliasesFor,
  scopeForWord,
  shortAlias,
  hintEntries,
  diffPrefixes,
};
