'use strict';

/**
 * 查询引擎。
 *
 * 串起：解析输入 → 分发到 provider → 汇总候选 → 排序 → 截断。
 *
 * 设计要点：
 * - provider 是"有 search(terms, context) 和可选 activate(item)"的普通对象，
 *   不依赖 Electron，所以可以用假 provider 完整单测引擎行为。
 * - 慢 provider（文件索引）可以被跳过或降级，不能拖住其它 provider：
 *   引擎对每个 provider 做独立超时，超时就丢弃它这一轮的结果。
 * - 查询串行化：后发起的查询让前一轮的结果作废（stale token），
 *   避免慢查询覆盖快查询的 UI。
 */

const { parseQuery } = require('./query');
const { rankCandidates, DEFAULT_LIMIT } = require('./rank');

/** 单个 provider 的默认超时。 */
const DEFAULT_PROVIDER_TIMEOUT = 120;

/** 超时专用错误，让调用方能区分"太慢"和"出错"——两者的处理策略不同。 */
class TimeoutError extends Error {
  constructor(ms) {
    super(`timeout after ${ms}ms`);
    this.name = 'TimeoutError';
    this.code = 'timeout';
  }
}

/**
 * 给 promise 套一个超时。
 * 超时抛 TimeoutError；promise 自身的错误原样抛出——绝不把真实错误
 * 伪装成超时，否则日志里永远看不到"索引坏了"这种关键信息。
 */
function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError(ms));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * @param {object} options
 * @param {Array<object>} options.providers 已注册的 provider
 * @param {object} [options.usageStore]
 * @param {object} [options.providerWeights]
 * @param {number} [options.limit]
 * @param {number} [options.providerTimeout]
 * @param {{now:()=>number}} [options.clock]
 */
function createEngine(options = {}) {
  const providers = [];
  const limit = Number.isInteger(options.limit) ? options.limit : DEFAULT_LIMIT;
  const providerTimeout = Number.isFinite(options.providerTimeout)
    ? options.providerTimeout
    : DEFAULT_PROVIDER_TIMEOUT;
  const now = typeof options.clock?.now === 'function' ? options.clock.now : () => Date.now();

  /** 每轮查询自增；返回时若已不是最新的，就丢弃结果。 */
  let generation = 0;

  /**
   * 注册 provider。
   * @param {object} provider { id, aliases?, weight?, search, activate?, init?, dispose? }
   */
  function register(provider) {
    if (!provider || typeof provider.id !== 'string' || !provider.id) {
      throw new TypeError('provider 必须有非空 id');
    }
    if (typeof provider.search !== 'function') {
      throw new TypeError(`provider ${provider.id} 必须有 search 方法`);
    }
    if (providers.some((p) => p.id === provider.id)) {
      throw new Error(`provider ${provider.id} 重复注册`);
    }
    providers.push(provider);
    return provider;
  }

  function list() {
    return providers.slice();
  }

  function get(id) {
    return providers.find((p) => p.id === id) ?? null;
  }

  /** 解析输入，不执行查询。UI 需要提前知道"这是不是锁定到了某个 provider"。 */
  function parse(input) {
    return parseQuery(input, providers);
  }

  /**
   * 执行查询。
   * @param {string} input 原始输入
   * @param {object} [context] 传给 provider 的额外上下文
   * @returns {Promise<{query:object, items:object[], errors:Array<{provider:string,message:string}>}>}
   */
  async function search(input, context = {}) {
    const query = parse(input);
    const myGeneration = (generation += 1);

    // 空查询：不做全文检索，让 provider 自行返回"常用/最近"。
    const targets = query.providerHint
      ? providers.filter((p) => p.id === query.providerHint)
      : providers;

    const settled = await Promise.all(
      targets.map(async (provider) => {
        const startedAt = now();
        // 远程 provider（如钉钉 MCP）自己做超时与降级，允许用 provider.timeout 覆盖。
        const budget = Number.isFinite(provider.timeout) ? provider.timeout : providerTimeout;
        try {
          const raw = await withTimeout(
            Promise.resolve(
              provider.search(query.terms, {
                ...context,
                query,
                empty: query.terms.length === 0,
                signal: context.signal,
              }),
            ),
            budget,
          );
          const items = normalizeItems(raw, provider.id);
          return {
            provider: provider.id,
            items,
            error: null,
            durationMs: now() - startedAt,
          };
        } catch (error) {
          const timedOut = error?.code === 'timeout';
          return {
            provider: provider.id,
            items: [],
            error: {
              code: timedOut ? 'timeout' : 'error',
              message: String(error?.message ?? error),
            },
          };
        }
      }),
    );

    // 有更新的查询开始了，这轮结果作废。
    if (myGeneration !== generation) {
      return { query, items: [], errors: [], stale: true };
    }

    const errors = [];
    const pool = [];
    for (const result of settled) {
      if (result.error) {
        errors.push({
          provider: result.provider,
          code: result.error.code,
          message: result.error.message ?? result.error.code,
        });
        continue;
      }
      pool.push(...result.items);
    }

    const items = rankCandidates(query.terms, pool, {
      usageStore: options.usageStore,
      providerWeights: options.providerWeights,
      now: now(),
      limit,
    });

    return { query, items, errors, stale: false };
  }

  /**
   * 执行选中项。
   * @param {object} item 排序后的候选
   * @param {object} [context]
   */
  async function activate(item, context = {}) {
    if (!item) return { ok: false, message: '没有可执行项' };
    const provider = get(item.provider);
    if (!provider) return { ok: false, message: `provider 不存在: ${item.provider}` };
    if (typeof provider.activate !== 'function') {
      return { ok: false, message: `provider ${item.provider} 不支持执行` };
    }
    try {
      const result = await provider.activate(item, context);
      const ok = result?.ok !== false;
      if (ok && options.usageStore) {
        options.usageStore.record(String(item.id ?? item.title ?? ''), now());
      }
      return ok ? { ok: true, ...(result ?? {}) } : { ok: false, ...(result ?? {}) };
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
  }

  /** 调用所有 provider 的 init（可选），失败不阻断启动。 */
  async function initAll(context = {}) {
    const results = await Promise.all(
      providers.map(async (provider) => {
        if (typeof provider.init !== 'function') return null;
        try {
          await provider.init(context);
          return null;
        } catch (error) {
          return { provider: provider.id, message: String(error?.message ?? error) };
        }
      }),
    );
    return results.filter(Boolean);
  }

  /** 调用所有 provider 的 dispose（可选）。 */
  async function disposeAll() {
    await Promise.all(
      providers.map(async (provider) => {
        if (typeof provider.dispose !== 'function') return;
        try {
          await provider.dispose();
        } catch {
          /* 退出路径，忽略 */
        }
      }),
    );
  }

  return { register, list, get, parse, search, activate, initAll, disposeAll };
}

/** provider 返回值容错：允许返回单条、数组、或 {items:[]}。 */
function normalizeItems(raw, providerId) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [raw];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const title = item.title ?? item.name;
    if (!title) continue;
    out.push({
      ...item,
      title: String(title),
      provider: item.provider ?? providerId,
      id: item.id ?? `${providerId}:${title}`,
    });
  }
  return out;
}

module.exports = {
  createEngine,
  normalizeItems,
  withTimeout,
  TimeoutError,
  DEFAULT_PROVIDER_TIMEOUT,
};
