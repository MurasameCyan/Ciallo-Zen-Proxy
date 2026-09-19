/**
 * dialects.mjs —— 三种 API 方言 + 各自的流式落地方式,从 gateway.mjs 拆出来。
 *
 * 上游那几个 path 也放这儿:每个方言自带 path,轮换逻辑不用知道自己在服务谁。
 * Gateway 那边 upstreamGet / reqOpts 还要用 OPENCODE_HOST 和 MODELS_PATH,
 * 从这里 import 回去。
 */

import {
  anthropicToOpenAI, openAIToAnthropic, anthropicError, errTypeFor, AnthropicStream,
} from './anthropic.mjs';
import { json } from './http-util.mjs';

export const OPENCODE_HOST = 'opencode.ai';
// 免费层入口在 2026-09-18~19 之间搬到了 /inference/openai/v1/*:老路径
// /zen/v1/chat/completions 现在对免费模型一律 403 FreeTierError,新路径在
// 同样的头 + body 形状下回 200。实测见容器内对照(/inference/openai/v1/
// chat/completions 200 vs /zen/v1/chat/completions 403)。
export const CHAT_PATH = '/inference/openai/v1/chat/completions';
// 上游原生支持 Responses API,走这条透传而不是翻译成 chat 再转回来(实测见
// zen-responses-native)。方言各自带上游 path,轮换逻辑不用知道自己在服务哪个。
// 新入口下的 responses 目前回 503 Endpoint is unavailable,所以仍指向老路径,
// 等它恢复再切。
export const RESPONSES_PATH = '/zen/v1/responses';
export const MODELS_PATH = '/zen/v1/models';


/**
 * 把上游的 reasoning_content 翻成 Anthropic 的 thinking 块。
 *
 * 默认开。deepseek-v4-flash-free 出正文之前会先推理好几分钟(实测「写个 SVG
 * 动画」的提问 200s 内推理 68000 字、正文 0 字),不转发的话客户端收到
 * message_start 之后几分钟一个事件都没有,看起来就是卡死。
 * 极少数客户端不认 thinking 块,那就 SHOW_THINKING=0 关掉。
 */
const SHOW_THINKING = process.env.SHOW_THINKING !== '0';

/** 只有明确的纯文本模态才降级;元数据缺失或还含其它模态时保持原请求。 */
const isTextOnly = (meta) => Array.isArray(meta?.inputModalities)
  && meta.inputModalities.length > 0
  && meta.inputModalities.every((m) => String(m).toLowerCase() === 'text');

const attachmentKind = (part) => {
  const type = String(part?.type || '').toLowerCase();
  if (type === 'image' || type === 'image_url' || type === 'input_image') return 'image';
  if (type === 'document' || type === 'file' || type === 'input_file') return 'document';
  return '';
};

/**
 * 从 **Responses 事件流** 里取出完整响应对象。
 *
 * Responses 的 sink 近乎透传,所以缓冲里就是上游那一串 response.* 事件。
 * 完整对象挂在 response.completed 事件的 response 字段上 —— 直接取它,
 * 不要去逐段拼 output:上游怎么分片是它的事,我们照抄整块最不容易出错。
 *
 * 取不到 completed(比如上游提前断了)时退回 null,调用方按失败处理。
 */
export function assembleFromResponsesEvents(sseText, model = '') {
  let last = null;
  for (const rawLine of String(sseText).split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let j;
    try { j = JSON.parse(payload); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    if (j.type === 'response.completed' && j.response) return j.response;
    // 有些实现把整块 response 直接发出来(没有 type 包装),留作兜底
    if (j.object === 'response') last = j;
  }
  return last;
}

/**
 * 从 **Anthropic 事件流** 回拼一条 chat.completion 形状的结果。
 *
 * 为什么需要这一层:强制流式之后,非流式客户端要我们替它收完再拼(见
 * gateChatBody)。而 Anthropic 方言的 sink 已经把上游 chunk 翻译成了
 * message_start / content_block_delta / message_delta 这套事件 —— 缓冲里
 * 装的就是它。所以这里做的是**反向**解析:把事件还原成「一个助手回答」,
 * 再交给 openAIToAnthropic 落到 Messages 响应上。
 *
 * 不能拿 chat 的拼装器直接解这些事件:字段名完全不同,解出来是个空壳
 * (实测过一次,text 块是空的而 usage 正常 —— 那种半对不对的结果最难发现)。
 */
export function assembleFromAnthropicEvents(sseText, model = '') {
  const text = [];
  const thinking = [];
  const blocks = new Map();     // index -> { id, name, args }
  let stopReason = null;
  let outputTokens = 0;
  let inputTokens = 0;

  const handle = (evt, data) => {
    if (!data || typeof data !== 'object') return;
    switch (evt) {
      case 'content_block_start': {
        const b = data.content_block || {};
        if (b.type === 'tool_use') {
          blocks.set(data.index, { id: b.id || '', name: b.name || '', args: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const d = data.delta || {};
        if (d.type === 'text_delta' && typeof d.text === 'string') text.push(d.text);
        else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') thinking.push(d.thinking);
        else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const acc = blocks.get(data.index);
          if (acc) acc.args += d.partial_json;
        }
        break;
      }
      case 'message_delta': {
        if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
        if (data.usage?.output_tokens != null) outputTokens = data.usage.output_tokens;
        break;
      }
      case 'message_start': {
        if (data.message?.usage?.input_tokens != null) inputTokens = data.message.usage.input_tokens;
        break;
      }
      default: break;
    }
  };

  // 事件流按「event: X / data: {...} / 空行」分帧,其中只有 data 行是载荷
  for (const rawLine of String(sseText).split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    let j;
    try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
    const evt = (j && typeof j === 'object' && j.type) ? j.type : null;
    if (evt) handle(evt, j);
  }

  if (!text.length && !blocks.size && !thinking.length && !stopReason) return null;
  const toolCalls = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => ({
    id: b.id, type: 'function', function: { name: b.name, arguments: b.args || '{}' },
  }));
  const message = { role: 'assistant', content: text.join('') || null };
  if (thinking.length) message.reasoning_content = thinking.join('');
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: `msg_${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: stopReason === 'tool_use' ? 'tool_calls'
        : (stopReason === 'max_tokens' ? 'length' : 'stop'),
    }],
    ...(outputTokens || inputTokens
      ? { usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }
      : {}),
  };
}

/**
 * 免费层准入的 body 条件。**这是门槛,不是优化。**
 *
 * 2026-09-19 容器内实测(/inference/openai/v1/chat/completions,不带任何凭证):
 *   stream:false + 无 tools / 5 tools   -> 403 FreeTierError
 *   stream:true  + 无 tools             -> 403
 *   stream:true  + 5 个核心工具名        -> **200 OK**
 *
 * 两个条件,缺一不可:
 *   1. body 里 stream 必须是 true
 *   2. tools 里必须**集齐 OpenCode 那五个核心工具名**:
 *      bash / edit / glob / grep / read
 *
 * 第 2 条容易搞错,这里记下实测过程:先按「总数 ≥5 且其中 ≥2 个核心名」实现,
 * 结果 403。逐项消融才看清真正的规则 —— 核心名**必须五个都在**:
 *
 *   5 个核心名              -> 200
 *   3 核心 + 2 个通用名      -> 403
 *   3 核心 + 2 个任意真实词   -> 403
 *   5 核心 + 5 个任意词      -> 200   ← 多余的工具名无害
 *
 * 所以是「五个核心名齐了就行」,多出来的工具不影响。注意别被旧资料带偏:
 * oh-my-pi #12306 里那份 bisection 说的是 /zen/v1 那条老路的规则(5 个核心名中
 * 有 2 个即可),对新端点不成立。
 *
 * 注入的 stub 只求名字对得上:实测 schema 和 description 完全不被校验(用
 * "x" 和一句废话都能过)。所以 stub 只是个占位,模型看不到有意义的描述,
 * 也就不会去调它。客户端自带的工具原样保留在前面。
 */
const GATE_CORE_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'];

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 从一条 tool 定义里取名字,兼容 OpenAI 的嵌套式和 Responses 的扁平式 */
function toolName(tool) {
  if (!isObject(tool)) return '';
  if (typeof tool.name === 'string') return tool.name;
  if (isObject(tool.function) && typeof tool.function.name === 'string') return tool.function.name;
  return '';
}

const gatedTool = (name) => ({
  type: 'function',
  function: {
    name,
    description: 'Tool available for this session.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
});

/**
 * 把出站 body 补齐到能过免费层的形状。返回 {forcedStream, injected},
 * 调用方据此决定响应怎么回(forcedStream 且客户端要非流式 → 得缓冲后拼回 JSON)。
 */
export function gateChatBody(body) {
  const forcedStream = body.stream !== true;
  if (forcedStream) body.stream = true;

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const present = new Set(tools.map(toolName));

  let injected = 0;
  for (const name of GATE_CORE_TOOLS) {
    if (present.has(name)) continue;
    tools.push(gatedTool(name));
    present.add(name);
    injected++;
  }
  if (injected) body.tools = tools;
  return { forcedStream, injected };
}

/**
 * 把上游的 SSE 文本拼成一条完整的 chat.completion 响应。
 *
 * 为什么需要:免费层只收 stream:true(见 gateChatBody),所以非流式客户端
 * 只能由我们替它收流再拼回来。上游给的是 chat.completion.chunk 增量,
 * 拼装规则按 OpenAI 的流式规范:
 *   - content / reasoning_content 逐段追加
 *   - tool_calls 按 index 归并,function.arguments 是分片追加的字符串
 *   - usage 通常只在最后一个 chunk 上,直接取
 *   - finish_reason 同理
 *
 * 这不是猜测形状的活:拼出来的对象要和上游非流式响应同形,否则客户端的
 * SDK 会解析失败 —— 所以下面刻意保留 id/object/created/model 这几个字段,
 * 并把 object 从 chat.completion.chunk 改写成 chat.completion。
 */
export function assembleChatCompletion(sseText, fallbackModel = '') {
  let head = null;
  let usage = null;
  let finish = null;
  let content = '';
  let reasoning = '';
  const tools = new Map();

  for (const rawLine of String(sseText).split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;      // 空行、注释、event: 行都跳过
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let j;
    try { j = JSON.parse(payload); } catch { continue; }
    if (!head && j && typeof j === 'object') head = j;
    const choice = j?.choices?.[0];
    const delta = choice?.delta || choice?.message || {};
    if (typeof delta.content === 'string') content += delta.content;
    const r = delta.reasoning_content ?? delta.reasoning;
    if (typeof r === 'string') reasoning += r;
    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const idx = Number.isInteger(tc?.index) ? tc.index : (tools.size ? tools.size - 1 : 0);
      const acc = tools.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) acc.id = tc.id;
      if (tc.type) acc.type = tc.type;
      if (tc.function?.name) acc.function.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') acc.function.arguments += tc.function.arguments;
      tools.set(idx, acc);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (j?.usage) usage = j.usage;
  }

  if (!head) return null;
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.size) {
    message.content = content || null;
    message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  }
  return {
    id: head.id || '',
    object: 'chat.completion',
    created: head.created || Math.floor(Date.now() / 1000),
    model: head.model || fallbackModel,
    choices: [{ index: 0, message, finish_reason: finish || 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

function downgradeOpenAIAttachments(body, meta, textType) {
  if (!isTextOnly(meta)) return body;
  const field = Array.isArray(body?.messages) ? 'messages' : (Array.isArray(body?.input) ? 'input' : '');
  if (!field) return body;
  return {
    ...body,
    [field]: body[field].map((message) => {
      if (!Array.isArray(message?.content)) return message;
      return {
        ...message,
        content: message.content.map((part) => {
          const kind = attachmentKind(part);
          return kind ? { type: textType, text: `[${kind} attached]` } : part;
        }),
      };
    }),
  };
}

/**
 * 方言。/v1/chat/completions、/v1/messages、/v1/responses 共用同一套节点轮换、
 * 冷却、重试,差别只有几件事:请求怎么进来、成功体怎么写回去、错误体和 SSE
 * 事件长什么样、以及上游 path 和思考强度往哪个字段塞。把这些收进一个对象,
 * 轮换逻辑就完全不用知道自己在服务哪个 API —— 否则每个 return 点都要 if,
 * 漏一个就是形状错乱的响应。
 */
export const OPENAI = {
  name: 'openai',
  path: CHAT_PATH,
  /** 客户端选哪个模型就用哪个 —— handleChat 已经拿实时免费清单挡过一道了 */
  toUpstream: (body, meta) => downgradeOpenAIAttachments(body, meta, 'text'),
  validate: (b) => (Array.isArray(b.messages) && b.messages.length ? null : 'messages required'),
  fail: (res, status, message, type, extra) => json(res, { error: { message, type, ...extra } }, status),
  // 顶层 reasoning_effort:有值覆盖,空值删掉(收敛客户端的乱值和会被丢的顶档别名)
  applyEffort: (body, effort) => { if (effort) body.reasoning_effort = effort; else delete body.reasoning_effort; },
  respond: (res, oai) => json(res, oai),
  sink: (res) => rawSink(res),
  // 上游只收流式(见 gateChatBody),所以非流式客户端要我们替它收完再拼。
  // 拼装由 gateway 的 assembleChatCompletion 做:两者缓冲里装的都是
  // chat.completion.chunk 形状的 SSE,规则一致。
  collect: (sseText, model) => assembleChatCompletion(sseText, model),
};

export const ANTHROPIC = {
  name: 'anthropic',
  path: CHAT_PATH,
  // anthropicToOpenAI 已经把 req.model 抄进去了,这里不再覆盖
  toUpstream: (body, meta) => anthropicToOpenAI(body, { textOnly: isTextOnly(meta) }),
  validate: (b) => (Array.isArray(b.messages) && b.messages.length ? null : 'messages: at least one message required'),
  // Anthropic 的错误体没有放附加字段的地方,所以把冷却剩余秒数并进 message,
  // 而不是塞个上游 SDK 会忽略掉的字段 —— 信息宁可在文字里也别丢。
  // type 参数刻意不用:Anthropic 只认自己那套枚举,按状态码映射才不会造出
  // SDK 读不懂的类型(OpenAI 那边的 invalid_model 在这儿就得是 invalid_request_error)
  fail: (res, status, message, type, extra) => {
    const s = extra?.cooldown?.[0]?.remain;
    return json(res, anthropicError(s ? `${message}(约 ${s}s 后恢复)` : message, errTypeFor(status)), status);
  },
  // anthropicToOpenAI 已经把强度转进了 reasoning_effort,这里和 OpenAI 同款收敛
  applyEffort: (body, effort) => { if (effort) body.reasoning_effort = effort; else delete body.reasoning_effort; },
  respond: (res, oai, model) => json(res, openAIToAnthropic(oai, model)),
  sink: (res, model) => anthropicSink(res, model),
  // 这里的 buffered 是**上游 chat 流经 sink 翻译后的 Anthropic 事件流**,不是
  // chat chunk。所以拼装要从 Anthropic 事件里取回完整回答,再交给 respond。
  collect: (sseText, model) => assembleFromAnthropicEvents(sseText, model),
};

/**
 * OpenAI Responses API。上游原生支持(见 zen-responses-native),所以这条是
 * 近乎透传:body 形状不翻译、成功体原样回。只有两处非做不可的薄处理 ——
 *   1. 思考强度走嵌套 reasoning.effort,不是 chat 的顶层 reasoning_effort;
 *   2. 流式 sink 必须行级感知,拦掉一类模型收尾时漏出的 chat.completion.chunk
 *      杂块(见 responsesSink),纯字节透传会让严格的 Responses 客户端解析报错。
 */
export const RESPONSES = {
  name: 'responses',
  path: RESPONSES_PATH,
  // OpenAI SDK 允许 input 是字符串,但上游只认数组(纯字符串 → 400 Empty input
  // messages),所以先补成数组;明确的纯文本模型再把附件换成 input_text 占位。
  toUpstream: (body, meta) => {
    const normalized = typeof body.input === 'string'
      ? { ...body, input: [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }] }
      : body;
    return downgradeOpenAIAttachments(normalized, meta, 'input_text');
  },
  validate: (b) => ((Array.isArray(b.input) && b.input.length) || (typeof b.input === 'string' && b.input.trim())
    ? null : 'input required'),
  // Responses 的错误体和 OpenAI 同形 {error:{message,type}},复用即可
  fail: (res, status, message, type, extra) => json(res, { error: { message, type, ...extra } }, status),
  // 嵌套 reasoning.effort:保留客户端可能带的 summary 等其它 reasoning 字段,
  // 只改 effort;删到空对象就把 reasoning 整个去掉,别发个空壳上去
  applyEffort: (body, effort) => {
    const r = (body.reasoning && typeof body.reasoning === 'object') ? { ...body.reasoning } : {};
    if (effort) r.effort = effort; else delete r.effort;
    if (Object.keys(r).length) body.reasoning = r; else delete body.reasoning;
  },
  respond: (res, oai) => json(res, oai),
  sink: (res) => responsesSink(res),
  // Responses 的 sink 是近乎透传,所以缓冲里是上游的 response.* 事件流。
  // 完整对象在 response.completed 的 response 字段里,直接取它 —— 比重新
  // 拼装各段 output 更可靠(上游的 output 分片规则我们没必要猜)。
  collect: (sseText, model) => assembleFromResponsesEvents(sseText, model),
};

/** OpenAI 流:上游字节原样透传,不解析不重排 */
function rawSink(res) {
  const safe = (fn) => { try { fn(); } catch {} };
  return {
    write: (chunk) => safe(() => res.write(chunk)),
    end: () => safe(() => res.end()),
    // 已经开始吐了才失败,补不了合法结尾,只能断开让客户端自己发现
    fail: () => safe(() => res.end()),
  };
}

/**
 * Responses 流:近乎透传,但要行级感知。
 *
 * 一类模型(deepseek-v4-flash / hy3 实测)收尾 usage 没翻干净:response.completed
 * 不带 usage,末尾反而漏出一个原始 {object:"chat.completion.chunk"} 再跟 [DONE]。
 * 那个杂块没有 Responses 的 type 字段,严格的 Responses 客户端(官方 SDK)碰到
 * 会解析报错,所以这里按行把它吞掉。它携带的 usage 由 forwardStream 单独抓走记账
 * (见那里的双命名兜底),不靠转发 —— 所以吞掉不影响面板 token 统计。
 *
 * 干净型模型(big-pickle / nemotron 等)根本不漏这个块,这层对它们等同透传。
 */
function responsesSink(res) {
  const safe = (fn) => { try { fn(); } catch {} };
  let buf = '';
  // 有状态解码:chunk 边界会切在多字节字符中间(中文 3 字节),每块各自
  // toString() 会把被切开的字符换成 U+FFFD,而且不可恢复。
  const decoder = new TextDecoder('utf-8');
  // 按行判断:只有确认是 chat.completion.chunk 的 data 行才丢,其余(response.*
  // 事件、空行、[DONE]、解析不了的行)一律原样转发,保住 SSE 分帧。
  const forwardLine = (line) => {
    if (line.startsWith('data:')) {
      const payload = line.slice(line.indexOf(':') + 1).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const j = JSON.parse(payload);
          if (j && j.object === 'chat.completion.chunk') return;
        } catch {}
      }
    }
    safe(() => res.write(line + '\n'));
  };
  return {
    write: (chunk) => {
      buf += decoder.decode(
        Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk)),
        { stream: true },
      );
      const lines = buf.split('\n');
      buf = lines.pop();          // 末行可能被截断,留着等下一个 chunk
      for (const line of lines) forwardLine(line);
    },
    end: () => { if (buf) { forwardLine(buf); buf = ''; } safe(() => res.end()); },
    fail: () => safe(() => res.end()),
  };
}

/** Anthropic 流:把上游的 chat.completion.chunk 翻译成 Messages 事件流 */
function anthropicSink(res, model) {
  const safe = (fn) => { try { fn(); } catch {} };
  const st = new AnthropicStream({
    model,
    thinking: SHOW_THINKING,
    emit: (event, data) => safe(() => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
  });
  return {
    write: (chunk) => st.feed(chunk),
    end: () => { st.end(); safe(() => res.end()); },
    // 和 rawSink 不同:这里能补一个合法收尾(error + message_stop),
    // 客户端的状态机于是能正常结束,而不是等到超时
    fail: (msg) => { st.fail(msg); safe(() => res.end()); },
  };
}

