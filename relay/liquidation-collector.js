// ============================================================================
// Binance USDⓈ-M "forceOrder" liquidation collector (shadow data source)
// ============================================================================
// Holds ONE persistent WebSocket to Binance's all-market liquidation stream
// (`!forceOrder@arr`), keeps the events for the watched symbols in memory, and
// serves them to the Cloudflare Worker over the relay's HTTP API
// (`/liquidations`, see server.js). It replaces the expired CoinGlass
// `/futures/liquidation/order` source for LIQUIDATION CASCADE / GRAVITY - but
// only as a DATA SOURCE. Whether the Worker uses it at all is decided on the
// Worker side (shadow/diagnostic-only until explicitly activated).
//
// SAFETY / ISOLATION
// - Disabled unless LIQ_COLLECTOR_ENABLED=1 (createCollectorFromEnv). Deploying
//   this code without that variable changes nothing for the existing relay.
// - No external dependencies: uses the global WebSocket of Node >= 22. On an
//   older runtime the collector stays disabled and reports why; the existing
//   HTTP proxy endpoints keep working.
// - Every socket callback is wrapped - an exception here can never reach the
//   HTTP server. Memory is bounded (retention window + per-symbol cap).
// - The App Platform health check (`/health`) is NOT tied to the collector, so
//   a Binance outage can never make DigitalOcean restart the relay.
//
// BINANCE STREAM FACTS (developers.binance.com, USDⓈ-M websocket docs)
// - For each symbol only the LATEST liquidation order within 1000ms is pushed
//   as a snapshot -> during cascades volumes are UNDER-COUNTED. We cannot
//   recover the hidden orders; we only measure how often a symbol was
//   "saturated" (events in consecutive seconds) as an indicator.
// - A connection is valid for 24h -> we rotate proactively (overlap + dedupe).
// - The server sends ping frames every 3 minutes; Node's WebSocket answers
//   with pong automatically (verified by the integration test with a real
//   socket). A silent/dead connection is caught by the stale watchdog.
// - No replay/history: anything that happens while disconnected is lost. Such
//   periods are recorded as gaps and reported with every query (`coverage`).
//
// DIRECTION
// `o.S` is the side of the forced (liquidation) order:
//   SELL -> a LONG position was liquidated  (forced selling, bearish pressure)
//   BUY  -> a SHORT position was liquidated (forced buying,  bullish pressure)
// The emitted `side` keeps the Worker's existing calcLiquidationCascade
// convention: 1 = forced BUY (shorts liquidated), 2 = forced SELL (longs
// liquidated). `liquidatedPosition` states it explicitly.
// ============================================================================
'use strict';

const DEFAULT_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';

// Must stay identical to WATCHLIST in worker/worker.js (guarded by a test).
const DEFAULT_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'LTCUSDT', 'SUIUSDT', 'APTUSDT', 'INJUSDT', 'HYPEUSDT', 'RIVERUSDT',
  'TAOUSDT', 'ZECUSDT', 'ONDOUSDT', 'WLDUSDT', 'OPUSDT', 'ARKMUSDT', 'BNBUSDT', 'XRPUSDT', 'LINKUSDT',
  'NEARUSDT', 'ETCUSDT', 'AAVEUSDT', 'RENDERUSDT', 'ALGOUSDT', 'SEIUSDT', 'ARBUSDT', 'JUPUSDT', 'ENAUSDT',
  'PENDLEUSDT', 'WIFUSDT', '1000PEPEUSDT', 'DOGEUSDT', 'AVAXUSDT', 'FETUSDT', 'UBUSDT', 'KASUSDT',
];

const DEFAULTS = {
  retentionMs: 24 * 3600 * 1000,          // events kept in memory
  maxEventsPerSymbol: 5000,               // hard memory cap per symbol
  dedupeWindowMs: 15 * 60 * 1000,         // duplicate keys remembered this long
  rotateAfterMs: (23 * 60 + 30) * 60000,  // proactive reconnect before Binance's 24h cut
  staleAfterMs: 15 * 60 * 1000,           // no message for this long -> assume dead socket
  backoffBaseMs: 1000,
  backoffMaxMs: 60 * 1000,
  stableResetMs: 60 * 1000,               // connection open this long -> backoff resets
  connectTimeoutMs: 20 * 1000,            // handshake not finished -> abort + reconnect
  housekeepingMs: 15 * 1000,
  maxGapsKept: 500,
  maxQueryLimit: 5000,
};

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

function rawToString(raw) {
  if (typeof raw === 'string') return raw;
  if (raw == null) return '';
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw);
}

// Parses ONE forceOrder payload object (already JSON-decoded).
function parseForceOrderPayload(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'not_object' };
  if (msg.e !== 'forceOrder') return { ok: false, reason: 'not_force_order' };
  const o = msg.o;
  if (!o || typeof o !== 'object') return { ok: false, reason: 'missing_order' };
  const symbol = typeof o.s === 'string' ? o.s.toUpperCase() : '';
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) return { ok: false, reason: 'invalid_symbol' };
  const orderSide = o.S;
  if (orderSide !== 'BUY' && orderSide !== 'SELL') return { ok: false, reason: 'invalid_side' };

  const ap = num(o.ap), p = num(o.p);
  let price = null, priceSource = null;
  if (ap > 0) { price = ap; priceSource = 'ap'; } else if (p > 0) { price = p; priceSource = 'p'; }
  if (price == null) return { ok: false, reason: 'invalid_price' };

  const z = num(o.z), l = num(o.l), q = num(o.q);
  let qty = null, qtySource = null;
  if (z > 0) { qty = z; qtySource = 'z'; } else if (l > 0) { qty = l; qtySource = 'l'; } else if (q > 0) { qty = q; qtySource = 'q'; }
  if (qty == null) return { ok: false, reason: 'invalid_qty' };

  const T = num(o.T), E = num(msg.E);
  const time = T > 0 ? T : (E > 0 ? E : NaN);
  if (!(time > 0)) return { ok: false, reason: 'invalid_time' };

  const usdValue = price * qty;
  if (!(usdValue > 0) || !Number.isFinite(usdValue)) return { ok: false, reason: 'invalid_usd' };

  return {
    ok: true,
    event: {
      symbol,
      orderSide,
      liquidatedPosition: orderSide === 'SELL' ? 'long' : 'short',
      side: orderSide === 'BUY' ? 1 : 2,
      price, qty, usdValue, time,
      eventTime: E > 0 ? E : null,
      status: typeof o.X === 'string' ? o.X : null,
      priceSource, qtySource,
    },
  };
}

// Parses a raw WebSocket message: raw stream object, combined-stream wrapper
// ({stream, data}), or an array of payloads. Returns { events, errors }.
function parseForceOrderMessage(raw) {
  let msg;
  try { msg = JSON.parse(rawToString(raw)); } catch (e) { return { events: [], errors: ['invalid_json'] }; }
  if (msg && typeof msg === 'object' && !Array.isArray(msg) && 'data' in msg && 'stream' in msg) msg = msg.data;
  const items = Array.isArray(msg) ? msg : [msg];
  const events = [], errors = [];
  for (const it of items) {
    const r = parseForceOrderPayload(it);
    if (r.ok) events.push(r.event); else errors.push(r.reason);
  }
  return { events, errors };
}

function dedupeKey(ev) {
  return `${ev.symbol}|${ev.time}|${ev.orderSide}|${ev.qty}|${ev.price}`;
}

function emptySymbolStats() {
  return { events: 0, buyUsd: 0, sellUsd: 0, maxUsd: 0, lastEventAt: null, saturatedEvents: 0, evictedByCap: 0 };
}

class LiquidationCollector {
  constructor(options = {}) {
    const o = { ...DEFAULTS, ...options };
    this.opts = o;
    this.url = o.url || DEFAULT_WS_URL;
    this.WebSocketImpl = o.WebSocketImpl;
    this.symbols = new Set((o.symbols || DEFAULT_SYMBOLS).map(s => String(s).toUpperCase()));
    this.now = o.now || (() => Date.now());
    this.setTimeout = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeout = o.clearTimeout || ((t) => clearTimeout(t));
    this.random = o.random || Math.random;
    this.logger = o.logger || { log() {}, warn() {}, error() {} };

    this.started = false;
    this.stopping = false;
    this.ws = null;            // active socket
    this.pendingWs = null;     // socket being opened during a 24h rotation
    this.intentional = new WeakSet();
    this.reconnectTimer = null;
    this.housekeepingTimer = null;
    this.attempt = 0;

    this.store = new Map();    // symbol -> events[] (time ascending)
    this.evictedBefore = new Map(); // symbol -> newest evicted time (coverage)
    this.dedupe = new Map();   // key -> expiresAt
    this.lastSecond = new Map(); // symbol -> last event second (saturation indicator)

    this.stats = {
      startedAt: null, firstOpenAt: null,
      messages: 0, eventsParsed: 0, eventsAccepted: 0, filteredSymbol: 0, duplicates: 0,
      invalid: {}, handlerErrors: 0,
      perSymbol: {},
    };
    this.conn = {
      state: 'idle', connects: 0, disconnects: 0, reconnectAttempts: 0, rotations: 0,
      rotationFailures: 0, staleReconnects: 0, openedAt: null, lastCloseAt: null, lastCloseCode: null,
      lastCloseReason: null, lastMessageAt: null, lastError: null, nextReconnectInMs: null,
    };
    this.gaps = [];          // { from, to|null, reason }
    this.totalGapMs = 0;
  }

  // ---- lifecycle ---------------------------------------------------------
  start() {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.stats.startedAt = this.now();
    this._openGap('startup', this.stats.startedAt);
    this._connect('start');
    this._scheduleHousekeeping();
  }

  stop() {
    this.stopping = true;
    if (this.reconnectTimer) { this.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.housekeepingTimer) { this.clearTimeout(this.housekeepingTimer); this.housekeepingTimer = null; }
    for (const ws of [this.ws, this.pendingWs]) if (ws) this._closeIntentionally(ws, 1000, 'stop');
    this.ws = null; this.pendingWs = null;
    this.conn.state = 'stopped';
    this._openGap('stopped', this.now());
  }

  _createSocket() {
    const ws = new this.WebSocketImpl(this.url);
    try { ws.binaryType = 'arraybuffer'; } catch (e) { /* not supported by impl */ }
    return ws;
  }

  _connect(reason) {
    if (this.stopping) return;
    this.reconnectTimer = null;
    this.conn.nextReconnectInMs = null;
    this.conn.state = 'connecting';
    if (reason !== 'start') this.conn.reconnectAttempts++;
    let ws;
    try {
      ws = this._createSocket();
    } catch (e) {
      this.conn.lastError = `create: ${e && e.message ? e.message : e}`;
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    this._bind(ws, false);
    this._armConnectTimeout(ws);
  }

  // A handshake that never completes (or a refused connection on runtimes that
  // emit only `error`) must not leave the collector stuck in 'connecting'.
  _armConnectTimeout(ws) {
    const timer = this.setTimeout(() => {
      if (this.intentional.has(ws)) return;
      if ((ws === this.ws && this.conn.state === 'connecting') || ws === this.pendingWs) {
        this.conn.lastError = 'connect timeout';
        this._socketDown(ws, null, 'connect_timeout');
      }
    }, this.opts.connectTimeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  _bind(ws, isRotation) {
    const guard = (fn) => (...args) => { try { fn(...args); } catch (e) { this.stats.handlerErrors++; this.conn.lastError = `handler: ${e && e.message ? e.message : e}`; } };
    ws.onopen = guard(() => this._onOpen(ws, isRotation));
    ws.onmessage = guard((ev) => this._onMessage(ws, ev && ev.data !== undefined ? ev.data : ev));
    // VERIFIED (integration test): Node's built-in WebSocket emits ONLY `error`
    // (no `close`) for a refused connection - so `error` is handled as "down".
    ws.onerror = guard((ev) => {
      this.conn.lastError = `socket: ${ev && ev.message ? ev.message : (ev && ev.error && ev.error.message) || 'error'}`;
      this._socketDown(ws, null, 'error');
    });
    ws.onclose = guard((ev) => this._socketDown(ws, (ev || {}).code, (ev || {}).reason));
  }

  _onOpen(ws, isRotation) {
    const t = this.now();
    if (isRotation) {
      if (ws !== this.pendingWs) { this._closeIntentionally(ws, 1000, 'superseded'); return; }
      const old = this.ws;
      this.ws = ws;
      this.pendingWs = null;
      this.conn.rotations++;
      if (old) this._closeIntentionally(old, 1000, 'rotated');
    } else if (ws !== this.ws) {
      this._closeIntentionally(ws, 1000, 'superseded');
      return;
    }
    this.conn.state = 'open';
    this.conn.connects++;
    this.conn.openedAt = t;
    this.conn.lastMessageAt = this.conn.lastMessageAt && this.conn.lastMessageAt > t ? this.conn.lastMessageAt : t;
    if (!this.stats.firstOpenAt) this.stats.firstOpenAt = t;
    this._closeGap(t);
  }

  _onMessage(ws, data) {
    if (ws !== this.ws && ws !== this.pendingWs) return;
    const t = this.now();
    this.conn.lastMessageAt = t;
    this.stats.messages++;
    const { events, errors } = parseForceOrderMessage(data);
    for (const r of errors) {
      if (r === 'not_force_order') continue; // e.g. subscription acks - not an error
      this.stats.invalid[r] = (this.stats.invalid[r] || 0) + 1;
    }
    for (const ev of events) this._ingest(ev, t);
  }

  // Single path for every way a socket can go down (close, error, connect
  // timeout). Idempotent: the socket is marked intentional first, so a later
  // close/error event for the same socket is ignored.
  _socketDown(ws, code, reason) {
    if (this.intentional.has(ws)) return;
    if (ws === this.pendingWs) {
      // rotation attempt failed before replacing the active socket - keep the old one
      this.pendingWs = null;
      this.conn.rotationFailures++;
      this._closeIntentionally(ws, 1000, 'rotation_failed');
      return;
    }
    if (ws !== this.ws) return;
    const t = this.now();
    this.ws = null;
    this._closeIntentionally(ws, 1000, 'down');
    this.conn.state = 'disconnected';
    this.conn.disconnects++;
    this.conn.lastCloseAt = t;
    this.conn.lastCloseCode = code != null ? code : null;
    this.conn.lastCloseReason = reason ? String(reason).slice(0, 200) : null;
    this._openGap(code != null ? `close:${code}` : (reason || 'close'), t);
    this._scheduleReconnect();
  }

  _closeIntentionally(ws, code, reason) {
    this.intentional.add(ws);
    try { ws.close(code, reason); } catch (e) { /* already closed */ }
  }

  _scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    this.attempt++;
    const exp = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * Math.pow(2, this.attempt - 1));
    const jitter = 0.8 + this.random() * 0.4; // ±20%
    const delay = Math.round(Math.min(this.opts.backoffMaxMs, exp * jitter));
    this.conn.nextReconnectInMs = delay;
    this.reconnectTimer = this.setTimeout(() => this._connect('reconnect'), delay);
  }

  // ---- housekeeping: backoff reset, stale watchdog, 24h rotation, pruning --
  _scheduleHousekeeping() {
    if (this.stopping) return;
    this.housekeepingTimer = this.setTimeout(() => {
      try { this.housekeeping(); } catch (e) { this.stats.handlerErrors++; }
      this._scheduleHousekeeping();
    }, this.opts.housekeepingMs);
    if (this.housekeepingTimer && typeof this.housekeepingTimer.unref === 'function') this.housekeepingTimer.unref();
  }

  housekeeping() {
    const t = this.now();
    if (this.conn.state === 'open') {
      if (this.conn.openedAt != null && t - this.conn.openedAt >= this.opts.stableResetMs) this.attempt = 0;
      // stale watchdog: a dead TCP connection can look "open" forever
      if (this.conn.lastMessageAt != null && t - this.conn.lastMessageAt >= this.opts.staleAfterMs && this.ws) {
        const dead = this.ws;
        this.ws = null;
        this.conn.state = 'disconnected';
        this.conn.staleReconnects++;
        this.conn.disconnects++;
        this.conn.lastCloseAt = t;
        this.conn.lastCloseCode = null;
        this.conn.lastCloseReason = 'stale';
        // conservative: data since the last message may be lost
        this._openGap('stale', this.conn.lastMessageAt);
        this._closeIntentionally(dead, 4000, 'stale');
        this._scheduleReconnect();
      } else if (this.conn.openedAt != null && t - this.conn.openedAt >= this.opts.rotateAfterMs && !this.pendingWs) {
        this._rotate();
      }
    }
    this.prune(t);
  }

  _rotate() {
    let ws;
    try { ws = this._createSocket(); } catch (e) { this.conn.rotationFailures++; return; }
    this.pendingWs = ws;
    this._bind(ws, true);
    this._armConnectTimeout(ws);
  }

  // ---- storage ------------------------------------------------------------
  _ingest(ev, receivedAt) {
    this.stats.eventsParsed++;
    if (!this.symbols.has(ev.symbol)) { this.stats.filteredSymbol++; return; }
    const key = dedupeKey(ev);
    if (this.dedupe.has(key)) { this.stats.duplicates++; return; }
    this.dedupe.set(key, receivedAt + this.opts.dedupeWindowMs);

    let arr = this.store.get(ev.symbol);
    if (!arr) { arr = []; this.store.set(ev.symbol, arr); }
    const rec = { side: ev.side, liquidatedPosition: ev.liquidatedPosition, usdValue: ev.usdValue, price: ev.price, qty: ev.qty, time: ev.time, receivedAt };
    if (!arr.length || arr[arr.length - 1].time <= rec.time) arr.push(rec);
    else {
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].time <= rec.time) lo = mid + 1; else hi = mid; }
      arr.splice(lo, 0, rec);
    }
    const st = this.stats.perSymbol[ev.symbol] || (this.stats.perSymbol[ev.symbol] = emptySymbolStats());
    if (arr.length > this.opts.maxEventsPerSymbol) {
      const removed = arr.splice(0, arr.length - this.opts.maxEventsPerSymbol);
      st.evictedByCap += removed.length;
      const newest = removed[removed.length - 1].time;
      if (!(this.evictedBefore.get(ev.symbol) >= newest)) this.evictedBefore.set(ev.symbol, newest);
    }
    this.stats.eventsAccepted++;
    st.events++;
    if (ev.side === 1) st.buyUsd += ev.usdValue; else st.sellUsd += ev.usdValue;
    if (ev.usdValue > st.maxUsd) st.maxUsd = ev.usdValue;
    st.lastEventAt = ev.time;
    // saturation indicator: an event in the second right after the previous one
    // means the 1000ms snapshot window was busy -> hidden orders are likely.
    const sec = Math.floor(ev.time / 1000);
    const prevSec = this.lastSecond.get(ev.symbol);
    if (prevSec != null && sec - prevSec <= 1) st.saturatedEvents++;
    this.lastSecond.set(ev.symbol, sec);
  }

  prune(t = this.now()) {
    const cutoff = t - this.opts.retentionMs;
    for (const [sym, arr] of this.store) {
      let i = 0;
      while (i < arr.length && arr[i].time < cutoff) i++;
      if (i) arr.splice(0, i);
    }
    for (const [k, exp] of this.dedupe) if (exp <= t) this.dedupe.delete(k);
    if (this.gaps.length > this.opts.maxGapsKept) this.gaps.splice(0, this.gaps.length - this.opts.maxGapsKept);
  }

  // ---- gaps / coverage ----------------------------------------------------
  _openGap(reason, from) {
    const last = this.gaps[this.gaps.length - 1];
    if (last && last.to == null) return; // already in a gap
    this.gaps.push({ from, to: null, reason });
  }

  _closeGap(to) {
    const last = this.gaps[this.gaps.length - 1];
    if (last && last.to == null) {
      last.to = to;
      this.totalGapMs += Math.max(0, to - last.from);
    }
  }

  coverage(symbol, since, t = this.now()) {
    const reasons = [];
    if (!this.stats.firstOpenAt) reasons.push('never_connected');
    else if (since < this.stats.firstOpenAt) reasons.push('before_collector_start');
    if (since < t - this.opts.retentionMs) reasons.push('beyond_retention');
    const ev = this.evictedBefore.get(symbol);
    if (ev != null && since <= ev) reasons.push('evicted_by_cap');
    // inclusive overlap: a gap that started in the same ms as the query still counts
    const overlapping = this.gaps.filter(g => g.reason !== 'startup' && g.from <= t && (g.to == null ? t : g.to) >= since)
      .map(g => ({ from: g.from, to: g.to, reason: g.reason }));
    if (overlapping.length) reasons.push('gap');
    if (this.conn.state !== 'open') reasons.push('not_connected');
    return { complete: reasons.length === 0, reasons, gaps: overlapping, connected: this.conn.state === 'open', collectorStartedAt: this.stats.startedAt, firstOpenAt: this.stats.firstOpenAt };
  }

  // Events with time >= since (oldest first, at most `limit`).
  query(symbol, since, { limit = this.opts.maxQueryLimit } = {}) {
    const t = this.now();
    const sym = String(symbol || '').toUpperCase();
    const lim = Math.max(1, Math.min(this.opts.maxQueryLimit, Number(limit) || this.opts.maxQueryLimit));
    const s = Number.isFinite(Number(since)) ? Number(since) : t - 20 * 60000;
    const arr = this.store.get(sym) || [];
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].time < s) lo = mid + 1; else hi = mid; }
    const slice = arr.slice(lo, lo + lim);
    const truncated = lo + lim < arr.length;
    return {
      symbol: sym, since: s, now: t, count: slice.length, truncated,
      nextSince: truncated ? slice[slice.length - 1].time : null,
      events: slice.map(e => ({ side: e.side, liquidatedPosition: e.liquidatedPosition, usdValue: e.usdValue, price: e.price, qty: e.qty, time: e.time })),
      coverage: this.coverage(sym, s, t),
    };
  }

  getStats() {
    const t = this.now();
    let stored = 0;
    for (const arr of this.store.values()) stored += arr.length;
    const openGap = this.gaps.length && this.gaps[this.gaps.length - 1].to == null ? this.gaps[this.gaps.length - 1] : null;
    return {
      enabled: true, url: this.url, symbols: this.symbols.size, now: t, runtime: process.version,
      uptimeMs: this.stats.startedAt ? t - this.stats.startedAt : 0,
      connection: { ...this.conn, rotating: !!this.pendingWs, backoffAttempt: this.attempt },
      events: {
        messages: this.stats.messages, parsed: this.stats.eventsParsed, accepted: this.stats.eventsAccepted,
        filteredSymbol: this.stats.filteredSymbol, duplicates: this.stats.duplicates, invalid: this.stats.invalid,
        handlerErrors: this.stats.handlerErrors, stored, dedupeKeys: this.dedupe.size,
      },
      gaps: {
        count: this.gaps.filter(g => g.reason !== 'startup').length,
        totalGapMs: this.totalGapMs + (openGap ? Math.max(0, t - openGap.from) : 0),
        open: openGap, recent: this.gaps.slice(-20),
      },
      perSymbol: this.stats.perSymbol,
      limits: { snapshotPerSymbolMs: 1000, retentionMs: this.opts.retentionMs, maxEventsPerSymbol: this.opts.maxEventsPerSymbol },
    };
  }
}

// Builds the collector from environment variables. Returns
// { collector: LiquidationCollector|null, disabledReason: string|null }.
function createCollectorFromEnv(env = process.env, { WebSocketImpl = globalThis.WebSocket, logger = console, overrides = {} } = {}) {
  if (String(env.LIQ_COLLECTOR_ENABLED || '').trim() !== '1') return { collector: null, disabledReason: 'LIQ_COLLECTOR_ENABLED is not 1' };
  if (typeof WebSocketImpl !== 'function') return { collector: null, disabledReason: `no global WebSocket in Node ${process.version} (needs Node >= 22)` };
  const symbols = (env.LIQ_SYMBOLS || '').trim()
    ? env.LIQ_SYMBOLS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_SYMBOLS;
  const collector = new LiquidationCollector({ url: (env.LIQ_WS_URL || '').trim() || DEFAULT_WS_URL, WebSocketImpl, symbols, logger, ...overrides });
  return { collector, disabledReason: null };
}

module.exports = {
  LiquidationCollector, createCollectorFromEnv, parseForceOrderMessage, parseForceOrderPayload,
  dedupeKey, DEFAULT_SYMBOLS, DEFAULT_WS_URL, DEFAULTS,
};
