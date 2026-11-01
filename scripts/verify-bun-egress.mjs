#!/usr/bin/env node
/** Real Bun regression: selector changes must not reuse an old CONNECT tunnel.
 * All traffic stays on loopback. Requires Bun and openssl; CI runs it separately
 * from npm test, like verify-tunnel.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ciallo-bun-egress-'));
const certFile = path.join(dir, 'cert.pem'), keyFile = path.join(dir, 'key.pem');
const sockets = new Set(), servers = [];
const agent = new http.Agent({ keepAlive: true });
const track = (socket) => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));
  return socket;
};
const listen = async (server) => {
  servers.push(server);
  server.on('connection', track);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
};
let child;
try {
  const config = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=opencode.ai\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', config,
    '-keyout', keyFile, '-out', certFile, '-addext', 'subjectAltName=DNS:opencode.ai'], { stdio: 'pipe' });
  const tls = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  const origin = async (egress) => listen(https.createServer(tls, (req, res) => {
    req.resume();
    req.once('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ egress })); });
  }));
  const portA = await origin('A'), portB = await origin('B');
  let selected = portA;
  const proxy = async (targetPort) => {
    const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
    server.on('connect', (req, client, head) => {
      if (req.url !== 'opencode.ai:443') { client.destroy(); return; }
      const peer = track(net.connect(targetPort(), '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (head.length) peer.write(head);
        client.pipe(peer); peer.pipe(client);
      }));
      peer.on('error', () => client.destroy());
      client.once('close', () => peer.destroy()); peer.once('close', () => client.destroy());
    });
    return listen(server);
  };
  const mainPort = await proxy(() => selected), childPort = await proxy(() => portB);
  const token = 'loopback-regression-token';
  child = spawn(process.env.BUN_BIN || 'bun', [fileURLToPath(new URL('../server/bun-sidecar.js', import.meta.url))], {
    env: { ...process.env, SIDECAR_TOKEN: token, NODE_EXTRA_CA_CERTS: certFile,
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '', no_proxy: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sidecarPort = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Bun readiness deadline: ' + errors)); }, 15000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error('Bun exited before readiness: ' + code + ' ' + errors)));
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const ready = /SIDECAR_READY (\d+)/.exec(output);
      if (ready) { clearTimeout(timer); resolve(Number(ready[1])); }
    });
  });
  const hit = (proxyPort) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: sidecarPort, path: '/inference/v1/chat/completions', method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'x-sidecar-token': token, 'x-sidecar-proxy': String(proxyPort) }, timeout: 10000 }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; }); res.once('error', reject);
      res.once('end', () => {
        if (res.statusCode !== 200) { reject(new Error('upstream HTTP ' + res.statusCode + ': ' + text)); return; }
        try { resolve(JSON.parse(text).egress); } catch (error) { reject(error); }
      });
    });
    request.once('error', reject); request.once('timeout', () => request.destroy(new Error('request deadline')));
    request.end('{"model":"loopback"}');
  });
  assert.equal(await hit(mainPort), 'A');
  selected = portB;
  assert.equal(await hit(mainPort), 'B', 'selector switched to B, but Bun reused the old A tunnel');
  selected = portA;
  assert.equal(await hit(mainPort), 'A', 'selector switched back to A, but Bun stayed on B');
  console.log('ok  selector changes A → B → A change the actual egress');
  assert.deepEqual(await Promise.all([hit(mainPort), hit(childPort)]), ['A', 'B'], 'concurrent lanes must keep their own egress');
  console.log('ok  concurrent lanes do not share an upstream tunnel');
} finally {
  agent.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
