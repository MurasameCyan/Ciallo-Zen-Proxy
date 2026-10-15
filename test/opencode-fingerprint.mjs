import assert from 'node:assert/strict';

import {
  OPENCODE_FINGERPRINT_TOOLS,
  aliasSseSink,
  applyFingerprintTools,
  restoreToolNames,
} from '../server/opencode-fingerprint.mjs';

const flat = (names) => names.map((name) => ({
  type: 'function',
  name,
  description: 'caller tool',
  parameters: { type: 'object', properties: {} },
}));
const chat = (names) => names.map((name) => ({
  type: 'function',
  function: { name, description: 'caller tool', parameters: { type: 'object', properties: {} } },
}));
const namesOf = (tools) => tools.map((tool) => tool.name ?? tool.function?.name);

{
  const body = { tools: flat(['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'WebFetch']) };
  const map = applyFingerprintTools(body, true);
  assert.deepEqual(namesOf(body.tools), [
    'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'WebFetch',
    ...OPENCODE_FINGERPRINT_TOOLS,
  ]);
  assert.equal(map.size, 0, 'case variants are caller tools, not fingerprint aliases');
  const read = body.tools.find((tool) => tool.name === 'read');
  const shell = body.tools.find((tool) => tool.name === 'shell');
  assert.match(read.description, /^Read the contents of a file or directory\./);
  assert.deepEqual(read.parameters.required, ['path']);
  assert.match(shell.description, /^Execute a shell command and return its output\./);
  assert.deepEqual(shell.parameters.required, ['command']);
  assert.equal(shell.strict, false);
  assert.equal(body.tool_choice, 'auto');
}

{
  const responsesNone = { tools: [], tool_choice: 'none' };
  applyFingerprintTools(responsesNone, true);
  assert.equal(responsesNone.tool_choice, 'auto', 'Responses v2 cannot carry tool_choice=none');

  const anthropicNone = { tools: [], tool_choice: { type: 'none' } };
  applyFingerprintTools(anthropicNone, false);
  assert.equal(anthropicNone.tool_choice, undefined, 'Chat v2 must remove object-form tool_choice=none');
}

{
  const canonicalChat = { tools: [] };
  applyFingerprintTools(canonicalChat, false);
  const nestedRead = JSON.parse(JSON.stringify(canonicalChat.tools.find((tool) => tool.function?.name === 'read')));
  const responsesBody = { tools: [nestedRead] };
  const responsesMap = applyFingerprintTools(responsesBody, true);
  assert.equal(responsesMap.get('read_client'), 'read', 'nested Chat definition must not satisfy Responses fingerprint');
  assert.deepEqual(namesOf(responsesBody.tools), ['read_client', 'read', 'shell']);

  const canonicalResponses = { tools: [] };
  applyFingerprintTools(canonicalResponses, true);
  const flatRead = JSON.parse(JSON.stringify(canonicalResponses.tools.find((tool) => tool.name === 'read')));
  const chatBody = { tools: [flatRead] };
  const chatMap = applyFingerprintTools(chatBody, false);
  assert.equal(chatMap.get('read_client'), 'read', 'flat Responses definition must not satisfy Chat fingerprint');
  assert.deepEqual(namesOf(chatBody.tools), ['read_client', 'read', 'shell']);
}
{
  const canonical = { tools: [] };
  applyFingerprintTools(canonical, false);
  const noncanonical = JSON.parse(JSON.stringify(canonical.tools.find((tool) => tool.function?.name === 'read')));
  noncanonical.function.strict = false;
  const body = { tools: [noncanonical] };
  const map = applyFingerprintTools(body, false);
  assert.equal(map.get('read_client'), 'read', 'nested strict field must make a definition noncanonical');
  assert.deepEqual(namesOf(body.tools), ['read_client', 'read', 'shell']);
}

{
  const canonical = { tools: [] };
  applyFingerprintTools(canonical, false);
  const exact = JSON.parse(JSON.stringify(canonical.tools.find((tool) => tool.function?.name === 'read')));
  const caller = JSON.parse(JSON.stringify(exact));
  caller.function.description = 'caller-owned read';
  const body = { tools: [exact, caller] };
  const map = applyFingerprintTools(body, false);
  assert.equal(map.get('read_client'), 'read', 'a later caller tool must not be dropped after the fingerprint tool');
  assert.deepEqual(namesOf(body.tools), ['read', 'read_client', 'shell']);
}


{
  const body = { messages: [{ role: 'user', content: 'hi' }], tools: chat(['Edit']) };
  applyFingerprintTools(body, false);
  assert.deepEqual(namesOf(body.tools), ['Edit', 'read', 'shell']);
  assert.equal(body.tool_choice, undefined, 'chat must not send tool_choice=none');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /^Do not call the `read` or `shell` tools;/);
}

{
  const body = {
    tools: flat(['read', 'read_client', 'Edit']),
    messages: [{
      role: 'assistant',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    }],
    tool_choice: { type: 'function', name: 'read' },
  };
  const map = applyFingerprintTools(body, true);
  assert.deepEqual(namesOf(body.tools), ['read_client2', 'read_client', 'Edit', 'read', 'shell']);
  assert.equal(map.get('read_client2'), 'read');
  assert.equal(body.messages[0].tool_calls[0].function.name, 'read_client2');
  assert.equal(body.tool_choice.name, 'read_client2');

  const restored = restoreToolNames({
    choices: [{ delta: { tool_calls: [{ function: { name: 'read_client2' } }] } }],
    output: [{ type: 'function_call', name: 'read_client2' }],
    item: { type: 'function_call', name: 'read_client2' },
  }, map);
  assert.equal(restored.choices[0].delta.tool_calls[0].function.name, 'read');
  assert.equal(restored.output[0].name, 'read');
  assert.equal(restored.item.name, 'read');
}

{
  const body = { tools: flat(['shell']) };
  const map = applyFingerprintTools(body, true);
  assert.equal(map.get('shell_client'), 'shell');
  const restored = restoreToolNames({
    type: 'content_block_start',
    content_block: { type: 'tool_use', name: 'shell_client' },
  }, map);
  assert.equal(restored.content_block.name, 'shell');
}

{
  const body = { tools: flat(['shell']) };
  const map = applyFingerprintTools(body, true);
  const chunks = [];
  const sink = aliasSseSink({
    write: (chunk) => chunks.push(String(chunk)),
    end: () => {},
    fail: () => {},
  }, map);
  const frame = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: 'shell_client' } }] } }] })}\n\n`;
  const split = frame.indexOf('shell_client') + 3;
  sink.write(frame.slice(0, split));
  sink.write(frame.slice(split));
  sink.end();
  const data = chunks.find((chunk) => chunk.startsWith('data: '));
  assert.equal(JSON.parse(data.slice(6)).choices[0].delta.tool_calls[0].function.name, 'shell');
}

console.log('opencode fingerprint tests: ok');
