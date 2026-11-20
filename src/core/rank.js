'use strict';

/**
 * 结果排序。
 *
 * 输入：各 provider 给出的候选列表
 * 输出：排好序、去重、截断后的结果列表
 *
 * 排序由三部分构成：
 *   1. 文本匹配分（fuzzy.js）
 *   2. 使用习惯分（frecency：用得越多、越近，越靠前）
 *   3. provider 的基础权重（应用 > 文件 > 剪贴板，避免文件把应用挤下去）
 *
 * 三者相加后排序。使用习惯分被刻意压在 120 以内——它能改变"差不多的两个
 * 结果"之间的顺序，但翻不了质：输入完全匹配时，不该被一个常点的弱匹配顶掉。
 */

const { scoreFields } = require('./fuzzy');

/** 使用习惯分的上限，见文件头注释。 */
const USAGE_LIMIT = 120;

/** 每类 provider 的基础权重，决定不同来源混排时谁优先。 */
const DEFAULT_PROVIDER_WEIGHT = {
  app: 60,
  project: 50,
  chrome: 30,
  dingtalk: 40,
  dingdoc: 20,
  file: 0,
  clipboard: -20,
  calc: 200,
  shell: 10,
  web: -10,
};

/** 默认结果条数上限。 */
const DEFAULT_LIMIT = 9;

/**
 * 远程 provider（钉钉）已经按服务端规则命中过的条目，本地模糊匹配不一定能复现：
 * 联系人支持拼音首字母（hp → 庄浩鹏），文档按正文检索（标题里没有关键词）。
 * 这类条目给一个低于 subsequence 档的保底分，保证它们能出现，但排在本地标题命中之后。
 */
const SERVER_MATCH_SCORE = 260;

/**
 * frecency：最近 + 频繁。
 * @param {{count:number, lastUsed:number}} usage
 * @param {number} now 毫秒时间戳（显式传入，便于测试）
 */
function usageScore(usage, now) {
  if (!usage || !usage.count || usage.count <= 0) return 0;
  const count = usage.count;
  const lastUsed = Number(usage.lastUsed) || 0;
  const ageDays = lastUsed > 0 ? Math.max(0, (now - lastUsed) / 86400000) : 365;

  // 频繁度：对数增长，避免一次暴涨碾压一切。30 次约到满格。
  const frequency = Math.min(1, Math.log1p(count) / Math.log1p(30));

  // 新鲜度：半衰期 7 天。
  const freshness = Math.pow(0.5, ageDays / 7);

  // 只用后两者相乘，频率高但很久没用的会自然掉下去。
  return Math.round(USAGE_LIMIT * frequency * (0.35 + 0.65 * freshness));
}

/**
 * 给单个候选打分。
 * 候选至少要有 title；tags/subtitle/path 参与次级匹配。
 * @returns {number|null} null 表示不匹配
 */
function scoreCandidate(terms, candidate, options = {}) {
  const { usageStore, providerWeights, now } = options;

  const fields = [{ text: String(candidate.title ?? ''), weight: 1 }];
  if (candidate.subtitle) fields.push({ text: String(candidate.subtitle), weight: 0.35 });
  if (candidate.path) fields.push({ text: String(candidate.path), weight: 0.25 });
  if (Array.isArray(candidate.tags)) {
    for (const tag of candidate.tags) {
      if (tag) fields.push({ text: String(tag), weight: 0.3 });
    }
  }

  // altTitles：和标题一样能独立命中，但分数打折——网页条目搜 "dingtalk"
  // 时标题里没有域名，只能靠 URL 命中；折扣保证标题命中仍然优先。
  let hit = scoreFields(terms, fields);
  if (!hit && Array.isArray(candidate.altTitles)) {
    for (const alt of candidate.altTitles) {
      if (!alt) continue;
      const altHit = scoreFields(terms, [{ text: String(alt), weight: 1 }]);
      if (altHit && (!hit || altHit.score > hit.score)) hit = { score: altHit.score * 0.75 };
    }
  }
  // 服务端已命中（拼音 / 正文检索）但本地匹配不上的，保底收录，见 SERVER_MATCH_SCORE。
  if (!hit && candidate.serverMatched) hit = { score: SERVER_MATCH_SCORE };
  if (!hit) return null;

  const providerId = candidate.provider ?? '';
  const weightMap = providerWeights ?? DEFAULT_PROVIDER_WEIGHT;
  const providerBonus = weightMap[providerId] ?? 0;

  let usageBonus = 0;
  if (usageStore) {
    const usage = usageStore.get(candidate.id);
    usageBonus = usageScore(usage, now ?? Date.now());
  }

  return hit.score + providerBonus + usageBonus;
}

/** 候选的稳定标识：优先用显式 id，否则由 provider + 标题派生。 */
function candidateKey(candidate) {
  if (candidate.id) return String(candidate.id);
  return `${candidate.provider ?? 'unknown'}:${String(candidate.title ?? '')}`;
}

/**
 * 对候选池排序。
 * @param {string[]} terms 查询词元
 * @param {Array<object>} candidates
 * @param {object} options { usageStore, providerWeights, now, limit }
 * @returns {Array<object>} 已排序并附带 score 的候选副本
 */
function rankCandidates(terms, candidates, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : DEFAULT_LIMIT;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  // 空查询：不算分，只按使用习惯 + provider 权重排（用于"刚打开时展示常用"）。
  if (!Array.isArray(terms) || terms.length === 0) {
    const scored = candidates.map((candidate, index) => {
      const usage = options.usageStore?.get(candidateKey(candidate));
      const base = usageScore(usage, options.now ?? Date.now());
      const providerBonus =
        (options.providerWeights ?? DEFAULT_PROVIDER_WEIGHT)[candidate.provider] ?? 0;
      return { candidate, score: base + providerBonus, index };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.slice(0, limit).map(({ candidate, score }) => ({ ...candidate, score }));
  }

  const scored = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const score = scoreCandidate(terms, candidate, options);
    if (score === null) continue;
    scored.push({ candidate, score, index });
  }

  // 去重：同一 key 只保留分最高的（同分保留先出现的）。
  const best = new Map();
  for (const entry of scored) {
    const key = candidateKey(entry.candidate);
    const existing = best.get(key);
    if (!existing || entry.score > existing.score) best.set(key, entry);
  }

  const deduped = [...best.values()];
  deduped.sort((a, b) => b.score - a.score || a.index - b.index);
  return deduped.slice(0, limit).map(({ candidate, score }) => ({ ...candidate, score }));
}

module.exports = {
  USAGE_LIMIT,
  DEFAULT_LIMIT,
  DEFAULT_PROVIDER_WEIGHT,
  usageScore,
  scoreCandidate,
  candidateKey,
  rankCandidates,
};
