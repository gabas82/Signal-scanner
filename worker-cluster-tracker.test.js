// LIQUIDATION CLUSTER OUTCOME TRACKER - чисто observational Stage 1 логика
// (виж "клъстер срещу контролна група" discussion-а). READ-peek на
// liqGravity.buckets, собствен KV namespace, нулево докосване на
// sigstate:/calcLiqVeto/ENTRY. Виж бележката преди advanceClusterTracking в
// worker.js за пълния контекст.
import { describe, it, expect } from 'vitest';
import {
  CLUSTER_TRACK_PROXIMITY_PCT, CLUSTER_TRACK_NEGLIGIBLE_RATIO, CLUSTER_TRACK_WATCH_RATIO,
  CLUSTER_TRACK_MAX_AGE_MS, buildClusterLedgerBaseline, updateClusterLedger,
  selectTrackedLevelForSide, openLevelLifecycle, stepLevelLifecycle, isLevelLifecycleExpired,
  expireLevelLifecycle, finalizeClusterLifecycleRecord, advanceClusterTracking,
  priceToLiqBucket, liqBucketToPrice,
  CLUSTER_TRACK_KV_PREFIX, CLUSTER_EVENT_KV_PREFIX, clusterTrackKey, clusterEventKey,
  trackSymbolClusterOutcome,
  CLUSTER_OUTCOME_MIN_SAMPLE, CLUSTER_OUTCOME_REASONS, buildOutcomeRateStats,
  groupClusterOutcomeRecords, buildClusterOutcomeSummary, compareOutcomeGroups,
  buildClusterVsControlComparison,
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

const MIN_USD = 2000000; // LIQ_GRAVITY_CLUSTER_MIN_USD

// Помощник: връща bucketKey за дадена цена (string, както идва от Object.keys)
function keyFor(price) { return String(priceToLiqBucket(price)); }

describe('buildClusterLedgerBaseline', () => {
  it('маркира вече-над-прага кошчета като legacy, без originKnown', () => {
    const buckets = { [keyFor(100)]: MIN_USD * 1.5, [keyFor(50)]: 100 };
    const ledger = buildClusterLedgerBaseline(buckets);
    expect(ledger[keyFor(100)]).toMatchObject({ originTag: 'legacy', originKnown: false, bornAt: null });
    expect(ledger[keyFor(50)]).toBeUndefined(); // под прага - не влиза в baseline
  });
  it('празен buckets -> празен ledger', () => {
    expect(buildClusterLedgerBaseline({})).toEqual({});
    expect(buildClusterLedgerBaseline(undefined)).toEqual({});
  });
});

describe('updateClusterLedger', () => {
  it('кошче, пресичащо прага за първи път БЕЗ предходно наблюдение, става fresh с birthLatencyMin=null', () => {
    const buckets = { [keyFor(100)]: MIN_USD * 1.2 };
    const { ledger, births } = updateClusterLedger({}, buckets, 1000);
    expect(ledger[keyFor(100)]).toMatchObject({ originTag: 'fresh', originKnown: true, bornAt: 1000, birthLatencyMin: null });
    expect(births).toEqual([{ bucketKey: keyFor(100), bornAt: 1000, bornUsd: MIN_USD * 1.2, birthLatencyMin: null }]);
  });
  it('кошче, наблюдавано първо под прага (watch zone), после пресичащо прага -> birthLatencyMin изчислен', () => {
    const k = keyFor(100);
    const buckets1 = { [k]: MIN_USD * CLUSTER_TRACK_WATCH_RATIO };
    const step1 = updateClusterLedger({}, buckets1, 0);
    expect(step1.ledger[k]).toMatchObject({ originTag: null, originKnown: true, firstNonZeroAt: 0, bornAt: null });
    expect(step1.births).toEqual([]);

    const buckets2 = { [k]: MIN_USD * 1.1 };
    const step2 = updateClusterLedger(step1.ledger, buckets2, 10 * 60000);
    expect(step2.ledger[k]).toMatchObject({ originTag: 'fresh', originKnown: true, bornAt: 10 * 60000, birthLatencyMin: 10 });
    expect(step2.births[0].birthLatencyMin).toBe(10);
  });
  it('кошче под watch прага не се следи изобщо (евтин ledger)', () => {
    const buckets = { [keyFor(100)]: MIN_USD * 0.2 };
    const { ledger, births } = updateClusterLedger({}, buckets, 0);
    expect(ledger).toEqual({});
    expect(births).toEqual([]);
  });
  it('веднъж fresh, кошчето остава fresh и само lastUsd се обновява', () => {
    const k = keyFor(100);
    const step1 = updateClusterLedger({}, { [k]: MIN_USD * 1.1 }, 0);
    const step2 = updateClusterLedger(step1.ledger, { [k]: MIN_USD * 1.5 }, 60000);
    expect(step2.ledger[k]).toMatchObject({ originTag: 'fresh', bornAt: 0, lastUsd: MIN_USD * 1.5 });
    expect(step2.births).toEqual([]);
  });
  it('липсващи/празни buckets не хвърлят грешка', () => {
    expect(() => updateClusterLedger({}, undefined, 0)).not.toThrow();
    expect(updateClusterLedger({ a: { originTag: 'fresh' } }, {}, 0).ledger).toEqual({ a: { originTag: 'fresh' } });
  });
});

describe('selectTrackedLevelForSide', () => {
  it('намира клъстер над цената в радиуса', () => {
    const price = 100;
    const buckets = { [keyFor(101)]: MIN_USD * 2 };
    const { cluster, control } = selectTrackedLevelForSide(buckets, price, 'above');
    expect(cluster).toMatchObject({ bucketKey: keyFor(101), usd: MIN_USD * 2 });
    expect(control).toBeNull();
  });
  it('намира контролно (почти празно) кошче под цената в радиуса', () => {
    const price = 100;
    const buckets = { [keyFor(99)]: MIN_USD * 0.05 };
    const { cluster, control } = selectTrackedLevelForSide(buckets, price, 'below');
    expect(cluster).toBeNull();
    expect(control).toMatchObject({ bucketKey: keyFor(99) });
  });
  it('сивата зона (между negligible и прага) не се брои за нищо', () => {
    const price = 100;
    const buckets = { [keyFor(101)]: MIN_USD * 0.5 };
    const { cluster, control } = selectTrackedLevelForSide(buckets, price, 'above');
    expect(cluster).toBeNull();
    expect(control).toBeNull();
  });
  it('кошче извън радиуса (>2%) се игнорира и за двете роли', () => {
    const price = 100;
    const buckets = { [keyFor(105)]: MIN_USD * 3, [keyFor(97)]: 1 };
    const above = selectTrackedLevelForSide(buckets, price, 'above');
    expect(above.cluster).toBeNull();
  });
  it('грешна страна се филтрира (клъстер над цената не е "below" кандидат)', () => {
    const price = 100;
    const buckets = { [keyFor(101)]: MIN_USD * 2 };
    const below = selectTrackedLevelForSide(buckets, price, 'below');
    expect(below.cluster).toBeNull();
    expect(below.control).toBeNull();
  });
  it('избира НАЙ-БЛИЗКИЯ клъстер, когато има няколко в радиуса', () => {
    const price = 100;
    const buckets = { [keyFor(101.8)]: MIN_USD * 2, [keyFor(100.5)]: MIN_USD * 3 };
    const { cluster } = selectTrackedLevelForSide(buckets, price, 'above');
    expect(cluster.bucketKey).toBe(keyFor(100.5));
  });
  it('невалидна цена или липсващи buckets -> {null, null}, без грешка', () => {
    expect(selectTrackedLevelForSide(null, 100, 'above')).toEqual({ cluster: null, control: null });
    expect(selectTrackedLevelForSide({}, null, 'above')).toEqual({ cluster: null, control: null });
  });
});

describe('openLevelLifecycle', () => {
  it('отваря cluster слот с данни от ledger entry', () => {
    const slot = openLevelLifecycle({
      symbol: 'BTCUSDT', side: 'above', kind: 'cluster',
      selection: { bucketKey: '1', usd: MIN_USD * 2, price: 101 },
      ledgerEntry: { originTag: 'fresh', originKnown: true, bornAt: 500, bornUsd: MIN_USD * 2, birthLatencyMin: 15 },
      now: 1000, price: 100,
    });
    expect(slot).toMatchObject({
      symbol: 'BTCUSDT', kind: 'cluster', side: 'above', levelPrice: 101,
      originTag: 'fresh', originKnown: true, bornAt: 500, birthLatencyMin: 15,
      phase: 'none', closedAt: null,
    });
    expect(slot.peakProximityPct).toBeCloseTo(0.99, 1);
  });
  it('отваря control слот без origin данни', () => {
    const slot = openLevelLifecycle({
      symbol: 'ETHUSDT', side: 'below', kind: 'control',
      selection: { bucketKey: '2', usd: 10, price: 99 },
      ledgerEntry: null, now: 1000, price: 100,
    });
    expect(slot.originTag).toBeNull();
    expect(slot.originKnown).toBeNull();
    expect(slot.kind).toBe('control');
  });
  it('cluster без ledgerEntry пада назад към legacy/unknown (защитно)', () => {
    const slot = openLevelLifecycle({
      symbol: 'SOLUSDT', side: 'above', kind: 'cluster',
      selection: { bucketKey: '3', usd: MIN_USD, price: 101 },
      ledgerEntry: undefined, now: 1000, price: 100,
    });
    expect(slot.originTag).toBe('legacy');
    expect(slot.originKnown).toBe(false);
  });
});

describe('stepLevelLifecycle', () => {
  function baseSlot(overrides = {}) {
    return {
      symbol: 'BTCUSDT', kind: 'cluster', side: 'above', bucketKey: '1', levelPrice: 110,
      openedAt: 0, lastObservedAt: 0, lastObservedPrice: 100,
      phase: 'none', firstApproachAt: null, firstTouchAt: null,
      peakProximityPct: 9.09, closedAt: null, closePrice: null, closeReason: null, bouncedAt: null,
      originTag: 'fresh', originKnown: true, bornAt: 0, bornUsd: MIN_USD, birthLatencyMin: null, currentUsd: MIN_USD,
      ...overrides,
    };
  }

  it('приближаване в рамките на 2% -> phase=approaching, firstApproachAt поставен', () => {
    const slot = baseSlot();
    const next = stepLevelLifecycle(slot, 108.5, 1000); // ~1.36% от 110
    expect(next.phase).toBe('approaching');
    expect(next.firstApproachAt).toBe(1000);
    expect(next.closedAt).toBeNull();
  });
  it('цена, попадаща в самото кошче на нивото -> touched (реално наблюдавано)', () => {
    const slot = baseSlot();
    const levelBucket = priceToLiqBucket(110);
    const priceInBucket = liqBucketToPrice(levelBucket);
    const next = stepLevelLifecycle(slot, priceInBucket, 1000);
    expect(next.phase).toBe('touched');
    expect(next.firstTouchAt).toBe(1000);
  });
  it('пробив СЛЕД наблюдавано touched -> broken_confirmed', () => {
    let slot = baseSlot({ phase: 'touched', firstTouchAt: 500, firstApproachAt: 500 });
    const next = stepLevelLifecycle(slot, 111, 1000); // мина отвъд 110, страна се сменя
    expect(next.closeReason).toBe('broken_confirmed');
    expect(next.closedAt).toBe(1000);
  });
  it('пробив БЕЗ наблюдавано touched преди него -> broken_gap (прескок между тикове)', () => {
    const slot = baseSlot({ phase: 'approaching', firstApproachAt: 500 });
    const next = stepLevelLifecycle(slot, 111, 1000);
    expect(next.closeReason).toBe('broken_gap');
  });
  it('прав скок директно от далеч (phase=none) отвъд нивото -> също broken_gap', () => {
    const slot = baseSlot({ phase: 'none' });
    const next = stepLevelLifecycle(slot, 111, 1000);
    expect(next.closeReason).toBe('broken_gap');
  });
  it('отблъскване: доближи се, после се отдалечи извън зоната без пробив -> bounced', () => {
    let slot = baseSlot();
    slot = stepLevelLifecycle(slot, 108.5, 1000); // approaching
    const next = stepLevelLifecycle(slot, 100, 2000); // обратно далеч, същата страна
    expect(next.closeReason).toBe('bounced');
    expect(next.bouncedAt).toBe(2000);
  });
  it('никога не приближава -> няма промяна във фазата, слот остава отворен', () => {
    const slot = baseSlot();
    const next = stepLevelLifecycle(slot, 95, 1000); // далеч, отдалечава се още повече
    expect(next.phase).toBe('none');
    expect(next.closedAt).toBeNull();
  });
  it('веднъж затворен слот е terminal - следваща стъпка е no-op', () => {
    const slot = baseSlot({ closedAt: 999, closeReason: 'bounced' });
    const next = stepLevelLifecycle(slot, 50, 2000);
    expect(next).toBe(slot);
  });
  it('peakProximityPct пази МИНИМАЛНОТО наблюдавано разстояние, не последното', () => {
    let slot = baseSlot({ peakProximityPct: 20 });
    slot = stepLevelLifecycle(slot, 108, 1000); // по-близо
    const closer = slot.peakProximityPct;
    slot = stepLevelLifecycle(slot, 100, 2000); // отново далеч
    expect(slot.peakProximityPct).toBe(closer); // не се е влошил назад
  });
});

describe('isLevelLifecycleExpired / expireLevelLifecycle', () => {
  it('отворен слот, по-стар от максималния живот -> expired', () => {
    const slot = { openedAt: 0, closedAt: null };
    expect(isLevelLifecycleExpired(slot, CLUSTER_TRACK_MAX_AGE_MS + 1)).toBe(true);
    expect(isLevelLifecycleExpired(slot, CLUSTER_TRACK_MAX_AGE_MS - 1)).toBe(false);
  });
  it('вече затворен слот никога не се брои за expired', () => {
    const slot = { openedAt: 0, closedAt: 10 };
    expect(isLevelLifecycleExpired(slot, CLUSTER_TRACK_MAX_AGE_MS * 10)).toBe(false);
  });
  it('expireLevelLifecycle маркира closeReason=expired с последната наблюдавана цена', () => {
    const slot = { openedAt: 0, lastObservedPrice: 123 };
    const expired = expireLevelLifecycle(slot, 999);
    expect(expired).toMatchObject({ closedAt: 999, closePrice: 123, closeReason: 'expired' });
  });
});

describe('finalizeClusterLifecycleRecord', () => {
  it('добавя durationMin за затворен слот', () => {
    const slot = { openedAt: 0, closedAt: 10 * 60000 };
    expect(finalizeClusterLifecycleRecord(slot).durationMin).toBe(10);
  });
  it('durationMin е null за неприключен слот', () => {
    const slot = { openedAt: 0, closedAt: null };
    expect(finalizeClusterLifecycleRecord(slot).durationMin).toBeNull();
  });
});

describe('advanceClusterTracking (orchestration)', () => {
  it('първо изпълнение (prevState null) прави само baseline - без births, без слотове от легаси кошчета автоматично', () => {
    const buckets = { [keyFor(101)]: MIN_USD * 2 };
    const { nextState, births, closedRecords } = advanceClusterTracking(null, 'BTCUSDT', buckets, 100, 1000);
    expect(births).toEqual([]);
    expect(closedRecords).toEqual([]);
    expect(nextState.ledger[keyFor(101)]).toMatchObject({ originTag: 'legacy' });
    // Слотът обаче СЕ отваря веднага (селекцията е независима от ledger baseline-а) - легаси клъстера трябва да се следи за изход, просто не се брои за "fresh" статистика.
    expect(nextState.slots.above_cluster).toMatchObject({ originTag: 'legacy', phase: 'none' });
  });

  it('следващ тик: нов fresh клъстер се ражда и слот за него се отваря', () => {
    const first = advanceClusterTracking(null, 'BTCUSDT', {}, 100, 0);
    const buckets2 = { [keyFor(101)]: MIN_USD * 1.5 };
    const second = advanceClusterTracking(first.nextState, 'BTCUSDT', buckets2, 100, 60000);
    expect(second.births).toEqual([{ bucketKey: keyFor(101), bornAt: 60000, bornUsd: MIN_USD * 1.5, birthLatencyMin: null }]);
    expect(second.nextState.slots.above_cluster).toMatchObject({ originTag: 'fresh', bornAt: 60000 });
  });

  it('макс 4 слота: above/below x cluster/control, не повече', () => {
    const buckets = {
      [keyFor(101)]: MIN_USD * 2,   // above cluster
      [keyFor(99)]: MIN_USD * 2,    // below cluster
      [keyFor(100.5)]: 10,          // above control (ще загуби от по-близкия клъстер? различни buckets, няма конфликт - проверяваме и двете могат да съществуват паралелно)
      [keyFor(98)]: 10,             // below control
    };
    const { nextState } = advanceClusterTracking(null, 'BTCUSDT', buckets, 100, 1000);
    const openSlots = Object.values(nextState.slots).filter(Boolean);
    expect(openSlots.length).toBeLessThanOrEqual(4);
    expect(Object.keys(nextState.slots).sort()).toEqual(['above_cluster', 'above_control', 'below_cluster', 'below_control']);
  });

  it('затворен слот се вади от nextState.slots и влиза в closedRecords, с durationMin', () => {
    const buckets1 = { [keyFor(101)]: MIN_USD * 2 };
    const t1 = advanceClusterTracking(null, 'BTCUSDT', buckets1, 100, 0);
    expect(t1.nextState.slots.above_cluster).not.toBeNull();

    // Цената минава ПРЕЗ нивото -> пробив -> слот се затваря
    const t2 = advanceClusterTracking(t1.nextState, 'BTCUSDT', buckets1, 102, 60000);
    expect(t2.closedRecords.length).toBe(1);
    expect(t2.closedRecords[0]).toMatchObject({ side: 'above', kind: 'cluster' });
    expect(t2.closedRecords[0].durationMin).toBe(1);
    expect(t2.nextState.slots.above_cluster).toBeNull();
  });

  it('невалидна цена връща непроменено състояние, без грешка', () => {
    const prev = { ledger: { a: 1 }, slots: { above_cluster: null } };
    const result = advanceClusterTracking(prev, 'BTCUSDT', {}, null, 1000);
    expect(result.nextState).toBe(prev);
    expect(result.births).toEqual([]);
    expect(result.closedRecords).toEqual([]);
  });

  it('expiry: отворен слот по-стар от максималния живот се затваря автоматично', () => {
    const buckets = { [keyFor(101)]: MIN_USD * 2 };
    const t1 = advanceClusterTracking(null, 'BTCUSDT', buckets, 100, 0);
    // Същите buckets/цена (без приближение/пробив) - само времето минава отвъд максималния живот.
    const t2 = advanceClusterTracking(t1.nextState, 'BTCUSDT', buckets, 100, CLUSTER_TRACK_MAX_AGE_MS + 1);
    expect(t2.closedRecords.length).toBe(1);
    expect(t2.closedRecords[0].closeReason).toBe('expired');
  });

  it('cluster и control на ЕДНАТА страна могат да съществуват паралелно (различни кошчета)', () => {
    const buckets = {
      [keyFor(101)]: MIN_USD * 2, // above cluster, ~1% над цената
      [keyFor(101.8)]: 5,          // above control, по-далеч, но пак в радиуса
    };
    const { nextState } = advanceClusterTracking(null, 'BTCUSDT', buckets, 100, 1000);
    expect(nextState.slots.above_cluster).not.toBeNull();
    expect(nextState.slots.above_control).not.toBeNull();
  });
});

describe('trackSymbolClusterOutcome (Stage 2 - KV wiring)', () => {
  it('пише clustertrack:<symbol> при първо извикване', async () => {
    const kv = makeKv();
    const buckets = { [keyFor(101)]: MIN_USD * 2 };
    await trackSymbolClusterOutcome({ ALERT_STATE: kv }, 'BTCUSDT', buckets, 100, 1000);
    expect(kv.m.has(clusterTrackKey('BTCUSDT'))).toBe(true);
    const stored = JSON.parse(kv.m.get(clusterTrackKey('BTCUSDT')));
    expect(stored.slots.above_cluster).toMatchObject({ originTag: 'legacy' });
  });

  it('пише САМО в clustertrack:/clusterevent: ключове - нищо друго', async () => {
    const kv = makeKv();
    const buckets = { [keyFor(101)]: MIN_USD * 2 };
    await trackSymbolClusterOutcome({ ALERT_STATE: kv }, 'BTCUSDT', buckets, 100, 1000);
    for (const key of kv.m.keys()) {
      expect(key.startsWith(CLUSTER_TRACK_KV_PREFIX) || key.startsWith(CLUSTER_EVENT_KV_PREFIX)).toBe(true);
    }
  });

  it('пропуска WRITE, щом слотът е стабилизиран (без промяна в поведението)', async () => {
    const kv = makeKv();
    const buckets = { [keyFor(101)]: MIN_USD * 2 };
    await trackSymbolClusterOutcome({ ALERT_STATE: kv }, 'BTCUSDT', buckets, 100, 1000); // отваря слот (phase 'none')
    await trackSymbolClusterOutcome({ ALERT_STATE: kv }, 'BTCUSDT', buckets, 100, 1001); // 'none' -> 'approaching' - РЕАЛНА промяна, write очакван
    let putCount = 0;
    const originalPut = kv.put;
    kv.put = async (...args) => { putCount++; return originalPut(...args); };
    // Същите buckets/цена - слотът вече е стабилно 'approaching', нищо ново.
    await trackSymbolClusterOutcome({ ALERT_STATE: kv }, 'BTCUSDT', buckets, 100, 1002);
    expect(putCount).toBe(0);
  });

  it('при затваряне на слот пише отделен clusterevent: запис', async () => {
    const kv = makeKv();
    const buckets = { [keyFor(101)]: MIN_USD * 2 };
    await trackSymbolClusterOutcome({ ALERT_STATE: kv }, 'BTCUSDT', buckets, 100, 0);
    // Пробив - цената минава през нивото.
    await trackSymbolClusterOutcome({ ALERT_STATE: kv }, 'BTCUSDT', buckets, 102, 60000);
    const eventKeys = [...kv.m.keys()].filter(k => k.startsWith(CLUSTER_EVENT_KV_PREFIX));
    expect(eventKeys.length).toBe(1);
    const record = JSON.parse(kv.m.get(eventKeys[0]));
    expect(record).toMatchObject({ symbol: 'BTCUSDT', side: 'above', kind: 'cluster', closeReason: 'broken_gap' });
  });

  it('не хвърля при KV грешка, връща null', async () => {
    const badKv = { get: async () => { throw new Error('kv down'); }, put: async () => {} };
    const result = await trackSymbolClusterOutcome({ ALERT_STATE: badKv }, 'BTCUSDT', {}, 100, 0);
    expect(result).toBeNull();
  });

  it('липсващ env.ALERT_STATE -> no-op, без грешка', async () => {
    await expect(trackSymbolClusterOutcome({}, 'BTCUSDT', {}, 100, 0)).resolves.toBeNull();
  });

  it('невалидна цена -> не пише нищо', async () => {
    const kv = makeKv();
    await trackSymbolClusterOutcome({ ALERT_STATE: kv }, 'BTCUSDT', { [keyFor(101)]: MIN_USD * 2 }, null, 0);
    expect(kv.m.size).toBe(0);
  });
});

describe('/cluster-diagnostics endpoint', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/cluster-diagnostics${qs}`), env, { waitUntil() {} });

  it('без/грешен token -> 401', async () => {
    const res = await call({ ALERT_STATE: makeKv(), TELEMETRY_TOKEN: 'secret' });
    expect(res.status).toBe(401);
  });

  it('с валиден token връща отворените слотове и затворените записи', async () => {
    const trackedState = { ledger: {}, slots: { above_cluster: { symbol: 'BTCUSDT', kind: 'cluster', side: 'above' } } };
    const closedRecord = { symbol: 'ETHUSDT', side: 'below', kind: 'control', openedAt: 1000, closedAt: 5000, closeReason: 'bounced' };
    const kv = makeKv({
      [clusterTrackKey('BTCUSDT')]: JSON.stringify(trackedState),
      [clusterEventKey(closedRecord)]: JSON.stringify(closedRecord),
    });
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&symbol=BTCUSDT');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openCount).toBe(1);
    expect(body.tracked.BTCUSDT.slots.above_cluster.symbol).toBe('BTCUSDT');
    expect(body.closedCount).toBe(1);
    expect(body.closed[0].symbol).toBe('ETHUSDT');
  });

  it('read-only - не пише в KV', async () => {
    const kv = makeKv({ [clusterTrackKey('BTCUSDT')]: JSON.stringify({ ledger: {}, slots: {} }) });
    let wrote = false;
    const originalPut = kv.put;
    kv.put = async (...args) => { wrote = true; return originalPut(...args); };
    await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&symbol=BTCUSDT');
    expect(wrote).toBe(false);
  });

  it('без symbol параметър итерира WATCHLIST по .symbol, не по обекта (regression)', async () => {
    const kv = makeKv({ [clusterTrackKey('BTCUSDT')]: JSON.stringify({ ledger: {}, slots: {} }) });
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    const body = await res.json();
    expect(Object.keys(body.tracked)).not.toContain('[object Object]');
    expect(body.tracked.BTCUSDT).toEqual({ ledger: {}, slots: {} });
  });
});

// Помощник: минимален синтетичен затворен lifecycle запис за Stage 3 тестовете.
function closedRecord({ kind = 'cluster', originTag = 'fresh', closeReason = 'bounced', durationMin = 30, peakProximityPct = 1 } = {}) {
  return { symbol: 'BTCUSDT', kind, originTag, closeReason, durationMin, peakProximityPct };
}

describe('buildOutcomeRateStats', () => {
  it('празен списък -> sampleSize 0, lowSample true, всички rates null', () => {
    const s = buildOutcomeRateStats([]);
    expect(s.sampleSize).toBe(0);
    expect(s.lowSample).toBe(true);
    expect(s.rates.bounced).toBeNull();
    expect(s.avgDurationMin).toBeNull();
    expect(s.avgPeakProximityPct).toBeNull();
  });
  it('смята correct counts/rates за смесени closeReason', () => {
    const records = [
      closedRecord({ closeReason: 'bounced' }),
      closedRecord({ closeReason: 'bounced' }),
      closedRecord({ closeReason: 'broken_confirmed' }),
      closedRecord({ closeReason: 'expired' }),
    ];
    const s = buildOutcomeRateStats(records);
    expect(s.sampleSize).toBe(4);
    expect(s.counts).toEqual({ broken_gap: 0, broken_confirmed: 1, bounced: 2, expired: 1 });
    expect(s.rates.bounced).toBeCloseTo(0.5);
    expect(s.rates.broken_confirmed).toBeCloseTo(0.25);
  });
  it('под CLUSTER_OUTCOME_MIN_SAMPLE -> lowSample true, над прага -> false', () => {
    const below = Array.from({ length: CLUSTER_OUTCOME_MIN_SAMPLE - 1 }, () => closedRecord());
    const atThreshold = Array.from({ length: CLUSTER_OUTCOME_MIN_SAMPLE }, () => closedRecord());
    expect(buildOutcomeRateStats(below).lowSample).toBe(true);
    expect(buildOutcomeRateStats(atThreshold).lowSample).toBe(false);
  });
  it('усреднява durationMin/peakProximityPct, игнорира липсващи (null) стойности', () => {
    const records = [
      closedRecord({ durationMin: 10, peakProximityPct: 1 }),
      closedRecord({ durationMin: 30, peakProximityPct: 3 }),
      { ...closedRecord(), durationMin: null, peakProximityPct: null },
    ];
    const s = buildOutcomeRateStats(records);
    expect(s.avgDurationMin).toBeCloseTo(20);
    expect(s.avgPeakProximityPct).toBeCloseTo(2);
  });
  it('нечисти/невалидни записи (null, непознат closeReason) не чупят агрегата', () => {
    const records = [null, undefined, { kind: 'cluster', closeReason: 'something_unexpected' }, closedRecord()];
    expect(() => buildOutcomeRateStats(records)).not.toThrow();
    const s = buildOutcomeRateStats(records);
    expect(s.sampleSize).toBe(4);
    expect(Object.values(s.counts).reduce((a, b) => a + b, 0)).toBe(1); // само истинският closeReason се брои
  });
  it('невалиден вход (не масив) -> празен резултат, без грешка', () => {
    expect(() => buildOutcomeRateStats(null)).not.toThrow();
    expect(buildOutcomeRateStats(undefined).sampleSize).toBe(0);
  });
});

describe('groupClusterOutcomeRecords / buildClusterOutcomeSummary', () => {
  it('разделя правилно cluster_fresh / cluster_legacy / control', () => {
    const records = [
      closedRecord({ kind: 'cluster', originTag: 'fresh' }),
      closedRecord({ kind: 'cluster', originTag: 'legacy' }),
      closedRecord({ kind: 'control', originTag: null }),
    ];
    const groups = groupClusterOutcomeRecords(records);
    expect(groups.cluster_fresh.length).toBe(1);
    expect(groups.cluster_legacy.length).toBe(1);
    expect(groups.control.length).toBe(1);
  });
  it('липсващ/непознат originTag на cluster запис пада консервативно в legacy', () => {
    const records = [{ kind: 'cluster', originTag: null, closeReason: 'bounced' }, { kind: 'cluster', closeReason: 'bounced' }];
    const groups = groupClusterOutcomeRecords(records);
    expect(groups.cluster_fresh.length).toBe(0);
    expect(groups.cluster_legacy.length).toBe(2);
  });
  it('непознат kind се игнорира тихо, без грешка', () => {
    const records = [{ kind: 'something_else' }, closedRecord()];
    expect(() => groupClusterOutcomeRecords(records)).not.toThrow();
    expect(groupClusterOutcomeRecords(records).cluster_fresh.length).toBe(1);
  });
  it('buildClusterOutcomeSummary връща stats за всяка от трите групи', () => {
    const records = [closedRecord({ kind: 'cluster', originTag: 'fresh' }), closedRecord({ kind: 'control' })];
    const summary = buildClusterOutcomeSummary(records);
    expect(Object.keys(summary).sort()).toEqual(['cluster_fresh', 'cluster_legacy', 'control']);
    expect(summary.cluster_fresh.sampleSize).toBe(1);
    expect(summary.cluster_legacy.sampleSize).toBe(0);
    expect(summary.control.sampleSize).toBe(1);
  });
});

describe('compareOutcomeGroups', () => {
  it('смята rate разлика правилно между две групи', () => {
    const a = buildOutcomeRateStats([closedRecord({ closeReason: 'bounced' }), closedRecord({ closeReason: 'bounced' })]);
    const b = buildOutcomeRateStats([closedRecord({ closeReason: 'bounced' }), closedRecord({ closeReason: 'broken_confirmed' })]);
    const cmp = compareOutcomeGroups(a, b, { labelA: 'cluster', labelB: 'control' });
    expect(cmp.rateDiff.bounced).toBeCloseTo(1 - 0.5);
    expect(cmp.labelA).toBe('cluster');
    expect(cmp.labelB).toBe('control');
  });
  it('lowConfidence е true, ако ПОНЕ ЕДНА от двете групи е под прага', () => {
    const small = buildOutcomeRateStats([closedRecord()]);
    const big = buildOutcomeRateStats(Array.from({ length: CLUSTER_OUTCOME_MIN_SAMPLE }, () => closedRecord()));
    expect(compareOutcomeGroups(small, big).lowConfidence).toBe(true);
    expect(compareOutcomeGroups(big, big).lowConfidence).toBe(false);
  });
  it('rateDiff е null, ако някоя от двете групи няма наблюдения за дадения reason', () => {
    const empty = buildOutcomeRateStats([]);
    const some = buildOutcomeRateStats([closedRecord()]);
    const cmp = compareOutcomeGroups(empty, some);
    expect(cmp.rateDiff.bounced).toBeNull();
  });
});

describe('buildClusterVsControlComparison (главна Stage 3 входна точка)', () => {
  it('комбинира breakdown + двете сравнения в едно', () => {
    const records = [
      ...Array.from({ length: 15 }, () => closedRecord({ kind: 'cluster', originTag: 'fresh', closeReason: 'broken_confirmed' })),
      ...Array.from({ length: 5 }, () => closedRecord({ kind: 'cluster', originTag: 'legacy', closeReason: 'bounced' })),
      ...Array.from({ length: 10 }, () => closedRecord({ kind: 'control', originTag: null, closeReason: 'bounced' })),
    ];
    const result = buildClusterVsControlComparison(records);
    expect(result.breakdown.cluster_fresh.sampleSize).toBe(15);
    expect(result.breakdown.cluster_legacy.sampleSize).toBe(5);
    expect(result.breakdown.control.sampleSize).toBe(10);
    expect(result.clusterVsControl.sampleSizeA).toBe(20); // fresh+legacy общо
    expect(result.clusterVsControl.lowConfidence).toBe(true); // cluster общо 20 (не lowSample), но control=10 < 20 прага
    expect(result.freshVsLegacy.labelA).toBe('fresh');
    expect(result.freshVsLegacy.lowConfidence).toBe(true); // legacy sample=5 < 20
  });
  it('празен вход -> всички групи с sampleSize 0, без грешка', () => {
    const result = buildClusterVsControlComparison([]);
    expect(result.breakdown.cluster_fresh.sampleSize).toBe(0);
    expect(result.clusterVsControl.lowConfidence).toBe(true);
  });
  it('невалиден вход (не масив) не хвърля грешка', () => {
    expect(() => buildClusterVsControlComparison(null)).not.toThrow();
    expect(() => buildClusterVsControlComparison(undefined)).not.toThrow();
  });
});
