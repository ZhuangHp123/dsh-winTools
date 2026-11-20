'use strict';

/**
 * 头像解析单测。
 *
 * 不碰真实客户端目录：用临时目录伪造 AvatarFiles，用假 fetch 验证 CDN 兜底。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAvatarStore, dimensionsOf, indexLocalAvatars } = require('../src/dingtalk/avatars');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/**
 * 造一个 mediaId：格式是 base64(前缀 + 若干「0xCD + 大端 u16 对」)，
 * 最后两对是高度和宽度。真实 id 也长这样，这里不引用任何真人资源名。
 */
function mediaId(height, width) {
  const bytes = Buffer.from([0x94, 0x02, 0xcf, 0x10, 0x61, 0x62, 0x63, 0x64, 0xcd, height >> 8, height & 0xff, 0xcd, width >> 8, width & 0xff]);
  return bytes.toString('base64').replace(/=+$/, '');
}

const ID_609x468 = mediaId(468, 609);
const ID_480x480 = mediaId(480, 480);
const ID_337x337 = mediaId(337, 337);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-avatar-'));
}

test('dimensionsOf：从 mediaId 解出原图宽高', () => {
  assert.deepEqual(dimensionsOf(ID_609x468), { height: 468, width: 609 });
  assert.deepEqual(dimensionsOf(ID_480x480), { height: 480, width: 480 });
  assert.deepEqual(dimensionsOf(ID_337x337), { height: 337, width: 337 });
  // 前导 @ 要能容忍（数据库里就带 @）
  assert.deepEqual(dimensionsOf('@' + ID_337x337), { height: 337, width: 337 });
  assert.equal(dimensionsOf(''), null);
  assert.equal(dimensionsOf('not-a-media-id'), null);
});

test('indexLocalAvatars：同一 id 优先取 60x60 缩略图', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'abc_800_800.png'), Buffer.alloc(50000, 1));
  fs.writeFileSync(path.join(dir, 'abc_800_800.png_60x60q90.png'), JPEG);
  fs.writeFileSync(path.join(dir, 'other_100_100.jpg'), JPEG);

  const index = indexLocalAvatars([dir]);
  assert.equal(index.size, 2);
  const hit = index.get('abc');
  assert.equal(hit.isSmall, true);
  assert.equal(hit.ext, 'png');
  assert.match(hit.file, /_60x60/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('头像：本地有就直接给 data URL，不发网络请求', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'aaa_240_240.jpg_60x60q90.jpg'), JPEG);
  let calls = 0;
  const store = createAvatarStore({
    avatarDirs: [dir],
    fetch: async () => {
      calls += 1;
      throw new Error('不该走网络');
    },
  });

  const url = store.dataUrl('@aaa');
  assert.match(url, /^data:image\/jpeg;base64,/);
  assert.equal(calls, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('头像：本地没有时按 mediaId 里解出的尺寸向 CDN 要', async () => {
  const requested = [];
  const store = createAvatarStore({
    avatarDirs: [],
    fetch: async (url) => {
      requested.push(url);
      return { ok: true, arrayBuffer: async () => JPEG };
    },
  });

  const ok = await store.ensure(ID_337x337);
  assert.equal(ok, true);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /^https:\/\/static\.dingtalk\.com\/media\//);
  assert.match(requested[0], /_337_337\.jpg_75x75q90_xz\.jpg$/);
  assert.match(store.dataUrl(ID_337x337), /^data:image\/jpeg;base64,/);
});

test('头像：CDN 全 404 时标记为缺失，不反复重试', async () => {
  let calls = 0;
  const store = createAvatarStore({
    avatarDirs: [],
    fetch: async () => {
      calls += 1;
      return { ok: false, arrayBuffer: async () => Buffer.alloc(0) };
    },
  });

  assert.equal(await store.ensure(ID_337x337), false);
  const first = calls;
  assert.equal(await store.ensure(ID_337x337), false);
  assert.equal(calls, first, '第二次不该再发请求');
  assert.equal(store.dataUrl(ID_337x337), null);
});

test('头像：解不出尺寸的 id 直接放弃，不打网络', async () => {
  let calls = 0;
  const store = createAvatarStore({
    avatarDirs: [],
    fetch: async () => {
      calls += 1;
      return { ok: true, arrayBuffer: async () => JPEG };
    },
  });
  assert.equal(await store.ensure('bogus'), false);
  assert.equal(calls, 0);
});

test('头像：下载成功后落盘，下次启动不用再联网', async () => {
  const cacheDir = tempDir();
  const store = createAvatarStore({
    avatarDirs: [],
    cacheDir,
    fetch: async () => ({ ok: true, arrayBuffer: async () => JPEG }),
  });
  await store.ensure(ID_337x337);
  assert.equal(fs.existsSync(path.join(cacheDir, `${ID_337x337}.jpg`)), true);

  // 新实例只认磁盘缓存，fetch 一调就报错
  const again = createAvatarStore({
    avatarDirs: [],
    cacheDir,
    fetch: async () => {
      throw new Error('不该再联网');
    },
  });
  assert.match(again.dataUrl(ID_337x337), /^data:image\/jpeg;base64,/);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});
