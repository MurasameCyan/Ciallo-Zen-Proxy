// bun-sidecar.js — runs under Bun, not Node.
//
// The free tier fingerprints the TLS client. 2026-11-01, same exit, same bytes:
// Node's OpenSSL handshake gets `429 FreeUsageLimitError`, Bun's BoringSSL
// handshake gets 200 (official CLI 2.2.5 and standalone Bun 1.4.4 alike).
// Matching Node's ciphers/curves to Bun's does not help. So upstream inference
// requests leave through this process: the Node gateway sends plain HTTP to
// 127.0.0.1, and Bun's fetch opens the TLS connection through the requested
// mihomo mixed-port.
//
// Wire contract (see bun-transport.mjs):
//   request  path/query = upstream path on https://opencode.ai
//            x-sidecar-token = shared secret from SIDECAR_TOKEN
//            x-sidecar-proxy = mihomo mixed-port to tunnel through
//   response upstream status/headers/body, streamed; on a transport failure
//            502 with x-sidecar-error = the fetch error message.

const TOKEN = process.env.SIDECAR_TOKEN || '';
const UPSTREAM = 'https://opencode.ai';
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding',
  'x-sidecar-token', 'x-sidecar-proxy', 'accept-encoding']);
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

if (!TOKEN) {
  console.error('SIDECAR_TOKEN missing');
  process.exit(2);
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  // Reasoning models can stay silent for minutes; Node owns the timeouts.
  idleTimeout: 0,
  async fetch(req) {
    if (req.headers.get('x-sidecar-token') !== TOKEN) return new Response('forbidden', { status: 403 });
    const proxyPort = Number(req.headers.get('x-sidecar-proxy'));
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      return new Response('bad proxy port', { status: 400 });
    }
    const url = new URL(req.url);
    const headers = new Headers();
    for (const [name, value] of req.headers) if (!DROP_REQUEST.has(name)) headers.set(name, value);
    // Identity keeps the stream byte-for-byte; compressed passthrough would need
    // the encoding header preserved end to end.
    headers.set('accept-encoding', 'identity');
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    let upstream;
    try {
      upstream = await fetch(UPSTREAM + url.pathname + url.search, {
        method: req.method, headers, body,
        proxy: `http://127.0.0.1:${proxyPort}`,
        // A mihomo selector can change behind this same proxy port. Reusing a
        // CONNECT tunnel would keep sending retries through the old exit IP.
        keepalive: false,
        redirect: 'manual',
        signal: req.signal,
      });
    } catch (error) {
      const message = String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 300);
      return new Response(message, { status: 502, headers: { 'x-sidecar-error': message || 'fetch failed' } });
    }
    const out = new Headers();
    for (const [name, value] of upstream.headers) if (!DROP_RESPONSE.has(name)) out.append(name, value);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
});

// The parent waits for this line to learn the port.
console.log(`SIDECAR_READY ${server.port}`);
