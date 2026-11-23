// BINANCE LIQUIDATION LIVE - ЕТАП 3 (реално влияние върху ENTRY, виж доклада
// "Binance Liquidation Integration"). Тества РЕАЛНИЯ worker.js (директен ESM
// import). За разлика от Етап 1/2 (чисто информативни), тук ENTRY TRIGGER-ът
// реално може да бъде блокиран (veto) от силен Binance CASCADE или GRAVITY
// сигнал в противоположна посока - огледално на съществуващия flowVeto модел.
// Покрива:
// (A) calcLiqVeto - комбинира CASCADE (изисква hasData) и GRAVITY (не изисква
//     per-tick hasData - дълготраен профил) - НИКОГА veto от липсващи данни.
// (B) calcEntryTrigger - liqVeto wiring (самостоятелно, заедно с flowVeto,
//     vetoSource diagnostics), регресия когато liqVeto=false/омиссия.
// (C) buildTelemetryRecord - новото vetoSource поле.
// (D) Структурна проверка на wiring-а в РЕАЛНИЯ source - и MR, и TC ENTRY
//     TRIGGER блоковете изчисляват liqVeto гейтнато зад liqLiveEnabled и го
//     подават на calcEntryTrigger.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import {
  calcLiqVeto, calcLiqVetoDetail, calcFlowVeto, calcFlowBoost, calcEntryTrigger, buildTelemetryRecord,
} from './worker/worker.js';

const workerSrc = fs.readFileSync('./worker/worker.js', 'utf8');

describe('(A) calcLiqVeto - CASCADE + GRAVITY, никога от липсващи данни', () => {
  const bullish = { bullish: true, bearish: false };
  const bearish = { bullish: false, bearish: true };
  const neutral = { bullish: false, bearish: false };

  it('CASCADE против посоката + hasData=true -> veto', () => {
    expect(calcLiqVeto({ direction: 'long', cascade: bearish, hasData: true, gravityDirection: null, gravityTier: 'none' })).toBe(true);
    expect(calcLiqVeto({ direction: 'short', cascade: bullish, hasData: true, gravityDirection: null, gravityTier: 'none' })).toBe(true);
  });
  it('CASCADE против посоката, НО hasData=false -> НЕ veto (никога от липсващи данни)', () => {
    expect(calcLiqVeto({ direction: 'long', cascade: bearish, hasData: false, gravityDirection: null, gravityTier: 'none' })).toBe(false);
  });
  it('CASCADE потвърждава или неутрален -> НЕ veto (само противоречие блокира)', () => {
    expect(calcLiqVeto({ direction: 'long', cascade: bullish, hasData: true, gravityDirection: null, gravityTier: 'none' })).toBe(false);
    expect(calcLiqVeto({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: null, gravityTier: 'none' })).toBe(false);
  });
  it('GRAVITY tier активен (watch/confirmed) + посоката на клъстера е противоположна -> veto, НЕЗАВИСИМО от hasData', () => {
    expect(calcLiqVeto({ direction: 'long', cascade: neutral, hasData: false, gravityDirection: 'short', gravityTier: 'watch' })).toBe(true);
    expect(calcLiqVeto({ direction: 'short', cascade: neutral, hasData: true, gravityDirection: 'long', gravityTier: 'confirmed' })).toBe(true);
  });
  it("GRAVITY tier='none' -> НЕ veto, дори посоката формално да не съвпада", () => {
    expect(calcLiqVeto({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: 'short', gravityTier: 'none' })).toBe(false);
  });
  it('GRAVITY посока същата като ENTRY посоката -> НЕ veto (confirm, не against)', () => {
    expect(calcLiqVeto({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: 'long', gravityTier: 'confirmed' })).toBe(false);
  });
  it('GRAVITY direction=null (няма профил) -> defensive, НЕ veto', () => {
    expect(calcLiqVeto({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: null, gravityTier: 'watch' })).toBe(false);
  });
  it('и двата едновременно против -> veto (OR, не double-count)', () => {
    expect(calcLiqVeto({ direction: 'long', cascade: bearish, hasData: true, gravityDirection: 'short', gravityTier: 'confirmed' })).toBe(true);
  });
  it('нищо не е против -> няма veto', () => {
    expect(calcLiqVeto({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: 'long', gravityTier: 'watch' })).toBe(false);
  });
});

// (A2) СМЕКЧАВАНЕ (12ч LIQ доклад предложение #1, 2026-11-19) - calcLiqVetoDetail
// (не голият calcLiqVeto) - само TREND_CONTINUATION + GRAVITY против в
// по-слабия 'watch' tier (БЕЗ cascadeAgainst) минава (veto:false, softened:true).
// CASCADE остава твърд veto винаги. GRAVITY 'confirmed' tier остава твърд veto.
// MEAN REVERSION (или setupMode изобщо неподаден) - непроменено поведение.
describe('(A2) calcLiqVetoDetail - СМЕКЧАВАНЕ за TREND_CONTINUATION + GRAVITY watch', () => {
  const neutral = { bullish: false, bearish: false };
  const bearish = { bullish: false, bearish: true };

  it("trend_continuation + GRAVITY против в 'watch' tier, БЕЗ cascade -> veto:false, softened:true", () => {
    const r = calcLiqVetoDetail({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: 'short', gravityTier: 'watch', setupMode: 'trend_continuation' });
    expect(r).toEqual({ veto: false, softened: true });
  });
  it("trend_continuation + GRAVITY против в 'confirmed' tier -> остава ТВЪРД veto (само watch се смекчава)", () => {
    const r = calcLiqVetoDetail({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: 'short', gravityTier: 'confirmed', setupMode: 'trend_continuation' });
    expect(r).toEqual({ veto: true, softened: false });
  });
  it('trend_continuation + CASCADE против (hasData=true) + GRAVITY watch против -> остава ТВЪРД veto (cascade печели)', () => {
    const r = calcLiqVetoDetail({ direction: 'long', cascade: bearish, hasData: true, gravityDirection: 'short', gravityTier: 'watch', setupMode: 'trend_continuation' });
    expect(r).toEqual({ veto: true, softened: false });
  });
  it("mean_reversion + GRAVITY против в 'watch' tier -> НЕ се смекчава (доклад предложение #2 - запазено непроменено)", () => {
    const r = calcLiqVetoDetail({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: 'short', gravityTier: 'watch', setupMode: 'mean_reversion' });
    expect(r).toEqual({ veto: true, softened: false });
  });
  it('setupMode неподаден (стари call-сайтове) -> твърд veto, никаква промяна в поведението', () => {
    const r = calcLiqVetoDetail({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: 'short', gravityTier: 'watch' });
    expect(r).toEqual({ veto: true, softened: false });
  });
  it('trend_continuation + GRAVITY watch, НО посоката съвпада (не е against) -> veto:false, softened:false (няма какво да се смекчава)', () => {
    const r = calcLiqVetoDetail({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: 'long', gravityTier: 'watch', setupMode: 'trend_continuation' });
    expect(r).toEqual({ veto: false, softened: false });
  });
  it('calcLiqVeto (голият boolean wrapper) връща точно .veto от calcLiqVetoDetail - включително в softened случая', () => {
    expect(calcLiqVeto({ direction: 'long', cascade: neutral, hasData: true, gravityDirection: 'short', gravityTier: 'watch', setupMode: 'trend_continuation' })).toBe(false);
  });
});

describe('(B) calcEntryTrigger - liqVeto wiring, vetoSource diagnostics', () => {
  const candle5m = { open: 100, close: 97, high: 100.5, low: 96.5 }; // силна bearish свещ
  const atr5m = 1; // range=4 >= 0.5*atr - валидна trigger свещ
  const base = { direction: 'short', candle5m, atr5m, candle15m: null, atr15m: 1, structRef: 96, flowBoost: false, htfAligned: false };

  it('liqVeto=true (flowVeto=false) -> status veto, vetoSource=liq', () => {
    const r = calcEntryTrigger({ ...base, flowVeto: false, liqVeto: true });
    expect(r.status).toBe('veto');
    expect(r.vetoSource).toBe('liq');
  });
  it('flowVeto=true (liqVeto=false) -> status veto, vetoSource=flow (регресия - старото поведение непроменено)', () => {
    const r = calcEntryTrigger({ ...base, flowVeto: true, liqVeto: false });
    expect(r.status).toBe('veto');
    expect(r.vetoSource).toBe('flow');
  });
  it('и двата true -> vetoSource=both', () => {
    const r = calcEntryTrigger({ ...base, flowVeto: true, liqVeto: true });
    expect(r.status).toBe('veto');
    expect(r.vetoSource).toBe('both');
  });
  it('и двата false -> нормално ENTRY (непроменено спрямо преди Етап 3)', () => {
    const r = calcEntryTrigger({ ...base, flowVeto: false, liqVeto: false });
    expect(r.status).toBe('entry');
    expect(r.vetoSource).toBeUndefined();
  });
  it('liqVeto изрично пропуснат (стари call-сайтове/тестове без параметъра) -> default false, никаква промяна', () => {
    const { liqVeto, ...noLiqParam } = base;
    const r = calcEntryTrigger({ ...noLiqParam, flowVeto: false });
    expect(r.status).toBe('entry');
  });
});

describe('(C) buildTelemetryRecord - vetoSource поле', () => {
  const baseArgs = {
    symbol: 'BTCUSDT', direction: 'short', decision: 'veto', setupScore: 3, setupBreakdown: {},
    armedAt: Date.now(), structRef: 90, triggerClose: 88, atr5m: 1, triggerRange: 1,
    confirmation15m: null, flowState: 'neutral', setupMode: 'mean_reversion', htfAligned: null,
  };
  it('не е подадено -> vetoSource null', () => {
    expect(buildTelemetryRecord(baseArgs).vetoSource).toBeNull();
  });
  it("подадено 'liq'/'flow'/'both' -> записва се точно както е подадено", () => {
    for (const v of ['liq', 'flow', 'both']) {
      expect(buildTelemetryRecord({ ...baseArgs, vetoSource: v }).vetoSource).toBe(v);
    }
  });
  it('liqSoftVetoed неподадено -> default false (не undefined/null)', () => {
    expect(buildTelemetryRecord(baseArgs).liqSoftVetoed).toBe(false);
  });
  it("liqSoftVetoed:true -> entryQualityTier принудително 'D' (score непроменен) - доклад предложение #1, 'понижаване на confidence вместо твърд veto'", () => {
    const tcArgs = {
      symbol: 'BTCUSDT', direction: 'long', decision: 'confirmed', setupScore: 3, setupBreakdown: {},
      armedAt: Date.now(), structRef: 90, triggerClose: 90.2, atr5m: 1, triggerRange: 1,
      confirmation15m: null, flowState: 'neutral', setupMode: 'trend_continuation', htfAligned: null,
    };
    const normal = buildTelemetryRecord(tcArgs);
    expect(normal.entryQualityTier).toBe('B'); // sanity - без liqSoftVetoed, нормален tier (не D)
    expect(normal.liqSoftVetoed).toBe(false);
    const softened = buildTelemetryRecord({ ...tcArgs, liqSoftVetoed: true });
    expect(softened.entryQualityTier).toBe('D');
    expect(softened.entryQualityScore).toBe(normal.entryQualityScore);
    expect(softened.liqSoftVetoed).toBe(true);
  });
});

describe('(D) Структурна проверка на wiring-а в РЕАЛНИЯ source (MR + TC ENTRY TRIGGER)', () => {
  it('MR call-сайтът изчислява liqVeto през голия calcLiqVeto (непроменено - доклад предложение #2)', () => {
    const matches = workerSrc.match(/const liqVeto = liqLiveEnabled\s*\n\s*\? calcLiqVeto\(\{[^}]+\}\)\s*\n\s*: false;/g) || [];
    expect(matches).toHaveLength(1); // само MR вече - TC мина на calcLiqVetoDetail
  });
  it('TC call-сайтът изчислява liqVetoDetail през calcLiqVetoDetail със setupMode: trend_continuation (доклад предложение #1 - смекчаване)', () => {
    const matches = workerSrc.match(/const liqVetoDetail = liqLiveEnabled\s*\n\s*\? calcLiqVetoDetail\(\{[^}]*setupMode: 'trend_continuation'[^}]*\}\)\s*\n\s*: \{ veto: false, softened: false \};/g) || [];
    expect(matches).toHaveLength(1);
  });
  it('и двата calcEntryTrigger извиквания подават liqVeto параметъра', () => {
    const matches = [...workerSrc.matchAll(/structRef, flowVeto, flowBoost, htfAligned, liqVeto,/g)];
    expect(matches).toHaveLength(2);
  });
  it('и двата buildTelemetryRecord извиквания подават vetoSource от съответния entryResult/trendEntryResult', () => {
    expect(workerSrc).toContain('vetoSource: entryResult.vetoSource,');
    expect(workerSrc).toContain('vetoSource: trendEntryResult.vetoSource,');
  });
  it('TC buildTelemetryRecord подава liqSoftVetoed от liqVetoDetail.softened (MR НЕ го подава - никога не се смекчава)', () => {
    expect(workerSrc).toContain('liqSoftVetoed: liqVetoDetail.softened,');
  });
  it("LIQ_SOFTENED лог съществува, с отделен needle от LIQ_VETO/LIQ_CONFIRM (без споделен префикс - за да не обърка 12ч анализа)", () => {
    expect(workerSrc).toContain('LIQ_SOFTENED trend_continuation');
    expect(workerSrc).not.toContain('LIQ_VETO_SOFTENED');
    expect(workerSrc).not.toContain('LIQ_CONFIRM_SOFTENED');
  });
  it('LIQ_VETO/LIQ_CONFIRM/LIQ_PASS/LIQ_SOFTENED логовете включват gravityDistancePct/cascadeBuyUsd/cascadeSellUsd - 7 реда общо', () => {
    // MR veto, MR confirm, MR pass, TC veto, TC confirm, TC pass (доклад
    // предложение #3/#4, 2026-11-22 - виж "LIQ_PASS" discussion-а) + TC
    // softened (доклад предложение #6, 2026-11-21).
    const matches = [...workerSrc.matchAll(/gravityDistancePct=\$\{liqGravityScore\.distancePct[^}]*\}.*cascadeBuyUsd=.*cascadeSellUsd=/g)];
    expect(matches).toHaveLength(7);
  });
  it('LIQ_SOFTENED логът конкретно включва cascadeBuyUsd/cascadeSellUsd (доклад предложение #6)', () => {
    expect(workerSrc).toMatch(/LIQ_SOFTENED trend_continuation.*cascadeBuyUsd=.*cascadeSellUsd=/);
  });
  it('всичките 7 LIQ_* needle-а включват price=${price} (доклад предложение #3, 2026-11-22 - futures-only символи без spot история)', () => {
    const matches = [...workerSrc.matchAll(/cascadeSellUsd=\$\{Math\.round\(liquidationCascade\.sellSumUsd \?\? 0\)\} price=\$\{price\}/g)];
    expect(matches).toHaveLength(7);
  });
  it('LIQ_CONFIRM логва САМО при реално потвърждение (liqConfirm === "confirm"), не просто "не е no_data" (доклад предложение #4, 2026-11-22)', () => {
    const matches = [...workerSrc.matchAll(/if \(decision === 'confirmed' && record\.liqConfirm === 'confirm'\) \{/g)];
    expect(matches).toHaveLength(2); // MR + TC
    // Старото, разводняващо условие вече не трябва да съществува никъде.
    expect(workerSrc).not.toContain("record.liqConfirm != null && record.liqConfirm !== 'no_data') {\n        console.log(`LIQ_CONFIRM");
  });
  it('LIQ_PASS съществува като ОТДЕЛЕН needle за "neutral"/"against" CONFIRMED записи (доклад предложение #4, 2026-11-22)', () => {
    expect(workerSrc).toContain('LIQ_PASS mean_reversion');
    expect(workerSrc).toContain('LIQ_PASS trend_continuation');
    const matches = [...workerSrc.matchAll(/if \(decision === 'confirmed' && record\.liqConfirm != null && record\.liqConfirm !== 'no_data' && record\.liqConfirm !== 'confirm'\) \{/g)];
    expect(matches).toHaveLength(2); // MR + TC
  });
});
