// BINANCE forceOrder COLLECTOR - ИНТЕГРАЦИОННИ тестове с РЕАЛЕН Node WebSocket
// (вграденият в Node >= 22) срещу локален минимален RFC 6455 сървър, който
// имитира Binance (`!forceOrder@arr`). Без външна мрежа. Покрива:
// - реално свързване, получаване, филтриране и дублиране;
// - ping frame от сървъра -> автоматичен pong от клиента (payload echo);
// - внезапно прекъсване (TCP destroy) и close frame -> reconnect + gap;
// - 24ч ротация с реални сокети (overlap без загуба/дублиране);
// - `relay/server.js` като отделен процес: изключен по подразбиране,
//   /health и съществуващите endpoint-и не се влияят от колектора.
import { describe, it, expect } from 'vitest';
import http from 'http';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { LiquidationCollector } = require('./relay/liquidation-collector.js');
import { fetchLiquidationOrdersRelayDiag, applyLiqShadowStep } from './worker/worker.js';

const HAS_WS = typeof globalThis.WebSocket === 'function';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 4000, step = 20 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout');
    await sleep(step);
  }
}

// ---- minimal RFC 6455 server (fake Binance) --------------------------------
function frame(opcode, payload = Buffer.alloc(0)) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let head;
  if (p.length < 126) head = Buffer.from([0x80 | opcode, p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([head, p]);
}
function startFakeBinance(fixedPort = 0) {
  const conns = [];
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = { socket, path: req.url, pongs: [], closed: false, buf: Buffer.alloc(0) };
    socket.on('data', (d) => {
      conn.buf = Buffer.concat([conn.buf, d]);
      while (conn.buf.length >= 2) {
        const op = conn.buf[0] & 0x0f; let len = conn.buf[1] & 0x7f; let off = 2;
        if (len === 126) { len = conn.buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(conn.buf.readBigUInt64BE(2)); off = 10; }
        const masked = (conn.buf[1] & 0x80) !== 0;
        const need = off + (masked ? 4 : 0) + len;
        if (conn.buf.length < need) break;
        let payload = conn.buf.subarray(off + (masked ? 4 : 0), need);
        if (masked) { const m = conn.buf.subarray(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4])); }
        conn.buf = conn.buf.subarray(need);
        if (op === 0xA) conn.pongs.push(payload.toString());
        if (op === 0x8) { try { socket.write(frame(0x8, payload.subarray(0, 2))); } catch (e) {} socket.end(); }
      }
    });
    socket.on('close', () => { conn.closed = true; });
    socket.on('error', () => {});
    conn.send = (obj) => socket.write(frame(0x1, typeof obj === 'string' ? obj : JSON.stringify(obj)));
    conn.ping = (p) => socket.write(frame(0x9, p));
    conn.closeWith = (code) => { const b = Buffer.alloc(2); b.writeUInt16BE(code); socket.write(frame(0x8, b)); };
    conn.destroy = () => socket.destroy();
    conns.push(conn);
  });
  return new Promise(resolve => server.listen(fixedPort, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ port, url: `ws://127.0.0.1:${port}/market/ws/!forceOrder@arr`, conns, open: () => conns.filter(c => !c.closed),
      close: () => new Promise(r => { conns.forEach(c => c.destroy()); server.close(() => r()); }) });
  }));
}
const fo = (o = {}) => ({ e: 'forceOrder', E: Date.now(), o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '0.01', p: '99000', ap: '100000', X: 'FILLED', l: '0.01', z: '0.01', T: Date.now(), ...o } });

function realCollector(url, extra = {}) {
  return new LiquidationCollector({ url, WebSocketImpl: globalThis.WebSocket, backoffBaseMs: 50, backoffMaxMs: 200, housekeepingMs: 30, ...extra });
}

describe('реален Node WebSocket срещу фалшив Binance', { skip: !HAS_WS, timeout: 20000 }, () => {
  it('свързване по документирания path, получаване, филтриране, дубликати', async () => {
    const fb = await startFakeBinance();
    const c = realCollector(fb.url);
    try {
      c.start();
      await waitFor(() => c.getStats().connection.state === 'open' && fb.open().length === 1);
      expect(fb.conns[0].path).toBe('/market/ws/!forceOrder@arr');
      const e = fo({ T: Date.now(), S: 'BUY', z: '2', ap: '50000' });
      fb.conns[0].send(e); fb.conns[0].send(e);
      fb.conns[0].send(fo({ s: 'NOTWATCHEDUSDT' }));
      fb.conns[0].send('{broken');
      await waitFor(() => c.getStats().events.messages >= 4);
      const q = c.query('BTCUSDT', Date.now() - 60000);
      expect(q.count).toBe(1);
      expect(q.events[0]).toEqual({ side: 1, liquidatedPosition: 'short', usdValue: 100000, price: 50000, qty: 2, time: e.o.T });
      const s = c.getStats().events;
      expect(s.duplicates).toBe(1);
      expect(s.filteredSymbol).toBe(1);
      expect(s.invalid.invalid_json).toBe(1);
    } finally { c.stop(); await fb.close(); }
  });

  it('ping frame -> автоматичен pong със същия payload (Binance изисква pong)', async () => {
    const fb = await startFakeBinance();
    const c = realCollector(fb.url);
    try {
      c.start();
      await waitFor(() => fb.open().length === 1 && c.getStats().connection.state === 'open');
      fb.conns[0].ping('hb-1700');
      await waitFor(() => fb.conns[0].pongs.length >= 1);
      expect(fb.conns[0].pongs[0]).toBe('hb-1700');
      expect(c.getStats().connection.state).toBe('open');
    } finally { c.stop(); await fb.close(); }
  });

  it('внезапно прекъсване (TCP destroy) -> gap -> reconnect -> данните продължават', async () => {
    const fb = await startFakeBinance();
    const c = realCollector(fb.url);
    try {
      c.start();
      await waitFor(() => fb.open().length === 1 && c.getStats().connection.state === 'open');
      const before = Date.now();
      fb.conns[0].destroy();
      await waitFor(() => c.getStats().connection.disconnects === 1);
      await waitFor(() => fb.open().length === 1 && fb.conns.length === 2 && c.getStats().connection.state === 'open');
      const st = c.getStats();
      expect(st.gaps.count).toBe(1);
      expect(st.gaps.recent.at(-1).to).not.toBeNull();
      expect(c.query('BTCUSDT', before - 1000).coverage.reasons).toContain('gap');
      fb.conns[1].send(fo({ T: Date.now() }));
      await waitFor(() => c.query('BTCUSDT', 0).count === 1);
      await sleep(5);
      expect(c.query('BTCUSDT', Date.now()).coverage.complete).toBe(true);
    } finally { c.stop(); await fb.close(); }
  });

  it('close frame от сървъра (1001) -> reconnect, lastCloseCode записан', async () => {
    const fb = await startFakeBinance();
    const c = realCollector(fb.url);
    try {
      c.start();
      await waitFor(() => fb.open().length === 1 && c.getStats().connection.state === 'open');
      fb.conns[0].closeWith(1001);
      await waitFor(() => c.getStats().connection.lastCloseCode === 1001);
      await waitFor(() => fb.conns.length === 2 && c.getStats().connection.state === 'open');
      expect(c.getStats().connection.reconnectAttempts).toBeGreaterThanOrEqual(1);
    } finally { c.stop(); await fb.close(); }
  });

  it('сървърът е недостъпен -> backoff опити, без изключение; появява се -> свързва се', async () => {
    const probe = net.createServer();
    const port = await new Promise(r => probe.listen(0, '127.0.0.1', () => r(probe.address().port)));
    await new Promise(r => probe.close(r));
    const c = realCollector(`ws://127.0.0.1:${port}/market/ws/!forceOrder@arr`);
    let fb = null;
    try {
      c.start();
      await waitFor(() => c.getStats().connection.reconnectAttempts >= 2);
      expect(c.getStats().connection.state).not.toBe('open');
      expect(c.getStats().gaps.open).not.toBeNull();
      fb = await startFakeBinance(port);                      // Binance се появява на същия порт
      await waitFor(() => c.getStats().connection.state === 'open', { timeout: 5000 });
      expect(c.getStats().gaps.open).toBeNull();
    } finally { c.stop(); if (fb) await fb.close(); }
  });

  it('24ч ротация с реални сокети: нова връзка преди затваряне на старата, без gap', async () => {
    const fb = await startFakeBinance();
    const c = realCollector(fb.url, { rotateAfterMs: 300 });
    try {
      c.start();
      await waitFor(() => fb.open().length === 1 && c.getStats().connection.state === 'open');
      await waitFor(() => c.getStats().connection.rotations >= 1, { timeout: 3000 });
      c.opts.rotateAfterMs = 1e9; // stop further rotations
      await waitFor(() => fb.open().length === 1);
      const e = fo({ T: Date.now() });
      for (const conn of fb.open()) conn.send(e);
      await waitFor(() => c.query('BTCUSDT', 0).count === 1);
      expect(c.getStats().gaps.count).toBe(0);
      expect(fb.conns[0].closed).toBe(true);
    } finally { c.stop(); await fb.close(); }
  });
});

// ---- relay/server.js като отделен процес ------------------------------------
async function freePort() {
  const s = net.createServer();
  const p = await new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
  await new Promise(r => s.close(r));
  return p;
}
async function startRelay(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['relay/server.js'], { env: { PATH: process.env.PATH, PORT: String(port), RELAY_TOKEN: 'tkn', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  await waitFor(() => out.includes('Relay listening'));
  const get = async (path) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, body: await r.json() }; };
  return { get, child, base: `http://127.0.0.1:${port}`, log: () => out, stop: () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); }) };
}

describe('relay/server.js процес - изолация на колектора', { timeout: 20000 }, () => {
  it('по подразбиране: колекторът е изключен, /health непроменен, /liquidations -> 503', async () => {
    const relay = await startRelay({});
    try {
      expect(await relay.get('/health')).toEqual({ status: 200, body: { ok: true } });
      expect(await relay.get('/')).toEqual({ status: 200, body: { ok: true } });
      expect((await relay.get('/liquidations?symbol=BTCUSDT')).status).toBe(401);
      const r = await relay.get('/liquidations?symbol=BTCUSDT&token=tkn');
      expect(r.status).toBe(503);
      expect(r.body.enabled).toBe(false);
      expect((await relay.get('/klines?token=tkn')).status).toBe(400);   // съществуващ endpoint, непроменен
      expect((await relay.get('/klines?symbol=BTCUSDT')).status).toBe(401);
      expect(relay.log()).toContain('Liquidation collector: disabled');
    } finally { await relay.stop(); }
  });

  it('включен: събира от фалшив Binance; Binance пада -> /health остава 200, relay-ят работи', { skip: !HAS_WS, timeout: 20000 }, async () => {
    const fb = await startFakeBinance();
    const relay = await startRelay({ LIQ_COLLECTOR_ENABLED: '1', LIQ_WS_URL: fb.url });
    try {
      await waitFor(async () => (await relay.get('/liquidations/stats?token=tkn')).body.connection?.state === 'open');
      fb.conns[0].send(fo({ s: '1000PEPEUSDT', S: 'SELL', ap: '0.012', z: '1000000', T: Date.now() }));
      const q = await waitFor(async () => { const r = await relay.get(`/liquidations?symbol=1000PEPEUSDT&since=${Date.now() - 60000}&token=tkn`); return r.body.count === 1 && r; });
      expect(q.body.events[0].liquidatedPosition).toBe('long');
      expect(q.body.events[0].usdValue).toBeCloseTo(12000, 6);
      expect(q.body.coverage.connected).toBe(true);
      expect((await relay.get('/liquidations?symbol=FOOUSDT&token=tkn')).status).toBe(400);
      expect((await relay.get('/liquidations?token=tkn')).status).toBe(400);
      expect((await relay.get('/liquidations?symbol=BTCUSDT&since=abc&token=tkn')).status).toBe(400);
      await fb.close();                                            // Binance изчезва
      await waitFor(async () => (await relay.get('/liquidations/stats?token=tkn')).body.connection.state !== 'open');
      expect(await relay.get('/health')).toEqual({ status: 200, body: { ok: true } });
      expect((await relay.get('/klines?token=tkn')).status).toBe(400);
      const cov = (await relay.get(`/liquidations?symbol=1000PEPEUSDT&since=${Date.now() - 60000}&token=tkn`)).body.coverage;
      expect(cov.complete).toBe(false);
      expect(relay.child.exitCode).toBeNull();
      expect(relay.log()).not.toContain('tkn');
    } finally { await relay.stop(); }
  });
});

describe('PIPELINE: фалшив Binance -> relay процес -> Worker shadow fetcher', { skip: !HAS_WS, timeout: 20000 }, () => {
  it('ликвидация на LONG (SELL) стига до Worker-а като side=2 и влиза в shadow CASCADE', async () => {
    const fb = await startFakeBinance();
    const relay = await startRelay({ LIQ_COLLECTOR_ENABLED: '1', LIQ_WS_URL: fb.url });
    try {
      await waitFor(async () => (await relay.get('/liquidations/stats?token=tkn')).body.connection?.state === 'open');
      const port = new URL(relay.base).port;
      const T = Date.now() - 5000;
      fb.conns[0].send(fo({ s: 'ETHUSDT', S: 'SELL', ap: '3000', z: '200', T }));   // 600k USD longs liquidated
      const env = { RELAY_URL: `http://127.0.0.1:${port}`, RELAY_TOKEN: 'tkn' };
      const r = await waitFor(async () => { const x = await fetchLiquidationOrdersRelayDiag(env, 'ETHUSDT', { fetchImpl: (u) => fetch(u) }); return x.count === 1 && x; });
      expect(r.status).toBe('ok');
      expect(r.orders[0].side).toBe(2);
      expect(r.orders[0].usdValue).toBe(600000);
      expect(r.coverageComplete).toBe(false);          // прозорецът започва преди старта на колектора
      expect(r.coverageReasons).toContain('before_collector_start');
      const { diag } = applyLiqShadowStep(null, r, { price: 3000 });
      expect(diag.events.some(e => e.kind === 'cascade' && e.direction === 'short')).toBe(true);
    } finally { await relay.stop(); await fb.close(); }
  });
});
