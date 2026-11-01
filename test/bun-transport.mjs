/**
 * bun-transport.mjs —— 上游请求经 Bun 代理时，网关看到的必须和直连 https 一样:
 * 上游的 HTTP 错误(429 FreeUsageLimitError)原样给分类器;代理那头的连接失败要变成
 * 请求 error(status 0),这样网关仍按传输错误换节点。用 Node 写的假代理顶替 Bun,
 * 协议和 server/bun-sidecar.js 一致。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBunTransport, stopBunTransport, upstreamRequest, bunTransportStatus } from '../server/bun-transport.mjs';

const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bun-transport-')), 'fake-sidecar.mjs');
fs.writeFileSync(fake, `
import http from 'node:http';
const server = http.createServer((req, res) => {
  if (req.headers['x-sidecar-token'] !== process.env.SIDECAR_TOKEN) { res.writeHead(403).end(); return; }
  const mode = req.headers['x-test-mode'];
  if (mode === 'transport') { res.writeHead(502, { 'x-sidecar-error': 'tunnel closed by proxy' }).end('x'); return; }
  if (mode === 'quota') {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } }));
    return;
  }
  res.writeHead(400).end();
});
server.listen(0, '127.0.0.1', () => console.log('SIDECAR_READY ' + server.address().port));
`);

const call = (mode, proxyPort = 17897) => new Promise((resolve) => {
  const req = upstreamRequest({
    host: 'opencode.ai', port: 443, path: '/inference/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-mode': mode }, agent: { proxyPort }, timeout: 5000,
  }, (res) => {
    let text = ''; res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', (error) => resolve({ error: error.message }));
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.end('{"model":"m"}');
});

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

assert.equal(await startBunTransport({ bin: process.execPath, script: fake }), true);
assert.equal(bunTransportStatus().ready, true);

await t('上游 429 原样交给网关,不当成代理故障', async () => {
  const r = await call('quota');
  assert.equal(r.status, 429);
  assert.equal(r.headers['retry-after'], '3600');
  assert.equal(JSON.parse(r.text).error.type, 'FreeUsageLimitError');
});

await t('代理连不上上游时变成请求 error,网关才会按传输错误换节点', async () => {
  const r = await call('transport');
  assert.equal(r.status, undefined, '代理失败绝不能变成一个 HTTP 502 响应交给分类器');
  assert.match(r.error, /^bun fetch: tunnel closed by proxy$/);
});

await stopBunTransport();
await t('代理停掉后不挂住:回退到 Node 直连', async () => {
  assert.equal(bunTransportStatus().ready, false);
  // 回退走 https.request;这里只验证它真的发出去并以网络错误结束,而不是等待一个不存在的代理。
  const r = await new Promise((resolve) => {
    const req = upstreamRequest({ host: '127.0.0.1', port: 9, path: '/', method: 'POST', agent: undefined, timeout: 3000 }, () => resolve({ responded: true }));
    req.on('error', (error) => resolve({ error: error.code || error.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
  assert.ok(r.error, `回退请求应以网络错误结束,实际 ${JSON.stringify(r)}`);
});

console.log(`\nbun-transport.mjs: 全部通过 (${n} 组)`);
