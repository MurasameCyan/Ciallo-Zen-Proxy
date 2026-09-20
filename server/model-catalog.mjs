/**
 * model-catalog.mjs —— opencode 官方能力目录(models.opencode.ai/api.json)。
 *
 * 这是上游自己维护的机器可读清单,给每个模型标了两件我们一直缺的元数据:
 *
 *   1. 原生协议。目录不写 `protocol` 字段,但 provider 的 `npm` 唯一决定它:
 *        @ai-sdk/openai              → responses(muse-spark 1.2/1.3 就是这种,
 *                                       打 /chat/completions 一律 500,只有
 *                                       /zen/v1/responses 才 200 —— 实测见对照)
 *        @ai-sdk/openai-compatible   → chat(big-pickle / nemotron / deepseek 等)
 *        @ai-sdk/anthropic           → messages(付费的 claude 系,免费清单里没有)
 *      模型条目自己也可能带 provider.npm 覆盖 provider 默认值,取值时先看模型级。
 *
 *   2. 上下文/输出上限。`limit.context` / `limit.output`。**只用于展示兜底** ——
 *      我们盘上那份是发真实请求实测出来的,和目录不一致时信实测(见 Capabilities
 *      的 ctxMap 合并顺序)。目录填的是我们**还没探到**的模型(比如刚上线的),
 *      免得面板缺个 [1M] 后缀。
 *
 * 缓存/TTL/原子写和 ModelMetadataStore 同构,但刻意不共用一个类:那个是
 * models.dev(拿 pricing/modalities),这个是 opencode(拿 protocol),两个源
 * 的 schema 和刷新节奏各管各的,揉在一起只会让「protocol 到底信谁」变糊。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

export const CATALOG_URL = 'https://models.opencode.ai/api.json';
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_TIMEOUT_MS = 30_000;
export const DEFAULT_CATALOG_FILE = path.join(DATA_DIR, 'opencode-catalog.json');

// 免费清单只可能出现在这两个 provider 下。其它 200 多个 provider(anthropic /
// openai / google ...)是 models.dev 那套聚合源,不是 opencode 自己的端点,
// 拉进来只会让 id 撞车,所以按 provider id 白名单收窄。
const OPENCODE_PROVIDERS = ['opencode', 'opencode-go'];

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/** provider 的 npm 包名 → 原生协议。见文件头的对照表 */
export function protocolFromNpm(npm) {
  const n = String(npm ?? '').trim().toLowerCase();
  if (!n) return '';
  if (n.includes('anthropic')) return 'anthropic';
  if (n === '@ai-sdk/openai') return 'responses';
  // openai-compatible 以及其它 openai 变体都是 chat 端点
  if (n.includes('openai')) return 'chat';
  return '';
}

/**
 * 把 api.json 收敛成 `id → {protocol, context, maxOutput}` 一张扁表。
 *
 * 只认白名单里的两个 provider。同一个 id 在 zen 和 go 都出现时(上游偶有),
 * 先到先得按 OPENCODE_PROVIDERS 的顺序 —— zen 优先,那是免费清单的主入口。
 */
export function normalizeCatalog(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object') return out;
  for (const provider of OPENCODE_PROVIDERS) {
    const entry = raw[provider];
    const models = entry?.models;
    if (!models || typeof models !== 'object') continue;
    const providerNpm = entry.npm;
    for (const [key, model] of Object.entries(models)) {
      if (!model || typeof model !== 'object') continue;
      const id = String(model.id || key || '').trim();
      if (!id || out.has(id)) continue;
      const limit = model.limit && typeof model.limit === 'object' ? model.limit : {};
      // 模型级 npm 覆盖 provider 默认(muse-spark 就是靠模型级 @ai-sdk/openai 才
      // 从 provider 默认的 openai-compatible 里被单拎成 responses 的)
      const npm = model.provider?.npm || model.npm || providerNpm;
      out.set(id, {
        id,
        provider,
        protocol: protocolFromNpm(npm),
        context: number(limit.context),
        maxOutput: number(limit.output),
      });
    }
  }
  return out;
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (e) {
    // Windows 不能用 rename 覆盖已存在的文件;和 model-metadata 那边同款兜底。
    const backup = `${file}.replace`;
    try {
      if (fs.existsSync(file)) fs.renameSync(file, backup);
      fs.renameSync(temp, file);
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
    } catch (inner) {
      try { if (!fs.existsSync(file) && fs.existsSync(backup)) fs.renameSync(backup, file); } catch {}
      throw inner;
    } finally {
      try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch {}
    }
  }
  try { fs.chmodSync(file, 0o600); } catch {}
}

export class OpencodeCatalog {
  constructor({
    file = DEFAULT_CATALOG_FILE,
    endpoint = CATALOG_URL,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    logger = () => {},
  } = {}) {
    this.file = file;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.models = new Map();
    this.updatedAt = 0;
    this.lastError = '';
    this.inflight = null;
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const records = saved?.models;
      if (!records || typeof records !== 'object') return;
      this.models = new Map(Object.entries(records));
      this.updatedAt = Number(saved.updatedAt) || 0;
    } catch {}
  }

  get(id) {
    const key = String(id ?? '').trim();
    if (!key) return null;
    return this.models.get(key) || null;
  }

  /** 原生协议;目录里没有或没解析出来时回 '',调用方按 chat 兜底 */
  protocol(id) {
    return this.get(id)?.protocol || '';
  }

  /** 上下文上限;仅当目录有值时返回正整数,否则 null */
  context(id) {
    const c = this.get(id)?.context;
    return Number.isInteger(c) && c > 0 ? c : null;
  }

  /** 面板/合并要的那张 `id → context` 扁表,只覆盖问到的 id */
  ctxMap(ids = null) {
    const out = {};
    const keys = ids || [...this.models.keys()];
    for (const id of keys) {
      const c = this.context(id);
      if (c != null) out[id] = c;
    }
    return out;
  }

  status() {
    const age = this.updatedAt ? Math.max(0, this.now() - this.updatedAt) : Infinity;
    return {
      ready: this.models.size > 0,
      models: this.models.size,
      updatedAt: this.updatedAt || null,
      stale: age > CATALOG_TTL_MS,
      nextRefresh: this.updatedAt ? this.updatedAt + CATALOG_TTL_MS : null,
      lastError: this.lastError || null,
    };
  }

  refresh({ force = false } = {}) {
    if (this.inflight) return this.inflight;
    if (!force && this.updatedAt && this.now() - this.updatedAt < CATALOG_TTL_MS) {
      return Promise.resolve({ updated: false, reason: 'fresh', models: this.models.size });
    }
    if (typeof this.fetchImpl !== 'function') return Promise.reject(new Error('fetch is unavailable'));
    this.inflight = this.#refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.endpoint, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response?.ok) throw new Error(`opencode catalog HTTP ${response?.status ?? 0}`);
      const normalized = normalizeCatalog(await response.json());
      if (!normalized.size) throw new Error('opencode catalog returned no models');
      const updatedAt = this.now();
      writeAtomic(this.file, { version: 1, updatedAt, models: Object.fromEntries(normalized) });
      this.models = normalized;
      this.updatedAt = updatedAt;
      this.lastError = '';
      return { updated: true, models: normalized.size, updatedAt };
    } catch (e) {
      this.lastError = e?.name === 'AbortError' ? 'opencode catalog timeout' : String(e?.message || e);
      this.logger('warn', `[catalog] ${this.lastError}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
