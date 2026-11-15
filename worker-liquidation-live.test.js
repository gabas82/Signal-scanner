// BINANCE LIQUIDATION LIVE (Етап 2 - реално влияние, виж доклада "Binance
// Liquidation Integration"). Тества РЕАЛНИЯ worker.js (директен ESM import).
// Покрива:
// (A) isLiqLiveEnabled - fail-closed флаг (огледален на isLiqDiagEnabled).
// (B) fetchLiquidationOrdersLive - hasData разграничава "няма данни" (relay
//     недостъпен/грешка/изключен) от "данни получени, но прозорецът е празен"
//     (легитимен нулев резултат) - виж изискването да не третираме липсата
//     на данни като потвърждение.
// (C) liqConfirmStatus - 4-те състояния (confirm/against/neutral/no_data) -
//     exhaustive проверка, никога no_data не се интерпретира като confirm.
// (D) buildTelemetryRecord - новото liqConfirm поле, обратно съвместимо
//     (по подразбиране null, когато LIQ_LIVE е изключен).
// (E) END-TO-END scanSymbolSignals:
//     - LIQ_LIVE_ENABLED ИЗКЛЮЧЕН (default) -> резултат/sigstate БАЙТ-
//       ИДЕНТИЧНИ с оригиналния worker.js (преди тази промяна, origin/main) -
//       доказва нулева регресия за всички съществуващи потребители на флага.
//     - ВКЛЮЧЕН -> calcLiquidationCascade/accumulateLiquidationGravity се
//       захранват от реални Binance relay данни; еднократен reset на
//       liqGravity при първо активиране; relay грешка/изключване НИКОГА не
//       се чете като потвърждение (hasData=false -> cascade неутрален).
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  isLiqLiveEnabled, fetchLiquidationOrdersLive, liqConfirmStatus, LIQ_CONFIRM_LABELS,
  buildTelemetryRecord, scanSymbolSignals,
} from './worker/worker.js';

const realFetch = globalThis.fetch;
const realNow = Date.now;
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });

describe('(A) isLiqLiveEnabled - fail-closed, огледален на isLiqDiagEnabled', () => {
  it('отсъстващ/произволен env -> false (старото поведение по подразбиране)', () => {
    expect(isLiqLiveEnabled({})).toBe(false);
    expect(isLiqLiveEnabled({ LIQ_LIVE_ENABLED: '0' })).toBe(false);
    expect(isLiqLiveEnabled({ LIQ_LIVE_ENABLED: 'true' })).toBe(false);
    expect(isLiqLiveEnabled({ LIQ_LIVE_ENABLED: '' })).toBe(false);
    expect(isLiqLiveEnabled(undefined)).toBe(false);
    expect(isLiqLiveEnabled(null)).toBe(false);
  });
  it("само точно '1' (с trim) активира", () => {
    expect(isLiqLiveEnabled({ LIQ_LIVE_ENABLED: '1' })).toBe(true);
    expect(isLiqLiveEnabled({ LIQ_LIVE_ENABLED: ' 1 ' })).toBe(true);
  });
});

describe('(B) fetchLiquidationOrdersLive - hasData разграничение', () => {
  const env = { RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 'relay-secret-xyz' };
  function mockRelay(status, body) {
    globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
  }
  it("status 'ok' (има събития) -> hasData true, orders подадени непроменени", async () => {
    mockRelay(200, { events: [{ side: 1, usdValue: 900000, time: Date.now(), price: 100 }], coverage: { complete: true, reasons: [] } });
    const r = await fetchLiquidationOrdersLive(env, 'BTCUSDT');
    expect(r.hasData).toBe(true);
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ side: 1, usdValue: 900000 });
  });
  it("status 'empty' (0 събития в прозореца) -> hasData true - ЛЕГИТИМНИ данни, не 'липса на данни'", async () => {
    mockRelay(200, { events: [], coverage: { complete: true, reasons: [] } });
    const r = await fetchLiquidationOrdersLive(env, 'BTCUSDT');
    expect(r.hasData).toBe(true);
    expect(r.orders).toEqual([]);
  });
  it('relay колекторът е изключен (503 source_disabled) -> hasData false', async () => {
    mockRelay(503, { reason: 'LIQ_COLLECTOR_ENABLED is not 1' });
    const r = await fetchLiquidationOrdersLive(env, 'BTCUSDT');
    expect(r.hasData).toBe(false);
    expect(r.orders).toEqual([]);
  });
  it('HTTP грешка от relay -> hasData false', async () => {
    mockRelay(500, { error: 'boom' });
    const r = await fetchLiquidationOrdersLive(env, 'BTCUSDT');
    expect(r.hasData).toBe(false);
  });
  it('мрежова грешка (fetch хвърля/timeout) -> hasData false, никога не чупи caller-а', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };
    const r = await fetchLiquidationOrdersLive(env, 'BTCUSDT');
    expect(r.hasData).toBe(false);
    expect(r.orders).toEqual([]);
  });
  it('липсващ RELAY_URL/RELAY_TOKEN -> hasData false (no_relay), без мрежова заявка', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
    const r = await fetchLiquidationOrdersLive({}, 'BTCUSDT');
    expect(r.hasData).toBe(false);
    expect(called).toBe(false);
  });
});

describe('(C) liqConfirmStatus - 4 състояния, никога no_data -> confirm', () => {
  const bullish = { bullish: true, bearish: false };
  const bearish = { bullish: false, bearish: true };
  const neutral = { bullish: false, bearish: false };
  it('hasData=false -> винаги no_data, независимо от cascade съдържанието', () => {
    expect(liqConfirmStatus(bullish, false, 'long')).toBe('no_data');
    expect(liqConfirmStatus(bearish, false, 'short')).toBe('no_data');
    expect(liqConfirmStatus(neutral, false, 'long')).toBe('no_data');
    expect(liqConfirmStatus(null, false, 'long')).toBe('no_data');
  });
  it('cascade=null/undefined при hasData=true -> defensive no_data (никога confirm)', () => {
    expect(liqConfirmStatus(null, true, 'long')).toBe('no_data');
    expect(liqConfirmStatus(undefined, true, 'short')).toBe('no_data');
  });
  it('данни има, каскадата съвпада с посоката -> confirm', () => {
    expect(liqConfirmStatus(bullish, true, 'long')).toBe('confirm');
    expect(liqConfirmStatus(bearish, true, 'short')).toBe('confirm');
  });
  it('данни има, каскадата е в противоположна посока -> against', () => {
    expect(liqConfirmStatus(bearish, true, 'long')).toBe('against');
    expect(liqConfirmStatus(bullish, true, 'short')).toBe('against');
  });
  it('данни има, но няма каскада в нито посока -> neutral (НЕ against, НЕ confirm)', () => {
    expect(liqConfirmStatus(neutral, true, 'long')).toBe('neutral');
    expect(liqConfirmStatus(neutral, true, 'short')).toBe('neutral');
  });
  it('LIQ_CONFIRM_LABELS покрива точно 4-те състояния; no_data текстът не твърди потвърждение', () => {
    expect(Object.keys(LIQ_CONFIRM_LABELS).sort()).toEqual(['against', 'confirm', 'neutral', 'no_data']);
    expect(LIQ_CONFIRM_LABELS.no_data.toLowerCase()).not.toContain('потвърждение');
    expect(LIQ_CONFIRM_LABELS.neutral.toLowerCase()).not.toContain('потвърждение');
  });
});

describe('(D) buildTelemetryRecord - liqConfirm поле (обратно съвместимо)', () => {
  const baseArgs = {
    symbol: 'BTCUSDT', direction: 'long', decision: 'confirmed', setupScore: 3, setupBreakdown: {},
    armedAt: Date.now(), structRef: 100, triggerClose: 101, atr5m: 1, triggerRange: 1,
    confirmation15m: true, flowState: 'neutral', setupMode: 'mean_reversion', htfAligned: true,
  };
  it('не е подадено (LIQ_LIVE изключен) -> liqConfirm null, старите полета непроменени', () => {
    const r = buildTelemetryRecord(baseArgs);
    expect(r.liqConfirm).toBeNull();
    expect(r.htfAligned).toBe(true);
  });
  it("подадено 'confirm'/'against'/'neutral'/'no_data' -> записва се точно както е подадено", () => {
    for (const v of ['confirm', 'against', 'neutral', 'no_data']) {
      expect(buildTelemetryRecord({ ...baseArgs, liqConfirm: v }).liqConfirm).toBe(v);
    }
  });
});

describe('(E) END-TO-END scanSymbolSignals - LIQ_LIVE_ENABLED', () => {
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
  function makeKv(seed = {}) {
    const m = new Map(Object.entries(seed));
    return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) };
  }
  // relayEvents е мутируем масив - позволява на един и същ router да връща
  // различни /liquidations отговори между последователни тикове в един тест
  // (виж тестa за "еднократен reset" и "непрекъснато натрупване" по-долу).
  function router({ relayEvents = [], relayStatus = 200, relayCalls = [] } = {}) {
    return async (url) => {
      const s = String(url);
      if (s.includes('/liquidations?')) {
        relayCalls.push(s);
        if (relayStatus !== 200) return new Response(JSON.stringify({ reason: 'disabled' }), { status: relayStatus });
        return new Response(JSON.stringify({ symbol: 'BTCUSDT', count: relayEvents.length, truncated: false, events: relayEvents, coverage: { complete: true, reasons: [], gaps: [], connected: true } }), { status: 200 });
      }
      if (s.includes('/klines')) {
        const u = new URL(s);
        return new Response(JSON.stringify(klines(u.searchParams.get('interval'), Number(u.searchParams.get('limit')))), { status: 200 });
      }
      return new Response(JSON.stringify({ code: -1, msg: 'mock unavailable' }), { status: 503 });
    };
  }

  describe('флаг ИЗКЛЮЧЕН (default) - нулева регресия спрямо оригиналния worker.js', () => {
    let originalScanSymbolSignals;
    beforeAll(async () => {
      // Дъмпва ТОЧНО кода от origin/main (преди тази PR) във временен файл и
      // го импортира динамично - "байт-идентично" сравнение срещу РЕАЛНИЯ
      // стар код, не срещу предположения за старото му поведение.
      const originalSrc = execSync('git show origin/main:worker/worker.js', { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 50 }).toString();
      const tmpFile = path.join(os.tmpdir(), `worker-original-${Date.now()}.mjs`);
      fs.writeFileSync(tmpFile, originalSrc);
      const mod = await import(pathToFileURL(tmpFile).href);
      originalScanSymbolSignals = mod.scanSymbolSignals;
      fs.unlinkSync(tmpFile);
    });

    it('без LIQ_LIVE_ENABLED - резултат и sigstate са БАЙТ-ИДЕНТИЧНИ с origin/main', async () => {
      const relayCalls = [];
      const envBase = () => ({ RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 'relay-secret-xyz' });

      Date.now = () => FIXED_NOW;
      globalThis.fetch = router({ relayEvents: [{ side: 1, usdValue: 820000, time: FIXED_NOW - 30000, price: 99500 }], relayCalls });
      const kvOld = makeKv();
      const oldResult = await originalScanSymbolSignals({ ...envBase(), ALERT_STATE: kvOld }, 'BTCUSDT');

      Date.now = () => FIXED_NOW;
      globalThis.fetch = router({ relayEvents: [{ side: 1, usdValue: 820000, time: FIXED_NOW - 30000, price: 99500 }], relayCalls });
      const kvNew = makeKv();
      const newResult = await scanSymbolSignals({ ...envBase(), ALERT_STATE: kvNew }, 'BTCUSDT');

      // Новите 3 полета (liquidationCascade/liquidationHasData/liqLiveEnabled)
      // са добавка към resultа - премахваме ги преди сравнение, останалото
      // трябва да е 100% същото като старата production логика.
      const { liquidationCascade, liquidationHasData, liqLiveEnabled, ...newResultOldShape } = newResult;
      expect(JSON.stringify(newResultOldShape)).toBe(JSON.stringify(oldResult));
      expect(liqLiveEnabled).toBe(false);
      // legacy пътят (CoinGlass, без CG_API_KEY) си остава мъртъв - потвърждение,
      // не изненада от тази промяна.
      expect(liquidationCascade).toEqual({ bullish: false, bearish: false, buySumUsd: 0, sellSumUsd: 0 });
      expect(liquidationHasData).toBe(false);
      expect(kvNew.m.get('sigstate:BTCUSDT')).toBe(kvOld.m.get('sigstate:BTCUSDT'));
    });
  });

  describe('флаг ВКЛЮЧЕН - реални Binance данни захранват cascade/gravity', () => {
    function envOn(extra = {}) {
      return { RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 'relay-secret-xyz', LIQ_LIVE_ENABLED: '1', ...extra };
    }

    it('bullish cascade (side=1, над прага) -> liquidationCascade.bullish=true, hasData=true', async () => {
      Date.now = () => FIXED_NOW;
      globalThis.fetch = router({ relayEvents: [{ side: 1, usdValue: 600000, time: FIXED_NOW - 30000, price: 99500 }] });
      const kv = makeKv();
      const result = await scanSymbolSignals(envOn({ ALERT_STATE: kv }), 'BTCUSDT');
      expect(result.liqLiveEnabled).toBe(true);
      expect(result.liquidationHasData).toBe(true);
      expect(result.liquidationCascade.bullish).toBe(true);
      expect(result.liquidationCascade.bearish).toBe(false);
      expect(result.liquidationCascade.buySumUsd).toBe(600000);
    });

    it('relay грешка/изключен (hasData=false) -> cascade НЕУТРАЛЕН, НИКОГА третиран като потвърждение', async () => {
      Date.now = () => FIXED_NOW;
      globalThis.fetch = router({ relayStatus: 503 });
      const kv = makeKv();
      const result = await scanSymbolSignals(envOn({ ALERT_STATE: kv }), 'BTCUSDT');
      expect(result.liquidationHasData).toBe(false);
      expect(result.liquidationCascade).toEqual({ bullish: false, bearish: false, buySumUsd: 0, sellSumUsd: 0 });
    });

    it('еднократен reset на liqGravity при ПЪРВОТО активиране - изчиства стар CoinGlass профил, после НЕ се повтаря', async () => {
      // Стъпка 1: симулираме стар, "мъртъв" CoinGlass liqGravity профил,
      // натрупан преди тази промяна (стари цени, флагът е бил изключен).
      const staleSigstate = JSON.stringify({ liqGravity: { buckets: { '12345': 9999999 }, lastSeenTime: 1700000000000 } });
      const kv = makeKv({ 'sigstate:BTCUSDT': staleSigstate });

      Date.now = () => FIXED_NOW;
      globalThis.fetch = router({ relayEvents: [{ side: 1, usdValue: 600000, time: FIXED_NOW - 30000, price: 99500 }] });
      await scanSymbolSignals(envOn({ ALERT_STATE: kv }), 'BTCUSDT');
      let sig = JSON.parse(kv.m.get('sigstate:BTCUSDT'));
      expect(sig.liqGravityLiveReset).toBe(true);
      expect(sig.liqGravity.buckets['12345']).toBeUndefined(); // старият стойностен клъстер е изчистен
      expect(sig.liqGravity.lastSeenTime).toBe(FIXED_NOW - 30000); // новата реална ликвидация е натрупана
      const afterFirstTick = sig.liqGravity.buckets;

      // Стъпка 2: втори тик, флагът пак включен - НЕ трябва да reset-ва пак
      // (натрупването продължава, не се изтрива).
      Date.now = () => FIXED_NOW + 60000;
      globalThis.fetch = router({ relayEvents: [{ side: 1, usdValue: 400000, time: FIXED_NOW + 30000, price: 99600 }] });
      await scanSymbolSignals(envOn({ ALERT_STATE: kv }), 'BTCUSDT');
      sig = JSON.parse(kv.m.get('sigstate:BTCUSDT'));
      expect(sig.liqGravity.lastSeenTime).toBe(FIXED_NOW + 30000);
      expect(Object.keys(sig.liqGravity.buckets).length).toBeGreaterThanOrEqual(Object.keys(afterFirstTick).length);
    });

    it('флаг изключен след активиране - НЕ ресетва отново (liqGravityLiveReset остава true, стар reset се пази)', async () => {
      const kv = makeKv({ 'sigstate:BTCUSDT': JSON.stringify({ liqGravity: { buckets: { '1': 100 }, lastSeenTime: 1 }, liqGravityLiveReset: true }) });
      Date.now = () => FIXED_NOW;
      globalThis.fetch = router({ relayEvents: [] });
      await scanSymbolSignals({ RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 'x', ALERT_STATE: kv }, 'BTCUSDT'); // флагът ИЗКЛЮЧЕН тук
      const sig = JSON.parse(kv.m.get('sigstate:BTCUSDT'));
      expect(sig.liqGravity.buckets['1']).toBe(100); // непипнато - reset-ът е еднократен и вече е станал
    });
  });
});
