'use strict';

/**
 * 钉钉联系人 / 钉钉文档。
 *
 * 联系人优先读钉钉本地库（localIndex.js）：500 多人一次读出，姓名、工号、
 * 数字 uid 都在里面，搜索零延迟，也不需要 OAuth。MCP 网关留作兜底——本地没有
 * 的人（比如别的组织的同事）才去问服务端。
 * 文档仍然只走 MCP 网关：文档不在本地库里，而且权限判断在服务端做，没权限的
 * 搜不到，天然不会越权。
 *
 * 性能约束：这是网络请求，不能每次按键都打一轮。所以：
 *   - 不带锁定的普通搜索只匹配**本地缓存**（曾经搜到过的联系人和文档），零延迟；
 *   - 只有显式 `联系人 xxx` / `文档 xxx` 才走网络，并把结果写进缓存；
 *   - 同一关键词 90 秒内不重复请求。
 *
 * 注意服务端的命中规则比本地宽松：联系人支持拼音首字母（hp → 庄浩鹏），
 * 文档按正文检索（标题里可能完全没有关键词）。这类结果本地模糊匹配不出来，
 * 所以远程结果一律带 `serverMatched: true`，由排序层保底收录。
 *
 * 联系人回车的动作是打开与 TA 的单聊。本地索引能拼出单聊 cid（两个数字 uid
 * 升序拼接），直接用客户端的 `page/conversation?cid=` 协议一跳到位，实测 150ms
 * 就落到正确聊天。拿不到本地数据时才退回驱动搜索面板的老路子（openChat.js）。
 * 文档回车优先在钉钉内置浏览器打开（复用登录态），失败再退到系统浏览器。
 */

const { createMcpClient, unwrapToolResult } = require('./mcpClient');
const { pinyinInitials } = require('../core/pinyin');

// 通讯录端点上真正的搜索工具。名字很像的 search_user_by_key_word 只回 userId 数组，
// 不带姓名，还要再补一次查人接口，白跑一轮。
const CONTACT_TOOL = 'search_contact_by_key_word';
const CONTACT_TOOL_PARAM = 'keyword';
const DOC_TOOL = 'search_documents';

/** 远程查询的超时（毫秒）。引擎用 provider.timeout 覆盖统一预算。 */
const REMOTE_TIMEOUT = 6000;

/** 同一关键词的远程结果缓存时长。 */
const QUERY_CACHE_TTL = 90_000;

/** 缓存条数上限，防止长期使用后文件膨胀。 */
const MAX_CACHED_CONTACTS = 400;
const MAX_CACHED_DOCS = 400;

const CONTACT_ID_FIELDS = ['userId', 'userid', 'user_id', 'staffId', 'staff_id', 'dingId', 'ding_id', 'id'];
const CONTACT_NAME_FIELDS = ['name', 'nick', 'nickName', 'nickname', 'displayName', 'userName'];
// 实测返回里 title 是职位（如“后端开发工程师”），比部门更常见，一起当副标题用。
const CONTACT_DEPT_FIELDS = [
  'deptName',
  'dept_name',
  'department',
  'departmentName',
  'orgName',
  'jobNumber',
  'workNo',
  'title',
];

const DOC_TITLE_FIELDS = ['title', 'name', 'docName', 'doc_name', 'fileName'];
const DOC_URL_FIELDS = ['url', 'docUrl', 'doc_url', 'link', 'openUrl', 'jumpUrl', 'shareUrl'];

function firstString(object, fields) {
  for (const field of fields) {
    const value = object?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/**
 * 在任意嵌套结构里找出所有"长得像"某个实体的对象。
 * MCP 返回的包装层各家不一样（data / result / list / 直接数组），
 * 与其猜路径，不如按字段特征遍历。
 */
function collectObjects(root, predicate, maxDepth = 6) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || depth > maxDepth || out.length >= 200) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (predicate(node)) {
      out.push(node);
      return;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(root, 0);
  return out;
}

/**
 * 联系人结果 → { userId, name, dept, nick, openId }（去重、丢掉没名字的）。
 * 实测网关返回 `{ result: [{ nick, name, title, userId, openDingTalkId }] }`，
 * 其中 title 是职位；nick 常和 name 相同，偶尔不同，两个都拿来搜。
 */
function normalizeContacts(payload) {
  const objects = collectObjects(payload, (o) => {
    const name = firstString(o, CONTACT_NAME_FIELDS);
    const id = firstString(o, CONTACT_ID_FIELDS);
    return Boolean(name && id && !firstString(o, DOC_URL_FIELDS));
  });
  const byId = new Map();
  for (const object of objects) {
    const userId = firstString(object, CONTACT_ID_FIELDS);
    const name = firstString(object, CONTACT_NAME_FIELDS);
    if (!userId || !name) continue;
    const dept = firstString(object, CONTACT_DEPT_FIELDS);
    const nick = firstString(object, ['nick', 'nickName', 'nickname', 'flowerName']);
    const openId = firstString(object, ['openDingTalkId', 'open_dingtalk_id', 'openId']);
    const entry = { userId, name, dept, nick: nick && nick !== name ? nick : '', openId };
    const existing = byId.get(userId);
    if (!existing) byId.set(userId, entry);
    else if (!existing.dept && dept) byId.set(userId, { ...existing, dept });
  }
  return [...byId.values()];
}

/** 文档结果 → { title, url }（去重）。 */
function normalizeDocuments(payload) {
  const objects = collectObjects(payload, (o) => {
    const url = firstString(o, DOC_URL_FIELDS);
    return Boolean(url && /^https?:\/\//i.test(url) && firstString(o, DOC_TITLE_FIELDS));
  });
  const byUrl = new Map();
  for (const object of objects) {
    const url = firstString(object, DOC_URL_FIELDS);
    const title = firstString(object, DOC_TITLE_FIELDS);
    if (!url || !title) continue;
    if (!byUrl.has(url)) byUrl.set(url, { title, url });
  }
  if (byUrl.size > 0) return [...byUrl.values()];

  // 结构完全认不出来时，退化成"从文本里捞 alidocs 链接"。
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  const found = text.match(/https?:\/\/alidocs\.dingtalk\.com\/[^\s"'<>\\]+/g) ?? [];
  return [...new Set(found)].map((url) => ({ title: decodeURIComponent(url.split('/').pop() || url), url }));
}

/**
 * 头像占位用的首字，规则跟钉钉客户端一致：中文名取后两字（张三丰 → 三丰），
 * 西文名取前两个单词的首字母（Alice Brown → AB）。已授权接口拿不到真人头像 URL
 * （只有好友列表有 picUrl 字段，实测还是 null），所以统一用色块。
 */
function initialsOf(name) {
  const text = String(name ?? '').trim();
  if (!text) return '';
  if (/[\u4e00-\u9fff]/.test(text)) return [...text].slice(-2).join('');
  const words = text.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return text.slice(0, 2);
}

function contactToCandidate(contact, options = {}) {
  const subtitleParts = [contact.dept, contact.nick].filter(Boolean);
  const subtitle = subtitleParts.length > 0 ? `${subtitleParts.join('  ·  ')}  ·  钉钉联系人` : '钉钉联系人';
  // 拼音首字母放进 altTitles：本地按 hp 命中庄浩鹏后，排序层的模糊匹配
  // （只认姓名文本）会把它当不匹配丢掉，靠 altTitles 才能保住这条。
  const pinyin = contact.pinyin ?? pinyinInitials(contact.name);
  return {
    // 同名同事（重名）靠数字 uid 区分，id 必须带上它，否则 lastResults 会互相覆盖
    id: `dingtalk:user:${contact.uid ?? contact.userId}`,
    kind: 'contact',
    provider: 'dingtalk',
    title: contact.name,
    subtitle,
    initials: initialsOf(contact.name),
    altTitles: pinyin ? [pinyin] : undefined,
    tags: [contact.dept, contact.userId, contact.uid].filter(Boolean),
    userId: contact.userId,
    uid: contact.uid || undefined,
    avatarId: contact.avatarId || undefined,
    openId: contact.openId || undefined,
    serverMatched: options.serverMatched || undefined,
  };
}

function docToCandidate(doc, options = {}) {
  let host = '钉钉文档';
  try {
    host = new URL(doc.url).hostname;
  } catch {
    /* 保持默认 */
  }
  return {
    id: `dingtalk:doc:${doc.url}`,
    kind: 'doc',
    provider: 'dingdoc',
    title: doc.title,
    subtitle: `${host}  ·  钉钉文档`,
    tags: [host],
    altTitles: [doc.url],
    url: doc.url,
    serverMatched: options.serverMatched || undefined,
  };
}

/** 把 OAuth 管理器变成 MCP 客户端的取 token / 401 重试钩子。 */
function oauthHooks(oauth) {
  if (!oauth) return {};
  return { getToken: () => oauth.currentToken(), onUnauthorized: () => oauth.login() };
}

/** 大小写不敏感的宽松匹配，供本地缓存过滤。 */
function matchesTerms(terms, ...values) {
  if (!Array.isArray(terms) || terms.length === 0) return false;
  const haystack = values.filter(Boolean).join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(String(term).toLowerCase()));
}

/** 纯西文（字母）词元才走拼音首字母：中文词元直接按姓名匹配。 */
const ASCII_WORD = /^[a-z]+$/i;

/**
 * 拼音首字母是否为词元的有序子序列。
 * 服务端把 "hp" 认作庄浩鹏（zhp），本地用同一口径，避免同一个词本地查不到、
 * 走网络才出结果。子序列而不是前缀：允许跳字（zhp 命中 hp、zsf 命中 zf）。
 */
function initialsMatch(term, initials) {
  if (!ASCII_WORD.test(term) || !initials) return false;
  const needle = term.toLowerCase();
  const haystack = initials.toLowerCase();
  let hi = 0;
  for (let ni = 0; ni < needle.length; ni += 1) {
    hi = haystack.indexOf(needle[ni], hi);
    if (hi === -1) return false;
    hi += 1;
  }
  return true;
}

/**
 * 本地联系人匹配：姓名/别名/工号/部门任一命中，或者输入的拉丁字母是
 * 姓名拼音首字母的有序子序列（hp → 庄浩鹏）。
 */
function contactMatches(terms, entry) {
  if (!Array.isArray(terms) || terms.length === 0) return false;
  const initials = entry.pinyin ?? pinyinInitials(entry.name);
  return terms.every(
    (term) =>
      matchesTerms([term], entry.name, entry.nick, entry.alias, entry.userId, entry.uid, entry.dept) ||
      initialsMatch(String(term), initials),
  );
}

/**
 * 单字中文也值得查一次（“张”“王”都是常见问法）；纯西文单字符太宽泛，
 * 等用户再打一个字符。
 */
function worthRemoteQuery(keyword) {
  const text = String(keyword ?? '').trim();
  if (!text) return false;
  if (/[\u4e00-\u9fff]/.test(text)) return true;
  return text.length >= 2;
}

/**
 * 联系人 provider。
 * @param {object} options
 * @param {string} [options.mcpUrl] 通讯录 MCP 的 StreamableHttp URL
 * @param {{load:()=>Promise<object|null>, save:(d:object)=>Promise<boolean>}} [options.cache]
 * @param {()=>({selfUid:string, people:Array})|null} [options.loadLocal] 读本地库，返回 null 表示不可用
 * @param {(uid:string)=>Promise<{ok:boolean,message?:string}>} [options.openByUid] 用 cid 直接跳会话
 * @param {(name:string)=>Promise<{ok:boolean,message?:string}>} [options.openChat] 兜底：驱动搜索面板
 * @param {boolean} [options.allowRemote=true] false 时只查本地（冒烟测试用，避免弹 OAuth）
 * @param {Function} [options.fetch] 测试注入
 * @param {()=>number} [options.now]
 */
function createContactProvider(options = {}) {
  const now = options.now ?? (() => Date.now());
  const mcpUrl = options.mcpUrl;
  const allowRemote = options.allowRemote !== false;
  const openChat = options.openChat;
  const openByUid = options.openByUid;
  let client = null;
  let contacts = [];
  let localPeople = [];
  const queryCache = new Map();

  if (mcpUrl) {
    client = createMcpClient({
      url: mcpUrl,
      fetch: options.fetch,
      timeout: REMOTE_TIMEOUT,
      ...oauthHooks(options.oauth),
    });
  }

  function remember(list) {
    const byId = new Map(contacts.map((c) => [c.userId, c]));
    for (const contact of list) byId.set(contact.userId, { ...byId.get(contact.userId), ...contact });
    contacts = [...byId.values()].slice(-MAX_CACHED_CONTACTS);
  }

  async function remoteSearch(keyword) {
    const cached = queryCache.get(keyword);
    if (cached && now() - cached.at < QUERY_CACHE_TTL) return cached.list;

    const result = await client.callTool(CONTACT_TOOL, { [CONTACT_TOOL_PARAM]: keyword });
    const list = normalizeContacts(unwrapToolResult(result));
    queryCache.set(keyword, { at: now(), list });
    remember(list);
    return list;
  }

  return {
    id: 'dingtalk',
    aliases: options.aliases ?? ['钉钉', '联系人', '通讯录', 'dingtalk', 'contact', 'contacts', 'c', 'dc'],
    label: '联系人',
    timeout: REMOTE_TIMEOUT,

    async init() {
      const saved = await options.cache?.load?.();
      if (Array.isArray(saved?.contacts)) contacts = saved.contacts;
      // 本地库要解密几十兆，别让启动等它：先亮窗口，读完了再补进搜索池。
      if (typeof options.loadLocal === 'function') {
        const apply = (local) => {
          if (Array.isArray(local?.people)) localPeople = local.people;
        };
        try {
          const result = options.loadLocal();
          if (result && typeof result.then === 'function') result.then(apply).catch(() => {});
          else apply(result);
        } catch {
          /* 本地库读不出来就只靠 MCP，不给启动添乱 */
        }
      }
    },

    async search(terms, context = {}) {
      const keyword = (context.query?.keyword ?? terms.join(' ')).trim();
      const scoped = context.query?.providerHint === 'dingtalk';

      // 本地命中优先：500 多人的库里模糊匹配是内存操作，比网络快两个数量级，
      // 而且不需要 OAuth。只有本地查不到时才去问服务端。
      const local = localMatches(localPeople, terms);
      if (local.length > 0) return local;

      // 只有锁定搜索才走网络；普通搜索只用缓存，保证按键零延迟。
      if (scoped && allowRemote && client && worthRemoteQuery(keyword)) {
        try {
          const remote = await remoteSearch(keyword);
          // 服务端已经按关键词（含拼音）筛过，不再用本地模糊匹配二次过滤，
          // 否则 hp → 庄浩鹏 这类结果会被误杀。
          return remote.map((contact) => contactToCandidate(contact, { serverMatched: true }));
        } catch (error) {
          // 抛出去让引擎记进 errors，状态栏会显示原因；别静默返回空结果。
          throw new Error(`钉钉查询失败：${error?.message ?? error}`);
        }
      }

      // 本地没命中时，退回之前经 MCP 搜到过的缓存（含拼音首字母等本地匹配不出的结果）。
      return localMatches(contacts, terms);
    },

    async activate(item) {
      // 本地索引过来的条目带数字 uid，能拼出 cid 一步跳转
      const uid = String(item?.uid ?? '').trim();
      if (uid && openByUid) return openByUid(uid);
      const name = String(item?.title ?? item?.name ?? '').trim();
      if (!name) return { ok: false, message: '缺少姓名，无法打开聊天' };
      if (!openChat) return { ok: false, message: '未配置钉钉会话通道' };
      return openChat(name);
    },

    stats() {
      return { contacts: localPeople.length || contacts.length, local: localPeople.length, configured: Boolean(client) };
    },

    async dispose() {
      if (contacts.length > 0) await options.cache?.save?.({ contacts });
    },
  };
}

function localMatches(pool, terms) {
  return pool
    .filter((entry) => contactMatches(terms, entry))
    .map((contact) => contactToCandidate(contact));
}

/**
 * 文档 provider。
 * @param {object} options 同联系人，另加 openUrl(url) 打开网页兜底
 */
function createDocumentProvider(options = {}) {
  const now = options.now ?? (() => Date.now());
  const mcpUrl = options.mcpUrl;
  const allowRemote = options.allowRemote !== false;
  let client = null;
  let documents = [];
  const queryCache = new Map();

  if (mcpUrl) {
    client = createMcpClient({
      url: mcpUrl,
      fetch: options.fetch,
      timeout: REMOTE_TIMEOUT,
      ...oauthHooks(options.oauth),
    });
  }

  function remember(list, keyword) {
    const byUrl = new Map(documents.map((d) => [d.url, d]));
    for (const doc of list) {
      const existing = byUrl.get(doc.url);
      // 服务端按正文匹配，命中的文档标题里往往没有关键词。把"搜到它的关键词"
      // 记下来，不锁定的普通搜索才能从缓存里把它捞回来。
      const keys = new Set(existing?.searchKeys ?? []);
      if (keyword) keys.add(keyword);
      byUrl.set(doc.url, { ...existing, ...doc, searchKeys: [...keys] });
    }
    documents = [...byUrl.values()].slice(-MAX_CACHED_DOCS);
  }

  async function remoteSearch(keyword) {
    const cached = queryCache.get(keyword);
    if (cached && now() - cached.at < QUERY_CACHE_TTL) return cached.list;
    const result = await client.callTool(DOC_TOOL, { keyword });
    const list = normalizeDocuments(unwrapToolResult(result));
    queryCache.set(keyword, { at: now(), list });
    remember(list, keyword);
    return list;
  }

  return {
    id: 'dingdoc',
    aliases: options.aliases ?? ['文档', '钉钉文档', 'dingdoc', 'doc', 'docs', 'dd'],
    label: '文档',
    timeout: REMOTE_TIMEOUT,

    async init() {
      const saved = await options.cache?.load?.();
      if (Array.isArray(saved?.documents)) documents = saved.documents;
    },

    async search(terms, context = {}) {
      const keyword = (context.query?.keyword ?? terms.join(' ')).trim();
      const scoped = context.query?.providerHint === 'dingdoc';

      if (scoped && allowRemote && client && worthRemoteQuery(keyword)) {
        try {
          const remote = await remoteSearch(keyword);
          // 文档是正文检索：标题里常常没有关键词，本地匹配不上也要展示。
          return remote.map((doc) => docToCandidate(doc, { serverMatched: true }));
        } catch (error) {
          throw new Error(`钉钉文档查询失败：${error?.message ?? error}`);
        }
      }

      return docLocalMatches(documents, terms);
    },

    async activate(item) {
      const url = item?.url;
      if (!url) return { ok: false, message: '该文档缺少链接' };
      // 优先用钉钉内置浏览器打开，复用客户端登录态；失败再退系统浏览器。
      try {
        await options.openExternal(`dingtalk://dingtalkclient/page/link?url=${encodeURIComponent(url)}`);
        return { ok: true };
      } catch {
        try {
          await options.openExternal(url);
          return { ok: true };
        } catch (error) {
          return { ok: false, message: `打开文档失败，可能没有访问权限：${error?.message ?? error}` };
        }
      }
    },

    stats() {
      return { documents: documents.length, configured: Boolean(client) };
    },

    async dispose() {
      if (documents.length > 0) await options.cache?.save?.({ documents });
    },
  };
}

function docLocalMatches(pool, terms) {
  const out = [];
  for (const entry of pool) {
    if (matchesTerms(terms, entry.title, entry.url)) {
      out.push(docToCandidate(entry));
    } else if (matchesTerms(terms, ...(entry.searchKeys ?? []))) {
      // 服务端按正文命中过、标题里却没有关键词：本地模糊匹配会把它判为不匹配，
      // 必须带 serverMatched 才能拿到排序层的保底分。
      out.push(docToCandidate(entry, { serverMatched: true }));
    }
  }
  return out;
}

module.exports = {
  createContactProvider,
  createDocumentProvider,
  normalizeContacts,
  normalizeDocuments,
  contactToCandidate,
  initialsOf,
  docToCandidate,
  worthRemoteQuery,
  CONTACT_TOOL,
  CONTACT_TOOL_PARAM,
  DOC_TOOL,
  REMOTE_TIMEOUT,
  QUERY_CACHE_TTL,
};
