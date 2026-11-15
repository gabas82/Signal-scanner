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
//       ИДЕНТИЧНИ с оригиналния worker.js (статичен snapshot отпреди тази
//       PR, виж test-fixtures/) - доказва нулева регресия за всички
//       съществуващи потребители на флага.
//     - ВКЛЮЧЕН -> calcLiquidationCascade/accumulateLiquidationGravity се
//       захранват от реални Binance relay данни; еднократен reset на
//       liqGravity при първо активиране; relay грешка/изключване НИКОГА не
//       се чете като потвърждение (hasData=false -> cascade неутрален).
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  isLiqLiveEnabled, fetchLiquidationOrdersLive, liqConfirmStatus, LIQ_CONFIRM_LABELS,
  buildTelemetryRecord, scanSymbolSignals, buildLiqConfirmLine,
  calcLiquidationCascade, accumulateLiquidationGravity,
} from './worker/worker.js';
const workerSrc = fs.readFileSync('./worker/worker.js', 'utf8');

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
      // Статичен snapshot на worker.js ТОЧНО както е бил в origin/main преди
      // тази PR (commit 47a07dc, md5 ef59bf6f... - същият код, който е
      // реално качен в production версия 101/102 на Cloudflare). Умишлено
      // НЕ използваме `git show origin/main:...` тук - CI checkout (actions/
      // checkout@v4) по подразбиране е плитък (fetch-depth: 1) и НЕ носи
      // branch/ref история, само последния commit на PR главата - "origin/
      // main" там не съществува изобщо ("fatal: invalid object name"). Статичен
      // файл прави теста hermetic - работи еднакво локално и в CI, независимо
      // от дълбочината на checkout-а.
      const mod = await import(pathToFileURL(path.resolve('test-fixtures/worker-pre-liquidation-live.mjs')).href);
      originalScanSymbolSignals = mod.scanSymbolSignals;
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

describe('(F) buildLiqConfirmLine - WhatsApp ред (ARMED + ENTRY NOW CONFIRMED, MR и TC)', () => {
  const bullish = { bullish: true, bearish: false };
  const bearish = { bullish: false, bearish: true };
  it('флаг изключен -> винаги null, независимо от cascade/hasData (съобщението остава без ред)', () => {
    expect(buildLiqConfirmLine(false, bullish, true, 'long')).toBeNull();
    expect(buildLiqConfirmLine(false, null, false, 'short')).toBeNull();
  });
  it('флаг включен -> точният label, съответстващ на liqConfirmStatus за 4-те състояния', () => {
    expect(buildLiqConfirmLine(true, bullish, true, 'long')).toBe(LIQ_CONFIRM_LABELS.confirm);
    expect(buildLiqConfirmLine(true, bearish, true, 'long')).toBe(LIQ_CONFIRM_LABELS.against);
    expect(buildLiqConfirmLine(true, { bullish: false, bearish: false }, true, 'long')).toBe(LIQ_CONFIRM_LABELS.neutral);
    expect(buildLiqConfirmLine(true, bullish, false, 'long')).toBe(LIQ_CONFIRM_LABELS.no_data);
  });

  // Структурна проверка на wiring-а в РЕАЛНИЯ изходен код (не само функцията
  // изолирано) - доказва, че и четирите WhatsApp блока (ARMED MR/TC, ENTRY
  // CONFIRMED MR/TC) реално викат buildLiqConfirmLine с правилната посока, и
  // че редът е conditional (никога безусловен push) - запазва байт-
  // идентичността на старите съобщения при изключен флаг.
  it('ARMED (MR) вика buildLiqConfirmLine(liqLiveEnabled, liquidationCascade, liquidationHasData, armedDirection) СЛЕД предупредителния ред', () => {
    const warnIdx = workerSrc.indexOf('⚠️ Все още НЕ Е entry - чакаме ENTRY TRIGGER (Етап 3)`,\n        ];');
    const liqCallIdx = workerSrc.indexOf('buildLiqConfirmLine(liqLiveEnabled, liquidationCascade, liquidationHasData, armedDirection)');
    expect(warnIdx).toBeGreaterThan(-1);
    expect(liqCallIdx).toBeGreaterThan(warnIdx);
    expect(liqCallIdx).toBeLessThan(warnIdx + 400); // веднага след, не произволно по-долу във файла
  });
  it('ARMED (TC) вика buildLiqConfirmLine с trendArmedDirection', () => {
    expect(workerSrc).toContain('buildLiqConfirmLine(liqLiveEnabled, liquidationCascade, liquidationHasData, trendArmedDirection)');
  });
  it('ENTRY NOW - CONFIRMED (MR) - entryLiqLine (от entryResult.direction) е позициониран МЕЖДУ HTF CONTEXT и BOTH QUALITY в съобщението', () => {
    expect(workerSrc).toContain('buildLiqConfirmLine(liqLiveEnabled, liquidationCascade, liquidationHasData, entryResult.direction)');
    const htfIdx = workerSrc.indexOf('`HTF CONTEXT: ${entryResult.htfAligned ? \'✓\' : \'—\'}`,');
    const usageIdxAll = [...workerSrc.matchAll(/\.\.\.\(entryLiqLine \? \[entryLiqLine\] : \[\]\),/g)].map(m => m.index);
    const bothQualityIdx = workerSrc.indexOf('BOTH QUALITY (виж classifyBothQuality по-горе) -\n            // маркиране за ВСЯКА TC+MR same-tick');
    expect(htfIdx).toBeGreaterThan(-1);
    expect(usageIdxAll).toHaveLength(2); // MR + TC
    const mrUsageIdx = usageIdxAll.find(i => i > htfIdx);
    expect(mrUsageIdx).toBeGreaterThan(htfIdx);
    expect(bothQualityIdx).toBeGreaterThan(mrUsageIdx);
  });
  it('ENTRY NOW - CONFIRMED (TC) вика buildLiqConfirmLine с trendEntryResult.direction', () => {
    expect(workerSrc).toContain('buildLiqConfirmLine(liqLiveEnabled, liquidationCascade, liquidationHasData, trendEntryResult.direction)');
  });
  it('и четирите call site-а подават реда УСЛОВНО (spread/if), никога безусловен push - старите съобщения остават непроменени при изключен флаг', () => {
    expect((workerSrc.match(/buildLiqConfirmLine\(liqLiveEnabled, liquidationCascade, liquidationHasData, \w+(\.\w+)?\)/g) || [])).toHaveLength(4);
    expect(workerSrc).toContain('if (armedLiqLine) armedLines.push(armedLiqLine);');
    expect(workerSrc).toContain('if (trendArmedLiqLine) trendArmedLines.push(trendArmedLiqLine);');
    expect((workerSrc.match(/\.\.\.\(entryLiqLine \? \[entryLiqLine\] : \[\]\),/g) || [])).toHaveLength(2); // MR + TC ENTRY блокове
  });
});

describe('(G) PHASE CYCLE - правилна интерпретация на Binance BUY/SELL посоката', () => {
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
  // fundingRate=0.001 -> funding=0.1 >= TOP_WATCH_FUNDING_MIN (0.06) - форсира
  // isTopWatch()=true, за да се изчисли cycleShortScore (иначе е gate-нат зад
  // TOP WATCH и винаги би бил 0, независимо от bearish каскадата).
  function router({ relayEvents = [], forceTopWatch = false } = {}) {
    return async (url) => {
      const s = String(url);
      if (s.includes('/liquidations?')) {
        return new Response(JSON.stringify({ symbol: 'BTCUSDT', count: relayEvents.length, truncated: false, events: relayEvents, coverage: { complete: true, reasons: [], gaps: [], connected: true } }), { status: 200 });
      }
      if (s.includes('/klines')) {
        const u = new URL(s);
        return new Response(JSON.stringify(klines(u.searchParams.get('interval'), Number(u.searchParams.get('limit')))), { status: 200 });
      }
      if (forceTopWatch && s.includes('/funding')) {
        return new Response(JSON.stringify([{ fundingRate: '0.001' }]), { status: 200 });
      }
      return new Response(JSON.stringify({ code: -1, msg: 'mock unavailable' }), { status: 503 });
    };
  }
  function env(extra = {}) {
    return { RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 'relay-secret-xyz', LIQ_LIVE_ENABLED: '1', ...extra };
  }

  it("Binance BUY (side=1, принудително затворен SHORT -> бичи натиск) -> cascade.bullish=true -> cycleLongScore с +1 кредит спрямо baseline без ликвидация", async () => {
    Date.now = () => FIXED_NOW;
    globalThis.fetch = router({ relayEvents: [] });
    const baseline = await scanSymbolSignals(env({ ALERT_STATE: makeKv() }), 'BTCUSDT');

    Date.now = () => FIXED_NOW;
    globalThis.fetch = router({ relayEvents: [{ side: 1, usdValue: 600000, time: FIXED_NOW - 30000, price: 99500 }] });
    const withBuy = await scanSymbolSignals(env({ ALERT_STATE: makeKv() }), 'BTCUSDT');

    expect(withBuy.liquidationCascade.bullish).toBe(true);
    expect(withBuy.liquidationCascade.bearish).toBe(false);
    expect(withBuy.cycleLongScore).toBe(baseline.cycleLongScore + 1);
  });

  it("Binance SELL (side=2, принудително затворен LONG -> мечи натиск) -> cascade.bearish=true -> cycleShortScore с +1 кредит спрямо baseline (TOP WATCH форсиран)", async () => {
    Date.now = () => FIXED_NOW;
    globalThis.fetch = router({ relayEvents: [], forceTopWatch: true });
    const baseline = await scanSymbolSignals(env({ ALERT_STATE: makeKv() }), 'BTCUSDT');
    expect(baseline.cyclePhase).toBeDefined(); // sanity - топ watch път реално се изпълнява

    Date.now = () => FIXED_NOW;
    globalThis.fetch = router({ relayEvents: [{ side: 2, usdValue: 600000, time: FIXED_NOW - 30000, price: 100500 }], forceTopWatch: true });
    const withSell = await scanSymbolSignals(env({ ALERT_STATE: makeKv() }), 'BTCUSDT');

    expect(withSell.liquidationCascade.bearish).toBe(true);
    expect(withSell.liquidationCascade.bullish).toBe(false);
    expect(withSell.cycleShortScore).toBe(baseline.cycleShortScore + 1);
  });

  it('BUY каскада НЕ дава кредит на cycleShortScore, SELL каскада НЕ дава кредит на cycleLongScore (посоката не се разменя/разлива в грешния score)', async () => {
    Date.now = () => FIXED_NOW;
    globalThis.fetch = router({ relayEvents: [], forceTopWatch: true });
    const baseline = await scanSymbolSignals(env({ ALERT_STATE: makeKv() }), 'BTCUSDT');

    Date.now = () => FIXED_NOW;
    globalThis.fetch = router({ relayEvents: [{ side: 1, usdValue: 600000, time: FIXED_NOW - 30000, price: 99500 }], forceTopWatch: true });
    const withBuy = await scanSymbolSignals(env({ ALERT_STATE: makeKv() }), 'BTCUSDT');
    expect(withBuy.cycleShortScore).toBe(baseline.cycleShortScore); // непроменен - BUY не е bearish

    Date.now = () => FIXED_NOW;
    globalThis.fetch = router({ relayEvents: [{ side: 2, usdValue: 600000, time: FIXED_NOW - 30000, price: 100500 }] });
    const withSell = await scanSymbolSignals(env({ ALERT_STATE: makeKv() }), 'BTCUSDT');
    const baselineNoTopWatch = await (async () => {
      Date.now = () => FIXED_NOW;
      globalThis.fetch = router({ relayEvents: [] });
      return scanSymbolSignals(env({ ALERT_STATE: makeKv() }), 'BTCUSDT');
    })();
    expect(withSell.cycleLongScore).toBe(baselineNoTopWatch.cycleLongScore); // непроменен - SELL не е bullish
  });

  it('под прага (LIQUIDATION_CASCADE_USD_MIN=500хил.) -> нито bullish, нито bearish, независимо от side', async () => {
    Date.now = () => FIXED_NOW;
    globalThis.fetch = router({ relayEvents: [{ side: 1, usdValue: 100000, time: FIXED_NOW - 30000, price: 99500 }] });
    const r1 = await scanSymbolSignals(env({ ALERT_STATE: makeKv() }), 'BTCUSDT');
    expect(r1.liquidationCascade).toEqual({ bullish: false, bearish: false, buySumUsd: 100000, sellSumUsd: 0 });

    Date.now = () => FIXED_NOW;
    globalThis.fetch = router({ relayEvents: [{ side: 2, usdValue: 100000, time: FIXED_NOW - 30000, price: 100500 }] });
    const r2 = await scanSymbolSignals(env({ ALERT_STATE: makeKv() }), 'BTCUSDT');
    expect(r2.liquidationCascade).toEqual({ bullish: false, bearish: false, buySumUsd: 0, sellSumUsd: 100000 });
  });
});

describe('(H) Остарели/непълни данни - НИКОГА фалшиво потвърждение', () => {
  const env = { RELAY_URL: 'https://relay.mock', RELAY_TOKEN: 'relay-secret-xyz' };
  it('relay връща реални bullish събития, НО coverage.complete=false (gap по време на прозореца) -> hasData=false, liqConfirmStatus НИКОГА confirm', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      events: [{ side: 1, usdValue: 900000, time: Date.now(), price: 100 }],
      coverage: { complete: false, reasons: ['gap'], gaps: [{ from: 1, to: 2, reason: 'ws_disconnect' }], connected: true },
    }), { status: 200 });
    const r = await fetchLiquidationOrdersLive(env, 'BTCUSDT');
    expect(r.hasData).toBe(false);
    expect(r.orders).toHaveLength(1); // данните се подават на CASCADE/GRAVITY (частично по-добре от нищо)
    // Дори със съдържание, което БИ дало bullish=true, confirm статусът остава no_data.
    const cascade = calcLiquidationCascade(r.orders);
    expect(cascade.bullish).toBe(true);
    expect(liqConfirmStatus(cascade, r.hasData, 'long')).toBe('no_data'); // НИКОГА 'confirm'
  });
  it('relay не е свързан (connected:false) въпреки complete:true по текст - все пак третираме стриктно само по coverage.complete', async () => {
    // defensive doc-тест: ако бъдещ relay вариант някога изпрати противоречиви
    // полета, hasData зависи ИЗРИЧНО от coverage.complete===true, не от connected.
    globalThis.fetch = async () => new Response(JSON.stringify({
      events: [{ side: 1, usdValue: 900000, time: Date.now(), price: 100 }],
      coverage: { complete: true, reasons: [], gaps: [], connected: false },
    }), { status: 200 });
    const r = await fetchLiquidationOrdersLive(env, 'BTCUSDT');
    expect(r.hasData).toBe(true); // complete:true е единственият критерий, както е документирано
  });
  it('липсващо coverage поле изцяло (непознат relay формат) -> coverageComplete=null -> hasData=false, НЕ се приема за надеждно', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ events: [{ side: 1, usdValue: 900000, time: Date.now(), price: 100 }] }), { status: 200 });
    const r = await fetchLiquidationOrdersLive(env, 'BTCUSDT');
    expect(r.hasData).toBe(false);
  });
});

describe('(I) LIQUIDATION GRAVITY - акумулацията е коректна независимо от BUY/SELL side', () => {
  it('BUY и SELL поръчки в СЪЩОТО ценово кошче се натрупват заедно (клъстерната "сила" е по USD обем, не по посока - direction-ът идва от разстоянието цена/клъстер, не от side)', () => {
    const state = {};
    accumulateLiquidationGravity(state, [
      { side: 1, usdValue: 300000, time: 1000, price: 100 },
      { side: 2, usdValue: 200000, time: 2000, price: 100.001 }, // почти същата цена -> същото log-bucket
    ]);
    const buckets = Object.values(state.liqGravity.buckets);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toBe(500000); // и двете посоки допринасят за силата на клъстера
  });
  it('lastSeenTime напредва само напред, независимо от side на последната обработена поръчка', () => {
    const state = {};
    accumulateLiquidationGravity(state, [{ side: 2, usdValue: 100000, time: 5000, price: 50 }]);
    expect(state.liqGravity.lastSeenTime).toBe(5000);
    accumulateLiquidationGravity(state, [{ side: 1, usdValue: 100000, time: 3000, price: 50 }]); // по-стара от lastSeenTime
    expect(state.liqGravity.lastSeenTime).toBe(5000); // непроменено - вече обработена/по-стара поръчка, без двойно броене
    const buckets = Object.values(state.liqGravity.buckets);
    expect(buckets[0]).toBe(100000); // по-старата поръчка НЕ е добавена повторно
  });
});

describe('(J) calcLiquidationCascade - директна проверка на side -> посока конвенцията (изолирано от целия pipeline)', () => {
  it('side=1 (Binance BUY, форсирано затворен SHORT) -> bullish=true, bearish=false', () => {
    const r = calcLiquidationCascade([{ side: 1, usdValue: 600000, time: Date.now(), price: 100 }]);
    expect(r).toEqual({ bullish: true, bearish: false, buySumUsd: 600000, sellSumUsd: 0 });
  });
  it('side=2 (Binance SELL, форсирано затворен LONG) -> bearish=true, bullish=false', () => {
    const r = calcLiquidationCascade([{ side: 2, usdValue: 600000, time: Date.now(), price: 100 }]);
    expect(r).toEqual({ bullish: false, bearish: true, buySumUsd: 0, sellSumUsd: 600000 });
  });
  it('смесени side в прозореца - сумите се броят отделно по side, каскадата е bullish И bearish едновременно ако и двете минат прага', () => {
    const r = calcLiquidationCascade([
      { side: 1, usdValue: 550000, time: Date.now(), price: 100 },
      { side: 2, usdValue: 520000, time: Date.now(), price: 100 },
    ]);
    expect(r.bullish).toBe(true);
    expect(r.bearish).toBe(true);
    expect(r.buySumUsd).toBe(550000);
    expect(r.sellSumUsd).toBe(520000);
  });
});
