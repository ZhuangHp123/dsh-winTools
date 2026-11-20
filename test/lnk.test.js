'use strict';

/**
 * .lnk 解析单测。
 *
 * 全部用**合成 buffer**，不依赖本机上的真实快捷方式——否则测试在别人机器上
 * 必挂。合成的方式也顺便把 [MS-SHLLINK] 的布局写成可读代码，比 fixture
 * 二进制更能说明字段含义。
 *
 * 真实 .lnk 的对照验证在开发时做过（122 个开始菜单快捷方式 vs WScript.Shell，
 * 目标路径一致），但那是一次性验证，不适合进测试套件。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  parseLnkTarget,
  parseLnkTargetRaw,
  parseLnkTargetCandidates,
  parseIdListPath,
  readLinkInfo,
  resolveRelativePath,
  repairUserProfilePath,
  expandEnvVars,
  displayNameFromPath,
  joinSuffix,
} = require('../src/apps/lnk');

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

/** 造一个只有 ShellLinkHeader 的骨架。 */
function makeHeader(linkFlags, extra = {}) {
  const buffer = Buffer.alloc(HEADER_SIZE);
  buffer.writeUInt32LE(HEADER_SIZE, 0); // HeaderSize
  // LinkCLSID 保持全 0：解析器不校验它。
  buffer.writeUInt32LE(linkFlags, 0x14); // LinkFlags
  if (extra.fileAttributes !== undefined) {
    buffer.writeUInt32LE(extra.fileAttributes, 0x18);
  }
  return buffer;
}

/** 造 LinkTargetIDList 段：size(2) + items。 */
function makeIdList(items) {
  const body = Buffer.concat(items);
  const size = Buffer.alloc(2);
  size.writeUInt16LE(body.length + 2, 0); // 含结尾的 TerminatorID(2字节 0)
  return Buffer.concat([size, body, Buffer.alloc(2)]);
}

/** root folder 项：只有 CLSID，不含路径（桌面 CLSID）。 */
function rootFolderItem() {
  const clsid = Buffer.from('e04fd020ea3a6910a2d808002b30309d', 'hex');
  const buffer = Buffer.alloc(3 + clsid.length);
  buffer.writeUInt16LE(buffer.length, 0);
  buffer[2] = 0x1f;
  clsid.copy(buffer, 3);
  return buffer;
}

/** 驱动器项 type 0x2F：`C:\` 形式的 ANSI 串，以 \0 结尾。 */
function driveItem(drive) {
  const text = Buffer.from(`${drive}\0`, 'latin1');
  const buffer = Buffer.alloc(3 + text.length);
  buffer.writeUInt16LE(buffer.length, 0);
  buffer[2] = 0x2f;
  text.copy(buffer, 3);
  return buffer;
}

/** 文件/目录项 type 0x31/0x32：12 字节固定头 + ANSI 名称。 */
function fileEntryItem(name, type = 0x32, padBytes = 2) {
  const text = Buffer.from(`${name}\0`, 'latin1');
  const buffer = Buffer.alloc(12 + padBytes + text.length);
  buffer.writeUInt16LE(buffer.length, 0);
  buffer[2] = type;
  // offset 3..7 FileSize, 7..11 DateTime, 11..12 属性 —— 全留 0。
  text.copy(buffer, 12 + padBytes);
  return buffer;
}

/** StringData 段（Unicode 时每字符 2 字节）：count(2) + 字符。 */
function makeStringData(value, unicode) {
  const count = Buffer.alloc(2);
  count.writeUInt16LE(value.length, 0);
  const body = unicode ? Buffer.from(value, 'utf16le') : Buffer.from(value, 'latin1');
  return Buffer.concat([count, body]);
}

/**
 * 造 LinkInfo 段。
 * @param {string} localBasePath ANSI 的 LocalBasePath
 * @param {string} [suffix] CommonPathSuffix
 * @param {{unicodeBase?:string, unicodeSuffix?:string}} [uni]
 */
function makeLinkInfo(localBasePath, suffix = '', uni = {}) {
  const useUnicodeHeader = Boolean(uni.unicodeBase || uni.unicodeSuffix);
  const headerSize = useUnicodeHeader ? 0x24 : 0x1c;
  const volumeId = Buffer.alloc(0x10); // VolumeID，解析器只跳过
  const ansiBase = Buffer.from(`${localBasePath}\0`, 'latin1');
  const ansiSuffix = Buffer.from(`${suffix}\0`, 'latin1');

  // 头部之后依次是 VolumeID、ANSI Base、ANSI Suffix、可选 Unicode 段。
  const afterHeader = volumeId.length + ansiBase.length + ansiSuffix.length;
  const uniBase = useUnicodeHeader && uni.unicodeBase
    ? Buffer.from(`${uni.unicodeBase}\0`, 'utf16le')
    : Buffer.alloc(0);
  const uniSuffix = useUnicodeHeader && uni.unicodeSuffix
    ? Buffer.from(`${uni.unicodeSuffix}\0`, 'utf16le')
    : Buffer.alloc(0);
  const total = headerSize + afterHeader + uniBase.length + uniSuffix.length;

  const buffer = Buffer.alloc(total);
  buffer.writeUInt32LE(total, 0); // LinkInfoSize
  buffer.writeUInt32LE(headerSize, 4); // LinkInfoHeaderSize
  buffer.writeUInt32LE(0x01, 8); // LinkInfoFlags: VolumeIDAndLocalBasePath

  const volumeIdOffset = headerSize;
  const localBasePathOffset = volumeIdOffset + volumeId.length;
  const suffixOffset = localBasePathOffset + ansiBase.length;
  buffer.writeUInt32LE(volumeIdOffset, 12);
  buffer.writeUInt32LE(localBasePathOffset, 16);
  buffer.writeUInt32LE(0, 20); // CommonNetworkRelativeLinkOffset
  buffer.writeUInt32LE(suffixOffset, 24);

  let writeAt = headerSize + volumeId.length;
  ansiBase.copy(buffer, writeAt);
  writeAt += ansiBase.length;
  ansiSuffix.copy(buffer, writeAt);
  writeAt += ansiSuffix.length;
  if (useUnicodeHeader) {
    if (uniBase.length) {
      buffer.writeUInt32LE(writeAt, 28); // LocalBasePathOffsetUnicode
      uniBase.copy(buffer, writeAt);
      writeAt += uniBase.length;
    } else {
      buffer.writeUInt32LE(0, 28);
    }
    if (uniSuffix.length) {
      buffer.writeUInt32LE(writeAt, 32); // CommonPathSuffixOffsetUnicode
      uniSuffix.copy(buffer, writeAt);
      writeAt += uniSuffix.length;
    } else {
      buffer.writeUInt32LE(0, 32);
    }
  }
  return buffer;
}

/** 造 EnvironmentVariableDataBlock（ExtraData 里的目标兜底）。 */
function makeEnvBlock(value) {
  const ansiSize = 260;
  const wide = Buffer.alloc(ansiSize * 2);
  Buffer.from(`${value}\0`, 'utf16le').copy(wide, 0);
  const total = 8 + ansiSize + wide.length;
  const buffer = Buffer.alloc(total);
  buffer.writeUInt32LE(total, 0);
  buffer.writeUInt32LE(0xa0000001, 4);
  Buffer.from(`${value}\0`, 'latin1').copy(buffer, 8);
  wide.copy(buffer, 8 + ansiSize);
  return buffer;
}

/** 不存在的路径判定器：让 decodeAnsiPath 的候选编码自校验变得确定。 */
function noneExists() {
  return false;
}

test('从 LinkInfo 的 ANSI LocalBasePath 读出目标', () => {
  const buffer = Buffer.concat([
    makeHeader(FLAG_LINK_INFO),
    makeLinkInfo('C:\\Windows\\notepad.exe'),
  ]);
  assert.equal(parseLnkTarget(buffer, { exists: noneExists }), 'C:\\Windows\\notepad.exe');
});

test('LinkInfo 的 Unicode 路径优先于 ANSI', () => {
  // ANSI 故意写一个错的，Unicode 写对的：解析器必须用 Unicode。
  const buffer = Buffer.concat([
    makeHeader(FLAG_LINK_INFO),
    makeLinkInfo('C:\\wrong.exe', '', { unicodeBase: 'C:\\正确\\程序.exe' }),
  ]);
  assert.equal(parseLnkTarget(buffer, { exists: noneExists }), 'C:\\正确\\程序.exe');
});

test('LocalBasePath + CommonPathSuffix 拼成完整路径', () => {
  const buffer = Buffer.concat([
    makeHeader(FLAG_LINK_INFO),
    makeLinkInfo('C:\\Program Files\\App', '\\bin\\app.exe'),
  ]);
  assert.equal(
    parseLnkTarget(buffer, { exists: noneExists }),
    'C:\\Program Files\\App\\bin\\app.exe',
  );
});

test('joinSuffix 不重复反斜杠', () => {
  assert.equal(joinSuffix('C:\\a\\', '\\b.exe'), 'C:\\a\\b.exe');
  assert.equal(joinSuffix('C:\\a', 'b.exe'), 'C:\\a\\b.exe');
  assert.equal(joinSuffix('C:\\a', ''), 'C:\\a');
});

test('GBK 字节的 ANSI 路径按存在性自校验解出中文', () => {
  // "D:\软件\Everything.exe" 的 GBK 编码。用 latin1 会解成 "D:\Èí¼þ\..."。
  const gbk = Buffer.from([
    0x44, 0x3a, 0x5c, 0xc8, 0xed, 0xbc, 0xfe, 0x5c,
    0x45, 0x76, 0x65, 0x72, 0x79, 0x74, 0x68, 0x69, 0x6e, 0x67, 0x2e, 0x65, 0x78, 0x65,
  ]);
  const expected = 'D:\\软件\\Everything.exe';

  // 构造 LinkInfo 时不能走 makeLinkInfo（它按 latin1 写），手工拼 ANSI 段。
  const headerSize = 0x1c;
  const volumeId = Buffer.alloc(0x10);
  const ansiBase = Buffer.concat([gbk, Buffer.from([0])]);
  const ansiSuffix = Buffer.from([0]);
  const total = headerSize + volumeId.length + ansiBase.length + ansiSuffix.length;
  const info = Buffer.alloc(total);
  info.writeUInt32LE(total, 0);
  info.writeUInt32LE(headerSize, 4);
  info.writeUInt32LE(0x01, 8);
  const volumeIdOffset = headerSize;
  const localBasePathOffset = volumeIdOffset + volumeId.length;
  const suffixOffset = localBasePathOffset + ansiBase.length;
  info.writeUInt32LE(volumeIdOffset, 12);
  info.writeUInt32LE(localBasePathOffset, 16);
  info.writeUInt32LE(0, 20);
  info.writeUInt32LE(suffixOffset, 24);
  ansiBase.copy(info, localBasePathOffset);
  ansiSuffix.copy(info, suffixOffset);

  const buffer = Buffer.concat([makeHeader(FLAG_LINK_INFO), info]);
  const onlyGbkExists = (p) => p === expected;
  assert.equal(parseLnkTarget(buffer, { exists: onlyGbkExists }), expected);
});

test('跳过所有 StringData 字段后仍能找到 ExtraData 里的目标', () => {
  // 关键回归：只跳过 NAME_STRING 会让 ExtraData 偏移算错，
  // 结果读不到 %windir% 形态的目标（本机屏幕键盘/命令提示符就是这个形态）。
  const buffer = Buffer.concat([
    makeHeader(
      FLAG_NAME | FLAG_RELATIVE_PATH | FLAG_WORKING_DIR | FLAG_ARGUMENTS | FLAG_ICON,
    ),
    makeStringData('显示名称', false), // NAME_STRING
    makeStringData('..\\..\\bin\\x.exe', false), // RELATIVE_PATH
    makeStringData('C:\\work', false), // WORKING_DIR
    makeStringData('--flag', false), // ARGUMENTS
    makeStringData('C:\\icon.ico', false), // ICON_LOCATION
    makeEnvBlock('%windir%\\system32\\osk.exe'),
  ]);
  const target = parseLnkTarget(buffer, {
    exists: noneExists,
    env: { windir: 'C:\\Windows' },
  });
  assert.equal(target, 'C:\\Windows\\system32\\osk.exe');
});

test('没有 LinkInfo 时用 ExtraData 的环境变量块', () => {
  const buffer = Buffer.concat([
    makeHeader(0x00),
    makeEnvBlock('%windir%\\system32\\osk.exe'),
  ]);
  const target = parseLnkTarget(buffer, {
    exists: noneExists,
    env: { windir: 'C:\\Windows' },
  });
  assert.equal(target, 'C:\\Windows\\system32\\osk.exe');
});

test('RELATIVE_PATH 相对 .lnk 自身目录解析成绝对路径', () => {
  // 起点是 .lnk 所在目录 ...\Start Menu\Programs\Vendor，
  // 退 5 层到盘符根（Vendor→Programs→Start Menu→Users\me→Users→C:\）。
  const buffer = Buffer.concat([
    makeHeader(FLAG_RELATIVE_PATH),
    makeStringData('..\\..\\..\\..\\..\\Windows\\Installer\\app.msi', false),
  ]);
  const lnkPath = 'C:\\Users\\me\\Start Menu\\Programs\\Vendor\\app.lnk';
  assert.equal(
    parseLnkTarget(buffer, { exists: noneExists, lnkPath }),
    'C:\\Windows\\Installer\\app.msi',
  );
});

test('相对路径解析不碰已经是绝对的路径', () => {
  assert.equal(resolveRelativePath('C:\\abs\\x.exe', 'C:\\a\\b.lnk'), 'C:\\abs\\x.exe');
  assert.equal(resolveRelativePath('\\\\server\\share\\x.exe', 'C:\\a\\b.lnk'), '\\\\server\\share\\x.exe');
});

test('只有 IDList 时从 shell item 拼出路径（含 root folder 项）', () => {
  // 关键回归：IDList 首项是 root folder CLSID 时必须跳过而不是放弃，
  // 否则本机 Snipaste 这种"无 LinkInfo 无 ExtraData"的快捷方式解析不出来。
  const idList = makeIdList([
    rootFolderItem(),
    driveItem('D:'),
    fileEntryItem('Snipaste-2.11.3-x64', 0x31),
    fileEntryItem('Snipaste.exe', 0x32),
  ]);
  const buffer = Buffer.concat([makeHeader(FLAG_ID_LIST), idList]);

  assert.equal(parseIdListPath(buffer, HEADER_SIZE), 'D:\\Snipaste-2.11.3-x64\\Snipaste.exe');
  assert.equal(parseLnkTarget(buffer, { exists: noneExists }), 'D:\\Snipaste-2.11.3-x64\\Snipaste.exe');
});

test('IDList 里名称前的填充字节宽度不影响解析', () => {
  // 标准文档写属性 1 字节（名称从 12 起），本机实测是 2 字节（从 14 起）。
  // 两种布局都必须解析正确，所以按"跳过开头控制字节"对齐，而不是写死偏移。
  for (const pad of [0, 1, 2]) {
    const idList = makeIdList([
      driveItem('C:'),
      fileEntryItem('app.exe', 0x32, pad),
    ]);
    const buffer = Buffer.concat([makeHeader(FLAG_ID_LIST), idList]);
    assert.equal(
      parseIdListPath(buffer, HEADER_SIZE),
      'C:\\app.exe',
      `padBytes=${pad} 时应解析出 C:\\app.exe`,
    );
  }
});

test('IDList 含未知 item 类型时放弃并返回 null（而不是瞎拼）', () => {
  const unknown = Buffer.alloc(6);
  unknown.writeUInt16LE(6, 0);
  unknown[2] = 0x99;
  const idList = makeIdList([driveItem('C:'), unknown]);
  const buffer = Buffer.concat([makeHeader(FLAG_ID_LIST), idList]);
  assert.equal(parseIdListPath(buffer, HEADER_SIZE), null);
});

test('只有 CLSID 型 IDList（文件资源管理器/控制面板）返回 null', () => {
  // 这类系统快捷方式没有文件系统目标，WScript.Shell 的 TargetPath 也是空串。
  const idList = makeIdList([rootFolderItem()]);
  const buffer = Buffer.concat([makeHeader(FLAG_ID_LIST), idList]);
  assert.equal(parseLnkTarget(buffer, { exists: noneExists }), null);
});

test('坏 buffer 一律返回 null，不抛异常', () => {
  assert.equal(parseLnkTargetRaw(Buffer.alloc(0)), null);
  assert.equal(parseLnkTargetRaw(Buffer.alloc(10)), null);
  assert.equal(parseLnkTargetRaw(Buffer.from('not a shortcut at all')), null);
  // HeaderSize 不对
  const wrongHeader = makeHeader(0);
  wrongHeader.writeUInt32LE(0x99, 0);
  assert.equal(parseLnkTargetRaw(wrongHeader), null);
});

test('截断的 LinkInfo 不抛异常', () => {
  const full = makeLinkInfo('C:\\Windows\\notepad.exe');
  const truncated = full.subarray(0, 8);
  const buffer = Buffer.concat([makeHeader(FLAG_LINK_INFO), truncated]);
  assert.equal(readLinkInfo(buffer, HEADER_SIZE, { exists: noneExists }), null);
});

test('expandEnvVars 展开 %VAR%，未定义的原样保留', () => {
  const env = { windir: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  assert.equal(expandEnvVars('%windir%\\notepad.exe', env), 'C:\\Windows\\notepad.exe');
  assert.equal(expandEnvVars('%NOPE%\\x.exe', env), '%NOPE%\\x.exe');
  assert.equal(expandEnvVars('no vars here', env), 'no vars here');
});

test('repairUserProfilePath 只在替换后确实存在时才替换用户名', () => {
  const stale = 'C:\\Users\\someone\\AppData\\Local\\app\\app.exe';
  const fixed = 'C:\\Users\\me\\AppData\\Local\\app\\app.exe';

  // 旧路径存在 → 不动
  assert.equal(repairUserProfilePath(stale, { USERNAME: 'me' }, (p) => p === stale), stale);
  // 新路径存在 → 替换
  assert.equal(repairUserProfilePath(stale, { USERNAME: 'me' }, (p) => p === fixed), fixed);
  // 谁都不存在 → 保持原样（本机 nvm 就是这个情况，别假装修好了）
  assert.equal(repairUserProfilePath(stale, { USERNAME: 'me' }, () => false), stale);
  // 用户名本来就一样 → 不动
  assert.equal(repairUserProfilePath(stale, { USERNAME: 'someone' }, () => false), stale);
  // 不是用户目录的路径 → 不动
  assert.equal(repairUserProfilePath('C:\\Windows\\x.exe', { USERNAME: 'me' }, () => false), 'C:\\Windows\\x.exe');
});

test('displayNameFromPath 去掉扩展名并跳过 .lnk 后缀', () => {
  assert.equal(displayNameFromPath('C:\\a\\notepad.exe'), 'notepad');
  assert.equal(displayNameFromPath('C:\\a\\Visual Studio Code.lnk'), 'Visual Studio Code');
  assert.equal(displayNameFromPath('C:\\a\\folder'), 'folder');
});

test('空/畸形 ExtraData 链不会死循环', () => {
  // blockSize=0 会让朴素实现原地打转，必须有保护。
  const bogus = Buffer.alloc(16);
  bogus.writeUInt32LE(0, 0);
  const buffer = Buffer.concat([makeHeader(0), bogus]);
  assert.equal(parseLnkTarget(buffer, { exists: noneExists }), null);
});

test('多个目标线索按可信度排序，IDList 排最后', () => {
  const idList = makeIdList([driveItem('C:'), fileEntryItem('garbage.exe')]);
  const buffer = Buffer.concat([
    makeHeader(FLAG_ID_LIST | FLAG_LINK_INFO | FLAG_RELATIVE_PATH),
    idList,
    makeLinkInfo('C:\\Program Files\\App\\app.exe'),
    makeStringData('..\\..\\app.exe', false),
  ]);
  const candidates = parseLnkTargetCandidates(buffer, { exists: noneExists });
  assert.equal(candidates[0], 'C:\\Program Files\\App\\app.exe', 'LinkInfo 应排第一');
  assert.equal(candidates[1], '..\\..\\app.exe', 'RELATIVE_PATH 应排在 IDList 之前');
  assert.equal(candidates[2], 'C:\\garbage.exe', 'IDList 应排最后');
});

test('IDList 解析出垃圾时，采用真实存在的相对路径线索', () => {
  // 本机 Adobe Acrobat 这类 MSI 广告型快捷方式就是这样：IDList 最后一个
  // item 解出 `...\!` 这种垃圾，而 RELATIVE_PATH 才是对的。解析器必须
  // 按"路径是否存在"在候选之间裁决，而不是盲信某个结构。
  const idList = makeIdList([
    driveItem('C:'),
    fileEntryItem('{AC76BA86-1033-FFFF-7760-0C0F074E4100}', 0x31),
    fileEntryItem('!', 0x32),
  ]);
  const buffer = Buffer.concat([
    makeHeader(FLAG_ID_LIST | FLAG_RELATIVE_PATH),
    idList,
    makeStringData('..\\..\\..\\Windows\\Installer\\{AC76BA86}\\app.ico', false),
  ]);
  const lnkPath = 'C:\\ProgramData\\Start Menu\\Programs\\Adobe.lnk';
  const realFile = 'C:\\Windows\\Installer\\{AC76BA86}\\app.ico';
  const target = parseLnkTarget(buffer, { exists: (p) => p === realFile, lnkPath });
  assert.equal(target, realFile);
});

test('所有候选都不存在时仍返回最可信的那个（保证界面有名字可显示）', () => {
  const idList = makeIdList([driveItem('D:'), fileEntryItem('gone.exe')]);
  const buffer = Buffer.concat([
    makeHeader(FLAG_ID_LIST | FLAG_LINK_INFO),
    idList,
    makeLinkInfo('C:\\Program Files\\Gone\\gone.exe'),
  ]);
  assert.equal(
    parseLnkTarget(buffer, { exists: noneExists }),
    'C:\\Program Files\\Gone\\gone.exe',
  );
});
