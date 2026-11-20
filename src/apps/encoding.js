'use strict';

/**
 * Windows ANSI 代码页解码。
 *
 * 问题：.lnk 里的 "LocalBasePath" 用的是系统 ANSI 代码页，不是 UTF-8。
 * 这台机器上是 GBK。用 latin1 直接解会得到 `D:\Èí¼þ\Everything\...`
 * 这种乱码 —— 本机 Everything 的快捷方式实测就是这个形态。
 *
 * 做法：不猜代码页，而是**按优先顺序试解，并用"路径在磁盘上是否存在"自校验**。
 * 这比读注册表可靠（Node 没有内置 Win32 注册表 API），也自然适配任何语言的系统。
 * 全部解不出来时退回 latin1，保证 ASCII 部分永远是正确的。
 */

/** 尝试顺序：中文 Windows 最常见，其次西欧，最后 latin1 兜底。 */
const CANDIDATE_LABELS = ['gbk', 'big5', 'shift_jis', 'windows-1252', 'utf-8', 'latin1'];

/** TextDecoder 标签是否可用（构造时不校验，必须真解一次）。 */
function isLabelSupported(label) {
  try {
    const decoder = new TextDecoder(label, { fatal: false });
    decoder.decode(Buffer.from([0x41, 0x42]));
    return true;
  } catch {
    return false;
  }
}

let supportedLabels;

function getSupportedLabels() {
  if (!supportedLabels) {
    supportedLabels = CANDIDATE_LABELS.filter(isLabelSupported);
    if (supportedLabels.length === 0) supportedLabels = ['latin1'];
    // latin1 一定可用，放到最后作为兜底。
    supportedLabels = supportedLabels.filter((l) => l !== 'latin1').concat('latin1');
  }
  return supportedLabels;
}

/**
 * 按单个编码解码。
 * @param {Buffer} buffer
 * @param {string} label
 */
function decodeWith(buffer, label) {
  const decoder = new TextDecoder(label, { fatal: false });
  return decoder.decode(buffer).replace(/\0+$/, '');
}

/**
 * 把所有候选编码都试一遍，按优先顺序返回去重后的结果。
 * 调用方可用 exists() 挑第一个真实存在的路径。
 * @param {Buffer} buffer
 * @returns {Array<{text:string, label:string}>}
 */
function decodeCandidates(buffer) {
  const seen = new Set();
  const out = [];
  for (const label of getSupportedLabels()) {
    let text;
    try {
      text = decodeWith(buffer, label);
    } catch {
      continue;
    }
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, label });
  }
  return out;
}

/**
 * 解码一个 ANSI 路径，并用 exists 自校验。
 * 第一个在磁盘上存在的解码结果胜出；都不存在（比如目标已卸载）时，
 * 返回优先顺序里的第一个——宁可显示一个可能不准的路径，也不要空着。
 *
 * @param {Buffer} buffer
 * @param {(p:string)=>boolean} [exists] 判定函数，默认 fs.existsSync
 */
function decodeAnsiPath(buffer, exists) {
  const candidates = decodeCandidates(buffer);
  if (candidates.length === 0) return { text: buffer.toString('latin1'), label: 'latin1', verified: false };
  const check = typeof exists === 'function' ? exists : defaultExists;
  for (const candidate of candidates) {
    if (check(candidate.text)) {
      return { text: candidate.text, label: candidate.label, verified: true };
    }
  }
  return { text: candidates[0].text, label: candidates[0].label, verified: false };
}

let cachedExists;
function defaultExists() {
  if (!cachedExists) {
    const fs = require('node:fs');
    cachedExists = (p) => {
      if (!p || typeof p !== 'string') return false;
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    };
  }
  return cachedExists;
}

/** 简化的解码入口：只要字符串。 */
function decodeAnsi(buffer, exists) {
  return decodeAnsiPath(buffer, exists).text;
}

module.exports = {
  decodeAnsi,
  decodeAnsiPath,
  decodeCandidates,
  getSupportedLabels,
  CANDIDATE_LABELS,
};
