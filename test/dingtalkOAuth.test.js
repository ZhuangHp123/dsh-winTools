'use strict';

/**
 * 钉钉 MCP OAuth 单测。
 *
 * fetch / 浏览器 / 回调全部注入或本地回环，不碰真实钉钉账号。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');

const {
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
} = require('../src/dingtalk/oauth');

function response(body, init = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: init.status ? init.status < 400 : true,
    status: init.status ?? 200,
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        if (init.headers) {
          for (const [k, v] of Object.entries(init.headers)) if (k.toLowerCase() === key) return v;
        }
        return key === 'content-type' ? 'application/json' : null;
      },
    },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const ENDPOINTS = {
  authorizationEndpoint: 'https://as.example/oauth/authorize',
  tokenEndpoint: 'https://as.example/oauth/token',
  registrationEndpoint: 'https://as.example/oauth/register',
};

/** .well-known 的线上格式是 snake_case。 */
const WIRE_META = {
  issuer: 'https://as.example',
  authorization_endpoint: ENDPOINTS.authorizationEndpoint,
  token_endpoint: ENDPOINTS.tokenEndpoint,
  registration_endpoint: ENDPOINTS.registrationEndpoint,
};

test('base64url / PKCE：challenge 是 verifier 的 SHA256', () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9\-_]+$/);
  assert.equal(verifier.length, 43);
  assert.equal(challenge, base64url(createHash('sha256').update(verifier).digest()));
});

test('discoverAuthServer：从 401 的 resource_metadata 拿到授权服务器', async () => {
  const fetch = recordingFetch((url) => {
    if (url === 'https://mcp-gw.example/x') {
      return response('', {
        status: 401,
        headers: {
          'www-authenticate': 'Bearer realm="mcp", resource_metadata="https://mcp-gw.example/.well-known/oauth-protected-resource/x"',
        },
      });
    }
    return response({ resource: 'x', authorization_servers: ['https://mcp-gw2.example'] });
  });
  assert.equal(await discoverAuthServer('https://mcp-gw.example/x', { fetch }), 'https://mcp-gw2.example');
  assert.equal(fetch.calls.length, 2);
});

test('discoverAuthServer：异常时退回默认授权服务器', async () => {
  const fetch = async () => {
    throw new Error('offline');
  };
  assert.equal(await discoverAuthServer('https://x/y', { fetch }), DEFAULT_AUTH_SERVER);
});

test('discoverEndpoints：读出三个端点', async () => {
  const fetch = async () =>
    response({
      authorization_endpoint: 'https://as/authorize',
      token_endpoint: 'https://as/token',
      registration_endpoint: 'https://as/register',
    });
  assert.deepEqual(await discoverEndpoints('https://as', { fetch }), {
    authorizationEndpoint: 'https://as/authorize',
    tokenEndpoint: 'https://as/token',
    registrationEndpoint: 'https://as/register',
  });
});

test('registerClient：发 RFC 7591 请求体并拿回 client_id', async () => {
  const fetch = recordingFetch(() => response({ client_id: 'cid', client_secret: 'sec' }, { status: 201 }));
  const result = await registerClient('https://as/register', 'http://127.0.0.1:1234/callback', { fetch });
  assert.deepEqual(result, { clientId: 'cid', clientSecret: 'sec' });

  const body = JSON.parse(fetch.calls[0].init.body);
  assert.deepEqual(body.redirect_uris, ['http://127.0.0.1:1234/callback']);
  assert.equal(body.token_endpoint_auth_method, 'client_secret_post');
  assert.deepEqual(body.grant_types, ['authorization_code', 'refresh_token']);
});

test('registerClient：失败时报状态码', async () => {
  const fetch = async () => response('nope', { status: 400 });
  await assert.rejects(() => registerClient('https://as/register', 'http://127.0.0.1:1/cb', { fetch }), /HTTP 400/);
});

test('startLoopbackServer：只接受 /callback 并回传 code/state', async () => {
  const server = await startLoopbackServer({ timeout: 5000 });
  try {
    const waiting = server.waitForCode();
    const res = await fetch(server.redirectUri.replace('/callback', '/callback') + '?code=abc&state=xyz');
    const text = await res.text();
    assert.match(server.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.deepEqual(await waiting, { code: 'abc', state: 'xyz' });
    assert.match(text, /授权完成/);
  } finally {
    server.close();
  }
});

test('startLoopbackServer：其它路径返回 404，不结算', async () => {
  const server = await startLoopbackServer({ timeout: 5000 });
  try {
    const res = await fetch(server.redirectUri.replace('/callback', '/other'));
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('exchangeCode：带 PKCE 与 client_secret 换 token', async () => {
  const fetch = recordingFetch(() =>
    response({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
  );
  const token = await exchangeCode(
    ENDPOINTS,
    { code: 'c', redirectUri: 'http://127.0.0.1:1/cb', clientId: 'cid', clientSecret: 'sec', codeVerifier: 'v' },
    { fetch },
  );
  assert.equal(token.accessToken, 'at');
  assert.equal(token.refreshToken, 'rt');
  assert.ok(token.expiresAt > Date.now() + 50 * 60 * 1000);

  const params = new URLSearchParams(fetch.calls[0].init.body);
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(params.get('code_verifier'), 'v');
  assert.equal(params.get('client_secret'), 'sec');
});

test('exchangeCode：token 错误体转成可读消息', async () => {
  const fetch = async () => response({ error: 'invalid_grant', error_description: 'code expired' }, { status: 400 });
  await assert.rejects(
    () => exchangeCode(ENDPOINTS, { code: 'c', redirectUri: 'r', clientId: 'i', codeVerifier: 'v' }, { fetch }),
    /code expired/,
  );
});

test('refreshToken：用 refresh_token 换新 token', async () => {
  const fetch = recordingFetch(() => response({ access_token: 'at2', expires_in: 100 }));
  const token = await refreshToken(ENDPOINTS, { refreshToken: 'rt', clientId: 'cid' }, { fetch });
  assert.equal(token.accessToken, 'at2');
  assert.equal(token.refreshToken, null);
  const params = new URLSearchParams(fetch.calls[0].init.body);
  assert.equal(params.get('grant_type'), 'refresh_token');
});

test('OAuth 管理器：已有有效 token 时直接返回，不登录', async () => {
  const fetch = async () => {
    throw new Error('should not fetch');
  };
  let loginCalls = 0;
  const manager = createOAuthManager({
    mcpUrl: 'https://mcp-gw.example/x',
    fetch,
    store: { load: async () => ({ clientId: 'c', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60000 }) },
    openBrowser: async () => {
      loginCalls += 1;
    },
  });
  await manager.load();
  assert.equal(await manager.getToken(), 'at');
  assert.equal(loginCalls, 0);
});

test('OAuth 管理器：token 过期时用 refresh_token 自动续期', async () => {
  let nowValue = 1000;
  const fetch = recordingFetch((url) => {
    if (url.endsWith('/.well-known/oauth-authorization-server')) return response(WIRE_META);
    if (url === ENDPOINTS.tokenEndpoint) return response({ access_token: 'at-new', expires_in: 3600 });
    return response('', { status: 404 });
  });
  const saved = [];
  const manager = createOAuthManager({
    mcpUrl: 'https://mcp-gw.example/x',
    fetch,
    now: () => nowValue,
    store: {
      load: async () => ({ clientId: 'c', clientSecret: null, accessToken: 'old', refreshToken: 'rt', expiresAt: 500 }),
      save: async (data) => saved.push(data),
    },
    openBrowser: async () => {
      throw new Error('不该打开浏览器');
    },
  });
  await manager.load();
  assert.equal(await manager.getToken(), 'at-new');
  assert.equal(saved.at(-1).accessToken, 'at-new');
  assert.equal(saved.at(-1).refreshToken, 'rt'); // 服务端没给新的，保留旧的
});

test('OAuth 管理器：refresh 也失败时返回 null（触发重新登录）', async () => {
  const fetch = recordingFetch((url) => {
    if (url.endsWith('/.well-known/oauth-authorization-server')) return response(WIRE_META);
    return response({ error: 'invalid_grant' }, { status: 400 });
  });
  const manager = createOAuthManager({
    mcpUrl: 'https://mcp-gw.example/x',
    fetch,
    store: { load: async () => ({ clientId: 'c', accessToken: 'old', refreshToken: 'rt', expiresAt: 0 }) },
    openBrowser: async () => {
      throw new Error('不该打开浏览器');
    },
  });
  await manager.load();
  // currentToken 不会自动弹登录（那是 onUnauthorized 的职责），只报告"没有可用 token"。
  assert.equal(await manager.currentToken(), null);
  assert.equal(manager.loggedIn, false);
});

test('OAuth 管理器：完整登录流程（注册 → 授权 → 换 token）', async () => {
  let redirected = null;
  const fetch = recordingFetch((url, init) => {
    if (url === 'https://mcp-gw.example/x') {
      return response('', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp-gw.example/.well-known/x"' },
      });
    }
    if (url === 'https://mcp-gw.example/.well-known/x') return response({ authorization_servers: ['https://as.example'] });
    if (url.endsWith('/.well-known/oauth-authorization-server')) return response(WIRE_META);
    if (url === ENDPOINTS.registrationEndpoint) return response({ client_id: 'cid', client_secret: 'sec' }, { status: 201 });
    if (url === ENDPOINTS.tokenEndpoint) return response({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    return response('', { status: 404 });
  });

  const notices = [];
  const manager = createOAuthManager({
    mcpUrl: 'https://mcp-gw.example/x',
    fetch,
    store: { load: async () => null, save: async () => true },
    onNotice: (message) => notices.push(message),
    openBrowser: async (uri) => {
      redirected = new URL(uri);
      // 模拟用户在浏览器里完成授权后网关回调本机。
      // 这一跳必须走真实 HTTP：真实世界里是浏览器发起的，不经过 MCP 的 fetch。
      const redirectUri = redirected.searchParams.get('redirect_uri');
      const state = redirected.searchParams.get('state');
      await globalThis.fetch(`${redirectUri}?code=auth-code&state=${state}`);
    },
  });
  await manager.load();

  assert.equal(await manager.getToken(), 'at');
  assert.equal(redirected.origin + redirected.pathname, 'https://as.example/oauth/authorize');
  assert.equal(redirected.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(redirected.searchParams.get('client_id'), 'cid');
  assert.equal(redirected.searchParams.get('resource'), 'https://mcp-gw.example/x');
  assert.ok(redirected.searchParams.get('code_challenge'));
  assert.ok(notices.some((n) => n.includes('授权完成')));
  assert.equal(manager.loggedIn, true);
});

test('OAuth 管理器：state 不匹配时中止', async () => {
  const fetch = recordingFetch((url) => {
    if (url.endsWith('/.well-known/oauth-authorization-server')) return response(WIRE_META);
    if (url === ENDPOINTS.registrationEndpoint) return response({ client_id: 'cid' });
    return response('', { status: 404 });
  });
  const manager = createOAuthManager({
    mcpUrl: 'https://mcp-gw.example/x',
    authServer: 'https://as.example',
    fetch,
    store: { load: async () => null },
    openBrowser: async (uri) => {
      const redirectUri = new URL(uri).searchParams.get('redirect_uri');
      await globalThis.fetch(`${redirectUri}?code=c&state=WRONG`);
    },
  });
  await manager.load();
  await assert.rejects(() => manager.getToken(), /state 不匹配/);
});
