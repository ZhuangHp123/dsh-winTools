'use strict';

/**
 * 从钉钉本地数据库读「姓名 → 数字 uid」，用来直接跳到单聊。
 *
 * 为什么值得读库：客户端自己的搜索面板路径要点搜索框、粘名字、等结果、回车，
 * 全程 4~5 秒还得把窗口抢到前台，用户能看到整个过程。而客户端内部的
 * `page/conversation?cid=` 协议能一步切到会话，实测 150ms 就落到正确的聊天。
 * 难处是 cid：单聊 cid 是「两个数字 uid 升序用冒号拼接」，这两个 id MCP 网关
 * 都不给（只给组织内 userId 和 openDingTalkId），只能从本地库拿。
 *
 * 库是加密的（AES-128-ECB）。密钥推导按 dingwave-V3 的结论：
 *   password = 自己的数字 uid + user_config 里的 salt
 *   dk       = PBKDF2-HMAC-SHA1(password, '666DingT', 1000, 32)
 *   key      = MD5(dk) 的十六进制前 16 个字符（作为 ASCII 字节，不是 hex 解码）
 * 自己的数字 uid 不在任何明文配置里，靠两件事定位：先用日志里出现次数最多的
 * 若干个候选逐个试解文件头（只有对的 uid 能解出 "SQLite format 3"），再退一步
 * 用 1:1 会话里出现最多的 uid 兜底。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SQLITE_HEADER = 'SQLite format 3';
const KDF_SALT = '666DingT';
const PROFILE_QUERY =
  "select uid, nick, alias, orgInfo from tbuser_profile_v2 where nick is not null and nick != ''";

/** 钉钉数据目录：%APPDATA%\DingTalk\<hash>_v3，里面要有 DBFiles。 */
function findDataDir(root = path.join(os.homedir(), 'AppData', 'Roaming', 'DingTalk')) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('_v3'))
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'DBFiles')));
  if (candidates.length === 0) return null;
  // 多账号时挑 DBFiles 最新的那个，等于"最近在用"。
  return candidates
    .map((dir) => {
      try {
        return { dir, at: fs.statSync(path.join(dir, 'DBFiles')).mtimeMs };
      } catch {
        return { dir, at: 0 };
      }
    })
    .sort((a, b) => b.at - a.at)[0].dir;
}

function readSalt(dataDir) {
  const raw = fs.readFileSync(path.join(dataDir, 'user_config'), 'utf8').trim();
  const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  const salt = String(parsed?.salt ?? '');
  if (!/^[0-9a-f]{16,64}$/i.test(salt)) throw new Error('user_config 里没有可用的 salt');
  return salt;
}

function keyFor(uid, salt) {
  const dk = crypto.pbkdf2Sync(Buffer.from(String(uid) + salt, 'utf8'), Buffer.from(KDF_SALT), 1000, 32, 'sha1');
  const hex = crypto.createHash('md5').update(dk).digest('hex').slice(0, 16);
  return Buffer.from(hex, 'latin1');
}

function decryptBuffer(data, key) {
  const aligned = data.length - (data.length % 16);
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([
    decipher.update(data.subarray(0, aligned)),
    decipher.final(),
    data.subarray(aligned),
  ]);
}

function looksLikeSqlite(buffer) {
  return buffer.subarray(0, SQLITE_HEADER.length).toString('latin1') === SQLITE_HEADER;
}

/**
 * 在日志里按出现次数排候选 uid。自己的 uid 会在每条请求日志里重复出现，
 * 别人的只偶尔出现一两次，排序差别很明显（实测 85 : 4）。
 */
function uidCandidates(dataDir, limit = 8) {
  const counts = new Map();
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      try {
        const stat = fs.statSync(full);
        // 日志可能上兆，只捡最近的若干个，够排序了
        if (stat.size > 0 && stat.size < 6 * 1024 * 1024) files.push({ full, at: stat.mtimeMs });
      } catch {
        /* 忽略读不到的 */
      }
    }
  };
  walk(path.join(dataDir, '..', 'log'), 0);
  files.sort((a, b) => b.at - a.at);
  for (const file of files.slice(0, 40)) {
    let text;
    try {
      text = fs.readFileSync(file.full).toString('latin1');
    } catch {
      continue;
    }
    const re = /uid[=: ]{1,3}(\d{6,12})/g;
    let match;
    while ((match = re.exec(text))) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map((entry) => entry[0]);
}

/** 拿 members.db 头 4KB 逐个候选试解，第一个能解出 SQLite 头就是自己的 uid。 */
function detectSelfUid(dataDir, salt) {
  const dbPath = path.join(dataDir, 'DBFiles', 'members.db');
  let head;
  try {
    const stat = fs.statSync(dbPath);
    const fd = fs.openSync(dbPath, 'r');
    head = Buffer.alloc(Math.min(4096, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
  } catch {
    return null;
  }
  for (const uid of uidCandidates(dataDir)) {
    try {
      if (looksLikeSqlite(decryptBuffer(head, keyFor(uid, salt)))) return uid;
    } catch {
      /* 这个候选不对，继续 */
    }
  }
  return null;
}

function readProfiles(dbPath) {
  // 延迟 require：node:sqlite 只在 Electron/Node 22+ 有，单测里用不到实现细节。
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(PROFILE_QUERY).all();
  } finally {
    db.close();
  }
}

function orgNameOf(raw) {
  if (!raw) return '';
  try {
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return String(info?.orgName ?? info?.mainOrgName ?? '');
  } catch {
    return '';
  }
}

/**
 * cid 规则：两个人的数字 uid 按数值升序，用冒号拼接。
 * 顺序反了客户端也认，但会落到"会话不存在"的空面板上。
 */
function cidFor(a, b) {
  const [x, y] = [String(a), String(b)].sort((m, n) => Number(m) - Number(n) || (m < n ? -1 : 1));
  return `${x}:${y}`;
}

/**
 * 读库并整理成 { selfUid, people: [{ uid, name, alias, dept }] }。
 * 同名多条（重名同事）都保留，交给上层按 uid 区分展示。
 */
function loadLocalContacts(dataDir) {
  const salt = readSalt(dataDir);
  const selfUid = detectSelfUid(dataDir, salt);
  if (!selfUid) return { selfUid: null, people: [], reason: '无法确定本机账号的数字 uid' };

  const key = keyFor(selfUid, salt);
  const decrypted = decryptBuffer(fs.readFileSync(path.join(dataDir, 'DBFiles', 'dingtalk.db')), key);
  if (!looksLikeSqlite(decrypted)) {
    return { selfUid: null, people: [], reason: 'dingtalk.db 解密失败（客户端可能换过加密方式）' };
  }

  const tmp = path.join(os.tmpdir(), `dsh-dingtalk-${process.pid}.db`);
  fs.writeFileSync(tmp, decrypted);
  let rows;
  try {
    rows = readProfiles(tmp);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件删不掉不影响结果 */
    }
  }

  const people = [];
  for (const row of rows) {
    const name = String(row.nick ?? '').trim();
    if (!name) continue;
    const uid = String(row.uid ?? '').trim();
    if (!uid || uid === String(selfUid)) continue;
    people.push({ uid, name, alias: String(row.alias ?? '').trim(), dept: orgNameOf(row.orgInfo) });
  }
  return { selfUid: String(selfUid), people, reason: '' };
}

module.exports = {
  findDataDir,
  readSalt,
  keyFor,
  decryptBuffer,
  looksLikeSqlite,
  uidCandidates,
  detectSelfUid,
  cidFor,
  loadLocalContacts,
};
