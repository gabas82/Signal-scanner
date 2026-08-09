import { describe, it, expect } from 'vitest';
import {
  calcSMA, calcRSI, detectBottom, detectTop, calcSignal, calcSetupQuality,
  calcLiquidityBias, calcWallBias, calcAltRadarScore, calcAltRadarSignal,
  calcRSISeries, calcEMASeries, calcFlushSignal, calcBaseSignal, calcBaseDivergenceStrength, calcSqueezeSignal, calcShiftSignal, calcImpulseSignal,
  calcBlowoffSignal, calcDistributionSignal, calcDumpSqueezeSignal, calcShiftDownSignal,
  calcATR, calcTrueRangeSeries, calcWarmingTier, calc4HBigVolume, calcDumpCascade,
  calcVolumePressure, calcWarmingContext, calcEntryImpulse, calcMMx25Entry,
  calcSmoothedATR, calcBuildUpEarly, calcEmaTrendFilter, calc4hTwoBarTrend, calcATRExpansion,
  calcMMOscValue, calcMMOscEntry, calcMMOscPullbackZone,
  calcImpulseAtrSignal, calcConfirmedSignal,
  isManipulable, formatNum, formatPrice, formatOIDelta, fixSymbol,
  getMaintenanceRate, calcLiquidationPrice, calcDCALevels,
  MAINTENANCE_RATE_MAJOR, MAINTENANCE_RATE_SEMI, MAINTENANCE_RATE_MINOR,
  DCA_ENTRY, DCA_LEVERAGE
} from './signal-logic.js';

function baseCoin(overrides = {}) {
  return {
    symbol: 'TEST', fullSymbol: 'TESTUSDT', price: 100, chg24: 0, vol24: 0,
    funding: 0, longPct: 50, shortPct: 50, oi: 0, oiDelta: 0, oiFlip: null,
    volSpike: false, isTrending: false, pctFromAth: null, pctFromAtl: null,
    ath: null, atl: null, marketCap: null, goldenCross: null, vol1h: null,
    vol4h: null, valid: true,
    ...overrides
  };
}

describe('calcSMA', () => {
  it('връща null, ако няма достатъчно данни', () => {
    expect(calcSMA([1, 2], 5)).toBeNull();
  });
  it('изчислява проста средна за последните N стойности', () => {
    expect(calcSMA([1, 2, 3, 4, 5], 3)).toBeCloseTo(4); // (3+4+5)/3
  });
});

describe('calcRSI', () => {
  it('връща null при недостатъчно свещи', () => {
    expect(calcRSI([1, 2, 3], 5)).toBeNull();
  });
  it('връща 100 при само печалби (нулеви загуби)', () => {
    const closes = [1, 2, 3, 4, 5, 6];
    expect(calcRSI(closes, 5)).toBe(100);
  });
  it('връща 0 при само загуби (нулеви печалби)', () => {
    const closes = [6, 5, 4, 3, 2, 1];
    expect(calcRSI(closes, 5)).toBe(0);
  });
  it('връща стойност между 0 и 100 при смесени движения', () => {
    const closes = [10, 12, 11, 13, 12, 14];
    const rsi = calcRSI(closes, 5);
    expect(rsi).toBeGreaterThan(0);
    expect(rsi).toBeLessThan(100);
  });
});

describe('detectBottom', () => {
  it('връща false за неутрална монета без сигнали за дъно', () => {
    expect(detectBottom(baseCoin())).toBe(false);
  });
  it('връща true, когато поне 3 условия са изпълнени (напр. близо до ATL)', () => {
    const coin = baseCoin({ funding: 0.01, oiDelta: 2, pctFromAtl: 50 });
    // funding<0.03 (+1), oiDelta>1 (+1), pctFromAtl<100 (+2) = 4 точки >= 3
    expect(detectBottom(coin)).toBe(true);
  });
  it('връща false точно под прага (score=2)', () => {
    const coin = baseCoin({ funding: 0.01, oiDelta: 2 }); // само +1 +1 = 2
    expect(detectBottom(coin)).toBe(false);
  });
});

describe('detectTop', () => {
  it('връща false за неутрална монета', () => {
    expect(detectTop(baseCoin())).toBe(false);
  });
  it('връща true при висок funding + висок longPct (>=4 точки)', () => {
    const coin = baseCoin({ funding: 0.1, longPct: 75 });
    // funding>0.08 (+2), longPct>70 (+2) = 4
    expect(detectTop(coin)).toBe(true);
  });
  it('връща false точно под прага (score=3)', () => {
    const coin = baseCoin({ funding: 0.1, oiDelta: -2 }); // +2 +1 = 3
    expect(detectTop(coin)).toBe(false);
  });
});

describe('calcSignal', () => {
  it('връща SQUEEZE при висок funding и near-50/50 long/short', () => {
    const coin = baseCoin({ funding: 0.07, longPct: 52 });
    expect(calcSignal(coin).signal).toBe('SQUEEZE');
  });
  it('връща LONG при силно движение нагоре + бичи позициониране', () => {
    const coin = baseCoin({ chg24: 12, longPct: 66, funding: -0.02 });
    expect(calcSignal(coin).signal).toBe('LONG');
  });
  it('връща SHORT при силно движение надолу + мечи позициониране', () => {
    const coin = baseCoin({ chg24: -12, shortPct: 66, longPct: 34, funding: 0.09 });
    expect(calcSignal(coin).signal).toBe('SHORT');
  });
  it('връща NEUTRAL, когато нищо не е изразено', () => {
    expect(calcSignal(baseCoin()).signal).toBe('NEUTRAL');
  });
  it('coin.liqBias="long" добавя точка към ls, без да променя ss', () => {
    const without = calcSignal(baseCoin({ chg24: 3 }));
    const withBias = calcSignal(baseCoin({ chg24: 3, liqBias: 'long' }));
    expect(withBias.ls).toBe(without.ls + 1);
    expect(withBias.ss).toBe(without.ss);
  });
  it('coin.liqBias="short" добавя точка към ss, без да променя ls', () => {
    const without = calcSignal(baseCoin({ chg24: -3 }));
    const withBias = calcSignal(baseCoin({ chg24: -3, liqBias: 'short' }));
    expect(withBias.ss).toBe(without.ss + 1);
    expect(withBias.ls).toBe(without.ls);
  });
  it('coin.liqBias="neutral" (или липсващ) не променя резултата', () => {
    const without = calcSignal(baseCoin({ chg24: 3 }));
    const neutral = calcSignal(baseCoin({ chg24: 3, liqBias: 'neutral' }));
    expect(neutral).toEqual(without);
  });
});

describe('calcSetupQuality', () => {
  it('връща grade "none", когато няма изразени точки', () => {
    expect(calcSetupQuality(baseCoin()).grade).toBe('none');
  });
  it('връща grade "setup", когато се съберат >=4 точки за една посока', () => {
    const coin = baseCoin({
      funding: -0.02, longPct: 40, oiDelta: 3, chg24: 12, goldenCross: true
    });
    const sq = calcSetupQuality(coin);
    expect(sq.grade).toBe('setup');
    expect(sq.side).toBe('long');
  });
  it('coin.liqBias="long" добавя директна точка към дългата страна (когато сигналът вече е LONG независимо от uклона)', () => {
    // chg24:12 сам по себе си вече дава сигнал LONG (ls>=3), затова liqBias тук
    // добавя само своята директна точка в calcSetupQuality, без да променя sig.signal.
    const without = calcSetupQuality(baseCoin({ funding: -0.02, longPct: 40, oiDelta: 3, chg24: 12 }));
    const withBias = calcSetupQuality(baseCoin({ funding: -0.02, longPct: 40, oiDelta: 3, chg24: 12, liqBias: 'long' }));
    expect(withBias.pts).toBe(without.pts + 1);
    expect(withBias.side).toBe('long');
  });
  it('coin.liqBias="short" добавя директна точка към късата страна (когато сигналът вече е SHORT независимо от uклона)', () => {
    const without = calcSetupQuality(baseCoin({ funding: 0.1, longPct: 75, chg24: -12 }));
    const withBias = calcSetupQuality(baseCoin({ funding: 0.1, longPct: 75, chg24: -12, liqBias: 'short' }));
    expect(withBias.pts).toBe(without.pts + 1);
    expect(withBias.side).toBe('short');
  });
  it('coin.liqBias="neutral" (или липсващ) не добавя точки', () => {
    const base = calcSetupQuality(baseCoin({ funding: -0.02, longPct: 40, chg24: 12 }));
    const neutral = calcSetupQuality(baseCoin({ funding: -0.02, longPct: 40, chg24: 12, liqBias: 'neutral' }));
    expect(neutral.pts).toBe(base.pts);
  });
  it('coin.liqBias може да допринесе двойно, ако сам обръща и calcSignal посоката (директна точка + sig.signal LONG)', () => {
    // funding<-0.01 сам дава само ls=1 (сигнал остава NEUTRAL); liqBias="long" го качва
    // на ls=2 (сигнал вече LONG) - т.е. добавя и директната си точка, и точката за sig.signal==='LONG'.
    const without = calcSetupQuality(baseCoin({ funding: -0.02 }));
    const withBias = calcSetupQuality(baseCoin({ funding: -0.02, liqBias: 'long' }));
    expect(withBias.pts).toBe(without.pts + 2);
  });
});

describe('calcLiquidityBias', () => {
  it('връща neutral, когато няма никакви ликвидационни данни', () => {
    expect(calcLiquidityBias([], [], 100).bias).toBe('neutral');
    expect(calcLiquidityBias(null, null, 100).bias).toBe('neutral');
  });
  it('връща "long", когато над цената има доминираща и близка ликвидационна зона', () => {
    const above = [{ price: 104, amount: 1000000 }];
    const below = [{ price: 90, amount: 100000 }];
    expect(calcLiquidityBias(above, below, 100).bias).toBe('long');
  });
  it('връща "short", когато под цената има доминираща и близка ликвидационна зона', () => {
    const above = [{ price: 110, amount: 100000 }];
    const below = [{ price: 97, amount: 1000000 }];
    expect(calcLiquidityBias(above, below, 100).bias).toBe('short');
  });
  it('връща neutral, ако доминиращата зона е твърде далеч от цената (>8%)', () => {
    const above = [{ price: 115, amount: 1000000 }]; // 15% над цената
    const below = [{ price: 90, amount: 100000 }];
    expect(calcLiquidityBias(above, below, 100).bias).toBe('neutral');
  });
  it('връща neutral, когато двете страни са сравними по големина (без ясна доминация)', () => {
    const above = [{ price: 103, amount: 100000 }];
    const below = [{ price: 97, amount: 90000 }];
    expect(calcLiquidityBias(above, below, 100).bias).toBe('neutral');
  });
});

describe('calcWallBias', () => {
  it('връща neutral, когато няма никакви стени', () => {
    expect(calcWallBias(null, null, 100).bias).toBe('neutral');
  });
  it('връща "long", когато Buy Wall (подкрепа) доминира и е близо под цената', () => {
    const buyWall = { price: 96, usd: 1000000 };
    const sellWall = { price: 110, usd: 100000 };
    expect(calcWallBias(buyWall, sellWall, 100).bias).toBe('long');
  });
  it('връща "short", когато Sell Wall (съпротива) доминира и е близо над цената', () => {
    const buyWall = { price: 90, usd: 100000 };
    const sellWall = { price: 103, usd: 1000000 };
    expect(calcWallBias(buyWall, sellWall, 100).bias).toBe('short');
  });
  it('връща neutral, ако доминиращата стена е твърде далеч от цената (>8%)', () => {
    const buyWall = { price: 85, usd: 1000000 }; // 15% под цената
    const sellWall = { price: 110, usd: 100000 };
    expect(calcWallBias(buyWall, sellWall, 100).bias).toBe('neutral');
  });
  it('връща neutral, когато двете стени са сравними по големина (без ясна доминация)', () => {
    const buyWall = { price: 97, usd: 100000 };
    const sellWall = { price: 103, usd: 90000 };
    expect(calcWallBias(buyWall, sellWall, 100).bias).toBe('neutral');
  });
  it('работи и с една-единствена стена (другата липсва)', () => {
    const buyWall = { price: 98, usd: 500000 };
    expect(calcWallBias(buyWall, null, 100).bias).toBe('long');
  });
});

describe('isManipulable', () => {
  it('връща true при нисък обем', () => {
    expect(isManipulable(baseCoin({ vol24: 1000, oi: 10000000 }))).toBe(true);
  });
  it('връща true при нисък OI', () => {
    expect(isManipulable(baseCoin({ vol24: 100000000, oi: 1000 }))).toBe(true);
  });
  it('връща false при достатъчен обем и OI', () => {
    expect(isManipulable(baseCoin({ vol24: 100000000, oi: 10000000 }))).toBe(false);
  });
});

describe('formatNum', () => {
  it('форматира милиарди с B', () => expect(formatNum(2.5e9)).toBe('2.50B'));
  it('форматира милиони с M', () => expect(formatNum(3.4e6)).toBe('3.4M'));
  it('форматира хиляди с K', () => expect(formatNum(1500)).toBe('1.5K'));
  it('форматира малки числа directno', () => expect(formatNum(42)).toBe('42.00'));
  it('връща -- за null/undefined', () => {
    expect(formatNum(null)).toBe('--');
    expect(formatNum(undefined)).toBe('--');
  });
  it('третира 0 като валидна стойност, не като липсваща (null-check изключва само null/undefined)', () => expect(formatNum(0)).toBe('0.00'));
});

describe('formatPrice', () => {
  it('връща -- при 0/null', () => expect(formatPrice(0)).toBe('--'));
  it('закръглява цени >=10000 без десетични', () => expect(formatPrice(65000)).toBe('65,000'));
  it('закръглява цени >=1000 до 1 десетична', () => expect(formatPrice(1234.567)).toBe('1,234.6'));
  it('показва 4 десетични за цени >=1', () => expect(formatPrice(3.14159)).toBe('3.1416'));
  it('показва 6 десетични за цени <1', () => expect(formatPrice(0.0001234)).toBe('0.000123'));
});

describe('formatOIDelta', () => {
  it('връща -- при 0/null', () => expect(formatOIDelta(0)).toContain('--'));
  it('показва ▲ при положителна делта', () => expect(formatOIDelta(2.5)).toContain('▲2.50%'));
  it('показва ▼ при отрицателна делта', () => expect(formatOIDelta(-3.1)).toContain('▼3.10%'));
});

describe('fixSymbol', () => {
  it('прилага SYMBOL_MAP override (MATIC -> POL)', () => expect(fixSymbol('MATIC')).toBe('POLUSDT'));
  it('добавя USDT за немапнати символи', () => expect(fixSymbol('BTC')).toBe('BTCUSDT'));
});

describe('getMaintenanceRate', () => {
  it('връща MAJOR rate за мейджър монета', () => expect(getMaintenanceRate('BTC')).toBe(MAINTENANCE_RATE_MAJOR));
  it('връща SEMI rate за полу-мейджър монета', () => expect(getMaintenanceRate('ADA')).toBe(MAINTENANCE_RATE_SEMI));
  it('връща MINOR rate за всичко останало', () => expect(getMaintenanceRate('SOMEMEME')).toBe(MAINTENANCE_RATE_MINOR));
});

describe('calcLiquidationPrice', () => {
  it('ликвидацията за LONG е под средната цена', () => {
    const liq = calcLiquidationPrice(100, 100, 10, 3, 'long', MAINTENANCE_RATE_MAJOR);
    expect(liq).toBeLessThan(100);
    expect(liq).toBeCloseTo(100 * (1 - 1/3 + MAINTENANCE_RATE_MAJOR));
  });
  it('ликвидацията за SHORT е над средната цена', () => {
    const liq = calcLiquidationPrice(100, 100, 10, 3, 'short', MAINTENANCE_RATE_MAJOR);
    expect(liq).toBeGreaterThan(100);
    expect(liq).toBeCloseTo(100 * (1 + 1/3 - MAINTENANCE_RATE_MAJOR));
  });
});

describe('calcDCALevels', () => {
  it('връща 4 стъпки (вход + DCA1 + DCA2 + DCA3)', () => {
    const steps = calcDCALevels(100, 'long', 'BTC');
    expect(steps).toHaveLength(4);
    expect(steps[0].label).toBe('ВХОД');
    expect(steps[0].totalUSDT).toBe(DCA_ENTRY);
  });
  it('за LONG всяко следващо ниво е под входната цена', () => {
    const steps = calcDCALevels(100, 'long', 'BTC');
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].levelPrice).toBeLessThan(100);
    }
  });
  it('за SHORT всяко следващо ниво е над входната цена', () => {
    const steps = calcDCALevels(100, 'short', 'BTC');
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].levelPrice).toBeGreaterThan(100);
    }
  });
  it('общата вложена сума расте монотонно през стъпките', () => {
    const steps = calcDCALevels(100, 'long', 'ETH');
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].totalUSDT).toBeGreaterThan(steps[i - 1].totalUSDT);
    }
  });
  it('крайната обща сума спазва фиксираната DCA прогресия ($10+$20+$40+$80=$150)', () => {
    const steps = calcDCALevels(50000, 'long', 'BTC');
    expect(steps[steps.length - 1].totalUSDT).toBe(DCA_ENTRY + DCA_ENTRY*2 + DCA_ENTRY*4 + DCA_ENTRY*8);
  });
  it('ликвидационната цена за минорна монета е по-консервативна (по-близо до входа) от мейджър при същите нива', () => {
    const majorSteps = calcDCALevels(100, 'long', 'BTC');
    const minorSteps = calcDCALevels(100, 'long', 'SOMEMEME');
    // По-висок maintenance rate при minor -> по-висока (по-близка до входа) ликвидационна цена за LONG
    expect(minorSteps[0].liqPrice).toBeGreaterThan(majorSteps[0].liqPrice);
  });
});

describe('calcAltRadarScore', () => {
  it('връща 0, когато нито едно условие не е изпълнено (или няма SMA история)', () => {
    expect(calcAltRadarScore(55, 100, 50, 1, null, null, null, null)).toBe(0);
  });
  it('брои btc_d<sma условието (BTC доминансът пада)', () => {
    expect(calcAltRadarScore(54, 100, 50, 1, 55, null, null, null)).toBe(1);
    expect(calcAltRadarScore(56, 100, 50, 1, 55, null, null, null)).toBe(0);
  });
  it('брои total3>sma условието (ALT пазарна капитализация расте)', () => {
    expect(calcAltRadarScore(55, 105, 50, 1, null, 100, null, null)).toBe(1);
    expect(calcAltRadarScore(55, 95, 50, 1, null, 100, null, null)).toBe(0);
  });
  it('брои всичките 4 условия, когато всички са изпълнени', () => {
    expect(calcAltRadarScore(54, 105, 55, 1.1, 55, 100, 50, 1)).toBe(4);
  });
});

describe('calcAltRadarSignal', () => {
  it('връща "none" при резултат под прага за pressure', () => {
    expect(calcAltRadarSignal(1, 2, 3, 4)).toBe('none');
    expect(calcAltRadarSignal(0)).toBe('none');
  });
  it('връща "pressure" при резултат >= pressureMin, но < expansionMin', () => {
    expect(calcAltRadarSignal(2, 2, 3, 4)).toBe('pressure');
  });
  it('връща "expansion" при резултат >= expansionMin, но < seasonMin', () => {
    expect(calcAltRadarSignal(3, 2, 3, 4)).toBe('expansion');
  });
  it('връща "season" при резултат >= seasonMin', () => {
    expect(calcAltRadarSignal(4, 2, 3, 4)).toBe('season');
  });
  it('ползва подразбиращи се прагове 2/3/4, ако не са подадени', () => {
    expect(calcAltRadarSignal(4)).toBe('season');
    expect(calcAltRadarSignal(2)).toBe('pressure');
  });
});

describe('calcRSISeries', () => {
  it('връща null преди период и съвпада с calcRSI на всяка валидна позиция', () => {
    const closes = [10, 11, 12, 11, 13, 14, 12, 15, 16, 14];
    const series = calcRSISeries(closes, 5);
    expect(series[0]).toBeNull();
    expect(series[4]).toBeNull();
    for (let i = 5; i < closes.length; i++) {
      expect(series[i]).toBeCloseTo(calcRSI(closes.slice(0, i + 1), 5));
    }
  });
});

describe('calcEMASeries', () => {
  it('връща масив от null-ове, ако няма достатъчно данни', () => {
    expect(calcEMASeries([1, 2], 5)).toEqual([null, null]);
  });
  it('първата стойност е SMA на първите `period` затваряния', () => {
    const closes = [10, 20, 30, 40, 50, 60];
    const series = calcEMASeries(closes, 3);
    expect(series[2]).toBeCloseTo((10 + 20 + 30) / 3);
  });
  it('следва рекурсивната EMA формула за следващата позиция', () => {
    const closes = [10, 20, 30, 40];
    const series = calcEMASeries(closes, 3);
    const k = 2 / 4;
    const expected = 40 * k + series[2] * (1 - k);
    expect(series[3]).toBeCloseTo(expected);
  });
});

function buildDecliningCandles(n, startPrice = 200, step = 2) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const open = price, close = price - step;
    candles.push({ open, high: open + 0.1, low: close - 0.1, close, volume: 1000 });
    price = close;
  }
  return candles;
}
function buildRisingCandles(n, startPrice = 10, step = 2) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const open = price, close = price + step;
    candles.push({ open, high: close + 0.1, low: open - 0.1, close, volume: 1000 });
    price = close;
  }
  return candles;
}

describe('calcFlushSignal', () => {
  it('връща true при екстремно ниска RSI + вол spike + range spike + мечка свещ + HTF oversold', () => {
    const candles = buildDecliningCandles(25);
    const last = candles[candles.length - 1];
    const originalClose = last.close;
    last.high = last.open + 0.1;
    last.low = originalClose - 50;
    last.close = last.low + 1;
    last.volume = 100000;
    expect(calcFlushSignal(candles, true)).toBe(true);
  });
  it('връща false, ако HTF филтърът не е в oversold', () => {
    const candles = buildDecliningCandles(25);
    const last = candles[candles.length - 1];
    const originalClose = last.close;
    last.high = last.open + 0.1;
    last.low = originalClose - 50;
    last.close = last.low + 1;
    last.volume = 100000;
    expect(calcFlushSignal(candles, false)).toBe(false);
  });
  it('връща false, ако не е свещ с достатъчно нисък RSI (възходящ пазар)', () => {
    const candles = buildRisingCandles(25);
    const last = candles[candles.length - 1];
    last.volume = 100000;
    last.high = last.close + 50;
    expect(calcFlushSignal(candles, true)).toBe(false);
  });
  it('връща false при недостатъчно свещи', () => {
    expect(calcFlushSignal(buildDecliningCandles(5), true)).toBe(false);
  });
});

describe('calcBaseDivergenceStrength', () => {
  function candlesWithLows(lowAt15, lowAt25) {
    return Array.from({ length: 26 }, (_, i) => {
      const low = i === 15 ? lowAt15 : i === 25 ? lowAt25 : 100;
      return { open: 100, high: 100.5, low, close: 100 };
    });
  }
  // V-образни closes: спад до дъно на индекс 13, после възход - RSI на индекс25 >> RSI на индекс15.
  function candlesVShapeCloses() {
    return Array.from({ length: 26 }, (_, i) => {
      const close = i <= 13 ? 100 - i : 87 + (i - 13);
      return { open: close, high: close + 0.5, low: close - 0.5, close };
    });
  }
  it('връща нулев score при недостатъчно свещи', () => {
    expect(calcBaseDivergenceStrength([{ open: 1, high: 1, low: 1, close: 1 }])).toEqual({ score: 0, priceDropPct: 0, rsiGain: 0 });
  });
  it('по-голям спад на нисколто дава по-голям priceDropPct', () => {
    const big = calcBaseDivergenceStrength(candlesWithLows(100, 80));
    const small = calcBaseDivergenceStrength(candlesWithLows(100, 95));
    expect(big.priceDropPct).toBeCloseTo(20);
    expect(small.priceDropPct).toBeCloseTo(5);
    expect(big.score).toBeGreaterThan(small.score);
  });
  it('връща priceDropPct:0, ако последното ниско НЕ е по-ниско от предходното (без дивергенция)', () => {
    const r = calcBaseDivergenceStrength(candlesWithLows(80, 100));
    expect(r.priceDropPct).toBe(0);
  });
  it('улавя растящ RSI въпреки по-ниските нива на цената (скрита bullish дивергенция)', () => {
    const r = calcBaseDivergenceStrength(candlesVShapeCloses());
    expect(r.rsiGain).toBeGreaterThan(50);
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('calcSqueezeSignal', () => {
  it('връща true при бичи свещ + вол spike + RSI>40', () => {
    const candles = buildRisingCandles(25);
    const last = candles[candles.length - 1];
    last.volume = 100000; // голям spike
    expect(calcSqueezeSignal(candles)).toBe(true);
  });
  it('връща false без вол spike', () => {
    const candles = buildRisingCandles(25);
    expect(calcSqueezeSignal(candles)).toBe(false);
  });
  it('връща false при мечка свещ', () => {
    const candles = buildDecliningCandles(25);
    const last = candles[candles.length - 1];
    last.volume = 100000;
    expect(calcSqueezeSignal(candles)).toBe(false);
  });
});

describe('calcShiftSignal', () => {
  it('връща true при EMA crossover нагоре + RSI>45', () => {
    // Плоска база (fast EMA == slow EMA), после точно 1 свещ нагоре - fast EMA
    // реагира по-бързо и се качва над slow EMA точно на последната свещ (fresh crossover).
    const flat = Array.from({ length: 55 }, () => ({ open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
    const candles = [...flat, { open: 100, high: 105.5, low: 99.5, close: 105, volume: 1000 }];
    expect(calcShiftSignal(candles)).toBe(true);
  });
  it('връща false без EMA crossover (плосък пазар)', () => {
    const flat = Array.from({ length: 60 }, () => ({ open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
    expect(calcShiftSignal(flat)).toBe(false);
  });
});

describe('calcImpulseSignal', () => {
  it('връща long:true при компресия + вол build-up + пробив нагоре', () => {
    const base = Array.from({ length: 22 }, () => ({ open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
    const tight = { open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 };
    const breakout = { open: 100, high: 110, low: 99.9, close: 109, volume: 5000 };
    const candles = [...base, tight, breakout];
    const result = calcImpulseSignal(candles, false);
    expect(result.long).toBe(true);
    expect(result.short).toBe(false);
  });
  it('връща short:true при компресия + вол build-up + пробив надолу', () => {
    const base = Array.from({ length: 22 }, () => ({ open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
    const tight = { open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 };
    const breakout = { open: 100, high: 100.1, low: 90, close: 91, volume: 5000 };
    const candles = [...base, tight, breakout];
    const result = calcImpulseSignal(candles, false);
    expect(result.short).toBe(true);
    expect(result.long).toBe(false);
  });
  it('потиска се, ако flushActive=true', () => {
    const base = Array.from({ length: 22 }, () => ({ open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
    const tight = { open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 };
    const breakout = { open: 100, high: 110, low: 99.9, close: 109, volume: 5000 };
    const candles = [...base, tight, breakout];
    const result = calcImpulseSignal(candles, true);
    expect(result.long).toBe(false);
    expect(result.short).toBe(false);
  });
  it('връща {long:false,short:false} при недостатъчно свещи', () => {
    expect(calcImpulseSignal([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }], false)).toEqual({ long: false, short: false });
  });
});

describe('calcTrueRangeSeries', () => {
  it('първата свещ използва само high-low', () => {
    expect(calcTrueRangeSeries([{ open: 100, high: 105, low: 95, close: 100 }])).toEqual([10]);
  });
  it('улавя гап извън диапазона на текущата свещ (по-голям от high-low)', () => {
    const candles = [
      { open: 100, high: 100, low: 100, close: 100 },
      { open: 96, high: 99, low: 95, close: 96 }, // gap надолу: |95-100|=5 > (99-95)=4
    ];
    expect(calcTrueRangeSeries(candles)[1]).toBeCloseTo(5);
  });
});

describe('calcATR', () => {
  it('връща null при недостатъчно свещи', () => {
    expect(calcATR([{ open: 1, high: 2, low: 1, close: 1.5 }], 5)).toBeNull();
  });
  it('изчислява средния true range за периода', () => {
    const candles = Array.from({ length: 5 }, () => ({ open: 100, high: 102, low: 98, close: 100 }));
    expect(calcATR(candles, 5)).toBeCloseTo(4);
  });
});

describe('calcWarmingTier', () => {
  function baseWithLast(vol, direction) {
    const base = Array.from({ length: 20 }, () => ({ open: 100, high: 100.05, low: 99.95, close: 100, volume: 1000 }));
    const last = direction === 'up'
      ? { open: 99.9, high: 100.15, low: 99.85, close: 100.1, volume: vol }
      : direction === 'down'
      ? { open: 100.1, high: 100.15, low: 99.85, close: 99.9, volume: vol }
      : { open: 100, high: 100.05, low: 99.95, close: 100, volume: vol };
    return [...base, last];
  }
  it('връща tier "none" при нормален обем', () => {
    expect(calcWarmingTier(baseWithLast(1000, 'up')).tier).toBe('none');
  });
  it('връща tier "warm" при ~1.7x обем', () => {
    const r = calcWarmingTier(baseWithLast(1800, 'up'));
    expect(r.tier).toBe('warm');
    expect(r.direction).toBe('up');
  });
  it('връща tier "hot" при ~2.6x обем', () => {
    const r = calcWarmingTier(baseWithLast(2800, 'down'));
    expect(r.tier).toBe('hot');
    expect(r.direction).toBe('down');
  });
  it('връща tier "super" при >=3x обем', () => {
    expect(calcWarmingTier(baseWithLast(10000, 'up')).tier).toBe('super');
  });
  it('връща tier "none", ако диапазонът не е компресиран (ATR% над прага)', () => {
    const base = Array.from({ length: 20 }, () => ({ open: 100, high: 100.05, low: 99.95, close: 100, volume: 1000 }));
    const wideLast = { open: 90, high: 110, low: 85, close: 105, volume: 10000 };
    expect(calcWarmingTier([...base, wideLast]).tier).toBe('none');
  });
  it('easeFactor<1 улеснява прага (Boost Window ефект)', () => {
    const r = calcWarmingTier(baseWithLast(1200, 'up'), { easeFactor: 0.5 });
    expect(r.tier).toBe('hot');
  });
});

describe('calc4HBigVolume', () => {
  function candles4h(lastVol, direction) {
    const base = Array.from({ length: 20 }, () => ({ open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
    const last = direction === 'up'
      ? { open: 100, high: 105, low: 99, close: 104, volume: lastVol }
      : { open: 104, high: 105, low: 99, close: 100, volume: lastVol };
    return [...base, last];
  }
  it('връща active:false при недостатъчно свещи', () => {
    expect(calc4HBigVolume([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }]).active).toBe(false);
  });
  it('връща active:true при обемен spike + посока, независимо от компресия', () => {
    const r = calc4HBigVolume(candles4h(50000, 'up'));
    expect(r.active).toBe(true);
    expect(r.direction).toBe('up');
  });
  it('връща active:false без обемен spike', () => {
    expect(calc4HBigVolume(candles4h(1000, 'up')).active).toBe(false);
  });
});

describe('calcDumpCascade', () => {
  function redCandle(strong) {
    return strong
      ? { open: 100, high: 100.1, low: 90, close: 90.5 }
      : { open: 100, high: 100.1, low: 99, close: 99.5 };
  }
  it('връща active:false при недостатъчно свещи', () => {
    expect(calcDumpCascade([{ open: 1, high: 1, low: 1, close: 1 }]).active).toBe(false);
  });
  it('връща active:true при >=2 силно червени свещи от последните 3', () => {
    const r = calcDumpCascade([redCandle(false), redCandle(true), redCandle(true)]);
    expect(r.active).toBe(true);
    expect(r.redCount).toBe(2);
  });
  it('връща active:false при само 1 силно червена свещ', () => {
    const r = calcDumpCascade([redCandle(false), redCandle(false), redCandle(true)]);
    expect(r.active).toBe(false);
    expect(r.redCount).toBe(1);
  });
});

describe('calcVolumePressure', () => {
  it('връща biasLong при доминиращ обем на зелени свещи', () => {
    const candles = [
      { open: 100, high: 100.2, low: 99.9, close: 100.1, volume: 1000 },
      { open: 100.1, high: 100.3, low: 100, close: 100.2, volume: 1000 },
    ];
    const r = calcVolumePressure(candles, 2);
    expect(r.press).toBeGreaterThan(0);
    expect(r.biasLong).toBe(true);
    expect(r.biasShort).toBe(false);
  });
  it('връща biasShort при доминиращ обем на червени свещи', () => {
    const candles = [
      { open: 100.1, high: 100.2, low: 99.9, close: 100, volume: 1000 },
      { open: 100.2, high: 100.3, low: 100, close: 100.1, volume: 1000 },
    ];
    const r = calcVolumePressure(candles, 2);
    expect(r.biasShort).toBe(true);
    expect(r.biasLong).toBe(false);
  });
  it('връща biasLong:false и biasShort:false при недостатъчно свещи', () => {
    const r = calcVolumePressure([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }], 5);
    expect(r.biasLong).toBe(false);
    expect(r.biasShort).toBe(false);
  });
});

describe('calcWarmingContext', () => {
  function buildCtx(direction) {
    const flat = () => (direction === 'up'
      ? { open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 }
      : { open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 });
    const base = Array.from({ length: 18 }, flat);
    const step = direction === 'up' ? 0.1 : -0.1;
    let px = 100;
    const rising = [1000, 1000, 1200, 1500, 1900, 3000].map((vol) => {
      const open = px, close = px + step;
      px = close;
      const high = Math.max(open, close) + 0.05, low = Math.min(open, close) - 0.05;
      return { open, high, low, close, volume: vol };
    });
    return [...base, ...rising];
  }
  it('връща warming:true и biasLong:true при обемен spike + растящ обем + компресия (up)', () => {
    const r = calcWarmingContext(buildCtx('up'));
    expect(r.warming).toBe(true);
    expect(r.biasLong).toBe(true);
    expect(r.biasShort).toBe(false);
  });
  it('връща warming:true и biasShort:true при аналогичен сетъп надолу', () => {
    const r = calcWarmingContext(buildCtx('down'));
    expect(r.warming).toBe(true);
    expect(r.biasShort).toBe(true);
  });
  it('връща warming:false при недостатъчно свещи', () => {
    expect(calcWarmingContext([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }]).warming).toBe(false);
  });
  it('връща warming:false без обемен spike (плосък обем)', () => {
    const flat = Array.from({ length: 24 }, () => ({ open: 100, high: 100.1, low: 99.9, close: 100.05, volume: 1000 }));
    expect(calcWarmingContext(flat).warming).toBe(false);
  });
  it('връща warming:false ако диапазонът не е компресиран (ATR% над прага)', () => {
    const candles = buildCtx('up');
    candles[candles.length - 1] = { open: 90, high: 115, low: 85, close: 110, volume: 3000 };
    expect(calcWarmingContext(candles).warming).toBe(false);
  });
});

describe('calcEntryImpulse', () => {
  function buildImpulse(direction, lastVol) {
    const flat = () => ({ open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 });
    const base = Array.from({ length: 21 }, flat);
    const last = direction === 'up'
      ? { open: 100, high: 102, low: 99.9, close: 101.8, volume: lastVol }
      : { open: 100, high: 100.1, low: 98, close: 98.2, volume: lastVol };
    return [...base, last];
  }
  it('връща impulseUp:true при обемен spike + голямо тяло + пробив на предходния high', () => {
    const r = calcEntryImpulse(buildImpulse('up', 3000));
    expect(r.impulseUp).toBe(true);
    expect(r.impulseDn).toBe(false);
  });
  it('връща impulseDn:true при аналогичен пробив надолу', () => {
    const r = calcEntryImpulse(buildImpulse('down', 3000));
    expect(r.impulseDn).toBe(true);
  });
  it('връща impulseUp:false без обемен spike', () => {
    expect(calcEntryImpulse(buildImpulse('up', 1000)).impulseUp).toBe(false);
  });
  it('връща impulseUp:false при недостатъчно свещи', () => {
    expect(calcEntryImpulse([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }]).impulseUp).toBe(false);
  });
});

describe('calcMMx25Entry', () => {
  function buildTrend(direction, spike) {
    const n = 21;
    const step = direction === 'up' ? 0.1 : -0.1;
    return Array.from({ length: n }, (_, i) => {
      const close = 100 + i * step;
      const open = 100 + (i - 1) * step;
      const isLast = i === n - 1;
      const range = isLast && spike ? 5 : 0.1;
      const volume = isLast && spike ? 5000 : 1000;
      return { open, high: Math.max(open, close) + range / 2, low: Math.min(open, close) - range / 2, close, volume };
    });
  }
  it('връща long:true при възходящ тренд над EMA без спайк в обема/диапазона', () => {
    const r = calcMMx25Entry(buildTrend('up', false));
    expect(r.long).toBe(true);
    expect(r.short).toBe(false);
  });
  it('връща short:true при низходящ тренд под EMA без спайк', () => {
    const r = calcMMx25Entry(buildTrend('down', false));
    expect(r.short).toBe(true);
  });
  it('връща long:false при анти-спайк проверка неуспешна (екстремен обем/диапазон)', () => {
    expect(calcMMx25Entry(buildTrend('up', true)).long).toBe(false);
  });
  it('връща long:false и short:false при недостатъчно свещи', () => {
    const r = calcMMx25Entry([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    expect(r.long).toBe(false);
    expect(r.short).toBe(false);
  });
});

describe('calcBuildUpEarly', () => {
  function buildCandles(n, direction) {
    const candles = [];
    let px = 100;
    for (let i = 0; i < n; i++) {
      const inEarly = i >= n - 6;
      const open = px;
      let close;
      if (inEarly) close = direction === 'up' ? open + 0.05 : direction === 'down' ? open - 0.05 : open;
      else close = open + (i % 2 === 0 ? 0.02 : -0.02);
      const high = Math.max(open, close) + 0.05, low = Math.min(open, close) - 0.05;
      candles.push({ open, high, low, close, volume: 1000 });
      px = close;
    }
    return candles;
  }
  it('връща long:true при тих build-up нагоре (мнозинство бичи свещи + higher lows + компресия + стабилен обем)', () => {
    const r = calcBuildUpEarly(buildCandles(30, 'up'));
    expect(r.long).toBe(true);
    expect(r.short).toBe(false);
  });
  it('връща short:true при аналогичен build-up надолу', () => {
    const r = calcBuildUpEarly(buildCandles(30, 'down'));
    expect(r.short).toBe(true);
    expect(r.long).toBe(false);
  });
  it('връща long:false, ако обемът на последната свещ е пресъхнал под прага', () => {
    const candles = buildCandles(30, 'up');
    candles[candles.length - 1].volume = 100; // под volStableMult(0.8) * volMA
    expect(calcBuildUpEarly(candles).long).toBe(false);
  });
  it('връща long:false и short:false при недостатъчно свещи', () => {
    const r = calcBuildUpEarly(buildCandles(10, 'up'));
    expect(r.long).toBe(false);
    expect(r.short).toBe(false);
  });
});

describe('calcEmaTrendFilter', () => {
  function buildTrendCloses(n, direction) {
    return Array.from({ length: n }, (_, i) => {
      const close = direction === 'up' ? 100 + i * 0.5 : 100 - i * 0.5;
      return { open: close, high: close + 0.1, low: close - 0.1, close, volume: 1000 };
    });
  }
  it('връща bull:true при възходящ тренд (EMA fast > slow и расте)', () => {
    const r = calcEmaTrendFilter(buildTrendCloses(12, 'up'), { fastLen: 5, slowLen: 10 });
    expect(r.bull).toBe(true);
    expect(r.bear).toBe(false);
  });
  it('връща bear:true при низходящ тренд', () => {
    const r = calcEmaTrendFilter(buildTrendCloses(12, 'down'), { fastLen: 5, slowLen: 10 });
    expect(r.bear).toBe(true);
  });
  it('връща bull:false и bear:false при недостатъчно свещи за slowLen', () => {
    const r = calcEmaTrendFilter(buildTrendCloses(5, 'up'), { fastLen: 5, slowLen: 10 });
    expect(r.bull).toBe(false);
    expect(r.bear).toBe(false);
  });
});

describe('calc4hTwoBarTrend', () => {
  it('връща bull:true при 2 поредни бичи свещи', () => {
    const candles = [
      { open: 99, high: 100.2, low: 98.9, close: 100, volume: 1000 },
      { open: 100, high: 101.2, low: 99.9, close: 101, volume: 1000 },
    ];
    expect(calc4hTwoBarTrend(candles).bull).toBe(true);
  });
  it('връща bull:false и bear:false при смесени свещи', () => {
    const candles = [
      { open: 99, high: 100.2, low: 98.9, close: 100, volume: 1000 },
      { open: 101, high: 101.2, low: 99.9, close: 100.5, volume: 1000 },
    ];
    const r = calc4hTwoBarTrend(candles);
    expect(r.bull).toBe(false);
    expect(r.bear).toBe(false);
  });
  it('връща bull:false и bear:false при под 2 свещи', () => {
    const r = calc4hTwoBarTrend([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    expect(r.bull).toBe(false);
    expect(r.bear).toBe(false);
  });
});

describe('calcATRExpansion', () => {
  it('връща true, ако диапазонът рязко се разширява на последната свещ', () => {
    const base = Array.from({ length: 20 }, () => ({ open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 }));
    const wideLast = { open: 100, high: 103, low: 97, close: 102, volume: 1000 };
    expect(calcATRExpansion([...base, wideLast])).toBe(true);
  });
  it('връща false при постоянен диапазон (без разширяване)', () => {
    const flat = Array.from({ length: 20 }, () => ({ open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 }));
    expect(calcATRExpansion(flat)).toBe(false);
  });
  it('връща false при недостатъчно свещи', () => {
    expect(calcATRExpansion([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }])).toBe(false);
  });
});

describe('calcBlowoffSignal', () => {
  it('връща true при екстремно висока RSI + вол spike + range spike + бичи свещ + HTF overbought', () => {
    const candles = buildRisingCandles(25);
    const last = candles[candles.length - 1];
    const originalClose = last.close;
    last.low = last.open - 0.1;
    last.high = originalClose + 50;
    last.close = last.high - 1;
    last.volume = 100000;
    expect(calcBlowoffSignal(candles, true)).toBe(true);
  });
  it('връща false, ако HTF филтърът не е в overbought', () => {
    const candles = buildRisingCandles(25);
    const last = candles[candles.length - 1];
    const originalClose = last.close;
    last.low = last.open - 0.1;
    last.high = originalClose + 50;
    last.close = last.high - 1;
    last.volume = 100000;
    expect(calcBlowoffSignal(candles, false)).toBe(false);
  });
  it('връща false, ако не е свещ с достатъчно висок RSI (низходящ пазар)', () => {
    const candles = buildDecliningCandles(25);
    const last = candles[candles.length - 1];
    last.volume = 100000;
    last.low = last.close - 50;
    expect(calcBlowoffSignal(candles, true)).toBe(false);
  });
  it('връща false при недостатъчно свещи', () => {
    expect(calcBlowoffSignal(buildRisingCandles(5), true)).toBe(false);
  });
});

describe('calcDistributionSignal', () => {
  function buildDistCandles() {
    const n = 32;
    const closes = [];
    for (let i = 0; i < n; i++) {
      if (i <= 21) closes.push(100 + i);       // силен ръст: 100..121
      else closes.push(121 - (i - 21));         // отдръпване: 121..111 (RSI отслабва)
    }
    const candles = closes.map((close, i) => ({
      open: close, high: 200 + i * 0.3, low: 200 + i * 0.3 - 0.4, close, volume: 1000,
    }));
    candles[n - 1].low = candles[n - 1].high - 0.1; // малък диапазон на последната свещ
    candles[n - 1].volume = 300; // пресъхнал обем
    return candles;
  }
  it('връща true при скрита bearish дивергенция + сух обем + малък диапазон + HTF overbought', () => {
    expect(calcDistributionSignal(buildDistCandles(), true)).toBe(true);
  });
  it('връща false, ако HTF филтърът не е в overbought', () => {
    expect(calcDistributionSignal(buildDistCandles(), false)).toBe(false);
  });
  it('връща false при недостатъчно свещи', () => {
    expect(calcDistributionSignal([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }], true)).toBe(false);
  });
});

describe('calcDumpSqueezeSignal', () => {
  it('връща true при мечка свещ + вол spike + RSI<60', () => {
    const candles = buildDecliningCandles(25);
    const last = candles[candles.length - 1];
    last.volume = 100000;
    expect(calcDumpSqueezeSignal(candles)).toBe(true);
  });
  it('връща false без вол spike', () => {
    const candles = buildDecliningCandles(25);
    expect(calcDumpSqueezeSignal(candles)).toBe(false);
  });
  it('връща false при бичи свещ', () => {
    const candles = buildRisingCandles(25);
    const last = candles[candles.length - 1];
    last.volume = 100000;
    expect(calcDumpSqueezeSignal(candles)).toBe(false);
  });
});

describe('calcShiftDownSignal', () => {
  it('връща true при EMA crossunder надолу + RSI<55', () => {
    const flat = Array.from({ length: 55 }, () => ({ open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
    const candles = [...flat, { open: 100, high: 100.5, low: 94.5, close: 95, volume: 1000 }];
    expect(calcShiftDownSignal(candles)).toBe(true);
  });
  it('връща false без EMA crossunder (плосък пазар)', () => {
    const flat = Array.from({ length: 60 }, () => ({ open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
    expect(calcShiftDownSignal(flat)).toBe(false);
  });
});

describe('calcMMOscValue', () => {
  it('връща ~50 (неутрален) при плосък пазар', () => {
    const flat = Array.from({ length: 55 }, () => ({ open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 }));
    expect(calcMMOscValue(flat)).toBeCloseTo(50, 1);
  });
  it('връща стойност над 50 при силен бичи натиск/моментум', () => {
    const flat = Array.from({ length: 55 }, () => ({ open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 }));
    const breakout = { open: 100, high: 106, low: 99.9, close: 105, volume: 5000 };
    expect(calcMMOscValue([...flat, breakout])).toBeGreaterThan(90);
  });
  it('връща null при недостатъчно свещи', () => {
    expect(calcMMOscValue(Array.from({ length: 10 }, () => ({ open: 1, high: 1, low: 1, close: 1, volume: 1 })))).toBeNull();
  });
});

describe('calcMMOscEntry', () => {
  function buildFlat(n = 55) {
    return Array.from({ length: n }, () => ({ open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 }));
  }
  it('връща long:true при бичи пробив (осцилаторът пресича нагоре прага + EMA режим нагоре + обем/тяло)', () => {
    const breakout = { open: 100, high: 106, low: 99.9, close: 105, volume: 5000 };
    const r = calcMMOscEntry([...buildFlat(), breakout]);
    expect(r.long).toBe(true);
    expect(r.short).toBe(false);
  });
  it('връща short:true при мечи пробив надолу', () => {
    const breakdown = { open: 100, high: 100.1, low: 94, close: 95, volume: 5000 };
    const r = calcMMOscEntry([...buildFlat(), breakdown]);
    expect(r.short).toBe(true);
  });
  it('връща long:false без достатъчен обем/тяло, дори при пресичане на прага', () => {
    const weakBreak = { open: 100, high: 100.3, low: 99.9, close: 100.1, volume: 1000 };
    expect(calcMMOscEntry([...buildFlat(), weakBreak]).long).toBe(false);
  });
  it('връща long:false и short:false при недостатъчно свещи', () => {
    const r = calcMMOscEntry(buildFlat(10));
    expect(r.long).toBe(false);
    expect(r.short).toBe(false);
  });
});

describe('calcMMOscPullbackZone', () => {
  it('връща true за long, ако осцилаторът е в неутралната зона (48-55)', () => {
    expect(calcMMOscPullbackZone(50, 1)).toBe(true);
    expect(calcMMOscPullbackZone(60, 1)).toBe(false);
  });
  it('връща true за short, ако осцилаторът е в огледалната зона (45-52)', () => {
    expect(calcMMOscPullbackZone(50, -1)).toBe(true);
    expect(calcMMOscPullbackZone(40, -1)).toBe(false);
  });
  it('връща false при null стойност', () => {
    expect(calcMMOscPullbackZone(null, 1)).toBe(false);
  });
});

describe('calcImpulseAtrSignal', () => {
  function buildFlat(n, range) {
    return Array.from({ length: n }, () => ({ open: 100, high: 100 + range / 2, low: 100 - range / 2, close: 100, volume: 1000 }));
  }
  it('връща long:true при пробив нагоре със здравословна ATR% волатилност', () => {
    const flat = buildFlat(25, 0.6);
    const breakout = { open: 100, high: 103, low: 99.9, close: 102.5, volume: 3000 };
    const r = calcImpulseAtrSignal([...flat, breakout]);
    expect(r.long).toBe(true);
    expect(r.short).toBe(false);
  });
  it('връща short:true при пробив надолу', () => {
    const flat = buildFlat(25, 0.6);
    const breakdown = { open: 100, high: 100.1, low: 97, close: 97.5, volume: 3000 };
    const r = calcImpulseAtrSignal([...flat, breakdown]);
    expect(r.short).toBe(true);
    expect(r.long).toBe(false);
  });
  it('връща long:false, ако ATR% е под минималния праг (твърде тих пазар)', () => {
    const flat = buildFlat(25, 0.01);
    const quietBreak = { open: 100, high: 101.5, low: 99.9, close: 101.3, volume: 3000 };
    const r = calcImpulseAtrSignal([...flat, quietBreak]);
    expect(r.long).toBe(false);
  });
  it('връща long:false, ако ATR% е над максималния праг (твърде екстремна волатилност)', () => {
    const flat = buildFlat(25, 8);
    const wildBreak = { open: 100, high: 110, low: 99, close: 108, volume: 3000 };
    const r = calcImpulseAtrSignal([...flat, wildBreak]);
    expect(r.long).toBe(false);
  });
  it('връща long:false и short:false при недостатъчно свещи', () => {
    const r = calcImpulseAtrSignal(buildFlat(10, 0.6));
    expect(r.long).toBe(false);
    expect(r.short).toBe(false);
  });
});

describe('calcConfirmedSignal', () => {
  function buildTrendSeries(n, start, step) {
    const candles = [];
    let price = start;
    for (let i = 0; i < n; i++) {
      price += step;
      candles.push({ open: price - step, high: price + 0.3, low: price - step - 0.3, close: price, volume: 1000 });
    }
    return candles;
  }
  function buildBullConfirmed15m() {
    const c15 = buildTrendSeries(60, 100, 0.4);
    let lastClose = c15[c15.length - 1].close;
    for (let i = 0; i < 6; i++) {
      lastClose -= 1.5;
      c15.push({ open: lastClose + 1.5, high: lastClose + 1.6, low: lastClose - 0.3, close: lastClose, volume: 1000 });
    }
    const e20 = calcEMASeries(c15.map(c => c.close), 20);
    const bounceClose = e20[e20.length - 1] + 1;
    c15.push({ open: lastClose, high: bounceClose + 0.3, low: lastClose - 0.1, close: bounceClose, volume: 1500 });
    return c15;
  }
  function buildBearConfirmed15m() {
    const c15 = buildTrendSeries(60, 200, -0.4);
    let lastClose = c15[c15.length - 1].close;
    for (let i = 0; i < 6; i++) {
      lastClose += 1.5;
      c15.push({ open: lastClose - 1.5, high: lastClose + 0.3, low: lastClose - 1.6, close: lastClose, volume: 1000 });
    }
    const e20 = calcEMASeries(c15.map(c => c.close), 20);
    const dumpClose = e20[e20.length - 1] - 1;
    c15.push({ open: lastClose, high: lastClose + 0.1, low: dumpClose - 0.3, close: dumpClose, volume: 1500 });
    return c15;
  }
  it('връща long:true при bullish pullback (15м пресича обратно над EMA20, EMA20>EMA50) + 1ч regime sync bull', () => {
    const c1hBull = buildTrendSeries(70, 100, 0.5);
    const r = calcConfirmedSignal(buildBullConfirmed15m(), c1hBull);
    expect(r.long).toBe(true);
    expect(r.short).toBe(false);
  });
  it('връща short:true при bearish pullback + 1ч regime sync bear', () => {
    const c1hBear = buildTrendSeries(70, 200, -0.5);
    const r = calcConfirmedSignal(buildBearConfirmed15m(), c1hBear);
    expect(r.short).toBe(true);
    expect(r.long).toBe(false);
  });
  it('връща long:false, ако 1ч regime sync не съвпада (15м bullish, 1ч bearish)', () => {
    const c1hBear = buildTrendSeries(70, 200, -0.5);
    const r = calcConfirmedSignal(buildBullConfirmed15m(), c1hBear);
    expect(r.long).toBe(false);
  });
  it('игнорира regime sync-а, ако useHTFRegime:false', () => {
    const c1hBear = buildTrendSeries(70, 200, -0.5);
    const r = calcConfirmedSignal(buildBullConfirmed15m(), c1hBear, { useHTFRegime: false });
    expect(r.long).toBe(true);
  });
  it('връща long:false и short:false при недостатъчно свещи', () => {
    const c1hBull = buildTrendSeries(70, 100, 0.5);
    const r = calcConfirmedSignal(buildBullConfirmed15m().slice(0, 10), c1hBull);
    expect(r.long).toBe(false);
    expect(r.short).toBe(false);
  });
});
