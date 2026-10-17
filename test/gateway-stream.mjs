import assert from 'node:assert/strict';
import { test } from 'node:test';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Gateway, OPENAI, ANTHROPIC, RESPONSES } from '../server/gateway.mjs';
import { chatUpstreamDialect, withToolAliases } from '../server/dialects.mjs';

const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const chat = (delta, finish_reason = null) => frame({ choices: [{ index: 0, delta, finish_reason }] });
async function stream(t, send, dialect = OPENAI, budget = 5000, { buffered = false, config = {} } = {}) {
  const original = https.request;
  const client = new EventEmitter();
  Object.assign(client, { code: null, body: '', writableEnded: false,
    writeHead(code) { this.code = code; }, write(value) { this.body += value; },
    end(value) { if (value) this.write(value); this.writableEnded = true; }, setHeader() {} });
  let request;
  let response;
  const cleanups = [];
  https.request = (_options, callback) => {
    request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => { request.destroyed = true; };
    request.end = () => queueMicrotask(() => {
      response = new EventEmitter();
      Object.assign(response, { statusCode: 200, headers: {}, setTimeout() { return this; } });
      callback(response);
      Promise.resolve().then(() => send({ request, response, client, cleanup: fn => cleanups.push(fn) })).catch(error => response.emit('error', error));
    });
    return request;
  };
  t.after(() => { for (const cleanup of cleanups) cleanup(); https.request = original; });
  const gateway = Object.create(Gateway.prototype);
  const logs = [];
  Object.assign(gateway, { config: { pinClaudeBackend: false, ...config }, logger: (_level, message) => logs.push(message), agent: null });
  const result = buffered
    ? gateway.forwardBuffered(client, { model: 'boundary-free', messages: [] }, dialect, budget)
    : gateway.forwardStream(client, { model: 'boundary-free', messages: [] }, dialect, budget);
  return { client, result, logs, getRequest: () => request };
}

for (const [name, prefix] of [['heartbeat', ': ping\n\n'], ['role', chat({ role: 'assistant' })], ['lifecycle', frame({ type: 'response.created', response: { id: 'resp_x', status: 'in_progress' } })]]) {
  test(`${name}-only EOF cannot commit HTTP 200 or count as success`, async (t) => {
    const { client, result } = await stream(t, ({ response }) => { response.emit('data', Buffer.from(prefix)); response.emit('end'); });
    await assert.rejects(result, error => error.notStarted === true && Number(error.status) >= 500);
    assert.equal(client.code, null);
    assert.equal(client.body, '');
  });
}

test('first SSE error preserves status and retry-after before any client output', async (t) => {
  const { client, result } = await stream(t, ({ response }) => {
    response.headers['retry-after'] = '3600';
    response.emit('data', Buffer.from(frame({ error: { type: 'rate_limit_error', message: 'quota [429]' } })));
    response.emit('end');
  });
  await assert.rejects(result, error => error.status === 429 && error.retryAfter === 3600 && error.notStarted === true);
  assert.equal(client.code, null);
});

test('fragmented UTF-8 frames are withheld until complete and are never corrupted', async (t) => {
  const wire = chat({ role: 'assistant' }) + chat({ content: '你好 [DONE]' }) + chat({}, 'stop') + 'data: [DONE]\n\n';
  const bytes = Buffer.from(wire);
  const split = bytes.indexOf(Buffer.from('你')) + 1;
  const { client, result } = await stream(t, ({ response, client }) => {
    response.emit('data', bytes.subarray(0, split));
    assert.equal(client.code, null, 'role and partial content do not commit the client response');
    response.emit('data', bytes.subarray(split));
    response.emit('end');
  });
  assert.equal((await result).ok, true);
  assert.equal(client.code, 200);
  assert.ok(client.body.includes('你好 [DONE]'));
  assert.ok(!client.body.includes('\uFFFD'));
});

test('after opening, pending partial frames are not written into heartbeat boundaries', async (t) => {
  const first = chat({ content: 'first' });
  const second = chat({ content: 'second' });
  const { client, result } = await stream(t, ({ response, client }) => {
    response.emit('data', Buffer.from(first));
    response.emit('data', Buffer.from(second.slice(0, 12)));
    assert.equal(client.body, first, 'a heartbeat can now only land after a complete frame');
    response.emit('data', Buffer.from(second.slice(12) + chat({}, 'stop') + 'data: [DONE]\n\n'));
    response.emit('end');
  });
  assert.equal((await result).ok, true);
  assert.equal(client.body, first + second + chat({}, 'stop') + 'data: [DONE]\n\n');
});

test('content without a terminal is an upstream failure, never a successful EOF', async (t) => {
  const { client, result } = await stream(t, ({ response }) => { response.emit('data', Buffer.from(chat({ content: 'unfinished' }))); response.emit('end'); });
  assert.equal((await result).ok, false);
  assert.equal(client.code, 200);
  assert.ok(!client.body.includes('data: [DONE]'));
});

test('error after business output fails once with a protocol error and no normal completion', async (t) => {
  const { client, result } = await stream(t, ({ response }) => {
    response.emit('data', Buffer.from(chat({ content: 'partial' })));
    response.emit('data', Buffer.from(frame({ error: { message: 'provider failed [503]' } })));
    response.emit('end');
  }, ANTHROPIC);
  const output = await result;
  assert.equal(output.ok, false);
  const events = client.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.equal(events.filter(event => event.type === 'error').length, 1);
  assert.equal(events.filter(event => event.type === 'message_stop').length, 1);
  assert.ok(!events.some(event => event.type === 'message_delta' && event.delta?.stop_reason === 'end_turn'));
});

test('a legal empty reply completes without any invented text', async (t) => {
  const { client, result } = await stream(t, ({ response }) => { response.emit('data', Buffer.from(chat({ role: 'assistant' }) + chat({}, 'stop') + 'data: [DONE]\n\n')); response.emit('end'); });
  assert.equal((await result).ok, true);
  assert.equal(client.code, 200);
  assert.ok(!client.body.includes('"content"'));
});

test('CRLF and multiline SSE data are parsed as one event and retain usage', async (t) => {
  const wire = 'data: {"choices":[\r\ndata: {"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}],\r\ndata: "usage":{"prompt_tokens":2,"completion_tokens":3}}\r\n\r\ndata: [DONE]\r\n\r\n';
  const { client, result } = await stream(t, ({ response }) => { for (const byte of Buffer.from(wire)) response.emit('data', Buffer.from([byte])); response.emit('end'); });
  const output = await result;
  assert.equal(output.ok, true);
  assert.equal(output.usage.prompt_tokens, 2);
  assert.equal(output.usage.completion_tokens, 3);
  assert.equal(client.body, wire);
});

test('Responses lifecycle followed by failed is rejected instead of completed', async (t) => {
  const { client, result } = await stream(t, ({ response }) => { response.emit('data', Buffer.from(frame({ type: 'response.created', response: { id: 'resp_x' } }) + frame({ type: 'response.failed', response: { id: 'resp_x', status: 'failed', error: { message: 'provider failed [502]' } } }))); response.emit('end'); }, RESPONSES);
  await assert.rejects(result, error => error.notStarted === true && error.status === 502);
  assert.equal(client.code, null);
});

test('Responses incomplete is a legitimate terminal, not a transport failure', async (t) => {
  const { client, result } = await stream(t, ({ response }) => { response.emit('data', Buffer.from(frame({ type: 'response.incomplete', response: { id: 'resp_x', status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 0 } } }))); response.emit('end'); }, RESPONSES);
  assert.equal((await result).ok, true);
  assert.ok(client.body.includes('response.incomplete'));
  assert.ok(!client.body.includes('response.completed'));
});

test('neutral upstream heartbeats cannot indefinitely postpone first-output deadline', { timeout: 3000 }, async (t) => {
  const { client, result, getRequest } = await stream(t, ({ response, cleanup }) => {
    const timer = setInterval(() => response.emit('data', Buffer.from(': ping\n\n')), 10);
    cleanup(() => { clearInterval(timer); response.emit('end'); });
  }, OPENAI, 1000);
  await assert.rejects(result, error => error.notStarted === true && error.status === 0);
  assert.equal(client.code, null);
  assert.equal(getRequest().destroyed, true);
});

test('lone carriage-return event endings are complete SSE frames at EOF', async (t) => {
  const wire = (chat({ content: 'answer' }) + chat({}, 'stop') + 'data: [DONE]\n\n').replaceAll('\n', '\r');
  const { result } = await stream(t, ({ response }) => { response.emit('data', Buffer.from(wire)); response.emit('end'); });
  assert.equal((await result).ok, true);
});

test('a failed translation cannot be accounted as a successful upstream stream', async (t) => {
  const dialect = withToolAliases(chatUpstreamDialect(RESPONSES), new Map([['alias', 'original']]));
  const { client, result } = await stream(t, ({ response }) => {
    response.emit('data', Buffer.from(chat({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }) + chat({}, 'tool_calls') + 'data: [DONE]\n\n'));
    response.emit('end');
  }, dialect);
  assert.ok(client.body === '' || !client.body.includes('response.completed'));
  assert.equal((await result).ok, false);
  assert.ok(client.body.includes('response.failed'));
});

test('role plus DONE without a finish reason stays retryable before client output', async (t) => {
  const { client, result } = await stream(t, ({ response }) => {
    response.emit('data', Buffer.from(chat({ role: 'assistant' }) + 'data: [DONE]\n\n'));
    response.emit('end');
  }, chatUpstreamDialect(RESPONSES));
  await assert.rejects(result, error => error.notStarted === true && error.status >= 500);
  assert.equal(client.code, null);
});

test('explicit non-JSON ping events do not truncate a valid reply', async (t) => {
  const { client, result } = await stream(t, ({ response }) => {
    response.emit('data', Buffer.from('event: ping\ndata: heartbeat\n\n' + chat({ content: 'answer' }) + 'event: ping\ndata: alive\n\n' + chat({}, 'stop') + 'data: [DONE]\n\n'));
    response.emit('end');
  });
  assert.equal((await result).ok, true);
  assert.ok(client.body.includes('answer'));
});

for (const opened of [false, true]) {
  test(`invalid UTF-8 cannot be silently replaced in a completed reply, opened=${opened}`, async (t) => {
    const { client, result } = await stream(t, ({ response }) => {
      if (opened) response.emit('data', Buffer.from(chat({ content: 'first' })));
      response.emit('data', Buffer.concat([Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"'), Buffer.from([0xff]), Buffer.from('"},"finish_reason":null}]}\n\n' + chat({}, 'stop') + 'data: [DONE]\n\n')]));
      response.emit('end');
    }, chatUpstreamDialect(RESPONSES));
    if (opened) {
      assert.equal((await result).ok, false);
      assert.ok(client.body.includes('response.failed'));
      assert.ok(!client.body.includes('response.completed'));
    } else {
      await assert.rejects(result, error => error.notStarted === true && error.status >= 500);
      assert.equal(client.code, null);
    }
    assert.ok(!client.body.includes('\uFFFD'));
  });
}

test('stream interruption logs redact configured secrets before reaching the logger', async (t) => {
  const apiKey = 'private-config-key';
  const token = 'private-subscription-value';
  const { result, logs } = await stream(t, ({ response }) => {
    response.emit('data', Buffer.from(chat({ content: 'partial' })));
    response.emit('data', Buffer.from(frame({ error: { message: `provider failed ${apiKey} ${token} https://subscription.invalid/?token=${token}` } })));
    response.emit('end');
  }, OPENAI, 5000, { config: { apiKey, subscriptionUrl: `https://subscription.invalid/?token=${token}` } });
  assert.equal((await result).ok, false);
  assert.ok(logs.some(line => line.includes('provider failed')));
  for (const secret of [apiKey, token, 'subscription.invalid']) assert.ok(!logs.join('\n').includes(secret));
});

test('buffered Anthropic replies preserve authoritative input, cache and reasoning usage', async (t) => {
  const usage = { prompt_tokens: 321, completion_tokens: 11, total_tokens: 332, prompt_tokens_details: { cached_tokens: 7 }, completion_tokens_details: { reasoning_tokens: 3 } };
  const { client, result } = await stream(t, ({ response }) => {
    response.emit('data', Buffer.from(chat({ content: 'answer' }) + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }) + 'data: [DONE]\n\n'));
    response.emit('end');
  }, ANTHROPIC, 5000, { buffered: true });
  const parsed = await result;
  assert.equal(parsed.usage.prompt_tokens, 321);
  assert.equal(parsed.usage.completion_tokens, 11);
  assert.equal(parsed.usage.prompt_tokens_details.cached_tokens, 7);
  assert.equal(parsed.usage.completion_tokens_details.reasoning_tokens, 3);
  ANTHROPIC.respond(client, parsed, 'boundary-free');
  const publicReply = JSON.parse(client.body);
  assert.equal(publicReply.usage.input_tokens, 321);
  assert.equal(publicReply.usage.output_tokens, 11);
});

test('malformed initial tool delta cannot commit HTTP 200 before validation', async (t) => {
  const { client, result } = await stream(t, ({ response }) => {
    response.emit('data', Buffer.from(chat({ tool_calls: [{ id: 'call_invalid', type: 'function', function: { name: 'read', arguments: '{}' } }] })));
    response.emit('end');
  }, chatUpstreamDialect(RESPONSES));
  await assert.rejects(result, error => error.notStarted === true && error.status >= 500);
  assert.equal(client.code, null);
  assert.equal(client.body, '');
});

for (const buffered of [false, true]) {
  test(`fragmented tool aliases stay declared at the Responses client boundary, buffered=${buffered}`, async (t) => {
    const dialect = withToolAliases(chatUpstreamDialect(RESPONSES), new Map([['read_client', 'read']]));
    const { client, result } = await stream(t, ({ response }) => {
      response.emit('data', Buffer.from(chat({ tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read_', arguments: '{' } }] })));
      response.emit('data', Buffer.from(chat({ tool_calls: [{ index: 0, function: { name: 'client', arguments: '"path":"x"}' } }] })));
      response.emit('data', Buffer.from(chat({}, 'tool_calls') + 'data: [DONE]\n\n'));
      response.emit('end');
    }, dialect, 5000, { buffered });
    const parsed = await result;
    if (buffered) {
      dialect.respond(client, parsed, 'boundary-free');
      assert.equal(JSON.parse(client.body).output[0].name, 'read');
    } else {
      assert.equal(parsed.ok, true);
      const events = client.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
      for (const event of events.filter(event => event.item?.type === 'function_call')) assert.equal(event.item.name, 'read');
      assert.equal(events.find(event => event.type === 'response.completed').response.output[0].name, 'read');
    }
    assert.ok(!client.body.includes('read_client'));
    const final = buffered ? JSON.parse(client.body) : dialect.collect(client.body);
    assert.equal(final.output[0].call_id, 'call_read');
    assert.equal(final.output[0].arguments, '{"path":"x"}');
  });
}
