/**
 * 上游错误分类只依赖状态码和错误体,不依赖网关状态机,方便转发与能力探测共用。
 */
export function upstreamErrorMessage(body) {
  if (body && typeof body === 'object') {
    return String(body?.error?.message || body?.message || '').trim();
  }
  const text = String(body ?? '');
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.message;
    if (message) return String(message).trim();
  } catch {}
  return text.trim();
}

export function isModelUnavailableError(status, body) {
  if (Number(status) !== 400) return false;
  return /\bmodel\s+(?:(?:is|was)\s+)?(?:unavailable|not\s+available)\b/i
    .test(upstreamErrorMessage(body));
}

/**
 * 免费层准入门(403 FreeTierError:「can only be used from within OpenCode」)。
 *
 * 我们出站已经强制补上 cli UA + 形状正确的 session + 集齐五个核心工具名(见
 * identityHeaders / gateChatBody / gateResponsesBody),所以这个 403 从来不是
 * 「身份真的不对」—— 实测它是**间歇性**的:同一个节点前一分钟被这句话拒、
 * 后一分钟同样的请求 200。多半是上游按出口/时间窗做的概率性抽检。
 *
 * 所以它该被当成**可重试**(换出口重发),而不是 terminal 直接甩给客户端 ——
 * 后者会让用户在一次抽检上原地失败,而隔壁节点明明能过。
 */
export function isFreeTierError(status, body) {
  if (Number(status) !== 403) return false;
  const message = upstreamErrorMessage(body);
  return /free\s*tier|FreeTierError|from\s+within\s+OpenCode/i.test(message);
}

export function isCapabilityError(status, body) {
  const code = Number(status);
  if (code !== 400 && code !== 422) return false;
  if (isModelUnavailableError(code, body)) return false;
  const message = upstreamErrorMessage(body);
  return !/\b(?:unauthorized|forbidden|invalid\s+(?:api[_ -]?key|token)|authentication)\b/i.test(message);
}

/**
 * 上游会把供应商的错误塞进 HTTP 200 里。2026-09-14 在容器里实测到的原样响应
 * (nemotron-3-ultra-free,经节点出站):
 *
 *   HTTP/1.1 200
 *   {"error":{"type":"server_error","message":"Error from provider (Console):
 *     Upstream request failed: [502] Upstream error from Nvidia: Service temporarily unavailable"}}
 *
 * 只看状态码的话这是一次成功:forward 会 JSON.parse 后 resolve,attempt 记
 * success、清掉当前出口的冷却、把这坨 {error:...} 当成回答发给客户端,而且
 * **不换节点不重试** —— 而它其实是个可重试的 502。所以成功路径也得验一遍 body。
 *
 * 判据刻意窄:必须「error 携带了信息」且「一个业务载荷字段都没有」。
 * 上游正常回答里可能带 error:null,工具调用的响应里 choices 可能是空数组
 * 但 usage 在 —— 误判会把真实回答吞掉,那比漏判更糟。
 */
const PAYLOAD_KEYS = ['choices', 'output', 'output_text', 'content', 'delta', 'response'];

export function isErrorShapedOk(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const err = payload.error;
  if (err == null) return false;
  const hasInfo = typeof err === 'string'
    ? err.trim() !== ''
    : !!(err.message || err.type || err.code);
  if (!hasInfo) return false;
  return !PAYLOAD_KEYS.some((k) => payload[k] != null);
}

/**
 * 把上游真正的状态码从错误原文里抠出来 —— 它写在方括号里
 * (`Upstream request failed: [502] Upstream error from Nvidia`),
 * 而 HTTP 层那个 200 是假的:拿 200 去 classifyUpstreamError 会落到
 * terminal 分支,也就是不重试。
 *
 * 抠不出来就退回 502:能确定的是「上游侧失败了」,而 5xx 会进 attempt 的
 * retryable 分支去换节点,这正是这类错误该得到的处置。
 */
export function embeddedStatus(body, fallback = 502) {
  const m = /\[(\d{3})\]/.exec(upstreamErrorMessage(body));
  if (!m) return fallback;
  const code = Number(m[1]);
  return code >= 400 && code <= 599 ? code : fallback;
}

export function classifyUpstreamError(status, body) {
  const code = Number(status) || 0;
  if (code === 429) return 'rate_limited';
  if (code === 0) return 'transport';
  if (isModelUnavailableError(code, body)) return 'model_unavailable';
  // 免费层抽检 403 是间歇的(见 isFreeTierError):换个出口重发多半就过,
  // 当 terminal 会让用户在一次抽检上原地失败。归到 retryable 走换节点重试。
  if (isFreeTierError(code, body)) return 'retryable';
  if (code === 408 || code >= 500) return 'retryable';
  return 'terminal';
}
