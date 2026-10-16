import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpencodeVersionStore, CLIENT_VERSION_URL, CLIENT_VERSION_TTL_MS } from '../server/opencode-version.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ciallo-version-'));
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const release = (version, fields = {}) => ({
  channel: 'latest', name: 'cli', distribution: 'npm', active: true,
  metadata: { package: '@opencode/cli' }, version, ...fields,
});
const response = (payload) => ({ ok: true, json: async () => payload });

try {
  await t('24 小时到期才更新,重启后继续使用上次成功版本与剩余 TTL', async () => {
    let now = 1_000_000_000_000;
    let calls = 0;
    const file = path.join(TMP, 'ttl.json');
    const fetchImpl = async (url) => {
      assert.equal(url, CLIENT_VERSION_URL);
      return response(release(++calls === 1 ? '2.0.31' : '2.0.32'));
    };
    const first = new OpencodeVersionStore({ file, now: () => now, fetchImpl });
    await first.refresh();
    const savedAt = now;
    const again = new OpencodeVersionStore({ file, now: () => now, fetchImpl });
    now += CLIENT_VERSION_TTL_MS - 1;
    await again.refresh();
    assert.equal(calls, 1);
    assert.equal(again.version, '2.0.31');
    now++;
    await again.refresh();
    assert.equal(calls, 2);
    assert.equal(again.version, '2.0.32');
    assert.equal(again.status().updatedAt, savedAt + CLIENT_VERSION_TTL_MS);
    assert.equal(new OpencodeVersionStore({ file }).version, '2.0.32');
  });

  await t('并发刷新只发一个请求,等待期间仍可使用上一成功版本', async () => {
    let unblock;
    let calls = 0;
    const store = new OpencodeVersionStore({
      file: path.join(TMP, 'concurrent.json'),
      fetchImpl: async () => { calls++; return new Promise(resolve => { unblock = resolve; }); },
    });
    const before = store.version;
    const a = store.refresh(), b = store.refresh();
    assert.equal(store.version, before);
    assert.equal(calls, 1);
    unblock(response(release('2.0.31')));
    await Promise.all([a, b]);
    assert.equal(calls, 1);
    assert.equal(store.version, '2.0.31');
  });

  await t('网络失败、非发行源、非法版本和版本倒退均不能覆盖成功缓存', async () => {
    const file = path.join(TMP, 'preserve.json');
    let payload = release('2.0.31');
    const store = new OpencodeVersionStore({ file, fetchImpl: async () => response(payload) });
    await store.refresh();
    const disk = fs.readFileSync(file, 'utf8');
    const bad = [
      release('1.19.3'), release('2.0.31-beta.1'), release('2.00.32'),
      release('2.0.32\r\nx-injected: yes'), release('2.0.30'),
      release('2.0.32', { channel: 'dev' }), release('2.0.32', { name: 'desktop' }),
      release('2.0.32', { distribution: 'github' }), release('2.0.32', { active: false }),
      release('2.0.32', { metadata: { package: 'opencode-ai' } }),
    ];
    for (payload of bad) {
      await assert.rejects(store.refresh({ force: true }));
      assert.equal(store.version, '2.0.31');
      assert.equal(fs.readFileSync(file, 'utf8'), disk);
    }
    store.fetchImpl = async () => { throw new Error('offline'); };
    await assert.rejects(store.refresh({ force: true }), /offline/);
    assert.equal(store.status().lastError, 'offline');
    assert.equal(new OpencodeVersionStore({ file }).version, '2.0.31');
    store.fetchImpl = async () => response(release('2.0.32'));
    await store.refresh({ force: true });
    assert.equal(store.version, '2.0.32');
    assert.equal(store.status().lastError, null);
  });

  await t('损坏或包含不安全头值的缓存不能成为出站版本', async () => {
    const file = path.join(TMP, 'bad-cache.json');
    const fallback = new OpencodeVersionStore({ file }).version;
    assert.equal(fallback, '2.0.29');
    assert.equal(new OpencodeVersionStore({ file }).version, fallback);
    fs.writeFileSync(file, JSON.stringify({ version: '2.0.32\nunsafe', updatedAt: Date.now() }));
    assert.equal(new OpencodeVersionStore({ file }).version, fallback);
  });

  await t('后台按剩余 TTL 触发,停掉在途刷新不会复活定时器', async () => {
    let now = 1_000_000_000_000;
    let unblock;
    const file = path.join(TMP, 'scheduler.json');
    fs.writeFileSync(file, JSON.stringify({ version: '2.0.31', updatedAt: now }));
    const store = new OpencodeVersionStore({ file, now: () => now,
      fetchImpl: () => new Promise(resolve => { unblock = resolve; }),
    });
    let id = 0;
    const timers = new Map();
    const setTimer = (fn, delay) => { const handle = ++id; timers.set(handle, { fn, delay }); return handle; };
    const clearTimer = handle => timers.delete(handle);
    now += 2 * 3600_000;
    store.start({ setTimer, clearTimer });
    const [handle, timer] = [...timers][0];
    assert.equal(timer.delay, CLIENT_VERSION_TTL_MS - 2 * 3600_000);
    now += timer.delay;
    timers.delete(handle);
    const running = timer.fn();
    store.stop();
    unblock(response(release('2.0.32')));
    await running;
    assert.equal(store.version, '2.0.32');
    assert.equal(timers.size, 0);
  });

  await t('首次刷新失败仍有可用版本,下一天自动恢复且无需客户端请求', async () => {
    let now = 1_000_000_000_000;
    let calls = 0;
    let timer;
    const store = new OpencodeVersionStore({ file: path.join(TMP, 'offline-start.json'), now: () => now,
      fetchImpl: async () => { if (++calls === 1) throw new Error('offline'); return response(release('2.0.31')); },
    });
    const before = store.version;
    const setTimer = (fn, delay) => { timer = { fn, delay }; return 1; };
    store.start({ setTimer, clearTimer: () => { timer = null; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.version, before);
    assert.equal(timer.delay, CLIENT_VERSION_TTL_MS);
    now += timer.delay;
    await timer.fn();
    assert.equal(store.version, '2.0.31');
    assert.equal(calls, 2);
    store.stop();
  });
  console.log(`\nopencode-version.mjs: 全部通过 (${n} 组)`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
