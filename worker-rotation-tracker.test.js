// ROTATION TRACKER - следи динамичната dashboard листа (base+gainers+OI+
// trending), различна от фиксирания 35-символен WATCHLIST. Чисто observational
// логика (влизане/излизане/резултат по-късно) - виж бележката в worker.js
// преди diffRotationMembership за пълния контекст.
import { describe, it, expect } from 'vitest';
import {
  rankRotationCandidates, buildPendingRotationHorizons, calcRotationOutcomePct,
  diffRotationMembership, resolvePendingRotationOutcomes, ROTATION_OUTCOME_HORIZONS_MIN,
} from './worker/worker.js';

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
