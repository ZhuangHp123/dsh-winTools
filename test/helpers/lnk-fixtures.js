'use strict';

/**
 * 构造合成 .lnk 二进制的帮助函数。
 *
 * 单独抽出来是因为 lnk.test.js 和 appProvider.test.js 都要造快捷方式。
 * 这里只造**结构正确的最小 .lnk**，不依赖任何真实文件。
 */

const HEADER_SIZE = 0x4c;

/** LinkFlags 位。 */
const FLAG_ID_LIST = 0x01;
const FLAG_LINK_INFO = 0x02;
const FLAG_NAME = 0x04;
const FLAG_RELATIVE_PATH = 0x08;
const FLAG_WORKING_DIR = 0x10;
const FLAG_ARGUMENTS = 0x20;
const FLAG_ICON = 0x40;
const FLAG_UNICODE = 0x80;

/** 造 ShellLinkHeader 骨架。 */
function makeHeader(linkFlags) {
  const buffer = Buffer.alloc(HEADER_SIZE);
  buffer.writeUInt32LE(HEADER_SIZE, 0);
  buffer.writeUInt32LE(linkFlags, 0x14);
  return buffer;
}

/**
 * 造 LinkInfo 段（ANSI LocalBasePath）。
 * @param {string} localBasePath
 * @param {string} [suffix]
 */
function makeLinkInfo(localBasePath, suffix = '') {
  const headerSize = 0x1c;
  const volumeId = Buffer.alloc(0x10);
  const ansiBase = Buffer.from(`${localBasePath}\0`, 'latin1');
  const ansiSuffix = Buffer.from(`${suffix}\0`, 'latin1');
  const total = headerSize + volumeId.length + ansiBase.length + ansiSuffix.length;

  const buffer = Buffer.alloc(total);
  buffer.writeUInt32LE(total, 0);
  buffer.writeUInt32LE(headerSize, 4);
  buffer.writeUInt32LE(0x01, 8); // VolumeIDAndLocalBasePath

  const volumeIdOffset = headerSize;
  const localBasePathOffset = volumeIdOffset + volumeId.length;
  const suffixOffset = localBasePathOffset + ansiBase.length;
  buffer.writeUInt32LE(volumeIdOffset, 12);
  buffer.writeUInt32LE(localBasePathOffset, 16);
  buffer.writeUInt32LE(0, 20);
  buffer.writeUInt32LE(suffixOffset, 24);

  ansiBase.copy(buffer, localBasePathOffset);
  ansiSuffix.copy(buffer, suffixOffset);
  return buffer;
}

/** 造一个带 LinkInfo 目标的完整 .lnk。 */
function makeLnk(targetPath) {
  return Buffer.concat([makeHeader(FLAG_LINK_INFO), makeLinkInfo(targetPath)]);
}

module.exports = {
  HEADER_SIZE,
  FLAG_ID_LIST,
  FLAG_LINK_INFO,
  FLAG_NAME,
  FLAG_RELATIVE_PATH,
  FLAG_WORKING_DIR,
  FLAG_ARGUMENTS,
  FLAG_ICON,
  FLAG_UNICODE,
  makeHeader,
  makeLinkInfo,
  makeLnk,
};
