/**
 * http-util.mjs —— 最小的 HTTP 响应helpers。
 *
 * 单独一个文件是为了打断依赖环:方言表(dialects.mjs)要写 JSON 错误体,
 * 而它自己被 gateway.mjs 引用 —— json 留在 gateway.mjs 里就成了环。
 */

/** 写一个 JSON 响应。no-store:面板轮询的接口不能被浏览器或中间层缓存 */
export function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/**
 * 收完整个请求体后再一次性按 UTF-8 解码。不能对每个网络 chunk 直接做
 * `raw += chunk`:chunk 可能切在中文或 emoji 的多字节序列中,逐块解码会产出 U+FFFD。
 * 超过 maxBytes 返回 null,调用方负责按自己的协议回 413。
 */
export async function readUtf8Body(req, maxBytes = Infinity) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buf.byteLength;
    if (bytes > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
