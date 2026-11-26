// RELAY TOKEN - coordinated rotation support (2026-11-26). isValidToken е
// чиста, параметризирана проверка (виж коментара в relay/server.js) -
// позволява RELAY_TOKEN_PREV да приема стария token ВРЕМЕННО по време на
// ротация, без прекъсване на услугата. require.main===module guard-ът
// предпазва от реално стартиране на HTTP сървър тук (виж server.js края).
import { describe, it, expect } from 'vitest';
import { isValidToken, buildTicker24hrTarget } from './relay/server.js';

describe('isValidToken', () => {
  it('без конфигуриран token (празен) -> позволява всичко (съществуващо, непроменено поведение)', () => {
    expect(isValidToken('anything', '', '')).toBe(true);
    expect(isValidToken('', '', '')).toBe(true);
  });

  it('точно съвпадение с token -> true', () => {
    expect(isValidToken('secret123', 'secret123', '')).toBe(true);
  });

  it('грешен token, без tokenPrev -> false', () => {
    expect(isValidToken('wrong', 'secret123', '')).toBe(false);
  });

  it('грешен token, но съвпада с tokenPrev -> true (ротационен прозорец)', () => {
    expect(isValidToken('old-secret', 'new-secret', 'old-secret')).toBe(true);
  });

  it('нито token, нито tokenPrev съвпада -> false', () => {
    expect(isValidToken('attacker-guess', 'new-secret', 'old-secret')).toBe(false);
  });

  it('празен tokenPrev не отваря "приема всичко" - само истинско старо-ниво съвпадение минава', () => {
    expect(isValidToken('', 'new-secret', '')).toBe(false);
  });
});

describe('buildTicker24hrTarget (regression guard - непроменено от rotation фикса)', () => {
  it('без symbol -> bulk URL (целия пазар)', () => {
    expect(buildTicker24hrTarget(null)).toBe('https://fapi.binance.com/fapi/v1/ticker/24hr');
  });
  it('със symbol -> per-symbol URL', () => {
    expect(buildTicker24hrTarget('BTCUSDT')).toBe('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT');
  });
});
