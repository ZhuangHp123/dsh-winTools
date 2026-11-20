'use strict';

/**
 * 钉钉 MCP 客户端与两个 provider 的单测。
 *
 * 全部注入 fetch，不依赖网络、不需要真实 MCP 地址。
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseSseForId, unwrapToolResult, createMcpClient } = require('../src/dingtalk/mcpClient');
const {
  createContactProvider,
  createDocumentProvider,
  normalizeContacts,
  normalizeDocuments,
  contactToCandidate,
  initialsOf,
  docToCandidate,
  worthRemoteQuery,
} = require('../src/dingtalk/dingtalkProvider');

/** 造一个假的 fetch：按调用顺序返回预置响应。 */
function fakeFetch(responses) {
  const calls = [];
  let index = 0;
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const item = typeof responses === 'function' ? responses(calls.length, JSON.parse(init.body)) : responses[index++];
    if (!item) throw new Error('unexpected fetch call');
    if (item instanceof Error) throw item;
    return item;
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => JSON.stringify(body),
  };
}

function sseResponse(events, headers = {}) {
  const text = events
    .map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null),
    },
    text: async () => text,
  };
}

test('parseSseForId 取 id 匹配的那条，忽略通知事件', () => {
  const text =
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n' +
    'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n';
  assert.deepEqual(parseSseForId(text, 7), { jsonrpc: '2.0', id: 7, result: { ok: true } });
  assert.equal(parseSseForId(text, 8), null);
});

test('parseSseForId 支持多行 data 拼成一条 JSON', () => {
  const text = 'data: {"jsonrpc":"2.0",\ndata: "id":9,"result":{"a":1}}\n\n';
  assert.deepEqual(parseSseForId(text, 9).result, { a: 1 });
});

test('unwrapToolResult 解析 content[].text 里的 JSON', () => {
  const result = { content: [{ type: 'text', text: '{"list":[1,2]}' }] };
  assert.deepEqual(unwrapToolResult(result), { list: [1, 2] });
});

test('unwrapToolResult 非 JSON 文本原样返回', () => {
  assert.equal(unwrapToolResult({ content: [{ type: 'text', text: '你好' }] }), '你好');
});

test('unwrapToolResult 无 content 时返回 structuredContent', () => {
  assert.deepEqual(unwrapToolResult({ structuredContent: { x: 1 } }), { x: 1 });
});

test('MCP 客户端：握手后调用工具，带 session id', async () => {
  const fetch = fakeFetch([
    jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'sess-1' }),
    jsonResponse({}),
    jsonResponse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
  ]);
  const client = createMcpClient({ url: 'https://mcp-gw.example/x', fetch });
  const result = await client.callTool('search_documents', { keyword: 'abc' });

  assert.deepEqual(unwrapToolResult(result), { ok: true });
  assert.equal(fetch.calls.length, 3); // initialize + notifications/initialized + tools/call
  assert.equal(fetch.calls[0].body.method, 'initialize');
  assert.equal(fetch.calls[2].body.params.name, 'search_documents');
  assert.equal(fetch.calls[2].headers['mcp-session-id'], 'sess-1');
});

test('MCP 客户端：握手失败后允许重试', async () => {
  let attempts = 0;
  const fetch = fakeFetch((callCount, body) => {
    if (body.method === 'initialize') {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { message: 'bad key' } });
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} });
    }
    if (body.method === 'notifications/initialized') return jsonResponse({});
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { ok: 1 } });
  });
  const client = createMcpClient({ url: 'https://mcp-gw.example/x', fetch });

  await assert.rejects(() => client.callTool('t', {}), /bad key/);
  const result = await client.callTool('t', {});
  assert.deepEqual(result, { ok: 1 });
  assert.equal(attempts, 2);
});

test('MCP 客户端：HTTP 非 2xx 抛出带状态码的错误', async () => {
  const fetch = async () => ({
    ok: false,
    status: 401,
    headers: { get: () => 'application/json' },
    text: async () => '{"error":"invalid key"}',
  });
  const client = createMcpClient({ url: 'https://mcp-gw.example/x', fetch });
  await assert.rejects(() => client.initialize(), /HTTP 401/);
});

test('MCP 客户端：SSE 响应也能解析', async () => {
  const fetch = fakeFetch([
    sseResponse([{ jsonrpc: '2.0', id: 1, result: {} }]),
    sseResponse([]),
    sseResponse([{ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"n":5}' }] } }]),
  ]);
  const client = createMcpClient({ url: 'https://mcp-gw.example/x', fetch });
  const result = await client.callTool('t', {});
  assert.deepEqual(unwrapToolResult(result), { n: 5 });
});

test('normalizeContacts：从任意包装层里捞出 userId + name', () => {
  const payload = {
    result: {
      data: {
        list: [
          { userId: 'u1', name: '张三', deptName: '研发部' },
          { userId: 'u2', nick: '李四' },
          { name: '没有 id' },
        ],
      },
    },
  };
  const list = normalizeContacts(payload);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { userId: 'u1', name: '张三', dept: '研发部', nick: '', openId: '' });
  assert.deepEqual(list[1], { userId: 'u2', name: '李四', dept: '', nick: '', openId: '' });
});

test('normalizeContacts：保留职位、昵称与 openDingTalkId（实测形态）', () => {
  const payload = {
    result: [
      {
        nick: '大壮',
        name: '庄浩鹏',
        title: '后端开发工程师',
        userId: '501619001324161162',
        openDingTalkId: 'Doii3ApmaqFAhIHD8y18sVtQewbliiaGiSDm',
      },
    ],
  };
  assert.deepEqual(normalizeContacts(payload), [
    {
      userId: '501619001324161162',
      name: '庄浩鹏',
      dept: '后端开发工程师',
      nick: '大壮',
      openId: 'Doii3ApmaqFAhIHD8y18sVtQewbliiaGiSDm',
    },
  ]);
});

test('normalizeContacts：同一人出现多次时合并，保留有部门的版本', () => {
  const payload = [{ userId: 'u1', name: '张三' }, { userId: 'u1', name: '张三', deptName: '研发部' }];
  const list = normalizeContacts(payload);
  assert.equal(list.length, 1);
  assert.equal(list[0].dept, '研发部');
});

test('normalizeContacts：不会把文档对象误判成联系人', () => {
  const payload = [{ name: '接口文档', url: 'https://alidocs.dingtalk.com/i/nodes/x', userId: 'doc1' }];
  assert.deepEqual(normalizeContacts(payload), []);
});

test('normalizeDocuments：识别标题 + 链接', () => {
  const payload = { documents: [{ title: '需求说明', url: 'https://alidocs.dingtalk.com/i/nodes/abc' }] };
  const list = normalizeDocuments(payload);
  assert.deepEqual(list, [{ title: '需求说明', url: 'https://alidocs.dingtalk.com/i/nodes/abc' }]);
});

test('normalizeDocuments：认得出实测的 name + docUrl 结构', () => {
  const payload = {
    documents: [
      {
        name: '3.0.2-条码系统PRD',
        docUrl: 'https://alidocs.dingtalk.com/i/nodes/YMyQA2dXW792DgE6hdwYmqGoJzlwrZgb?utm_scene=team_space',
        extension: 'adoc',
        nodeId: 'YMyQA2dXW792DgE6hdwYmqGoJzlwrZgb',
      },
    ],
  };
  assert.deepEqual(normalizeDocuments(payload), [
    {
      title: '3.0.2-条码系统PRD',
      url: 'https://alidocs.dingtalk.com/i/nodes/YMyQA2dXW792DgE6hdwYmqGoJzlwrZgb?utm_scene=team_space',
    },
  ]);
});

test('normalizeDocuments：结构认不出时从文本里捞 alidocs 链接', () => {
  const list = normalizeDocuments('找到文档：https://alidocs.dingtalk.com/i/nodes/xyz?x=1 请查看');
  assert.equal(list.length, 1);
  assert.match(list[0].url, /nodes\/xyz/);
});

test('候选：联系人副标题带职位，文档标题进 altTitles', () => {
  const contact = contactToCandidate({ userId: 'u1', name: '张三', dept: '研发部' });
  assert.equal(contact.kind, 'contact');
  assert.equal(contact.subtitle, '研发部  ·  钉钉联系人');

  const doc = docToCandidate({ title: '需求说明', url: 'https://alidocs.dingtalk.com/i/nodes/abc' });
  assert.equal(doc.kind, 'doc');
  assert.equal(doc.subtitle, 'alidocs.dingtalk.com  ·  钉钉文档');
  assert.deepEqual(doc.altTitles, ['https://alidocs.dingtalk.com/i/nodes/abc']);
});

test('worthRemoteQuery：中文单字也查，西文单字符不查', () => {
  assert.equal(worthRemoteQuery('张'), true);
  assert.equal(worthRemoteQuery('需求'), true);
  assert.equal(worthRemoteQuery('z'), false);
  assert.equal(worthRemoteQuery('zh'), true);
  assert.equal(worthRemoteQuery('  '), false);
});

test('联系人 provider：普通搜索只查缓存，不打网络', async () => {
  const fetch = fakeFetch([]);
  const provider = createContactProvider({
    mcpUrl: 'https://mcp-gw.example/contacts',
    openExternal: async () => {},
    cache: { load: async () => ({ contacts: [{ userId: 'u1', name: '张三', dept: '研发部' }] }) },
    fetch,
  });
  await provider.init();

  const items = await provider.search(['张'], { query: { keyword: '张', providerHint: null } });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '张三');
  assert.equal(fetch.calls.length, 0);
});

test('联系人 provider：锁定搜索走 MCP，结果原样收录（服务端已筛过）', async () => {
  const fetch = fakeFetch((n, body) => {
    if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} });
    if (body.method === 'notifications/initialized') return jsonResponse({});
    assert.equal(body.params.name, 'search_contact_by_key_word');
    assert.equal(body.params.arguments.keyword, 'hp');
    // 服务端按拼音命中：结果标题里根本没有 "hp"。
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [
          { type: 'text', text: JSON.stringify({ result: [{ userId: 'u9', name: '庄浩鹏', nick: '大壮' }] }) },
        ],
      },
    });
  });
  let saved = null;
  const provider = createContactProvider({
    mcpUrl: 'https://mcp-gw.example/contacts',
    openExternal: async () => {},
    cache: { load: async () => ({ contacts: [] }), save: async (data) => (saved = data) },
    fetch,
  });
  await provider.init();

  const items = await provider.search(['hp'], { query: { keyword: 'hp', providerHint: 'dingtalk' } });
  assert.equal(items.length, 1);
  assert.equal(items[0].userId, 'u9');
  assert.equal(items[0].serverMatched, true);

  await provider.dispose();
  assert.equal(saved.contacts.length, 1);
});

test('联系人 provider：锁定搜索单字中文也会请求', async () => {
  const fetch = fakeFetch((n, body) => {
    if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} });
    if (body.method === 'notifications/initialized') return jsonResponse({});
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ result: [{ userId: 'u1', name: '张三' }] }) }] },
    });
  });
  const provider = createContactProvider({
    mcpUrl: 'https://mcp-gw.example/contacts',
    openExternal: async () => {},
    cache: { load: async () => null },
    fetch,
  });
  await provider.init();

  const items = await provider.search(['张'], { query: { keyword: '张', providerHint: 'dingtalk' } });
  assert.equal(items.length, 1);
  assert.ok(fetch.calls.some((call) => call.body.method === 'tools/call'));
});

test('联系人 provider：网络失败把原因抛给引擎', async () => {
  const fetch = async () => ({ ok: false, status: 500, headers: { get: () => 'application/json' }, text: async () => '' });
  const provider = createContactProvider({
    mcpUrl: 'https://mcp-gw.example/contacts',
    openExternal: async () => {},
    cache: { load: async () => null },
    fetch,
  });
  await provider.init();
  await assert.rejects(
    () => provider.search(['张'], { query: { keyword: '张三', providerHint: 'dingtalk' } }),
    /钉钉查询失败/,
  );
});

test('联系人 provider：没配 URL 时不打网络也能用', async () => {
  const provider = createContactProvider({ openExternal: async () => {}, cache: { load: async () => null } });
  await provider.init();
  assert.deepEqual(await provider.search(['张'], { query: { keyword: '张', providerHint: 'dingtalk' } }), []);
  assert.equal(provider.stats().configured, false);
});

test('联系人 provider：回车按姓名打开单聊（不走 deep link）', async () => {
  const opened = [];
  const provider = createContactProvider({
    cache: { load: async () => null },
    openChat: async (name) => {
      opened.push(name);
      return { ok: true };
    },
  });
  const result = await provider.activate({ title: '张三丰', userId: 'u1' });
  assert.equal(result.ok, true);
  assert.deepEqual(opened, ['张三丰']);
});

test('联系人 provider：本地索引命中时优先于 MCP，且不带 serverMatched', async () => {
  const provider = createContactProvider({
    mcpUrl: 'https://example.invalid/contact',
    fetch: async () => {
      throw new Error('本地已命中，不该打网络');
    },
    cache: { load: async () => null },
    loadLocal: () => ({
      selfUid: '1000000001',
      people: [{ uid: '2000000002', name: '张三丰', alias: '', dept: '示例科技有限公司' }],
    }),
  });
  await provider.init();
  const items = await provider.search(['张'], { query: { providerHint: 'dingtalk', keyword: '蒋' } });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '张三丰');
  assert.equal(items[0].uid, '2000000002');
  assert.equal(items[0].serverMatched, undefined);
});

test('联系人 provider：本地条目的 avatarId 会带到候选项上，供界面取头像', async () => {
  const provider = createContactProvider({
    cache: { load: async () => null },
    loadLocal: () => ({
      selfUid: '1000000001',
      people: [{ uid: '2000000002', name: '张三丰', dept: '示例科技有限公司', avatarId: 'sampleAvatarMediaId' }],
    }),
  });
  await provider.init();
  const items = await provider.search(['张']);
  assert.equal(items[0].avatarId, 'sampleAvatarMediaId');
});

test('联系人 provider：本地有 uid 时用 cid 直跳，不再驱动搜索面板', async () => {
  const byUid = [];
  const byName = [];
  const provider = createContactProvider({
    cache: { load: async () => null },
    openByUid: async (uid) => {
      byUid.push(uid);
      return { ok: true };
    },
    openChat: async (name) => {
      byName.push(name);
      return { ok: true };
    },
  });
  const result = await provider.activate({ title: '张三丰', uid: '2000000002' });
  assert.equal(result.ok, true);
  assert.deepEqual(byUid, ['2000000002']);
  assert.deepEqual(byName, []);
});

test('联系人 provider：没有 uid 时退回按姓名打开', async () => {
  const byName = [];
  const provider = createContactProvider({
    cache: { load: async () => null },
    openByUid: async () => assert.fail('不该走 uid'),
    openChat: async (name) => {
      byName.push(name);
      return { ok: true };
    },
  });
  await provider.activate({ title: '张三丰', userId: 'u1' });
  assert.deepEqual(byName, ['张三丰']);
});

test('联系人 provider：同名同事靠 uid 区分成不同条目', () => {
  const a = contactToCandidate({ uid: '1001', name: '张伟' });
  const b = contactToCandidate({ uid: '1002', name: '张伟' });
  assert.notEqual(a.id, b.id);
});

test('联系人 provider：没配 openChat / 没姓名时给出可读的失败', async () => {
  const bare = createContactProvider({ cache: { load: async () => null } });
  assert.equal((await bare.activate({ title: '张三丰' })).ok, false);
  const provider = createContactProvider({ cache: { load: async () => null }, openChat: async () => ({ ok: true }) });
  const result = await provider.activate({ userId: 'u1' });
  assert.equal(result.ok, false);
  assert.match(result.message, /姓名/);
});

test('首字色块：中文名取后两字，西文名取首字母', () => {
  assert.equal(initialsOf('张三丰'), '三丰');
  assert.equal(initialsOf('庄浩鹏'), '浩鹏');
  assert.equal(initialsOf('张三'), '张三');
  assert.equal(initialsOf('李'), '李');
  assert.equal(initialsOf('Alice Brown'), 'AB');
  assert.equal(initialsOf('bob'), 'bo');
  assert.equal(initialsOf('  '), '');
  assert.equal(contactToCandidate({ userId: 'u1', name: '张三丰' }).initials, '三丰');
});

test('联系人 provider：群聊功能已移除，带 conversationId 的条目不再处理', async () => {
  const opened = [];
  const provider = createContactProvider({
    openExternal: async (uri) => opened.push(uri),
    cache: { load: async () => null },
  });
  const result = await provider.activate({ conversationId: 'cid9' });
  assert.equal(result.ok, false);
  assert.deepEqual(opened, []);
});

test('文档 provider：回车先用钉钉内置浏览器打开', async () => {
  const opened = [];
  const provider = createDocumentProvider({
    openExternal: async (uri) => opened.push(uri),
    cache: { load: async () => null },
  });
  const result = await provider.activate({ url: 'https://alidocs.dingtalk.com/i/nodes/abc' });
  assert.equal(result.ok, true);
  assert.match(opened[0], /^dingtalk:\/\/dingtalkclient\/page\/link\?url=https%3A%2F%2Falidocs/);
});

test('文档 provider：内置浏览器失败时退回系统浏览器', async () => {
  const opened = [];
  const provider = createDocumentProvider({
    openExternal: async (uri) => {
      opened.push(uri);
      if (uri.startsWith('dingtalk:')) throw new Error('no handler');
    },
    cache: { load: async () => null },
  });
  const result = await provider.activate({ url: 'https://alidocs.dingtalk.com/i/nodes/abc' });
  assert.equal(result.ok, true);
  assert.equal(opened.length, 2);
  assert.equal(opened[1], 'https://alidocs.dingtalk.com/i/nodes/abc');
});

test('文档 provider：两种方式都失败时报"可能没有权限"', async () => {
  const provider = createDocumentProvider({
    openExternal: async () => {
      throw new Error('denied');
    },
    cache: { load: async () => null },
  });
  const result = await provider.activate({ url: 'https://alidocs.dingtalk.com/i/nodes/abc' });
  assert.equal(result.ok, false);
  assert.match(result.message, /没有访问权限/);
});

test('文档 provider：缓存命中时不打网络，锁定搜索原样收录远程结果', async () => {
  const fetch = fakeFetch((n, body) => {
    if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} });
    if (body.method === 'notifications/initialized') return jsonResponse({});
    assert.equal(body.params.name, 'search_documents');
    // 服务端按正文检索：标题里没有 "库存"。
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              documents: [{ name: '接口卡清单', docUrl: 'https://alidocs.dingtalk.com/i/nodes/k' }],
            }),
          },
        ],
      },
    });
  });
  const provider = createDocumentProvider({
    mcpUrl: 'https://mcp-gw.example/docs',
    openExternal: async () => {},
    cache: { load: async () => ({ documents: [{ title: '需求说明', url: 'https://alidocs.dingtalk.com/i/nodes/a' }] }) },
    fetch,
  });
  await provider.init();

  const local = await provider.search(['需求'], { query: { keyword: '需求', providerHint: null } });
  assert.equal(local.length, 1);
  assert.equal(fetch.calls.length, 0);

  const remote = await provider.search(['库存'], { query: { keyword: '库存', providerHint: 'dingdoc' } });
  assert.equal(remote.length, 1);
  assert.equal(remote[0].title, '接口卡清单');
  assert.equal(remote[0].serverMatched, true);
  assert.ok(fetch.calls.length > 0);
});

test('文档 provider：远程搜到的结果在普通搜索里也能凭关键词找回', async () => {
  const fetch = fakeFetch((n, body) => {
    if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} });
    if (body.method === 'notifications/initialized') return jsonResponse({});
    // 正文命中：标题里没有“库存”这两个字
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              documents: [{ name: '接口卡清单', docUrl: 'https://alidocs.dingtalk.com/i/nodes/k' }],
            }),
          },
        ],
      },
    });
  });
  const saved = [];
  const provider = createDocumentProvider({
    mcpUrl: 'https://mcp-gw.example/docs',
    openExternal: async () => {},
    cache: { load: async () => null, save: async (data) => saved.push(data) },
    fetch,
  });
  await provider.init();

  await provider.search(['库存'], { query: { keyword: '库存', providerHint: 'dingdoc' } });
  await provider.dispose();

  // 下次启动：只用缓存，不许联网
  const offline = createDocumentProvider({
    mcpUrl: 'https://mcp-gw.example/docs',
    openExternal: async () => {},
    cache: { load: async () => saved[saved.length - 1] },
    fetch: async () => assert.fail('普通搜索不该联网'),
  });
  await offline.init();
  const hits = await offline.search(['库存'], { query: { keyword: '库存', providerHint: null } });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, '接口卡清单');
  // 标题里没有关键词，必须带 serverMatched，排序层才会保底收录而不是丢掉
  assert.equal(hits[0].serverMatched, true);
});

test('查询缓存：同一关键词 90 秒内不重复请求', async () => {
  let nowValue = 1000;
  const fetch = fakeFetch((n, body) => {
    if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} });
    if (body.method === 'notifications/initialized') return jsonResponse({});
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ list: [{ userId: 'u1', name: '张三' }] }) }] },
    });
  });
  const provider = createContactProvider({
    mcpUrl: 'https://mcp-gw.example/contacts',
    openExternal: async () => {},
    cache: { load: async () => null },
    fetch,
    now: () => nowValue,
  });
  await provider.init();

  await provider.search(['张'], { query: { keyword: '张三', providerHint: 'dingtalk' } });
  const afterFirst = fetch.calls.length;
  await provider.search(['张'], { query: { keyword: '张三', providerHint: 'dingtalk' } });
  assert.equal(fetch.calls.length, afterFirst);

  nowValue += 91_000;
  await provider.search(['张'], { query: { keyword: '张三', providerHint: 'dingtalk' } });
  assert.ok(fetch.calls.length > afterFirst);
});
