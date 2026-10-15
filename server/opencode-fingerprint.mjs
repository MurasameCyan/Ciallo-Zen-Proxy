/**
 * OpenCode v2 free-tier fingerprint.
 *
 * /inference/v1 checks the exact `read` and `shell` definitions. Caller tools
 * remain unchanged unless they reuse one of those exact names with a different
 * definition; those tools travel under a request-local alias and are restored
 * on the response side.
 */

export const OPENCODE_FINGERPRINT_TOOLS = ['read', 'shell'];

// Verbatim definitions captured from the OpenCode v2.0.26 CLI. Upstream compares
// descriptions and parameter schemas, so keep these strings and object shapes.
const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: 'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
        limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  shell: {
    description: 'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
        timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
        background: { type: 'boolean', description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};


export function fingerprintToolKey(name) {
  const trimmed = String(name ?? '').trim();
  return OPENCODE_FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : '';
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return '';
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  return fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string'
    ? fn.name.trim() : '';
}

function chatFunctionOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === 'object' && !Array.isArray(fn) ? fn : null;
}

function isFingerprintDefinition(tool, key, flat) {
  const wanted = FINGERPRINT_TOOL_DEFINITIONS[key];
  if (!tool || typeof tool !== 'object' || Array.isArray(tool) || tool.type !== 'function') return false;
  if (flat) {
    return tool.name === key && tool.strict === false
      && tool.description === wanted.description
      && JSON.stringify(tool.parameters) === JSON.stringify(wanted.parameters);
  }
  const def = chatFunctionOf(tool);
  return !tool.name && tool.strict === undefined && !!def && def.name === key
    && def.strict === undefined
    && def.description === wanted.description
    && JSON.stringify(def.parameters) === JSON.stringify(wanted.parameters);
}

function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/** Move conflicting caller tools off exact fingerprint names. */
export function concealFingerprintToolNames(tools, flat = false) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools, map };

  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }
    const key = fingerprintToolKey(toolNameOf(tool));
    if (!key) {
      out.push(tool);
      continue;
    }
    const exact = isFingerprintDefinition(tool, key, flat);
    if (exact) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(tool);
      }
      continue;
    }
    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

/** Append an exact fingerprint definition for every missing name. */
export function appendMissingFingerprintTools(tools, flat) {
  const appended = [];
  if (!Array.isArray(tools)) return appended;
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    tools.push(flat
      ? { type: 'function', name, description, parameters, strict: false }
      : { type: 'function', function: { name, description, parameters } });
    appended.push(name);
  }
  return appended;
}

function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]));
}

export function retargetToolChoice(body, map) {
  if (!body || typeof body !== 'object' || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return;
  const aliases = aliasesByOriginal(map);
  if (typeof choice.name === 'string') {
    const alias = aliases.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }
  const fn = choice.function;
  if (fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string') {
    const alias = aliases.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

export function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== 'object' || !map?.size) return;
  const aliases = aliasesByOriginal(map);
  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) => item?.type === 'function_call' && aliases.has(item.name)
      ? { ...item, name: aliases.get(item.name) } : item);
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => {
      if (!Array.isArray(msg?.tool_calls)) return msg;
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((call) => aliases.has(call?.function?.name)
          ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } } : call),
      };
    });
  }
}

function noteUnavailableTools(body, flat, names) {
  const list = names.map((name) => `\`${name}\``).join(' or ');
  const note = names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  if (flat) {
    body.instructions = typeof body.instructions === 'string' && body.instructions.trim()
      ? `${body.instructions}\n\n${note}` : note;
    return;
  }
  // Chat bodies use messages. A body with top-level system is Claude-shaped and
  // is intentionally left alone; its system content is converted separately.
  if (!Array.isArray(body.messages) || body.system !== undefined) return;
  const first = body.messages[0];
  if (first?.role === 'system' && typeof first.content === 'string') {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: 'system', content: note }, ...body.messages];
  }
}

export function applyFingerprintTools(body, flat) {
  if (!body || typeof body !== 'object') return new Map();
  const { tools, map } = concealFingerprintToolNames(body.tools, flat);
  body.tools = Array.isArray(tools) ? tools : [];
  const appended = appendMissingFingerprintTools(body.tools, flat);
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  if (appended.length) noteUnavailableTools(body, flat, appended);
  const choice = body.tool_choice;
  const none = choice === 'none'
    || (choice && typeof choice === 'object' && !Array.isArray(choice) && choice.type === 'none');
  if (none) {
    if (flat) body.tool_choice = 'auto';
    else delete body.tool_choice;
  }
  // Responses accepts its explicit auto default; `none` is rejected by upstream.
  if (!body.tool_choice && flat) body.tool_choice = 'auto';
  return map;
}


/** Restore aliases in a complete response object or one decoded SSE event. */
export function restoreToolNames(payload, map) {
  if (!map?.size || payload == null) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== 'object') return payload;
  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };
  if (payload.type === 'content_block_start') {
    const block = payload.content_block;
    if (block?.type === 'tool_use' && map.has(block.name)) put('content_block', { ...block, name: map.get(block.name) });
  }
  if (Array.isArray(payload.content)) {
    put('content', payload.content.map((block) => block?.type === 'tool_use' && map.has(block.name)
      ? { ...block, name: map.get(block.name) } : block));
  }
  if (Array.isArray(payload.choices)) {
    const choices = payload.choices.map((choice) => {
      let changed = false;
      const next = { ...choice };
      for (const holder of ['delta', 'message']) {
        const value = choice?.[holder];
        if (!value || !Array.isArray(value.tool_calls)) continue;
        const calls = value.tool_calls.map((call) => {
          const name = call?.function?.name;
          if (!map.has(name)) return call;
          changed = true;
          return { ...call, function: { ...call.function, name: map.get(name) } };
        });
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    });
    put('choices', choices);
  }
  if (Array.isArray(payload.output)) {
    put('output', payload.output.map((item) => item?.type === 'function_call' && map.has(item.name)
      ? { ...item, name: map.get(item.name) } : item));
  }
  if (payload.item?.type === 'function_call' && map.has(payload.item.name)) {
    put('item', { ...payload.item, name: map.get(payload.item.name) });
  }
  if (payload.response && typeof payload.response === 'object') {
    const response = restoreToolNames(payload.response, map);
    if (response !== payload.response) put('response', response);
  }
  return out;
}

/**
 * Wrap a dialect sink with a small stateful SSE line transformer. It preserves
 * comments and event lines, while restoring aliases in JSON data frames before
 * the dialect-specific sink sees them.
 */
export function aliasSseSink(inner, map) {
  if (!map?.size) return inner;
  let buffer = '';
  const decoder = new TextDecoder();
  const writeLine = (line) => {
    const match = /^([^:]*data:\s*)(.*)$/.exec(line);
    if (!match || !match[2] || match[2] === '[DONE]') {
      inner.write(`${line}\n`);
      return;
    }
    try {
      inner.write(`${match[1]}${JSON.stringify(restoreToolNames(JSON.parse(match[2]), map))}\n`);
    } catch {
      inner.write(`${line}\n`);
    }
  };
  return {
    write(chunk) {
      buffer += decoder.decode(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk)), { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) writeLine(line.replace(/\r$/, ''));
    },
    end() {
      buffer += decoder.decode();
      if (buffer) writeLine(buffer.replace(/\r$/, ''));
      inner.end();
    },
    fail(message) {
      inner.fail?.(message);
    },
  };
}
