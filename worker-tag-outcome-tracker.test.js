// SIGNAL TAG OUTCOME TRACKER (Etap 1, наблюдателен) - виж коментара преди
// TAG_OUTCOME_TRACKED_TYPES в worker.js ("FLUSH/DUMP SQUEEZE - две фази на
// едно движение, или просто противоречиви сигнали"). Чисто observability:
// тестваме pure builders/aggregators + structural wiring в scanSymbolSignals
// + /tag-outcome-diagnostics endpoint. НЕ пипа ENTRY/VETO/scoring логика.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  TAG_OUTCOME_TRACKED_TYPES, buildTagOutcomeRecord, tagTypeKey, tagSoloKey,
  buildTagOutcomeTypeSoloBreakdown, buildTagCoFireCounts, buildTagOutcomeSummary,
} from './worker/worker.js';
import worker from './worker/worker.js';

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

const WORKER_SRC = readFileSync('./worker/worker.js', 'utf8');

describe('TAG_OUTCOME_TRACKED_TYPES', () => {
  it('съдържа точно обсъдените в discussion-а типове (FLUSH/DUMP SQUEEZE + MM/IMPULSE+ATR случаите)', () => {
    expect(TAG_OUTCOME_TRACKED_TYPES).toEqual(new Set(['flush', 'blowoff', 'squeeze', 'dumpSqueeze', 'mm', 'mmX25', 'impulseAtr']));
  });
  it('НЕ включва ENTRY/SETUP/ARMED типове - само "суровите" market-signal тагове', () => {
    expect(TAG_OUTCOME_TRACKED_TYPES.has('entry')).toBe(false);
    expect(TAG_OUTCOME_TRACKED_TYPES.has('setup')).toBe(false);
  });
});

describe('buildTagOutcomeRecord', () => {
  it('строи запис с всички outcome/mfe/mae полета null-ирани (чакат резолюция)', () => {
    const r = buildTagOutcomeRecord({ symbol: 'BTC', type: 'flush', direction: 'short', at: 1000, price: 64000, concurrentTypes: ['dumpSqueeze'] });
    expect(r).toMatchObject({ symbol: 'BTC', type: 'flush', direction: 'short', at: 1000, entryPrice: 64000, concurrentTypes: ['dumpSqueeze'] });
    expect(r.outcome5m).toBeNull();
    expect(r.outcome240m).toBeNull();
    expect(r.mfe5m).toBeNull();
    expect(r.mae60mAtr).toBeNull();
    expect(r.timeToMfeMin).toBeNull();
    expect(r.maeBeforeMfePct).toBeNull();
  });
  it('concurrentTypes по подразбиране е празен масив, не undefined/null', () => {
    const r = buildTagOutcomeRecord({ symbol: 'BTC', type: 'mm', direction: 'long', at: 1000, price: 100 });
    expect(r.concurrentTypes).toEqual([]);
  });
  it('at по подразбиране е Date.now() когато не е подаден', () => {
    const before = Date.now();
    const r = buildTagOutcomeRecord({ symbol: 'ETH', type: 'squeeze', direction: 'long', price: 2000 });
    expect(r.at).toBeGreaterThanOrEqual(before);
  });
  it('entryPrice null когато price не е подаден', () => {
    const r = buildTagOutcomeRecord({ symbol: 'ETH', type: 'blowoff', direction: 'long', at: 1000 });
    expect(r.entryPrice).toBeNull();
  });
});

describe('tagTypeKey / tagSoloKey', () => {
  it('tagTypeKey връща r.type, null когато липсва', () => {
    expect(tagTypeKey({ type: 'flush' })).toBe('flush');
    expect(tagTypeKey({})).toBeNull();
  });
  it('tagSoloKey -> "solo" без concurrentTypes, "coFired" с непразен масив', () => {
    expect(tagSoloKey({ concurrentTypes: [] })).toBe('solo');
    expect(tagSoloKey({})).toBe('solo');
    expect(tagSoloKey({ concurrentTypes: ['dumpSqueeze'] })).toBe('coFired');
  });
});

describe('buildTagOutcomeTypeSoloBreakdown', () => {
  it('разделя solo/coFired записи по тип, брои коректно всеки хоризонт', () => {
    const records = [
      { type: 'flush', concurrentTypes: [], outcome5m: 1.0 },
      { type: 'flush', concurrentTypes: [], outcome5m: -0.5 },
      { type: 'flush', concurrentTypes: ['dumpSqueeze'], outcome5m: 2.0 },
    ];
    const out = buildTagOutcomeTypeSoloBreakdown(records);
    expect(out.flush.solo.m5.count).toBe(2);
    expect(out.flush.coFired.m5.count).toBe(1);
    expect(out.flush.coFired.m5.avgOutcomePct).toBe(2.0);
  });
  it('тип без записи от едната категория -> count:0 fallback, не undefined/throw', () => {
    const records = [{ type: 'mm', concurrentTypes: [], outcome5m: 1.0 }];
    const out = buildTagOutcomeTypeSoloBreakdown(records);
    expect(out.mm.coFired.m5).toEqual({ count: 0, avgOutcomePct: null, winRatePct: null });
    expect(out.mm.coFired.m240).toEqual({ count: 0, avgOutcomePct: null, winRatePct: null });
  });
  it('празен вход -> празен обект, без throw', () => {
    expect(buildTagOutcomeTypeSoloBreakdown([])).toEqual({});
  });
});

describe('buildTagCoFireCounts', () => {
  it('брои реалните co-fire двойки (type+other), отговаря директно на "теоретично срещу реално"', () => {
    const records = [
      { type: 'flush', concurrentTypes: ['dumpSqueeze'] },
      { type: 'flush', concurrentTypes: ['dumpSqueeze', 'blowoff'] },
      { type: 'mm', concurrentTypes: [] },
    ];
    const out = buildTagCoFireCounts(records);
    expect(out['flush+dumpSqueeze']).toBe(2);
    expect(out['flush+blowoff']).toBe(1);
    expect(out['mm+dumpSqueeze']).toBeUndefined();
  });
  it('без concurrentTypes никъде -> празен обект', () => {
    expect(buildTagCoFireCounts([{ type: 'mm', concurrentTypes: [] }, { type: 'flush' }])).toEqual({});
  });
});

describe('buildTagOutcomeSummary', () => {
  it('комбинира byType/bySolo/byTypeSolo/coFireCounts в един обект', () => {
    const records = [
      { type: 'flush', concurrentTypes: ['dumpSqueeze'], outcome5m: 1.0 },
      { type: 'dumpSqueeze', concurrentTypes: ['flush'], outcome5m: -1.0 },
    ];
    const summary = buildTagOutcomeSummary(records);
    expect(summary.byType.flush.m5.count).toBe(1);
    expect(summary.bySolo.coFired.m5.count).toBe(2);
    expect(summary.byTypeSolo.flush.coFired.m5.count).toBe(1);
    expect(summary.coFireCounts).toEqual({ 'flush+dumpSqueeze': 1, 'dumpSqueeze+flush': 1 });
  });
  it('празен масив -> не хвърля, връща пусти агрегати', () => {
    const summary = buildTagOutcomeSummary([]);
    expect(summary.byType).toEqual({});
    expect(summary.coFireCounts).toEqual({});
  });
});

// STRUCTURAL - потвърждава wiring-а в scanSymbolSignals (нов pending запис
// само за TAG_OUTCOME_TRACKED_TYPES + резолюция, огледално на
// pendingOutcomes блока) директно от source-а, без да извикваме цялата
// scanSymbolSignals (изисква тежък fetch mocking) - виж (D) структурния
// подход в worker-liquidation-veto.test.js.
describe('scanSymbolSignals wiring (structural)', () => {
  it('пише pending tag-outcome запис само за newFired сигнали от TAG_OUTCOME_TRACKED_TYPES', () => {
    const needle = 'const trackedNewFired = newFired.filter(sig => TAG_OUTCOME_TRACKED_TYPES.has(sig.type));';
    expect(WORKER_SRC.includes(needle)).toBe(true);
  });
  it('concurrentTypes хваща ВСИЧКИ newFired типове в тика (не само tracked), не само tracked списъка', () => {
    const needle = 'const allNewTypes = newFired.map(sig => sig.type);';
    expect(WORKER_SRC.includes(needle)).toBe(true);
    const concurrentNeedle = 'const concurrentTypes = allNewTypes.filter(t => t !== sig.type);';
    expect(WORKER_SRC.includes(concurrentNeedle)).toBe(true);
  });
  it('резолюционният блок е огледален на pendingOutcomes (updateExcursion + resolvePendingOutcomeHorizons), преди saveSymbolState', () => {
    const needle = 'if (state.pendingTagOutcomes && state.pendingTagOutcomes.length && env.ALERT_STATE) {';
    const idx = WORKER_SRC.indexOf(needle);
    expect(idx).toBeGreaterThan(-1);
    const saveIdx = WORKER_SRC.indexOf('await saveSymbolState(env, symbol, state);');
    expect(saveIdx).toBeGreaterThan(idx);
  });
  it('НЕ пипа longScore/shortScore/activeSignals - изцяло observational, нулево влияние върху WhatsApp съобщението', () => {
    // Записващият блок трябва да е СЛЕД longScore/shortScore изчислението, не преди.
    const scoreIdx = WORKER_SRC.indexOf("const longScore = computeFamilyCappedScore(activeSignals, 'long');");
    const trackerIdx = WORKER_SRC.indexOf('const trackedNewFired = newFired.filter(sig => TAG_OUTCOME_TRACKED_TYPES.has(sig.type));');
    expect(scoreIdx).toBeGreaterThan(-1);
    expect(trackerIdx).toBeGreaterThan(scoreIdx);
  });
});

describe('/tag-outcome-diagnostics endpoint', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/tag-outcome-diagnostics${qs}`), env, { waitUntil() {} });

  it('без/грешен token -> 401', async () => {
    const res = await call({ ALERT_STATE: makeKv(), TELEMETRY_TOKEN: 'secret' });
    expect(res.status).toBe(401);
  });

  it('без ALERT_STATE конфигуриран -> 500', async () => {
    const res = await call({ TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    expect(res.status).toBe(500);
  });

  it('с валиден token връща records + агрегиран summary, сортирани по at descending', async () => {
    const r1 = { symbol: 'BTC', type: 'flush', direction: 'short', at: 1000, entryPrice: 64000, concurrentTypes: [], outcome5m: 1.0 };
    const r2 = { symbol: 'BTC', type: 'dumpSqueeze', direction: 'short', at: 2000, entryPrice: 63900, concurrentTypes: ['flush'], outcome5m: -0.5 };
    const kv = makeKv({
      'tagoutcome:BTC:1000:flush': JSON.stringify(r1),
      'tagoutcome:BTC:2000:dumpSqueeze': JSON.stringify(r2),
    });
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.records[0].at).toBe(2000);
    expect(body.records[1].at).toBe(1000);
    expect(body.summary.byType.flush.m5.count).toBe(1);
    expect(body.summary.coFireCounts).toEqual({ 'dumpSqueeze+flush': 1 });
  });

  it('?type= филтрира records, но summary статистиката остава върху пресятите records (документирано поведение)', async () => {
    const r1 = { symbol: 'BTC', type: 'flush', direction: 'short', at: 1000, concurrentTypes: [] };
    const r2 = { symbol: 'BTC', type: 'mm', direction: 'long', at: 2000, concurrentTypes: [] };
    const kv = makeKv({
      'tagoutcome:BTC:1000:flush': JSON.stringify(r1),
      'tagoutcome:BTC:2000:mm': JSON.stringify(r2),
    });
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&type=flush');
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.records[0].type).toBe('flush');
  });

  it('?limit= ограничава records, но summary отразява ВСИЧКИТЕ натрупани записи (не само sample-а)', async () => {
    const seed = {};
    for (let i = 0; i < 5; i++) {
      seed[`tagoutcome:BTC:${1000 + i}:flush`] = JSON.stringify({ symbol: 'BTC', type: 'flush', direction: 'short', at: 1000 + i, concurrentTypes: [], outcome5m: 1.0 });
    }
    const kv = makeKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=2');
    const body = await res.json();
    expect(body.records.length).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.count).toBe(5);
    expect(body.summary.byType.flush.m5.count).toBe(5);
  });

  it('read-only - не пише в KV', async () => {
    const kv = makeKv({ 'tagoutcome:BTC:1000:flush': JSON.stringify({ symbol: 'BTC', type: 'flush', at: 1000, concurrentTypes: [] }) });
    let wrote = false;
    const originalPut = kv.put;
    kv.put = async (...args) => { wrote = true; return originalPut(...args); };
    await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    expect(wrote).toBe(false);
  });
});
