// ЕТАП 1 - ENTRY TELEMETRY INTEGRITY AUDIT (repair queue "Entry Engine —
// Telemetry Audit & Signal Quality Optimization"). Тества РЕАЛНИЯ worker.js
// код (не копие), директен ESM import, огледално на
// worker-apisports-liveall.test.js. Покрива:
// (1) regression guard срещу bug-а "state.trendArmed липсваше setupAt" -
//     причиняваше episodeId ВИНАГИ null за trend_continuation telemetry.
// (2) buildTelemetryRecord() episodeId коректност (MR + TC + null setupAt).
// (3) новите pure diagnostic функции (unique/episode conversion, coverage
//     range, duplicate detection, unmatched evaluation count, missing
//     latency count) - construct fixtures, не зависят от реален KV.
// (4) schema compatibility - buildTcLifecycleSummary() старите полета остават
//     непроменени по форма и смисъл.
// (5) PR #141 CODE REVIEW fixes: TIMESTAMP IDENTITY (builders приемат
//     канoничен `at`, не 2 независими Date.now()), COMPOSITE EPISODE KEYS
//     (symbol+direction+setupAt, не само `at`), TRUNCATION DETECTION
//     (listKvKeysWithTruncation честно отразява list_complete), INCOMPLETE
//     COHORT WARNINGS (cohortStatus), и end-to-end regression за целия
//     SETUP CREATED -> ARMED CREATED -> ENTRY CONFIRMED поток.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import {
  buildTelemetryRecord, buildTcSetupCreatedRecord, buildTcArmedCreatedRecord,
  buildTcLifecycleSummary, buildTcConversionMetrics,
  buildCoverageRange, countPossibleDuplicateEvents, countUnmatchedEvaluations,
  countMissingLatency, buildTcIntegrityDiagnostics, buildTelemetryIntegrityDiagnostics,
  buildTcMissingEpisodeIds, buildTcCohortStatus, listKvKeysWithTruncation,
} from './worker/worker.js';

const workerSrc = fs.readFileSync('./worker/worker.js', 'utf8');

describe('BUG FIX regression guard - state.trendArmed.setupAt', () => {
  it('state.trendArmed обектният литерал съдържа setupAt (предотвратява episodeId=null bug-а)', () => {
    const idx = workerSrc.indexOf('state.trendArmed = {');
    expect(idx).toBeGreaterThan(-1);
    const block = workerSrc.slice(idx, idx + 400);
    const closeIdx = block.indexOf('};');
    const literal = block.slice(0, closeIdx);
    expect(literal).toContain('setupAt:');
  });
});

describe('buildTelemetryRecord() - episodeId коректност', () => {
  it('TREND CONTINUATION - с popluten setupAt (след fix-а) -> episodeId е коректно построен', () => {
    const rec = buildTelemetryRecord({
      symbol: 'BTCUSDT', direction: 'long', decision: 'confirmed',
      setupMode: 'trend_continuation', setupAt: 1700000000000,
      armedAt: 1700000100000, structRef: 100, triggerClose: 101, atr5m: 1,
    });
    expect(rec.episodeId).toBe('BTCUSDT_trend_continuation_long_1700000000000');
    expect(rec.setupAt).toBe(1700000000000);
  });

  it('TREND CONTINUATION - setupAt null (bug-ът ПРЕДИ fix-а) -> episodeId е null', () => {
    const rec = buildTelemetryRecord({
      symbol: 'BTCUSDT', direction: 'long', decision: 'confirmed',
      setupMode: 'trend_continuation', setupAt: null,
      armedAt: 1700000100000, structRef: 100, triggerClose: 101, atr5m: 1,
    });
    expect(rec.episodeId).toBeNull();
  });

  it('MEAN REVERSION - setupAt от state.setup.at -> episodeId коректно построен', () => {
    const rec = buildTelemetryRecord({
      symbol: 'ETHUSDT', direction: 'short', decision: 'confirmed',
      setupMode: 'mean_reversion', setupAt: 1700000000000,
      armedAt: 1700000050000, structRef: 100, triggerClose: 99, atr5m: 1,
      reArmCount: 3, triggerSource: 'fresh_pivot',
    });
    expect(rec.episodeId).toBe('ETHUSDT_mean_reversion_short_1700000000000');
  });
});

// episodeId тук СЪЗНАТЕЛНО следва точната production конвенция
// (`${symbol}_trend_continuation_${direction}_${setupAt}`), не произволна
// тестова стойност - buildTcEpisodeConversion (след PR #141 review fix)
// сравнява точно срещу тая конвенция, построена от armed_created записите.
function tcEntryRecord({ symbol = 'BTCUSDT', direction = 'long', decision = 'confirmed', armedAt, setupAt, episodeId, timeFromArmMin = 5 } = {}) {
  const resolvedEpisodeId = episodeId !== undefined ? episodeId
    : (setupAt != null ? `${symbol}_trend_continuation_${direction}_${setupAt}` : null);
  return { symbol, direction, decision, armedAt, episodeId: resolvedEpisodeId, timeFromArmMin, setupMode: 'trend_continuation', at: armedAt + 60000 };
}
function lifecycleRecord({ kind, symbol = 'BTCUSDT', direction = 'long', at, setupAt, armedAt, reason }) {
  return { kind, symbol, direction, at, setupAt: setupAt ?? null, armedAt: armedAt ?? null, reason: reason ?? null };
}

describe('buildTcConversionMetrics() - unique vs episode conversion (винаги 0-100%)', () => {
  it('1 SETUP, 3 re-arm (3 ARMED) -> unique conversion = 100%, НЕ 300%', () => {
    const setupCreated = [lifecycleRecord({ kind: 'setup_created', at: 1000 })];
    const armedCreated = [
      lifecycleRecord({ kind: 'armed_created', at: 1100, setupAt: 1000 }),
      lifecycleRecord({ kind: 'armed_created', at: 1200, setupAt: 1000 }),
      lifecycleRecord({ kind: 'armed_created', at: 1300, setupAt: 1000 }),
    ];
    const m = buildTcConversionMetrics(setupCreated, armedCreated, []);
    expect(m.unique.uniqueSetupCount).toBe(1);
    expect(m.unique.uniqueSetupReachedArmedCount).toBe(1);
    expect(m.unique.uniqueSetupToArmedPct).toBe(100);
  });

  it('2 SETUP-а, само 1 стига ARMED -> unique conversion = 50%', () => {
    const setupCreated = [
      lifecycleRecord({ kind: 'setup_created', at: 1000 }),
      lifecycleRecord({ kind: 'setup_created', at: 2000 }),
    ];
    const armedCreated = [lifecycleRecord({ kind: 'armed_created', at: 1100, setupAt: 1000 })];
    const m = buildTcConversionMetrics(setupCreated, armedCreated, []);
    expect(m.unique.uniqueSetupToArmedPct).toBe(50);
  });

  it('episode conversion - 2 допустими ARMED episode-а, 1 с CONFIRMED (с коректен episodeId) -> 50%, не event ratio', () => {
    const armedCreated = [
      lifecycleRecord({ kind: 'armed_created', at: 1100, setupAt: 1000, symbol: 'BTCUSDT' }),
      lifecycleRecord({ kind: 'armed_created', at: 2100, setupAt: 2000, symbol: 'ETHUSDT' }),
    ];
    const entries = [
      tcEntryRecord({ symbol: 'BTCUSDT', armedAt: 1100, setupAt: 1000, decision: 'confirmed' }),
      tcEntryRecord({ symbol: 'BTCUSDT', armedAt: 1100, setupAt: 1000, decision: 'confirmed' }), // повторна evaluation, СЪЩИЯ episode
      tcEntryRecord({ symbol: 'ETHUSDT', armedAt: 2100, setupAt: 2000, decision: 'missed' }),
    ];
    const m = buildTcConversionMetrics([], armedCreated, entries);
    expect(m.episode.eligibleEpisodeCount).toBe(2);
    expect(m.episode.confirmedEpisodeCount).toBe(1);
    expect(m.episode.episodeConfirmedPct).toBe(50);
  });

  it('episode conversion - CONFIRMED с episodeId, който НЕ принадлежи на нито един eligible episode -> не се брои (защита срещу чужд/orphan episodeId)', () => {
    const armedCreated = [lifecycleRecord({ kind: 'armed_created', at: 1100, setupAt: 1000, symbol: 'BTCUSDT' })];
    const entries = [tcEntryRecord({ symbol: 'BTCUSDT', armedAt: 1100, setupAt: 9999999, decision: 'confirmed' })];
    const m = buildTcConversionMetrics([], armedCreated, entries);
    expect(m.episode.eligibleEpisodeCount).toBe(1);
    expect(m.episode.confirmedEpisodeCount).toBe(0);
  });
});

describe('PR #141 review fix 1 - TIMESTAMP IDENTITY (builders приемат канoничен `at`)', () => {
  it('buildTcSetupCreatedRecord({at}) записва ТОЧНО подадения at, не нов Date.now()', () => {
    const canonicalAt = 1700000000123;
    const rec = buildTcSetupCreatedRecord({ symbol: 'BTCUSDT', direction: 'long', price: 100, at: canonicalAt });
    expect(rec.at).toBe(canonicalAt);
  });

  it('buildTcArmedCreatedRecord({at}) записва ТОЧНО подадения at, не нов Date.now()', () => {
    const canonicalAt = 1700000005678;
    const rec = buildTcArmedCreatedRecord({ symbol: 'BTCUSDT', direction: 'long', priceAtArm: 100, at: canonicalAt });
    expect(rec.at).toBe(canonicalAt);
  });

  it('две builder извиквания с РАЗЛИЧНИ canonical `at` стойности (симулира 2 отделни Date.now() извиквания, върнали различен ms) - при explicit `at` подаден, lifecycle записът и "state" идентификаторът въпреки това СЪВПАДАТ', () => {
    // Симулира точно сценария от review-то: ако state.trendSetup.at е записан
    // в state В ЕДИН момент (simulatedStateAt), а builder-ът извика Date.now()
    // ВТОРИ път малко по-късно (simulatedBuilderInternalNow), двете стойности
    // биха се различавали without the fix. С explicit `at: simulatedStateAt`
    // подаден, записът ГАРАНТИРАНО използва state-ия timestamp.
    const simulatedStateAt = 1700000000000;
    const simulatedBuilderInternalNowIfBugPresent = simulatedStateAt + 7; // различна стойност
    expect(simulatedBuilderInternalNowIfBugPresent).not.toBe(simulatedStateAt); // доказва, че "2 Date.now() биха differed"

    const setupRecord = buildTcSetupCreatedRecord({ symbol: 'BTCUSDT', direction: 'long', price: 100, at: simulatedStateAt });
    expect(setupRecord.at).toBe(simulatedStateAt); // НЕ simulatedBuilderInternalNowIfBugPresent

    const armedRecord = buildTcArmedCreatedRecord({
      symbol: 'BTCUSDT', direction: 'long', priceAtArm: 101, setupAt: setupRecord.at, at: simulatedStateAt + 60000,
    });
    expect(armedRecord.setupAt).toBe(setupRecord.at); // state.trendSetup.at === setup lifecycle record.at
  });

  it('без explicit `at` (backward compatible default) -> builder-ът пада обратно на Date.now()', () => {
    const before = Date.now();
    const rec = buildTcSetupCreatedRecord({ symbol: 'BTCUSDT', direction: 'long', price: 100 });
    const after = Date.now();
    expect(rec.at).toBeGreaterThanOrEqual(before);
    expect(rec.at).toBeLessThanOrEqual(after);
  });
});

describe('PR #141 review fix 2 - COMPOSITE EPISODE KEYS (без cross-symbol/cross-direction колизии)', () => {
  it('unique conversion - 2 различни символа, ИДЕНТИЧЕН setup `at` -> 2 отделни SETUP-а, не 1', () => {
    const collisionAt = 1700000000000;
    const setupCreated = [
      lifecycleRecord({ kind: 'setup_created', symbol: 'BTCUSDT', direction: 'long', at: collisionAt }),
      lifecycleRecord({ kind: 'setup_created', symbol: 'ETHUSDT', direction: 'long', at: collisionAt }),
    ];
    const armedCreated = [
      lifecycleRecord({ kind: 'armed_created', symbol: 'BTCUSDT', direction: 'long', at: collisionAt + 100, setupAt: collisionAt }),
    ];
    const m = buildTcConversionMetrics(setupCreated, armedCreated, []);
    expect(m.unique.uniqueSetupCount).toBe(2); // НЕ 1 (без collision merge)
    expect(m.unique.uniqueSetupReachedArmedCount).toBe(1); // само BTCUSDT стигна ARMED
    expect(m.unique.uniqueSetupToArmedPct).toBe(50);
  });

  it('unique conversion - СЪЩИЯ символ, LONG и SHORT на идентичен `at` -> 2 отделни SETUP-а, не се смесват', () => {
    const collisionAt = 1700000000000;
    const setupCreated = [
      lifecycleRecord({ kind: 'setup_created', symbol: 'BTCUSDT', direction: 'long', at: collisionAt }),
      lifecycleRecord({ kind: 'setup_created', symbol: 'BTCUSDT', direction: 'short', at: collisionAt }),
    ];
    const armedCreated = [
      lifecycleRecord({ kind: 'armed_created', symbol: 'BTCUSDT', direction: 'short', at: collisionAt + 100, setupAt: collisionAt }),
    ];
    const m = buildTcConversionMetrics(setupCreated, armedCreated, []);
    expect(m.unique.uniqueSetupCount).toBe(2);
    expect(m.unique.uniqueSetupReachedArmedCount).toBe(1); // само SHORT стигна ARMED
  });

  it('episode conversion - 2 различни символа с идентичен setupAt -> не се обединяват в 1 episode', () => {
    const collisionSetupAt = 1700000000000;
    const armedCreated = [
      lifecycleRecord({ kind: 'armed_created', symbol: 'BTCUSDT', direction: 'long', at: 1100, setupAt: collisionSetupAt }),
      lifecycleRecord({ kind: 'armed_created', symbol: 'ETHUSDT', direction: 'long', at: 2100, setupAt: collisionSetupAt }),
    ];
    const entries = [
      tcEntryRecord({ symbol: 'BTCUSDT', armedAt: 1100, setupAt: collisionSetupAt, decision: 'confirmed' }),
    ];
    const m = buildTcConversionMetrics([], armedCreated, entries);
    expect(m.episode.eligibleEpisodeCount).toBe(2); // НЕ 1
    expect(m.episode.confirmedEpisodeCount).toBe(1); // само BTCUSDT episode-ът е confirmed
  });
});

describe('buildCoverageRange()', () => {
  it('връща min/max `at` сред записите', () => {
    const r = buildCoverageRange([{ at: 500 }, { at: 100 }, { at: 900 }]);
    expect(r.coverageStart).toBe(100);
    expect(r.coverageEnd).toBe(900);
  });
  it('празен масив -> null/null, не хвърля', () => {
    const r = buildCoverageRange([]);
    expect(r.coverageStart).toBeNull();
    expect(r.coverageEnd).toBeNull();
  });
});

describe('countPossibleDuplicateEvents()', () => {
  it('2 armed_created за СЪЩИЯ symbol+direction на <5s разстояние -> флагнати като possible duplicate', () => {
    const records = [
      lifecycleRecord({ kind: 'armed_created', at: 1000 }),
      lifecycleRecord({ kind: 'armed_created', at: 1000 + 1200 }), // 1.2s по-късно
    ];
    expect(countPossibleDuplicateEvents(records)).toBe(1);
  });
  it('2 armed_created на реалистичен re-arm interval (>5s) -> НЕ се флагват', () => {
    const records = [
      lifecycleRecord({ kind: 'armed_created', at: 1000 }),
      lifecycleRecord({ kind: 'armed_created', at: 1000 + 10 * 60000 }), // 10 мин по-късно
    ];
    expect(countPossibleDuplicateEvents(records)).toBe(0);
  });
  it('различни symbol/direction/kind на СЪЩОТО време -> НЕ се флагват (различни ключове)', () => {
    const records = [
      lifecycleRecord({ kind: 'armed_created', symbol: 'BTCUSDT', at: 1000 }),
      lifecycleRecord({ kind: 'armed_created', symbol: 'ETHUSDT', at: 1000 }),
      lifecycleRecord({ kind: 'setup_created', symbol: 'BTCUSDT', at: 1000 }),
    ];
    expect(countPossibleDuplicateEvents(records)).toBe(0);
  });
});

describe('countUnmatchedEvaluations() - обяснява armedToAnyEvaluationPct > 100%', () => {
  it('evaluation с armedAt, несъвпадащ с никой ARMED CREATED в прозореца -> преброен', () => {
    const armedCreated = [lifecycleRecord({ kind: 'armed_created', at: 1000 })];
    const entries = [tcEntryRecord({ armedAt: 1000 }), tcEntryRecord({ armedAt: 9999 })]; // 9999 извън прозореца
    expect(countUnmatchedEvaluations(armedCreated, entries)).toBe(1);
  });
  it('PR #141 review fix - composite key: евалюация за ЧУЖД символ на идентичен armedAt НЕ матчва (без cross-symbol false match)', () => {
    const armedCreated = [lifecycleRecord({ kind: 'armed_created', symbol: 'BTCUSDT', at: 1000 })];
    const entries = [tcEntryRecord({ symbol: 'ETHUSDT', armedAt: 1000 })];
    expect(countUnmatchedEvaluations(armedCreated, entries)).toBe(1); // чужд символ -> unmatched, не false-positive match
  });
});

describe('countMissingLatency() - обяснява "982 от 1026" разликата', () => {
  it('легаси записи без timeFromArmMin не участват в latency bucket-ите', () => {
    const entries = [tcEntryRecord({ timeFromArmMin: 5 }), tcEntryRecord({ timeFromArmMin: null }), tcEntryRecord({ timeFromArmMin: null })];
    expect(countMissingLatency(entries)).toBe(2);
  });
});

describe('PR #141 review fix - buildTcMissingEpisodeIds() (lineage gap detection)', () => {
  it('ARMED episode, чийто SETUP CREATED НЕ е в сканираното - episodeId се появява в missingEpisodeIds', () => {
    const setupCreated = []; // SETUP извън прозореца (truncation)
    const armedCreated = [lifecycleRecord({ kind: 'armed_created', symbol: 'BTCUSDT', direction: 'long', at: 1100, setupAt: 1000 })];
    const missing = buildTcMissingEpisodeIds(setupCreated, armedCreated);
    expect(missing).toEqual(['BTCUSDT_trend_continuation_long_1000']);
  });
  it('ARMED episode с известен SETUP CREATED -> НЕ се появява в missingEpisodeIds', () => {
    const setupCreated = [lifecycleRecord({ kind: 'setup_created', symbol: 'BTCUSDT', direction: 'long', at: 1000 })];
    const armedCreated = [lifecycleRecord({ kind: 'armed_created', symbol: 'BTCUSDT', direction: 'long', at: 1100, setupAt: 1000 })];
    expect(buildTcMissingEpisodeIds(setupCreated, armedCreated)).toEqual([]);
  });
  it('дедупликира - 3 re-arm на СЪЩИЯ missing episode -> 1 запис в масива, не 3', () => {
    const armedCreated = [
      lifecycleRecord({ kind: 'armed_created', symbol: 'BTCUSDT', direction: 'long', at: 1100, setupAt: 1000 }),
      lifecycleRecord({ kind: 'armed_created', symbol: 'BTCUSDT', direction: 'long', at: 1200, setupAt: 1000 }),
    ];
    expect(buildTcMissingEpisodeIds([], armedCreated)).toEqual(['BTCUSDT_trend_continuation_long_1000']);
  });
});

describe('PR #141 review fix 4 - INCOMPLETE COHORT WARNINGS (buildTcCohortStatus)', () => {
  it('нито lifecycle, нито telemetry truncated, с данни -> complete_within_scanned_window', () => {
    const setupCreated = [lifecycleRecord({ kind: 'setup_created', at: 1000 })];
    expect(buildTcCohortStatus(false, false, setupCreated, [])).toBe('complete_within_scanned_window');
  });
  it('lifecycle truncated -> partial_truncated_scan_window (независимо от telemetry)', () => {
    expect(buildTcCohortStatus(true, false, [], [])).toBe('partial_truncated_scan_window');
  });
  it('telemetry truncated -> partial_truncated_scan_window', () => {
    expect(buildTcCohortStatus(false, true, [], [])).toBe('partial_truncated_scan_window');
  });
  it('без truncation, но без никакви SETUP/ARMED записи -> insufficient_data', () => {
    expect(buildTcCohortStatus(false, false, [], [])).toBe('insufficient_data');
  });
});

describe('buildTcIntegrityDiagnostics() - композитен отговор', () => {
  it('комбинира coverage/duplicate/unmatched/missing-latency/conversion/cohortStatus/missingEpisodeIds в едно', () => {
    const lifecycle = [
      lifecycleRecord({ kind: 'setup_created', at: 1000 }),
      lifecycleRecord({ kind: 'armed_created', at: 1100, setupAt: 1000 }),
    ];
    const entries = [tcEntryRecord({ armedAt: 1100, setupAt: 1000, timeFromArmMin: 2 })];
    const d = buildTcIntegrityDiagnostics(lifecycle, entries, false, false);
    expect(d.recordsReturned).toBe(2);
    expect(d.recordsAvailable).toBeNull(); // insufficient_data - никога не се измисля
    expect(d.isTruncated).toEqual({ lifecycle: false, entryEvaluation: false });
    expect(d.cohortStatus).toBe('complete_within_scanned_window');
    expect(d.coverageStart).toBe(1000);
    expect(d.coverageEnd).toBe(1100);
    expect(d.missingEpisodeIds).toEqual([]);
    expect(d.unmatchedEvaluationCount).toBe(0);
    expect(d.missingLatencyCount).toBe(0);
    expect(d.conversionMetrics.unique.uniqueSetupToArmedPct).toBe(100);
    expect(d.conversionMetrics.episode.episodeConfirmedPct).toBe(100);
    expect(d.aggregationPopulation.lifecycle).toMatch(/trend_continuation ONLY/);
  });

  it('truncated lifecycle -> cohortStatus отразява partial, дори с валидни числа', () => {
    const lifecycle = [lifecycleRecord({ kind: 'setup_created', at: 1000 })];
    const d = buildTcIntegrityDiagnostics(lifecycle, [], true, false);
    expect(d.cohortStatus).toBe('partial_truncated_scan_window');
  });
});

describe('buildTelemetryIntegrityDiagnostics() - /telemetry sibling', () => {
  it('отчита setupModeMissingCount за записи без разпознато setupMode', () => {
    const records = [
      { at: 1000, setupMode: 'mean_reversion' },
      { at: 2000, setupMode: 'trend_continuation' },
      { at: 3000, setupMode: undefined },
    ];
    const d = buildTelemetryIntegrityDiagnostics(records, false);
    expect(d.setupModeMissingCount).toBe(1);
    expect(d.coverageStart).toBe(1000);
    expect(d.coverageEnd).toBe(3000);
  });
});

describe('buildTcLifecycleSummary() - schema compatibility (старите полета непроменени)', () => {
  it('запазва точно същата форма на summary обекта', () => {
    const lifecycle = [lifecycleRecord({ kind: 'setup_created', at: 1000 })];
    const s = buildTcLifecycleSummary(lifecycle, []);
    expect(Object.keys(s).sort()).toEqual(
      ['armedCreated', 'conversionPct', 'entryEvaluation', 'latencyBuckets', 'reArm', 'resetByReason', 'setupCreated'].sort()
    );
    expect(Object.keys(s.conversionPct).sort()).toEqual(
      ['armedToAnyEvaluationPct', 'armedToConfirmedPct', 'armedToMissedPct', 'armedToVetoEpisodePct', 'setupToArmedPct'].sort()
    );
  });
});

// PR #141 review fix 3 - TRUNCATION DETECTION. Mock KV, контролиращ точно
// list_complete/cursor поведението, за да покрие 4-те гранични случая,
// изискани в review-то.
function makeMockKv(pages) {
  let call = 0;
  return {
    list: async () => {
      const page = pages[Math.min(call, pages.length - 1)];
      call++;
      return page;
    },
  };
}
function makeKeys(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({ name: `k${offset + i}` }));
}

describe('listKvKeysWithTruncation() - честна truncation проверка (PR #141 review fix 3)', () => {
  it('1999 keys, list_complete:true -> truncated:false (пълен dataset, под лимита)', async () => {
    const kv = makeMockKv([{ keys: makeKeys(1999), list_complete: true, cursor: undefined }]);
    const { keys, truncated } = await listKvKeysWithTruncation(kv, 'prefix:', 2000);
    expect(keys.length).toBe(1999);
    expect(truncated).toBe(false);
  });

  it('точно 2000 keys, list_complete:true -> truncated:false (пълен dataset, точно на лимита)', async () => {
    const kv = makeMockKv([{ keys: makeKeys(2000), list_complete: true, cursor: undefined }]);
    const { keys, truncated } = await listKvKeysWithTruncation(kv, 'prefix:', 2000);
    expect(keys.length).toBe(2000);
    expect(truncated).toBe(false);
  });

  it('точно 2000 keys, НО list_complete:false (още страници чакат) -> truncated:true (БЕШЕ false преди фикса - именно бъгът от review-то)', async () => {
    const kv = makeMockKv([{ keys: makeKeys(2000), list_complete: false, cursor: 'more' }]);
    const { keys, truncated } = await listKvKeysWithTruncation(kv, 'prefix:', 2000);
    expect(keys.length).toBe(2000);
    expect(truncated).toBe(true);
  });

  it('повече от 2000 keys (2 страници от 1000+1500) -> truncated:true, keys slice-нати до 2000', async () => {
    const kv = makeMockKv([
      { keys: makeKeys(1000), list_complete: false, cursor: 'page2' },
      { keys: makeKeys(1500, 1000), list_complete: false, cursor: 'page3' },
    ]);
    const { keys, truncated } = await listKvKeysWithTruncation(kv, 'prefix:', 2000);
    expect(keys.length).toBe(2000); // капнато, не 2500
    expect(truncated).toBe(true);
  });
});

// PR #141 review fix 5 - END-TO-END REGRESSION TESTS: реалните builder
// функции, свързани в ТОЧНАТА production последователност (SETUP CREATED ->
// ARMED CREATED -> ENTRY CONFIRMED), с explicit canonical `at` стойности
// (огледално на scanSymbolSignals wiring-а след review фикса), подадени в
// новите diagnostic агрегатори.
describe('END-TO-END regression - SETUP CREATED -> ARMED CREATED -> ENTRY CONFIRMED', () => {
  it('сценарий 1: 1 завършен SETUP -> 1 ARMED -> 1 CONFIRMED - пълна кохорта, 0 несъответствия', () => {
    const symbol = 'BTCUSDT', direction = 'long';
    const setupAt = 1700000000000;
    const armedAt = setupAt + 5 * 60000;

    const setupRecord = buildTcSetupCreatedRecord({ symbol, direction, price: 100, setupScore: 3, at: setupAt });
    const armedRecord = buildTcArmedCreatedRecord({
      symbol, direction, priceAtArm: 101, structuralReference: 99, atrAtArm: 1,
      setupAt: setupRecord.at, at: armedAt,
    });
    const entryRecord = buildTelemetryRecord({
      symbol, direction, decision: 'confirmed', setupMode: 'trend_continuation',
      setupAt: setupRecord.at, armedAt: armedRecord.at,
      structRef: 99, triggerClose: 102, atr5m: 1,
    });

    // 1. Еднакъв setupAt по цялата верига.
    expect(armedRecord.setupAt).toBe(setupRecord.at);
    expect(entryRecord.setupAt).toBe(setupRecord.at);
    // 2. Правилен episodeId.
    expect(entryRecord.episodeId).toBe(`${symbol}_trend_continuation_${direction}_${setupAt}`);
    // 3. Правилна връзка чрез armedAt.
    expect(entryRecord.armedAt).toBe(armedRecord.at);

    const setupCreated = [setupRecord];
    const armedCreated = [armedRecord];
    const tcEntryRecords = [{ ...entryRecord, at: armedAt + 60000 }];

    const diag = buildTcIntegrityDiagnostics(
      [...setupCreated.map((r) => ({ kind: 'setup_created', ...r })), ...armedCreated.map((r) => ({ kind: 'armed_created', ...r }))],
      tcEntryRecords, false, false,
    );
    // 4. unique conversion = 100% при един завършен SETUP.
    expect(diag.conversionMetrics.unique.uniqueSetupToArmedPct).toBe(100);
    // 5. episode conversion = 100% при един завършен CONFIRMED episode.
    expect(diag.conversionMetrics.episode.episodeConfirmedPct).toBe(100);
    // 6. unmatchedEvaluationCount = 0 за тая пълна тестова кохорта.
    expect(diag.unmatchedEvaluationCount).toBe(0);
    expect(diag.missingEpisodeIds).toEqual([]);
  });

  it('сценарий 2: 1 SETUP -> 3 ARMED (re-arm) -> 1 CONFIRMED - 1 уникален episode, НЕ инфлация над 100%', () => {
    const symbol = 'BTCUSDT', direction = 'long';
    const setupAt = 1700000000000;

    const setupRecord = buildTcSetupCreatedRecord({ symbol, direction, price: 100, at: setupAt });
    const armedRecords = [0, 1, 2].map((i) =>
      buildTcArmedCreatedRecord({
        symbol, direction, priceAtArm: 101 + i, setupAt: setupRecord.at, at: setupAt + (i + 1) * 5 * 60000,
      })
    );
    const lastArmed = armedRecords[armedRecords.length - 1];
    const entryRecord = buildTelemetryRecord({
      symbol, direction, decision: 'confirmed', setupMode: 'trend_continuation',
      setupAt: setupRecord.at, armedAt: lastArmed.at, structRef: 99, triggerClose: 105, atr5m: 1,
    });

    const lifecycleRecords = [
      { kind: 'setup_created', ...setupRecord },
      ...armedRecords.map((r) => ({ kind: 'armed_created', ...r })),
    ];
    const tcEntryRecords = [{ ...entryRecord, at: lastArmed.at + 60000 }];

    const diag = buildTcIntegrityDiagnostics(lifecycleRecords, tcEntryRecords, false, false);
    expect(diag.conversionMetrics.unique.uniqueSetupCount).toBe(1); // 1 уникален SETUP, не 3
    expect(diag.conversionMetrics.unique.uniqueSetupToArmedPct).toBe(100); // НЕ 300%
    expect(diag.conversionMetrics.episode.eligibleEpisodeCount).toBe(1); // 3 ARMED -> 1 episode
    expect(diag.conversionMetrics.episode.episodeConfirmedPct).toBe(100);
    expect(diag.unmatchedEvaluationCount).toBe(0);
  });

  it('сценарий 3: 2 различни символа с ИДЕНТИЧНИ timestamps - без collision, без неправилно обединяване', () => {
    const collisionSetupAt = 1700000000000;
    const collisionArmedAt = collisionSetupAt + 5 * 60000;

    const setupBtc = buildTcSetupCreatedRecord({ symbol: 'BTCUSDT', direction: 'long', price: 100, at: collisionSetupAt });
    const setupEth = buildTcSetupCreatedRecord({ symbol: 'ETHUSDT', direction: 'long', price: 50, at: collisionSetupAt });
    const armedBtc = buildTcArmedCreatedRecord({ symbol: 'BTCUSDT', direction: 'long', priceAtArm: 101, setupAt: collisionSetupAt, at: collisionArmedAt });
    const armedEth = buildTcArmedCreatedRecord({ symbol: 'ETHUSDT', direction: 'long', priceAtArm: 51, setupAt: collisionSetupAt, at: collisionArmedAt });

    const entryBtc = buildTelemetryRecord({
      symbol: 'BTCUSDT', direction: 'long', decision: 'confirmed', setupMode: 'trend_continuation',
      setupAt: collisionSetupAt, armedAt: collisionArmedAt, structRef: 99, triggerClose: 102, atr5m: 1,
    });
    // ETH episode НЕ потвърден (missed) - очакваме episode conversion да отличи
    // BTCUSDT (confirmed) от ETHUSDT (missed), не да ги слее в 1 "collision" episode.
    const entryEth = buildTelemetryRecord({
      symbol: 'ETHUSDT', direction: 'long', decision: 'missed', setupMode: 'trend_continuation',
      setupAt: collisionSetupAt, armedAt: collisionArmedAt, structRef: 49, triggerClose: 50, atr5m: 1,
    });

    expect(entryBtc.episodeId).not.toBe(entryEth.episodeId); // различни episodeId-та въпреки идентичните timestamps

    const lifecycleRecords = [
      { kind: 'setup_created', ...setupBtc }, { kind: 'setup_created', ...setupEth },
      { kind: 'armed_created', ...armedBtc }, { kind: 'armed_created', ...armedEth },
    ];
    const tcEntryRecords = [
      { ...entryBtc, at: collisionArmedAt + 60000 },
      { ...entryEth, at: collisionArmedAt + 60000 },
    ];

    const diag = buildTcIntegrityDiagnostics(lifecycleRecords, tcEntryRecords, false, false);
    expect(diag.conversionMetrics.unique.uniqueSetupCount).toBe(2); // 2 отделни SETUP-а
    expect(diag.conversionMetrics.episode.eligibleEpisodeCount).toBe(2); // 2 отделни episode-а
    expect(diag.conversionMetrics.episode.confirmedEpisodeCount).toBe(1); // само BTCUSDT
    expect(diag.conversionMetrics.episode.episodeConfirmedPct).toBe(50); // НЕ 100%, НЕ колизия
    expect(diag.unmatchedEvaluationCount).toBe(0);
  });
});
