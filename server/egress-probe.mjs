/** Independent, bounded reachability/IP facts; never touches an inference selector. */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import net, { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR, PROVIDER_FILE, parseProviderEgress } from './config.mjs';
import { MihomoInstance } from './mihomo.mjs';
import { MihomoAgent } from './proxy.mjs';

const TTL_MS = 10 * 60 * 1000;
const ZEN_URL = 'https://opencode.ai/';
const NEUTRAL_URL = 'https://api.country.is/';
const quiet = () => {};
const copy = (record) => ({ ...record, zen: { ...record.zen }, neutral: { ...record.neutral } });
const failed = (error) => ({ ok: false, status: null, ms: 0, error });
const exactName = (name) => `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}
const releasePort = (server) => new Promise((resolve) => server.close(resolve));

// A wall-clock timer covers CONNECT, TLS, headers and the entire bounded body.
// Error values are fixed categories: upstream/provider credentials never escape.
function requestBody(request, url, options, timeoutMs, maxBytes) {
  return new Promise((resolve) => {
    const start = Date.now();
    let req, response, done = false, status = null;
    const finish = (error = null, body = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { response?.destroy(); req?.destroy(); }
      resolve({ ok: !error, status, ms: Math.max(0, Date.now() - start), error, body });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      req = request(url, { ...options, headers: { accept: 'application/json', connection: 'close' } }, (res) => {
        response = res;
        if (done) { res.destroy(); return; }
        status = res.statusCode || null;
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          if (done) return;
          size += chunk.length;
          if (size > maxBytes) { finish('response_too_large'); return; }
          chunks.push(chunk);
        });
        res.once('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
        res.once('error', () => finish('response_failed'));
        res.once('aborted', () => finish('response_aborted'));
      });
      req.once('error', () => finish('request_failed'));
      req.end();
    } catch {
      finish('request_failed');
    }
  });
}

export class EgressProbe {
  constructor({ providerFile = PROVIDER_FILE, dataDir = DATA_DIR, logger = quiet, timeoutMs = 6000,
    processFactory = (options) => new MihomoInstance(options), requestImpl = https.request } = {}) {
    this.providerFile = providerFile;
    this.dataDir = dataDir;
    this.logger = logger;
    this.timeoutMs = Math.min(30_000, Math.max(1, Number(timeoutMs) || 6000));
    this.processFactory = processFactory;
    this.requestImpl = requestImpl;
    this.records = new Map();
    this.pending = Promise.resolve();
    this.stopped = false;
    this.controller = null;
    this.providerSnapshot = null;
  }

  #providerSnapshot() {
    try {
      // Equal-size writes may retain every stat timestamp on coarse filesystems.
      // Validate exact bytes before publishing facts; unchanged text reuses the
      // parsed inventory and fingerprint without another hash.
      const text = readFileSync(this.providerFile, 'utf8');
      if (this.providerSnapshot?.text !== text) {
        this.providerSnapshot = { text, providers: parseProviderEgress(text),
          fingerprint: createHash('sha256').update(text).digest('hex') };
      }
      return this.providerSnapshot;
    } catch {
      this.providerSnapshot = null;
      return null;
    }
  }

  #prune(snapshot = this.#providerSnapshot()) {
    const now = Date.now();
    for (const [node, record] of this.records) {
      if (now - record.at >= TTL_MS || record.providerRevision !== snapshot?.fingerprint) this.records.delete(node);
    }
  }

  get(node) {
    this.#prune();
    const record = this.records.get(node);
    return record ? copy(record) : null;
  }

  snapshot() {
    this.#prune();
    return [...this.records.values()].map(copy);
  }

  #sameProvider(snapshot) {
    return this.#providerSnapshot()?.fingerprint === snapshot?.fingerprint;
  }

  #publish(record) {
    record.at = Date.now();
    this.records.delete(record.node);
    this.records.set(record.node, record);
    return copy(record);
  }

  measure(nodes, { force = false, onResult } = {}) {
    const candidates = [...new Set(nodes.filter((node) => typeof node === 'string' && node.length))];
    const result = this.pending.then(() => this.#measure(candidates, force, onResult));
    this.pending = result.catch(quiet);
    return result;
  }

  async stop() {
    this.stopped = true;
    this.controller?.abort();
    await this.pending;
  }

  async #target(port, neutral) {
    const agent = new MihomoAgent(port);
    // The base agent establishes CONNECT asynchronously. A socket delivered after
    // the total deadline must be destroyed rather than attached to a dead request.
    let finished = false;
    const connect = agent.createConnection.bind(agent);
    agent.createConnection = (options, callback) => connect(options, (error, socket) => {
      if (finished) { socket?.destroy(); callback(error || new Error('probe_finished')); return; }
      callback(error, socket);
    });
    try {
      const { body, ...fact } = await requestBody(this.requestImpl, neutral ? NEUTRAL_URL : ZEN_URL,
        { agent, method: neutral ? 'GET' : 'HEAD', signal: this.controller?.signal }, this.timeoutMs, 64 * 1024);
      let exitIp = null;
      let exitCountry = null;
      if (neutral && fact.ok) {
        if (fact.status < 200 || fact.status >= 300) {
          fact.ok = false;
          fact.error = 'http_status';
        } else {
          try {
            const { ip, country } = JSON.parse(body);
            if (typeof ip === 'string' && isIP(ip)) {
              exitIp = ip;
              if (typeof country === 'string' && /^[A-Z]{2}$/.test(country)) exitCountry = country;
            }
          } catch { /* Invalid bodies are unknown, never a provider-server fallback. */ }
          if (!exitIp) { fact.ok = false; fact.error = 'invalid_exit_ip'; }
        }
      }
      return { fact, exitIp, exitCountry };
    } finally {
      finished = true;
      agent.destroy();
    }
  }

  async #measure(nodes, force, onResult) {
    if (this.stopped) return [];
    const snapshot = this.#providerSnapshot();
    this.#prune(snapshot);
    if (!snapshot) return [];

    // Keep cache hits in the returned run even if a long scan later expires them.
    const run = new Map();
    const stale = [];
    for (const node of nodes) {
      if (force || !this.records.has(node)) {
        stale.push(node);
        continue;
      }
      const fact = copy(this.records.get(node));
      run.set(node, fact);
      onResult?.(fact);
    }

    // A single owned process is used for each bounded group. This avoids creating
    // hundreds of listeners/ports while still covering every candidate.
    for (let offset = 0; offset < stale.length; offset += 3) {
      if (this.stopped || !this.#sameProvider(snapshot)) {
        this.#prune(this.#providerSnapshot());
        return [];
      }
      const batch = stale.slice(offset, offset + 3);
      const measured = await this.#measureBatch(batch, snapshot, onResult);
      if (measured.obsolete || this.stopped) return [];
      for (const fact of measured.facts) run.set(fact.node, fact);
    }
    if (this.stopped || !this.#sameProvider(snapshot)) {
      this.#prune(this.#providerSnapshot());
      return [];
    }
    return nodes.map((node) => run.get(node)).filter(Boolean);
  }

  async #measureBatch(nodes, snapshot, onResult) {
    const results = nodes.map((node) => ({ node, provider: snapshot.providers.get(node) || null,
      providerRevision: snapshot.fingerprint, at: 0, exitIp: null, exitCountry: null,
      zen: failed('probe_failed'), neutral: failed('probe_failed') }));
    const published = new Set();
    let obsolete = false;
    let callbackError = null;
    const publish = (index) => {
      const fact = this.#publish(results[index]);
      published.add(index);
      try { onResult?.(fact); }
      catch (error) { callbackError = error; throw error; }
    };
    const reservations = [];
    let workspace, instance, startupTimer, abortStartup;
    const controller = this.controller = new AbortController();
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      workspace = await fs.mkdtemp(path.join(this.dataDir, 'egress-probe-'));
      // Mihomo restricts provider paths to HomeDir. A local snapshot also keeps
      // one batch consistent if the main provider refreshes during measurement.
      await fs.writeFile(path.join(workspace, 'airport.yaml'), snapshot.text, { mode: 0o600 });
      for (let i = 0; i <= nodes.length; i++) reservations.push(await reservePort());
      const ports = reservations.map((server) => server.address().port);
      const ctrlPort = ports.pop();
      const tag = randomUUID();
      const groups = nodes.map((node, i) => ({ name: `egress-${tag}-${i}`, type: 'select', use: ['airport'], filter: exactName(node) }));
      const config = {
        'mixed-port': 0, port: 0, 'socks-port': 0,
        'allow-lan': false, 'bind-address': '127.0.0.1', mode: 'rule', 'log-level': 'silent', ipv6: false,
        'external-controller': `127.0.0.1:${ctrlPort}`,
        profile: { 'store-selected': false, 'store-fake-ip': false },
        dns: { enable: true, ipv6: false, 'enhanced-mode': 'redir-host', nameserver: ['223.5.5.5', '119.29.29.29'] },
        'proxy-providers': { airport: { type: 'file', path: './airport.yaml', 'health-check': { enable: false } } },
        'proxy-groups': groups,
        listeners: groups.map((group, i) => ({ name: `probe-${i}`, type: 'http', listen: '127.0.0.1', port: ports[i], proxy: group.name, users: [] })),
        // Unsupported/misconfigured listener routing must reject, never go DIRECT.
        rules: ['MATCH,REJECT'],
      };
      const configFile = path.join(workspace, 'probe.json');
      await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
      instance = this.processFactory({ configFile, dataDir: workspace, ctrlPort, label: 'egress-probe' });
      await Promise.all(reservations.splice(0).map(releasePort));
      await Promise.race([
        instance.start(quiet, { signal: controller.signal }),
        new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('probe_start_timeout')), 30_000); }),
        new Promise((_, reject) => {
          abortStartup = () => reject(new Error('probe_stopped'));
          if (controller.signal.aborted) abortStartup();
          else controller.signal.addEventListener('abort', abortStartup, { once: true });
        }),
      ]);
      clearTimeout(startupTimer);
      if (!this.#sameProvider(snapshot)) obsolete = true;
      if (!obsolete && !this.stopped) {
        const control = async (route) => {
          const response = await requestBody(http.request, `http://127.0.0.1:${ctrlPort}${route}`, { agent: false, signal: controller.signal },
            Math.min(this.timeoutMs, 2000), 2 * 1024 * 1024);
          if (!response.ok || response.status !== 200) throw new Error('probe_control_failed');
          return JSON.parse(response.body);
        };
        const provider = await control('/providers/proxies/airport');
        const { proxies } = await control('/proxies');
        for (let i = 0; i < nodes.length; i++) {
          if (this.stopped) break;
          if (!this.#sameProvider(snapshot)) { obsolete = true; break; }
          const node = nodes[i];
          const group = proxies?.[groups[i].name];
          if (!provider.proxies?.some((proxy) => proxy.name === node) ||
              group?.all?.length !== 1 || group.all[0] !== node || group.now !== node) {
            results[i].zen = failed('node_not_selected');
            results[i].neutral = failed('node_not_selected');
            publish(i);
            continue;
          }
          results[i].zen = (await this.#target(ports[i], false)).fact;
          if (this.stopped) break;
          const neutral = await this.#target(ports[i], true);
          results[i].neutral = neutral.fact;
          results[i].exitIp = neutral.exitIp;
          results[i].exitCountry = neutral.exitCountry;
          if (!this.#sameProvider(snapshot)) { obsolete = true; break; }
          publish(i);
        }
      }
    } catch (error) {
      if (!callbackError && !this.stopped && !obsolete) this.logger('warn', '[egress-probe] Independent measurement unavailable');
      if (callbackError) throw error;
    } finally {
      clearTimeout(startupTimer);
      if (abortStartup) controller.signal.removeEventListener('abort', abortStartup);
      controller.abort();
      try { await instance?.stop(quiet); }
      catch { this.logger('warn', '[egress-probe] Independent process cleanup failed'); }
      await Promise.all(reservations.map(releasePort));
      if (workspace) {
        try { await fs.rm(workspace, { recursive: true, force: true }); }
        catch { this.logger('warn', '[egress-probe] Temporary workspace cleanup failed'); }
      }
      if (this.controller === controller) this.controller = null;
    }
    if (callbackError) throw callbackError;
    if (!obsolete && !this.stopped && !this.#sameProvider(snapshot)) obsolete = true;
    if (!obsolete && !this.stopped) {
      // Startup/control failures still become complete, sanitized facts.
      for (let i = 0; i < results.length; i++) if (!published.has(i)) publish(i);
    }
    if (obsolete) {
      this.#prune(this.#providerSnapshot());
      return { facts: [], obsolete: true };
    }
    return { facts: [...published].sort((a, b) => a - b).map((index) => copy(results[index])), obsolete: false };
  }
}
