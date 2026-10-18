import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-cooldown-state-'));
process.env.DATA_DIR = directory;
const { Gateway } = await import('../server/gateway.mjs');
const { PROVIDER_FILE } = await import('../server/config.mjs');
const { NodeCooldown } = await import('../server/rotation.mjs');
const stateFile = path.join(directory, 'cooldowns.json');
let providerRevision = 0;
function providers(entries) {
  fs.mkdirSync(path.dirname(PROVIDER_FILE), { recursive: true });
  fs.writeFileSync(PROVIDER_FILE, `proxies:\n${entries.map(([name, server]) =>
    `  - {name: ${JSON.stringify(name)}, server: ${JSON.stringify(server)}, type: http, port: 80}`).join('\n')}\n`);
  const stamp = new Date(Date.now() + ++providerRevision * 1000);
  fs.utimesSync(PROVIDER_FILE, stamp, stamp);
}
async function measured(g, node, exitIp) {
  g.config.subscriptionUrl = 'test-only';
  const provider = g.providerIdentityOf(node);
  g.egressProbe.measure = async () => [{ node, provider, exitIp }];
  await g.measureEgress([node]);
}
const config = { apiKey: 'test', subscriptionUrl: '', persistUsage: false, maxChildLanes: 1 };
const gateway = () => new Gateway({ ...config }, () => {});
beforeEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  providers([]);
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('a new gateway skips a persisted cooling exit without resetting its deadline', () => {
  const first = gateway();
  first.cooldown.mark429('node-A', 'default', 3600);
  const until = first.cooldown.get('node-A').until;
  const next = gateway();
  assert.equal(next.cooldown.isCooling('node-A'), true);
  assert.equal(next.cooldown.get('node-A').until, until);
  assert.equal(next.cooldown.pickAvailable(['node-A', 'node-B']), 'node-B');
  assert.equal(next.cooldown.isCooling('node-A', 'nemotron'), false);
});

test('confirmed success and explicit reset stay cleared after another gateway starts', () => {
  const first = gateway();
  first.cooldown.mark429('node-A', 'default', 3600);
  first.cooldown.markBlocked('node-B', 'nemotron');
  const next = gateway();
  assert.equal(next.cooldown.isCooling('node-A'), true);
  assert.equal(next.cooldown.isCooling('node-B', 'nemotron'), true);
  next.cooldown.clear('node-A', 'default');
  const afterSuccess = gateway();
  assert.equal(afterSuccess.cooldown.isCooling('node-A'), false);
  assert.equal(afterSuccess.cooldown.isCooling('node-B', 'nemotron'), true);
  afterSuccess.resetCooldowns();
  const afterReset = gateway();
  assert.equal(afterReset.cooldown.isCooling('node-B', 'nemotron'), false);
});

test('an expired saved cooldown does not start a fresh waiting period', (t) => {
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  t.after(() => { Date.now = clock; });
  const first = gateway();
  first.cooldown.mark429('node-A', 'default', 2);
  now += 1000;
  const resumed = gateway();
  assert.equal(resumed.cooldown.get('node-A')?.remain, 1000);
  now += 2000;
  assert.equal(gateway().cooldown.isCooling('node-A'), false);
});

test('renamed and temporarily removed nodes retain provider-associated cooldowns', async () => {
  providers([['old-name', 'provider.example']]);
  const first = gateway();
  first.nodeCache = ['old-name'];
  await measured(first, 'old-name', '203.0.113.10');
  first.cooldown.mark429('old-name', 'default', 3600);
  const until = first.cooldown.get('old-name').until;
  const marked = first.cooldown.recentMark('old-name');
  providers([]);
  first.nodeCache = null;
  first.mihomoApi = async () => ({ all: [] });
  await first.getAllNodes();
  assert.equal(first.egressIdentities.get('old-name')?.ip, '203.0.113.10');
  providers([['new-name', 'provider.example']]);
  const next = gateway();
  next.nodeCache = ['new-name'];
  assert.equal(next.cooldown.get('new-name').until, until);
  assert.equal(next.cooldown.isCooling('new-name', 'nemotron'), false);
  assert.equal(next.cooldown.recentMark('new-name'), marked);
  assert.deepEqual(next.cooldown.summary().map(({ node }) => node), ['new-name']);
  await measured(next, 'new-name', '203.0.113.11');
  assert.equal(next.cooldown.isCooling('new-name'), false);
  assert.equal(next.cooldown.recentMark('new-name'), 0);
  assert.deepEqual(next.cooldown.summary(), []);
  const restored = gateway();
  restored.nodeCache = ['new-name'];
  assert.equal(restored.cooldown.egress('new-name'), '203.0.113.11');
  assert.equal(restored.cooldown.isCooling('new-name'), false);
  providers([['old-name', 'provider.example']]);
  restored.nodeCache = ['old-name'];
  assert.equal(restored.cooldown.get('old-name').until, until);
});

test('first measurement moves only fallback policy and different measured IPs never merge', async () => {
  providers([['A', 'shared.example'], ['B', 'shared.example']]);
  const first = gateway();
  first.nodeCache = ['A', 'B'];
  first.cooldown.mark429('A', 'default', 7200);
  first.cooldown.markBlocked('A', 'nemotron');
  const until = first.cooldown.get('A').until;
  await measured(first, 'A', '203.0.113.20');
  assert.equal(first.cooldown.get('B').until, until);
  await measured(first, 'B', '203.0.113.21');
  assert.equal(first.cooldown.isCooling('B'), false);
  assert.equal(first.cooldown.isCooling('B', 'nemotron'), false);
  first.cooldown.mark5xx('B', 'ling');
  await measured(first, 'A', '203.0.113.22');
  assert.equal(first.cooldown.isCooling('A'), false);
  assert.equal(first.cooldown.isCooling('A', 'ling'), false);
  const next = gateway();
  next.nodeCache = ['A', 'B'];
  assert.equal(next.cooldown.isCooling('A'), false);
  assert.equal(next.cooldown.isCooling('B'), false);
  assert.equal(next.cooldown.get('B', 'ling').reason, '5xx');
  providers([['unknown', 'shared.example']]);
  next.nodeCache = ['unknown'];
  assert.equal(next.cooldown.get('unknown').until, until);
  assert.equal(next.cooldown.get('unknown', 'nemotron').blocked, true);
  assert.equal(next.cooldown.get('unknown', 'ling').reason, '5xx');
  assert.equal(next.cooldown.isCooling('unknown', 'laguna'), false);
  assert.equal(next.cooldown.summary().filter((row) => row.group === 'default').length, 1);
});

test('weak marks never replace strong Retry-After policy across restart', () => {
  const first = gateway();
  first.cooldown.mark429('node-A', 'default', 7200);
  const strong = first.cooldown.get('node-A');
  first.cooldown.mark5xx('node-A');
  first.cooldown.markBlocked('node-A');
  first.cooldown.mark429('node-A');
  const resumed = gateway();
  assert.equal(resumed.cooldown.get('node-A').until, strong.until);
  assert.equal(resumed.cooldown.get('node-A').retryAfter, 7200);
  assert.equal(resumed.cooldown.get('node-A').blocked, undefined);
});

test('expiry saves cleanup but preserves queue-tail history until confirmed success', (t) => {
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  t.after(() => { Date.now = clock; });
  const first = gateway();
  first.cooldown.mark429('node-A', 'default', 1);
  const marked = first.cooldown.recentMark('node-A');
  now += 2000;
  assert.equal(first.cooldown.isCooling('node-A'), false);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).cooldowns.length, 0);
  const resumed = gateway();
  assert.equal(resumed.cooldown.recentMark('node-A'), marked);
  resumed.cooldown.clear('node-A', 'default');
  assert.equal(gateway().cooldown.recentMark('node-A'), 0);
});

test('related lookup deduplicates longest summary without clearing or marking other exits', () => {
  const c = new NodeCooldown({
    egressOf: (node) => node === 'unknown' ? 'provider' : node,
    relatedEgressesOf: (node) => node === 'unknown' ? ['ip-A', 'ip-B'] : [],
    namesOf: () => ['unknown'],
  });
  c.mark429('ip-A', 'default', 7200);
  c.mark429('ip-B', 'default', 3600);
  c.markBlocked('ip-B', 'nemotron');
  assert.equal(c.get('unknown').egress, 'ip-A');
  assert.equal(c.summary().filter((row) => row.group === 'default').length, 1);
  assert.equal(c.summary().find((row) => row.group === 'default').retryAfter, 7200);
  c.clear('unknown', 'default');
  assert.equal(c.isCooling('ip-A'), true);
  assert.equal(c.isCooling('ip-B'), true);
  c.mark5xx('unknown', 'ling');
  assert.equal(c.isCooling('ip-A', 'ling'), false);
  assert.equal(c.isCooling('ip-B', 'ling'), false);
});

test('identity rekey saves immediately and keeps complete group policy', () => {
  const first = gateway();
  first.cooldown.markBlocked('old', 'nemotron');
  first.cooldown.mark5xx('old', 'ling');
  first.cooldown.rekey('old', 'new');
  const next = gateway();
  assert.equal(next.cooldown.isCooling('old', 'nemotron'), false);
  assert.equal(next.cooldown.get('new', 'nemotron').blocked, true);
  assert.equal(next.cooldown.get('new', 'ling').reason, '5xx');
  assert.ok(next.cooldown.recentMark('new') > 0);
});

test('corrupt or unsupported state warns without preventing gateway startup', () => {
  for (const invalid of ['{broken', JSON.stringify({ version: 999 })]) {
    fs.writeFileSync(stateFile, invalid);
    const warnings = [];
    const g = new Gateway({ ...config }, (level, message) => warnings.push({ level, message }));
    assert.equal(g.cooldown.isCooling('node-A'), false);
    assert.ok(warnings.some(({ level, message }) => level === 'warn' && message.includes('[cooldowns]')));
    g.cooldown.mark429('node-A');
    assert.equal(gateway().cooldown.isCooling('node-A'), true);
  }
});

test('persisted state contains only cooldown policy and node/provider/IP associations', async () => {
  providers([['node-A', 'provider.example']]);
  const first = new Gateway({ ...config, apiKey: 'never-save-key', subscriptionUrl: 'never-save-subscription' }, () => {});
  await measured(first, 'node-A', '203.0.113.30');
  first.cooldown.mark429('node-A', 'default', 3600);
  const raw = fs.readFileSync(stateFile, 'utf8');
  assert.ok(raw.includes('provider.example'));
  assert.ok(raw.includes('203.0.113.30'));
  assert.equal(raw.includes('never-save'), false);
  assert.equal(raw.includes('subscriptionUrl'), false);
  assert.equal(raw.includes('apiKey'), false);
  assert.equal(raw.includes('request'), false);
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp') || name.endsWith('.replace')), []);
});

test('measured success clears only its group across restart and unknown aliases see that clearing', async () => {
  providers([['A', 'shared.example'], ['B', 'shared.example']]);
  const first = gateway();
  first.nodeCache = ['A', 'B'];
  await measured(first, 'A', '203.0.113.40');
  first.cooldown.mark429('A', 'default', 3600);
  first.cooldown.markBlocked('A', 'nemotron');
  const next = gateway();
  assert.equal(next.cooldown.isCooling('B'), true);
  next.cooldown.clear('A', 'default');
  const afterSuccess = gateway();
  assert.equal(afterSuccess.cooldown.isCooling('A'), false);
  assert.equal(afterSuccess.cooldown.isCooling('B'), false);
  assert.equal(afterSuccess.cooldown.isCooling('B', 'nemotron'), true);
  assert.ok(afterSuccess.cooldown.recentMark('B') > 0);
  afterSuccess.resetCooldowns();
  const afterReset = gateway();
  assert.equal(afterReset.cooldown.isCooling('B', 'nemotron'), false);
  assert.equal(afterReset.cooldown.recentMark('B'), 0);
});

test('changing provider does not move an old measured exit policy onto the new provider', async () => {
  providers([['A', 'old.example']]);
  const first = gateway();
  await measured(first, 'A', '203.0.113.50');
  first.cooldown.mark429('A', 'default', 3600);
  const until = first.cooldown.get('A').until;
  providers([['A', 'new.example'], ['old-alias', 'old.example']]);
  assert.equal(first.cooldown.isCooling('A'), false);
  assert.equal(first.cooldown.get('old-alias').until, until);
  await measured(first, 'A', '203.0.113.51');
  const next = gateway();
  assert.equal(next.cooldown.isCooling('A'), false);
  assert.equal(next.cooldown.get('old-alias').until, until);
});

test('pure snapshot restore retains absolute deadline, flags and independent ranking history', () => {
  const first = new NodeCooldown();
  first.mark429('A', 'default', 7200);
  first.markBlocked('B', 'nemotron');
  first.mark5xx('C', 'ling');
  first.lastMarked.set('expired\u0000default', 123);
  let changes = 0;
  const next = new NodeCooldown({ onChange: () => { changes++; } });
  next.restore(first.snapshot());
  assert.equal(changes, 0, 'restoring must not recursively save');
  assert.equal(next.get('A').until, first.get('A').until);
  assert.equal(next.get('B', 'nemotron').blocked, true);
  assert.equal(next.get('C', 'ling').reason, '5xx');
  assert.equal(next.recentMark('expired'), 123);
  assert.equal(next.recentMark('A'), first.recentMark('A'));
  next.clear('A', 'default');
  assert.equal(changes, 1);
});

test('measured IPs never collide with provider or node fallback policy domains', async () => {
  providers([['measured', 'source.example'], ['fallback', '203.0.113.61']]);
  const g = gateway();
  g.cooldown.mark429('fallback', 'default', 7200);
  const until = g.cooldown.get('fallback').until;
  await measured(g, 'measured', '203.0.113.61');
  assert.equal(g.cooldown.isCooling('measured'), false);
  assert.equal(g.cooldown.get('fallback').until, until);
  await measured(g, 'fallback', '203.0.113.62');
  assert.equal(g.cooldown.isCooling('measured'), false);
  assert.equal(g.cooldown.get('fallback').until, until);
  providers([['measured', 'source.example']]);
  g.cooldown.markBlocked('203.0.113.61', 'nemotron');
  assert.equal(g.cooldown.isCooling('measured', 'nemotron'), false);
  assert.equal(gateway().cooldown.isCooling('measured', 'nemotron'), false);
});

test('gateway rejects obsolete cached and in-flight provider measurements', async () => {
  providers([['A', 'old.example']]);
  const g = gateway();
  g.config.subscriptionUrl = 'test-only';
  g.egressProbe.measure = async () => [{ node: 'A', provider: 'old.example', exitIp: '203.0.113.70' }];
  await g.measureEgress(['A']);
  providers([['A', 'new.example']]);
  await g.measureEgress(['A']);
  assert.equal(g.cooldown.egress('A'), 'new.example');
  let finish;
  g.egressProbe.measure = () => new Promise((resolve) => { finish = resolve; });
  const pending = g.measureEgress(['A']);
  providers([['A', 'third.example']]);
  finish([{ node: 'A', provider: 'new.example', exitIp: '203.0.113.71' }]);
  await pending;
  assert.equal(g.cooldown.egress('A'), 'third.example');
  const restored = gateway();
  assert.equal(restored.cooldown.egress('A'), 'third.example');
});

test('a completed exit adopts its cooldown policy before the rest of the scan finishes', async (t) => {
  providers([['A', 'shared.example'], ['B', 'shared.example']]);
  const g = gateway();
  g.config.subscriptionUrl = 'test-only';
  g.nodeCache = ['A', 'B'];
  g.cooldown.mark429('A', 'default', 3600);
  const deadline = g.cooldown.get('A').until;
  let report, finish;
  const first = { node: 'A', provider: 'shared.example', exitIp: '203.0.113.72' };
  const unknown = { node: 'B', provider: 'shared.example', exitIp: null };
  g.egressProbe.measure = (_, { onResult }) => {
    report = onResult;
    return new Promise((resolve) => { finish = resolve; });
  };
  const pending = g.measureEgress(g.nodeCache);
  t.after(async () => { finish([first, unknown]); await pending; });
  report?.(first);
  assert.equal(g.cooldown.egress('A'), first.exitIp, 'new evidence must be usable without waiting for slow nodes');
  assert.equal(g.cooldown.get('A').until, deadline);
  assert.equal(g.cooldown.get('B').until, deadline, 'unknown aliases retain their existing protection');
  let status = g.egressStatus(g.nodeCache);
  assert.equal(status.measuring, true);
  assert.equal(status.progress.completed, 1);
  report(unknown);
  status = g.egressStatus(g.nodeCache);
  assert.equal(status.progress.completed, 2, 'failed IP checks still advance completion');
  assert.equal(status.progress.failed, 1);
  assert.equal(status.measuring, true, 'cleanup is still part of the active scan');
  finish([first, unknown]);
  await pending;
  status = g.egressStatus(g.nodeCache);
  assert.equal(status.measuring, false);
  assert.equal(status.progress.completed, 2, 'final results must not count streaming callbacks twice');
  assert.equal(status.progress.measured, 1);
  assert.equal(status.progress.cancelled, false);
});

test('policy-free identity churn is collected and read lookups never rewrite history', async () => {
  const g = gateway();
  for (let i = 0; i < 24; i++) {
    providers([[`alias-${i}`, 'shared.example']]);
    await measured(g, `alias-${i}`, `203.0.113.${100 + i}`);
  }
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.identities.length, 1);
  assert.equal(saved.associations.length, 1);
  assert.equal(g.egressIdentities.size, 1);
  assert.equal(g.egressAssociations.size, 1);
  const associations = [...g.egressAssociations];
  for (let i = 0; i < 24; i++) g.cooldown.isCooling(`unknown-${i}`);
  assert.deepEqual([...g.egressAssociations], associations);
});

test('unchanged cached measurements do not save serialize or rebuild identity state', async () => {
  providers([['A', 'shared.example']]);
  const g = gateway();
  await measured(g, 'A', '203.0.113.80');
  g.cooldown.mark429('A', 'default', 3600);
  let saves = 0, snapshots = 0;
  const identity = g.egressIdentities.get('A');
  const associations = [...g.egressAssociations];
  g.cooldownState.save = () => { saves++; };
  g.cooldown.snapshot = () => { snapshots++; throw new Error('unchanged facts must not serialize'); };
  await g.measureEgress(['A']);
  await g.measureEgress(['A']);
  assert.equal(saves, 0);
  assert.equal(snapshots, 0);
  assert.equal(g.egressIdentities.get('A'), identity);
  assert.deepEqual([...g.egressAssociations], associations);
});

test('rejected backoff persists reason and absolute short deadline without weakening strong policies', (t) => {
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  t.after(() => { Date.now = clock; });
  const g = gateway();
  g.cooldown.markRejected('A', 'ling');
  const until = g.cooldown.get('A', 'ling').until;
  assert.equal(g.cooldown.get('A', 'ling').reason, 'rejected');
  assert.equal(until, now + 60_000);
  assert.equal(g.cooldown.isCooling('A', 'default'), false);
  now += 1000;
  const restored = gateway();
  assert.equal(restored.cooldown.get('A', 'ling').reason, 'rejected');
  assert.equal(restored.cooldown.get('A', 'ling').until, until);
  restored.cooldown.mark429('B', 'default', 7200);
  restored.cooldown.markBlocked('C');
  const strong = restored.cooldown.get('B');
  const blocked = restored.cooldown.get('C');
  restored.cooldown.markRejected('B');
  restored.cooldown.markRejected('C');
  assert.equal(restored.cooldown.get('B').until, strong.until);
  assert.equal(restored.cooldown.get('B').retryAfter, 7200);
  assert.equal(restored.cooldown.get('C').until, blocked.until);
  assert.equal(restored.cooldown.get('C').blocked, true);
  now = until + 1;
  assert.equal(gateway().cooldown.isCooling('A', 'ling'), false);
});

test('expired failed-exit churn releases retired aliases and ages out unneeded ranking history', async (t) => {
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  t.after(() => { Date.now = clock; });
  const g = gateway();
  for (let i = 0; i < 24; i++) {
    const node = `failed-alias-${i}`;
    providers([[node, 'shared.example']]);
    g.nodeCache = [node];
    await measured(g, node, `203.0.113.${100 + i}`);
    g.cooldown.markRejected(node);
    now += 60_001;
  }
  providers([['current', 'shared.example']]);
  g.nodeCache = ['current'];
  await measured(g, 'current', '203.0.113.200');
  assert.equal(g.egressIdentities.size, 1, 'provider/IP policy history must not retain every old alias');
  assert.ok(g.cooldown.recentMark('unrelated') === 0);
  providers([['current', 'shared.example'], ['unknown', 'shared.example']]);
  assert.ok(g.cooldown.recentMark('unknown') > 0, 'recent failed exits still rank unknown aliases conservatively');
  assert.equal(g.cooldown.isCooling('unknown'), false);
  now += 24 * 3600 * 1000 + 1;
  g.saveCooldownState();
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.lastMarked.length, 0);
  assert.equal(g.cooldown.lastMarked.size, 0);
  assert.equal(saved.identities.length, 1);
  assert.equal(saved.associations.length, 1);
  assert.equal(g.cooldown.recentMark('unknown'), 0);
  assert.equal(gateway().cooldown.recentMark('unknown'), 0);
});

test('history collection preserves current ranking and every effective absolute policy without retired measured rows', async (t) => {
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  t.after(() => { Date.now = clock; });
  providers([['current', 'shared.example'], ['retired-active', 'shared.example'], ['retired-expired', 'shared.example']]);
  const g = gateway();
  for (const [node, ip] of [['current', '203.0.113.230'], ['retired-active', '203.0.113.231'], ['retired-expired', '203.0.113.232']]) {
    await measured(g, node, ip);
  }
  g.cooldown.markRejected('current');
  const currentMark = g.cooldown.recentMark('current');
  g.cooldown.mark429('retired-active', 'nemotron', 24 * 3600);
  g.cooldown.markRejected('retired-expired');
  const state = g.cooldown.snapshot();
  const active = state.cooldowns.find((row) => row.group === 'nemotron');
  active.until = now + 48 * 3600 * 1000;
  g.cooldown.restore(state);
  now += 25 * 3600 * 1000;
  providers([['current', 'shared.example'], ['unknown', 'shared.example']]);
  g.nodeCache = ['current', 'unknown'];
  g.saveCooldownState();
  assert.equal(g.cooldown.recentMark('current'), currentMark, 'current candidate ranking is still needed');
  assert.equal(g.cooldown.get('unknown', 'nemotron').until, active.until);
  assert.equal(g.cooldown.get('unknown', 'nemotron').retryAfter, 24 * 3600);
  assert.equal(g.cooldown.isCooling('current', 'nemotron'), false, 'known distinct IPs stay independent');
  assert.deepEqual([...g.egressIdentities.keys()], ['current']);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.associations.some((row) => row.ip === '203.0.113.232'), false);
  const restored = gateway();
  assert.equal(restored.cooldown.get('unknown', 'nemotron').until, active.until);
  assert.equal(restored.cooldown.recentMark('current'), currentMark);
});

test('retry exclusions skip unknown aliases of a measured exit but retain measured independent IPs', async () => {
  providers([['tried', 'shared.example'], ['unknown', 'shared.example'], ['independent', 'shared.example']]);
  const g = gateway();
  g.nodeCache = ['tried', 'unknown', 'independent'];
  await measured(g, 'tried', '203.0.113.240');
  await measured(g, 'independent', '203.0.113.241');
  assert.equal(g.cooldown.pickAvailable(g.nodeCache, 'default', new Set(['tried'])), 'independent');
  assert.equal(g.cooldown.pickAvailable(['tried', 'independent'], 'default', new Set(['unknown'])), null);
});

test('normal unchanged inventory polling ages retired ranking without another state mutation', async (t) => {
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  t.after(() => { Date.now = clock; });
  providers([['old', 'shared.example']]);
  const g = gateway();
  g.nodeCache = ['old'];
  await measured(g, 'old', '203.0.113.242');
  g.cooldown.markRejected('old');
  providers([['unknown', 'shared.example']]);
  g.nodeCache = ['unknown'];
  g.egressStatus(g.nodeCache);
  now += 60_001;
  assert.equal(g.cooldown.isCooling('unknown'), false);
  assert.ok(g.cooldown.recentMark('unknown') > 0);
  let saves = 0, snapshots = 0;
  const save = g.cooldownState.save.bind(g.cooldownState);
  const snapshot = g.cooldown.snapshot.bind(g.cooldown);
  g.cooldownState.save = (state) => { saves++; return save(state); };
  g.cooldown.snapshot = () => { snapshots++; return snapshot(); };
  for (let i = 0; i < 5; i++) {
    g.egressStatus(g.nodeCache);
    g.rankNodes(g.nodeCache);
  }
  assert.equal(saves, 0, 'unchanged polls before the history deadline do not save');
  assert.equal(snapshots, 0, 'unchanged polls before the history deadline do not serialize');
  now += 24 * 3600 * 1000 + 1;
  g.egressStatus(g.nodeCache);
  assert.equal(g.cooldown.recentMark('unknown'), 0);
  assert.equal(gateway().cooldown.recentMark('unknown'), 0);
  assert.equal(saves, 1);
  assert.equal(snapshots, 1);
  g.nodeCache = ['unknown'];
  g.rankNodes(g.nodeCache);
  g.egressStatus(g.nodeCache);
  assert.equal(saves, 1, 'a refreshed equal node list and empty retired history stay cheap');
  assert.equal(snapshots, 1);
  assert.equal(g.egressAssociations.size, 0);
});

test('selection collects stale restored history while retaining current ranking and active absolute policy', async (t) => {
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  t.after(() => { Date.now = clock; });
  providers([['current', 'shared.example'], ['old', 'shared.example'], ['active', 'shared.example']]);
  const first = gateway();
  first.nodeCache = ['current', 'old', 'active'];
  for (const [node, ip] of [['current', '203.0.113.243'], ['old', '203.0.113.244'], ['active', '203.0.113.245']]) {
    await measured(first, node, ip);
  }
  first.cooldown.markRejected('current');
  const currentMark = first.cooldown.recentMark('current');
  first.cooldown.markRejected('old');
  now += 2 * 3600 * 1000;
  first.cooldown.mark429('active', 'nemotron', 24 * 3600);
  const active = first.cooldown.get('active', 'nemotron');
  providers([['current', 'shared.example'], ['unknown', 'shared.example']]);
  first.nodeCache = ['current', 'unknown'];
  first.egressStatus(first.nodeCache);
  now += 23 * 3600 * 1000;
  const restored = gateway();
  restored.nodeCache = ['current', 'unknown'];
  restored.rankNodes(restored.nodeCache);
  assert.equal(restored.cooldown.recentMark('current'), currentMark);
  const effective = restored.cooldown.get('unknown', 'nemotron');
  for (const key of ['until', 'retryAfter', 'group', 'reason']) assert.equal(effective[key], active[key]);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.associations.some((row) => row.ip === '203.0.113.244'), false);
  assert.equal(saved.associations.some((row) => row.ip === '203.0.113.245'), true);
  now = active.until + 1;
  restored.rankNodes(restored.nodeCache);
  assert.equal(restored.cooldown.recentMark('unknown'), currentMark, 'unknown aliases still inherit the current measured exit ranking');
  assert.equal(restored.cooldown.recentMark('current'), currentMark);
  assert.equal(restored.cooldown.get('unknown', 'nemotron'), null);
  assert.equal([...restored.egressAssociations.values()].some((row) => row.ip === '203.0.113.245'), false);
  assert.equal(gateway().cooldown.recentMark('unknown'), currentMark);
  restored.nodeCache = ['unknown'];
  restored.rankNodes(restored.nodeCache);
  assert.equal(restored.cooldown.recentMark('current'), 0, 'retiring the final direct reference schedules collection');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastMarked.length, 0);
});

test('retry exclusions keep IP-looking provider and node fallback identities distinct', async () => {
  providers([['measured', 'source.example'], ['fallback', '203.0.113.246']]);
  const g = gateway();
  await measured(g, 'measured', '203.0.113.246');
  assert.equal(g.cooldown.pickAvailable(['fallback'], 'default', new Set(['measured'])), 'fallback');
  assert.equal(g.cooldown.pickAvailable(['203.0.113.246'], 'default', new Set(['measured'])), '203.0.113.246');
  assert.equal(g.cooldown.pickAvailable(['measured'], 'default', new Set(['fallback'])), 'measured');
  assert.equal(g.cooldown.pickAvailable(['measured'], 'default', new Set(['203.0.113.246'])), 'measured');
});
