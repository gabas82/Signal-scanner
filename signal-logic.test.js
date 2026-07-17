import { describe, it, expect } from 'vitest';
import {
  calcSMA, calcRSI, detectBottom, detectTop, calcSignal, calcSetupQuality,
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
