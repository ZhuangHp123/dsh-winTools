'use strict';

/**
 * 模糊匹配与打分。
 *
 * 这是启动器的核心：输入几个字符，要能把最可能的结果排到最前面。
 * 纯函数、无 I/O、无 Electron 依赖，全部可单测。
 *
 * 打分分层（tier 之间刻意留出足够间隙，保证"更好的匹配类型"永远赢过
 * "更差的匹配类型 + 位置加成"）：
 *   exact       1000  目标与输入完全相同
 *   prefix       800  目标以输入开头
 *   wordStart    650  输入落在某个词的开头（含 camelCase / 数字边界）
 *   substring    500  输入出现在目标中间
 *   subsequence  300  输入字符按顺序散落在目标里
 *
 * 每层的调整项总和被限制在 [-60, +60]，远小于层间距（最小 150），
 * 所以跨层顺序是稳定的。
 */

const TIER = Object.freeze({
  EXACT: 1000,
  PREFIX: 800,
  WORD_START: 650,
  SUBSTRING: 500,
  SUBSEQUENCE: 300,
});

const ADJUST_LIMIT = 60;

/** 分词边界字符：命中这些字符后面的位置算"词首"。 */
const SEPARATOR = /[\s\-_./\\:()[\]{},+~!@#$%^&*=|"'<>?;`\u3000]/;

/**
 * 判断 index 处是否是一个词的开头。
 * 覆盖三种边界：字符串开头、分隔符之后、camelCase/数字↔字母 的转折处。
 */
function isBoundary(text, index) {
  if (index <= 0) return true;
  const prev = text[index - 1];
  const cur = text[index];
  if (SEPARATOR.test(prev)) return true;
  const prevIsLower = prev !== prev.toUpperCase() && prev === prev.toLowerCase();
  const curIsUpper = cur !== cur.toLowerCase();
  if (prevIsLower && curIsUpper) return true;
  // 数字与字母的交界两侧都算边界：version2 / 2version 都该能按词首命中。
  const prevIsDigit = prev >= '0' && prev <= '9';
  const curIsDigit = cur >= '0' && cur <= '9';
  if (prevIsDigit !== curIsDigit) return true;
  return false;
}

/** 贪心求子序列各字符的位置；匹配不上返回 null。 */
function subsequencePositions(needle, haystack) {
  const positions = [];
  let hi = 0;
  for (let ni = 0; ni < needle.length; ni += 1) {
    const ch = needle[ni];
    let found = -1;
    for (; hi < haystack.length; hi += 1) {
      if (haystack[hi] === ch) {
        found = hi;
        hi += 1;
        break;
      }
    }
    if (found === -1) return null;
    positions.push(found);
  }
  return positions;
}

function clampAdjust(value) {
  if (value > ADJUST_LIMIT) return ADJUST_LIMIT;
  if (value < -ADJUST_LIMIT) return -ADJUST_LIMIT;
  return value;
}

/** 目标越长，含着同样的输入越"不值钱"。 */
function lengthPenalty(textLength, termLength) {
  return Math.min(45, Math.max(0, textLength - termLength) * 0.3);
}

/** 区分大小写时给出一点加分：用户真按 shift 打了大写，通常是有意的。 */
function caseBonus(term, text, index) {
  if (!term || !text) return 0;
  if (term === term.toLowerCase()) return 0;
  return text.slice(index, index + term.length) === term ? 12 : 0;
}

/**
 * 单个词元对单段文本打分。匹配不上返回 null。
 * @returns {{score:number, positions:number[]}|null}
 */
function scoreTerm(term, text) {
  if (!term || !text) return null;
  const needle = term.toLowerCase();
  const haystack = text.toLowerCase();
  if (!haystack) return null;

  if (haystack === needle) {
    // 完全相同也尊重大小写：用户按了 shift 多半是有意的。
    return {
      score: TIER.EXACT + caseBonus(term, text, 0),
      positions: range(0, needle.length),
    };
  }

  const firstIndex = haystack.indexOf(needle);

  if (firstIndex === 0) {
    const adjust =
      20 - lengthPenalty(haystack.length, needle.length) + caseBonus(term, text, 0);
    return { score: TIER.PREFIX + clampAdjust(adjust), positions: range(0, needle.length) };
  }

  // 优先找"词首"出现点，比任意位置的 substr 更符合直觉。
  if (firstIndex > 0) {
    let boundaryIndex = -1;
    let from = firstIndex;
    while (from !== -1) {
      if (isBoundary(haystack, from)) {
        boundaryIndex = from;
        break;
      }
      from = haystack.indexOf(needle, from + 1);
    }
    if (boundaryIndex >= 0) {
      const adjust =
        Math.max(0, 40 - boundaryIndex) -
        lengthPenalty(haystack.length, needle.length) +
        caseBonus(term, text, boundaryIndex);
      return {
        score: TIER.WORD_START + clampAdjust(adjust),
        positions: range(boundaryIndex, needle.length),
      };
    }
    const adjust =
      Math.max(0, 40 - firstIndex) -
      lengthPenalty(haystack.length, needle.length) +
      caseBonus(term, text, firstIndex);
    return {
      score: TIER.SUBSTRING + clampAdjust(adjust),
      positions: range(firstIndex, needle.length),
    };
  }

  const positions = subsequencePositions(needle, haystack);
  if (!positions) return null;
  const span = positions[positions.length - 1] - positions[0] + 1;
  const gaps = span - needle.length;
  const compactness = Math.max(0, 40 - gaps * 5);
  const startsOnBoundary = isBoundary(haystack, positions[0]) ? 15 : 0;
  const adjust = compactness + startsOnBoundary - lengthPenalty(haystack.length, needle.length);
  return { score: TIER.SUBSEQUENCE + clampAdjust(adjust), positions };
}

function range(start, length) {
  const out = new Array(length);
  for (let i = 0; i < length; i += 1) out[i] = start + i;
  return out;
}

/**
 * 多词元对单段文本打分：所有词元都必须命中，分数累加。
 * 额外给"各词元按顺序出现"一点加分（用户通常按出现顺序打字）。
 */
function scoreTerms(terms, text) {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  if (!text) return null;
  let total = 0;
  const positions = [];
  let lastEnd = -1;
  let ordered = true;
  for (const term of terms) {
    const hit = scoreTerm(term, text);
    if (!hit) return null;
    total += hit.score;
    if (hit.positions[0] < lastEnd) ordered = false;
    lastEnd = hit.positions[hit.positions.length - 1];
    positions.push(...hit.positions);
  }
  if (ordered && terms.length > 1) total += 20;
  return { score: total, positions };
}

/**
 * 对一条候选的多个字段打分。
 * fields: [{ text, weight }]，weight 用来压低次要字段（比如路径之于文件名）。
 * 主字段（第一个）必须命中；其余字段命中只加分。
 */
function scoreFields(terms, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const [primary, ...rest] = fields;
  const primaryHit = scoreTerms(terms, primary.text);
  if (!primaryHit) return null;
  let total = primaryHit.score * (primary.weight ?? 1);
  for (const field of rest) {
    const hit = scoreTerms(terms, field.text);
    if (hit) total += hit.score * (field.weight ?? 0.5);
  }
  return { score: total, positions: primaryHit.positions };
}

module.exports = {
  TIER,
  isBoundary,
  subsequencePositions,
  scoreTerm,
  scoreTerms,
  scoreFields,
};
