import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageTracker, CALL_LOG_LIMIT } from '../server/usage.mjs';
import * as usageModule from '../server/usage.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciallo-usage-trace-'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const tracker = (file = 'memory.json', persist = false) => new UsageTracker(path.join(tmp, file), null, persist);

try {
  t('每次失败与取消尝试均保留关联、状态和真实出口元数据', () => {
    const u = tracker();
    for (const [i, outcome] of ['rateLimited', 'timeout', 'upstreamError', 'clientCanceled', 'backendMismatch', 'success'].entries()) {
      u.recordAttempt(`node-${i}`, outcome, i === 5 ? { prompt_tokens: 10, completion_tokens: 4 } : null,
        i === 5 ? { ttfb: 20, total: 70 } : null,
        { requestId: 'request-1', attempt: i + 1, model: `actual-${i}`, effort: 'max',
          status: i === 0 ? 429 : i === 5 ? 200 : null, error: i === 0 ? 'quota exhausted' : '', elapsed: 70 + i });
    }
    const { calls, total, byNode } = u.getStats();
    assert.equal(calls.length, 6, '失败不是只进聚合桶,必须有逐次记录');
    assert.deepEqual(calls.map((c) => c.outcome), ['rateLimited', 'timeout', 'upstreamError', 'clientCanceled', 'backendMismatch', 'success']);
    assert.deepEqual(calls.map((c) => c.attempt), [1, 2, 3, 4, 5, 6]);
    assert.ok(calls.every((c) => c.requestId === 'request-1'));
    assert.equal(calls[0].status, 429);
    assert.equal(calls[0].error, 'quota exhausted');
    assert.equal(calls[3].elapsed, 73);
    assert.equal(calls[5].model, 'actual-5');
    assert.equal(calls[5].in + calls[5].out, 14);
    assert.equal(total.requests, 0, '节点尝试不能增加客户端请求数');
    assert.equal(byNode['node-0'].rateLimited, 1);
  });

  t('recordRequest 保存最终摘要而不重复改变请求或节点聚合', () => {
    const u = tracker('summary.json', true);
    u.recordAttempt('A', 'timeout', null, null, { requestId: 'r', attempt: 1, elapsed: 20 });
    u.recordAttempt('B', 'success', { prompt_tokens: 2, completion_tokens: 3 }, { total: 50 },
      { requestId: 'r', attempt: 2, status: 200, elapsed: 50 });
    u.record('model', { prompt_tokens: 2, completion_tokens: 3 }, true);
    const before = structuredClone({ total: u.getStats().total, byNode: u.getStats().byNode });
    u.recordRequest({ requestId: 'r', model: 'model', outcome: 'success', status: 200, elapsed: 80, attempts: 2 });
    u.recordRequest({ requestId: 'invalid', model: 'bad', outcome: 'error', status: 400, elapsed: 1, attempts: 0 });
    const data = u.getStats();
    assert.deepEqual({ total: data.total, byNode: data.byNode }, before);
    assert.equal(data.requests.length, 2);
    assert.deepEqual(data.requests.map((r) => [r.requestId, r.outcome, r.attempts]), [['r', 'success', 2], ['invalid', 'error', 0]]);
    assert.equal(data.requests[0].elapsed, 80);
    assert.equal(data.requests[1].status, 400);
    assert.ok(data.requests[0].at > 0);
    const loaded = tracker('summary.json', true).getStats();
    assert.deepEqual(loaded.requests, data.requests, '最终摘要立即落盘,包括零尝试失败');
    assert.equal(loaded.calls.length, 2);
  });

  t('诊断信息不保留授权、API key、订阅 URL、原始对象或请求正文', () => {
    const u = tracker();
    const attempts = [
      'Authorization: Bearer secret-auth-value\nfailed with api_key=private-api-value token=private-token-value',
      'failed fetching https://user:pass@example.test/sub?token=subscription-secret',
      '{"error":{"message":"private body"},"messages":[{"content":"private prompt"}]}',
      '<html><body>private response body</body></html>',
      { message: 'private object body', request: { prompt: 'private prompt' } },
      'upstream busy '.repeat(100),
      'bad credential sk-example-secret-value',
    ];
    for (const [i, error] of attempts.entries()) {
      u.recordAttempt('A', 'upstreamError', null, null, { requestId: 'safe', attempt: i + 1, error,
        authorization: 'unlisted secret', body: 'private request body' });
    }
    assert.equal(u.getStats().calls.length, attempts.length);
    const stored = JSON.stringify(u.getStats().calls);
    for (const secret of ['secret-auth-value', 'private-api-value', 'private-token-value', 'subscription-secret',
      'user:pass', 'example.test', 'private body', 'private response body', 'private object body', 'private prompt',
      'unlisted secret', 'private request body', 'sk-example-secret-value']) assert.ok(!stored.includes(secret), `泄漏了 ${secret}`);
    for (const c of u.getStats().calls) {
      assert.equal(typeof c.error, 'string');
      assert.ok(c.error.length <= 512);
      assert.ok(!/[\r\n]/.test(c.error));
    }
  });

  t('失败 timing 与 elapsed 均不稀释成功样本,失败上报 usage 仍只计实际节点一次', () => {
    const u = tracker();
    u.recordAttempt('A', 'success', { prompt_tokens: 10, completion_tokens: 5 }, { ttfb: 20, total: 100 }, { elapsed: 100 });
    u.recordAttempt('A', 'timeout', { prompt_tokens: 2, completion_tokens: 1 }, { ttfb: 1, total: 1 }, { elapsed: 1 });
    u.recordAttempt('A', 'clientCanceled', null, { ttfb: 1, total: 1 }, { elapsed: 1 });
    const a = u.getStats().byNode.A;
    assert.equal(a.requests, 3);
    assert.equal(a.ttfbMs, 20);
    assert.equal(a.ttfbCount, 1);
    assert.equal(a.durationMs, 100);
    assert.equal(a.durationCount, 1);
    assert.equal(a.totalTokens, 18);
  });

  t('可复用诊断清理器覆盖配置密钥并在截断前清理凭据', () => {
    assert.equal(typeof usageModule.sanitizeDiagnostic, 'function');
    const cleaned = usageModule.sanitizeDiagnostic('failed custom-config-value again custom-config-value', ['custom-config-value']);
    assert.ok(!cleaned.includes('custom-config-value'));
    assert.ok(cleaned.includes('failed'));
    const edge = usageModule.sanitizeDiagnostic('x'.repeat(500) + ' Authorization: Bearer secret-across-limit');
    assert.ok(!edge.includes('secret-across'));
    assert.ok(edge.length <= 512);
  });

  t('尝试与请求窗口均有界,混合失败不被过滤且清零同时删除两者', () => {
    const u = tracker();
    for (let i = 0; i < CALL_LOG_LIMIT + 3; i++) {
      u.recordAttempt('A', i % 2 ? 'timeout' : 'success', null, null, { requestId: `r${i}`, attempt: 1 });
      u.recordRequest({ requestId: `r${i}`, outcome: i % 2 ? 'error' : 'success', attempts: 1 });
    }
    const data = u.getStats();
    assert.equal(data.calls.length, CALL_LOG_LIMIT);
    assert.equal(data.requests.length, CALL_LOG_LIMIT);
    assert.equal(data.calls[0].requestId, 'r3');
    assert.equal(data.requests[0].requestId, 'r3');
    assert.equal(data.calls.at(-1).requestId, `r${CALL_LOG_LIMIT + 2}`);
    u.reset();
    assert.deepEqual(u.getStats().calls, []);
    assert.deepEqual(u.getStats().requests, []);
  });

  t('旧账保留聚合和历史成功,没有请求摘要时不编造关联', () => {
    const file = path.join(tmp, 'legacy.json');
    const legacy = { at: 1, node: 'old', model: 'model', in: 7, out: 2, ms: 100 };
    fs.writeFileSync(file, JSON.stringify({ total: { requests: 7, success: 5, fail: 2 },
      byNode: { old: { requests: 9, success: 5, timeout: 4 } }, calls: [legacy] }));
    const data = tracker('legacy.json', true).getStats();
    assert.equal(data.total.requests, 7);
    assert.equal(data.byNode.old.requests, 9);
    assert.equal(data.calls.length, 1);
    assert.equal(data.calls[0].requestId, undefined);
    assert.equal(data.calls[0].attempt, undefined);
    assert.deepEqual(data.requests, []);
    assert.equal(data.calls[0].in, 7);
  });

  t('加载时请求窗口裁剪且坏数组归空,不改变历史聚合', () => {
    const file = path.join(tmp, 'load.json');
    fs.writeFileSync(file, JSON.stringify({ total: { requests: 9 }, calls: [],
      requests: Array.from({ length: CALL_LOG_LIMIT + 4 }, (_, i) => ({ requestId: `r${i}`, outcome: 'error' })) }));
    const data = tracker('load.json', true).getStats();
    assert.equal(data.requests.length, CALL_LOG_LIMIT);
    assert.equal(data.requests[0].requestId, 'r4');
    assert.equal(data.total.requests, 9);
    for (const bad of [null, {}, 'bad']) {
      fs.writeFileSync(file, JSON.stringify({ total: { requests: 9 }, requests: bad }));
      assert.deepEqual(tracker('load.json', true).getStats().requests, []);
    }
  });

  t('未验证模型名的诊断标签有界,包括旧持久化请求摘要', () => {
    const model = 'invalid-model-' + 'x'.repeat(20000);
    const u = tracker();
    u.recordRequest({ requestId: 'bad-model', model, outcome: 'error', status: 400, attempts: 0 });
    const current = u.getStats().requests[0];
    assert.ok(current.model.startsWith('invalid-model-'));
    assert.ok(Buffer.byteLength(JSON.stringify(current)) < 2048);
    const file = path.join(tmp, 'long-model.json');
    fs.writeFileSync(file, JSON.stringify({ total: { requests: 1 }, requests: [{ requestId: 'legacy', model, outcome: 'error', status: 400 }] }));
    const loaded = tracker('long-model.json', true).getStats().requests[0];
    assert.ok(loaded.model.startsWith('invalid-model-'));
    assert.ok(Buffer.byteLength(JSON.stringify(loaded)) < 2048);
  });

  console.log(`\nusage-trace.mjs: 全部通过 (${n} 组)\n`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
