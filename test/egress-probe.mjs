import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeCooldown } from '../server/rotation.mjs';

import { EgressProbe } from '../server/egress-probe.mjs';
import { MihomoInstance } from '../server/mihomo.mjs';

for (const [kind, mark] of [
  ['429', (c, n, g) => c.mark429(n, g, 3600)],
  ['blocked', (c, n, g) => c.markBlocked(n, g)],
  ['5xx', (c, n, g) => c.mark5xx(n, g)],
]) {
  test(`identity migration preserves ${kind} deadline and ranking history`, () => {
    let measured = false;
    const cooldown = new NodeCooldown({ egressOf: (node) => measured ? '203.0.113.10' : `provider:${node}` });
    mark(cooldown, 'A', 'default');
    const before = cooldown.get('A');
    const marked = cooldown.recentMark('A');
    cooldown.rekey('provider:A', '203.0.113.10');
    measured = true;
    assert.equal(cooldown.get('A').until, before.until);
    assert.equal(cooldown.get('A').retryAfter, before.retryAfter);
    assert.equal(cooldown.get('A').blocked, before.blocked);
    assert.equal(cooldown.get('A').reason, before.reason);
    assert.equal(cooldown.recentMark('A'), marked);
    assert.equal(cooldown.get('A', 'nemotron'), null);
  });
}

test('same-IP merge keeps strongest group policy while distinct exits stay separate', () => {
  const identities = new Map([['A', 'provider:A'], ['B', '203.0.113.10'], ['C', '203.0.113.11']]);
  const cooldown = new NodeCooldown({ egressOf: (node) => identities.get(node) });
  cooldown.mark429('B', 'default', 7200);
  cooldown.mark5xx('A', 'default');
  cooldown.markBlocked('A', 'nemotron');
  const deadline = cooldown.get('B').until;
  cooldown.rekey('provider:A', '203.0.113.10');
  identities.set('A', '203.0.113.10');
  assert.equal(cooldown.get('A').until, deadline);
  assert.equal(cooldown.get('B').retryAfter, 7200);
  assert.equal(cooldown.get('B', 'nemotron').blocked, true);
  assert.equal(cooldown.isCooling('C'), false);
  assert.equal(cooldown.cooldowns.has('provider:A\0default'), false);
  assert.equal(cooldown.lastMarked.has('provider:A\0default'), false);
});

test('expired cooldown history also migrates and never overwrites a newer mark', () => {
  const cooldown = new NodeCooldown();
  cooldown.lastMarked.set('old\0default', 300);
  cooldown.lastMarked.set('new\0default', 200);
  cooldown.lastMarked.set('new\0nemotron', 400);
  cooldown.rekey('old', 'new');
  assert.equal(cooldown.recentMark('new'), 400);
  assert.equal(cooldown.lastMarked.get('new\0default'), 300);
  assert.equal(cooldown.recentMark('old'), 0);
});

async function fixture(t, { missing = false, wrongSelector = false, failStart = false, neutral = '{"ip":"203.0.113.50"}', drip = false, huge = false, onStart = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-egress-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const providerFile = path.join(dir, 'provider.yaml');
  await fs.writeFile(providerFile, 'proxies: []\n');
  const observed = { starts: 0, stops: 0, requests: [], configs: [], active: 0, maxActive: 0 };
  const sockets = new Set();
  const endpoint = http.createServer((req, res) => {
    if (req.url === '/zen') { res.writeHead(403); res.end('forbidden'); return; }
    res.writeHead(200);
    if (drip) {
      const timer = setInterval(() => res.write(' '), 5);
      res.on('close', () => clearInterval(timer));
    } else res.end(huge ? 'x'.repeat(100_000) : neutral);
  });
  endpoint.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => endpoint.close(resolve)); });
  const processFactory = (options) => {
    let control;
    return {
      async start() {
        observed.starts++;
        observed.maxActive = Math.max(observed.maxActive, ++observed.active);
        const config = JSON.parse(await fs.readFile(options.configFile, 'utf8'));
        observed.configs.push({ config, options });
        await onStart?.({ providerFile, observed });
        if (failStart) throw new Error('https://user:secret@subscription.example/token-value');
        const groups = config['proxy-groups'];
        control = http.createServer((req, res) => {
          res.setHeader('content-type', 'application/json');
          if (req.url === '/providers/proxies/airport') {
            res.end(JSON.stringify({ proxies: missing ? [] : groups.map((g) => ({ name: new RegExp(g.filter).source.replace(/^\^|\$$/g, '').replace(/\\(.)/g, '$1') })) }));
          } else {
            const proxies = Object.fromEntries(groups.map((g) => {
              const node = new RegExp(g.filter).source.replace(/^\^|\$$/g, '').replace(/\\(.)/g, '$1');
              return [g.name, { all: wrongSelector ? ['DIRECT'] : [node], now: wrongSelector ? 'DIRECT' : node }];
            }));
            res.end(JSON.stringify({ proxies }));
          }
        });
        await new Promise((resolve) => control.listen(options.ctrlPort, '127.0.0.1', resolve));
      },
      async stop() {
        observed.stops++;
        observed.active--;
        if (control) await new Promise((resolve) => control.close(resolve));
      },
    };
  };
  const requestImpl = (url, options, callback) => {
    observed.requests.push({ url: String(url), port: options.agent.proxyPort });
    return http.request({ host: '127.0.0.1', port: endpoint.address().port, path: new URL(url).hostname === 'opencode.ai' ? '/zen' : '/neutral' }, callback);
  };
  return { dir, providerFile, observed, probe: new EgressProbe({ providerFile, dataDir: dir, timeoutMs: 60, processFactory, requestImpl }) };
}

test('isolated listener routes both targets to exact special-character node without selector writes', async (t) => {
  const { probe, observed, dir } = await fixture(t);
  const node = 'HK/a|b "quoted" [x] +.?';
  const [result] = await probe.measure([node]);
  assert.equal(result.node, node);
  assert.equal(result.exitIp, '203.0.113.50');
  assert.equal(result.zen.ok, true, 'HTTP 403 is responding reachability');
  assert.equal(result.zen.status, 403);
  assert.equal(result.neutral.ok, true);
  assert.equal(observed.requests.length, 2);
  assert.equal(observed.stops, 1);
  const { config, options } = observed.configs[0];
  assert.ok(options.dataDir.startsWith(dir + path.sep));
  assert.equal(config['mixed-port'] || 0, 0);
  assert.equal(config['proxy-providers'].airport.type, 'file');
  assert.equal(config['proxy-providers'].airport.url, undefined);
  assert.equal(config['proxy-providers'].airport['health-check']?.enable || false, false);
  assert.equal(config.listeners[0].proxy, config['proxy-groups'][0].name);
  assert.equal(config.listeners[0].listen, '127.0.0.1');
  assert.equal(config.listeners[0].type, 'http');
  assert.equal(observed.requests[0].port, config.listeners[0].port);
  assert.equal(observed.requests[1].port, config.listeners[0].port);
  const exact = new RegExp(config['proxy-groups'][0].filter);
  assert.ok(exact.test(node));
  assert.equal(exact.test(node + ' extra'), false);
  assert.equal(exact.test('HK/ab quoted x'), false);
  assert.equal(await fs.stat(options.dataDir).catch(() => null), null, 'probe workspace is released');
});

test('one scan covers every unique candidate and reuses fresh measurements', async (t) => {
  const { probe, observed } = await fixture(t);
  const nodes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const [first, second] = await Promise.all([probe.measure([...nodes, 'A', '', null]), probe.measure(nodes)]);
  assert.deepEqual(first.map((fact) => fact.node), nodes);
  assert.deepEqual(second.map((fact) => fact.node), nodes);
  assert.equal(observed.maxActive, 1, 'batches never overlap independent processes');
  assert.equal(observed.requests.length, nodes.length * 2, 'fresh nodes are not probed again');
  for (const node of nodes) assert.equal(probe.get(node).exitIp, '203.0.113.50');
  await probe.measure(['A'], { force: true });
  assert.equal(observed.requests.length, nodes.length * 2 + 2);
});

test('completed results become visible during a scan, including unknown exits', async (t) => {
  const { probe } = await fixture(t, { neutral: '{"ip":"not-an-ip"}' });
  const seen = [];
  const results = await probe.measure(['A', 'B', 'C', 'D'], {
    onResult: (fact) => {
      seen.push(fact.node);
      assert.equal(probe.get(fact.node).neutral.error, 'invalid_exit_ip');
    },
  });
  assert.deepEqual(new Set(seen), new Set(['A', 'B', 'C', 'D']));
  assert.equal(results.length, 4, 'unknown IPs are completed checks, not unmeasured nodes');
});

test('large scans retain results beyond the former 256-fact ceiling', async (t) => {
  const { probe } = await fixture(t);
  const nodes = Array.from({ length: 260 }, (_, i) => `node-${i}`);
  const results = await probe.measure(nodes);
  assert.deepEqual(results.map((fact) => fact.node), nodes);
  assert.equal(probe.snapshot().length, nodes.length);
});

for (const options of [{ neutral: '{"ip":"not-an-ip"}' }, { neutral: '{"ip":"203.0.113.1:443"}' }, { drip: true }, { huge: true }, { missing: true }, { wrongSelector: true }, { failStart: true }]) {
  test(`failed or untrustworthy measurement stays unknown and always cleans up ${JSON.stringify(options)}`, async (t) => {
    const { probe, observed } = await fixture(t, options);
    const start = Date.now();
    const [result] = await probe.measure(['A']);
    assert.equal(result.exitIp, null);
    assert.equal(result.neutral.ok, false);
    assert.ok(result.neutral.error);
    assert.equal(observed.stops, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret|subscription\.example|token-value/);
    if (options.drip) assert.ok(Date.now() - start < 1000, 'wall-clock deadline stops a continuously streaming peer');
    if (options.missing || options.wrongSelector || options.failStart) assert.equal(observed.requests.length, 0, 'fail closed before any external traffic');
  });
}

test('expired and retired facts do not remain in public snapshots indefinitely', async (t) => {
  const { probe } = await fixture(t);
  await probe.measure(['retired']);
  const at = probe.get('retired').at;
  assert.equal(typeof at, 'number');
  const now = Date.now;
  try {
    Date.now = () => at + 10 * 60 * 1000 + 1;
    assert.equal(probe.get('retired'), null);
    assert.deepEqual(probe.snapshot(), []);
  } finally {
    Date.now = now;
  }
});

test('migration keeps longer source Retry-After over destination blocked and 5xx policies', () => {
  const cooldown = new NodeCooldown();
  cooldown.mark429('source', 'default', 7200);
  cooldown.markBlocked('target', 'default');
  cooldown.mark5xx('target', 'nemotron');
  const before = cooldown.get('source');
  cooldown.rekey('source', 'target');
  assert.equal(cooldown.get('target').until, before.until);
  assert.equal(cooldown.get('target').retryAfter, 7200);
  assert.equal(cooldown.get('target', 'nemotron').reason, '5xx');
  assert.equal(cooldown.isCooling('source'), false);
});

test('adopting one measured alias never clears unmeasured aliases sharing its provider', () => {
  const identities = new Map([['A', 'provider'], ['B', 'provider']]);
  const cooldown = new NodeCooldown({ egressOf: node => identities.get(node) });
  cooldown.mark429('A', 'default', 3600);
  const deadline = cooldown.get('B').until;
  cooldown.rekey('provider', '203.0.113.7', { preserveSource: true });
  identities.set('A', '203.0.113.7');
  assert.equal(cooldown.get('A').until, deadline);
  assert.equal(cooldown.get('B').until, deadline);
  assert.equal(cooldown.recentMark('A'), cooldown.recentMark('B'));
  cooldown.rekey('provider', '203.0.113.7');
  identities.set('B', '203.0.113.7');
  assert.equal(cooldown.get('B').until, deadline);
  assert.equal(cooldown.cooldowns.has('provider\0default'), false);
});

test('cached facts are invalidated by provider changes even within the freshness window', async (t) => {
  const { probe, observed, providerFile } = await fixture(t);
  await fs.writeFile(providerFile, 'proxies:\n  - {name: A, server: old.example, type: http, port: 80}\n');
  await probe.measure(['A']);
  assert.equal(observed.starts, 1);
  await fs.writeFile(providerFile, 'proxies:\n  - {name: A, server: new.example, type: http, port: 80}\n');
  const [fresh] = await probe.measure(['A']);
  assert.equal(observed.starts, 2);
  assert.equal(fresh.provider, 'new.example');
  await fs.writeFile(providerFile, 'proxies:\n  - {name: A, server: new.example, type: http, port: 81}\n');
  await probe.measure(['A']);
  assert.equal(observed.starts, 3, 'same-name subscription changes invalidate cached routes too');
});

test('a provider changed during a batch cannot publish or cache the old snapshot result', async (t) => {
  const { probe, providerFile } = await fixture(t, {
    onStart: async ({ providerFile }) => {
      await fs.writeFile(providerFile, 'proxies:\n  - {name: A, server: new.example, type: http, port: 80}\n');
    },
  });
  await fs.writeFile(providerFile, 'proxies:\n  - {name: A, server: old.example, type: http, port: 80}\n');
  assert.deepEqual(await probe.measure(['A']), []);
  assert.equal(probe.get('A'), null);
  assert.deepEqual(probe.snapshot(), []);
});

test('cancelling during the initial readiness check prevents a late child spawn', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-probe-start-'));
  const configFile = path.join(dir, 'probe.json');
  await fs.writeFile(configFile, '{}');
  const instance = new MihomoInstance({ bin: process.execPath, configFile, dataDir: dir, ctrlPort: 1 });
  t.after(async () => { await instance.stop(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  let ready;
  const initialCheck = new Promise((resolve) => { ready = resolve; });
  instance.isRunning = () => initialCheck;
  const controller = new AbortController();
  const starting = instance.start(() => {}, { signal: controller.signal });
  controller.abort();
  ready(false);
  await assert.rejects(starting, (error) => error.name === 'AbortError');
  assert.equal(instance.child, null);
});
