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
  OUTCOME_HORIZONS_MIN, buildPendingOutcomeHorizons, resolvePendingOutcomeHorizons, updateExcursion,
  buildMrSetupCreatedRecord, buildMrArmedCreatedRecord, buildMrArmedResetRecord,
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

// FINAL REVIEW CORRECTION - buildTcCohortStatus() вече приема ЕДИН options
// обект и връща {status, scanComplete, lineageComplete} (не само string) -
// SCAN completeness (KV list_complete) и LINEAGE completeness (SETUP->
// ARMED->ENTRY връзките действително проследими) са ЯВНО разграничени,
// никога слети в едно булево.
function cohortArgs(overrides = {}) {
  return {
    scanTruncated: false, setupCreatedRecords: [], armedCreatedRecords: [],
    missingEpisodeIds: [], unmatchedEvaluationCount: 0, nullEpisodeIdCount: 0,
    ...overrides,
  };
}

describe('PR #141 review fix 4 - INCOMPLETE COHORT WARNINGS (buildTcCohortStatus)', () => {
  it('scan complete + lineage complete + с данни -> complete_within_scanned_window', () => {
    const setupCreated = [lifecycleRecord({ kind: 'setup_created', at: 1000 })];
    const r = buildTcCohortStatus(cohortArgs({ setupCreatedRecords: setupCreated }));
    expect(r.status).toBe('complete_within_scanned_window');
    expect(r.scanComplete).toBe(true);
    expect(r.lineageComplete).toBe(true);
  });

  it('scan truncated -> partial_truncated_scan_window, scanComplete:false', () => {
    const r = buildTcCohortStatus(cohortArgs({ scanTruncated: true }));
    expect(r.status).toBe('partial_truncated_scan_window');
    expect(r.scanComplete).toBe(false);
  });

  it('scan complete, без никакви SETUP/ARMED записи -> insufficient_data', () => {
    const r = buildTcCohortStatus(cohortArgs());
    expect(r.status).toBe('insufficient_data');
  });

  // FINAL REVIEW CORRECTION - точно сценарият от review-то: KV сканирането е
  // ЗАВЪРШЕНО (scanTruncated:false), ИМА валидни SETUP/ARMED записи, но
  // lineage-ът е нарушен (missingEpisodeIds непразен) -> status трябва да
  // отрази LINEAGE проблема, не "complete", само защото скенирането приключи.
  it('scan complete, НО lineage incomplete (missingEpisodeIds непразен) -> scan_complete_lineage_incomplete, НЕ complete', () => {
    const setupCreated = [lifecycleRecord({ kind: 'setup_created', at: 1000 })];
    const r = buildTcCohortStatus(cohortArgs({
      setupCreatedRecords: setupCreated,
      missingEpisodeIds: ['BTCUSDT_trend_continuation_long_5000'],
    }));
    expect(r.status).toBe('scan_complete_lineage_incomplete');
    expect(r.scanComplete).toBe(true);
    expect(r.lineageComplete).toBe(false);
  });

  it('scan complete, НО unmatchedEvaluationCount > 0 -> lineage incomplete', () => {
    const setupCreated = [lifecycleRecord({ kind: 'setup_created', at: 1000 })];
    const r = buildTcCohortStatus(cohortArgs({ setupCreatedRecords: setupCreated, unmatchedEvaluationCount: 2 }));
    expect(r.status).toBe('scan_complete_lineage_incomplete');
    expect(r.lineageComplete).toBe(false);
  });

  it('scan complete, НО nullEpisodeIdCount > 0 -> lineage incomplete', () => {
    const setupCreated = [lifecycleRecord({ kind: 'setup_created', at: 1000 })];
    const r = buildTcCohortStatus(cohortArgs({ setupCreatedRecords: setupCreated, nullEpisodeIdCount: 3 }));
    expect(r.status).toBe('scan_complete_lineage_incomplete');
    expect(r.lineageComplete).toBe(false);
  });

  it('scan truncated НАДВИШАВА lineage проблема в status-а (partial_truncated_scan_window, не scan_complete_lineage_incomplete)', () => {
    const r = buildTcCohortStatus(cohortArgs({ scanTruncated: true, missingEpisodeIds: ['x'] }));
    expect(r.status).toBe('partial_truncated_scan_window');
    expect(r.lineageComplete).toBe(false); // все пак вярно отразено, дори не е primary статус
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
    expect(d.cohortScanComplete).toBe(true);
    expect(d.cohortLineageComplete).toBe(true);
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
    expect(d.cohortScanComplete).toBe(false);
  });

  // FINAL REVIEW CORRECTION - точно регресионния случай, изискан в review-то:
  // "KV scan е завършен. Има валиден SETUP. Има ARMED от друг SETUP, който
  // липсва в прочетените записи. Очакване: Scan complete, но lineage
  // incomplete." Изграден на ниво ПЪЛЕН buildTcIntegrityDiagnostics() отговор
  // (не само изолираната buildTcCohortStatus()), за да покрие реалния
  // composite wiring (missingEpisodeIds -> cohortStatus).
  it('scan complete + валиден SETUP + ARMED от ДРУГ, липсващ SETUP -> scan complete, lineage incomplete', () => {
    const lifecycle = [
      // Валиден, напълно проследим episode: BTCUSDT SETUP@1000 -> ARMED@1100.
      lifecycleRecord({ kind: 'setup_created', symbol: 'BTCUSDT', direction: 'long', at: 1000 }),
      lifecycleRecord({ kind: 'armed_created', symbol: 'BTCUSDT', direction: 'long', at: 1100, setupAt: 1000 }),
      // ARMED от ДРУГ SETUP (setupAt: 5000), чийто setup_created запис липсва
      // от текущо сканираните lifecycle записи (напр. retention/pagination
      // граница) - lineage gap, въпреки че KV сканирането самò по себе си е
      // напълно завършено (lifecycleTruncated/telemetryTruncated = false по-долу).
      lifecycleRecord({ kind: 'armed_created', symbol: 'ETHUSDT', direction: 'long', at: 5100, setupAt: 5000 }),
    ];
    const entries = [tcEntryRecord({ symbol: 'BTCUSDT', armedAt: 1100, setupAt: 1000, decision: 'confirmed' })];

    const d = buildTcIntegrityDiagnostics(lifecycle, entries, /* lifecycleTruncated */ false, /* telemetryTruncated */ false);

    expect(d.cohortScanComplete).toBe(true); // KV сканирането самò по себе си Е завършено
    expect(d.missingEpisodeIds).toEqual(['ETHUSDT_trend_continuation_long_5000']); // lineage gap-ът е видим
    expect(d.cohortLineageComplete).toBe(false); // ... и затова lineage НЕ е пълен
    expect(d.cohortStatus).toBe('scan_complete_lineage_incomplete'); // НЕ "complete_within_scanned_window"
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

// PR #141 review fix 3 - TRUNCATION DETECTION, PR #141 FINAL REVIEW
// CORRECTION - реалистични KV страници. Mock KV, който ХВЪРЛЯ ако поискана
// страница съдържа повече ключове от production `limit` (1000) -
// гарантира, че фикстурите отразяват истинското Cloudflare KV .list()
// поведение (никога повече от `limit` ключа на страница), не произволно
// голяма единична "страница" от 1999/2000/2500 ключа наведнъж (каквото
// реално KV никога не би върнало за limit:1000 заявка).
function makeMockKv(pages) {
  let call = 0;
  return {
    callCount: () => call,
    list: async ({ limit }) => {
      const page = pages[Math.min(call, pages.length - 1)];
      if (page.keys.length > limit) {
        throw new Error(`mock KV page violates realistic limit: ${page.keys.length} > ${limit}`);
      }
      call++;
      return page;
    },
  };
}
function makeKeys(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({ name: `k${offset + i}` }));
}

describe('listKvKeysWithTruncation() - честна truncation проверка (PR #141 review fix 3, реалистични ≤1000-key страници)', () => {
  it('1999 keys през 2 реалистични страници (1000+999), list_complete:true на последната -> truncated:false', async () => {
    const kv = makeMockKv([
      { keys: makeKeys(1000), list_complete: false, cursor: 'page2' },
      { keys: makeKeys(999, 1000), list_complete: true, cursor: undefined },
    ]);
    const { keys, truncated } = await listKvKeysWithTruncation(kv, 'prefix:', 2000);
    expect(keys.length).toBe(1999);
    expect(truncated).toBe(false);
  });

  it('точно 2000 keys през 2 реалистични страници (1000+1000), list_complete:true на последната -> truncated:false (пълен dataset, точно на лимита)', async () => {
    const kv = makeMockKv([
      { keys: makeKeys(1000), list_complete: false, cursor: 'page2' },
      { keys: makeKeys(1000, 1000), list_complete: true, cursor: undefined },
    ]);
    const { keys, truncated } = await listKvKeysWithTruncation(kv, 'prefix:', 2000);
    expect(keys.length).toBe(2000);
    expect(truncated).toBe(false);
  });

  it('точно 2000 keys през 2 реалистични страници (1000+1000), НО list_complete:false на последната (още страници чакат) -> truncated:true (БЕШЕ false преди фикса - именно бъгът от review-то)', async () => {
    const kv = makeMockKv([
      { keys: makeKeys(1000), list_complete: false, cursor: 'page2' },
      { keys: makeKeys(1000, 1000), list_complete: false, cursor: 'page3' },
    ]);
    const { keys, truncated } = await listKvKeysWithTruncation(kv, 'prefix:', 2000);
    expect(keys.length).toBe(2000);
    expect(truncated).toBe(true);
  });

  it('данни отвъд лимита - 3-тата реалистична страница НИКОГА не се извлича заради MAX_KEYS_SCANNED таванa -> truncated:true, keys капнати до 2000, само 2 заявки направени', async () => {
    const kv = makeMockKv([
      { keys: makeKeys(1000), list_complete: false, cursor: 'page2' },
      { keys: makeKeys(1000, 1000), list_complete: false, cursor: 'page3' },
      { keys: makeKeys(500, 2000), list_complete: true, cursor: undefined }, // НИКОГА не се достига
    ]);
    const { keys, truncated } = await listKvKeysWithTruncation(kv, 'prefix:', 2000);
    expect(keys.length).toBe(2000); // капнато, не 2500
    expect(truncated).toBe(true);
    expect(kv.callCount()).toBe(2); // 3-тата страница НИКОГА не е извлечена - MAX_KEYS_SCANNED капва заявките, не само крайния резултат
  });

  it('единична реалистична 1000-key страница (точен production page size), list_complete:true -> truncated:false', async () => {
    const kv = makeMockKv([{ keys: makeKeys(1000), list_complete: true, cursor: undefined }]);
    const { keys, truncated } = await listKvKeysWithTruncation(kv, 'prefix:', 2000);
    expect(keys.length).toBe(1000);
    expect(truncated).toBe(false);
  });

  it('mock-ът хвърля при НЕреалистична страница (>1000 ключа) - доказва, че фикстурите по-горе никога не нарушават production limit-а', async () => {
    const kv = makeMockKv([{ keys: makeKeys(1500), list_complete: true, cursor: undefined }]);
    await expect(listKvKeysWithTruncation(kv, 'prefix:', 2000)).rejects.toThrow(/realistic limit/);
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

// VETO RETROSPECTIVE STAGE 2 (2026-11-26) - разширени хоризонти (120/360м) +
// пазарен режим context + VETO влизащ в pendingOutcomes.
describe('VETO RETROSPECTIVE STAGE 2 - разширени хоризонти', () => {
  it('OUTCOME_HORIZONS_MIN съдържа всичките 7 одобрени хоризонта, във възходящ ред', () => {
    expect(OUTCOME_HORIZONS_MIN).toEqual([5, 15, 30, 60, 120, 240, 360]);
  });

  it('buildPendingOutcomeHorizons произвежда m120/m360 ключове с коректен dueAt', () => {
    const horizons = buildPendingOutcomeHorizons(1000000);
    expect(horizons.m120.dueAt).toBe(1000000 + 120 * 60000);
    expect(horizons.m360.dueAt).toBe(1000000 + 360 * 60000);
    expect(Object.keys(horizons).length).toBe(7);
  });

  it('resolvePendingOutcomeHorizons попълва outcome120m/outcome360m при due момента', () => {
    const pending = { horizons: buildPendingOutcomeHorizons(0), entryPrice: 100, direction: 'long' };
    const { updates, allResolved } = resolvePendingOutcomeHorizons(pending, 110, 360 * 60000);
    expect(updates.outcome120m).toBeCloseTo(10, 5);
    expect(updates.outcome360m).toBeCloseTo(10, 5);
    expect(allResolved).toBe(true);
  });

  it('buildTelemetryRecord има null placeholder-и за всичките нови 120м/360м полета', () => {
    const rec = buildTelemetryRecord({
      symbol: 'BTCUSDT', direction: 'long', decision: 'veto', setupMode: 'trend_continuation',
      armedAt: 1, structRef: 100, triggerClose: 101, atr5m: 1, vetoSource: 'liq',
    });
    for (const f of ['outcome120m', 'outcome360m', 'mfe120m', 'mae120m', 'mfe120mAtr', 'mae120mAtr',
      'mfe360m', 'mae360m', 'mfe360mAtr', 'mae360mAtr']) {
      expect(rec[f]).toBeNull();
    }
  });
});

describe('VETO RETROSPECTIVE STAGE 2 - пазарен режим context в telemetry', () => {
  it('buildTelemetryRecord записва подадените liqGravity*/htfTrend4h стойности', () => {
    const rec = buildTelemetryRecord({
      symbol: 'ETHUSDT', direction: 'short', decision: 'veto', setupMode: 'mean_reversion',
      armedAt: 1, structRef: 100, triggerClose: 99, atr5m: 1, vetoSource: 'liq',
      liqGravityTier: 'watch', liqGravityDirection: 'long', liqGravityDistancePct: 1.23,
      liqCascadeBuyUsd: 50000, liqCascadeSellUsd: 12000, htfTrend4h: 'bear',
    });
    expect(rec.liqGravityTier).toBe('watch');
    expect(rec.liqGravityDirection).toBe('long');
    expect(rec.liqGravityDistancePct).toBe(1.23);
    expect(rec.liqCascadeBuyUsd).toBe(50000);
    expect(rec.liqCascadeSellUsd).toBe(12000);
    expect(rec.htfTrend4h).toBe('bear');
  });

  it('buildTelemetryRecord без подадени режим полета -> безопасни default-и (none/null)', () => {
    const rec = buildTelemetryRecord({
      symbol: 'ETHUSDT', direction: 'short', decision: 'confirmed', setupMode: 'mean_reversion',
      armedAt: 1, structRef: 100, triggerClose: 99, atr5m: 1,
    });
    expect(rec.liqGravityTier).toBe('none');
    expect(rec.liqGravityDirection).toBeNull();
    expect(rec.liqGravityDistancePct).toBeNull();
    expect(rec.liqCascadeBuyUsd).toBeNull();
    expect(rec.liqCascadeSellUsd).toBeNull();
    expect(rec.htfTrend4h).toBeNull();
  });
});

describe('VETO RETROSPECTIVE STAGE 2 - двупосочно MFE/MAE за VETO чрез wiring-а в scanSymbolSignals', () => {
  it('worker.js wiring-ът включва decision===\'veto\' в pendingOutcomes push условието (2 call sites: MR + TC)', () => {
    const matches = workerSrc.match(/decision === 'confirmed' \|\| decision === 'missed' \|\| decision === 'veto'/g) || [];
    expect(matches.length).toBe(2);
  });

  it('updateExcursion/calcOutcomePct огледална симетрия: mae за direction=long == -(mfe за direction=short) на ИДЕНТИЧЕН ценов път', () => {
    // Доказва твърдението в коментара на wiring-а: за един VETO LONG запис,
    // mae{X}m (движение В ПРОТИВОПОЛОЖНАТА, SHORT посока) е математически
    // идентично на mfe{X}m, което БИ се получило, ако directio=short за
    // СЪЩИЯ ценов път - т.е. ЕДИН pendingOutcomes запис реално носи
    // информация за движение в двете посоки, без нужда от паралелен tracking.
    const candle = { high: 105, low: 95 };
    const pendingLong = { direction: 'long', entryPrice: 100 };
    const pendingShort = { direction: 'short', entryPrice: 100 };
    updateExcursion(pendingLong, candle, 0);
    updateExcursion(pendingShort, candle, 0);
    expect(pendingLong.mfePct).toBeCloseTo(5, 6); // LONG favorable = high movement
    expect(pendingLong.maePct).toBeCloseTo(-5, 6); // LONG adverse = low movement
    expect(pendingShort.mfePct).toBeCloseTo(5, 6); // SHORT favorable = low movement (огледално положително)
    expect(pendingShort.maePct).toBeCloseTo(-5, 6); // SHORT adverse = high movement
    // Самата огледална симетрия: adverse excursion за LONG (-5%) по модул
    // съвпада с favorable excursion, което SHORT би видял на СЪЩИЯ ценов път (+5%).
    expect(pendingLong.maePct).toBeCloseTo(-pendingShort.mfePct, 6);
    expect(pendingShort.maePct).toBeCloseTo(-pendingLong.mfePct, 6);
  });
});

// MR LIFECYCLE TELEMETRY (2026-11-26) - mrlifecycle:, огледално на
// tclifecycle: (TC), затваря SETUP/ARMED blind spot-а, установен в VETO
// RETROSPECTIVE Stage 1 анализа.
describe('MR LIFECYCLE TELEMETRY - builders (огледално на TC builders)', () => {
  it('buildMrSetupCreatedRecord({at}) записва ТОЧНО подадения at, не нов Date.now()', () => {
    const canonicalAt = 1700000000000;
    const rec = buildMrSetupCreatedRecord({ symbol: 'BTCUSDT', direction: 'long', price: 100, setupScore: 4, at: canonicalAt });
    expect(rec).toEqual({ kind: 'setup_created', symbol: 'BTCUSDT', direction: 'long', at: canonicalAt, price: 100, setupScore: 4 });
  });

  it('buildMrArmedCreatedRecord({at}) записва ТОЧНО подадения at + setupAt linkage', () => {
    const canonicalAt = 1700000100000;
    const rec = buildMrArmedCreatedRecord({
      symbol: 'ETHUSDT', direction: 'short', priceAtArm: 50, structuralReference: 51,
      atrAtArm: 0.5, setupAt: 1700000000000, at: canonicalAt,
    });
    expect(rec).toEqual({
      kind: 'armed_created', symbol: 'ETHUSDT', direction: 'short', at: canonicalAt,
      priceAtArm: 50, structuralReference: 51, atrAtArm: 0.5, setupAt: 1700000000000,
    });
  });

  it('buildMrArmedResetRecord - 5-те реални reason клона (setup_lost/direction_changed/expired_6h/entry_confirmed/entry_missed)', () => {
    for (const reason of ['setup_lost', 'direction_changed', 'expired_6h', 'entry_confirmed', 'entry_missed']) {
      const rec = buildMrArmedResetRecord({
        symbol: 'BTCUSDT', direction: 'long', armedAt: 1000, priceAtArm: 100, reason, price: 102, atrAtArm: 1, at: 1600000,
      });
      expect(rec.kind).toBe('armed_reset');
      expect(rec.reason).toBe(reason);
      expect(rec.armedDurationMin).toBeCloseTo((1600000 - 1000) / 60000, 6);
      expect(rec.pctMoveFromArm).toBeCloseTo(2, 6); // (102-100)/100*100
    }
  });

  it('buildMrArmedResetRecord без armedAt -> armedDurationMin е null (defensive, огледално на TC)', () => {
    const rec = buildMrArmedResetRecord({ symbol: 'BTCUSDT', direction: 'long', armedAt: null, priceAtArm: 100, reason: 'expired_6h', price: 102 });
    expect(rec.armedDurationMin).toBeNull();
  });
});

describe('MR LIFECYCLE TELEMETRY - wiring присъства в scanSymbolSignals (структурна проверка)', () => {
  it('SETUP CREATED се записва в mrlifecycle: при setupFired', () => {
    expect(workerSrc).toMatch(/mrlifecycle:\$\{symbol\}:\$\{mrSetupRecord\.at\}:setup_created/);
  });
  it('ARMED CREATED се записва в mrlifecycle: при armedFired', () => {
    expect(workerSrc).toMatch(/mrlifecycle:\$\{symbol\}:\$\{mrArmedRecord\.at\}:armed_created/);
  });
  it('ARMED RESET се записва в mrlifecycle: за всичките 4 reset пътя (setup_lost/direction_changed комбинирани, expired_6h, entry_confirmed/entry_missed)', () => {
    const matches = [...workerSrc.matchAll(/mrlifecycle:\$\{symbol\}:\$\{\w+\.at\}:armed_reset/g)];
    expect(matches.length).toBe(3); // 1x (setup_lost|direction_changed), 1x expired_6h, 1x (entry_confirmed|entry_missed)
  });
  it('MR ARMED RESET wiring НЕ променя оригиналното armedShouldReset условие (regression guard, виж worker-liquidation-live.test.js байт-идентичност)', () => {
    expect(workerSrc).toContain("const armedShouldReset = !setupState.direction || (prevArmed && prevArmed.direction !== setupState.direction);");
  });
});

describe('MR LIFECYCLE TELEMETRY - end-to-end: SETUP -> ARMED -> ENTRY/RESET linkage (fixture-ниво, огледално на TC-то)', () => {
  it('setupAt linkage: armed_created.setupAt === setup_created.at за СЪЩИЯ episode', () => {
    const setupAt = 1700000000000;
    const armedAt = 1700000050000;
    const setupRecord = buildMrSetupCreatedRecord({ symbol: 'SOLUSDT', direction: 'long', price: 100, setupScore: 3, at: setupAt });
    const armedRecord = buildMrArmedCreatedRecord({
      symbol: 'SOLUSDT', direction: 'long', priceAtArm: 101, structuralReference: 99, atrAtArm: 0.4, setupAt: setupRecord.at, at: armedAt,
    });
    expect(armedRecord.setupAt).toBe(setupRecord.at);
  });

  it('entry_confirmed reset запис + telemetry ENTRY запис за СЪЩИЯ episode - episodeId (от telemetry) и setupAt (от mrlifecycle) съвпадат', () => {
    const setupAt = 1700000000000;
    const armedAt = 1700000050000;
    const entryAt = 1700000100000;
    const armedResetRecord = buildMrArmedResetRecord({
      symbol: 'SOLUSDT', direction: 'long', armedAt, priceAtArm: 101, reason: 'entry_confirmed', price: 103, atrAtArm: 0.4, at: entryAt,
    });
    const entryTelemetry = buildTelemetryRecord({
      symbol: 'SOLUSDT', direction: 'long', decision: 'confirmed', setupMode: 'mean_reversion',
      setupAt, armedAt, structRef: 99, triggerClose: 103, atr5m: 0.4,
    });
    expect(entryTelemetry.episodeId).toBe('SOLUSDT_mean_reversion_long_' + setupAt);
    expect(armedResetRecord.reason).toBe('entry_confirmed');
    expect(armedResetRecord.armedDurationMin).toBeCloseTo((entryAt - armedAt) / 60000, 6);
  });
});
