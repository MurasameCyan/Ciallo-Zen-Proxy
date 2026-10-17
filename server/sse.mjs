import { embeddedStatus } from './upstream-errors.mjs';

/** Buffer complete SSE frames. Incomplete lines never reach a downstream sink. */
export class SseFrames {
  constructor() {
    this.pending = '';
    this.cursor = 0;
    this.lineStart = 0;
  }

  feed(text, final = false) {
    this.pending += text;
    const frames = [];
    while (this.cursor < this.pending.length) {
      const char = this.pending[this.cursor];
      if (char !== '\n' && char !== '\r') { this.cursor++; continue; }
      if (char === '\r' && this.cursor + 1 === this.pending.length && !final) break;
      const blank = this.cursor === this.lineStart;
      const end = this.cursor + (char === '\r' && this.pending[this.cursor + 1] === '\n' ? 2 : 1);
      this.cursor = end;
      this.lineStart = end;
      if (!blank) continue;
      frames.push(this.pending.slice(0, end));
      this.pending = this.pending.slice(end);
      this.cursor = 0;
      this.lineStart = 0;
    }
    return frames;
  }

  get incomplete() { return this.pending.trim().length > 0; }
}

const text = value => typeof value === 'string' && value.length > 0;
const tool = value => value && (text(value.id) || text(value.name) || text(value.arguments)
  || text(value.function?.name) || text(value.function?.arguments));
const content = value => text(value) || (Array.isArray(value) && value.some(part => text(part?.text) || text(part?.refusal)));
const failure = error => {
  const supplied = Number(error?.status ?? error?.status_code ?? error?.code);
  const status = supplied >= 400 && supplied <= 599 ? supplied : embeddedStatus({ error });
  return { status, body: JSON.stringify({ error }) };
};

/** Shared with the Responses bridge so malformed tool deltas cannot open HTTP output. */
export function chatToolDeltaError(delta) {
  if (!Number.isInteger(delta?.index) || delta.index < 0) return 'Chat tool delta is missing its parallel call index';
  if (delta.id != null && typeof delta.id !== 'string') return 'Malformed Chat tool call identity';
  if (delta.type != null && delta.type !== 'function') return `Unsupported Chat tool type: ${delta.type}`;
  if (delta.function != null && (typeof delta.function !== 'object' || Array.isArray(delta.function))) return 'Malformed Chat function delta';
  if (delta.function?.name != null && typeof delta.function.name !== 'string') return 'Malformed Chat function name';
  if (delta.function?.arguments != null && typeof delta.function.arguments !== 'string') return 'Malformed Chat function arguments';
  return null;
}

/** Protocol facts, not bytes or HTTP headers, determine output and completion. */
export function inspectSseFrame(frame) {
  const data = [];
  let event = '';
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    else if (line.startsWith('event:')) event = line.slice(6).trim();
  }
  if (event === 'ping' || !data.length) return { output: false, terminal: false };
  const source = data.join('\n');
  if (source.trim() === '[DONE]') return { output: false, terminal: false };
  let payload;
  try { payload = JSON.parse(source); } catch {
    return { error: failure({ message: 'Invalid upstream SSE data' }) };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: failure({ message: 'Invalid upstream SSE event' }) };
  }
  const type = typeof payload.type === 'string' ? payload.type : event;
  const response = payload.response;
  let error = payload.error ?? response?.error;
  if (!error && (type === 'error' || type === 'response.failed' || response?.status === 'failed')) {
    error = { message: payload.message || 'Upstream response failed', code: payload.code };
  }
  if (error && (typeof error === 'string' || error.message || error.type || error.code)) return { error: failure(error) };
  let output = false;
  let terminal = false;
  for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
      return { error: failure({ message: 'Invalid upstream SSE choice' }) };
    }
    const delta = choice.delta ?? choice.message ?? {};
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return { error: failure({ message: 'Malformed Chat message delta' }) };
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls)) return { error: failure({ message: 'Malformed Chat tool_calls delta' }) };
      for (const call of delta.tool_calls) {
        const message = chatToolDeltaError(call);
        if (message) return { error: failure({ message }) };
      }
    }
    output ||= content(delta.content) || text(delta.reasoning_content) || text(delta.reasoning)
      || text(delta.refusal) || (Array.isArray(delta.tool_calls) && delta.tool_calls.some(tool)) || tool(delta.function_call);
    if (choice.finish_reason != null) {
      if (/error/i.test(String(choice.finish_reason))) return { error: failure({ message: String(choice.finish_reason) }) };
      terminal = true;
    }
  }
  if (type.startsWith('response.')) {
    output ||= type.endsWith('.delta') && text(payload.delta);
    if (type === 'response.output_item.added') {
      output ||= payload.item?.type === 'function_call' && tool(payload.item);
    }
    terminal ||= type === 'response.completed' || type === 'response.incomplete';
  } else if (type === 'content_block_delta') {
    const delta = payload.delta || {};
    output ||= text(delta.text) || text(delta.thinking) || text(delta.partial_json);
  } else if (type === 'content_block_start') {
    const block = payload.content_block || {};
    output ||= text(block.text) || text(block.thinking) || (block.type === 'tool_use' && tool(block));
  } else if (type === 'message_stop') terminal = true;
  return { output: !!output, terminal, usage: payload.usage || response?.usage || null };
}
