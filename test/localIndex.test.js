'use strict';

/**
 * 本地索引与 cid 打开的单测。
 *
 * 不碰真实钉钉库：加密/解密、sqlite 读取都靠注入的假实现，
 * 只验证纯逻辑——cid 拼接规则、密钥推导、候选择优、失败回落。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { cidFor, keyFor, decryptBuffer, looksLikeSqlite, uidCandidates, detectSelfUid } = require('../src/dingtalk/localIndex');
const { createCidOpener } = require('../src/dingtalk/openChat');

test('cid：两个数字 uid 按数值升序用冒号拼接', () => {
  assert.equal(cidFor('2000000002', '1000000001'), '1000000001:2000000002');
  assert.equal(cidFor('1000000001', '2000000002'), '1000000001:2000000002');
  // 位数不同时按数值比，不按字典序（"9" > "10" 是字典序的坑）
  assert.equal(cidFor('9', '1000000001'), '9:1000000001');
  assert.equal(cidFor('1000000001', '9'), '9:1000000001');
});

test('密钥推导：PBKDF2 + MD5 十六进制前 16 位当 ASCII 密钥', () => {
  const key = keyFor('1000000001', '0123456789abcdef0123456789abcdef');
  assert.equal(key.length, 16);
  // 直接算一遍，防止有人"顺手"改成 hex 解码（那样密钥是 8 字节，解密全错）
  const dk = crypto.pbkdf2Sync(Buffer.from('10000000010123456789abcdef0123456789abcdef'), Buffer.from('666DingT'), 1000, 32, 'sha1');
  const expected = crypto.createHash('md5').update(dk).digest('hex').slice(0, 16);
  assert.equal(key.toString('latin1'), expected);
});

test('decryptBuffer：整块解密，尾部不足 16 字节原样保留', () => {
  const key = keyFor('1', 'a'.repeat(32));
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  const plain = Buffer.from('SQLite format 3\u0000' + 'x'.repeat(16));
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const dec = decryptBuffer(Buffer.concat([enc, Buffer.from('AB')]), key);
  assert.equal(looksLikeSqlite(dec), true);
  assert.equal(dec.subarray(-2).toString(), 'AB');
});

test('looksLikeSqlite：只认标准文件头', () => {
  assert.equal(looksLikeSqlite(Buffer.from('SQLite format 3\u0000rest')), true);
  assert.equal(looksLikeSqlite(Buffer.from('SQLite format 2\u0000rest')), false);
  assert.equal(looksLikeSqlite(Buffer.alloc(4)), false);
});

test('候选 uid：日志里出现次数最多的排前面', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-uid-'));
  const dataDir = path.join(root, 'hash_v3');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'log'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'log', 'a.log'),
    ['uid=999999', 'uid=1000000001', 'uid=1000000001', 'uid=1000000001'].join('\n'),
  );
  assert.deepEqual(uidCandidates(dataDir).slice(0, 2), ['1000000001', '999999']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectSelfUid：只有密钥正确的候选能解出 SQLite 头', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-self-'));
  const dataDir = path.join(root, 'hash_v3');
  const dbDir = path.join(dataDir, 'DBFiles');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'log'), { recursive: true });
  fs.writeFileSync(path.join(root, 'log', 'a.log'), 'uid=777777\nuid=777777\nuid=888888');

  const salt = 'b'.repeat(32);
  const key = keyFor('777777', salt);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  const plain = Buffer.alloc(4096, 7);
  Buffer.from('SQLite format 3\u0000').copy(plain, 0);
  fs.writeFileSync(path.join(dbDir, 'members.db'), Buffer.concat([cipher.update(plain), cipher.final()]));

  assert.equal(detectSelfUid(dataDir, salt), '777777');
  fs.rmSync(root, { recursive: true, force: true });
});

test('cid 打开器：拼出 page/conversation 链接', async () => {
  const uris = [];
  const open = createCidOpener({ openUri: async (uri) => uris.push(uri) });
  const result = await open('2000000002:1000000001');
  assert.equal(result.ok, true);
  assert.deepEqual(uris, ['dingtalk://dingtalkclient/page/conversation?cid=2000000002:1000000001']);
});

test('cid 打开器：空 cid 直接拒绝，不弹协议处理器', async () => {
  const uris = [];
  const open = createCidOpener({ openUri: async (uri) => uris.push(uri) });
  const result = await open('  ');
  assert.equal(result.ok, false);
  assert.match(result.message, /cid/);
  assert.deepEqual(uris, []);
});

test('cid 打开器：协议处理器报错时不抛，给出可读原因', async () => {
  const open = createCidOpener({
    openUri: async () => {
      throw new Error('没有关联的程序');
    },
  });
  const result = await open('1:2');
  assert.equal(result.ok, false);
  assert.match(result.message, /没有关联的程序/);
});
