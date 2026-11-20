'use strict';

/**
 * 极简 MCP 客户端（Streamable HTTP）。
 *
 * 只实现启动器需要的这一小块：initialize 握手 + tools/call。
 * 不是通用 SDK——不处理采样、通知、资源订阅，也不做重连；
 * 出错就把错误抛给调用方，由 provider 决定怎么降级。
 *
 * 为什么手写而不引 SDK：启动器没有打包步骤、没有运行时依赖，
 * 引入 @modelcontextprotocol/sdk 会带来一堆 `node:` 之外的东西，
 * 而这里需要的协议面只有三个字段（id / method / params）。
 *
 * 服务端可能回 JSON，也可能回 text/event-stream（Streamable HTTP 允许两种），
 * 两种都要能读。响应里只有 id 对得上的那一条才是我们要的。
 */

/** 从 SSE 文本里挑出和 id 匹配的那条 JSON-RPC 响应。 */
function parseSseForId(text, id) {
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join('\n');
    dataLines = [];
    try {
      const parsed = JSON.parse(payload);
      if (parsed && String(parsed.id) === String(id) && ('result' in parsed || 'error' in parsed)) {
        return parsed;
      }
    } catch {
      /* 不是 JSON 的 event 直接跳过 */
    }
    return null;
  };

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') {
      const hit = flush();
      if (hit) return hit;
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // event:/id:/retry: 与 comment 行（':'）与业务无关，忽略。
  }
  return flush();
}

/** 把 HTTP 响应体解析成 JSON-RPC 消息，JSON 和 SSE 都认。 */
async function readRpcResponse(response, id) {
  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
  const text = await response.text();

  if (contentType.includes('text/event-stream')) {
    const hit = parseSseForId(text, id);
    if (hit) return hit;
    // SSE 里没找到对应 id 的响应，说明服务端只是推了通知。
    return null;
  }
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.find((m) => String(m?.id) === String(id)) ?? null : parsed;
  } catch (error) {
    throw new Error(`MCP 响应不是 JSON：${text.slice(0, 200)}`);
  }
}

/**
 * 创建 MCP 客户端。
 * @param {object} options
 * @param {string} options.url StreamableHttp URL
 * @param {object} [options.headers] 额外请求头
 * @param {()=>Promise<string|null>} [options.getToken] 每次请求前取 Bearer token（OAuth）
 * @param {()=>Promise<string>} [options.onUnauthorized] 401 时换新 token，返回后重试一次
 * @param {(input:string, init:object)=>Promise<Response>} [options.fetch] 注入（测试用）
 * @param {number} [options.timeout] 单次请求超时（毫秒）
 */
function createMcpClient(options = {}) {
  const url = options.url;
  if (!url) throw new Error('MCP 客户端缺少 url');
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('当前运行时没有 fetch');
  const requestTimeout = Number.isFinite(options.timeout) ? options.timeout : 8000;
  const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(options.headers ?? {}),
  };

  let sessionId = null;
  let nextId = 1;
  let initialized = false;
  let initPromise = null;

  async function headers() {
    const h = { ...baseHeaders };
    if (sessionId) h['mcp-session-id'] = sessionId;
    if (typeof options.getToken === 'function') {
      const token = await options.getToken();
      if (token) h.authorization = `Bearer ${token}`;
    }
    return h;
  }

  async function post(body, retryOn401 = true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sid = response.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      if (!response.ok) {
        // token 失效：换一个再试一次。重试仍失败就当普通错误。
        if (response.status === 401 && retryOn401 && typeof options.onUnauthorized === 'function') {
          await options.onUnauthorized();
          initialized = false;
          return post(body, false);
        }
        const text = await response.text().catch(() => '');
        const error = new Error(`MCP HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`);
        error.status = response.status;
        throw error;
      }
      return response;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`MCP 请求超时（${requestTimeout}ms）`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 握手。并发调用共用同一个 promise，失败后允许重试。 */
  function initialize() {
    if (initialized) return Promise.resolve();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const id = nextId++;
      const response = await post({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'dsh-wintools', version: '1.0.0' },
        },
      });
      const message = await readRpcResponse(response, id);
      if (message?.error) throw new Error(`MCP 初始化失败：${message.error.message ?? 'unknown'}`);
      initialized = true;
      // 规范要求握手后发一条 notifications/initialized；服务端不要求就忽略失败。
      try {
        await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      } catch {
        /* 通知失败不影响后续调用 */
      }
    })().finally(() => {
      initPromise = null;
    });
    return initPromise;
  }

  /**
   * 调用工具。
   * @param {string} name
   * @param {object} [args]
   * @returns {Promise<object>} result 字段原样返回
   */
  async function callTool(name, args = {}) {
    await initialize();
    const id = nextId++;
    const response = await post({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const message = await readRpcResponse(response, id);
    if (!message) throw new Error('MCP 没有返回结果');
    if (message.error) throw new Error(`MCP 工具 ${name} 失败：${message.error.message ?? 'unknown'}`);
    return message.result ?? null;
  }

  /** 列出工具（调试/自检用）。 */
  async function listTools() {
    await initialize();
    const id = nextId++;
    const response = await post({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
    const message = await readRpcResponse(response, id);
    if (message?.error) throw new Error(`MCP tools/list 失败：${message.error.message ?? 'unknown'}`);
    return message?.result?.tools ?? [];
  }

  return {
    initialize,
    callTool,
    listTools,
    get sessionId() {
      return sessionId;
    },
    get initialized() {
      return initialized;
    },
  };
}

/**
 * tools/call 的结果常常是 content: [{type:'text', text:'<json>'}].
 * 这里把里面的 JSON 解析出来；解析不了就返回原文。
 */
function unwrapToolResult(result) {
  if (!result) return null;
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text);
  if (texts.length === 0) return result.structuredContent ?? null;

  const raw = texts.join('\n').trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

module.exports = { createMcpClient, parseSseForId, unwrapToolResult };
