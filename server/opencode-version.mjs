import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

// Keep the verified wire format; GitHub release tags belong to the v1 client.
export const CLIENT_VERSION_URL = 'https://opencode.ai/update/api/latest/cli/npm';
export const CLIENT_VERSION_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CLIENT_VERSION = '2.0.29';
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validClientVersion(value) {
  if (typeof value !== 'string' || !VERSION_RE.test(value)) return false;
  const parts = value.split('.').map(Number);
  return parts[0] >= 2 && parts.every(Number.isSafeInteger);
}

/** Both arguments have already passed validClientVersion. */
export function compareClientVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (e) {
    // Windows cannot replace an existing file with rename; keep the replacement
    // recoverable and restore the old cache if the second rename fails.
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
}

export class OpencodeVersionStore {
  constructor({
    file = path.join(DATA_DIR, 'opencode-version.json'),
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    logger = () => {},
  } = {}) {
    this.file = file;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.version = DEFAULT_CLIENT_VERSION;
    this.updatedAt = 0;
    this.lastError = '';
    this.inflight = null;
    this.scheduler = null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (validClientVersion(saved?.version) && compareClientVersions(saved.version, this.version) >= 0) {
        this.version = saved.version;
        // A future/broken clock must not suppress refresh indefinitely.
        if (Number.isFinite(saved.updatedAt) && saved.updatedAt > 0 && saved.updatedAt <= this.now()) {
          this.updatedAt = saved.updatedAt;
        }
      }
    } catch {}
  }

  status() {
    return {
      version: this.version,
      userAgent: `opencode/latest/${this.version}/cli`,
      updatedAt: this.updatedAt || null,
      stale: !this.updatedAt || this.now() - this.updatedAt >= CLIENT_VERSION_TTL_MS,
      nextRefresh: this.updatedAt ? this.updatedAt + CLIENT_VERSION_TTL_MS : null,
      lastError: this.lastError || null,
    };
  }

  refresh({ force = false } = {}) {
    if (this.inflight) return this.inflight;
    if (!force && this.updatedAt && this.now() - this.updatedAt < CLIENT_VERSION_TTL_MS) {
      return Promise.resolve(this.status());
    }
    this.inflight = this.#refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(CLIENT_VERSION_URL, {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (!response?.ok) throw new Error(`OpenCode version HTTP ${response?.status ?? 0}`);
      const release = await response.json();
      if (release?.channel !== 'latest' || release.name !== 'cli' || release.distribution !== 'npm'
          || release.active !== true || release.metadata?.package !== '@opencode/cli'
          || !validClientVersion(release.version)) {
        throw new Error('invalid official OpenCode CLI release metadata');
      }
      if (compareClientVersions(release.version, this.version) < 0) {
        throw new Error(`OpenCode release ${release.version} is older than cached ${this.version}`);
      }
      const updatedAt = this.now();
      writeAtomic(this.file, { version: release.version, updatedAt });
      this.version = release.version;
      this.updatedAt = updatedAt;
      this.lastError = '';
      this.logger('info', `[opencode-version] 已同步 ${this.version},每 24 小时检查官方发行版`);
      return this.status();
    } catch (error) {
      this.lastError = error?.name === 'AbortError' ? 'OpenCode version timeout' : String(error?.message || error);
      this.logger('warn', `[opencode-version] ${this.lastError};继续使用 ${this.version}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs independently of requests or dashboard polling; never blocks inference. */
  start({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.stop();
    const state = { timer: null, stopped: false, clearTimer };
    this.scheduler = state;
    const arm = (delay) => {
      state.timer = setTimer(tick, delay);
      state.timer?.unref?.();
    };
    const tick = async () => {
      if (state.stopped) return;
      let delay = CLIENT_VERSION_TTL_MS;
      try {
        await this.refresh();
        delay = Math.max(1, this.updatedAt + CLIENT_VERSION_TTL_MS - this.now());
      } catch { /* The store logs the failure and keeps the last good version. */ }
      if (!state.stopped) arm(delay);
    };
    const left = this.updatedAt + CLIENT_VERSION_TTL_MS - this.now();
    if (!this.updatedAt || left <= 0) void tick();
    else arm(left);
  }

  stop() {
    const state = this.scheduler;
    if (!state) return;
    state.stopped = true;
    if (state.timer !== null) state.clearTimer(state.timer);
    this.scheduler = null;
  }
}
