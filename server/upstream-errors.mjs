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

/** 上游错误体的 type 字段;免费层拒绝统一用 FreeTierError,文案会变。 */
function upstreamErrorType(body) {
  if (body && typeof body === 'object') return String(body?.error?.type || body?.type || '');
  try {
    const parsed = JSON.parse(String(body ?? ''));
    return String(parsed?.error?.type || parsed?.type || '');
  } catch {
    return '';
  }
}

export function isModelUnavailableError(status, body) {
  if (Number(status) !== 400) return false;
  return /\bmodel\s+(?:(?:is|was)\s+)?(?:unavailable|not\s+available)\b/i
    .test(upstreamErrorMessage(body));
}

/**
 * 免费层准入门。上游有两个阶段的拒绝,类型都是 403 FreeTierError:
 *
 *   1. 旧文案「can only be used from within OpenCode」—— 身份头/Session 形状
 *      不对时出现,也可能是按出口/时间窗的间歇抽检。
 *   2. 2026-10-19 实测的新文案「free models aren't available from your current
 *      network ... abusive traffic from this IP address」—— 出口 IP 被上游标记。
 *      同一个节点上所有免费模型都 403,换一个节点立刻 200(同一身份头、同一
 *      请求体),所以它是**出口属性**,不是客户端身份坏了。
 *
 * 两种都必须归为可重试(换出口重发),不能判 terminal —— terminal 会保留当前
 * 锁定节点、不写冷却,于是每个请求都在同一个被封 IP 上原地失败。文案会继续变,
 * 因此优先认 error.type=FreeTierError,旧关键词只作为没有 type 时的兜底。
 */
export function isFreeTierError(status, body) {
  if (Number(status) !== 403) return false;
  if (upstreamErrorType(body) === 'FreeTierError') return true;
  const message = upstreamErrorMessage(body);
  return /free\s*tier|from\s+within\s+OpenCode|abusive\s+traffic|free\s+models\s+(?:aren't|are not)\s+available\s+from\s+your\s+current\s+network/i.test(message);
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
// answers 是 System One(jev 分类器)的业务载荷,见 dialects 的 SYSTEMONE
const PAYLOAD_KEYS = ['choices', 'output', 'output_text', 'content', 'delta', 'response', 'answers'];

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
