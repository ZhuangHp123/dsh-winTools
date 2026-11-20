'use strict';

/**
 * Windows 快捷方式（.lnk）解析。
 *
 * 不依赖任何第三方库，自己按 [MS-SHLLINK] 规范读出目标路径。
 * 只需要 TargetPath 这一项，所以不做完整实现，只覆盖实际会遇到的形态：
 *   - 有 LinkInfo 结构（指向本地文件）→ 从 LinkInfo 里读 LocalBasePath
 *   - 只有 RELATIVE_PATH 字符串 → 拼接到 .lnk 自身目录
 *   - 目标本身是 UWP / MSI / 环境变量 → 尽力而为，失败返回 null
 *
 * 所有函数是纯函数（输入 Buffer，输出字符串），可以拿真实 .lnk 做单测。
 */

const { decodeAnsiPath } = require('./encoding');

/** LinkInfo 结构里 volume ID 之后可能出现的偏移量字段位置。 */
const LINK_INFO_HEADER_SIZE = 0x1C;

/**
 * 从 .lnk 的二进制内容中提取目标路径。
 *
 * 同一个 .lnk 里往往有多个"目标线索"同时存在（LinkInfo、环境变量块、
 * 相对路径、IDList），它们的可信度并不相同，甚至互相矛盾：
 * Adobe 那种 MSI 广告型快捷方式的 IDList 解析出来是垃圾，而 RELATIVE_PATH
 * 是对的。所以这里不安逸于第一个非空结果，而是把所有线索按可信度排队，
 * 能验证的（路径真实存在）优先采用。
 *
 * @param {Buffer} buffer .lnk 文件内容
 * @param {{exists?:(p:string)=>boolean, lnkPath?:string, env?:object}} [options]
 *   exists 用于 ANSI 路径自校验与候选裁决；lnkPath 用于解析相对路径；
 *   env 用于展开环境变量与修复陈旧用户名路径
 * @returns {string|null} 目标路径；解析不出时返回 null
 */
function parseLnkTarget(buffer, options = {}) {
  const candidates = parseLnkTargetCandidates(buffer, options);
  if (candidates.length === 0) return null;

  const exists = typeof options.exists === 'function' ? options.exists : defaultExists();
  const env = options.env ?? process.env;

  const resolved = [];
  for (const raw of candidates) {
    let target = expandEnvVars(raw, env);
    target = resolveRelativePath(target, options.lnkPath);
    target = repairUserProfilePath(target, env, exists);
    if (target) resolved.push(target);
  }
  if (resolved.length === 0) return null;

  // 有多个线索时，谁在磁盘上真实存在就信谁；都不存在就按可信度取第一个，
  // 至少保证界面上能显示一个像样的名字（启动一律走 .lnk 本身，不依赖它）。
  const verified = resolved.find((target) => exists(target));
  return verified ?? resolved[0];
}

/**
 * 按可信度从高到低给出所有解析出的目标线索（不做环境变量展开等修正）。
 *
 * 顺序的由来：
 *   1. LinkInfo —— 结构最完整，Windows 自己首选。
 *   2. ExtraData 的环境变量块 —— 形如 %windir%\system32\osk.exe，直白且准确。
 *   3. RELATIVE_PATH —— 显式写出的相对路径，比 IDList 可靠。
 *   4. LinkTargetIDList —— 只能靠 shell item 猜，实测最容易出错
 *      （Adodbe 的广告型快捷方式会解析出 `...\!` 这种垃圾）。
 *
 * @param {Buffer} buffer
 * @param {{exists?:(p:string)=>boolean}} [options]
 * @returns {string[]}
 */
function parseLnkTargetCandidates(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x4C) return [];

  const headerSize = buffer.readUInt32LE(0);
  if (headerSize !== 0x4C) return [];

  const linkFlags = buffer.readUInt32LE(0x14);
  const hasLinkTargetIDList = (linkFlags & 0x01) !== 0;
  const hasLinkInfo = (linkFlags & 0x02) !== 0;

  const candidates = [];
  let offset = headerSize;

  // 跳过 LinkTargetIDList（CLSID 是变长的，按 IDListSize 精确跳过）。
  if (hasLinkTargetIDList) {
    if (offset + 2 > buffer.length) return candidates;
    const idListSize = buffer.readUInt16LE(offset);
    offset += 2 + idListSize;
  }

  let linkInfoSkipped = false;
  if (hasLinkInfo && offset + LINK_INFO_HEADER_SIZE <= buffer.length) {
    const target = readLinkInfo(buffer, offset, options);
    if (target) candidates.push(target);
    const linkInfoSize = buffer.readUInt32LE(offset);
    // 防御：LinkInfoSize 明显超界说明结构坏了，别再拿它推进偏移。
    if (linkInfoSize >= LINK_INFO_HEADER_SIZE && offset + linkInfoSize <= buffer.length) {
      offset += linkInfoSize;
    } else {
      linkInfoSkipped = true;
    }
  }
  if (linkInfoSkipped) return candidates;

  // 这 6 个可选 StringData 字段按固定顺序排列，必须**逐个跳过**才能算准
  // ExtraData 的起点。只跳 Name 会让后面的偏移全错——本机"屏幕键盘"
  // 的快捷方式就是这样拿不到目标的。
  const stringDataFlags = [
    0x00000004, // NAME_STRING
    0x00000008, // RELATIVE_PATH
    0x00000010, // WORKING_DIR
    0x00000020, // COMMAND_LINE_ARGUMENTS
    0x00000040, // ICON_LOCATION
  ];
  let relativePath = null;
  for (const flag of stringDataFlags) {
    if (!(linkFlags & flag)) continue;
    const stringData = readStringData(buffer, offset, linkFlags);
    offset = stringData.nextOffset;
    if (flag === 0x00000008 && stringData.value) relativePath = stringData.value;
  }

  // ExtraData：目标可能藏在 EnvironmentVariableDataBlock 里，本机的
  // "屏幕键盘""命令提示符"都是这个形态，实测确认。
  const fromExtra = parseExtraDataTarget(buffer, offset);
  if (fromExtra) candidates.push(fromExtra);

  if (relativePath) candidates.push(relativePath);

  if (hasLinkTargetIDList) {
    const fromIdList = parseIdListPath(buffer, headerSize);
    if (fromIdList) candidates.push(fromIdList);
  }

  return candidates;
}

/** 只要最可信的那一个线索（不做修正），便于单测各步骤。 */
function parseLnkTargetRaw(buffer, options = {}) {
  return parseLnkTargetCandidates(buffer, options)[0] ?? null;
}

/** Shell item 类型：驱动器 / 目录 / 文件；root folder 是只有 CLSID 的占位项。 */
const ITEM_ROOT_FOLDER = 0x1f;
const ITEM_DRIVE = 0x2f;
const ITEM_FILE_ENTRY = 0x31;
const ITEM_FILE_ENTRY_2 = 0x32;

/**
 * 从 FileEntry 项里取文件名。
 *
 * 起始位置之后可能还有 0~2 字节的扩展属性/保留字段，值都是 0 或小整数，
 * 不可能出现在合法文件名的开头，所以跳过开头的控制字节即可对齐到名称。
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {string} 文件名；读不到返回空串
 */
function readEntryName(buffer, start, end) {
  let offset = start;
  while (offset < end && buffer[offset] < 0x20) offset += 1;
  if (offset >= end) return '';
  let stop = offset;
  while (stop < end && buffer[stop] !== 0) stop += 1;
  const raw = buffer.subarray(offset, stop);
  if (raw.length === 0) return '';
  return decodeAnsiPath(raw).text;
}

/**
 * 从 LinkTargetIDList 还原一个 DOS 路径。
 * 只处理最常见的三种 shell item；遇到其它类型就放弃（返回 null），
 * 让上层退回到"直接 shell 启动 .lnk"这条永远可用的路。
 *
 * @param {Buffer} buffer
 * @param {number} headerSize
 * @returns {string|null}
 */
function parseIdListPath(buffer, headerSize) {
  if (headerSize + 2 > buffer.length) return null;
  const idListSize = buffer.readUInt16LE(headerSize);
  const start = headerSize + 2;
  const end = Math.min(start + idListSize, buffer.length);

  let offset = start;
  let drive = '';
  const parts = [];

  for (let guard = 0; guard < 64; guard += 1) {
    if (offset + 3 > end) break;
    const itemSize = buffer.readUInt16LE(offset);
    if (itemSize === 0) break; // 终止项
    if (itemSize < 3 || offset + itemSize > end) return null;
    const type = buffer[offset + 2];

    if (type === ITEM_DRIVE) {
      // 结构：size(2) type(1) "C:\" (4字节, 以 \0 结尾)
      const raw = buffer.subarray(offset + 3, offset + itemSize);
      const text = readCString(raw, 0);
      drive = text.replace(/\\+$/, '');
      if (!drive) return null;
    } else if (type === ITEM_FILE_ENTRY || type === ITEM_FILE_ENTRY_2) {
      // 结构：size(2) type(1) FileSize(4) DateTime(4) 属性(1~2) 名称(ANSI, \0 结尾)
      // 属性字段宽度在不同 Windows 版本里不一致（本机是 2 字节，名称从 14 起；
      // 标准文档写 1 字节，名称从 12 起）。所以不写死偏移，从 12 往后跳过
      // 不可打印字节再读，两种布局都能对上。
      const name = readEntryName(buffer, offset + 12, offset + itemSize);
      if (!name) return null;
      parts.push(name);
    } else if (type === ITEM_ROOT_FOLDER) {
      // root folder 只是个 16 字节 CLSID，不含路径成分（本机 Snipaste 的
      // IDList 第一项就是 {20D04FE0-3AEA-1069-A2D8-08002B30309D} 桌面）。
      // 跳过它继续往后读，否则永远拼不出路径。
    } else {
      // 不认识的 item：IDList 里可能还有快捷方式指针等，放弃解析。
      return null;
    }

    offset += itemSize;
  }

  if (!drive || parts.length === 0) return null;
  const joined = parts.join('\\');
  const path = `${drive}\\${joined}`;
  return path.endsWith('\\') ? path.slice(0, -1) : path;
}

/** EnvironmentVariableDataBlock 的签名。 */
const ENV_BLOCK_SIGNATURE = 0xa0000001;
/** 该块内 ANSI 缓冲区固定 260 字节，Unicode 紧跟其后。 */
const ENV_BLOCK_ANSI_SIZE = 260;

/**
 * 从 ExtraData 里找环境变量数据块，返回展开后的目标路径。
 * @param {Buffer} buffer
 * @param {number} start ExtraData 起始偏移
 */
function parseExtraDataTarget(buffer, start) {
  let offset = start;
  // ExtraData 是 TerminatorBlock(4字节 0) 结尾的块链，防止畸形文件死循环。
  for (let guard = 0; guard < 64; guard += 1) {
    if (offset + 8 > buffer.length) return null;
    const blockSize = buffer.readUInt32LE(offset);
    if (blockSize < 8) return null;
    const signature = buffer.readUInt32LE(offset + 4);

    if (signature === ENV_BLOCK_SIGNATURE) {
      const wideStart = offset + 8 + ENV_BLOCK_ANSI_SIZE;
      const wideEnd = Math.min(wideStart + ENV_BLOCK_ANSI_SIZE * 2, buffer.length);
      let text = '';
      if (wideStart + 1 < wideEnd) {
        text = buffer.toString('utf16le', wideStart, wideEnd).replace(/\0.*$/s, '');
      }
      if (!text) {
        const ansiEnd = Math.min(offset + 8 + ENV_BLOCK_ANSI_SIZE, buffer.length);
        text = decodeAnsiPath(buffer.subarray(offset + 8, ansiEnd)).text.replace(/\0.*$/s, '');
      }
      if (!text) return null;
      return expandEnvVars(text, process.env);
    }

    offset += blockSize;
  }
  return null;
}

/**
 * 读 LinkInfo 结构，返回 LocalBasePath（或 CommonPathSuffix 拼出的完整路径）。
 * ANSI 路径用 decodeAnsiPath 解码——它按候选编码试解并以"路径是否存在"校验，
 * 避免把 GBK 路径解成 `D:\Èí¼þ\...`。
 */
function readLinkInfo(buffer, base, options = {}) {
  if (base + LINK_INFO_HEADER_SIZE > buffer.length) return null;

  const linkInfoSize = buffer.readUInt32LE(base);
  if (linkInfoSize === 0 || base + linkInfoSize > buffer.length) return null;

  const linkInfoHeaderSize = buffer.readUInt32LE(base + 4);
  const linkInfoFlags = buffer.readUInt32LE(base + 8);
  const localBasePathOffset = buffer.readUInt32LE(base + 16);
  const commonNetworkRelativeLinkOffset = buffer.readUInt32LE(base + 20);
  const commonPathSuffixOffset = buffer.readUInt32LE(base + 24);

  const hasVolumeIDAndLocalBasePath = (linkInfoFlags & 0x01) !== 0;
  const hasCommonNetworkRelativeLink = (linkInfoFlags & 0x02) !== 0;

  // Unicode 版本优先：LinkInfoHeaderSize >= 0x24 时含 LocalBasePathOffsetUnicode。
  // Unicode 永远比 ANSI 可靠，能用就先用。
  if (linkInfoHeaderSize >= 0x24) {
    const unicodeOffset = buffer.readUInt32LE(base + 28);
    const unicodeSuffixOffset = buffer.readUInt32LE(base + 32);
    if (hasVolumeIDAndLocalBasePath && unicodeOffset > 0) {
      const path = readWideString(buffer, base + unicodeOffset);
      const suffix =
        unicodeSuffixOffset > 0 ? readWideString(buffer, base + unicodeSuffixOffset) : '';
      if (path) return joinSuffix(path, suffix);
    }
  }

  // ANSI 路径（本地最常见）：走自校验解码。
  if (hasVolumeIDAndLocalBasePath && localBasePathOffset > 0) {
    const bytes = readCStringBuffer(buffer, base + localBasePathOffset);
    if (bytes.length > 0) {
      const localBasePath = decodeAnsiPath(bytes, options.exists).text;
      const suffix =
        commonPathSuffixOffset > 0
          ? decodeAnsiPath(readCStringBuffer(buffer, base + commonPathSuffixOffset), options.exists)
              .text
          : '';
      if (localBasePath) return joinSuffix(localBasePath, suffix);
    }
  }

  if (hasCommonNetworkRelativeLink && commonNetworkRelativeLinkOffset > 0) {
    // 网络路径：一般是 \\server\share，尽力读出，不强求。
    const netNameBytes = readCStringBuffer(buffer, base + commonNetworkRelativeLinkOffset + 8);
    const netName = decodeAnsiPath(netNameBytes, options.exists).text;
    if (netName) {
      const suffix =
        commonPathSuffixOffset > 0
          ? decodeAnsiPath(readCStringBuffer(buffer, base + commonPathSuffixOffset), options.exists)
              .text
          : '';
      return joinSuffix(netName, suffix);
    }
  }

  return null;
}

/** 拼 LocalBasePath + CommonPathSuffix，注意别重复分隔符。 */
function joinSuffix(basePath, suffix) {
  if (!suffix) return basePath;
  if (!basePath) return suffix;
  const trimmedBase = basePath.replace(/\\+$/, '');
  const trimmedSuffix = suffix.replace(/^\\+/, '');
  if (!trimmedSuffix) return trimmedBase;
  return `${trimmedBase}\\${trimmedSuffix}`;
}

/**
 * 读 StringData：2 字节长度 + 字符。count 为 0 表示空串。
 * 编码由 IsUnicode 标志（LinkFlags 位 0x80）决定。
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {number} [linkFlags] 不传时从文件头读
 * @returns {{value:string, nextOffset:number}}
 */
function readStringData(buffer, offset, linkFlags) {
  if (offset + 2 > buffer.length) return { value: '', nextOffset: buffer.length };
  const count = buffer.readUInt16LE(offset);
  const start = offset + 2;
  if (count === 0) return { value: '', nextOffset: start };

  const flags = Number.isInteger(linkFlags) ? linkFlags : buffer.readUInt32LE(0x14);
  const isUnicode = (flags & 0x80) !== 0;
  if (isUnicode) {
    const end = start + count * 2;
    if (end > buffer.length) return { value: '', nextOffset: buffer.length };
    return {
      value: buffer.toString('utf16le', start, end).replace(/\0+$/, ''),
      nextOffset: end,
    };
  }
  const end = start + count;
  if (end > buffer.length) return { value: '', nextOffset: buffer.length };
  return { value: decodeAnsiPath(buffer.subarray(start, end)).text.replace(/\0+$/, ''), nextOffset: end };
}

/** 读以 \0 结尾的 ANSI 字符串（原始字节，交给调用方决定编码）。 */
function readCStringBuffer(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) return Buffer.alloc(0);
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  return buffer.subarray(offset, end);
}

/** 读以 \0 结尾的 ANSI 字符串，按 ANSI 代码页解码。 */
function readCString(buffer, offset) {
  return decodeAnsiPath(readCStringBuffer(buffer, offset)).text;
}

/**
 * 把 RELATIVE_PATH 解析成绝对路径。
 *
 * 有些安装包（本机的 Adobe Acrobat、搜狗输入法）在 .lnk 里只写相对路径
 * `..\..\..\Windows\Installer\...`，它是相对 .lnk 自身所在目录的。
 * 不解析的话会得到一串 ".."，既显示难看也没法启动。
 *
 * @param {string} relativePath
 * @param {string} lnkPath .lnk 文件自身的绝对路径
 * @param {object} [pathModule]
 */
function resolveRelativePath(relativePath, lnkPath, pathModule) {
  if (!relativePath) return relativePath;
  if (!lnkPath) return relativePath;
  // 已经是绝对路径（带盘符或 UNC）就不动它。
  if (/^[a-zA-Z]:[\\/]/.test(relativePath) || relativePath.startsWith('\\\\')) {
    return relativePath;
  }
  const path = pathModule ?? require('node:path');
  try {
    return path.resolve(path.dirname(lnkPath), relativePath);
  } catch {
    return relativePath;
  }
}

/**
 * 修复"路径里嵌着别人的用户名"这种陈旧快捷方式。
 *
 * 本机 nvm 的快捷方式写死了 `C:\Users\wxj\...`（制作安装包时的用户名），
 * 实际用户是 zhuanghp。Windows 自己会借 IDList 修好它，我们没解析 IDList，
 * 就用最简单的规则修：换成本次会话的用户名，**且只在修完确实存在时采用**。
 *
 * @param {string} targetPath
 * @param {object} [env]
 * @param {(p:string)=>boolean} [exists]
 */
function repairUserProfilePath(targetPath, env, exists) {
  if (!targetPath) return targetPath;
  const environment = env ?? process.env;
  const check = typeof exists === 'function' ? exists : defaultExists();
  if (check(targetPath)) return targetPath;

  const match = /^([a-zA-Z]:\\Users\\)([^\\]+)(\\[\s\S]*)$/i.exec(targetPath);
  if (!match) return targetPath;
  const actualUser = environment.USERNAME;
  if (!actualUser || actualUser.toLowerCase() === match[2].toLowerCase()) return targetPath;

  const repaired = `${match[1]}${actualUser}${match[3]}`;
  return check(repaired) ? repaired : targetPath;
}

let existsCache;
function defaultExists() {
  if (!existsCache) {
    const fs = require('node:fs');
    existsCache = (p) => {
      if (!p || typeof p !== 'string') return false;
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    };
  }
  return existsCache;
}

/** 读以 \0 结尾的 UTF-16LE 宽字符串。 */
function readWideString(buffer, offset) {
  if (offset < 0 || offset + 1 >= buffer.length) return '';
  let end = offset;
  while (end + 1 < buffer.length && !(buffer[end] === 0 && buffer[end + 1] === 0)) end += 2;
  return buffer.toString('utf16le', offset, end);
}

/** 展开 %VAR% 形式的环境变量；无法展开时原样返回。 */
function expandEnvVars(text, env) {
  if (!text) return text;
  return text.replace(/%([^%]+)%/g, (match, name) => {
    const value = env?.[name] ?? env?.[name.toUpperCase()] ?? env?.[name.toLowerCase()];
    return value ?? match;
  });
}

/** 文件名去扩展名，作为显示名。 */
function displayNameFromPath(filePath, pathModule) {
  const path = pathModule ?? require('node:path');
  const base = path.basename(filePath);
  const ext = path.extname(base);
  if (!ext) return base;
  if (['.exe', '.lnk', '.url', '.bat', '.cmd', '.msi'].includes(ext.toLowerCase())) {
    return base.slice(0, -ext.length);
  }
  return base;
}

module.exports = {
  parseExtraDataTarget,
  parseIdListPath,
  parseLnkTarget,
  parseLnkTargetRaw,
  parseLnkTargetCandidates,
  resolveRelativePath,
  repairUserProfilePath,
  readLinkInfo,
  readStringData,
  readCString,
  readCStringBuffer,
  readWideString,
  expandEnvVars,
  displayNameFromPath,
  joinSuffix,
};
