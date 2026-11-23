'use strict';

/**
 * 汉字 → 拼音首字母（只取首字母，不做全拼）。
 *
 * 用途：本地联系人支持 "hp" → 庄浩鹏 这类输入，不用走网络。
 *
 * 实现：GB2312 一级汉字（0xB0A1–0xD7F9）本身就是按拼音排序的，
 * 每个字母（a/b/c/…/z）占一段连续区间。把这段字节一次性解码成字符、
 * 按区间贴上字母，就是一张 6763 字的表。
 *
 * 为什么不用 Intl.Collator('zh-u-co-pinyin')：实测 collator 对同音字
 * 给出不确定的相对顺序（他/塌、张/庄），无法可靠地反推首字母。
 *
 * 表在第一次调用时才建（约几十毫秒），之后只做 Map 查找。
 * 二级汉字与生僻字不在表内，返回空串——退化为原来的匹配方式。
 */

/** 各拼音字母在 GB2312 一级汉字里的起始字节（含），按字节升序。 */
const LETTER_RANGES = [
  [0xb0a1, 'a'],
  [0xb0c5, 'b'],
  [0xb2c1, 'c'],
  [0xb4ee, 'd'],
  [0xb6ee, 'e'],
  [0xb7a2, 'f'],
  [0xb8c1, 'g'],
  [0xb9fe, 'h'],
  [0xbbf7, 'j'],
  [0xbfc8, 'k'],
  [0xc0ac, 'l'],
  [0xc2e8, 'm'],
  [0xc4c3, 'n'],
  [0xc5b6, 'o'],
  [0xc5f4, 'p'],
  [0xc6da, 'q'],
  [0xc8bb, 'r'],
  [0xc8f6, 's'],
  [0xcbfe, 't'],
  [0xcdda, 'w'],
  [0xcef4, 'x'],
  [0xd1b9, 'y'],
  [0xd4d1, 'z'],
];

/** GB2312 一级汉字的字节范围。 */
const FIRST_LEVEL_START = 0xb0a1;
const FIRST_LEVEL_END = 0xd7f9;

/** @type {Map<string, string>|null} */
let table = null;

function buildTable() {
  const map = new Map();
  let decoder;
  try {
    decoder = new TextDecoder('gbk');
  } catch {
    return map; // 运行时没有 GBK 解码器就退化：返回空表
  }
  const bytes = [];
  const codes = [];
  for (let hi = FIRST_LEVEL_START >> 8; hi <= FIRST_LEVEL_END >> 8; hi += 1) {
    for (let lo = 0xa1; lo <= 0xfe; lo += 1) {
      const code = (hi << 8) | lo;
      if (code < FIRST_LEVEL_START || code > FIRST_LEVEL_END) continue;
      bytes.push(hi, lo);
      codes.push(code);
    }
  }
  const decoded = decoder.decode(new Uint8Array(bytes));
  const chars = Array.from(decoded);
  for (let i = 0; i < chars.length && i < codes.length; i += 1) {
    const code = codes[i];
    let letter = '';
    for (const [start, value] of LETTER_RANGES) {
      if (code >= start) letter = value;
      else break;
    }
    if (letter && !map.has(chars[i])) map.set(chars[i], letter);
  }
  return map;
}

function initialOfChar(char) {
  if (!table) table = buildTable();
  return table.get(char) ?? '';
}

/** 是否是需要查表的汉字区段（CJK 统一汉字基本区）。 */
function isCjk(char) {
  const code = char.codePointAt(0);
  return code >= 0x4e00 && code <= 0x9fff;
}

/**
 * 取一段文本的拼音首字母串（小写）。
 * 只保留汉字的首字母；其它字符（空格、英文、符号）跳过。
 * 没有可映射的汉字时返回空串。
 */
function pinyinInitials(text) {
  const source = String(text ?? '').trim();
  if (!source) return '';
  let out = '';
  for (const char of source) {
    if (!isCjk(char)) continue;
    out += initialOfChar(char);
  }
  return out;
}

module.exports = { pinyinInitials, initialOfChar };
