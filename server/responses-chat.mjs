import { randomUUID } from 'node:crypto';
import { SseFrames, chatToolDeltaError } from './sse.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.length > 0;
const uid = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const attachment = (part) => ['image_url', 'input_image', 'file', 'input_file'].includes(part?.type);

/** Tool APIs accept text results; visual context follows the complete parallel result group. */
export function splitToolContent(content) {
  if (!Array.isArray(content)) return { text: typeof content === 'string' ? content : JSON.stringify(content ?? ''), visual: [] };
  const text = content.flatMap((part) => typeof part === 'string' ? [part] : (typeof part?.text === 'string' ? [part.text] : []));
  return { text: text.join('\n'), visual: content.some(attachment) ? content : [] };
}

export function chatContentToResponses(content, textType) {
  if (typeof content === 'string') return content ? [{ type: textType, text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part === 'string') return [{ type: textType, text: part }];
    if (!object(part)) return [];
    if (typeof part.text === 'string') return [{ type: textType, text: part.text }];
    if (part.type === 'image_url') {
      const image = typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url;
      return [{ type: 'input_image', image_url: image?.url ?? '', ...(image?.detail ? { detail: image.detail } : {}) }];
    }
    if (part.type === 'file') return [{ type: 'input_file', ...part.file }];
    return [part];
  });
}

function contentError(content) {
  if (typeof content === 'string') return null;
  if (!Array.isArray(content)) return 'content must be a string or content array';
  for (const part of content) {
    if (!object(part)) return 'unsupported content part';
    if (['input_text', 'output_text', 'text'].includes(part.type) && typeof part.text === 'string') continue;
    if (part.type === 'refusal' && typeof part.refusal === 'string') continue;
    if (part.type === 'input_image') {
      if (!nonempty(part.image_url)) return 'input_image file references are not supported by a Chat upstream; supply image_url';
      continue;
    }
    if (part.type === 'input_file') {
      if (nonempty(part.file_data) || nonempty(part.file_id)) continue;
      return 'input_file requires file_data or file_id; file_url is not supported by a Chat upstream';
    }
    return `unsupported Responses content type: ${String(part.type)}`;
  }
  return null;
}

/** Return a client-visible error before any upstream request; conversion itself is total for JSON. */
export function validateResponsesForChat(body) {
  if (!object(body)) return 'Responses request must be an object';
  for (const field of ['previous_response_id', 'conversation', 'prompt', 'max_tool_calls']) {
    if (body[field] != null) return `${field} is not supported by a Chat upstream; supply complete input history`;
  }
  if (body.background === true || body.store === true) return 'server-side background/store state is not supported by a Chat upstream';
  if (body.truncation != null && body.truncation !== 'disabled') return 'automatic Responses truncation is not supported by a Chat upstream';
  if (body.include != null && (!Array.isArray(body.include) || body.include.some((field) => field !== 'message.output_text.logprobs'))) {
    return 'unsupported Responses include field for a Chat upstream';
  }
  if (body.instructions != null && typeof body.instructions !== 'string') return 'instructions must be a string for a Chat upstream';
  if (body.tools != null && !Array.isArray(body.tools)) return 'tools must be an array';
  for (const tool of body.tools ?? []) {
    if (tool?.type !== 'function') return `unsupported built-in tool for a Chat upstream: ${String(tool?.type)}`;
    if (!nonempty(tool.name)) return 'function tool name required';
  }
  const choice = body.tool_choice;
  if (choice != null && !(['auto', 'none', 'required'].includes(choice)
      || (object(choice) && choice.type === 'function' && nonempty(choice.name)))) {
    return 'unsupported tool_choice for a Chat upstream; use auto, none, required or a function name';
  }
  if (body.text?.format != null && !['text', 'json_object', 'json_schema'].includes(body.text.format?.type)) {
    return 'unsupported text.format for a Chat upstream';
  }
  if (typeof body.input === 'string') return body.input.trim() ? null : 'input required';
  if (!Array.isArray(body.input) || !body.input.length) return 'input required';
  for (const item of body.input) {
    if (!object(item)) return 'unsupported Responses input item';
    switch (item.type) {
      case 'function_call':
        if (!nonempty(item.call_id) || !nonempty(item.name) || typeof item.arguments !== 'string') return 'function_call requires call_id, name and string arguments';
        break;
      case 'function_call_output': {
        if (!nonempty(item.call_id)) return 'function_call_output requires call_id';
        const error = contentError(item.output);
        if (error) return `function_call_output: ${error}`;
        break;
      }
      case 'reasoning':
        if (item.encrypted_content) return 'encrypted reasoning state is not supported by a Chat upstream';
        if (!Array.isArray(item.summary) || item.summary.some((part) => part?.type !== 'summary_text' || typeof part.text !== 'string')) return 'unsupported reasoning summary';
        if (item.content != null && (!Array.isArray(item.content) || item.content.some((part) => part?.type !== 'reasoning_text' || typeof part.text !== 'string'))) return 'unsupported reasoning content';
        break;
      case undefined:
      case 'message': {
        if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) return 'unsupported Responses message role';
        const error = contentError(item.content);
        if (error) return error;
        if (item.role !== 'user' && Array.isArray(item.content) && item.content.some((part) => ['input_image', 'input_file'].includes(part.type))) return 'attachments are not supported in non-user Chat messages';
        break;
      }
      default: return `unsupported Responses input item: ${String(item.type)}`;
    }
  }
  return null;
}

function toChatContent(content, textOnly) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!object(part)) return [];
    if (['input_text', 'output_text', 'text'].includes(part.type)) return [{ type: 'text', text: part.text }];
    if (part.type === 'refusal') return [{ type: 'text', text: part.refusal }];
    if (part.type === 'input_image') return textOnly
      ? [{ type: 'text', text: '[image attached]' }]
      : [{ type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } }];
    if (part.type === 'input_file') {
      if (textOnly) return [{ type: 'text', text: '[document attached]' }];
      const { type, ...file } = part;
      return [{ type: 'file', file }];
    }
    return [part];
  });
}

export function responsesToChatBody(body, meta) {
  const src = object(body) ? body : {};
  const textOnly = Array.isArray(meta?.inputModalities) && meta.inputModalities.length > 0
    && meta.inputModalities.every((mode) => String(mode).toLowerCase() === 'text');
  const messages = [];
  const visuals = [];
  const flushVisuals = () => { if (visuals.length) messages.push({ role: 'user', content: visuals.splice(0) }); };
  if (typeof src.instructions === 'string' && src.instructions) messages.push({ role: 'system', content: src.instructions });
  const input = typeof src.input === 'string' ? [{ role: 'user', content: src.input }] : (Array.isArray(src.input) ? src.input : []);
  let assistant = null;
  const ensureAssistant = () => {
    if (!assistant) { assistant = { role: 'assistant', content: null }; messages.push(assistant); }
    return assistant;
  };
  for (const item of input) {
    if (!object(item)) continue;
    if (item.type !== 'function_call_output') flushVisuals();
    if (item.type === 'function_call') {
      const message = ensureAssistant();
      message.tool_calls ??= [];
      message.tool_calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) } });
    } else if (item.type === 'reasoning') {
      const summary = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]
        .flatMap((part) => typeof part?.text === 'string' ? [part.text] : []).join('\n');
      if (summary) {
        const message = ensureAssistant();
        message.reasoning_content = [message.reasoning_content, summary].filter(Boolean).join('\n');
      }
    } else if (item.type === 'function_call_output') {
      assistant = null;
      const result = splitToolContent(toChatContent(item.output, textOnly));
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: result.text });
      visuals.push(...result.visual);
    } else if (['system', 'developer', 'user', 'assistant'].includes(item.role)) {
      const content = toChatContent(item.content, textOnly);
      if (item.role === 'assistant') {
        const message = ensureAssistant();
        if (message.content === null) message.content = content;
        else if (typeof message.content === 'string' && typeof content === 'string') message.content += content;
        else {
          const parts = value => typeof value === 'string' ? [{ type: 'text', text: value }] : value;
          message.content = [...parts(message.content), ...parts(content)];
        }
      } else {
        messages.push({ role: item.role, content });
        assistant = null;
      }
    }
  }
  flushVisuals();
  const out = { model: src.model, messages, stream: src.stream === true };
  if (src.max_output_tokens != null) out.max_completion_tokens = src.max_output_tokens;
  for (const field of ['temperature', 'top_p', 'parallel_tool_calls', 'service_tier', 'metadata', 'user', 'safety_identifier', 'prompt_cache_key', 'top_logprobs']) {
    if (src[field] != null) out[field] = src[field];
  }
  if (src.reasoning?.effort != null) out.reasoning_effort = src.reasoning.effort;
  if (Array.isArray(src.include) && src.include.includes('message.output_text.logprobs')) out.logprobs = true;
  if (Array.isArray(src.tools)) out.tools = src.tools.filter((tool) => tool?.type === 'function').map(({ type, ...fn }) => ({ type: 'function', function: fn }));
  if (typeof src.tool_choice === 'string') out.tool_choice = src.tool_choice;
  else if (src.tool_choice?.type === 'function') out.tool_choice = { type: 'function', function: { name: src.tool_choice.name } };
  const format = src.text?.format;
  if (format?.type === 'json_object') out.response_format = { type: 'json_object' };
  if (format?.type === 'json_schema') { const { type, ...schema } = format; out.response_format = { type: 'json_schema', json_schema: schema }; }
  if (src.text?.verbosity != null) out.verbosity = src.text.verbosity;
  return out;
}

function responseUsage(usage) {
  if (!usage) return null;
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    input_tokens: input, output_tokens: output, total_tokens: usage.total_tokens ?? input + output,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0 },
  };
}

/** Incremental Chat SSE -> Responses SSE, never deriving success from EOF alone. */
export class ChatToResponsesStream {
  constructor({ model = '', emit, aliases = null }) {
    this.model = model;
    this.emit = emit;
    this.id = uid('resp');
    this.created = Math.floor(Date.now() / 1000);
    this.sequence = 0;
    this.started = false;
    this.ended = false;
    this.failed = false;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.frames = new SseFrames();
    this.event = '';
    this.output = [];
    this.calls = new Map();
    this.aliases = aliases;
    this.message = null;
    this.reasoning = null;
    this.finish = null;
    this.usage = null;
    this.sawDone = false;
  }

  send(type, data = {}) { this.emit(type, { type, sequence_number: this.sequence++, ...data }); }

  response(status, error = null, incomplete = null) {
    return {
      id: this.id, object: 'response', created_at: this.created, model: this.model,
      status, error, incomplete_details: incomplete, output: this.output,
      usage: responseUsage(this.usage),
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.send('response.created', { response: this.response('in_progress') });
    this.send('response.in_progress', { response: this.response('in_progress') });
  }

  add(item) {
    this.start();
    const index = this.output.length;
    this.output.push(item);
    this.send('response.output_item.added', { output_index: index, item: structuredClone(item) });
    return index;
  }

  text(delta, refusal = false, logprobs = []) {
    if (!delta) return;
    if (!this.message) {
      const item = { id: uid('msg'), type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      this.message = { item, index: this.add(item) };
    }
    const { item, index } = this.message;
    const type = refusal ? 'refusal' : 'output_text';
    let contentIndex = item.content.at(-1)?.type === type ? item.content.length - 1 : -1;
    if (contentIndex < 0) {
      const part = refusal ? { type, refusal: '' } : { type, text: '', annotations: [], logprobs: [] };
      contentIndex = item.content.push(part) - 1;
      this.send('response.content_part.added', { item_id: item.id, output_index: index, content_index: contentIndex, part: structuredClone(part) });
    }
    const part = item.content[contentIndex];
    part[refusal ? 'refusal' : 'text'] += delta;
    if (!refusal && Array.isArray(logprobs)) part.logprobs.push(...logprobs);
    this.send(`response.${type}.delta`, { item_id: item.id, output_index: index, content_index: contentIndex, delta, ...(!refusal ? { logprobs } : {}) });
  }

  think(delta) {
    if (!delta) return;
    if (!this.reasoning) {
      const item = { id: uid('rs'), type: 'reasoning', status: 'in_progress', summary: [] };
      this.reasoning = { item, index: this.add(item) };
      const part = { type: 'summary_text', text: '' };
      item.summary.push(part);
      this.send('response.reasoning_summary_part.added', { item_id: item.id, output_index: this.reasoning.index, summary_index: 0, part: { ...part } });
    }
    const { item, index } = this.reasoning;
    item.summary[0].text += delta;
    this.send('response.reasoning_summary_text.delta', { item_id: item.id, output_index: index, summary_index: 0, delta });
  }

  tool(delta) {
    const error = chatToolDeltaError(delta);
    if (error) return this.fail(error);
    let call = this.calls.get(delta.index);
    if (!call) {
      call = { item: { id: uid('fc'), type: 'function_call', status: 'in_progress', call_id: '', name: '', arguments: '' }, index: null, name: '', pending: [] };
      this.calls.set(delta.index, call);
    }
    const item = call.item;
    if (delta.id) {
      if (item.call_id && item.call_id !== delta.id) return this.fail('Chat tool call identity changed during streaming');
      item.call_id = delta.id;
    }
    if (typeof delta.function?.name === 'string') call.name += delta.function.name;
    if (typeof delta.function?.arguments === 'string' && delta.function.arguments) call.pending.push(delta.function.arguments);
    this.publishTool(call);
  }

  publishTool(call, final = false) {
    const item = call.item;
    if (call.index === null) {
      if (!item.call_id || !call.name) return;
      // A name fragment may contain arguments and still prefix several aliases.
      // Only a finish reason proves these names complete; unrelated output streams on.
      if (!final && this.aliases) {
        for (const alias of this.aliases.keys()) if (alias.startsWith(call.name)) return;
      }
      item.name = this.aliases?.get(call.name) ?? call.name;
      call.index = this.add(item);
    } else item.name = this.aliases?.get(call.name) ?? call.name;
    for (const args of call.pending) {
      item.arguments += args;
      this.send('response.function_call_arguments.delta', { item_id: item.id, output_index: call.index, delta: args });
    }
    call.pending.length = 0;
  }

  handle(payload) {
    if (this.ended) return;
    if (this.event === 'ping') return;
    if (payload === '[DONE]') { this.sawDone = true; return; }
    if (this.sawDone) return this.fail('Chat data arrived after [DONE]');
    let obj;
    try { obj = JSON.parse(payload); } catch { return this.fail('Malformed Chat SSE data'); }
    if (obj?.error || this.event === 'error') return this.fail(obj?.error?.message || obj?.message || 'Chat upstream returned an error');
    if (obj?.type === 'ping') return;
    if (!object(obj) || !Array.isArray(obj.choices)) return this.fail('Unsupported Chat stream event');
    this.start();
    if (obj.usage) this.usage = obj.usage;
    for (const choice of obj.choices) {
      if (!object(choice)) return this.fail('Malformed Chat choice');
      if (choice?.index != null && choice.index !== 0) return this.fail('Multiple Chat output choices are not supported by the Responses bridge');
      const delta = choice?.delta ?? choice?.message ?? {};
      if (!object(delta)) return this.fail('Malformed Chat message delta');
      if (delta.audio != null || delta.images != null || delta.image != null) return this.fail('Unsupported Chat visual/audio output; no content was discarded');
      if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) return this.fail('Malformed Chat tool_calls delta');
      if (delta.refusal != null && typeof delta.refusal !== 'string') return this.fail('Malformed Chat refusal delta');
      if (this.finish && (delta.content || delta.reasoning_content || delta.reasoning || delta.refusal || delta.tool_calls?.length)) return this.fail('Chat output arrived after its finish reason');
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string') this.think(reasoning);
      else if (reasoning != null) return this.fail('Unsupported Chat reasoning payload');
      if (typeof delta.content === 'string') this.text(delta.content, false, choice.logprobs?.content ?? []);
      else if (Array.isArray(delta.content)) {
        for (const part of delta.content) {
          if (part?.type === 'text' && typeof part.text === 'string') this.text(part.text);
          else return this.fail('Unsupported Chat output content; no visual output was discarded');
        }
      } else if (delta.content != null) return this.fail('Unsupported Chat output content');
      if (typeof delta.refusal === 'string') this.text(delta.refusal, true);
      for (const tool of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        this.tool(tool);
        if (this.ended) return;
      }
      if (delta.function_call != null) return this.fail('Legacy Chat function_call is not supported; use tool_calls');
      if (choice.finish_reason != null) {
        if (!['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason)) return this.fail(`Unsupported Chat finish reason: ${String(choice.finish_reason)}`);
        if (this.finish && this.finish !== choice.finish_reason) return this.fail('Conflicting Chat finish reasons');
        this.finish = choice.finish_reason;
        for (const call of this.calls.values()) this.publishTool(call, true);
      }
    }
  }

  frame(frame) {
    const data = [];
    this.event = '';
    for (const line of frame.split(/\r\n|\r|\n/)) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      if (field === 'event') this.event = value;
    }
    if (data.length) this.handle(data.join('\n'));
  }

  feed(chunk) {
    if (this.ended) return;
    let text;
    try {
      text = this.decoder.decode(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk)), { stream: true });
    } catch { return this.fail('Invalid UTF-8 in Chat stream'); }
    for (const frame of this.frames.feed(text)) this.frame(frame);
  }

  closeItems(status) {
    for (const [index, item] of this.output.entries()) {
      item.status = status;
      if (item.type === 'message') {
        for (const [contentIndex, part] of item.content.entries()) {
          const refusal = part.type === 'refusal';
          this.send(`response.${part.type}.done`, { item_id: item.id, output_index: index, content_index: contentIndex, [refusal ? 'refusal' : 'text']: part[refusal ? 'refusal' : 'text'], ...(!refusal ? { logprobs: part.logprobs } : {}) });
          this.send('response.content_part.done', { item_id: item.id, output_index: index, content_index: contentIndex, part: structuredClone(part) });
        }
      } else if (item.type === 'reasoning') {
        const part = item.summary[0];
        this.send('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text: part.text });
        this.send('response.reasoning_summary_part.done', { item_id: item.id, output_index: index, summary_index: 0, part: { ...part } });
      } else if (item.type === 'function_call') {
        this.send('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments, name: item.name });
      }
      this.send('response.output_item.done', { output_index: index, item: structuredClone(item) });
    }
  }

  end() {
    if (this.ended) return;
    let tail;
    try { tail = this.decoder.decode(); } catch { return this.fail('Truncated UTF-8 in Chat stream'); }
    for (const frame of this.frames.feed(tail, true)) this.frame(frame);
    if (this.ended) return;
    if (this.frames.incomplete) return this.fail('Truncated Chat SSE event');
    if (!this.finish) return this.fail('Chat stream ended without a finish reason');
    for (const call of this.calls.values()) {
      if (!call.item.call_id || !call.item.name || call.index === null) return this.fail('Chat tool call ended without its call_id or function name');
    }
    if (this.finish === 'tool_calls' && !this.calls.size) return this.fail('Chat stream ended with tool_calls but supplied no tool call');
    this.start();
    const incomplete = this.finish === 'length' || this.finish === 'content_filter';
    this.closeItems(incomplete ? 'incomplete' : 'completed');
    this.ended = true;
    this.send(incomplete ? 'response.incomplete' : 'response.completed', {
      response: this.response(incomplete ? 'incomplete' : 'completed', null, incomplete ? { reason: this.finish === 'length' ? 'max_output_tokens' : 'content_filter' } : null),
    });
  }

  fail(message = 'Chat upstream stream failed') {
    if (this.ended) return;
    this.start();
    this.closeItems('incomplete');
    this.ended = true;
    this.failed = true;
    this.send('response.failed', { response: this.response('failed', { code: 'server_error', message: String(message) }) });
  }
}

export function bridgeChatToResponses(inner, model, aliases = null) {
  const stream = new ChatToResponsesStream({ model, aliases, emit: (event, data) => inner.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) });
  return {
    write: (chunk) => stream.feed(chunk),
    end: () => { stream.end(); inner.end(); return !stream.failed; },
    fail: (message) => { stream.fail(message); inner.end(); },
  };
}
