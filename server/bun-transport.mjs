/**
 * bun-transport.mjs — sends upstream inference requests through the Bun sidecar.
 *
 * Why: the free tier rejects Node's TLS ClientHello with `429 FreeUsageLimitError`
 * and accepts Bun's (see bun-sidecar.js). That 429 looks like quota exhaustion,
 * so without this every node gets cooled down for hours while the official CLI
 * keeps working on the same exits.
 *
 * `upstreamRequest(opts, cb)` has the `https.request` shape the gateway already
 * uses. When the sidecar is running it rewrites the call into plain HTTP to
 * 127.0.0.1; otherwise it falls back to Node's https (old behavior, logged once).
 * A sidecar-side fetch failure becomes a request `error`, so the gateway still
 * classifies it as status 0 (transport) and switches nodes as before.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bun-sidecar.js');
const READY_TIMEOUT_MS = 15_000;
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000];

const state = {
  bin: '', script: SCRIPT, proc: null, port: 0, token: '', agent: null,
  stopping: false, restarts: 0, timer: null, logger: () => {}, warnedFallback: false,
};

export function bunTransportStatus() {
  return { ready: state.port > 0, port: state.port, bin: state.bin, restarts: state.restarts };
}

function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

function launch() {
  state.token = crypto.randomBytes(24).toString('hex');
  const proc = spawn(state.bin, [state.script], {
    env: { PATH: process.env.PATH || '', SIDECAR_TOKEN: state.token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.proc = proc;
  return new Promise((resolve) => {
    let buffered = '';
    const timer = setTimeout(() => { state.logger('error', '[bun] 代理进程启动超时'); proc.kill('SIGKILL'); resolve(false); }, READY_TIMEOUT_MS);
    proc.stdout.setEncoding('utf8').on('data', (chunk) => {
      buffered += chunk;
      const match = /SIDECAR_READY (\d+)/.exec(buffered);
      if (!match || state.port) return;
      clearTimeout(timer);
      state.port = Number(match[1]);
      state.agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
      state.logger('ok', `[bun] 上游 TLS 代理就绪 (127.0.0.1:${state.port})`);
      resolve(true);
    });
    proc.stderr.setEncoding('utf8').on('data', (chunk) => state.logger('warn', `[bun] ${String(chunk).trim().slice(0, 300)}`));
    proc.once('error', (error) => { clearTimeout(timer); state.logger('error', `[bun] 无法启动: ${error.message}`); resolve(false); });
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      const wasReady = state.port > 0;
      state.port = 0;
      state.proc = null;
      state.agent?.destroy();
      state.agent = null;
      if (state.stopping) return;
      state.logger('error', `[bun] 代理进程退出 (code=${code} signal=${signal}),上游请求暂时回退到 Node TLS`);
      if (!wasReady) resolve(false);
      const delay = RESTART_DELAYS_MS[Math.min(state.restarts, RESTART_DELAYS_MS.length - 1)];
      state.restarts++;
      state.timer = setTimeout(() => { state.timer = null; launch(); }, delay);
      state.timer.unref?.();
    });
  });
}

/** Start the sidecar. Missing Bun is not fatal: requests fall back to Node TLS. */
export async function startBunTransport({ bin = process.env.BUN_BIN || '/usr/local/bin/bun', script = SCRIPT, logger = () => {} } = {}) {
  state.logger = logger;
  state.stopping = false;
  if (state.proc) return state.port > 0;
  if (!executable(bin) || !fs.existsSync(script)) {
    logger('warn', `[bun] 找不到 Bun (${bin}),上游请求使用 Node TLS —— 免费层会把 Node 的握手判成 429`);
    return false;
  }
  state.bin = bin;
  state.script = script;
  return launch();
}

export async function stopBunTransport() {
  state.stopping = true;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  const proc = state.proc;
  if (!proc) return;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill('SIGTERM');
    setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3_000).unref?.();
  });
}

/** Drop-in for `https.request(opts, cb)` on upstream inference calls. */
export function upstreamRequest(opts, callback) {
  const proxyPort = Number(opts?.agent?.proxyPort);
  if (!state.port || !Number.isInteger(proxyPort) || proxyPort <= 0) {
    if (!state.warnedFallback && state.bin) {
      state.warnedFallback = true;
      state.logger('warn', '[bun] 代理不可用,本次上游请求回退到 Node TLS');
    }
    return https.request(opts, callback);
  }
  state.warnedFallback = false;
  const { agent, host, hostname, port, servername, ALPNProtocols, ...rest } = opts;
  let req;
  req = http.request({
    ...rest,
    host: '127.0.0.1',
    port: state.port,
    agent: state.agent,
    headers: { ...(opts.headers || {}), 'x-sidecar-token': state.token, 'x-sidecar-proxy': String(proxyPort) },
  }, (res) => {
    const failure = res.headers['x-sidecar-error'];
    if (res.statusCode === 502 && failure) {
      res.resume();
      req.destroy(new Error(`bun fetch: ${failure}`));
      return;
    }
    callback?.(res);
  });
  return req;
}
