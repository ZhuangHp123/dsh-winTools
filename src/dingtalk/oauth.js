'use strict';

/**
 * 钉钉 MCP 网关的 OAuth 登录。
 *
 * 钉钉的 MCP 网关（mcp-gw.dingtalk.com/oauth/server/<name>）不接受静态 key，
 * 而是标准 OAuth 2.1：先拿 401 的 www-authenticate 找到授权服务器，
 * 动态注册一个本机客户端，走 PKCE + 回环回调拿 token，之后用 Bearer 调用。
 *
 * 这里只做 RFC 8252（原生应用）那套最保守的流程：
 *   - 客户端动态注册（RFC 7591），回调地址是 http://127.0.0.1:<随机端口>/callback
 *   - PKCE S256，不给别人截胡的机会
 *   - token 存在用户数据目录，过期前自动刷新，refresh_token 也失效才要求重新登录
 *
 * 不引第三方库：需要的东西（http、crypto、fetch）Node 都有。
 */

const http = require('node:http');
const crypto = require('node:crypto');

const DEFAULT_AUTH_SERVER = 'https://mcp-gw2.dingtalk.com';
const SCOPE = 'user';
const LOGIN_TIMEOUT = 3 * 60 * 1000;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function randomState() {
  return base64url(crypto.randomBytes(16));
}

/**
 * 发现某个 MCP 端点的授权服务器（读 401 响应头里的 resource_metadata）。
 * 网络不通或格式不对时退回钉钉的默认授权服务器。
 */
async function discoverAuthServer(mcpUrl, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  try {
    const response = await doFetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
      }),
    });
    const challenge = response.headers.get('www-authenticate') ?? '';
    const match = /resource_metadata="([^"]+)"/i.exec(challenge);
    if (!match) return DEFAULT_AUTH_SERVER;

    const metaRes = await doFetch(match[1], { headers: { accept: 'application/json' } });
    if (!metaRes.ok) return DEFAULT_AUTH_SERVER;
    const meta = await metaRes.json();
    const server = Array.isArray(meta?.authorization_servers) ? meta.authorization_servers[0] : null;
    return typeof server === 'string' && server ? server : DEFAULT_AUTH_SERVER;
  } catch {
    return DEFAULT_AUTH_SERVER;
  }
}

/** 读授权服务器的 .well-known/oauth-authorization-server。 */
async function discoverEndpoints(authServer, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(`${authServer}/.well-known/oauth-authorization-server`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`读取授权服务器元数据失败：HTTP ${res.status}`);
  const meta = await res.json();
  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
  };
}

/** RFC 7591 动态注册本机客户端。 */
async function registerClient(registrationEndpoint, redirectUri, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'dsh-wintools',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: SCOPE,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`注册 OAuth 客户端失败：HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
  }
  const data = await res.json();
  if (!data?.client_id) throw new Error('注册 OAuth 客户端失败：没有 client_id');
  return { clientId: data.client_id, clientSecret: data.client_secret ?? null };
}

/**
 * 起一个只处理一次回调的本地 http 服务。
 * @returns {Promise<{redirectUri:string, waitForCode:()=>Promise<{code:string,state:string}>, close:()=>void}>}
 */
function startLoopbackServer(options = {}) {
  return new Promise((resolve, reject) => {
    let settle;
    let fail;
    const codePromise = new Promise((res, rej) => {
      settle = res;
      fail = rej;
    });
    const server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        error
          ? '<html><body style="font-family:sans-serif">授权失败，可以关闭此页。</body></html>'
          : '<html><body style="font-family:sans-serif">授权完成，可以关闭此页。</body></html>',
      );
      if (error) fail(new Error(`授权被拒绝：${error}`));
      else settle({ code: code ?? '', state: state ?? '' });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const timer = setTimeout(() => fail(new Error('授权超时，请重试')), options.timeout ?? LOGIN_TIMEOUT);
      if (typeof timer.unref === 'function') timer.unref();
      resolve({
        redirectUri,
        waitForCode: () => codePromise,
        close: () => {
          clearTimeout(timer);
          try {
            server.close();
          } catch {
            /* 已经关了 */
          }
        },
      });
    });
  });
}

/**
 * 用授权码换 token。
 * @returns {Promise<{accessToken:string, refreshToken:string|null, expiresAt:number}>}
 */
async function exchangeCode(endpoints, params, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  if (params.clientSecret) body.set('client_secret', params.clientSecret);
  // RFC 8707：资源指示器。MCP 网关用它把 token 绑定到具体端点，缺了会 invalid_request。
  if (params.resource) body.set('resource', params.resource);
  return tokenRequest(endpoints.tokenEndpoint, body, doFetch);
}

async function refreshToken(endpoints, params, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
  if (params.clientSecret) body.set('client_secret', params.clientSecret);
  if (params.resource) body.set('resource', params.resource);
  return tokenRequest(endpoints.tokenEndpoint, body, doFetch);
}

async function tokenRequest(tokenEndpoint, body, doFetch) {
  const res = await doFetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 错误体 */
  }
  if (!res.ok || !data.access_token) {
    const reason = data.error_description || data.error || text.slice(0, 200);
    throw new Error(`获取 token 失败：HTTP ${res.status}${reason ? ` ${reason}` : ''}`);
  }
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    // 留 60 秒余量，避免刚好在过期瞬间发请求。
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? Math.max(0, expiresIn - 60) * 1000 : 50 * 60 * 1000),
  };
}

/**
 * 创建 OAuth 管理器。
 *
 * 一个管理器对应一个 MCP 端点：不同服务的 token 作用域不同，不能混用。
 *
 * @param {object} options
 * @param {string} options.mcpUrl 受保护的 MCP 端点
 * @param {string} [options.authServer] 已知授权服务器（跳过发现）
 * @param {{load:()=>Promise<object|null>, save:(d:object)=>Promise<boolean>}} [options.store]
 * @param {(url:string)=>Promise<void>} options.openBrowser 打开系统浏览器
 * @param {(message:string)=>void} [options.onNotice] 登录状态提示
 * @param {Function} [options.fetch]
 * @param {()=>number} [options.now]
 */
function createOAuthManager(options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const mcpUrl = options.mcpUrl;
  if (!mcpUrl) throw new Error('OAuth 管理器缺少 mcpUrl');

  let state = null; // { clientId, clientSecret, accessToken, refreshToken, expiresAt }
  let endpoints = null;
  let authServer = options.authServer ?? null;
  let loginPromise = null;

  async function persist() {
    if (!state) return;
    await options.store?.save?.(state);
  }

  async function ensureEndpoints() {
    if (endpoints) return endpoints;
    if (!authServer) authServer = await discoverAuthServer(mcpUrl, { fetch: doFetch });
    endpoints = await discoverEndpoints(authServer, { fetch: doFetch });
    return endpoints;
  }

  /** 未登录时返回 null，登录过但过期则刷新。 */
  async function currentToken() {
    if (!state?.accessToken) return null;
    if (state.expiresAt > now()) return state.accessToken;
    if (!state.refreshToken) return null;
    const eps = await ensureEndpoints();
    try {
      const fresh = await refreshToken(
        eps,
        {
          refreshToken: state.refreshToken,
          clientId: state.clientId,
          clientSecret: state.clientSecret,
          resource: mcpUrl,
        },
        { fetch: doFetch },
      );
      state = { ...state, ...fresh, refreshToken: fresh.refreshToken ?? state.refreshToken };
      await persist();
      return state.accessToken;
    } catch {
      // refresh_token 也废了，只能重新登录。
      state = { ...state, accessToken: null, refreshToken: null, expiresAt: 0 };
      await persist();
      return null;
    }
  }

  /** 走一遍完整登录。并发调用共用同一个 promise。 */
  function login() {
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      const eps = await ensureEndpoints();
      const server = await startLoopbackServer();
      try {
        let clientId = state?.clientId;
        let clientSecret = state?.clientSecret;
        if (!clientId) {
          const registered = await registerClient(eps.registrationEndpoint, server.redirectUri, { fetch: doFetch });
          clientId = registered.clientId;
          clientSecret = registered.clientSecret;
        }

        const pkce = createPkce();
        const nonce = randomState();
        const authorizeUrl = new URL(eps.authorizationEndpoint);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', clientId);
        authorizeUrl.searchParams.set('redirect_uri', server.redirectUri);
        authorizeUrl.searchParams.set('scope', SCOPE);
        authorizeUrl.searchParams.set('state', nonce);
        authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        // 把 token 绑定到这个 MCP 资源；网关缺了它会以 invalid_request 拒绝。
        authorizeUrl.searchParams.set('resource', mcpUrl);

        options.onNotice?.('请在浏览器里完成钉钉授权…');
        await options.openBrowser(authorizeUrl.toString());
        const callback = await server.waitForCode();
        if (callback.state !== nonce) throw new Error('授权回调的 state 不匹配，已中止');

        const token = await exchangeCode(
          eps,
          {
            code: callback.code,
            redirectUri: server.redirectUri,
            clientId,
            clientSecret,
            codeVerifier: pkce.verifier,
            resource: mcpUrl,
          },
          { fetch: doFetch },
        );
        state = { clientId, clientSecret, ...token };
        await persist();
        options.onNotice?.('钉钉授权完成');
        return state.accessToken;
      } finally {
        server.close();
        loginPromise = null;
      }
    })();
    return loginPromise;
  }

  /** 保证有可用 token：有就返回，没有就登录。 */
  async function getToken() {
    const existing = await currentToken();
    if (existing) return existing;
    return login();
  }

  async function load() {
    const saved = await options.store?.load?.();
    if (saved && typeof saved === 'object' && saved.accessToken !== undefined) state = saved;
  }

  return {
    load,
    getToken,
    currentToken,
    login,
    get loggedIn() {
      return Boolean(state?.accessToken);
    },
    get authServer() {
      return authServer;
    },
    get endpoints() {
      return endpoints;
    },
    // 测试用
    _state: () => state,
  };
}

module.exports = {
  createOAuthManager,
  discoverAuthServer,
  discoverEndpoints,
  registerClient,
  startLoopbackServer,
  exchangeCode,
  refreshToken,
  createPkce,
  base64url,
  DEFAULT_AUTH_SERVER,
};
