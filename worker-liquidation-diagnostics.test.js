// COINGLASS /futures/liquidation/order - ДИАГНОСТИКА (shadow, diagnostic-only).
// Тества РЕАЛНИЯ worker.js (директен ESM import). Покрива:
// (A) Доказателство за legacy поведението: какво точно изпраща
//     fetchLiquidationOrdersWorker и как CASCADE/GRAVITY реагират на празен
//     масив, 401 в body (HTTP 200), HTTP грешка, timeout и реална нула.
// (B) Последствия при активиране с реални данни (прагове, 7-дневен backfill,
//     липса на decay) - БЕЗ промяна на production логиката.
// (C) Новият shadow модул: символна карта за всички 35 монети, класификация,
//     URL/параметри, без утечка на ключа, rising-edge събития, таймлайн.
// (D) End-to-end: scanSymbolSignals с LIQ_DIAG_ENABLED изкл./вкл. връща
//     ИДЕНТИЧЕН резултат и записва ИДЕНТИЧЕН sigstate - диагностиката не
//     влияе на генерирането на сигнали.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import {
  fetchLiquidationOrdersWorker, calcLiquidationCascade, accumulateLiquidationGravity,
  findNearestLiquidationCluster, calcLiquidationGravityScore, getLiquidationGravityTier,
  isLiqDiagEnabled, toCoinGlassCoin, classifyCoinGlassLiqResponse, normalizeLiqDiagOrders,
  buildLiqDiagUrl, fetchLiquidationOrdersDiag, detectLiqDiagTruncation, applyLiqShadowStep,
  runLiqShadowDiagnostics, buildLiqDiagSummary, runLiqDiagProbe, WATCHLIST, scanSymbolSignals,
  fetchLiquidationOrdersRelayDiag, getLiqDiagSource,
} from './worker/worker.js';
import worker from './worker/worker.js';

const workerSrc = fs.readFileSync('./worker/worker.js', 'utf8');
const FAKE_KEY = 'test-key-DO-NOT-LEAK-123';
const realFetch = globalThis.fetch;
const realNow = Date.now;
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });

// Mock на CoinGlass според документацията: `symbol` е монета (BTC); двойка
// (BTCUSDT) -> code "0" и празен масив.
function coinglassDocMock(ordersForCoin, { calls = [] } = {}) {
  return async (url, opts) => {
    calls.push({ url: String(url), headers: opts?.headers });
    const u = new URL(String(url));
    const sym = u.searchParams.get('symbol');
    const isPair = /USDT$/.test(sym);
    const data = isPair ? [] : (ordersForCoin[sym] || []);
    return new Response(JSON.stringify({ code: '0', msg: 'success', data }), { status: 200 });
  };
}
const order = (o) => ({ exchange_name: 'Binance', symbol: 'BTCUSDT', base_asset: 'BTC', price: 100000, usd_value: 1000, side: 1, time: Date.now(), ...o });

describe('(A) legacy fetchLiquidationOrdersWorker - какво реално се изпраща', () => {
  it('изпраща symbol=BTCUSDT (двойка), exchange=Binance, min=1, БЕЗ start_time', async () => {
    const calls = [];
    globalThis.fetch = coinglassDocMock({}, { calls });
    await fetchLiquidationOrdersWorker({ CG_API_KEY: FAKE_KEY }, 'BTCUSDT');
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/api/futures/liquidation/order');
    expect(u.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(u.searchParams.get('exchange')).toBe('Binance');
    expect(u.searchParams.get('min_liquidation_amount')).toBe('1');
    expect(u.searchParams.get('start_time')).toBeNull();
    expect(calls[0].headers['CG-API-KEY']).toBe(FAKE_KEY);
  });

  it('при документираното поведение (pair -> []) връща [] дори когато има реални ликвидации за BTC', async () => {
    globalThis.fetch = coinglassDocMock({ BTC: [order({ usd_value: 900000, side: 2 })] });
    const r = await fetchLiquidationOrdersWorker({ CG_API_KEY: FAKE_KEY }, 'BTCUSDT');
    expect(r).toEqual([]);
  });

  it('със същия mock, но symbol=BTC - данните идват (доказва, че разликата е само в символа)', async () => {
    globalThis.fetch = coinglassDocMock({ BTC: [order({ usd_value: 900000, side: 2 })] });
    const r = await fetchLiquidationOrdersWorker({ CG_API_KEY: FAKE_KEY }, 'BTC');
    expect(r).toHaveLength(1);
    expect(r[0].usdValue).toBe(900000);
  });

  it('401 в body при HTTP 200 (CoinGlass стил) -> null; legacy не гледа json.code', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: '401', msg: 'Upgrade plan' }), { status: 200 });
    expect(await fetchLiquidationOrdersWorker({ CG_API_KEY: FAKE_KEY }, 'BTCUSDT')).toBeNull();
  });

  it('api_error с data:[] -> [] (неразличимо от "няма ликвидации")', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: '403', msg: 'interval not allowed', data: [] }), { status: 200 });
    expect(await fetchLiquidationOrdersWorker({ CG_API_KEY: FAKE_KEY }, 'BTCUSDT')).toEqual([]);
  });

  it('HTTP 500 -> null; мрежова грешка/timeout -> null', async () => {
    globalThis.fetch = async () => new Response('err', { status: 500 });
    expect(await fetchLiquidationOrdersWorker({ CG_API_KEY: FAKE_KEY }, 'BTCUSDT')).toBeNull();
    globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    expect(await fetchLiquidationOrdersWorker({ CG_API_KEY: FAKE_KEY }, 'BTCUSDT')).toBeNull();
  });

  it('[], null и реална нула (стари поръчки) дават ЕДИН И СЪЩ CASCADE резултат', () => {
    const old = [{ side: 1, usdValue: 5e6, time: Date.now() - 60 * 60000, price: 1 }];
    const a = calcLiquidationCascade([]), b = calcLiquidationCascade(null), c = calcLiquidationCascade(old);
    for (const r of [a, b, c]) { expect(r.bullish).toBe(false); expect(r.bearish).toBe(false); expect(r.buySumUsd).toBe(0); expect(r.sellSumUsd).toBe(0); }
  });

  it('GRAVITY при [] / null -> профилът остава {buckets:{}, lastSeenTime:0} (точно наблюдението от KV)', () => {
    const s1 = {}, s2 = {};
    accumulateLiquidationGravity(s1, []);
    accumulateLiquidationGravity(s2, null);
    expect(s1.liqGravity).toEqual({ buckets: {}, lastSeenTime: 0 });
    expect(s2.liqGravity).toEqual({ buckets: {}, lastSeenTime: 0 });
    expect(findNearestLiquidationCluster(s1, 100000)).toBeNull();
    const sc = calcLiquidationGravityScore({ price: 100000, cluster: null, oiDeltaPct: 1, takerDelta: 1, volAccel: { tier: 'hot' } });
    expect(getLiquidationGravityTier(Math.max(sc.longScore, sc.shortScore), sc.hasHardFactorLong)).toBe('none');
  });

  it('source guard: legacy заявката остава непроменена в този branch', () => {
    expect(workerSrc).toContain('/api/futures/liquidation/order?symbol=${symbol}&exchange=Binance&min_liquidation_amount=1');
  });
});

describe('(B) последствия при активиране с реални данни (само анализ, без промяна)', () => {
  it('CASCADE: 500k USD side=2 за 15 мин -> bearish; 499k -> не', () => {
    const now = Date.now();
    expect(calcLiquidationCascade([{ side: 2, usdValue: 500000, time: now - 60000 }]).bearish).toBe(true);
    expect(calcLiquidationCascade([{ side: 2, usdValue: 499999, time: now - 60000 }]).bearish).toBe(false);
  });

  it('GRAVITY: първият тик след поправка (lastSeenTime=0) поглъща целия върнат прозорец наведнъж', () => {
    const now = Date.now();
    const st = {};
    const backfill = Array.from({ length: 50 }, (_, i) => ({ side: 2, usdValue: 100000, price: 101000, time: now - (i + 1) * 3600000 }));
    accumulateLiquidationGravity(st, backfill);
    const cluster = findNearestLiquidationCluster(st, 100000);
    expect(cluster).not.toBeNull();
    expect(cluster.usd).toBe(5000000); // >= 2*2M -> +1 "особено силен"
    const sc = calcLiquidationGravityScore({ price: 100000, cluster, oiDeltaPct: 0.1, takerDelta: null, volAccel: { tier: 'hot' } });
    // близо (+2) + обем (+1) + силен (+1) = 4, hard factor = OI > 0 -> CONFIRMED още на първия тик
    expect(getLiquidationGravityTier(sc.longScore, sc.hasHardFactorLong)).toBe('confirmed');
  });

  it('GRAVITY: няма decay - стари кошчета остават завинаги и само растат', () => {
    const st = {};
    const t0 = Date.now() - 90 * 86400000;
    accumulateLiquidationGravity(st, [{ side: 1, usdValue: 3e6, price: 50000, time: t0 }]);
    accumulateLiquidationGravity(st, [{ side: 1, usdValue: 1, price: 99000, time: Date.now() }]);
    const keys = Object.keys(st.liqGravity.buckets);
    expect(keys.length).toBe(2);
    expect(findNearestLiquidationCluster(st, 50100).usd).toBe(3e6); // 90-дневен клъстер все още "силен"
  });

  it('GRAVITY: поръчки със същата ms като lastSeenTime в следваща заявка се губят (строго >)', () => {
    const st = {};
    const t = Date.now();
    accumulateLiquidationGravity(st, [{ side: 1, usdValue: 10, price: 100, time: t }]);
    accumulateLiquidationGravity(st, [{ side: 1, usdValue: 99, price: 100, time: t }]);
    const total = Object.values(st.liqGravity.buckets).reduce((a, b) => a + b, 0);
    expect(total).toBe(10);
  });

  it('GRAVITY: клъстер в кошчето на текущата цена -> посоката зависи от знака на минимално разстояние', () => {
    const cluster = { price: 100000.01, usd: 5e6 };
    const up = calcLiquidationGravityScore({ price: 100000, cluster, oiDeltaPct: 1, takerDelta: null, volAccel: null });
    const dn = calcLiquidationGravityScore({ price: 100000.02, cluster, oiDeltaPct: -1, takerDelta: null, volAccel: null });
    expect(up.longScore).toBeGreaterThan(up.shortScore);
    expect(dn.shortScore).toBeGreaterThan(dn.longScore);
  });
});

describe('(C) shadow модул - символи, класификация, параметри', () => {
  it('флагът е ИЗКЛЮЧЕН по подразбиране', () => {
    expect(isLiqDiagEnabled({})).toBe(false);
    expect(isLiqDiagEnabled({ LIQ_DIAG_ENABLED: '0' })).toBe(false);
    expect(isLiqDiagEnabled({ LIQ_DIAG_ENABLED: 'true' })).toBe(false);
    expect(isLiqDiagEnabled({ LIQ_DIAG_ENABLED: '1' })).toBe(true);
  });

  it('символна карта за всички 35 монети от WATCHLIST', () => {
    expect(WATCHLIST.length).toBe(35);
    const unverified = [];
    for (const { symbol } of WATCHLIST) {
      const m = toCoinGlassCoin(symbol);
      expect(m.coin).toMatch(/^[A-Z0-9]+$/);
      expect(m.coin.endsWith('USDT')).toBe(false);
      if (!m.verified) unverified.push(`${symbol}->${m.coin}`);
    }
    expect(unverified).toEqual(['1000PEPEUSDT->PEPE']);
    expect(toCoinGlassCoin('BTCUSDT')).toEqual({ coin: 'BTC', verified: true, rule: 'strip_usdt' });
    expect(toCoinGlassCoin('1000SHIBUSDT').coin).toBe('SHIB');
    expect(toCoinGlassCoin('1000SHIBUSDT').verified).toBe(false);
  });

  it('класификация на всички случаи', () => {
    expect(classifyCoinGlassLiqResponse({ hasKey: false }).status).toBe('no_key');
    expect(classifyCoinGlassLiqResponse({ httpStatus: 200, json: { code: '0', data: [{}] } }).status).toBe('ok');
    expect(classifyCoinGlassLiqResponse({ httpStatus: 200, json: { code: '0', data: [] } }).status).toBe('empty');
    const e401 = classifyCoinGlassLiqResponse({ httpStatus: 200, json: { code: '401', msg: 'Upgrade plan' } });
    expect(e401.status).toBe('api_error'); expect(e401.code).toBe('401'); expect(e401.msg).toBe('Upgrade plan');
    expect(classifyCoinGlassLiqResponse({ httpStatus: 200, json: { code: '403', data: [] } }).status).toBe('api_error');
    expect(classifyCoinGlassLiqResponse({ httpStatus: 200, json: { code: '0', data: null } }).status).toBe('bad_shape');
    expect(classifyCoinGlassLiqResponse({ httpStatus: 429, json: { code: '429' } }).status).toBe('http_error');
    expect(classifyCoinGlassLiqResponse({ httpStatus: 200, json: undefined }).status).toBe('parse_error');
    const ab = new Error('x'); ab.name = 'AbortError';
    expect(classifyCoinGlassLiqResponse({ error: ab }).status).toBe('timeout');
    expect(classifyCoinGlassLiqResponse({ error: new Error('ECONNRESET') }).status).toBe('network');
  });

  it('URL: coin символ + start_time; ключът е само в header-а и НИКОГА в резултата', async () => {
    const calls = [];
    const now = 1800000000000;
    globalThis.fetch = coinglassDocMock({ BTC: [order({ time: now - 1000 })] }, { calls });
    const r = await fetchLiquidationOrdersDiag({ CG_API_KEY: FAKE_KEY }, 'BTCUSDT', { now });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('symbol')).toBe('BTC');
    expect(u.searchParams.get('start_time')).toBe(String(now - 20 * 60000));
    expect(calls[0].url).not.toContain(FAKE_KEY);
    expect(r.status).toBe('ok');
    expect(r.count).toBe(1);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(buildLiqDiagUrl('ETH', { minAmount: 100000 })).toContain('symbol=ETH&exchange=Binance&min_liquidation_amount=100000');
  });

  it('без ключ -> no_key, без мрежова заявка', async () => {
    let called = 0;
    globalThis.fetch = async () => { called++; return new Response('{}'); };
    const r = await fetchLiquidationOrdersDiag({}, 'BTCUSDT');
    expect(r.status).toBe('no_key');
    expect(called).toBe(0);
  });

  it('timeout/мрежа не хвърля навън', async () => {
    globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const r = await fetchLiquidationOrdersDiag({ CG_API_KEY: FAKE_KEY }, 'ETHUSDT');
    expect(r.status).toBe('timeout');
    expect(r.orders).toEqual([]);
  });

  it('normalizeLiqDiagOrders пази pair/base_asset за проверка на картата', () => {
    const o = normalizeLiqDiagOrders([{ symbol: 'PEPEUSDT', base_asset: 'PEPE', usd_value: '12.5', time: 1, price: '0.00001', side: 2 }, { usd_value: 'x', time: 1 }]);
    expect(o).toHaveLength(1);
    expect(o[0]).toEqual({ side: 2, usdValue: 12.5, time: 1, price: 0.00001, pair: 'PEPEUSDT', baseAsset: 'PEPE' });
  });

  it('truncation detection', () => {
    const st = 1000000;
    const many = Array.from({ length: 200 }, (_, i) => ({ time: st + 120000 + i }));
    expect(detectLiqDiagTruncation(many, st)).toBe(true);
    expect(detectLiqDiagTruncation(many.slice(0, 199), st)).toBe(false);
    expect(detectLiqDiagTruncation([{ time: st + 1 }, ...many], st)).toBe(false);
  });
});

describe('(C) applyLiqShadowStep - shadow изчисление без странични ефекти', () => {
  const now = Date.now();
  const fr = (orders, status = 'ok') => ({ status, code: '0', msg: null, count: orders.length, coin: 'BTC', coinVerified: true, coinRule: 'strip_usdt', startTime: now - 20 * 60000, at: now, orders, latencyMs: 5 });

  it('не мутира предишния diag state и не съдържа реалния state.liqGravity', () => {
    const prev = applyLiqShadowStep(null, fr([])).diag;
    const snapshot = JSON.stringify(prev);
    const realState = { liqGravity: { buckets: {}, lastSeenTime: 0 } };
    applyLiqShadowStep(prev, fr([{ side: 2, usdValue: 600000, time: now - 1000, price: 100000 }]), { price: 100000 });
    expect(JSON.stringify(prev)).toBe(snapshot);
    expect(realState.liqGravity).toEqual({ buckets: {}, lastSeenTime: 0 });
  });

  it('CASCADE would-fire събитие само при rising edge + хистограма + legacy сравнение', () => {
    let d = null;
    const big = [{ side: 2, usdValue: 600000, time: now - 1000, price: 100000 }];
    d = applyLiqShadowStep(d, fr(big), { price: 100000, legacyBuyUsd: 0, legacySellUsd: 0 }).diag;
    d = applyLiqShadowStep(d, fr(big), { price: 100000 }).diag;
    const cascadeEvents = d.events.filter(e => e.kind === 'cascade');
    expect(cascadeEvents).toHaveLength(1);
    expect(cascadeEvents[0].direction).toBe('short');
    expect(d.cascadeHist.sell['500000']).toBe(2);
    expect(d.cascadeMax.sell).toBe(600000);
    expect(d.timeline[0].side2Usd15m).toBe(600000);
    expect(d.timeline[0].legacySide2Usd15m).toBe(0);
    expect(d.counts.ok).toBe(2);
  });

  it('api_error се брои, но не се натрупва в gravity и не създава събития', () => {
    const r = applyLiqShadowStep(null, { ...fr([], 'api_error'), code: '401', msg: 'Upgrade plan' }, { price: 1 }).diag;
    expect(r.counts.api_error).toBe(1);
    expect(r.last.code).toBe('401');
    expect(r.lastOkAt).toBeNull();
    expect(r.events).toHaveLength(0);
    expect(r.timeline[0].side1Usd15m).toBeNull();
  });

  it('таймлайнът и събитията са с таван', () => {
    let d = null;
    for (let i = 0; i < 300; i++) d = applyLiqShadowStep(d, fr([]), { price: 1 }).diag;
    expect(d.timeline.length).toBe(288);
  });

  it('runLiqShadowDiagnostics пише САМО в liqdiag: ключ и не хвърля при KV грешка', async () => {
    const puts = [];
    const kv = { get: async () => null, put: async (k, v) => { puts.push(k); } };
    const diag = await runLiqShadowDiagnostics({ ALERT_STATE: kv }, 'BTCUSDT', Promise.resolve(fr([])), { price: 1 });
    expect(diag).not.toBeNull();
    expect(puts).toEqual(['liqdiag:BTCUSDT']);
    const badKv = { get: async () => { throw new Error('kv down'); }, put: async () => {} };
    expect(await runLiqShadowDiagnostics({ ALERT_STATE: badKv }, 'BTCUSDT', Promise.resolve(fr([])), {})).toBeNull();
  });

  it('buildLiqDiagSummary', () => {
    const okD = applyLiqShadowStep(null, fr([{ side: 1, usdValue: 1, time: now, price: 1, pair: 'BTCUSDT', baseAsset: 'BTC' }]), { price: 1 }).diag;
    const errD = applyLiqShadowStep(null, { ...fr([], 'api_error'), coin: 'PEPE', coinVerified: false }, {}).diag;
    const s = buildLiqDiagSummary([{ symbol: 'BTCUSDT', diag: okD }, { symbol: '1000PEPEUSDT', diag: errD }, { symbol: 'UBUSDT', diag: null }]);
    expect(s.totals).toEqual({ ok: 1, api_error: 1 });
    expect(s.neverOk).toEqual(['1000PEPEUSDT', 'UBUSDT']);
    expect(s.unverifiedCoins[0].coin).toBe('PEPE');
    expect(s.bySymbol.BTCUSDT.pairCounts).toEqual({ BTCUSDT: 1 });
  });
});

describe('(C) runLiqDiagProbe - ръчна проба pair срещу coin', () => {
  it('доказва бъга при документираното поведение и не връща ключа', async () => {
    const now = Date.now();
    globalThis.fetch = coinglassDocMock({ BTC: [order({ time: now - 5000, usd_value: 150000 })] });
    const p = await runLiqDiagProbe({ CG_API_KEY: FAKE_KEY }, 'BTCUSDT', { now });
    expect(p.verdict).toBe('symbol_format_bug_confirmed');
    expect(p.legacy.status).toBe('empty');
    expect(p.coin.status).toBe('ok');
    expect(p.coin.coin).toBe('BTC');
    expect(JSON.stringify(p)).not.toContain(FAKE_KEY);
  });
  it('401 -> api_error_plan_or_auth', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: '401', msg: 'Upgrade plan' }), { status: 200 });
    expect((await runLiqDiagProbe({ CG_API_KEY: FAKE_KEY }, 'BTCUSDT')).verdict).toBe('api_error_plan_or_auth');
  });
});

describe('(D) END-TO-END scanSymbolSignals - диагностиката НЕ влияе на сигналите', () => {
  const FIXED_NOW = 1800000000000;
  const IV = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
  function klines(interval, limit) {
    const step = IV[interval] || 60000;
    const out = [];
    for (let i = limit - 1; i >= 0; i--) {
      const t = FIXED_NOW - (i + 1) * step;
      const base = 100000 + Math.sin((limit - i) / 7) * 2000 + (limit - i) * 3;
      out.push([t, String(base), String(base * 1.004), String(base * 0.996), String(base * 1.001), '1234.5', t + step - 1, '123450000', 1000, '600', '60000000', '0']);
    }
    return out;
  }
  function makeKv() {
    const m = new Map();
    return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) };
  }
  function router(cgCalls, relayCalls = []) {
    return async (url, opts) => {
      const s = String(url);
      if (s.includes('/liquidations?')) {
        relayCalls.push(s);
        return new Response(JSON.stringify({ symbol: 'BTCUSDT', count: 1, truncated: false, events: [{ side: 1, liquidatedPosition: 'short', usdValue: 820000, price: 99500, qty: 8.24, time: FIXED_NOW - 30000 }], coverage: { complete: true, reasons: [], gaps: [], connected: true } }), { status: 200 });
      }
      if (s.includes('/klines')) {
        const u = new URL(s);
        return new Response(JSON.stringify(klines(u.searchParams.get('interval'), Number(u.searchParams.get('limit')))), { status: 200 });
      }
      if (s.includes('coinglass.com')) {
        cgCalls.push(s);
        const sym = new URL(s).searchParams.get('symbol');
        const data = /USDT$/.test(sym) ? [] : [{ exchange_name: 'Binance', symbol: 'BTCUSDT', base_asset: 'BTC', price: 100500, usd_value: 750000, side: 2, time: FIXED_NOW - 60000 }];
        return new Response(JSON.stringify({ code: '0', data }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: -1, msg: 'mock unavailable' }), { status: 503 });
    };
  }
  async function runScan(flag, extraEnv = { LIQ_DIAG_SOURCE: 'coinglass' }) {
    Date.now = () => FIXED_NOW;
    const kv = makeKv();
    const cgCalls = [], relayCalls = [];
    globalThis.fetch = router(cgCalls, relayCalls);
    const env = { RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 'relay-secret-xyz', CG_API_KEY: FAKE_KEY, ALERT_STATE: kv, ...extraEnv, ...(flag ? { LIQ_DIAG_ENABLED: '1' } : {}) };
    const result = await scanSymbolSignals(env, 'BTCUSDT');
    return { result, kv, cgCalls, relayCalls };
  }

  it('резултатът и sigstate са идентични с изкл./вкл. флаг; вкл. -> само допълнителен liqdiag: ключ', async () => {
    const off = await runScan(false);
    const on = await runScan(true);
    expect(JSON.stringify(on.result)).toBe(JSON.stringify(off.result));
    expect(on.kv.m.get('sigstate:BTCUSDT')).toBe(off.kv.m.get('sigstate:BTCUSDT'));
    const offKeys = [...off.kv.m.keys()].sort();
    const onKeys = [...on.kv.m.keys()].sort();
    expect(onKeys.filter(k => !offKeys.includes(k))).toEqual(['liqdiag:BTCUSDT']);
    expect(offKeys.some(k => k.startsWith('liqdiag:'))).toBe(false);
    // legacy заявката е еднаква и в двата режима; shadow добавя ТОЧНО 1 (coin) заявка
    expect(off.cgCalls).toHaveLength(1);
    expect(on.cgCalls).toHaveLength(2);
    expect(new URL(on.cgCalls.find(u => !u.includes('symbol=BTCUSDT'))).searchParams.get('symbol')).toBe('BTC');
    // legacy профилът остава празен (бъгът), shadow вижда реалните данни
    const sig = JSON.parse(on.kv.m.get('sigstate:BTCUSDT'));
    expect(sig.liqGravity).toEqual({ buckets: {}, lastSeenTime: 0 });
    const diag = JSON.parse(on.kv.m.get('liqdiag:BTCUSDT'));
    expect(diag.last.status).toBe('ok');
    expect(diag.shadowGravity.lastSeenTime).toBe(FIXED_NOW - 60000);
    expect(diag.events.some(e => e.kind === 'cascade' && e.direction === 'short')).toBe(true);
    expect(diag.timeline[0].legacySide2Usd15m).toBe(0);
    expect(diag.timeline[0].side2Usd15m).toBe(750000);
    expect(JSON.stringify(diag)).not.toContain(FAKE_KEY);
  });

  it('RELAY източник (по подразбиране): идентичен резултат/sigstate; legacy CoinGlass заявката е непроменена', async () => {
    const off = await runScan(false, {});
    const on = await runScan(true, {});
    expect(JSON.stringify(on.result)).toBe(JSON.stringify(off.result));
    expect(on.kv.m.get('sigstate:BTCUSDT')).toBe(off.kv.m.get('sigstate:BTCUSDT'));
    expect(off.relayCalls.filter(u => u.includes('/liquidations?'))).toHaveLength(0);
    expect(on.relayCalls).toHaveLength(1);
    const u = new URL(on.relayCalls[0]);
    expect(u.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(u.searchParams.get('since')).toBe(String(FIXED_NOW - 20 * 60000));
    expect(on.cgCalls).toHaveLength(1);           // само legacy заявката, без CoinGlass shadow
    expect(off.cgCalls).toHaveLength(1);
    const diag = JSON.parse(on.kv.m.get('liqdiag:BTCUSDT'));
    expect(diag.last.source).toBe('relay');
    expect(diag.last.coverageComplete).toBe(true);
    expect(diag.events.some(e => e.kind === 'cascade' && e.direction === 'long')).toBe(true);
    expect(diag.timeline[0].side1Usd15m).toBe(820000);
    expect(diag.timeline[0].legacySide1Usd15m).toBe(0);
    expect(JSON.stringify(diag)).not.toContain('relay-secret-xyz');
    expect(JSON.parse(on.kv.m.get('sigstate:BTCUSDT')).liqGravity).toEqual({ buckets: {}, lastSeenTime: 0 });
  });
});

describe('(E) fetchLiquidationOrdersRelayDiag - Binance forceOrder през relay', () => {
  const now = 1800000000000;
  const env = { RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 'relay-secret-xyz' };
  const resp = (status, body) => async () => new Response(JSON.stringify(body), { status });
  it('източник по подразбиране е relay; coinglass само изрично', () => {
    expect(getLiqDiagSource({})).toBe('relay');
    expect(getLiqDiagSource({ LIQ_DIAG_SOURCE: 'CoinGlass' })).toBe('coinglass');
    expect(getLiqDiagSource({ LIQ_DIAG_SOURCE: 'x' })).toBe('relay');
  });
  it('ok + coverage; токенът не е в резултата; невалидни side се филтрират', async () => {
    const calls = [];
    const r = await fetchLiquidationOrdersRelayDiag(env, 'ETHUSDT', { now, fetchImpl: async (u) => { calls.push(u); return new Response(JSON.stringify({ events: [{ side: 2, usdValue: 5000, price: 3000, time: now - 1000 }, { side: 7, usdValue: 1, price: 1, time: now }], coverage: { complete: false, reasons: ['gap'] }, truncated: true }), { status: 200 }); } });
    expect(calls[0]).toContain('symbol=ETHUSDT');
    expect(calls[0]).toContain(`since=${now - 20 * 60000}`);
    expect(r.status).toBe('ok');
    expect(r.count).toBe(1);
    expect(r.orders[0]).toEqual({ side: 2, usdValue: 5000, time: now - 1000, price: 3000, pair: 'ETHUSDT', baseAsset: null });
    expect(r.coverageComplete).toBe(false);
    expect(r.coverageReasons).toEqual(['gap']);
    expect(r.relayTruncated).toBe(true);
    expect(JSON.stringify(r)).not.toContain('relay-secret-xyz');
  });
  it('статуси: no_relay, source_disabled (503), http_error, bad_shape, parse_error, timeout, network, empty', async () => {
    expect((await fetchLiquidationOrdersRelayDiag({}, 'BTCUSDT')).status).toBe('no_relay');
    const d = await fetchLiquidationOrdersRelayDiag(env, 'BTCUSDT', { fetchImpl: resp(503, { enabled: false, reason: 'LIQ_COLLECTOR_ENABLED is not 1' }) });
    expect(d.status).toBe('source_disabled');
    expect(d.msg).toContain('LIQ_COLLECTOR_ENABLED');
    expect((await fetchLiquidationOrdersRelayDiag(env, 'BTCUSDT', { fetchImpl: resp(401, { error: 'Unauthorized' }) })).status).toBe('http_error');
    expect((await fetchLiquidationOrdersRelayDiag(env, 'BTCUSDT', { fetchImpl: resp(200, { foo: 1 }) })).status).toBe('bad_shape');
    expect((await fetchLiquidationOrdersRelayDiag(env, 'BTCUSDT', { fetchImpl: async () => new Response('<html>', { status: 200 }) })).status).toBe('parse_error');
    expect((await fetchLiquidationOrdersRelayDiag(env, 'BTCUSDT', { fetchImpl: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; } })).status).toBe('timeout');
    expect((await fetchLiquidationOrdersRelayDiag(env, 'BTCUSDT', { fetchImpl: async () => { throw new Error('ECONNRESET'); } })).status).toBe('network');
    expect((await fetchLiquidationOrdersRelayDiag(env, 'BTCUSDT', { fetchImpl: resp(200, { events: [], coverage: { complete: true, reasons: [] } }) })).status).toBe('empty');
  });
  it('applyLiqShadowStep отчита източника и непълното покритие', () => {
    const fr = { source: 'relay', status: 'ok', count: 1, coin: 'BTCUSDT', coinVerified: true, coinRule: 'relay_pair', startTime: now - 1, at: now, orders: [{ side: 1, usdValue: 10, time: now, price: 1 }], coverageComplete: false, coverageReasons: ['gap', 'not_connected'] };
    const d = applyLiqShadowStep(null, fr, { price: 1 }).diag;
    expect(d.sources).toEqual({ relay: 1 });
    expect(d.coverageIncompleteCount).toBe(1);
    expect(d.coverageReasons).toEqual({ gap: 1, not_connected: 1 });
    expect(d.last.source).toBe('relay');
    expect(d.timeline[0].coverageComplete).toBe(false);
  });
});

describe('(D) source guards - SETUP/ARMED/ENTRY не са засегнати', () => {
  it('calcSetupState не чете нищо ликвидационно', () => {
    const start = workerSrc.indexOf('function calcSetupState(');
    const body = workerSrc.slice(start, workerSrc.indexOf('\n}\n', start));
    expect(body).not.toMatch(/liq|cascade|gravity/i);
  });
  it('shadow модулът не пише в state.liqGravity и не праща известия', () => {
    const start = workerSrc.indexOf('// ═══ COINGLASS LIQUIDATION DIAGNOSTICS (SHADOW');
    const end = workerSrc.indexOf('async function runLiqDiagProbe', start);
    const mod = workerSrc.slice(start, end);
    expect(mod).not.toMatch(/\bstate\.liqGravity\s*=/);
    expect(mod).not.toMatch(/accumulateLiquidationGravity\(state\b/);
    expect(mod).not.toContain('sendWhatsApp');
    expect(mod).not.toContain('saveSymbolState');
    expect(mod).not.toContain('markLiqGravityFired');
  });
});

describe('(D) /liq-diagnostics endpoint - read-only, token-защитен', () => {
  const kvWith = (entries) => ({ get: async (k) => entries[k] ?? null, put: async () => { throw new Error('endpoint must not write'); } });
  const call = (path, env) => worker.fetch(new Request(`https://w.mock${path}`), env, { waitUntil() {} });
  it('без/грешен token -> 401', async () => {
    expect((await call('/liq-diagnostics', { TELEMETRY_TOKEN: 'tok', ALERT_STATE: kvWith({}) })).status).toBe(401);
    expect((await call('/liq-diagnostics?token=bad', { TELEMETRY_TOKEN: 'tok', ALERT_STATE: kvWith({}) })).status).toBe(401);
    expect((await call('/liq-diagnostics?token=x', { ALERT_STATE: kvWith({}) })).status).toBe(401);
  });
  it('символ извън WATCHLIST -> 400; probe без symbol -> 400', async () => {
    const env = { TELEMETRY_TOKEN: 'tok', ALERT_STATE: kvWith({}) };
    expect((await call('/liq-diagnostics?token=tok&symbol=FOOUSDT', env)).status).toBe(400);
    expect((await call('/liq-diagnostics/probe?token=tok', env)).status).toBe(400);
    expect((await call('/liq-diagnostics/probe?token=tok&symbol=BTCUSDT&coin=bad!', env)).status).toBe(400);
  });
  it('summary за всички 35 (празен KV) - не пише в KV, показва enabled флага', async () => {
    const res = await call('/liq-diagnostics?token=tok', { TELEMETRY_TOKEN: 'tok', ALERT_STATE: kvWith({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.symbols).toBe(35);
    expect(body.enabled).toBe(false);
    expect(body.neverOk).toHaveLength(35);
  });
});
