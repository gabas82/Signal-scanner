// ROTATION TRACKER - следи динамичната dashboard листа (base+gainers+OI+
// trending), различна от фиксирания 35-символен WATCHLIST. Чисто observational
// логика (влизане/излизане/резултат по-късно) - виж бележката в worker.js
// преди diffRotationMembership за пълния контекст.
import { describe, it, expect, afterEach } from 'vitest';
import {
  rankRotationCandidates, buildPendingRotationHorizons, calcRotationOutcomePct,
  diffRotationMembership, resolvePendingRotationOutcomes, ROTATION_OUTCOME_HORIZONS_MIN,
  selectHighMoveSymbols, selectHighVolumeSymbols, buildRotationCandidates,
  BASE_ROTATION_SYMBOLS, trackCoinRotation, ROTATION_STATE_KEY, ROTATION_PENDING_KEY,
} from './worker/worker.js';
import worker from './worker/worker.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

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

function tickerRow(symbol, { price = 1, chg = 0, vol = 0 } = {}) {
  return { symbol, lastPrice: String(price), priceChangePercent: String(chg), quoteVolume: String(vol) };
}

describe('rankRotationCandidates', () => {
  it('подрежда по vol24 низходящо', () => {
    const coins = [
      { symbol: 'A', vol24: 1000, price: 1 },
      { symbol: 'B', vol24: 5000, price: 1 },
      { symbol: 'C', vol24: 3000, price: 1 },
    ];
    const ranked = rankRotationCandidates(coins);
    expect(ranked.map(c => c.symbol)).toEqual(['B', 'C', 'A']);
  });
  it('не мутира входния масив', () => {
    const coins = [{ symbol: 'A', vol24: 1 }, { symbol: 'B', vol24: 2 }];
    const copy = [...coins];
    rankRotationCandidates(coins);
    expect(coins).toEqual(copy);
  });
  it('третира липсващ vol24 като 0', () => {
    const coins = [{ symbol: 'A' }, { symbol: 'B', vol24: 5 }];
    expect(rankRotationCandidates(coins).map(c => c.symbol)).toEqual(['B', 'A']);
  });
});

describe('buildPendingRotationHorizons', () => {
  it('изгражда m60/m240/m1440 хоризонти, нито един resolved', () => {
    const exitedAt = 1_000_000;
    const h = buildPendingRotationHorizons(exitedAt);
    expect(Object.keys(h).sort()).toEqual(['m1440', 'm240', 'm60']);
    for (const m of ROTATION_OUTCOME_HORIZONS_MIN) {
      expect(h[`m${m}`]).toEqual({ dueAt: exitedAt + m * 60000, resolved: false });
    }
  });
});

describe('calcRotationOutcomePct', () => {
  it('връща положителен %, ако цената е нараснала след излизане', () => {
    expect(calcRotationOutcomePct(100, 110)).toBeCloseTo(10);
  });
  it('връща отрицателен %, ако цената е спаднала след излизане', () => {
    expect(calcRotationOutcomePct(100, 90)).toBeCloseTo(-10);
  });
  it('връща null при липсващи или невалидни цени', () => {
    expect(calcRotationOutcomePct(null, 100)).toBeNull();
    expect(calcRotationOutcomePct(100, null)).toBeNull();
    expect(calcRotationOutcomePct(0, 100)).toBeNull();
  });
});

describe('diffRotationMembership', () => {
  it('нова монета без предишно състояние -> ново влизане, entryRank = текущия ѝ rank', () => {
    const { activeState, exitedRecords } = diffRotationMembership({}, [
      { symbol: 'BTCUSDT', price: 65000, sourceTags: ['base'] },
    ], 1000);
    expect(exitedRecords).toEqual([]);
    expect(activeState.BTCUSDT).toMatchObject({
      enteredAt: 1000, entryPrice: 65000, entryRank: 0, peakRank: 0,
      maxPrice: 65000, minPrice: 65000, lastPrice: 65000, sourceTags: ['base'], lastSeenAt: 1000,
    });
  });

  it('монета, която продължава да е в листата - опреснява lastSeenAt/peakRank/max-min цена, пази entryPrice/entryRank', () => {
    const prev = {
      BTCUSDT: { enteredAt: 1000, entryPrice: 65000, entryRank: 3, peakRank: 3, maxPrice: 65000, minPrice: 65000, lastPrice: 65000, sourceTags: ['base'], lastSeenAt: 1000 },
    };
    const { activeState } = diffRotationMembership(prev, [
      { symbol: 'BTCUSDT', price: 66500 },
    ], 2000);
    // rank на тика е 0 (единствена монета в batch-а) -> по-добър от предишния peakRank(3)
    expect(activeState.BTCUSDT).toMatchObject({
      enteredAt: 1000, entryPrice: 65000, entryRank: 3, peakRank: 0,
      maxPrice: 66500, minPrice: 65000, lastPrice: 66500, lastSeenAt: 2000,
    });
  });

  it('монета, изчезнала В РАМКИТЕ на GAP толеранса - НЕ се брои за излязла, пази се в activeState', () => {
    const prev = {
      ETHUSDT: { enteredAt: 1000, entryPrice: 1800, entryRank: 1, peakRank: 1, maxPrice: 1800, minPrice: 1800, lastPrice: 1800, sourceTags: [], lastSeenAt: 1000 },
    };
    const now = 1000 + 5 * 60000; // 5 мин по-късно - вътре в 12-мин толеранса
    const { activeState, exitedRecords } = diffRotationMembership(prev, [], now);
    expect(exitedRecords).toEqual([]);
    expect(activeState.ETHUSDT).toEqual(prev.ETHUSDT);
  });

  it('монета, отсъстваща ПОВЕЧЕ от GAP толеранса - реално излизане, финализиран запис с pending хоризонти', () => {
    const prev = {
      ETHUSDT: { enteredAt: 1000, entryPrice: 1800, entryRank: 1, peakRank: 0, maxPrice: 1900, minPrice: 1750, lastPrice: 1850, sourceTags: ['gainer'], lastSeenAt: 2000 },
    };
    const now = 2000 + 13 * 60000; // 13 мин - извън 12-мин толеранса
    const { activeState, exitedRecords } = diffRotationMembership(prev, [], now);
    expect(activeState.ETHUSDT).toBeUndefined();
    expect(exitedRecords).toHaveLength(1);
    expect(exitedRecords[0]).toMatchObject({
      symbol: 'ETHUSDT', enteredAt: 1000, exitedAt: 2000, durationMin: (2000 - 1000) / 60000,
      entryPrice: 1800, exitPrice: 1850, entryRank: 1, peakRank: 0,
      maxPrice: 1900, minPrice: 1750, sourceTags: ['gainer'],
      outcome60m: null, outcome240m: null, outcome1440m: null,
    });
    expect(exitedRecords[0].horizons.m60.dueAt).toBe(2000 + 60 * 60000);
  });

  it('смесен тик - едновременно ново влизане, продължаващо присъствие и реално излизане', () => {
    const prev = {
      AAAUSDT: { enteredAt: 0, entryPrice: 10, entryRank: 0, peakRank: 0, maxPrice: 10, minPrice: 10, lastPrice: 10, sourceTags: [], lastSeenAt: 0 }, // ще излезе
      BBBUSDT: { enteredAt: 0, entryPrice: 20, entryRank: 1, peakRank: 1, maxPrice: 20, minPrice: 20, lastPrice: 20, sourceTags: [], lastSeenAt: 0 }, // продължава
    };
    const now = 20 * 60000; // 20 мин - извън толеранса за AAAUSDT
    const { activeState, exitedRecords } = diffRotationMembership(prev, [
      { symbol: 'BBBUSDT', price: 21, sourceTags: [] },
      { symbol: 'CCCUSDT', price: 5, sourceTags: ['trending'] }, // ново
    ], now);
    expect(Object.keys(activeState).sort()).toEqual(['BBBUSDT', 'CCCUSDT']);
    expect(exitedRecords.map(r => r.symbol)).toEqual(['AAAUSDT']);
    expect(activeState.CCCUSDT.enteredAt).toBe(now);
  });
});

describe('resolvePendingRotationOutcomes', () => {
  it('не резолвира хоризонт, преди dueAt да е минал', () => {
    const pending = { exitPrice: 100, horizons: { m60: { dueAt: 100000, resolved: false } } };
    const { updates, allResolved } = resolvePendingRotationOutcomes(pending, 110, 50000);
    expect(updates).toEqual({});
    expect(allResolved).toBe(false);
  });
  it('резолвира хоризонт, чиито dueAt е минал, с правилния % от calcRotationOutcomePct', () => {
    const pending = { exitPrice: 100, horizons: { m60: { dueAt: 100000, resolved: false } } };
    const { updates, allResolved } = resolvePendingRotationOutcomes(pending, 110, 150000);
    expect(updates.outcome60m).toBeCloseTo(10);
    expect(allResolved).toBe(true);
    expect(pending.horizons.m60.resolved).toBe(true);
  });
  it('allResolved=false, докато поне един хоризонт чака', () => {
    const pending = {
      exitPrice: 100,
      horizons: { m60: { dueAt: 100000, resolved: true }, m240: { dueAt: 400000, resolved: false } },
    };
    const { updates, allResolved } = resolvePendingRotationOutcomes(pending, 90, 150000);
    expect(updates).toEqual({});
    expect(allResolved).toBe(false);
  });
  it('не резолвира повторно вече резолвнат хоризонт', () => {
    const pending = { exitPrice: 100, horizons: { m60: { dueAt: 100000, resolved: true } } };
    const { updates } = resolvePendingRotationOutcomes(pending, 999, 999999999);
    expect(updates).toEqual({});
  });
  it('третира липсващи/невалидни horizons defensive-but graceful (легаси запис)', () => {
    expect(resolvePendingRotationOutcomes({ exitPrice: 100 }, 110, 1000)).toEqual({ updates: {}, allResolved: true });
  });
});

describe('selectHighMoveSymbols', () => {
  it('филтрира по chg24%>5 И quoteVolume>5M, сортира низходящо, до 15', () => {
    const bulk = [
      tickerRow('AUSDT', { chg: 10, vol: 6000000 }),
      tickerRow('BUSDT', { chg: 20, vol: 6000000 }),
      tickerRow('CUSDT', { chg: 4, vol: 6000000 }),  // под 5% прага
      tickerRow('DUSDT', { chg: 15, vol: 1000000 }), // под volume прага
      tickerRow('_FUTEXP', { chg: 50, vol: 9000000 }), // не завършва на USDT
    ];
    expect(selectHighMoveSymbols(bulk)).toEqual(['BUSDT', 'AUSDT']);
  });
  it('връща [] при невалиден вход', () => {
    expect(selectHighMoveSymbols(null)).toEqual([]);
    expect(selectHighMoveSymbols(undefined)).toEqual([]);
  });
});

describe('selectHighVolumeSymbols', () => {
  it('филтрира по quoteVolume>100M, сортира низходящо, до 10', () => {
    const bulk = [
      tickerRow('AUSDT', { vol: 200000000 }),
      tickerRow('BUSDT', { vol: 500000000 }),
      tickerRow('CUSDT', { vol: 50000000 }), // под прага
    ];
    expect(selectHighVolumeSymbols(bulk)).toEqual(['BUSDT', 'AUSDT']);
  });
});

describe('buildRotationCandidates', () => {
  it('включва base символ дори без gainer/high-volume таг, с vol24>1M', () => {
    const bulk = [tickerRow('BTCUSDT', { price: 65000, vol: 2000000 })];
    const result = buildRotationCandidates(bulk);
    expect(result).toEqual([{ symbol: 'BTCUSDT', price: 65000, vol24: 2000000, chg24: 0, sourceTags: ['base'] }]);
  });
  it('изключва base символ с vol24<=1M (СЪЩИЯ филтър като клиента)', () => {
    const bulk = [tickerRow('BTCUSDT', { price: 65000, vol: 500000 })];
    expect(buildRotationCandidates(bulk)).toEqual([]);
  });
  it('маркира gainer/highVolume таговете правилно, дори за символ извън base', () => {
    const bulk = [tickerRow('ZZZUSDT', { price: 2, chg: 20, vol: 200000000 })];
    const result = buildRotationCandidates(bulk);
    expect(result[0].sourceTags.sort()).toEqual(['gainer', 'highVolume']);
  });
  it('пропуска символ, отсъстващ от bulk ticker-а (само в BASE_ROTATION_SYMBOLS списъка)', () => {
    expect(buildRotationCandidates([])).toEqual([]);
  });
  it('BASE_ROTATION_SYMBOLS не е празен и съдържа BTCUSDT/ETHUSDT', () => {
    expect(BASE_ROTATION_SYMBOLS).toContain('BTCUSDT');
    expect(BASE_ROTATION_SYMBOLS).toContain('ETHUSDT');
    expect(BASE_ROTATION_SYMBOLS.length).toBeGreaterThan(0);
  });
});

describe('trackCoinRotation (orchestration, fake KV + fetch)', () => {
  it('без ALERT_STATE или RELAY_URL -> no-op, не хвърля грешка', async () => {
    await expect(trackCoinRotation({})).resolves.toBeUndefined();
    await expect(trackCoinRotation({ ALERT_STATE: makeKv() })).resolves.toBeUndefined();
  });

  it('първи tick - записва нови влизания в rotation:active, не финализира нищо', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify([
      tickerRow('BTCUSDT', { price: 65000, vol: 2000000 }),
    ]), { status: 200 });
    const kv = makeKv();
    await trackCoinRotation({ ALERT_STATE: kv, RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 't' });
    const active = JSON.parse(kv.m.get(ROTATION_STATE_KEY));
    expect(active.BTCUSDT).toBeDefined();
    expect(active.BTCUSDT.entryPrice).toBe(65000);
    expect([...kv.m.keys()].some(k => k.startsWith('rotation:BTCUSDT:'))).toBe(false);
  });

  it('символ излиза извън GAP толеранса -> финализиран rotation: запис се появява в KV', async () => {
    const enteredAt = 1000;
    const lastSeenAt = 2000;
    const seededActive = { ETHUSDT: { enteredAt, entryPrice: 1800, entryRank: 0, peakRank: 0, maxPrice: 1850, minPrice: 1750, lastPrice: 1820, sourceTags: ['base'], lastSeenAt } };
    const kv = makeKv({ [ROTATION_STATE_KEY]: JSON.stringify(seededActive) });
    const now = lastSeenAt + 13 * 60000; // извън 12-мин толеранса
    const realDateNow = Date.now;
    Date.now = () => now;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify([]), { status: 200 }); // ETHUSDT вече не е в bulk-а
      await trackCoinRotation({ ALERT_STATE: kv, RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 't' });
    } finally { Date.now = realDateNow; }
    const key = `rotation:ETHUSDT:${enteredAt}`;
    expect(kv.m.has(key)).toBe(true);
    const record = JSON.parse(kv.m.get(key));
    expect(record).toMatchObject({ symbol: 'ETHUSDT', enteredAt, exitedAt: lastSeenAt, exitPrice: 1820, outcome60m: null });
    const pending = JSON.parse(kv.m.get(ROTATION_PENDING_KEY));
    expect(pending).toHaveLength(1);
    expect(pending[0].symbol).toBe('ETHUSDT');
  });

  it('резолвира due хоризонт от pending опашката и обновява финализирания запис в KV', async () => {
    const exitedRecord = {
      symbol: 'ETHUSDT', enteredAt: 1000, exitedAt: 2000, durationMin: 16.6,
      entryPrice: 1800, exitPrice: 1800, entryRank: 0, peakRank: 0,
      maxPrice: 1850, minPrice: 1750, sourceTags: ['base'],
      horizons: { m60: { dueAt: 2000 + 60 * 60000, resolved: false } },
      outcome60m: null, outcome240m: null, outcome1440m: null,
    };
    const kv = makeKv({
      [ROTATION_STATE_KEY]: JSON.stringify({}),
      [ROTATION_PENDING_KEY]: JSON.stringify([{ symbol: 'ETHUSDT', enteredAt: 1000, exitPrice: 1800, horizons: exitedRecord.horizons }]),
      'rotation:ETHUSDT:1000': JSON.stringify(exitedRecord),
    });
    const now = 2000 + 65 * 60000; // хоризонтът вече е due
    const realDateNow = Date.now;
    Date.now = () => now;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify([tickerRow('ETHUSDT', { price: 1980 })]), { status: 200 });
      await trackCoinRotation({ ALERT_STATE: kv, RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 't' });
    } finally { Date.now = realDateNow; }
    const updated = JSON.parse(kv.m.get('rotation:ETHUSDT:1000'));
    expect(updated.outcome60m).toBeCloseTo(10); // (1980-1800)/1800*100
    const pending = JSON.parse(kv.m.get(ROTATION_PENDING_KEY));
    expect(pending).toEqual([]); // единственият хоризонт е резолвнат -> изчезва от опашката
  });
});

describe('/rotation-diagnostics endpoint', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/rotation-diagnostics${qs}`), env, { waitUntil() {} });

  it('без/грешен token -> 401', async () => {
    const res = await call({ ALERT_STATE: makeKv(), TELEMETRY_TOKEN: 'secret' });
    expect(res.status).toBe(401);
  });

  it('с валиден token връща активните и финализираните записи', async () => {
    const kv = makeKv({
      [ROTATION_STATE_KEY]: JSON.stringify({ BTCUSDT: { entryPrice: 65000 } }),
      'rotation:ETHUSDT:1000': JSON.stringify({ symbol: 'ETHUSDT', exitedAt: 5000 }),
    });
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeCount).toBe(1);
    expect(body.exitedCount).toBe(1);
    expect(body.exited[0].symbol).toBe('ETHUSDT');
  });

  it('read-only - не пише в KV', async () => {
    const kv = makeKv({ [ROTATION_STATE_KEY]: JSON.stringify({}) });
    await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    let wrote = false;
    const originalPut = kv.put;
    kv.put = async (...args) => { wrote = true; return originalPut(...args); };
    await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    expect(wrote).toBe(false);
  });
});
