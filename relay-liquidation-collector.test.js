// BINANCE forceOrder LIQUIDATION COLLECTOR (relay/liquidation-collector.js) -
// unit тестове с фалшив WebSocket + ръчен часовник (детерминистично, без
// мрежа). Покрива: нормална работа, посока, прекъсване, повторно свързване с
// backoff, 24ч ротация с overlap, stale watchdog, дублирани събития,
// неправилни данни, памет/retention, coverage/gaps и статистика.
// Интеграционните тестове с РЕАЛЕН Node WebSocket са в
// relay-liquidation-collector.integration.test.js.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  LiquidationCollector, createCollectorFromEnv, parseForceOrderMessage, parseForceOrderPayload,
  dedupeKey, DEFAULT_SYMBOLS, DEFAULT_WS_URL,
} = require('./relay/liquidation-collector.js');

// ---- test doubles ----------------------------------------------------------
function makeClock(start = 1800000000000) {
  let now = start;
  let seq = 0;
  const timers = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const t = { id: ++seq, at: now + ms, fn }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = end;
    },
    pending: () => timers.length,
  };
}

function makeFakeWs() {
  const instances = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.closed = false; this.closeCalls = []; instances.push(this); }
    close(code, reason) { this.closeCalls.push({ code, reason }); this.closed = true; if (this.onclose) this.onclose({ code: code ?? 1005, reason }); }
    // test helpers (server side)
    open() { this.onopen && this.onopen({}); }
    send(obj) { this.onmessage && this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
    drop(code = 1006, reason = '') { this.closed = true; this.onclose && this.onclose({ code, reason }); }
  }
  return { FakeWebSocket, instances };
}

const fo = (o = {}, top = {}) => ({
  e: 'forceOrder', E: 1800000000500,
  o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '0.010', p: '99000', ap: '100000', X: 'FILLED', l: '0.010', z: '0.010', T: 1800000000400, ...o },
  ...top,
});

function setup(extra = {}) {
  const clock = makeClock();
  const { FakeWebSocket, instances } = makeFakeWs();
  const c = new LiquidationCollector({
    WebSocketImpl: FakeWebSocket, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    random: () => 0.5, ...extra,
  });
  return { c, clock, instances };
}

// ---- parsing & direction -------------------------------------------------
describe('parseForceOrderMessage - формат и посока', () => {
  it('SELL -> ликвидиран LONG, side=2; BUY -> ликвидиран SHORT, side=1 (конвенцията на Worker-а)', () => {
    const sell = parseForceOrderMessage(JSON.stringify(fo({ S: 'SELL' }))).events[0];
    expect(sell.liquidatedPosition).toBe('long');
    expect(sell.side).toBe(2);
    const buy = parseForceOrderMessage(JSON.stringify(fo({ S: 'BUY' }))).events[0];
    expect(buy.liquidatedPosition).toBe('short');
    expect(buy.side).toBe(1);
  });

  it('USD = средна цена (ap) x изпълнено количество (z); време = T', () => {
    const ev = parseForceOrderMessage(JSON.stringify(fo({ ap: '100000', z: '0.5', T: 1800000001234 }))).events[0];
    expect(ev.usdValue).toBe(50000);
    expect(ev.price).toBe(100000);
    expect(ev.qty).toBe(0.5);
    expect(ev.time).toBe(1800000001234);
    expect(ev.priceSource).toBe('ap');
    expect(ev.qtySource).toBe('z');
  });

  it('fallback: ap=0 -> p; z=0 -> l -> q; T липсва -> E', () => {
    const ev = parseForceOrderMessage(JSON.stringify(fo({ ap: '0', p: '2000', z: '0', l: '0', q: '3', T: undefined }, { E: 1800000009999 }))).events[0];
    expect(ev.price).toBe(2000);
    expect(ev.qty).toBe(3);
    expect(ev.usdValue).toBe(6000);
    expect(ev.time).toBe(1800000009999);
  });

  it('combined-stream обвивка {stream, data}, масив от payload-и и Buffer/ArrayBuffer вход', () => {
    expect(parseForceOrderMessage(JSON.stringify({ stream: '!forceOrder@arr', data: fo() })).events).toHaveLength(1);
    expect(parseForceOrderMessage(JSON.stringify([fo(), fo({ s: 'ETHUSDT' })])).events).toHaveLength(2);
    expect(parseForceOrderMessage(Buffer.from(JSON.stringify(fo()))).events).toHaveLength(1);
    const ab = new TextEncoder().encode(JSON.stringify(fo())).buffer;
    expect(parseForceOrderMessage(ab).events).toHaveLength(1);
  });

  it('неправилни данни -> конкретна причина, без изключение', () => {
    const reason = (x) => parseForceOrderMessage(typeof x === 'string' ? x : JSON.stringify(x)).errors[0];
    expect(reason('{not json')).toBe('invalid_json');
    expect(reason({ result: null, id: 1 })).toBe('not_force_order');
    expect(reason({ e: 'forceOrder' })).toBe('missing_order');
    expect(reason(fo({ s: '' }))).toBe('invalid_symbol');
    expect(reason(fo({ s: 'BTC USDT' }))).toBe('invalid_symbol');
    expect(reason(fo({ S: 'HOLD' }))).toBe('invalid_side');
    expect(reason(fo({ ap: 'x', p: '-1' }))).toBe('invalid_price');
    expect(reason(fo({ z: '0', l: '0', q: 'NaN' }))).toBe('invalid_qty');
    expect(reason(fo({ T: 0 }, { E: 0 }))).toBe('invalid_time');
    expect(reason(fo({ ap: '1e308', z: '1e10' }))).toBe('invalid_usd');
    expect(parseForceOrderPayload(null).reason).toBe('not_object');
    expect(parseForceOrderMessage('null').errors[0]).toBe('not_object');
  });
});

describe('конфигурация', () => {
  it('DEFAULT_SYMBOLS == WATCHLIST в worker/worker.js (35 монети)', () => {
    const src = fs.readFileSync('./worker/worker.js', 'utf8');
    const block = src.slice(src.indexOf('const WATCHLIST = ['), src.indexOf('];', src.indexOf('const WATCHLIST = [')));
    const worker = [...block.matchAll(/symbol: '([A-Z0-9]+)'/g)].map(m => m[1]);
    expect(worker.length).toBe(35);
    expect([...DEFAULT_SYMBOLS].sort()).toEqual([...worker].sort());
  });

  it('createCollectorFromEnv: изключен по подразбиране; без WebSocket -> изключен с причина', () => {
    expect(createCollectorFromEnv({}).collector).toBeNull();
    expect(createCollectorFromEnv({ LIQ_COLLECTOR_ENABLED: 'true' }).collector).toBeNull();
    const noWs = createCollectorFromEnv({ LIQ_COLLECTOR_ENABLED: '1' }, { WebSocketImpl: null });
    expect(noWs.collector).toBeNull();
    expect(noWs.disabledReason).toContain('WebSocket');
    const { FakeWebSocket } = makeFakeWs();
    const on = createCollectorFromEnv({ LIQ_COLLECTOR_ENABLED: '1', LIQ_SYMBOLS: 'btcusdt, ETHUSDT' }, { WebSocketImpl: FakeWebSocket });
    expect(on.collector).not.toBeNull();
    expect([...on.collector.symbols]).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(on.collector.url).toBe(DEFAULT_WS_URL);
    expect(DEFAULT_WS_URL).toBe('wss://fstream.binance.com/market/ws/!forceOrder@arr');
  });
});

// ---- normal operation ------------------------------------------------------
describe('нормална работа', () => {
  it('събира само наблюдаваните символи, подрежда по време, връща от since нататък', () => {
    const { c, clock, instances } = setup();
    c.start();
    expect(instances).toHaveLength(1);
    instances[0].open();
    const t = clock.now();
    instances[0].send(fo({ s: 'BTCUSDT', T: t + 2000, S: 'BUY' }));
    instances[0].send(fo({ s: 'BTCUSDT', T: t + 1000, S: 'SELL' })); // out of order
    instances[0].send(fo({ s: 'DOGEUSDT', T: t + 1500 }));
    instances[0].send(fo({ s: 'XYZUSDT', T: t + 1500 })); // not watched
    clock.advance(3000);
    const q = c.query('BTCUSDT', t);
    expect(q.events.map(e => e.time)).toEqual([t + 1000, t + 2000]);
    expect(q.events[0].liquidatedPosition).toBe('long');
    expect(q.events[1].side).toBe(1);
    expect(q.coverage.complete).toBe(true);
    expect(c.query('BTCUSDT', t + 1500).events).toHaveLength(1);
    const s = c.getStats();
    expect(s.events.accepted).toBe(3);
    expect(s.events.filteredSymbol).toBe(1);
    expect(s.perSymbol.BTCUSDT.buyUsd).toBe(1000);
    expect(s.perSymbol.BTCUSDT.sellUsd).toBe(1000);
    expect(s.connection.state).toBe('open');
    c.stop();
  });

  it('limit + truncated + nextSince за страниране', () => {
    const { c, clock, instances } = setup({ maxQueryLimit: 3 });
    c.start(); instances[0].open();
    const t = clock.now();
    for (let i = 1; i <= 5; i++) instances[0].send(fo({ T: t + i * 1000, z: String(i) }));
    const q = c.query('BTCUSDT', t, { limit: 10 });
    expect(q.count).toBe(3);
    expect(q.truncated).toBe(true);
    expect(q.nextSince).toBe(t + 3000);
    c.stop();
  });
});

// ---- duplicates ------------------------------------------------------------
describe('дублирани събития', () => {
  it('едно и също събитие два пъти -> записано веднъж, броено като duplicate', () => {
    const { c, clock, instances } = setup();
    c.start(); instances[0].open();
    const e = fo({ T: clock.now() + 10 });
    instances[0].send(e); instances[0].send(e);
    expect(c.query('BTCUSDT', 0).count).toBe(1);
    expect(c.getStats().events.duplicates).toBe(1);
    c.stop();
  });

  it('различно количество в същата ms -> НЕ е дубликат', () => {
    const { c, clock, instances } = setup();
    c.start(); instances[0].open();
    const T = clock.now() + 10;
    instances[0].send(fo({ T, z: '1' })); instances[0].send(fo({ T, z: '2' }));
    expect(c.query('BTCUSDT', 0).count).toBe(2);
    c.stop();
  });

  it('dedupe ключовете изтичат (без неограничен растеж на паметта)', () => {
    const { c, clock, instances } = setup({ dedupeWindowMs: 60000 });
    c.start(); instances[0].open();
    instances[0].send(fo({ T: clock.now() }));
    expect(c.dedupe.size).toBe(1);
    clock.advance(120000);
    c.prune();
    expect(c.dedupe.size).toBe(0);
    expect(dedupeKey({ symbol: 'A', time: 1, orderSide: 'BUY', qty: 2, price: 3 })).toBe('A|1|BUY|2|3');
    c.stop();
  });
});

// ---- malformed data --------------------------------------------------------
describe('неправилни данни', () => {
  it('невалиден JSON/полета не спират колектора; броят се по причина; ack-овете не са грешка', () => {
    const { c, clock, instances } = setup();
    c.start(); instances[0].open();
    instances[0].send('garbage');
    instances[0].send({ result: null, id: 1 });
    instances[0].send(fo({ S: '??' }));
    instances[0].send(fo({ T: clock.now() + 1 }));
    const s = c.getStats();
    expect(s.events.invalid).toEqual({ invalid_json: 1, invalid_side: 1 });
    expect(s.events.accepted).toBe(1);
    expect(s.connection.state).toBe('open');
    c.stop();
  });

  it('изключение в handler-а се хваща (не стига до relay-я)', () => {
    const { c, instances } = setup();
    c.start(); instances[0].open();
    c._ingest = () => { throw new Error('boom'); };
    instances[0].send(fo());
    expect(c.getStats().events.handlerErrors).toBe(1);
    expect(c.getStats().connection.lastError).toContain('boom');
    c.stop();
  });
});

// ---- disconnect / reconnect ------------------------------------------------
describe('прекъсване и повторно свързване', () => {
  it('drop -> gap + експоненциален backoff (1s, 2s, 4s...) -> reconnect затваря gap-а', () => {
    const { c, clock, instances } = setup();
    c.start(); instances[0].open();
    clock.advance(5000);
    const dropAt = clock.now();
    instances[0].drop(1006);
    expect(c.getStats().connection.state).toBe('disconnected');
    expect(c.getStats().connection.nextReconnectInMs).toBe(1000);
    clock.advance(999); expect(instances).toHaveLength(1);
    clock.advance(1); expect(instances).toHaveLength(2);
    instances[1].drop(1006);                               // fails before open
    expect(c.getStats().connection.nextReconnectInMs).toBe(2000);
    clock.advance(2000); expect(instances).toHaveLength(3);
    instances[2].drop(1006);
    expect(c.getStats().connection.nextReconnectInMs).toBe(4000);
    clock.advance(4000);
    instances[3].open();
    const st = c.getStats();
    expect(st.connection.state).toBe('open');
    expect(st.connection.reconnectAttempts).toBe(3);
    expect(st.gaps.count).toBe(1);
    expect(st.gaps.recent.at(-1).from).toBe(dropAt);
    expect(st.gaps.recent.at(-1).to).toBe(clock.now());
    expect(st.gaps.totalGapMs).toBe(7000);
    c.stop();
  });

  it('backoff е ограничен до 60s и се нулира след стабилна връзка', () => {
    const { c, clock, instances } = setup();
    c.start();
    for (let i = 0; i < 10; i++) { instances.at(-1).drop(); clock.advance(c.getStats().connection.nextReconnectInMs); }
    expect(c.attempt).toBe(10);
    instances.at(-1).drop();
    expect(c.getStats().connection.nextReconnectInMs).toBe(60000);
    clock.advance(60000);
    instances.at(-1).open();
    clock.advance(76000); // stableResetMs (60s) + 1 housekeeping период (15s)
    expect(c.attempt).toBe(0);
    instances.at(-1).drop();
    expect(c.getStats().connection.nextReconnectInMs).toBe(1000);
    c.stop();
  });

  it('coverage: заявка през gap-а -> complete:false + gap; след reconnect -> complete:true', () => {
    const { c, clock, instances } = setup();
    c.start(); instances[0].open();
    const before = clock.now();
    clock.advance(10000);
    instances[0].drop();
    let cov = c.query('BTCUSDT', before).coverage;
    expect(cov.complete).toBe(false);
    expect(cov.reasons).toContain('gap');
    expect(cov.reasons).toContain('not_connected');
    clock.advance(1000); instances[1].open();
    const after = clock.now();
    cov = c.query('BTCUSDT', before).coverage;
    expect(cov.complete).toBe(false);
    expect(cov.gaps[0].to).toBe(after);
    clock.advance(5000);
    expect(c.query('BTCUSDT', after + 1).coverage.complete).toBe(true);
    c.stop();
  });

  it('coverage: преди старта на колектора и извън retention -> complete:false', () => {
    const { c, clock, instances } = setup({ retentionMs: 3600000 });
    c.start();
    expect(c.query('BTCUSDT', clock.now()).coverage.reasons).toContain('never_connected');
    clock.advance(500); instances[0].open();
    expect(c.query('BTCUSDT', clock.now() - 1000).coverage.reasons).toContain('before_collector_start');
    clock.advance(2 * 3600000);
    expect(c.query('BTCUSDT', clock.now() - 2 * 3600000).coverage.reasons).toContain('beyond_retention');
    c.stop();
  });

  it('грешка при създаване на сокет -> backoff, без изключение', () => {
    let fail = true;
    const { FakeWebSocket, instances } = makeFakeWs();
    class Flaky extends FakeWebSocket { constructor(u) { if (fail) throw new Error('ENOTFOUND'); super(u); } }
    const clock = makeClock();
    const c = new LiquidationCollector({ WebSocketImpl: Flaky, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: () => 0.5 });
    c.start();
    expect(c.getStats().connection.lastError).toContain('ENOTFOUND');
    fail = false;
    clock.advance(1000);
    expect(instances).toHaveLength(1);
    c.stop();
  });

  it('stop() не планира повече reconnect-и', () => {
    const { c, clock, instances } = setup();
    c.start(); instances[0].open();
    c.stop();
    clock.advance(3600000);
    expect(instances).toHaveLength(1);
    expect(c.getStats().connection.state).toBe('stopped');
  });
});

// ---- 24h rotation / stale watchdog -----------------------------------------
describe('24-часово ограничение и stale watchdog', () => {
  it('ротация преди 24ч: нов сокет, overlap без gap, дубликатите от двете връзки се филтрират', () => {
    const { c, clock, instances } = setup();
    c.start(); instances[0].open();
    const keepAlive = () => instances.filter(w => !w.closed).forEach(w => w.send({ result: null, id: 0 }));
    for (let i = 0; i < 141; i++) { clock.advance(10 * 60000); keepAlive(); }  // 23ч30м
    expect(instances.length).toBe(2);              // rotation socket created at 23h30
    const t = clock.now();
    const e = fo({ T: t });
    instances[0].send(e); instances[1].send(e);     // overlap: same event on both
    instances[1].open();
    expect(instances[0].closed).toBe(true);         // old closed intentionally
    expect(instances[0].closeCalls[0].reason).toBe('rotated');
    const st = c.getStats();
    expect(st.connection.rotations).toBe(1);
    expect(st.gaps.count).toBe(0);
    expect(st.events.duplicates).toBe(1);
    expect(c.query('BTCUSDT', t).count).toBe(1);
    expect(c.query('BTCUSDT', t - 3600000).coverage.complete).toBe(true);
    c.stop();
  });

  it('неуспешна ротация -> старата връзка остава активна, без gap', () => {
    const { c, clock, instances } = setup({ rotateAfterMs: 60000, staleAfterMs: 10 * 60000 });
    c.start(); instances[0].open();
    clock.advance(75000);
    expect(instances.length).toBe(2);
    instances[1].drop(1006);
    const st = c.getStats();
    expect(st.connection.state).toBe('open');
    expect(st.connection.rotationFailures).toBe(1);
    expect(st.gaps.count).toBe(0);
    expect(c.ws).toBe(instances[0]);
    c.stop();
  });

  it('Binance затваря на 24ч -> нормален reconnect с gap (ако ротацията не е успяла)', () => {
    const { c, clock, instances } = setup({ rotateAfterMs: 10 * 24 * 3600000 });
    c.start(); instances[0].open();
    instances[0].drop(1000, 'server 24h');
    expect(c.getStats().connection.lastCloseCode).toBe(1000);
    clock.advance(1000); instances[1].open();
    expect(c.getStats().gaps.count).toBe(1);
    c.stop();
  });

  it('stale: без съобщения 15 мин -> принудително затваряне, gap от последното съобщение, reconnect', () => {
    const { c, clock, instances } = setup();
    c.start(); instances[0].open();
    clock.advance(60000);
    instances[0].send(fo({ T: clock.now() }));
    const lastMsg = clock.now();
    clock.advance(15 * 60000 + 15000);
    const st = c.getStats();
    expect(st.connection.staleReconnects).toBe(1);
    expect(instances[0].closeCalls[0].reason).toBe('stale');
    expect(st.gaps.open.from).toBe(lastMsg);
    expect(st.gaps.open.reason).toBe('stale');
    clock.advance(1000);
    expect(instances).toHaveLength(2);
    c.stop();
  });
});

// ---- memory / retention / saturation --------------------------------------
describe('памет, retention и индикатор за подценяване', () => {
  it('cap на символ: най-старите се изхвърлят и coverage го отчита', () => {
    const { c, clock, instances } = setup({ maxEventsPerSymbol: 3 });
    c.start(); instances[0].open();
    const t = clock.now();
    for (let i = 1; i <= 5; i++) instances[0].send(fo({ T: t + i * 10000 }));
    expect(c.store.get('BTCUSDT')).toHaveLength(3);
    expect(c.getStats().perSymbol.BTCUSDT.evictedByCap).toBe(2);
    expect(c.query('BTCUSDT', t).coverage.reasons).toContain('evicted_by_cap');
    expect(c.query('BTCUSDT', t + 25000).coverage.reasons).not.toContain('evicted_by_cap');
    c.stop();
  });

  it('retention: събития по-стари от прозореца се изтриват', () => {
    const { c, clock, instances } = setup({ retentionMs: 3600000 });
    c.start(); instances[0].open();
    instances[0].send(fo({ T: clock.now() }));
    clock.advance(2 * 3600000);
    c.prune();
    expect(c.store.get('BTCUSDT')).toHaveLength(0);
    c.stop();
  });

  it('saturatedEvents: събития в последователни секунди (1000ms snapshot е бил зает)', () => {
    const { c, clock, instances } = setup();
    c.start(); instances[0].open();
    const t = Math.floor(clock.now() / 1000) * 1000;
    instances[0].send(fo({ T: t + 100 }));
    instances[0].send(fo({ T: t + 1100 }));
    instances[0].send(fo({ T: t + 2100 }));
    instances[0].send(fo({ T: t + 9000 }));
    expect(c.getStats().perSymbol.BTCUSDT.saturatedEvents).toBe(2);
    c.stop();
  });

  it('getStats не съдържа token/секрети и има лимитите на потока', () => {
    const { c, instances } = setup();
    c.start(); instances[0].open();
    const s = JSON.stringify(c.getStats());
    expect(s).not.toMatch(/token/i);
    expect(c.getStats().limits.snapshotPerSymbolMs).toBe(1000);
    c.stop();
  });
});

describe('error без close и connect timeout (реално поведение на Node WebSocket)', () => {
  it('само `error` (без `close`) при отказана връзка -> третира се като прекъсване и reconnect', () => {
    const { c, clock, instances } = setup();
    c.start();
    instances[0].onerror({ message: 'Received network error or non-101 status code.' });
    const st = c.getStats();
    expect(st.connection.state).toBe('disconnected');
    expect(st.connection.lastError).toContain('non-101');
    expect(instances[0].closed).toBe(true);
    clock.advance(1000);
    expect(instances).toHaveLength(2);
    instances[0].onclose && instances[0].onclose({ code: 1006 }); // късен close -> игнориран
    expect(c.getStats().connection.disconnects).toBe(1);
    c.stop();
  });

  it('handshake не завършва за 20s -> connect_timeout + reconnect', () => {
    const { c, clock, instances } = setup();
    c.start();
    clock.advance(19999); expect(instances).toHaveLength(1);
    clock.advance(1);
    expect(c.getStats().connection.lastCloseReason).toBe('connect_timeout');
    clock.advance(1000);
    expect(instances).toHaveLength(2);
    instances[1].open();
    expect(c.getStats().connection.state).toBe('open');
    c.stop();
  });

  it('ротационният сокет с увиснал handshake -> rotationFailures, активната връзка остава', () => {
    const { c, clock, instances } = setup({ rotateAfterMs: 60000 });
    c.start(); instances[0].open();
    const keep = () => instances[0].send({ result: null, id: 0 });
    clock.advance(70000); keep();
    expect(instances).toHaveLength(2);
    clock.advance(21000); keep();
    expect(c.getStats().connection.rotationFailures).toBe(1);
    expect(c.ws).toBe(instances[0]);
    expect(c.getStats().gaps.count).toBe(0);
    c.stop();
  });
});
