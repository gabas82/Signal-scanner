// Извлечена чиста бизнес логика от signal-scanner.html, за да може да се тества
// самостоятелно (Node/Vitest) и същевременно да се ползва непроменена в браузъра
// чрез <script src="signal-logic.js"> (класически script, споделя глобалния scope).

const DCA_LEVERAGE = 3;
const DCA_ENTRY = 10;
// Три нива на maintenance margin tier, доближаващи реалните Binance Futures margin tiers по дълбочина на ликвидност:
// MAJOR (най-дълбок order book) -> SEMI (средна капитализация/ликвидност) -> MINOR (по-малки/волатилни/нишови)
const MAJOR_COINS = new Set(['BTC','ETH','SOL','BNB','XRP','DOGE','LTC']);
const SEMI_MAJOR_COINS = new Set(['ADA','AVAX','LINK','DOT','UNI','ATOM','NEAR','SUI','APT','AAVE','ARB','TON','ETC']);
const MAINTENANCE_RATE_MAJOR = 0.004;
const MAINTENANCE_RATE_SEMI = 0.0065; // полу-мейджъри: по-плитка книга от топ 7, но все пак ликвидни
const MAINTENANCE_RATE_MINOR = 0.01; // по-волатилни/нискокапитализирани монети - по-висок реален margin tier

const SYMBOL_MAP = {'MATIC':'POL','TIAO':'TIA'};
function fixSymbol(s) { return (SYMBOL_MAP[s] || s) + 'USDT'; }

// Пресъздава логиката на потребителски Pine Script индикатор "Mario – ALT Radar
// Symbols" в JS: 4 условия (BTC.D пада / TOTAL3 расте / OTHERS расте / ALT-BTC
// расте спрямо своя 5-дневен SMA), сборувани в резултат 0-4, който определя
// PRESSURE/EXPANSION/SEASON нивото. SMA(null) означава недостатъчно история
// (все още) - условието просто не се брои, вместо да гърми.
//
// Всяко условие изисква отклонението от SMA да е поне stdMult (по подразбиране
// 0.5) стандартни отклонения на същия 5-дневен прозорец - без този праг чист
// пазарен шум (+0.01% над средната) в страничен/"мъртъв" пазар лъжливо
// покриваше и 4-те условия едновременно (реален случай: BTC.D/TOTAL3/OTHERS
// на части от процента над своите SMA, докато пазарът реално не мърда).
// Стандартното отклонение (не фиксиран %) се самонагласява за всеки показател -
// BTC.D се движи в процентни пунктове, TOTAL3/OTHERS в милиарди долари.
function calcAltRadarScore(btcD, total3, others, altBtc, btcDSma, total3Sma, othersSma, altBtcSma, btcDStd, total3Std, othersStd, altBtcStd, opts) {
  const stdMult = opts?.stdMult ?? 0.5;
  let score = 0;
  if (btcDSma != null && btcDStd != null && (btcDSma - btcD) > stdMult * btcDStd) score++;
  if (total3Sma != null && total3Std != null && (total3 - total3Sma) > stdMult * total3Std) score++;
  if (othersSma != null && othersStd != null && (others - othersSma) > stdMult * othersStd) score++;
  if (altBtcSma != null && altBtcStd != null && (altBtc - altBtcSma) > stdMult * altBtcStd) score++;
  return score;
}

function calcAltRadarSignal(score, pressureMin, expansionMin, seasonMin) {
  const pMin = pressureMin ?? 2, eMin = expansionMin ?? 3, sMin = seasonMin ?? 4;
  if (score >= sMin) return 'season';
  if (score >= eMin) return 'expansion';
  if (score >= pMin) return 'pressure';
  return 'none';
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a,b) => a+b, 0) / period;
}

function calcStdDev(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a,b) => a+b, 0) / period;
  const variance = slice.reduce((a,b) => a + (b-mean)*(b-mean), 0) / period;
  return Math.sqrt(variance);
}

// Wilder RMA изглаждане (alpha = 1/period), не обикновена SMA на последните
// `period` разлики - TradingView ta.rsi() ползва точно тази смяна и носи
// напред цялата история с експоненциално затихващо тегло, докато старата
// версия гледаше само последния прозорец без памет отвъд него (реален пример:
// Worker RSI 28.8 vs TradingView RSI 30.3 на един и същ момент). За масив с
// точно period+1 стойности резултатът е идентичен на старата SMA версия
// (само seed стъпката, без допълнително изглаждане) - границите/edge case
// тестовете затова остават непроменени.
function calcRSI(closes, period) {
  const n = closes.length;
  if (n < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// Масив от RSI стойности (същата проста average-gain/average-loss формула като
// calcRSI, за консистентност) - по една на всяка позиция >= period, null преди
// това. Нужен е за сигнали, които сравняват RSI на текущата спрямо по-стари свещи
// (bullish divergence), не само последната стойност.
function calcRSISeries(closes, period) {
  const series = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    series[i] = calcRSI(closes.slice(0, i + 1), period);
  }
  return series;
}

// Масив от EMA стойности (стандартна експоненциална формула, seed-ната със SMA
// на първите `period` затваряния) - нужен за crossover детекция (SHIFT сигнала).
function calcEMASeries(closes, period) {
  if (closes.length < period) return new Array(closes.length).fill(null);
  const series = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  series[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    series[i] = ema;
  }
  return series;
}

// ─── "Mario – Capitulation Suite" (личен Pine Script индикатор на потребителя) ───
// Пресъздава FLUSH/BASE/SQUEEZE/SHIFT/IMPULSE сигналите му в чист JS върху масив
// от свещи {open,high,low,close,volume} (най-стара -> най-нова). "Cooldown"-ът от
// оригинала (не повтаряй сигнал N свещи след предишния) е изпуснат нарочно - тук
// само показваме дали условието е вярно на последната свещ, без anti-spam логика
// за push известия, каквато TradingView алармите имат.

// FLUSH: капитулационен flush - екстремно ниска RSI + вол spike + голям диапазон +
// мечка свещ, филтрирано по HTF (4ч+1д RSI) oversold, за да не хваща шум.
function calcFlushSignal(candles, htfExtreme, opts = {}) {
  const rsiLen = opts.rsiLen ?? 14, rsiFlushLevel = opts.rsiFlushLevel ?? 25;
  const volLen = opts.volLen ?? 20, volFlushMult = opts.volFlushMult ?? 2.5;
  const rangeLen = opts.rangeLen ?? 20, rangeMult = opts.rangeMult ?? 2.0;
  const useHTFFilter = opts.useHTFFilter ?? true;
  const n = candles.length;
  if (n < Math.max(rsiLen, volLen, rangeLen) + 1) return false;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const ranges = candles.map(c => c.high - c.low);
  const rsi = calcRSISeries(closes, rsiLen)[n - 1];
  const volMA = calcSMA(volumes, volLen);
  const rangeMA = calcSMA(ranges, rangeLen);
  if (rsi == null || volMA == null || rangeMA == null) return false;
  const last = candles[n - 1];
  const volSpike = last.volume > volMA * volFlushMult;
  const rangeSpike = (last.high - last.low) > rangeMA * rangeMult;
  const bearCandle = last.close < last.open;
  const htfFilter = useHTFFilter ? htfExtreme : true;
  return rsi < rsiFlushLevel && volSpike && rangeSpike && bearCandle && htfFilter;
}

// BLOWOFF: огледалната версия на FLUSH при връх - екстремно висока RSI + вол spike +
// голям диапазон + бичи свещ, филтрирано по HTF overbought (mirror на FLUSH-ия oversold).
function calcBlowoffSignal(candles, htfOverbought, opts = {}) {
  const rsiLen = opts.rsiLen ?? 14, rsiBlowoffLevel = opts.rsiBlowoffLevel ?? 75;
  const volLen = opts.volLen ?? 20, volFlushMult = opts.volFlushMult ?? 2.5;
  const rangeLen = opts.rangeLen ?? 20, rangeMult = opts.rangeMult ?? 2.0;
  const useHTFFilter = opts.useHTFFilter ?? true;
  const n = candles.length;
  if (n < Math.max(rsiLen, volLen, rangeLen) + 1) return false;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const ranges = candles.map(c => c.high - c.low);
  const rsi = calcRSISeries(closes, rsiLen)[n - 1];
  const volMA = calcSMA(volumes, volLen);
  const rangeMA = calcSMA(ranges, rangeLen);
  if (rsi == null || volMA == null || rangeMA == null) return false;
  const last = candles[n - 1];
  const volSpike = last.volume > volMA * volFlushMult;
  const rangeSpike = (last.high - last.low) > rangeMA * rangeMult;
  const bullCandle = last.close > last.open;
  const htfFilter = useHTFFilter ? htfOverbought : true;
  return rsi > rsiBlowoffLevel && volSpike && rangeSpike && bullCandle && htfFilter;
}

// BASE: скрита bullish дивергенция (цената прави по-ниско дъно, RSI прави по-високо
// дъно) + сух обем + малък диапазон + RSI се възстановява над базовото ниво.
function calcBaseSignal(candles, htfExtreme, opts = {}) {
  const rsiLen = opts.rsiLen ?? 14, rsiBaseLevel = opts.rsiBaseLevel ?? 35;
  const volLen = opts.volLen ?? 20, volDryMult = opts.volDryMult ?? 0.8;
  const rangeLen = opts.rangeLen ?? 20;
  const useHTFFilter = opts.useHTFFilter ?? true;
  const n = candles.length;
  if (n < Math.max(rsiLen, volLen, rangeLen) + 11) return false;
  const closes = candles.map(c => c.close);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const ranges = candles.map(c => c.high - c.low);
  const rsiSeries = calcRSISeries(closes, rsiLen);
  const volMA = calcSMA(volumes, volLen);
  const rangeMA = calcSMA(ranges, rangeLen);
  const rsi = rsiSeries[n - 1], rsi5 = rsiSeries[n - 6], rsi10 = rsiSeries[n - 11];
  if (rsi == null || rsi5 == null || rsi10 == null || volMA == null || rangeMA == null) return false;
  const priceLowerLow = lows[n - 1] < lows[n - 6] && lows[n - 6] < lows[n - 11];
  const rsiHigherLow = rsi > rsi5 && rsi5 > rsi10;
  const bullDiv = priceLowerLow && rsiHigherLow;
  const last = candles[n - 1];
  const volDry = last.volume < volMA * volDryMult;
  const smallRange = (last.high - last.low) < rangeMA;
  const rsiRecover = rsi > rsiBaseLevel;
  const htfFilter = useHTFFilter ? htfExtreme : true;
  return bullDiv && volDry && smallRange && rsiRecover && htfFilter;
}

// Сила на "скритата" bullish дивергенция зад BASE сигнала - колкото по-голяма, толкова
// по-убедителен е моделът "втори, по-нисък под, но с отслабващ низходящ момент" (RSI
// расте докато цената пада). Само за РАНЖИРАНЕ на вече активни BASE монети - не заменя
// самия calcBaseSignal boolean gate.
function calcBaseDivergenceStrength(candles, opts = {}) {
  const rsiLen = opts.rsiLen ?? 14;
  const n = candles.length;
  if (n < rsiLen + 11) return { score: 0, priceDropPct: 0, rsiGain: 0 };
  const closes = candles.map(c => c.close);
  const lows = candles.map(c => c.low);
  const rsiSeries = calcRSISeries(closes, rsiLen);
  const rsi = rsiSeries[n - 1], rsi10 = rsiSeries[n - 11];
  const lowNow = lows[n - 1], lowThen = lows[n - 11];
  if (rsi == null || rsi10 == null || lowThen <= 0) return { score: 0, priceDropPct: 0, rsiGain: 0 };
  const priceDropPct = Math.max(0, (lowThen - lowNow) / lowThen * 100);
  const rsiGain = Math.max(0, rsi - rsi10);
  return { score: priceDropPct + rsiGain, priceDropPct, rsiGain };
}

// DISTRIBUTION: огледалната версия на BASE при връх - скрита bearish дивергенция
// (цената прави по-високо връх, RSI прави по-нисък връх) + сух обем + малък
// диапазон + RSI се отдръпва под "top" нивото + HTF overbought филтър.
function calcDistributionSignal(candles, htfOverbought, opts = {}) {
  const rsiLen = opts.rsiLen ?? 14, rsiTopLevel = opts.rsiTopLevel ?? 65;
  const volLen = opts.volLen ?? 20, volDryMult = opts.volDryMult ?? 0.8;
  const rangeLen = opts.rangeLen ?? 20;
  const useHTFFilter = opts.useHTFFilter ?? true;
  const n = candles.length;
  if (n < Math.max(rsiLen, volLen, rangeLen) + 11) return false;
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const volumes = candles.map(c => c.volume);
  const ranges = candles.map(c => c.high - c.low);
  const rsiSeries = calcRSISeries(closes, rsiLen);
  const volMA = calcSMA(volumes, volLen);
  const rangeMA = calcSMA(ranges, rangeLen);
  const rsi = rsiSeries[n - 1], rsi5 = rsiSeries[n - 6], rsi10 = rsiSeries[n - 11];
  if (rsi == null || rsi5 == null || rsi10 == null || volMA == null || rangeMA == null) return false;
  const priceHigherHigh = highs[n - 1] > highs[n - 6] && highs[n - 6] > highs[n - 11];
  const rsiLowerHigh = rsi < rsi5 && rsi5 < rsi10;
  const bearDiv = priceHigherHigh && rsiLowerHigh;
  const last = candles[n - 1];
  const volDry = last.volume < volMA * volDryMult;
  const smallRange = (last.high - last.low) < rangeMA;
  const rsiRetreat = rsi < rsiTopLevel;
  const htfFilter = useHTFFilter ? htfOverbought : true;
  return bearDiv && volDry && smallRange && rsiRetreat && htfFilter;
}

// SQUEEZE: бичи свещ + вол spike (сама сила като FLUSH прага) + RSI над 40 - типично
// кратък шорт-скуийз изблик.
function calcSqueezeSignal(candles, opts = {}) {
  const rsiLen = opts.rsiLen ?? 14, volLen = opts.volLen ?? 20, volFlushMult = opts.volFlushMult ?? 2.5;
  const n = candles.length;
  if (n < Math.max(rsiLen, volLen) + 1) return false;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const rsi = calcRSISeries(closes, rsiLen)[n - 1];
  const volMA = calcSMA(volumes, volLen);
  if (rsi == null || volMA == null) return false;
  const last = candles[n - 1];
  const bullCandle = last.close > last.open;
  const volSpike = last.volume > volMA * volFlushMult;
  return bullCandle && volSpike && rsi > 40;
}

// DUMP SQUEEZE: огледалната версия на SQUEEZE при връх - мечка свещ + вол spike
// (same сила като SQUEEZE прага) + RSI под 60 - типично кратък "long squeeze"
// изблик надолу (последно влезлите на дълго биват изхвърлени).
function calcDumpSqueezeSignal(candles, opts = {}) {
  const rsiLen = opts.rsiLen ?? 14, volLen = opts.volLen ?? 20, volFlushMult = opts.volFlushMult ?? 2.5;
  const n = candles.length;
  if (n < Math.max(rsiLen, volLen) + 1) return false;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const rsi = calcRSISeries(closes, rsiLen)[n - 1];
  const volMA = calcSMA(volumes, volLen);
  if (rsi == null || volMA == null) return false;
  const last = candles[n - 1];
  const bearCandle = last.close < last.open;
  const volSpike = last.volume > volMA * volFlushMult;
  return bearCandle && volSpike && rsi < 60;
}

// SHIFT: бърз EMA пресича нагоре бавния EMA + RSI над 45 - смяна на тренда нагоре.
function calcShiftSignal(candles, opts = {}) {
  const rsiLen = opts.rsiLen ?? 14, emaFastLen = opts.emaFastLen ?? 20, emaSlowLen = opts.emaSlowLen ?? 50;
  const n = candles.length;
  if (n < emaSlowLen + 1) return false;
  const closes = candles.map(c => c.close);
  const rsi = calcRSISeries(closes, rsiLen)[n - 1];
  const emaFastSeries = calcEMASeries(closes, emaFastLen);
  const emaSlowSeries = calcEMASeries(closes, emaSlowLen);
  const fNow = emaFastSeries[n - 1], fPrev = emaFastSeries[n - 2];
  const sNow = emaSlowSeries[n - 1], sPrev = emaSlowSeries[n - 2];
  if (rsi == null || fNow == null || fPrev == null || sNow == null || sPrev == null) return false;
  const crossover = fPrev <= sPrev && fNow > sNow;
  return crossover && rsi > 45;
}

// SHIFT DOWN: огледалната версия на SHIFT при връх - бърз EMA пресича надолу
// бавния EMA + RSI под 55 - смяна на тренда надолу.
function calcShiftDownSignal(candles, opts = {}) {
  const rsiLen = opts.rsiLen ?? 14, emaFastLen = opts.emaFastLen ?? 20, emaSlowLen = opts.emaSlowLen ?? 50;
  const n = candles.length;
  if (n < emaSlowLen + 1) return false;
  const closes = candles.map(c => c.close);
  const rsi = calcRSISeries(closes, rsiLen)[n - 1];
  const emaFastSeries = calcEMASeries(closes, emaFastLen);
  const emaSlowSeries = calcEMASeries(closes, emaSlowLen);
  const fNow = emaFastSeries[n - 1], fPrev = emaFastSeries[n - 2];
  const sNow = emaSlowSeries[n - 1], sPrev = emaSlowSeries[n - 2];
  if (rsi == null || fNow == null || fPrev == null || sNow == null || sPrev == null) return false;
  const crossunder = fPrev >= sPrev && fNow < sNow;
  return crossunder && rsi < 55;
}

// IMPULSE LONG/SHORT: тясна предходна свещ (компресия) + вол build-up + пробив на
// 10-свещния хай/лоу - ранен импулс в посока на пробива. Потиска се, ако FLUSH вече
// е активен на същата свещ (за да не се двоят сигналите).
function calcImpulseSignal(candles, flushActive, opts = {}) {
  const volLen = opts.volLen ?? 20, volImpulseMult = opts.volImpulseMult ?? 1.8;
  const rangeLen = opts.rangeLen ?? 20;
  const n = candles.length;
  if (n < Math.max(volLen, rangeLen, 10) + 2) return { long: false, short: false };
  const volumes = candles.map(c => c.volume);
  const ranges = candles.map(c => c.high - c.low);
  const volMA = calcSMA(volumes, volLen);
  const rangeMA = calcSMA(ranges, rangeLen);
  if (volMA == null || rangeMA == null) return { long: false, short: false };
  const prev = candles[n - 2], last = candles[n - 1];
  const tightRangePrev = (prev.high - prev.low) < rangeMA * 0.7;
  const volBuild = last.volume > volMA * volImpulseMult;
  const window = candles.slice(n - 11, n - 1);
  const highest10 = Math.max(...window.map(c => c.high));
  const lowest10 = Math.min(...window.map(c => c.low));
  const breakHigh = last.close > highest10;
  const breakLow = last.close < lowest10;
  return {
    long: tightRangePrev && volBuild && breakHigh && !flushActive,
    short: tightRangePrev && volBuild && breakLow && !flushActive,
  };
}

// ─── "Mario WARMING Gate + SUPER Override" (личен Pine Script индикатор) ─────
// True Range / ATR (проста SMA версия, за консистентност с останалите
// приближени индикатори в приложението - не истинската Wilder RMA).
function calcTrueRangeSeries(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}
// Wilder RMA на True Range (същото изглаждане като calcRSI по-горе, а не
// плъзгаща SMA само на последния прозорец) - за да съвпада с TradingView
// ta.atr(). При масив с точно `period` TR стойности резултатът е идентичен
// на старата SMA версия (само seed, без допълнително изглаждане).
function calcATR(candles, period) {
  const tr = calcTrueRangeSeries(candles);
  const n = tr.length;
  if (n < period) return null;
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// Оценява волуменния "warming" tier на последната свещ (1H по подразбиране в
// оригинала): WARMING/HOT/SUPER спрямо обемната MA, само ако диапазонът е
// компресиран (ATR% <= праг) - т.е. "затишие преди буря". easeFactor<1 обхваща
// "Boost Window" ефекта (по-лесно задействане за няколко часа след голям 4Ч обем).
function calcWarmingTier(candles, opts = {}) {
  const volLen = opts.volLen ?? 20, atrLen = opts.atrLen ?? 20;
  const atrPctMax = opts.atrPctMax ?? 0.75;
  const useCompression = opts.useCompression ?? true;
  const easeFactor = opts.easeFactor ?? 1;
  const warm1 = (opts.warm1x ?? 1.5) * easeFactor;
  const warm2 = (opts.warm2x ?? 2.0) * easeFactor;
  const warm3 = (opts.warm3x ?? 3.0) * easeFactor;
  const n = candles.length;
  if (n < Math.max(volLen, atrLen) + 1) return { tier: 'none', volX: null, atrPct: null, direction: 'flat' };
  const volumes = candles.map(c => c.volume);
  const volMA = calcSMA(volumes, volLen);
  const atr = calcATR(candles, atrLen);
  const last = candles[n - 1];
  if (volMA == null || atr == null) return { tier: 'none', volX: null, atrPct: null, direction: 'flat' };
  const volX = volMA > 0 ? last.volume / volMA : 0;
  const atrPct = (atr / last.close) * 100;
  const compressOK = !useCompression || atrPct <= atrPctMax;
  const direction = last.close > last.open ? 'up' : last.close < last.open ? 'down' : 'flat';
  let tier = 'none';
  if (compressOK && direction !== 'flat') {
    if (volX >= warm3) tier = 'super';
    else if (volX >= warm2) tier = 'hot';
    else if (volX >= warm1) tier = 'warm';
  }
  return { tier, volX, atrPct, direction };
}

// 4Ч "голям обем" потвърждение - независимо от компресията, само посока + spike.
function calc4HBigVolume(candles, opts = {}) {
  const volLen = opts.volLen ?? 20, threshold = opts.threshold ?? 2.5;
  const n = candles.length;
  if (n < volLen + 1) return { active: false, direction: 'flat', volX: null };
  const volMA = calcSMA(candles.map(c => c.volume), volLen);
  if (volMA == null) return { active: false, direction: 'flat', volX: null };
  const last = candles[n - 1];
  const volX = volMA > 0 ? last.volume / volMA : 0;
  const direction = last.close > last.open ? 'up' : last.close < last.open ? 'down' : 'flat';
  return { active: volX >= threshold && direction !== 'flat', direction, volX };
}

// Dump Cascade (15м): брои "силно червени" свещи (тяло >= dumpBodyPctMin % от
// диапазона) сред последните dumpBars - >= dumpMinCount означава каскаден срив.
function calcDumpCascade(candles, opts = {}) {
  const dumpBars = opts.dumpBars ?? 3, dumpMinCount = opts.dumpMinCount ?? 2;
  const dumpBodyPctMin = opts.dumpBodyPctMin ?? 60;
  const n = candles.length;
  if (n < dumpBars) return { active: false, redCount: 0 };
  let redCount = 0;
  for (let i = n - dumpBars; i < n; i++) {
    const c = candles[i];
    const range = Math.max(c.high - c.low, 1e-9);
    const bodyPct = (Math.abs(c.close - c.open) / range) * 100;
    if (c.close < c.open && bodyPct >= dumpBodyPctMin) redCount++;
  }
  return { active: redCount >= dumpMinCount, redCount };
}

// Обемно-претеглен посочен натиск (сума на (close-open)*volume) над последните `len`
// свещи - положителен => купувачите доминират по обем, отрицателен => продавачите.
function calcVolumePressure(candles, len) {
  const n = candles.length;
  if (n < len) return { press: 0, biasLong: false, biasShort: false };
  let press = 0;
  for (let i = n - len; i < n; i++) {
    const c = candles[i];
    press += (c.close - c.open) * c.volume;
  }
  return { press, biasLong: press > 0, biasShort: press < 0 };
}

// 15м контекст за "MM WARMING→IMPULSE": обемен spike + растящ обем (warmBars
// последователни свещи) + ATR компресия => отваря ARM прозорец за entry на по-нисък TF.
function calcWarmingContext(candles, opts = {}) {
  const volLen = opts.volLen ?? 20, atrLen = opts.atrLen ?? 14;
  const warmVolX = opts.warmVolX ?? 1.6, warmBars = opts.warmBars ?? 3;
  const useComp = opts.useComp ?? true, atrPctMax = opts.atrPctMax ?? 1.2;
  const pressLen = opts.pressLen ?? 6;
  const n = candles.length;
  const minLen = Math.max(volLen, atrLen, pressLen) + warmBars + 1;
  if (n < minLen) return { warming: false, biasLong: false, biasShort: false, volX: null, atrPct: null };

  const volMA = calcSMA(candles.map(c => c.volume), volLen);
  const atr = calcATR(candles, atrLen);
  const last = candles[n - 1];
  if (volMA == null || atr == null) return { warming: false, biasLong: false, biasShort: false, volX: null, atrPct: null };

  const volX = volMA > 0 ? last.volume / volMA : 0;
  const atrPct = (atr / last.close) * 100;
  const compOK = !useComp || atrPct <= atrPctMax;

  let riseCount = 0;
  for (let i = 0; i < warmBars; i++) {
    const cur = candles[n - 1 - i];
    const prev = candles[n - 2 - i];
    if (cur.volume > prev.volume) riseCount++;
  }
  const volRise = riseCount >= (warmBars - 1);

  const { biasLong, biasShort } = calcVolumePressure(candles, pressLen);
  const warming = volX >= warmVolX && volRise && compOK;
  return { warming, biasLong, biasShort, volX, atrPct };
}

// 5м impulse entry: обемен spike + голямо тяло + пробив на предходния high/low.
function calcEntryImpulse(candles, opts = {}) {
  const volLen = opts.volLen ?? 20;
  const impVolX = opts.impVolX ?? 2.2;
  const bodyPctMin = opts.bodyPctMin ?? 0.55;
  const n = candles.length;
  if (n < volLen + 2) return { impulseUp: false, impulseDn: false, volX: null, bodyPct: null };
  const volMA = calcSMA(candles.map(c => c.volume), volLen);
  if (volMA == null) return { impulseUp: false, impulseDn: false, volX: null, bodyPct: null };
  const last = candles[n - 1], prev = candles[n - 2];
  const range = Math.max(last.high - last.low, 1e-9);
  const bodyPct = Math.abs(last.close - last.open) / range;
  const volX = volMA > 0 ? last.volume / volMA : 0;
  const impulseVolOK = volX >= impVolX;
  const impulseBodyOK = bodyPct >= bodyPctMin;
  const impulseUp = impulseVolOK && impulseBodyOK && last.close > prev.high && last.close > last.open;
  const impulseDn = impulseVolOK && impulseBodyOK && last.close < prev.low && last.close < last.open;
  return { impulseUp, impulseDn, volX, bodyPct };
}

// "MM x25" - по-безопасен/по-тесен вход: EMA тренд филтър + анти-спайк проверка
// (обемът/диапазонът да НЕ е екстремен, за разлика от impulse entry-то).
function calcMMx25Entry(candles, opts = {}) {
  const volLen = opts.volLen ?? 20, atrLen = opts.atrLen ?? 14, emaLen = opts.emaLen ?? 20;
  const proxyVolX = opts.proxyVolX ?? 2.5, proxyATRX = opts.proxyATRX ?? 1.8;
  const n = candles.length;
  const minLen = Math.max(volLen, atrLen, emaLen) + 1;
  if (n < minLen) return { long: false, short: false, ema: null };
  const emaSeries = calcEMASeries(candles.map(c => c.close), emaLen);
  const ema = emaSeries[n - 1];
  const volMA = calcSMA(candles.map(c => c.volume), volLen);
  const atr = calcATR(candles, atrLen);
  const last = candles[n - 1];
  if (ema == null || volMA == null || atr == null) return { long: false, short: false, ema: null };
  const proxyOK = last.volume <= volMA * proxyVolX && (last.high - last.low) <= atr * proxyATRX;
  return { long: last.close > ema && proxyOK, short: last.close < ema && proxyOK, ema, proxyOK };
}

function detectBottom(coin) {
  let score = 0;
  if (Math.abs(coin.funding) < 0.03) score++;
  if (coin.oiDelta > 1) score++;
  if (coin.chg24 < -5) score++;
  if (coin.longPct < 45) score++;
  if (coin.pctFromAtl !== null && coin.pctFromAtl < 100) score += 2;
  return score >= 3;
}

function detectTop(coin) {
  let score = 0;
  if (coin.funding > 0.08) score += 2;
  if (coin.oiDelta < -1) score++;
  if (coin.chg24 > 10) score++;
  if (coin.longPct > 70) score += 2;
  if (coin.pctFromAth !== null && coin.pctFromAth > -15) score += 2;
  return score >= 4;
}

function calcSignal(coin) {
  let ls = 0, ss = 0;
  if (coin.chg24 >= 10) ls += 3; else if (coin.chg24 >= 5) ls += 2; else if (coin.chg24 >= 2) ls += 1;
  else if (coin.chg24 <= -10) ss += 3; else if (coin.chg24 <= -5) ss += 2; else if (coin.chg24 <= -2) ss += 1;
  if (coin.longPct >= 65) ls += 2; else if (coin.longPct >= 58) ls += 1;
  else if (coin.shortPct >= 55) ss += 1; else if (coin.shortPct >= 65) ss += 2;
  if (coin.funding < -0.01) ls += 1; else if (coin.funding > 0.08) ss += 2; else if (coin.funding > 0.05) ss += 1; else if (coin.funding > 0.03) ss += 1;
  if (coin.vol24 > 1000000000) ls += 1; else if (coin.vol24 > 500000000) ls += 1;
  if (coin.isTrending && coin.chg24 > 0) ls += 1; if (coin.isTrending && coin.chg24 < 0) ss += 1;
  if (coin.liqBias === 'long') ls += 1; if (coin.liqBias === 'short') ss += 1;
  if (coin.funding > 0.06 && Math.abs(coin.longPct - 50) < 15) return {signal:'SQUEEZE',ls,ss};
  if (ls >= 3) return {signal:'LONG',ls,ss}; if (ss >= 3) return {signal:'SHORT',ls,ss};
  if (ls >= 2 && ls > ss) return {signal:'LONG',ls,ss}; if (ss >= 2 && ss > ls) return {signal:'SHORT',ls,ss};
  return {signal:'NEUTRAL',ls,ss};
}

// Оценява дали близък голям ликвидационен клъстер (от вече показвания в
// "🔴 ЛИК НИВА" CoinGlass heatmap) действа като "магнит" за цената — честа
// пазарна интуиция е, че цената се тегли към зони с натрупани ликвидации.
// above/below: масиви {price, amount}, каквито връща getLiqNearPrice() -
// above = зони НАД текущата цена (предимно шорт ликвидации, дърпат нагоре),
// below = зони ПОД текущата цена (предимно лонг ликвидации, дърпат надолу).
// Сигналът се брои само ако едната страна ясно доминира (>=1.5x) И най-близката
// ѝ зона е достатъчно близо (<=8% от цената), за да е реалистично "достижима".
function calcLiquidityBias(above, below, price) {
  const sumAmt = arr => (arr || []).reduce((s, l) => s + (l.amount || 0), 0);
  const nearestPct = l => (l && price) ? Math.abs((l.price - price) / price) * 100 : Infinity;
  const aboveAmt = sumAmt(above), belowAmt = sumAmt(below);
  const nearestAbovePct = nearestPct(above && above[0]);
  const nearestBelowPct = nearestPct(below && below[0]);
  const NEAR_THRESHOLD_PCT = 8;
  const DOMINANCE_RATIO = 1.5;
  if (aboveAmt <= 0 && belowAmt <= 0) return { bias: 'neutral', aboveAmt, belowAmt };
  if (aboveAmt >= belowAmt * DOMINANCE_RATIO && nearestAbovePct <= NEAR_THRESHOLD_PCT) {
    return { bias: 'long', aboveAmt, belowAmt };
  }
  if (belowAmt >= aboveAmt * DOMINANCE_RATIO && nearestBelowPct <= NEAR_THRESHOLD_PCT) {
    return { bias: 'short', aboveAmt, belowAmt };
  }
  return { bias: 'neutral', aboveAmt, belowAmt };
}

// Наклон от вече работещите (безплатни) Binance order book "стени" - алтернатива
// на calcLiquidityBias(), тъй като CoinGlass liquidation heatmap-ът се оказа
// заключен зад по-висок платен план (CoinGlass връща {"code":"401","msg":"Upgrade
// plan"}) и никога не връща реални данни. ВАЖНО: логиката тук е ОБРАТНА на
// calcLiquidityBias - стена е подкрепа/съпротива (repel), не ликвидационен магнит
// (attract): голяма и близка Buy Wall (подкрепа) под цената -> бичи наклон;
// голяма и близка Sell Wall (съпротива) над цената -> мечи наклон.
// buyWall/sellWall: {price, usd} или null/undefined, каквито връща fetchOrderBookWalls().
function calcWallBias(buyWall, sellWall, price) {
  const nearestPct = w => (w && price) ? Math.abs((w.price - price) / price) * 100 : Infinity;
  const buyAmt = buyWall ? (buyWall.usd || 0) : 0;
  const sellAmt = sellWall ? (sellWall.usd || 0) : 0;
  const NEAR_THRESHOLD_PCT = 8;
  const DOMINANCE_RATIO = 1.5;
  if (buyAmt <= 0 && sellAmt <= 0) return { bias: 'neutral', buyAmt, sellAmt };
  if (buyAmt >= sellAmt * DOMINANCE_RATIO && nearestPct(buyWall) <= NEAR_THRESHOLD_PCT) {
    return { bias: 'long', buyAmt, sellAmt };
  }
  if (sellAmt >= buyAmt * DOMINANCE_RATIO && nearestPct(sellWall) <= NEAR_THRESHOLD_PCT) {
    return { bias: 'short', buyAmt, sellAmt };
  }
  return { bias: 'neutral', buyAmt, sellAmt };
}

function calcSetupQuality(coin) {
  const sig = calcSignal(coin);
  let longPts = 0, shortPts = 0;
  if (coin.funding < 0) longPts++;
  if (coin.longPct < 45) longPts++;
  if (coin.oiDelta > 2) longPts++;
  if (sig.signal === 'LONG') longPts++;
  if (coin.goldenCross === true) longPts++;
  if (detectBottom(coin)) longPts++;
  if (coin.liqBias === 'long') longPts++;
  if (coin.funding > 0.08) shortPts++;
  if (coin.longPct > 70) shortPts++;
  if (coin.chg24 > 5 && coin.oiDelta < 0) shortPts++;
  if (sig.signal === 'SHORT') shortPts++;
  if (coin.goldenCross === false) shortPts++;
  if (detectTop(coin)) shortPts++;
  if (coin.liqBias === 'short') shortPts++;
  const pts = Math.max(longPts, shortPts);
  const side = longPts >= shortPts ? 'long' : 'short';
  if (pts >= 4) return {grade:'setup', side, pts, label: side==='long' ? '🟢 ЛОНГ SETUP' : '🔴 ШОРТ SETUP'};
  if (pts >= 2) return {grade:'watch', side, pts, label:'🟡 НАБЛЮДАВАЙ'};
  return {grade:'none', side, pts, label:null};
}

function isManipulable(coin) { return coin.vol24 < 30000000 || coin.oi < 3000000; }

function formatNum(n) {
  if (!n && n!==0) return '--';
  if (n>=1e9) return (n/1e9).toFixed(2)+'B'; if (n>=1e6) return (n/1e6).toFixed(1)+'M';
  if (n>=1e3) return (n/1e3).toFixed(1)+'K'; return n.toFixed(2);
}

// Единна функция за форматиране на цена (премахнато дублирането с предишната formatP).
function formatPrice(p) {
  if (!p) return '--';
  if (p>=10000) return p.toLocaleString('en',{maximumFractionDigits:0}); if (p>=1000) return p.toLocaleString('en',{maximumFractionDigits:1});
  if (p>=1) return p.toFixed(4); return p.toFixed(6);
}

function formatOIDelta(delta) {
  if (!delta) return '<span style="color:var(--text2)">--</span>';
  return `<span style="color:${delta>0?'var(--green)':'var(--red)'}">${delta>0?'▲':'▼'}${Math.abs(delta).toFixed(2)}%</span>`;
}

// Maintenance margin rate, диференциран по тип монета в 3 нива (приближение на реалните Binance margin tiers):
// мейджъри с най-дълбока ликвидност -> нисък rate; полу-мейджъри -> среден rate;
// по-малки/волатилни монети -> по-консервативен (по-висок) rate, за да не показва калкулаторът
// оптимистична (по-далечна) ликвидационна цена за тях.
function getMaintenanceRate(symbol) {
  if (MAJOR_COINS.has(symbol)) return MAINTENANCE_RATE_MAJOR;
  if (SEMI_MAJOR_COINS.has(symbol)) return MAINTENANCE_RATE_SEMI;
  return MAINTENANCE_RATE_MINOR;
}

function calcLiquidationPrice(entryPrice, avgPrice, totalSize, leverage, side, maintenanceRate) {
  return side==='long' ? avgPrice*(1-(1/leverage)+maintenanceRate) : avgPrice*(1+(1/leverage)-maintenanceRate);
}

function calcDCALevels(entryPrice, side, symbol) {
  const maintenanceRate = getMaintenanceRate(symbol);
  const steps = [];
  const entryLiq = calcLiquidationPrice(entryPrice, entryPrice, DCA_ENTRY, DCA_LEVERAGE, side, maintenanceRate);
  steps.push({step:0,label:'ВХОД',addAmount:DCA_ENTRY,totalUSDT:DCA_ENTRY,levelPrice:entryPrice,avgPrice:entryPrice,liqPrice:entryLiq,safeOrder:null,pctFromEntry:0});
  let totalUSDT=DCA_ENTRY, totalQty=DCA_ENTRY/entryPrice;
  let dca2LevelPrice = null;
  [0.24,0.40].forEach((drop,i) => {
    const addAmount=DCA_ENTRY*Math.pow(2,i+1);
    const levelPrice=side==='long'?entryPrice*(1-drop):entryPrice*(1+drop);
    if (i===1) dca2LevelPrice = levelPrice;
    totalUSDT+=addAmount; totalQty+=addAmount/levelPrice;
    const avgPrice=totalUSDT/totalQty;
    const liqPrice=calcLiquidationPrice(entryPrice,avgPrice,totalUSDT,DCA_LEVERAGE,side,maintenanceRate);
    steps.push({step:i+1,label:`DCA ${i+1}`,addAmount,totalUSDT,levelPrice,avgPrice,liqPrice,safeOrder:side==='long'?liqPrice*1.02:liqPrice*0.98,pctFromEntry:drop*100});
  });
  const dca3Amount=DCA_ENTRY*8;
  const dca3Price=side==='long'?dca2LevelPrice*(1-0.35):dca2LevelPrice*(1+0.35);
  totalUSDT+=dca3Amount; totalQty+=dca3Amount/dca3Price;
  const dca3Avg=totalUSDT/totalQty;
  const dca3Liq=calcLiquidationPrice(entryPrice,dca3Avg,totalUSDT,DCA_LEVERAGE,side,maintenanceRate);
  steps.push({step:3,label:'DCA 3 · ПОСЛЕДЕН БУФЕР (-35% от DCA 2)',addAmount:dca3Amount,totalUSDT,levelPrice:dca3Price,avgPrice:dca3Avg,liqPrice:dca3Liq,safeOrder:side==='long'?dca3Liq*1.02:dca3Liq*0.98,pctFromEntry:Math.abs((dca3Price-entryPrice)/entryPrice*100)});
  return steps;
}

// ─── "Mario – Build-Up Detector + EMA Filter" (личен Pine Script индикатор) ───
// Три етапа: (1) Early Build-Up на 1ч - тих натиск в една посока + компресия
// на волатилността спрямо собствената ѝ скорошна средна + обем все още не е
// напълно пресъхнал; (2) 4ч Confirm - два поредни 4ч свещи в посоката +
// EMA50>EMA200 (и растящ EMA50) филтър, в рамките на времеви прозорец от
// early сигнала; (3) Pre-Impulse - потвърденият сигнал + разширяващ се ATR
// (спрямо съвсем скорошната си средна) - най-силният, финален тригер.

// Изглаждане на ATR спрямо собствената му скорошна средна (за lowVolatility/
// atrExpansion проверките) - пресмята ATR на всяка от последните `lookback`
// свещи и ги осреднява.
function calcSmoothedATR(candles, atrLen, lookback) {
  const n = candles.length;
  let sum = 0, count = 0;
  for (let i = 0; i < lookback; i++) {
    const end = n - i;
    if (end < atrLen) break;
    const v = calcATR(candles.slice(0, end), atrLen);
    if (v != null) { sum += v; count++; }
  }
  return count > 0 ? sum / count : null;
}

// Etap 1 (1ч): тих build-up в една посока - мнозинство свещи в тази посока +
// "накъсани" higher lows / lower highs + ATR под собствената си скорошна
// средна (компресия) + обемът все още не е напълно пресъхнал.
function calcBuildUpEarly(candles, opts = {}) {
  const earlyBars = opts.earlyBars ?? 6, atrLen = opts.atrLen ?? 14, volLen = opts.volLen ?? 20;
  const atrLooseMult = opts.atrLooseMult ?? 1.3, volStableMult = opts.volStableMult ?? 0.8;
  const n = candles.length;
  if (n < Math.max(atrLen, volLen) + earlyBars + 3) return { long: false, short: false };
  const last = candles.slice(n - earlyBars);
  let bullCount = 0, bearCount = 0;
  for (const c of last) { if (c.close > c.open) bullCount++; if (c.close < c.open) bearCount++; }
  const higherLows = candles[n-1].low > candles[n-2].low || candles[n-2].low > candles[n-3].low;
  const lowerHighs = candles[n-1].high < candles[n-2].high || candles[n-2].high < candles[n-3].high;
  const volMA = calcSMA(candles.map(c => c.volume), volLen);
  const volStable = volMA != null && candles[n-1].volume >= volMA * volStableMult;
  const currentAtr = calcATR(candles, atrLen);
  const smoothedAtr = calcSmoothedATR(candles, atrLen, earlyBars);
  const lowVolatility = currentAtr != null && smoothedAtr != null && currentAtr < smoothedAtr * atrLooseMult;
  const long = bullCount >= earlyBars / 2 && higherLows && lowVolatility && volStable;
  const short = bearCount >= earlyBars / 2 && lowerHighs && lowVolatility && volStable;
  return { long, short };
}

// EMA филтър (по подразбиране 4ч в оригинала): EMA fast > slow И fast расте (bull),
// или обратното (bear). Изисква candles.length >= slowLen (200 по подразбиране),
// за разлика от останалите сигнали в приложението - виж fetchKlines лимита за 4ч.
function calcEmaTrendFilter(candles, opts = {}) {
  const fastLen = opts.fastLen ?? 50, slowLen = opts.slowLen ?? 200;
  const closes = candles.map(c => c.close);
  const fastSeries = calcEMASeries(closes, fastLen);
  const slowSeries = calcEMASeries(closes, slowLen);
  const n = candles.length;
  const fNow = fastSeries[n-1], fPrev = fastSeries[n-2], sNow = slowSeries[n-1];
  if (fNow == null || fPrev == null || sNow == null) return { bull: false, bear: false };
  return { bull: fNow > sNow && fNow > fPrev, bear: fNow < sNow && fNow < fPrev };
}

// Etap 2 (4ч): последните 2 свещи И двете в същата посока - "потвърждение"
// на build-up-а с реално ценово движение подир него.
function calc4hTwoBarTrend(candles) {
  const n = candles.length;
  if (n < 2) return { bull: false, bear: false };
  const last = candles[n-1], prev = candles[n-2];
  return { bull: last.close > last.open && prev.close > prev.open, bear: last.close < last.open && prev.close < prev.open };
}

// Etap 3: ATR над съвсем скорошната си средна (по подразбиране 2 свещи) -
// диапазонът вече се разширява, типично за начало на истински импулс.
function calcATRExpansion(candles, opts = {}) {
  const atrLen = opts.atrLen ?? 14, lookback = opts.lookback ?? 2;
  const currentAtr = calcATR(candles, atrLen);
  const smoothedAtr = calcSmoothedATR(candles, atrLen, lookback);
  if (currentAtr == null || smoothedAtr == null) return false;
  return currentAtr > smoothedAtr;
}

// ─── "MM-OSC Entry Companion" (личен Pine Script индикатор) ─────────────────
// Осцилатор 0-100: комбинира ценов натиск спрямо бързата EMA, едносвещен
// моментум и обемен boost, всичко нормализирано през ATR и притиснато през
// tanh (JS вградената Math.tanh). Прилага се на 5м (същия таймфрейм като MM
// входовете, тъй като е "Entry Companion" към MM системата - не е зададен
// изрично таймфрейм в оригинала, той е "текущия чарт").
function calcMMOscValue(candles, opts = {}) {
  const atrLen = opts.atrLen ?? 14, emaFastLen = opts.emaFastLen ?? 20, emaSlowLen = opts.emaSlowLen ?? 50;
  const n = candles.length;
  if (n < Math.max(atrLen, emaSlowLen) + 2) return null;
  const closes = candles.map(c => c.close);
  const emaFast = calcEMASeries(closes, emaFastLen)[n - 1];
  const atr = calcATR(candles, atrLen);
  if (emaFast == null || atr == null || atr === 0) return null;
  const last = candles[n - 1], prev = candles[n - 2];
  const pressure = (last.close - emaFast) / atr;
  const momentum = (last.close - prev.close) / atr;
  const raw = pressure * 0.85 + momentum * 0.85;
  const osc = 50 + 50 * Math.tanh(raw);
  return Math.max(0, Math.min(100, osc));
}

// "BEST ENTRY": осцилаторът пресича прага НАГОРЕ (long) или НАДОЛУ (short) +
// EMA20/50 режим в същата посока + достатъчен обем/тяло на последната свещ.
// Връща и `osc` стойността (нужна на orchestration слоя за RE-ENTRY pullback
// проверката) - самата RE-ENTRY/cooldown/прозорец логика е stateful и живее
// извън тази чиста функция (виж mmOscState в signal-scanner.html/worker.js).
function calcMMOscEntry(candles, opts = {}) {
  const volLen = opts.volLen ?? 20, volMin = opts.volMin ?? 1.2, bodyMin = opts.bodyMin ?? 0.55;
  const entryUp = opts.entryUp ?? 55, entryDn = opts.entryDn ?? 45;
  const emaFastLen = opts.emaFastLen ?? 20, emaSlowLen = opts.emaSlowLen ?? 50;
  const n = candles.length;
  const oscNow = calcMMOscValue(candles, opts);
  const oscPrev = n > 1 ? calcMMOscValue(candles.slice(0, n - 1), opts) : null;
  if (oscNow == null || oscPrev == null) return { long: false, short: false, osc: oscNow };
  const closes = candles.map(c => c.close);
  const emaF = calcEMASeries(closes, emaFastLen)[n - 1];
  const emaS = calcEMASeries(closes, emaSlowLen)[n - 1];
  if (emaF == null || emaS == null) return { long: false, short: false, osc: oscNow };
  const regimeUp = emaF > emaS, regimeDown = emaF < emaS;
  const volMA = calcSMA(candles.map(c => c.volume), volLen);
  const last = candles[n - 1];
  const volX = volMA != null && volMA > 0 ? last.volume / volMA : 0;
  const rng = Math.max(last.high - last.low, 1e-9);
  const bodyPct = Math.abs(last.close - last.open) / rng;
  const baseOK = volX >= volMin && bodyPct >= bodyMin;
  const crossover = oscPrev <= entryUp && oscNow > entryUp;
  const crossunder = oscPrev >= entryDn && oscNow < entryDn;
  return {
    long: baseOK && regimeUp && crossover,
    short: baseOK && regimeDown && crossunder,
    osc: oscNow,
  };
}

// RE-ENTRY pullback зона: осцилаторът се е върнал в неутрална зона (48-55 за
// long, огледално 45-52 за short) след предходен вход - "чист" ретест преди
// евентуален повторен сигнал в СЪЩАТА посока в рамките на прозореца.
function calcMMOscPullbackZone(osc, direction, opts = {}) {
  const rePullLo = opts.rePullLo ?? 48, rePullHi = opts.rePullHi ?? 55;
  if (osc == null) return false;
  if (direction === 1) return osc >= rePullLo && osc <= rePullHi;
  if (direction === -1) return osc <= (100 - rePullLo) && osc >= (100 - rePullHi);
  return false;
}

// ─── "Mario IMPULSE + CONFIRMED + GAP FILTER + BTC.D FILTER" (личен Pine Script
// индикатор) ─────────────────────────────────────────────────────────────────
// Пренесени са само IMPULSE и CONFIRMED - CME Gap филтърът (CME:BTC1! фючърсен
// gap) и BTC.D филтърът (CRYPTOCAP:BTC.D EMA) изискват данни, които Binance API
// не дава (CME фючърси / почасова история на доминацията), затова са пропуснати.

// IMPULSE+ATR: пробив на предходния бар (close > prev.high / < prev.low) +
// голямо тяло на свещта + обемен спайк, ПЛЮС нов ATR% "здравословен диапазон"
// филтър (нито твърде тихо, нито екстремна волатилност) - разлика спрямо
// съществуващия calcEntryImpulse, който няма ATR% гейт.
function calcImpulseAtrSignal(candles, opts = {}) {
  const volLen = opts.volLen ?? 20, impulseVolMult = opts.impulseVolMult ?? 2.5;
  const impulseBodyPct = opts.impulseBodyPct ?? 0.6;
  const atrLen = opts.atrLen ?? 14, atrMinPct = opts.atrMinPct ?? 0.15, atrMaxPct = opts.atrMaxPct ?? 3.0;
  const n = candles.length;
  if (n < Math.max(volLen, atrLen) + 2) return { long: false, short: false };
  const volMA = calcSMA(candles.map(c => c.volume), volLen);
  const atr = calcATR(candles, atrLen);
  if (volMA == null || atr == null) return { long: false, short: false };
  const last = candles[n - 1], prev = candles[n - 2];
  const atrPct = atr / last.close * 100;
  const volatilityOK = atrPct >= atrMinPct && atrPct <= atrMaxPct;
  const rng = Math.max(last.high - last.low, 1e-9);
  const impulseCandle = Math.abs(last.close - last.open) / rng >= impulseBodyPct;
  const impulseVol = last.volume >= volMA * impulseVolMult;
  const gate = impulseCandle && impulseVol && volatilityOK;
  return { long: gate && last.close > prev.high, short: gate && last.close < prev.low };
}

// CONFIRMED: на HTF (по подразбиране 15м) цената пресича обратно EMA20, докато
// EMA20>EMA50 (bullish pullback continuation) / огледално за short, ПЛЮС по
// избор HTF Regime Sync - 1ч EMA20/EMA50 да сочат същата посока. И двата
// таймфрейма вече се тегли за WARMING Gate/Build-Up Detector, без нов fetch.
function calcConfirmedSignal(candles15, candles1h, opts = {}) {
  const emaFastLen = opts.emaFastLen ?? 20, emaMidLen = opts.emaMidLen ?? 50;
  const useHTFRegime = opts.useHTFRegime ?? true;
  const n15 = candles15.length;
  if (n15 < emaMidLen + 2) return { long: false, short: false };
  const closes15 = candles15.map(c => c.close);
  const ema20Series = calcEMASeries(closes15, emaFastLen);
  const ema50Series = calcEMASeries(closes15, emaMidLen);
  const ema20 = ema20Series[n15 - 1], ema20Prev = ema20Series[n15 - 2], ema50 = ema50Series[n15 - 1];
  const close = closes15[n15 - 1], closePrev = closes15[n15 - 2];
  if (ema20 == null || ema20Prev == null || ema50 == null) return { long: false, short: false };
  const crossover = closePrev <= ema20Prev && close > ema20;
  const crossunder = closePrev >= ema20Prev && close < ema20;
  const pullbackLong = crossover && ema20 > ema50;
  const pullbackShort = crossunder && ema20 < ema50;
  let htfBull = true, htfBear = true;
  if (useHTFRegime) {
    const n1h = candles1h.length;
    if (n1h < emaMidLen + 1) return { long: false, short: false };
    const closes1h = candles1h.map(c => c.close);
    const regEma20 = calcEMASeries(closes1h, emaFastLen)[n1h - 1];
    const regEma50 = calcEMASeries(closes1h, emaMidLen)[n1h - 1];
    if (regEma20 == null || regEma50 == null) return { long: false, short: false };
    htfBull = regEma20 > regEma50;
    htfBear = regEma20 < regEma50;
  }
  return { long: pullbackLong && htfBull, short: pullbackShort && htfBear };
}

// В браузъра (класически <script>) горните декларации стават глобални и се ползват
// directly от signal-scanner.html. В Node (Vitest) ги правим достъпни през module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DCA_LEVERAGE, DCA_ENTRY, MAJOR_COINS, SEMI_MAJOR_COINS,
    MAINTENANCE_RATE_MAJOR, MAINTENANCE_RATE_SEMI, MAINTENANCE_RATE_MINOR,
    SYMBOL_MAP, fixSymbol, calcSMA, calcStdDev, calcRSI, detectBottom, detectTop,
    calcSignal, calcSetupQuality, calcLiquidityBias, calcWallBias, calcAltRadarScore, calcAltRadarSignal,
    calcRSISeries, calcEMASeries, calcFlushSignal, calcBaseSignal, calcBaseDivergenceStrength, calcSqueezeSignal, calcShiftSignal, calcImpulseSignal,
    calcBlowoffSignal, calcDistributionSignal, calcDumpSqueezeSignal, calcShiftDownSignal,
    calcATR, calcTrueRangeSeries, calcWarmingTier, calc4HBigVolume, calcDumpCascade,
    calcVolumePressure, calcWarmingContext, calcEntryImpulse, calcMMx25Entry,
    calcSmoothedATR, calcBuildUpEarly, calcEmaTrendFilter, calc4hTwoBarTrend, calcATRExpansion,
    calcMMOscValue, calcMMOscEntry, calcMMOscPullbackZone,
    calcImpulseAtrSignal, calcConfirmedSignal,
    isManipulable, formatNum, formatPrice,
    formatOIDelta, getMaintenanceRate, calcLiquidationPrice, calcDCALevels
  };
}
