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
  calcLiqVeto, calcFlowVeto, calcFlowBoost, calcEntryTrigger, buildTelemetryRecord,
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
});

describe('(D) Структурна проверка на wiring-а в РЕАЛНИЯ source (MR + TC ENTRY TRIGGER)', () => {
  it('и двата ENTRY TRIGGER call-сайта (MR, TC) изчисляват liqVeto гейтнато зад liqLiveEnabled', () => {
    const matches = workerSrc.match(/const liqVeto = liqLiveEnabled\s*\n\s*\? calcLiqVeto\(\{[^}]+\}\)\s*\n\s*: false;/g) || [];
    expect(matches).toHaveLength(2); // MR + TC
  });
  it('и двата calcEntryTrigger извиквания подават liqVeto параметъра', () => {
    const matches = [...workerSrc.matchAll(/structRef, flowVeto, flowBoost, htfAligned, liqVeto,/g)];
    expect(matches).toHaveLength(2);
  });
  it('и двата buildTelemetryRecord извиквания подават vetoSource от съответния entryResult/trendEntryResult', () => {
    expect(workerSrc).toContain('vetoSource: entryResult.vetoSource,');
    expect(workerSrc).toContain('vetoSource: trendEntryResult.vetoSource,');
  });
});
