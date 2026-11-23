'use strict';

/**
 * 查询解析。
 *
 * 输入框里的字符串 → { terms, providerHint }
 *
 * 约定（沿用 Flow Launcher 最常用的那套手感）：
 *   "chr"        → 普通查询，所有 provider 都参与
 *   "> cmd"      → 以 '>' 开头，强制走命令 provider
 *   "app chr"    → 首词是 provider 名或别名，锁定该 provider，剩余词是查询
 *   "计算 1+1"   → 同上，用别名
 *
 * 解析只认"首词 + 空格"，不做更复杂的语法——启动器打字时不该有惊喜。
 */

/** 触发字符：只影响 hint，不剥掉内容。 */
const TRIGGER_PREFIX = {
  '>': 'shell',
  '=': 'calc',
  '?': 'web',
  '~': 'clipboard',
};

/**
 * 把输入拆成词元，保留引号内的整体。
 * 支持 "foo bar" 这样的引号短语，以及多余空白。
 */
function tokenize(input) {
  const text = String(input ?? '');
  const tokens = [];
  let current = '';
  let quote = null;
  let hasContent = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
        hasContent = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += ch;
    hasContent = true;
  }
  if (hasContent) tokens.push(current);
  return tokens;
}

/**
 * 解析查询。
 * @param {string} input 原始输入
 * @param {Array<{id:string, aliases?:string[]}>} providers 已注册的 provider
 * @returns {{raw:string, terms:string[], providerHint:string|null, alias:string|null, keyword:string}}
 */
function parseQuery(input, providers = []) {
  const raw = String(input ?? '');
  const trimmed = raw.trim();

  if (!trimmed) {
    return { raw, terms: [], providerHint: null, alias: null, keyword: '' };
  }

  const firstChar = trimmed[0];
  const trigger = TRIGGER_PREFIX[firstChar];
  if (trigger) {
    const rest = trimmed.slice(1).trim();
    return {
      raw,
      terms: tokenize(rest),
      providerHint: trigger,
      alias: null,
      keyword: rest,
    };
  }

  const tokens = tokenize(trimmed);
  if (tokens.length > 1) {
    const head = tokens[0].toLowerCase();
    const matched = findProvider(head, providers);
    if (matched) {
      const rest = tokens.slice(1);
      return {
        raw,
        terms: rest,
        providerHint: matched,
        // 命中的原词。同一个 provider 可能有多个别名（网页 vs 收藏夹），
        // provider 靠它进一步收窄范围；只拿 id 分不出来。
        alias: head,
        keyword: rest.join(' '),
      };
    }
  }

  return { raw, terms: tokens, providerHint: null, alias: null, keyword: trimmed };
}

/** 首词命中 provider 的 id 或任一别名（大小写不敏感）。 */
function findProvider(word, providers) {
  if (!word) return null;
  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string') continue;
    if (provider.id.toLowerCase() === word) return provider.id;
    // 前缀可在设置页里改，aliases 允许是函数（每次现取最新值）。
    const raw = typeof provider.aliases === 'function' ? provider.aliases() : provider.aliases;
    const aliases = Array.isArray(raw) ? raw : [];
    for (const alias of aliases) {
      if (String(alias).toLowerCase() === word) return provider.id;
    }
  }
  return null;
}

module.exports = { tokenize, parseQuery, findProvider, TRIGGER_PREFIX };
