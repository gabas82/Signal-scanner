// TREND BALANCE OBSERVATION TRACKER (Etап 2, наблюдателен) - виж коментара
// преди buildTrendObservationRecord в worker.js ("EVAA - POC сочи SHORT, но
// трендът сочи LONG"). Клиентът (signal-scanner.html) изчислява ТРЕНД
// БАЛАНС/TREND TARGET/ИСТОРИЧЕСКИ POC и докладва ГОТОВ снимък през
// /trend-observation; Worker-ът само записва + резолвира резултати.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  buildTrendObservationRecord, resolveTargetHits, isValidTrendObservationPayload,
  checkTrendObservationRateLimit, isTrendObservationDuplicate,
  trendObsHasTrendTargetKey, trendObsMagnetAboveKey, buildTrendObservationHitStats,
  buildTrendObservationSummary,
} from './worker/worker.js';
import worker from './worker/worker.js';

const WORKER_SRC = readFileSync('./worker/worker.js', 'utf8');

function makeKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix } = {}) => ({
      keys: [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
    }),
  };
}

const VALID_PAYLOAD = {
  symbol: 'EVAAUSDT', price: 5.5366, longSharePct: 75,
  goldenCross: true, ls: 5, ss: 0, crossPct: 100, momentumPct: 100, magnetPct: 50,
  magnetAboveCount: 1, magnetBelowCount: 0,
  magnetNearestAboveDistancePct: 8.5, magnetNearestAboveStrengthPct: 6.2,
  magnetNearestBelowDistancePct: null, magnetNearestBelowStrengthPct: null,
  trendTargetPrice: 6.0, trendTargetTier: 'watch', trendTargetDirection: 'long', trendTargetDistancePct: 8.5,
  historicalPocPrice: 1.441, historicalPocTier: 'strong', historicalPocDirection: 'short', historicalPocDistancePct: -74,
};

describe('buildTrendObservationRecord', () => {
  it('строи запис с всички outcome/mfe/mae/hit полета null-ирани/false', () => {
    const r = buildTrendObservationRecord({ ...VALID_PAYLOAD, at: 1000, direction: 'long' });
    expect(r).toMatchObject({
      symbol: 'EVAAUSDT', at: 1000, entryPrice: 5.5366, direction: 'long',
      goldenCross: true, ls: 5, ss: 0, longSharePct: 75,
      magnetAboveCount: 1, magnetBelowCount: 0,
      trendTargetPrice: 6.0, trendTargetDirection: 'long',
      historicalPocPrice: 1.441, historicalPocDirection: 'short',
    });
    expect(r.outcome5m).toBeNull();
    expect(r.outcome240m).toBeNull();
    expect(r.mfe5m).toBeNull();
    expect(r.trendTargetHit).toBe(false);
    expect(r.trendTargetHitAt).toBeNull();
    expect(r.historicalPocHit).toBe(false);
    expect(r.historicalPocHitAt).toBeNull();
  });
  it('липсващи опционални полета -> null/0 fallback, не throw', () => {
    const r = buildTrendObservationRecord({ symbol: 'BTCUSDT', price: 100, at: 1000, direction: 'long' });
    expect(r.magnetAboveCount).toBe(0);
    expect(r.trendTargetPrice).toBeNull();
    expect(r.historicalPocPrice).toBeNull();
  });
});

describe('resolveTargetHits', () => {
  it('LONG trend target се удря отгоре (candle.high >= targetPrice)', () => {
    const p = { trendTargetPrice: 110, trendTargetDirection: 'long', trendTargetHit: false, historicalPocPrice: null, historicalPocDirection: null, historicalPocHit: false };
    resolveTargetHits(p, { high: 111, low: 105 }, 2000);
    expect(p.trendTargetHit).toBe(true);
    expect(p.trendTargetHitAt).toBe(2000);
  });
  it('SHORT historical POC се удря отдолу (candle.low <= targetPrice)', () => {
    const p = { historicalPocPrice: 90, historicalPocDirection: 'short', historicalPocHit: false, trendTargetPrice: null, trendTargetDirection: null, trendTargetHit: false };
    resolveTargetHits(p, { high: 100, low: 89 }, 3000);
    expect(p.historicalPocHit).toBe(true);
    expect(p.historicalPocHitAt).toBe(3000);
  });
  it('не удря -> остава false', () => {
    const p = { trendTargetPrice: 110, trendTargetDirection: 'long', trendTargetHit: false, historicalPocPrice: null, historicalPocDirection: null, historicalPocHit: false };
    resolveTargetHits(p, { high: 105, low: 100 }, 2000);
    expect(p.trendTargetHit).toBe(false);
  });
  it('idempotent - веднъж ударена, не се "отударя" и не пренаписва hitAt', () => {
    const p = { trendTargetPrice: 110, trendTargetDirection: 'long', trendTargetHit: true, trendTargetHitAt: 1500, historicalPocPrice: null, historicalPocDirection: null, historicalPocHit: false };
    resolveTargetHits(p, { high: 200, low: 190 }, 9999);
    expect(p.trendTargetHitAt).toBe(1500);
  });
  it('без candle/липсващи high-low -> не throw, не мутира', () => {
    const p = { trendTargetPrice: 110, trendTargetDirection: 'long', trendTargetHit: false };
    expect(() => resolveTargetHits(p, null)).not.toThrow();
    expect(() => resolveTargetHits(p, {})).not.toThrow();
    expect(p.trendTargetHit).toBe(false);
  });
});

describe('isValidTrendObservationPayload', () => {
  it('валиден payload -> true', () => {
    expect(isValidTrendObservationPayload(VALID_PAYLOAD)).toBe(true);
  });
  it('невалиден символен формат -> false', () => {
    expect(isValidTrendObservationPayload({ ...VALID_PAYLOAD, symbol: 'evaausdt' })).toBe(false);
    expect(isValidTrendObservationPayload({ ...VALID_PAYLOAD, symbol: 'EVAA' })).toBe(false);
    expect(isValidTrendObservationPayload({ ...VALID_PAYLOAD, symbol: '<script>' })).toBe(false);
  });
  it('невалидна цена (<=0 или не число) -> false', () => {
    expect(isValidTrendObservationPayload({ ...VALID_PAYLOAD, price: 0 })).toBe(false);
    expect(isValidTrendObservationPayload({ ...VALID_PAYLOAD, price: '5.5' })).toBe(false);
    expect(isValidTrendObservationPayload({ ...VALID_PAYLOAD, price: -1 })).toBe(false);
  });
  it('longSharePct извън 0-100 -> false', () => {
    expect(isValidTrendObservationPayload({ ...VALID_PAYLOAD, longSharePct: 101 })).toBe(false);
    expect(isValidTrendObservationPayload({ ...VALID_PAYLOAD, longSharePct: -1 })).toBe(false);
  });
  it('невалиден tier -> false', () => {
    expect(isValidTrendObservationPayload({ ...VALID_PAYLOAD, trendTargetTier: 'extreme' })).toBe(false);
  });
  it('невалидна direction стойност -> false', () => {
    expect(isValidTrendObservationPayload({ ...VALID_PAYLOAD, trendTargetDirection: 'up' })).toBe(false);
  });
  it('null/undefined вход -> false, без throw', () => {
    expect(() => isValidTrendObservationPayload(null)).not.toThrow();
    expect(isValidTrendObservationPayload(null)).toBe(false);
    expect(isValidTrendObservationPayload(undefined)).toBe(false);
  });
});

describe('checkTrendObservationRateLimit', () => {
  it('под лимита -> true, брояча се инкрементира', async () => {
    const kv = makeKv();
    const ok = await checkTrendObservationRateLimit({ ALERT_STATE: kv }, '1.2.3.4');
    expect(ok).toBe(true);
  });
  it('над лимита -> false', async () => {
    const bucket = Math.floor(Date.now() / 60000);
    const kv = makeKv({ [`trendobsrate:1.2.3.4:${bucket}`]: '20' });
    const ok = await checkTrendObservationRateLimit({ ALERT_STATE: kv }, '1.2.3.4');
    expect(ok).toBe(false);
  });
  it('липсващ IP или ALERT_STATE -> fail-open (true)', async () => {
    expect(await checkTrendObservationRateLimit({ ALERT_STATE: makeKv() }, '')).toBe(true);
    expect(await checkTrendObservationRateLimit({}, '1.2.3.4')).toBe(true);
  });
});

describe('isTrendObservationDuplicate', () => {
  it('скорошен запис (под 4 мин) -> true (дубликат)', async () => {
    const now = 1000000;
    const kv = makeKv({ 'trendobslast:EVAAUSDT': String(now - 60000) });
    expect(await isTrendObservationDuplicate({ ALERT_STATE: kv }, 'EVAAUSDT', now)).toBe(true);
  });
  it('по-стар от 4 мин запис -> false', async () => {
    const now = 1000000;
    const kv = makeKv({ 'trendobslast:EVAAUSDT': String(now - 5 * 60000) });
    expect(await isTrendObservationDuplicate({ ALERT_STATE: kv }, 'EVAAUSDT', now)).toBe(false);
  });
  it('няма предходен запис -> false', async () => {
    expect(await isTrendObservationDuplicate({ ALERT_STATE: makeKv() }, 'EVAAUSDT')).toBe(false);
  });
});

describe('diagnostics aggregators', () => {
  it('trendObsHasTrendTargetKey различава withTrendTarget/noTrendTarget', () => {
    expect(trendObsHasTrendTargetKey({ trendTargetTier: 'watch' })).toBe('withTrendTarget');
    expect(trendObsHasTrendTargetKey({ trendTargetTier: 'none' })).toBe('noTrendTarget');
    expect(trendObsHasTrendTargetKey({ trendTargetTier: null })).toBe('noTrendTarget');
  });
  it('trendObsMagnetAboveKey различава hasMagnetAbove/noMagnetAbove', () => {
    expect(trendObsMagnetAboveKey({ magnetAboveCount: 2 })).toBe('hasMagnetAbove');
    expect(trendObsMagnetAboveKey({ magnetAboveCount: 0 })).toBe('noMagnetAbove');
  });
  it('buildTrendObservationHitStats смята hit rate и средно време до удар', () => {
    const records = [
      { at: 1000, trendTargetPrice: 110, trendTargetHit: true, trendTargetHitAt: 1000 + 10 * 60000 },
      { at: 2000, trendTargetPrice: 120, trendTargetHit: false, trendTargetHitAt: null },
      { at: 3000, trendTargetPrice: null, trendTargetHit: false, trendTargetHitAt: null },
    ];
    const stats = buildTrendObservationHitStats(records, 'trendTargetPrice', 'trendTargetHit', 'trendTargetHitAt');
    expect(stats.count).toBe(2);
    expect(stats.hitCount).toBe(1);
    expect(stats.hitRatePct).toBe(50);
    expect(stats.avgTimeToHitMin).toBeCloseTo(10, 1);
  });
  it('buildTrendObservationSummary комбинира всички разрези, не хвърля на празен вход', () => {
    const summary = buildTrendObservationSummary([]);
    expect(summary.overall).toEqual({});
    expect(summary.trendTargetHitStats.count).toBe(0);
  });
});

// STRUCTURAL - потвърждава wiring-а в scanSymbolSignals (резолюцията е
// огледална на pendingTagOutcomes) директно от source-а, виж (D) подхода в
// worker-liquidation-veto.test.js / worker-tag-outcome-tracker.test.js.
describe('scanSymbolSignals wiring (structural)', () => {
  it('резолюцията на pendingTrendObservations е преди saveSymbolState', () => {
    const needle = 'if (state.pendingTrendObservations && state.pendingTrendObservations.length && env.ALERT_STATE) {';
    const idx = WORKER_SRC.indexOf(needle);
    expect(idx).toBeGreaterThan(-1);
    const saveIdx = WORKER_SRC.indexOf('await saveSymbolState(env, symbol, state);');
    expect(saveIdx).toBeGreaterThan(idx);
  });
  it('resolveTargetHits се извиква в резолюционния блок', () => {
    expect(WORKER_SRC.includes('resolveTargetHits(p, lastClosed5mForTrendObs);')).toBe(true);
  });
});

describe('/trend-observation endpoint', () => {
  const call = (env, body) => worker.fetch(new Request('https://w.mock/trend-observation', { method: 'POST', body: JSON.stringify(body) }), env, { waitUntil() {} });

  it('валиден payload -> 200, записва KV + pending state', async () => {
    const kv = makeKv();
    const res = await call({ ALERT_STATE: kv }, VALID_PAYLOAD);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const trendObsKeys = [...kv.m.keys()].filter(k => k.startsWith('trendobs:EVAAUSDT:'));
    expect(trendObsKeys.length).toBe(1);
    const stateRaw = await kv.get('sigstate:EVAAUSDT');
    const state = JSON.parse(stateRaw);
    expect(state.pendingTrendObservations.length).toBe(1);
    expect(state.pendingTrendObservations[0].trendTargetPrice).toBe(6.0);
  });

  it('невалиден payload -> 400, не пише нищо', async () => {
    const kv = makeKv();
    const res = await call({ ALERT_STATE: kv }, { ...VALID_PAYLOAD, symbol: 'bad' });
    expect(res.status).toBe(400);
    expect(kv.m.size).toBe(0);
  });

  it('невалиден JSON -> 400', async () => {
    const res = await worker.fetch(new Request('https://w.mock/trend-observation', { method: 'POST', body: 'not json' }), { ALERT_STATE: makeKv() }, { waitUntil() {} });
    expect(res.status).toBe(400);
  });

  it('дублиран запис в рамките на dedup прозореца -> 200 { deduped: true }, без нов KV запис', async () => {
    const now = Date.now();
    const kv = makeKv({ 'trendobslast:EVAAUSDT': String(now - 60000) });
    const res = await call({ ALERT_STATE: kv }, VALID_PAYLOAD);
    const body = await res.json();
    expect(body.deduped).toBe(true);
    const trendObsKeys = [...kv.m.keys()].filter(k => k.startsWith('trendobs:EVAAUSDT:'));
    expect(trendObsKeys.length).toBe(0);
  });

  it('rate limit надвишен -> 429', async () => {
    const bucket = Math.floor(Date.now() / 60000);
    const kv = makeKv({ [`trendobsrate:5.6.7.8:${bucket}`]: '20' });
    const req = new Request('https://w.mock/trend-observation', {
      method: 'POST', body: JSON.stringify(VALID_PAYLOAD), headers: { 'CF-Connecting-IP': '5.6.7.8' },
    });
    const res = await worker.fetch(req, { ALERT_STATE: kv }, { waitUntil() {} });
    expect(res.status).toBe(429);
  });

  it('без ALERT_STATE -> 500', async () => {
    const res = await call({}, VALID_PAYLOAD);
    expect(res.status).toBe(500);
  });
});

describe('/trend-observation-diagnostics endpoint', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/trend-observation-diagnostics${qs}`), env, { waitUntil() {} });

  it('без/грешен token -> 401', async () => {
    const res = await call({ ALERT_STATE: makeKv(), TELEMETRY_TOKEN: 'secret' });
    expect(res.status).toBe(401);
  });

  it('с валиден token връща записите + агрегирания summary', async () => {
    const r1 = buildTrendObservationRecord({ ...VALID_PAYLOAD, at: 1000, direction: 'long' });
    const kv = makeKv({ 'trendobs:EVAAUSDT:1000': JSON.stringify(r1) });
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.records[0].symbol).toBe('EVAAUSDT');
    expect(body.summary.byTrendTargetPresence.withTrendTarget).toBeDefined();
  });

  it('read-only - не пише в KV', async () => {
    const kv = makeKv({ 'trendobs:EVAAUSDT:1000': JSON.stringify(buildTrendObservationRecord({ ...VALID_PAYLOAD, at: 1000, direction: 'long' })) });
    let wrote = false;
    const originalPut = kv.put;
    kv.put = async (...args) => { wrote = true; return originalPut(...args); };
    await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    expect(wrote).toBe(false);
  });
});
