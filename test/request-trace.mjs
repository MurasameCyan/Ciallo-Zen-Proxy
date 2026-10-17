import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Duplex, Readable } from 'node:stream';
import { after, beforeEach, test } from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-request-trace-'));
process.env.DATA_DIR = directory;
const { Gateway } = await import('../server/gateway.mjs');
const model = 'trace-fixture-free';
beforeEach(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory, { recursive: true }); });
after(() => fs.rmSync(directory, { recursive: true, force: true }));

function makeGateway(t, content) {
  const gateway = new Gateway({ apiKey: 'test', subscriptionUrl: '', persistUsage: false, maxChildLanes: 1 }, () => {});
  gateway.models = [model];
  gateway.modelsAt = Date.now();
  gateway.getAllNodes = async () => ['node-A'];
  gateway.ensureNode = async () => 'node-A';
  gateway.forwardBuffered = async () => ({ id: 'chatcmpl_fixture', object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  t.after(async () => {
    await gateway.stopChildLanes();
    await gateway.egressProbe.stop();
  });
  return gateway;
}

async function fixture(t, content) {
  const gateway = makeGateway(t, content);
  let closed;
  const responseClosed = new Promise(resolve => { closed = resolve; });
  const server = http.createServer((request, response) => {
    response.once('close', closed);
    gateway.handleChat(request, response).catch(error => response.destroy(error));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = () => new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'fixture' }] });
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      response.on('error', reject);
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  return { gateway, request, responseClosed };
}

test('client cancellation during buffered socket backpressure cannot be finalized as success', { timeout: 10000 }, async (t) => {
  const gateway = makeGateway(t, 'answer');
  let queued, pendingWrite;
  const responseQueued = new Promise(resolve => { queued = resolve; });
  // A real ServerResponse over a bounded slow transport avoids OS send-buffer
  // races. Destroying it fails the outstanding write before it can flush.
  const wire = new Duplex({
    read() {},
    write(chunk, encoding, callback) { pendingWrite = callback; queued(); },
    writev(chunks, callback) { pendingWrite = callback; queued(); },
    destroy(error, callback) {
      const pending = pendingWrite;
      pendingWrite = null;
      pending?.(error);
      callback(error);
    },
  });
  wire.on('error', () => {});
  t.after(() => wire.destroy());
  const request = Readable.from([JSON.stringify({ model, messages: [{ role: 'user', content: 'fixture' }] })]);
  Object.assign(request, { method: 'POST', httpVersionMajor: 1, httpVersionMinor: 1, headers: {}, socket: wire });
  const response = new http.ServerResponse(request);
  response.assignSocket(wire);
  const closed = new Promise(resolve => response.once('close', resolve));
  const handled = gateway.handleChat(request, response);
  await responseQueued;
  assert.equal(response.writableEnded, true);
  assert.equal(response.writableFinished, false);
  wire.destroy(Object.assign(new Error('peer reset'), { code: 'ECONNRESET' }));
  await handled;
  await closed;
  const stats = gateway.usage.getStats();
  assert.equal(stats.requests.length, 1);
  assert.equal(stats.requests[0].outcome, 'clientCanceled');
  assert.equal(stats.requests[0].attempts, 1);
  assert.equal(stats.total.success, 0);
  assert.equal(stats.byNode['node-A'].success, 1, 'the upstream did finish; only client delivery was canceled');
});

test('a flushed buffered reply finalizes exactly one successful client request', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, 'answer');
  const response = await f.request();
  await f.responseClosed;
  assert.equal(response.status, 200);
  assert.equal(response.body.choices[0].message.content, 'answer');
  const stats = f.gateway.usage.getStats();
  assert.equal(stats.requests.length, 1);
  assert.equal(stats.requests[0].outcome, 'success');
  assert.equal(stats.total.requests, 1);
  assert.equal(stats.total.success, 1);
  assert.equal(stats.byNode['node-A'].requests, 1);
});
