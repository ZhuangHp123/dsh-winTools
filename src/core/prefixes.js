'use strict';

/**
 * 搜索前缀（锁定范围的「首词」）。
 *
 * 每个范围只允许一个前缀（不含空白的单串，中英文/符号均可），用「前缀 + 空格」锁定范围。
 * 默认值可以在设置页或 config.json 的 prefixes 字段里改，存的是单个字符串。
 * 旧版存数组的配置也能读：取第一个合法词。
 *
 * 一个 scope 对应一个"可锁定范围"，和 provider 不是一一对应：
 * chrome 一个 provider 带 网页 / 收藏夹 / 标签页 三个 scope。
 */

/** scope → 默认前缀（单个英文词）。 */
const DEFAULT_PREFIXES = {
  app: 'a',
  project: 'p',
  web: 'web',
  bookmark: 'b',
  tab: 'w',
  contact: 'c',
  doc: 'd',
  file: 'f',
  clipboard: 'v',
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

/** 合法前缀：任意非空、不含空白的字符串（中文英文符号都行，长度不限）。 */
const WHITESPACE = /\s/;

function isPrefixWord(word) {
  return typeof word === 'string' && word.length > 0 && !WHITESPACE.test(word);
}

/**
 * 读一个配置值。
 * 兼容旧版数组（挑第一个合法的单个词）；空值视为"用默认"，非法值单独标出来。
 * @returns {{word:string|null, empty:boolean, illegal:boolean}}
 */
function prefixCandidate(value) {
  if (Array.isArray(value)) {
    const words = value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim());
    const valid = words.find(isPrefixWord);
    if (valid) return { word: valid, empty: false, illegal: false };
    const hasText = words.some(Boolean);
    return { word: null, empty: !hasText, illegal: hasText };
  }
  if (typeof value !== 'string') return { word: null, empty: false, illegal: true };
  // 只认单个词：带空白的（"a b"）算非法，提示用户只能留一个。
  const word = value.trim();
  if (!word) return { word: null, empty: true, illegal: false };
  if (WHITESPACE.test(word)) return { word: null, empty: false, illegal: true };
  return { word, empty: false, illegal: false };
}

/** 规整成单个合法前缀，否则 null。 */
function normalizePrefix(value) {
  return prefixCandidate(value).word;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 合并用户配置与默认值。
 *
 * 两阶段，保证"默认值的位置不会被别的范围的自定义值挤掉"：
 * 1. 先把所有没配自定义的范围按默认值占位；
 * 2. 再给配了自定义的范围占位——撞到已占的词就把这条自定义判为冲突、
 *    回退该范围自己的默认值；默认值也被占（两个范围都填了同一个词）才置空。
 *
 * @returns {{prefixes:Object<string,string|null>, conflicts:Array, invalid:Array}}
 */
function resolvePrefixes(overrides = {}) {
  const source = isPlainObject(overrides) ? overrides : {};
  const scopes = Object.keys(DEFAULT_PREFIXES);
  const prefixes = {};
  const conflicts = [];
  const invalid = [];
  const owner = new Map();

  const reserve = (scope, word) => {
    const key = word.toLowerCase();
    const takenBy = owner.get(key);
    if (takenBy) return takenBy;
    owner.set(key, scope);
    prefixes[scope] = word;
    return null;
  };

  // 阶段 1：没配自定义（或配了空值）的范围先拿默认值。
  const candidates = {};
  for (const scope of scopes) {
    const has = Object.prototype.hasOwnProperty.call(source, scope);
    const candidate = has ? prefixCandidate(source[scope]) : { word: null, empty: true, illegal: false };
    candidates[scope] = candidate;
    if (has && candidate.illegal) invalid.push({ scope, value: source[scope] });
    if (!candidate.word) reserve(scope, DEFAULT_PREFIXES[scope]);
  }

  // 阶段 2：自定义值占位，撞车就回退默认。
  for (const scope of scopes) {
    const candidate = candidates[scope];
    if (!candidate.word) continue;
    const clash = reserve(scope, candidate.word);
    if (!clash) continue;
    conflicts.push({ word: candidate.word, kept: clash, dropped: scope });
    const fallback = DEFAULT_PREFIXES[scope];
    if (reserve(scope, fallback)) {
      // 自己的默认值也被占了：这个范围只能暂时锁不上。
      prefixes[scope] = null;
    }
  }

  return { prefixes, conflicts, invalid };
}

/** 某个 provider 要注册的全部别名（多 scope 的取并集）。 */
function aliasesFor(prefixes, scopes) {
  const out = [];
  const seen = new Set();
  for (const scope of scopes) {
    const word = prefixes?.[scope];
    if (typeof word !== 'string' || !word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

/** 首词命中哪个 scope；没命中返回 null。 */
function scopeForWord(prefixes, word) {
  const key = String(word ?? '').trim().toLowerCase();
  if (!key) return null;
  for (const [scope, prefix] of Object.entries(prefixes ?? {})) {
    if (typeof prefix === 'string' && prefix.toLowerCase() === key) return scope;
  }
  return null;
}

/** 某范围当前的前缀；没有就返回空串。 */
function prefixOf(prefixes, scope) {
  const word = prefixes?.[scope];
  return typeof word === 'string' ? word : '';
}

/** 空状态提示需要的 [{scope,label,prefix}]，顺序固定，便于界面和测试对齐。 */
function hintEntries(prefixes) {
  return Object.keys(SCOPE_LABEL)
    .map((scope) => ({ scope, label: SCOPE_LABEL[scope], prefix: prefixOf(prefixes, scope) }))
    .filter((entry) => entry.prefix);
}

/** 与默认值比较（大小写不敏感）。 */
function isDefault(prefixes, scope) {
  return String(prefixes?.[scope] ?? '').toLowerCase() === DEFAULT_PREFIXES[scope].toLowerCase();
}

/**
 * 只挑出与默认值不同的 scope，用来写回 config.json。
 * 全默认时返回空对象——配置文件里不需要留一份九项默认值的副本。
 */
function diffPrefixes(prefixes) {
  const out = {};
  for (const scope of Object.keys(DEFAULT_PREFIXES)) {
    const word = prefixes?.[scope];
    if (typeof word !== 'string' || !word) continue;
    if (!isDefault(prefixes, scope)) out[scope] = word;
  }
  return out;
}

module.exports = {
  DEFAULT_PREFIXES,
  SCOPE_LABEL,
  WEB_SCOPES,
  isPrefixWord,
  normalizePrefix,
  resolvePrefixes,
  aliasesFor,
  scopeForWord,
  prefixOf,
  hintEntries,
  isDefault,
  diffPrefixes,
};
