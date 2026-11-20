'use strict';

/**
 * 打开单聊的脚本构造与结果解析。
 *
 * 真跑一遍需要钉钉在前台，单测里只注入 runPowerShell，验证契约：
 * 姓名必须以 base64 进脚本（不能拼进 PowerShell 源码），失败原因要翻成中文。
 */

const test = require('node:test');
const assert = require('node:assert');

const { createChatOpener, buildOpenChatScript, WINDOW_CLASS } = require('../src/dingtalk/openChat');

test('脚本里不出现明文姓名，只出现 base64', () => {
  const name = "张三丰'); Write-Output 'pwn";
  const script = buildOpenChatScript(name);
  assert.ok(!script.includes(name), '姓名原文被拼进了脚本');
  assert.equal(
    script.includes(Buffer.from(name, 'utf8').toString('base64')),
    true,
    '姓名没有以 base64 传给 PowerShell',
  );
});

test('脚本包含关键步骤：找窗口、抢焦点、点搜索框、粘贴、回车', () => {
  const script = buildOpenChatScript('张三');
  for (const needle of [WINDOW_CLASS, 'SetForegroundWindow', 'AttachThreadInput', 'ClientToScreen', '^v', '{ENTER}']) {
    assert.ok(script.includes(needle), `脚本缺少 ${needle}`);
  }
});

test('成功时返回 ok', async () => {
  const open = createChatOpener({ runPowerShell: async () => 'noise\n{"ok":true}\n' });
  assert.deepEqual(await open('张三丰'), { ok: true });
});

test('失败原因翻成中文', async () => {
  for (const [reason, keyword] of [
    ['not-running', '没有在运行'],
    ['no-window', '主窗口'],
    ['focus-denied', '焦点'],
  ]) {
    const open = createChatOpener({ runPowerShell: async () => `{"ok":false,"reason":"${reason}"}` });
    const result = await open('张三');
    assert.equal(result.ok, false);
    assert.match(result.message, new RegExp(keyword));
  }
});

test('脚本没输出、输出不是 JSON、执行报错，都不抛异常', async () => {
  const cases = [
    createChatOpener({ runPowerShell: async () => '' }),
    createChatOpener({ runPowerShell: async () => 'boom' }),
    createChatOpener({
      runPowerShell: async () => {
        throw new Error('spawn failed');
      },
    }),
  ];
  for (const open of cases) {
    const result = await open('张三');
    assert.equal(result.ok, false);
    assert.ok(result.message);
  }
});

test('空姓名直接拒绝，不调用 PowerShell', async () => {
  let called = 0;
  const open = createChatOpener({
    runPowerShell: async () => {
      called += 1;
      return '{"ok":true}';
    },
  });
  assert.equal((await open('   ')).ok, false);
  assert.equal(called, 0);
});
