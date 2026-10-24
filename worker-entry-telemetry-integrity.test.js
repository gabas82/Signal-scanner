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
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import {
  buildTelemetryRecord, buildTcLifecycleSummary, buildTcConversionMetrics,
  buildCoverageRange, countPossibleDuplicateEvents, countUnmatchedEvaluations,
  countMissingLatency, buildTcIntegrityDiagnostics, buildTelemetryIntegrityDiagnostics,
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

function tcRecord({ symbol = 'BTCUSDT', direction = 'long', decision = 'confirmed', armedAt, episodeId, timeFromArmMin = 5 } = {}) {
  return { symbol, direction, decision, armedAt, episodeId: episodeId ?? null, timeFromArmMin, setupMode: 'trend_continuation', at: armedAt + 60000 };
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

  it('episode conversion - 2 допустими ARMED episode-а, 1 с CONFIRMED -> 50%, не event ratio', () => {
    const armedCreated = [
      lifecycleRecord({ kind: 'armed_created', at: 1100, setupAt: 1000, symbol: 'BTCUSDT' }),
      lifecycleRecord({ kind: 'armed_created', at: 2100, setupAt: 2000, symbol: 'ETHUSDT' }),
    ];
    const entries = [
      tcRecord({ symbol: 'BTCUSDT', armedAt: 1100, decision: 'confirmed' }),
      tcRecord({ symbol: 'BTCUSDT', armedAt: 1100, decision: 'confirmed' }), // повторна evaluation, СЪЩИЯ episode
      tcRecord({ symbol: 'ETHUSDT', armedAt: 2100, decision: 'missed' }),
    ];
    const m = buildTcConversionMetrics([], armedCreated, entries);
    expect(m.episode.eligibleEpisodeCount).toBe(2);
    expect(m.episode.confirmedEpisodeCount).toBe(1);
    expect(m.episode.episodeConfirmedPct).toBe(50);
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
    const entries = [tcRecord({ armedAt: 1000 }), tcRecord({ armedAt: 9999 })]; // 9999 извън прозореца
    expect(countUnmatchedEvaluations(armedCreated, entries)).toBe(1);
  });
});

describe('countMissingLatency() - обяснява "982 от 1026" разликата', () => {
  it('легаси записи без timeFromArmMin не участват в latency bucket-ите', () => {
    const entries = [tcRecord({ timeFromArmMin: 5 }), tcRecord({ timeFromArmMin: null }), tcRecord({ timeFromArmMin: null })];
    expect(countMissingLatency(entries)).toBe(2);
  });
});

describe('buildTcIntegrityDiagnostics() - композитен отговор', () => {
  it('комбинира coverage/duplicate/unmatched/missing-latency/conversion в едно', () => {
    const lifecycle = [
      lifecycleRecord({ kind: 'setup_created', at: 1000 }),
      lifecycleRecord({ kind: 'armed_created', at: 1100, setupAt: 1000 }),
    ];
    const entries = [tcRecord({ armedAt: 1100, timeFromArmMin: 2 })];
    const d = buildTcIntegrityDiagnostics(lifecycle, entries, false, false);
    expect(d.recordsReturned).toBe(2);
    expect(d.recordsAvailable).toBeNull(); // insufficient_data - никога не се измисля
    expect(d.isTruncated).toEqual({ lifecycle: false, entryEvaluation: false });
    expect(d.coverageStart).toBe(1000);
    expect(d.coverageEnd).toBe(1100);
    expect(d.unmatchedEvaluationCount).toBe(0);
    expect(d.missingLatencyCount).toBe(0);
    expect(d.conversionMetrics.unique.uniqueSetupToArmedPct).toBe(100);
    expect(d.aggregationPopulation.lifecycle).toMatch(/trend_continuation ONLY/);
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
