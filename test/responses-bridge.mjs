import assert from 'node:assert/strict';
import test from 'node:test';
import * as dialects from '../server/dialects.mjs';
import { anthropicToOpenAI } from '../server/anthropic.mjs';
import { inspectSseFrame } from '../server/sse.mjs';

function bridge() {
  return dialects.chatUpstreamDialect(dialects.RESPONSES);
}
function capture(dialect = bridge()) {
  let text = '';
  let ended = 0;
  const sink = dialect.sink({ write: (chunk) => { text += chunk; }, end: () => { ended++; } }, 'client-model');
  return {
    sink,
    feed: (obj) => sink.write(`data: ${JSON.stringify(obj)}\n\n`),
    events: () => text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))),
    text: () => text,
    ended: () => ended,
  };
}
const chunk = (delta, finish_reason = null) => ({ id: 'chatcmpl-upstream', model: 'upstream-model', created: 123, choices: [{ index: 0, delta, finish_reason }] });
const terminal = (c) => c.events().find((event) => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type));

test('Responses request maps roles, consecutive and parallel tool calls, summaries and generation controls', () => {
  const d = bridge();
  const body = {
    model: 'client-model', instructions: 'be precise', stream: false,
    input: [
      { role: 'developer', content: 'policy' },
      { role: 'user', content: [{ type: 'input_text', text: 'inspect' }, { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'high' }, { type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,AQID' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'compare both' }] },
      { type: 'function_call', call_id: 'a', name: 'left', arguments: '{"x":1}' },
      { type: 'function_call', call_id: 'b', name: 'right', arguments: '{}' },
      { type: 'function_call_output', call_id: 'b', output: 'right result' },
      { type: 'function_call_output', call_id: 'a', output: 'left result' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'compared' }] },
    ],
    max_output_tokens: 125, temperature: 0.3, top_p: 0.7, parallel_tool_calls: false,
    reasoning: { effort: 'high' },
    tools: [{ type: 'function', name: 'left', description: 'L', parameters: { type: 'object' }, strict: true }],
    tool_choice: { type: 'function', name: 'left' },
    text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } },
  };
  assert.equal(d.validate(body), null);
  assert.equal(d.path, dialects.CHAT_PATH);
  const out = d.toUpstream(body);
  assert.equal(out.model, body.model);
  assert.deepEqual(out.messages.slice(0, 2), [{ role: 'system', content: 'be precise' }, { role: 'developer', content: 'policy' }]);
  assert.deepEqual(out.messages[2].content, [{ type: 'text', text: 'inspect' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } }, { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,AQID' } }]);
  assert.equal(out.messages[3].reasoning_content, 'compare both');
  assert.deepEqual(out.messages[3].tool_calls.map((call) => call.id), ['a', 'b']);
  assert.deepEqual(out.messages.slice(4, 6).map((message) => [message.tool_call_id, message.content]), [['b', 'right result'], ['a', 'left result']]);
  assert.equal(out.messages[6].content[0].text, 'compared');
  assert.equal(out.max_completion_tokens, 125);
  assert.equal(out.temperature, 0.3);
  assert.equal(out.top_p, 0.7);
  assert.equal(out.parallel_tool_calls, false);
  assert.deepEqual(out.tools[0].function, { name: 'left', description: 'L', parameters: { type: 'object' }, strict: true });
  assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'left' } });
  assert.deepEqual(out.response_format, { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: true } });
  d.applyEffort(out, 'low');
  assert.equal(out.reasoning_effort, 'low');
  assert.equal(out.reasoning, undefined);
});

test('string input and JSON object format are native Chat requests', () => {
  const out = bridge().toUpstream({ model: 'm', input: 'hello', text: { format: { type: 'json_object' } } });
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(out.response_format, { type: 'json_object' });
});

test('unrepresentable Responses state and tools fail validation before conversion', () => {
  const d = bridge();
  for (const extra of [
    { previous_response_id: 'resp_previous' }, { conversation: 'conv_1' },
    { tools: [{ type: 'web_search_preview' }] }, { tool_choice: { type: 'web_search_preview' } },
    { input: [{ type: 'item_reference', id: 'item_1' }] },
    { input: [{ type: 'reasoning', encrypted_content: 'opaque', summary: [] }] },
    { input: [{ role: 'user', content: [{ type: 'input_audio', data: 'AQID' }] }] },
  ]) {
    const request = { input: 'hello', ...extra };
    assert.match(d.validate(request), /unsupported|cannot|not supported/i);
    assert.doesNotThrow(() => d.toUpstream(request), 'normal conversion must not escape into an unexplained 500');
  }
});

test('native Responses request behavior is not replaced by Chat conversion', () => {
  const body = { model: 'm', input: [{ type: 'item_reference', id: 'native' }], previous_response_id: 'resp_a', tools: [{ type: 'web_search_preview' }] };
  assert.equal(dialects.RESPONSES.toUpstream(body), body);
  assert.equal(dialects.RESPONSES.path, dialects.RESPONSES_PATH);
});

test('Chat tool images retain matching results and become ordered subsequent user input images', () => {
  const out = dialects.chatToResponsesBody({ model: 'm', messages: [
    { role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 'before' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }, { type: 'text', text: 'after' }] },
    { role: 'tool', tool_call_id: 'b', content: 'second' },
  ] });
  assert.equal(out.input[0].type, 'function_call_output');
  assert.equal(out.input[0].call_id, 'a');
  assert.equal(out.input[0].output, 'before\nafter');
  assert.equal(out.input[1].call_id, 'b');
  assert.equal(out.input[2].role, 'user');
  assert.deepEqual(out.input[2].content, [{ type: 'input_text', text: 'before' }, { type: 'input_image', image_url: 'https://example.com/a.png' }, { type: 'input_text', text: 'after' }]);
});

test('Anthropic nested tool images survive through native Responses conversion', () => {
  const chat = anthropicToOpenAI({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }, { type: 'text', text: 'screen' }] }] }] });
  const out = dialects.chatToResponsesBody(chat);
  assert.equal(out.input[0].call_id, 'a');
  assert.equal(out.input[0].output, 'screen');
  assert.equal(out.input[1].role, 'user');
  assert.deepEqual(out.input[1].content, [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }, { type: 'input_text', text: 'screen' }]);
});

test('Responses input and tool-result images downgrade only for explicitly text-only metadata', () => {
  const body = { input: [{ type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'before' }, { type: 'input_image', image_url: 'https://example.com/a.png' }] }] };
  const text = bridge().toUpstream(body, { inputModalities: ['text'] });
  assert.equal(text.messages[0].content, 'before\n[image attached]');
  assert.equal(text.messages.length, 1);
  const unknown = bridge().toUpstream(body, null);
  assert.equal(unknown.messages[1].content[1].image_url.url, 'https://example.com/a.png');
});

test('stream emits ordered Responses lifecycle, reasoning/text pairs, usage and buffered completion', () => {
  const c = capture();
  c.feed(chunk({ role: 'assistant', reasoning_content: 'think ' }));
  c.feed(chunk({ reasoning_content: 'carefully', content: '你好' }));
  c.feed(chunk({ content: ' world' }));
  c.feed(chunk({}, 'stop'));
  assert.equal(terminal(c), undefined, 'wait for trailing usage before final response');
  c.feed({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 4 } } });
  c.sink.end();
  const events = c.events();
  assert.deepEqual(events.slice(0, 2).map((e) => e.type), ['response.created', 'response.in_progress']);
  assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, i) => i));
  const response = terminal(c).response;
  assert.equal(response.status, 'completed');
  assert.equal(response.model, 'client-model');
  assert.equal(response.output[0].type, 'reasoning');
  assert.equal(response.output[0].summary[0].text, 'think carefully');
  assert.equal(response.output[1].content[0].text, '你好 world');
  assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 7, total_tokens: 17, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 4 } });
  for (const [index, item] of response.output.entries()) {
    const added = events.find((e) => e.type === 'response.output_item.added' && e.output_index === index);
    const done = events.find((e) => e.type === 'response.output_item.done' && e.output_index === index);
    assert.equal(added.item.id, item.id);
    assert.deepEqual(done.item, item);
  }
  assert(events.some((e) => e.type === 'response.reasoning_summary_text.done' && e.text === 'think carefully'));
  assert(events.some((e) => e.type === 'response.output_text.done' && e.text === '你好 world'));
  assert.deepEqual(bridge().collect(c.text()), response);
  assert.equal(c.ended(), 1);
});

test('parallel tool arguments stream immediately with stable call identities and output indices', () => {
  const c = capture();
  c.feed(chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'right', arguments: '{"b":' } }, { index: 0, id: 'call_a', type: 'function', function: { name: 'left', arguments: '{' } }] }));
  assert.equal(c.events().filter((e) => e.type === 'response.function_call_arguments.delta').length, 2);
  c.feed(chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }, { index: 1, function: { arguments: '2}' } }] }));
  c.feed(chunk({}, 'tool_calls'));
  c.sink.end();
  const events = c.events();
  const response = terminal(c).response;
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.output.map((i) => [i.call_id, i.name, i.arguments]), [['call_b', 'right', '{"b":2}'], ['call_a', 'left', '{}']]);
  for (const [index, item] of response.output.entries()) {
    const deltas = events.filter((e) => e.type === 'response.function_call_arguments.delta' && e.output_index === index);
    assert(deltas.every((e) => e.item_id === item.id));
    assert.equal(deltas.map((e) => e.delta).join(''), item.arguments);
    assert(events.some((e) => e.type === 'response.function_call_arguments.done' && e.item_id === item.id && e.arguments === item.arguments));
  }
});

test('split UTF-8 SSE bytes do not corrupt Responses text', () => {
  const c = capture();
  const data = Buffer.from(`data: ${JSON.stringify(chunk({ content: '图片' }))}\n\n`);
  for (let i = 0; i < data.length; i++) c.sink.write(data.subarray(i, i + 1));
  c.feed(chunk({}, 'stop'));
  c.sink.end();
  assert.equal(terminal(c).response.output[0].content[0].text, '图片');
});

test('length and content_filter terminate incomplete, never completed', () => {
  for (const [finish, reason] of [['length', 'max_output_tokens'], ['content_filter', 'content_filter']]) {
    const c = capture();
    c.feed(chunk({ content: 'partial' }, finish));
    c.sink.end();
    assert.equal(terminal(c).type, 'response.incomplete');
    assert.equal(terminal(c).response.incomplete_details.reason, reason);
    assert(!c.events().some((e) => e.type === 'response.completed'));
    assert.equal(bridge().collect(c.text()).status, 'incomplete');
  }
});

test('truncated, malformed and explicitly failed Chat streams never become successful Responses', () => {
  for (const mode of ['truncated', 'malformed', 'upstream', 'transport', 'missing-call-id']) {
    const c = capture();
    c.feed(chunk({ content: 'partial' }));
    if (mode === 'malformed') { c.sink.write('data: {broken}\n\n'); c.feed(chunk({}, 'stop')); }
    if (mode === 'upstream') c.feed({ error: { message: 'upstream rejected', type: 'server_error' } });
    if (mode === 'missing-call-id') { c.feed(chunk({ tool_calls: [{ index: 0, function: { name: 'left', arguments: '{}' } }] })); c.feed(chunk({}, 'tool_calls')); }
    if (mode === 'transport') c.sink.fail('connection reset');
    else c.sink.end();
    assert.equal(terminal(c)?.type, 'response.failed', mode);
    assert.equal(terminal(c).response.status, 'failed');
    assert(terminal(c).response.error.message);
    assert(!c.events().some((e) => e.type === 'response.completed'), mode);
    assert.notEqual(bridge().collect(c.text())?.status, 'completed');
  }
});

test('tool aliases are restored at the Responses bridge boundary', () => {
  const c = capture(dialects.withToolAliases(bridge(), new Map([['alias_left', 'left']])));
  c.feed(chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'alias_left', arguments: '{}' } }] }));
  c.feed(chunk({}, 'tool_calls'));
  c.sink.end();
  assert.equal(terminal(c).response.output[0].name, 'left');
});

test('reasoning summaries attach to the following assistant message', () => {
  const out = bridge().toUpstream({ input: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'compared' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    { role: 'user', content: 'next' },
  ] });
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].reasoning_content, 'compared');
  assert.equal(out.messages[0].content[0].text, 'answer');
});

test('malformed top-level JSON requests are rejected without conversion exceptions', () => {
  const d = bridge();
  for (const request of [null, [], 1, 'hello']) {
    assert.equal(typeof d.validate(request), 'string');
    assert.doesNotThrow(() => d.toUpstream(request));
  }
});

test('complete multiline SSE events, CRLF and comments preserve content', () => {
  const c = capture();
  const obj = JSON.stringify(chunk({ content: 'multiline' }));
  const split = obj.indexOf(',') + 1;
  c.sink.write(`: keep-alive\r\ndata: ${obj.slice(0, split)}\r\ndata: ${obj.slice(split)}\r\n\r\n`);
  c.feed(chunk({}, 'stop'));
  c.sink.write('data: [DONE]\n\n');
  c.sink.end();
  assert.equal(terminal(c).response.output[0].content[0].text, 'multiline');
});

test('refusal is a real Responses refusal part with matching done events', () => {
  const c = capture();
  c.feed(chunk({ refusal: 'cannot ' }));
  c.feed(chunk({ refusal: 'answer' }, 'stop'));
  c.sink.end();
  assert.deepEqual(terminal(c).response.output[0].content, [{ type: 'refusal', refusal: 'cannot answer' }]);
  assert(c.events().some((event) => event.type === 'response.refusal.done' && event.refusal === 'cannot answer'));
});

test('a role-only EOF or DONE without a finish reason cannot complete', () => {
  for (const done of [false, true]) {
    const c = capture();
    c.feed(chunk({ role: 'assistant' }));
    if (done) c.sink.write('data: [DONE]\n\n');
    c.sink.end();
    assert.equal(terminal(c).type, 'response.failed');
  }
});

test('transport failure after a finish reason is still failure, not completion', () => {
  const c = capture();
  c.feed(chunk({ content: 'visible' }, 'stop'));
  c.sink.fail('connection reset after finish');
  assert.equal(terminal(c).type, 'response.failed');
  assert(!c.events().some((event) => event.type === 'response.completed'));
});

test('unsupported Chat visual output and malformed tool arguments are explicit failures', () => {
  for (const delta of [
    { content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
    { images: [{ url: 'https://example.com/a.png' }] },
    { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'left', arguments: {} } }] },
  ]) {
    const c = capture();
    c.feed(chunk(delta, 'stop'));
    c.sink.end();
    assert.equal(terminal(c).type, 'response.failed');
  }
});

test('native Responses-to-Chat failure never creates stop or DONE success markers', () => {
  const events = [];
  let done = 0;
  const stream = new dialects.ResponsesToChatStream({ model: 'm', emit: (event) => events.push(event), emitDone: () => { done++; } });
  stream.feed(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`);
  stream.fail('upstream failed');
  stream.end();
  assert.equal(done, 0);
  assert(!events.some((event) => event.choices?.some((choice) => choice.finish_reason)));
  assert.equal(events.at(-1).error.message, 'upstream failed');
});

test('text and refusal switches retain their original content order', () => {
  const c = capture();
  c.sink.write('event: ping\ndata: heartbeat\n\n');
  c.feed(chunk({ content: 'before' }));
  c.feed(chunk({ refusal: 'declined' }));
  c.feed(chunk({ content: 'after' }, 'stop'));
  c.sink.end();
  assert.deepEqual(terminal(c).response.output[0].content.map((part) => [part.type, part.text ?? part.refusal]), [
    ['output_text', 'before'], ['refusal', 'declined'], ['output_text', 'after'],
  ]);
});

test('native and converted failure sinks expose exactly one protocol error without normal completion', () => {
  for (const d of [dialects.OPENAI, dialects.RESPONSES, dialects.responsesUpstreamDialect(dialects.OPENAI)]) {
    const c = capture(d);
    c.sink.fail('upstream disconnected');
    const events = c.events();
    assert.equal(events.length, 1, d.name);
    assert.equal(events[0].error?.message ?? events[0].message, 'upstream disconnected');
    if (d === dialects.RESPONSES) assert.equal(events[0].type, 'error');
    assert(!c.text().includes('[DONE]'));
    assert.equal(c.ended(), 1);
  }
});

test('malformed choice values are protocol failures rather than process exceptions', () => {
  for (const choice of [null, 1, 'bad', []]) {
    const fact = inspectSseFrame(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
    assert.ok(fact.error?.status >= 500);
    assert.equal(fact.output, undefined);
  }
});

test('explicit text ping events are neutral and DONE cannot replace a real terminal', () => {
  assert.deepEqual(inspectSseFrame('event: ping\ndata: heartbeat\n\n'), { output: false, terminal: false });
  assert.equal(inspectSseFrame('data: [DONE]\n\n').terminal, false);
});

test('a malformed Chat choice produces a failed Responses object', () => {
  for (const choice of [null, 1, 'bad', [], true]) {
    const c = capture();
    c.feed({ choices: [choice] });
    assert.equal(c.sink.end(), false);
    assert.equal(terminal(c).type, 'response.failed');
    assert.equal(terminal(c).response.status, 'failed');
    assert(!c.events().some((event) => event.type === 'response.completed'));
  }
});

test('CR-only frames preserve text and tool aliases through the complete reverse bridge', () => {
  const c = capture(dialects.withToolAliases(bridge(), new Map([['alias_left', 'left']])));
  const wire = [chunk({ content: 'CR answer' }), chunk({ tool_calls: [{ index: 0, id: 'call_cr', type: 'function', function: { name: 'alias_left', arguments: '{}' } }] }), chunk({}, 'tool_calls')]
    .map(value => `data: ${JSON.stringify(value)}\r\r`).join('') + 'data: [DONE]\r\r';
  for (const byte of Buffer.from(wire)) c.sink.write(Buffer.from([byte]));
  c.sink.end();
  const final = terminal(c);
  assert.equal(final.type, 'response.completed');
  assert.equal(final.response.output[0].content[0].text, 'CR answer');
  assert.equal(final.response.output[1].name, 'left');
  assert.equal(final.response.output[1].call_id, 'call_cr');
  assert.equal(final.response.output[1].arguments, '{}');
});

test('multiline data restores read and shell aliases across fragmented SSE line endings', () => {
  for (const newline of ['\n', '\r', '\r\n']) {
    const c = capture(dialects.withToolAliases(bridge(), new Map([['read_client', 'read'], ['shell_client', 'shell']])));
    const payload = JSON.stringify(chunk({ tool_calls: [
      { index: 0, id: 'call_read', type: 'function', function: { name: 'read_client', arguments: '{"path":"x"}' } },
      { index: 1, id: 'call_shell', type: 'function', function: { name: 'shell_client', arguments: '{"command":"pwd"}' } },
    ] }));
    const split = payload.indexOf(',') + 1;
    const wire = `: keep-alive${newline}event: message${newline}data: ${payload.slice(0, split)}${newline}data: ${payload.slice(split)}${newline}${newline}`
      + `data: ${JSON.stringify(chunk({}, 'tool_calls'))}${newline}${newline}`;
    for (const byte of Buffer.from(wire)) c.sink.write(Buffer.from([byte]));
    assert.equal(c.sink.end(), true);
    assert.equal(terminal(c).type, 'response.completed');
    assert.deepEqual(terminal(c).response.output.map((item) => [item.call_id, item.name, item.arguments]), [
      ['call_read', 'read', '{"path":"x"}'], ['call_shell', 'shell', '{"command":"pwd"}'],
    ]);
  }
});

test('a final CR closes a complete Chat frame after fragmented CRLF lines', () => {
  const c = capture();
  const wire = `data: ${JSON.stringify(chunk({ content: 'final CR' }, 'stop'))}\r\n\r`;
  for (const byte of Buffer.from(wire)) c.sink.write(Buffer.from([byte]));
  assert.equal(c.sink.end(), true);
  assert.equal(terminal(c).type, 'response.completed');
  assert.equal(terminal(c).response.output[0].content[0].text, 'final CR');
});

test('alias restoration preserves non-data fields and the original complete frame boundary', () => {
  const c = capture(dialects.withToolAliases(dialects.OPENAI, new Map([['read_client', 'read']])));
  const payload = chunk({ tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read_client', arguments: '{}' } }] });
  const encoded = JSON.stringify(payload);
  const split = encoded.indexOf(',') + 1;
  const before = ': keep-alive\revent: message\rid: event-1\r';
  const after = 'retry: 1000\r\r';
  c.sink.write(`${before}data: ${encoded.slice(0, split)}\r${after.slice(0, -1)}data: ${encoded.slice(split)}\r\r`);
  c.sink.end();
  payload.choices[0].delta.tool_calls[0].function.name = 'read';
  assert.equal(c.text(), `${before}data: ${JSON.stringify(payload)}\r${after}`);
});

test('an unclosed aliased tail stays truncated and propagates the failed end result', () => {
  const c = capture(dialects.withToolAliases(bridge(), new Map([['alias_left', 'left']])));
  c.feed(chunk({ content: 'partial' }, 'stop'));
  c.sink.write('data: [DONE]\r');
  assert.equal(c.sink.end(), false);
  assert.equal(terminal(c).type, 'response.failed');
  assert.match(terminal(c).response.error.message, /Truncated/);
  assert(!c.events().some((event) => event.type === 'response.completed'));
});

test('bridge output replays a tool call followed by explanatory text as one assistant turn', () => {
  const c = capture();
  c.feed(chunk({ tool_calls: [{ index: 0, id: 'call_continue', type: 'function', function: { name: 'read', arguments: '{}' } }] }));
  c.feed(chunk({ content: 'Reading the file now.' }, 'tool_calls'));
  assert.equal(c.sink.end(), true);
  const previous = terminal(c).response.output;
  const next = bridge().toUpstream({ model: 'm', input: [
    ...previous, { type: 'function_call_output', call_id: 'call_continue', output: 'file contents' },
  ] });
  assert.deepEqual(next.messages.map(message => message.role), ['assistant', 'tool']);
  assert.equal(next.messages[0].tool_calls[0].id, 'call_continue');
  assert.equal(next.messages[0].content[0].text, 'Reading the file now.');
  assert.equal(next.messages[1].tool_call_id, 'call_continue');
});

test('fragmented function names restore request aliases only after complete assembly', () => {
  const c = capture(dialects.withToolAliases(bridge(), new Map([['read_client', 'read']])));
  c.feed(chunk({ tool_calls: [{ index: 0, id: 'call_fragment', type: 'function', function: { name: 'read_' } }] }));
  c.feed(chunk({ tool_calls: [{ index: 0, function: { name: 'client', arguments: '{}' } }] }));
  c.feed(chunk({}, 'tool_calls'));
  assert.equal(c.sink.end(), true);
  const final = terminal(c).response.output[0];
  assert.equal(final.name, 'read');
  assert.equal(final.arguments, '{}');
  for (const event of c.events().filter(event => event.item?.type === 'function_call')) {
    assert.equal(event.item.name, 'read', event.type);
  }
});

test('assistant replay coalesces text, reasoning and parallel calls without crossing role boundaries', () => {
  const out = bridge().toUpstream({ input: [
    { role: 'assistant', content: 'before' },
    { type: 'function_call', call_id: 'a', name: 'left', arguments: '{}' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'compare' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'after' }] },
    { type: 'function_call', call_id: 'b', name: 'right', arguments: '{}' },
    { type: 'function_call_output', call_id: 'a', output: 'left' },
    { type: 'function_call_output', call_id: 'b', output: 'right' },
    { role: 'assistant', content: 'result' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'new turn' },
    { role: 'system', content: 'boundary' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'new reasoning' }] },
    { role: 'assistant', content: 'last' },
  ] });
  assert.deepEqual(out.messages.map(message => message.role), ['assistant', 'tool', 'tool', 'assistant', 'user', 'assistant', 'system', 'assistant']);
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 'before' }, { type: 'text', text: 'after' }]);
  assert.equal(out.messages[0].reasoning_content, 'compare');
  assert.deepEqual(out.messages[0].tool_calls.map(call => call.id), ['a', 'b']);
  assert.equal(out.messages[3].content, 'result');
  assert.equal(out.messages[7].reasoning_content, 'new reasoning');
});

test('ambiguous alias names assemble with arguments while unrelated output remains incremental', () => {
  const aliases = new Map([['read_client', 'read'], ['read_client2', 'other_read']]);
  for (const newline of ['\n', '\r', '\r\n']) {
    const c = capture(dialects.withToolAliases(bridge(), aliases));
    const feed = value => {
      const wire = `data: ${JSON.stringify(value)}${newline}${newline}: keep-alive${newline}${newline}`;
      for (const byte of Buffer.from(wire)) c.sink.write(Buffer.from([byte]));
    };
    feed(chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read_', arguments: '{' } }] }));
    feed(chunk({ tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'read_client', arguments: '{"b":' } }] }));
    feed(chunk({ content: 'working' }));
    assert(c.events().some(event => event.type === 'response.output_text.delta' && event.delta === 'working'));
    assert(!c.events().some(event => event.item?.type === 'function_call'));
    feed(chunk({ tool_calls: [
      { index: 1, function: { name: '2', arguments: '2}' } },
      { index: 0, function: { name: 'client', arguments: '"a":' } },
    ] }));
    feed(chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, 'tool_calls'));
    const added = c.events().filter(event => event.type === 'response.output_item.added' && event.item.type === 'function_call');
    assert.deepEqual(added.map(event => [event.item.call_id, event.item.name]), [['a', 'read'], ['b', 'other_read']]);
    assert.equal(c.sink.end(), true);
    const calls = terminal(c).response.output.filter(item => item.type === 'function_call');
    assert.deepEqual(calls.map(item => [item.call_id, item.name, item.arguments]), [['a', 'read', '{"a":1}'], ['b', 'other_read', '{"b":2}']]);
    for (const item of calls) {
      assert.deepEqual(c.events().filter(event => event.type === 'response.function_call_arguments.delta' && event.item_id === item.id).map(event => event.delta), item.call_id === 'a' ? ['{', '"a":', '1}'] : ['{"b":', '2}']);
    }
    assert.deepEqual(bridge().collect(c.text()).output.filter(item => item.type === 'function_call').map(item => item.name), ['read', 'other_read']);
    for (const event of c.events().filter(event => event.item?.type === 'function_call')) {
      assert.equal(event.item.name, event.item.call_id === 'a' ? 'read' : 'other_read');
    }
  }
});

test('Chat tool shape validation agrees with the bridge and permits argument-only continuations', () => {
  const valid = { index: 0, id: 'call', type: 'function', function: { name: 'left', arguments: '{}' } };
  for (const call of [null, [], {}, { ...valid, index: -1 }, { ...valid, index: 0.5 }, { ...valid, index: '0' },
    { ...valid, id: 1 }, { ...valid, type: 'custom' }, { ...valid, function: [] },
    { ...valid, function: { name: 1 } }, { ...valid, function: { arguments: {} } }]) {
    const fact = inspectSseFrame(`data: ${JSON.stringify(chunk({ content: 'must not open', tool_calls: [call] }))}\n\n`);
    assert.ok(fact.error?.status >= 500, JSON.stringify(call));
    assert.equal(fact.output, undefined);
    const c = capture();
    c.feed(chunk({ tool_calls: [call] }));
    assert.equal(c.sink.end(), false);
    assert.equal(terminal(c).type, 'response.failed');
  }
  for (const tool_calls of [{}, 'invalid']) assert.ok(inspectSseFrame(`data: ${JSON.stringify(chunk({ tool_calls }))}\n\n`).error);
  assert.equal(inspectSseFrame(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }))}\n\n`).output, true);
  assert.equal(inspectSseFrame(`data: ${JSON.stringify(chunk({ function_call: { name: 'legacy', arguments: '{}' } }))}\n\n`).output, true);
});
