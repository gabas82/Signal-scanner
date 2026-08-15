// ============================================================================
// Cloudflare Worker: orange-grass-d809
// ============================================================================
// 1) HTTP proxy (fetch handler) - непроменена функционалност спрямо оригинала,
//    само ключовете вече се четат от Worker Secrets (env.*), не са hardcoded в
//    кода. Signal-scanner/football.html го викат за Yahoo/football-data.org/
//    api-sports.io/CoinGlass, за да не са ключовете видими в клиентския JS.
// 2) Cron известия (scheduled handler) - следи личен watchlist за DCA нива и
//    праща WhatsApp съобщение през CallMeBot (безплатно, без Twilio/Meta акаунт)
//    когато цената пресече ниво. Виж README.md в тази папка за setup стъпките
//    (secrets, KV binding, Cron Trigger, CallMeBot активация).
// ============================================================================

// ---- Личен watchlist -------------------------------------------------------
// symbol винаги е нужен (Binance формат, напр. 'BTCUSDT'). ВСЕКИ запис се следи
// за пазарни сигнали (WARMING/HOT/SUPER, MM LONG/SHORT/x25, FLUSH/BASE/SQUEEZE/
// SHIFT/IMPULSE) - за това entryPrice/side НЕ са нужни. Добавяш ги само ако
// искаш и DCA известия за конкретна твоя позиция в тази монета.
const WATCHLIST = [
  { symbol: 'BTCUSDT' },
  { symbol: 'ETHUSDT' },
  { symbol: 'SOLUSDT' },
  { symbol: 'LTCUSDT' },
  { symbol: 'SUIUSDT' },
  { symbol: 'APTUSDT' },
  { symbol: 'INJUSDT' },
  { symbol: 'HYPEUSDT' },
  { symbol: 'RIVERUSDT' },
  { symbol: 'TAOUSDT' },
  { symbol: 'ZECUSDT' },
  { symbol: 'ONDOUSDT' },
  { symbol: 'WLDUSDT' },
  { symbol: 'OPUSDT' },
  { symbol: 'ARKMUSDT' },
];

const DCA_ALERT_COOLDOWN_MS = 24 * 3600000; // не повтаря едно и също DCA ниво по-често от 24ч

// ---- DCA логика - byte-identical копие от signal-logic.js -----------------
// (calcDCALevels и директните му зависимости; Worker-ът е single-file dashboard
// проект, затова не internal import-ва signal-logic.js директно - ако promptнеш
// DCA формулата в signal-logic.js, огледай промяната и тук.)
const DCA_LEVERAGE = 3;
const DCA_ENTRY = 10;
const MAJOR_COINS = new Set(['BTC','ETH','SOL','BNB','XRP','DOGE','LTC']);
const SEMI_MAJOR_COINS = new Set(['ADA','AVAX','LINK','DOT','UNI','ATOM','NEAR','SUI','APT','AAVE','ARB','TON','ETC']);
const MAINTENANCE_RATE_MAJOR = 0.004;
const MAINTENANCE_RATE_SEMI = 0.0065;
const MAINTENANCE_RATE_MINOR = 0.01;

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

// ---- TextMeBot WhatsApp helper ----------------------------------------------
// Заменя CallMeBot (виж git history) - CallMeBot изчерпа безплатния си лимит
// съобщения ("0 messages left") и оттогава сайтът/плащанията им бяха постоянно
// счупени (сървърна MySQL грешка), затова минаваме на TextMeBot. env.CALLMEBOT_PHONE
// пази старото си име нарочно (същият номер, само за да не се дублира secret-а
// с ново име) - вижда се и в TEXTMEBOT_APIKEY, единственият нов secret тук.
// Връща диагностика (ok/status/body) вместо да гълта резултата.
async function sendWhatsApp(env, text) {
  if (!env.CALLMEBOT_PHONE || !env.TEXTMEBOT_APIKEY) {
    console.error('TextMeBot secrets not set - skipping notification');
    return { ok: false, error: 'CALLMEBOT_PHONE/TEXTMEBOT_APIKEY not set' };
  }
  const url = `https://api.textmebot.com/send.php?recipient=${encodeURIComponent(env.CALLMEBOT_PHONE)}&apikey=${encodeURIComponent(env.TEXTMEBOT_APIKEY)}&text=${encodeURIComponent(text)}`;
  try {
    const r = await fetch(url);
    const body = await r.text();
    return { ok: r.ok, status: r.status, body: body.slice(0, 500) };
  } catch (e) {
    console.error('TextMeBot send error:', e);
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// Пазарни сигнали (без нужда от твоя позиция) - byte-identical копия на
// съответните pure функции от signal-logic.js: Capitulation Suite (FLUSH/BASE/
// SQUEEZE/SHIFT/IMPULSE) + WARMING Gate (WARM/HOT/SUPER + 4Ч обем + Dump
// Cascade) + MM WARMING→IMPULSE + MM x25. Виж бележката при DCA секцията по-горе
// за причината за дублиране вместо import.
// ============================================================================
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a,b) => a+b, 0) / period;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period; const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain/avgLoss));
}

function calcRSISeries(closes, period) {
  const series = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    series[i] = calcRSI(closes.slice(0, i + 1), period);
  }
  return series;
}

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

function calcTrueRangeSeries(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}
function calcATR(candles, period) {
  return calcSMA(calcTrueRangeSeries(candles), period);
}

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

// ─── "Mario – Build-Up Detector + EMA Filter" ────────────────────────────
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

function calc4hTwoBarTrend(candles) {
  const n = candles.length;
  if (n < 2) return { bull: false, bear: false };
  const last = candles[n-1], prev = candles[n-2];
  return { bull: last.close > last.open && prev.close > prev.open, bear: last.close < last.open && prev.close < prev.open };
}

function calcATRExpansion(candles, opts = {}) {
  const atrLen = opts.atrLen ?? 14, lookback = opts.lookback ?? 2;
  const currentAtr = calcATR(candles, atrLen);
  const smoothedAtr = calcSmoothedATR(candles, atrLen, lookback);
  if (currentAtr == null || smoothedAtr == null) return false;
  return currentAtr > smoothedAtr;
}

// ─── "Mario – MM-OSC Entry Companion" ────────────────────────────────────
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

function calcMMOscPullbackZone(osc, direction, opts = {}) {
  const rePullLo = opts.rePullLo ?? 48, rePullHi = opts.rePullHi ?? 55;
  if (osc == null) return false;
  if (direction === 1) return osc >= rePullLo && osc <= rePullHi;
  if (direction === -1) return osc <= (100 - rePullLo) && osc >= (100 - rePullHi);
  return false;
}

// ─── "Mario IMPULSE + CONFIRMED + GAP FILTER + BTC.D FILTER" (само IMPULSE и
// CONFIRMED - Gap/BTC.D филтрите изискват данни, които Binance API не дава) ──
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

function klinesToCandles(klines) {
  return (klines||[]).map(k => ({ openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
}

// ---- Cooldown/ARM state - в браузъра живее в module-scope обекти (survive
// while the tab is open); тук ВСЯКО cron извикване е нов isolate, затова
// състоянието се пази в KV между извикванията (по символ, JSON blob).
const WARMING_COOLDOWN_MIN = { warm: 60, hot: 60, super: 120 };
const WARMING_BOOST_HOURS = 4;
const WARMING_BOOST_PCT = 0.10;
const WARMING_DUMP_EASE = 0.85;
const MM_ARM_MINUTES = 90;
const MM_COOLDOWN_MIN = 30;
const MM_X25_COOLDOWN_MIN = 30;
// Минимална % промяна на цената спрямо предходния MM/MM x25 fire, за да се
// позволи ОБРЪЩАНЕ на посоката преди пълния cooldown да е изтекъл. Без това
// s.dir !== direction пропускаше flip веднага, независимо от цената - реален
// случай: MM x25 LONG на SOL @76.11, после MM x25 SHORT @76.06 15 мин по-късно
// (практически същата цена) - двоен "100% увереност" сигнал в двете посоки
// насред застоял диапазон (whipsaw), не истинско обръщане на тренда.
const MM_FLIP_MIN_MOVE_PCT = 0.5;
// Същата защита, но за WARMING/HOT/SUPER: `warmingTierAllowed` имаше същия
// корен бъг като старото mmCanFire - `s.dir !== direction` пропускаше
// cooldown-а при ВСЯКО обръщане на посоката, независимо от движението на
// цената (напр. WARMING ▲ последвано от WARMING ▼ 5-10 мин по-късно на
// практически същата цена - двоен подвеждащ сигнал в двете посоки).
const WARMING_FLIP_MIN_MOVE_PCT = 0.5;

function warmingTierAllowed(state, tier, direction, price) {
  const s = state.warmingCooldown?.[tier];
  if (!s) return true;
  const cooledDown = (Date.now() - s.at) >= WARMING_COOLDOWN_MIN[tier] * 60000;
  if (cooledDown) return true;
  if (s.dir === direction) return false;
  if (s.price == null || price == null) return true;
  const movePct = Math.abs((price - s.price) / s.price) * 100;
  return movePct >= WARMING_FLIP_MIN_MOVE_PCT;
}
function markWarmingFired(state, tier, direction, price) {
  if (!state.warmingCooldown) state.warmingCooldown = {};
  state.warmingCooldown[tier] = { at: Date.now(), dir: direction, price };
}
function mmCanFire(state, key, direction, coolMin, price) {
  const s = state.mmCooldown?.[key];
  if (!s) return true;
  const cooledDown = (Date.now() - s.at) >= coolMin * 60000;
  if (cooledDown) return true;
  if (s.dir === direction) return false;
  if (s.price == null || price == null) return true;
  const movePct = Math.abs((price - s.price) / s.price) * 100;
  return movePct >= MM_FLIP_MIN_MOVE_PCT;
}
function markMMFired(state, key, direction, price) {
  if (!state.mmCooldown) state.mmCooldown = {};
  state.mmCooldown[key] = { at: Date.now(), dir: direction, price };
}

// LIVE детектори (FLUSH/BASE/DISTRIBUTION/SQUEEZE/DUMP SQUEEZE/EARLY BUILD-UP/
// WARMING/HOT/SUPER/MM/MM x25/MM-OSC) продължават с плоския 20-мин cooldown -
// препращаха идентично известие на ВСЯКО 5-мин cron изпълнение, докато
// условието на свещта остане вярно, реален случай, докладван от потребителя.
// CONFIRMED/структурните детектори (SHIFT/SHIFT▼/IMPULSE/IMPULSE+ATR/CONFIRMED/
// BUILD-UP CONFIRMED/PRE-IMPULSE) вместо това пазят openTime на затворената
// свещ, която ги е задействала - "1 сигнал на затворена свещ": ако condition-ът
// остане верен през целия 20-мин прозорец и след него на СЪЩАТА свещ, вече не
// препраща втори път; нова свещ (нов openTime) веднага отключва нов сигнал,
// без да чака 20 мин. tagCanFire приема candleOpenTime само за тези тагове -
// LIVE детекторите не го подават и продължават по старата логика непроменени.
const SIGNAL_REPEAT_COOLDOWN_MIN = 20;
function tagCanFire(state, label, candleOpenTime) {
  const s = state.tagCooldown?.[label];
  if (!s) return true;
  const sAt = typeof s === 'number' ? s : s.at;
  const sCandleOpenTime = typeof s === 'number' ? undefined : s.candleOpenTime;
  if (candleOpenTime != null && sCandleOpenTime != null) {
    return sCandleOpenTime !== candleOpenTime;
  }
  return (Date.now() - sAt) >= SIGNAL_REPEAT_COOLDOWN_MIN * 60000;
}
function markTagFired(state, label, candleOpenTime) {
  if (!state.tagCooldown) state.tagCooldown = {};
  state.tagCooldown[label] = candleOpenTime != null ? { at: Date.now(), candleOpenTime } : Date.now();
}

// "Mario – Build-Up Detector + EMA Filter" - Early Build-Up на 1ч отваря 18ч
// прозорец за 4ч Confirm, а Confirm + разширяващ се ATR дава Pre-Impulse.
const BUILDUP_MAX_HOURS = 18;
const BUILDUP_COOLDOWN_HOURS = 5;

function buildUpCanArm(state) {
  const s = state.buildUpCooldown;
  if (!s) return true;
  return (Date.now() - s.at) >= BUILDUP_COOLDOWN_HOURS * 3600000;
}
function markBuildUpArmed(state) {
  state.buildUpCooldown = { at: Date.now() };
}

// "Mario – MM-OSC Entry Companion" - RE-ENTRY прозорец/cooldown, огледален на
// mmOscState/mmOscCanFire/markMMOscFired от signal-scanner.html, но върху KV state.
const MMOSC_REWINDOW_MIN = 90;
const MMOSC_COOLDOWN_MIN = 100;

function mmOscCanFire(state, dir) {
  const s = state.mmOscCooldown?.[dir];
  if (!s) return true;
  return (Date.now() - s.at) >= MMOSC_COOLDOWN_MIN * 60000;
}
function markMMOscFired(state, dir) {
  if (!state.mmOscCooldown) state.mmOscCooldown = {};
  state.mmOscCooldown[dir] = { at: Date.now() };
}

// Binance блокира Cloudflare Workers-ите на ниво WAF (HTTP 403) - затова
// заявките минават през малкия relay сървър на DigitalOcean (виж relay/README.md),
// не директно към fapi.binance.com. RELAY_URL/RELAY_TOKEN са Worker Secrets.
async function fetchKlinesWorker(env, symbol, interval, limit) {
  const r = await fetch(`${env.RELAY_URL}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&token=${encodeURIComponent(env.RELAY_TOKEN)}`);
  const bodyText = await r.text();
  if (!r.ok) {
    throw new Error(`Relay klines ${symbol} ${interval} -> HTTP ${r.status}: ${bodyText.slice(0, 300)}`);
  }
  try {
    return JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`Relay klines ${symbol} ${interval} -> non-JSON response (status ${r.status}): ${bodyText.slice(0, 300)}`);
  }
}

// Долен/горен диапазон на последните `lookback` 1ч свещи - проста прокси мярка
// за близка съпротива/подкрепа (не Fibonacci/pivot точки, само swing high/low).
function calcSupportResistance(candles, lookback = 20) {
  if (!candles.length) return { support: null, resistance: null };
  const window = candles.slice(-lookback);
  return {
    resistance: Math.max(...window.map(c => c.high)),
    support: Math.min(...window.map(c => c.low)),
  };
}

// Съотношение дълги/къси позиции (Binance "Top Trader"/"Global" account ratio,
// 1ч период) - през relay-я по същата причина като klines/ticker. Връща null
// при грешка/липсващи данни, за да не чупи известието заради спомагателна инфо.
async function fetchLongShortWorker(env, symbol) {
  try {
    const r = await fetch(`${env.RELAY_URL}/longshort?symbol=${symbol}&period=1h&token=${encodeURIComponent(env.RELAY_TOKEN)}`);
    if (!r.ok) return null;
    const data = await r.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry) return null;
    const longFrac = parseFloat(entry.longAccount), shortFrac = parseFloat(entry.shortAccount);
    if (!isFinite(longFrac) || !isFinite(shortFrac)) return null;
    return { longPct: (longFrac * 100).toFixed(1), shortPct: (shortFrac * 100).toFixed(1) };
  } catch (e) {
    return null;
  }
}

// WhatsApp/Android понякога разпознава "$" залепено директно за низ от цифри
// като телефонен/тракинг номер и чупи и визуализацията, и copy-paste (изяжда
// водещи символи - напр. "$65061.30" стана "5061.30", "$0.3520" стана
// ".3520" в реални тествани известия). toLocaleString слага разделител по
// хиляди, който чупи непрекъснатата поредица от цифри; "$" вече не е залепен
// директно за числото в известията (виж checkMarketSignals/checkDcaLevels).
function formatPrice(p) {
  if (p == null) return null;
  const decimals = p >= 100 ? 2 : p >= 1 ? 4 : 6;
  return p.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// TP % стълба, извлечена от външен VIP сигнален канал (Cornix формат): техните
// Target 1/3/4/5/7 се мапват към нашите TP1-TP5 (по изрично желание - нямаме
// втори вход/stop loss тук, защото вече имаме собствена DCA стратегия за това).
// Процентите са осреднени от два реални техни сигнала (ETH и MNT), които се
// оказаха с почти идентична %-дистанция от входа въпреки различната монета -
// значи каналът използва фиксирана относителна стълба, не абсолютни нива.
const TP_PCTS = [1.26, 2.34, 3.58, 4.52, 8.23];

function calcTakeProfitLevels(price, direction) {
  return TP_PCTS.map(pct => direction === 'long' ? price * (1 + pct / 100) : price * (1 - pct / 100));
}

// Колко пъти по-голямо трябва да е мнозинството (лонг срещу шорт контекст
// сигнали) спрямо малцинството, за да покажем посока+TP с увереност вместо
// предупреждение за смесени сигнали. 4 означава напр. 4:1 или 8:2 минава,
// 3:2 или 2:1 - не (само в известието се показва %-но разпределение).
const DIRECTION_CONFIDENCE_RATIO = 4;
// Отделен, по-строг праг само за показване на TP стълбата - самата посока
// (Посока: LONG/SHORT) може да се покаже и при 1 потвърждение (ratioOK), но
// TP1-5 изисква поне MIN_TP_CONFIRMATION_HITS реални (не cooldown-потиснати)
// сигнала в мнозинството, иначе "1 от 1 сигнал LONG" изглеждаше подвеждащо
// сигурно като "4 от 5".
const MIN_TP_CONFIRMATION_HITS = 2;

function computeDirectionConfidence(longHits, shortHits) {
  const total = longHits + shortHits;
  const longPct = total ? Math.round((longHits / total) * 100) : 0;
  const shortPct = total ? 100 - longPct : 0;
  const majority = Math.max(longHits, shortHits);
  const minority = Math.min(longHits, shortHits);
  const ratioOK = total > 0 && (minority === 0 || majority >= minority * DIRECTION_CONFIDENCE_RATIO);
  const enoughHits = majority >= MIN_TP_CONFIRMATION_HITS;
  const confident = ratioOK && enoughHits;
  const direction = longHits === shortHits ? null : (longHits > shortHits ? 'long' : 'short');
  return { direction, confident, longPct, shortPct, longHits, shortHits, total, majority, ratioOK, enoughHits };
}

async function loadSymbolState(env, symbol) {
  if (!env.ALERT_STATE) return {};
  const raw = await env.ALERT_STATE.get(`sigstate:${symbol}`);
  return raw ? JSON.parse(raw) : {};
}
async function saveSymbolState(env, symbol, state) {
  if (!env.ALERT_STATE) return;
  await env.ALERT_STATE.put(`sigstate:${symbol}`, JSON.stringify(state));
}

// Сканира един символ, обновява/пази неговото cooldown състояние в KV, и
// връща списък от ЕТИКЕТИ на сигналите, които току-що са се задействали (не
// потиснати от cooldown) - празен масив означава "нищо ново тази обиколка".
async function scanSymbolSignals(env, symbol) {
  const [k15, k5, k1h, k4h, k1d] = await Promise.all([
    // 60 (не 40) - calcConfirmedSignal изисква поне 52 15м свещи (emaMidLen 50 + 2)
    // след затворената свещ (c15Closed = 59 свещи); с 40 CONFIRMED структурно
    // никога не можеше да се задейства.
    fetchKlinesWorker(env, symbol, '15m', 60),
    fetchKlinesWorker(env, symbol, '5m', 40),
    fetchKlinesWorker(env, symbol, '1h', 60),
    fetchKlinesWorker(env, symbol, '4h', 210), // 210 - нужни за EMA200 филтъра на Build-Up Detector-а
    fetchKlinesWorker(env, symbol, '1d', 20),
  ]);
  const c15 = klinesToCandles(k15), c5 = klinesToCandles(k5), c1h = klinesToCandles(k1h);
  const c4h = klinesToCandles(k4h), c1d = klinesToCandles(k1d);
  // CONFIRMED/структурни детектори (SHIFT/SHIFT▼/IMPULSE/IMPULSE+ATR/CONFIRMED/
  // BUILD-UP CONFIRMED/PRE-IMPULSE) трябва да гледат само последната ЗАТВОРЕНА
  // свещ, за да не се появяват/изчезват насред текущата незатворена свещ.
  // EARLY/LIVE детекторите (EARLY BUILD-UP, WARMING/HOT/SUPER, MM/MM x25/MM-OSC)
  // остават на живите candles (c1h/c5/c15) - целта им е ранно предупреждение.
  const c15Closed = c15.slice(0, -1);
  const c5Closed = c5.slice(0, -1);
  const c1hClosed = c1h.slice(0, -1);
  const c4hClosed = c4h.slice(0, -1);

  const rsi4h = c4h.length ? calcRSI(c4h.map(x=>x.close), 14) : null;
  const rsi1d = c1d.length ? calcRSI(c1d.map(x=>x.close), 14) : null;
  const htfExtreme = rsi4h!=null && rsi1d!=null && rsi4h<35 && rsi1d<35;
  const htfOverbought = rsi4h!=null && rsi1d!=null && rsi4h>65 && rsi1d>65;

  const flush = calcFlushSignal(c15, htfExtreme);
  const blowoff = calcBlowoffSignal(c15, htfOverbought);
  const base = calcBaseSignal(c1h, htfExtreme);
  const distribution = calcDistributionSignal(c1h, htfOverbought);
  const squeeze = calcSqueezeSignal(c5);
  const dumpSqueeze = calcDumpSqueezeSignal(c5);
  const shift = calcShiftSignal(c1hClosed);
  const shiftDown = calcShiftDownSignal(c1hClosed);
  const impulse = calcImpulseSignal(c1hClosed, flush);
  // openTime на съответната затворена свещ за всеки CONFIRMED/структурен таг -
  // ползва се от tagCanFire/markTagFired за "1 сигнал на затворена свещ" (виж
  // бележката там). LIVE таговете по-долу не пращат candleTime.
  const shiftCandleTime = c1hClosed.length ? c1hClosed[c1hClosed.length - 1].openTime : null;
  const confirmedCandleTime = c15Closed.length ? c15Closed[c15Closed.length - 1].openTime : null;
  const impulseAtrCandleTime = c5Closed.length ? c5Closed[c5Closed.length - 1].openTime : null;
  const buildUpCandleTime = c4hClosed.length ? c4hClosed[c4hClosed.length - 1].openTime : null;

  const state = await loadSymbolState(env, symbol);

  const early = calcBuildUpEarly(c1h);
  if ((early.long || early.short) && buildUpCanArm(state)) {
    state.buildUpWindow = { until: Date.now() + BUILDUP_MAX_HOURS * 3600000, dir: early.long ? 1 : -1 };
    markBuildUpArmed(state);
  }
  const buildUpWindow = state.buildUpWindow;
  const withinBuildUpWindow = !!buildUpWindow && Date.now() < buildUpWindow.until;
  const trend4h = calc4hTwoBarTrend(c4hClosed);
  const emaFilter = calcEmaTrendFilter(c4hClosed);
  const buildUpConfirmLong = withinBuildUpWindow && buildUpWindow.dir === 1 && trend4h.bull && emaFilter.bull;
  const buildUpConfirmShort = withinBuildUpWindow && buildUpWindow.dir === -1 && trend4h.bear && emaFilter.bear;
  if (buildUpConfirmLong || buildUpConfirmShort) state.buildUpWindow = null;
  const buildUpAtrExpanding = calcATRExpansion(c4hClosed);
  const preImpulseLong = buildUpConfirmLong && buildUpAtrExpanding;
  const preImpulseShort = buildUpConfirmShort && buildUpAtrExpanding;

  const bigVol4h = calc4HBigVolume(c4h);
  if (bigVol4h.active) {
    const dirVal = bigVol4h.direction === 'up' ? 1 : -1;
    state.warmingBoost = { until: Date.now() + WARMING_BOOST_HOURS*3600000, dir: dirVal };
  }
  const boost = state.warmingBoost;
  const boostActive = !!boost && Date.now() < boost.until;
  const easeFactor = boostActive ? (1 - WARMING_BOOST_PCT) : 1;
  const dumpCascade = calcDumpCascade(c15);
  const warming = calcWarmingTier(c1h, { easeFactor });
  const warmPrice = c1h.length ? c1h[c1h.length - 1].close : null;
  let warmTier = 'none';
  if (warming.tier !== 'none' && warmingTierAllowed(state, warming.tier, warming.direction, warmPrice)) {
    warmTier = warming.tier;
    markWarmingFired(state, warming.tier, warming.direction, warmPrice);
  }
  const compressOK = warming.atrPct != null && warming.atrPct <= 0.75;
  const superDownDump = dumpCascade.active && warming.direction === 'down' && compressOK
    && warming.volX != null && warming.volX >= (3.0 * easeFactor * WARMING_DUMP_EASE)
    && warmingTierAllowed(state, 'super', 'down', warmPrice);
  if (superDownDump) markWarmingFired(state, 'super', 'down', warmPrice);

  const ctx15 = calcWarmingContext(c15);
  if (ctx15.warming) state.mmArm = { until: Date.now() + MM_ARM_MINUTES * 60000 };
  const armed = !!state.mmArm && Date.now() < state.mmArm.until;
  const entry5 = calcEntryImpulse(c5);
  const x25 = calcMMx25Entry(c5);
  const mmPrice = c5.length ? c5[c5.length - 1].close : null;
  let mmLong = false, mmShort = false, mmX25Long = false, mmX25Short = false;
  if (armed && ctx15.biasLong && entry5.impulseUp && mmCanFire(state, 'mm', 1, MM_COOLDOWN_MIN, mmPrice)) { mmLong = true; markMMFired(state, 'mm', 1, mmPrice); }
  if (armed && ctx15.biasShort && entry5.impulseDn && mmCanFire(state, 'mm', -1, MM_COOLDOWN_MIN, mmPrice)) { mmShort = true; markMMFired(state, 'mm', -1, mmPrice); }
  if (armed && ctx15.biasLong && x25.long && mmCanFire(state, 'x25', 1, MM_X25_COOLDOWN_MIN, mmPrice)) { mmX25Long = true; markMMFired(state, 'x25', 1, mmPrice); }
  if (armed && ctx15.biasShort && x25.short && mmCanFire(state, 'x25', -1, MM_X25_COOLDOWN_MIN, mmPrice)) { mmX25Short = true; markMMFired(state, 'x25', -1, mmPrice); }

  const oscEntry = calcMMOscEntry(c5);
  const oscS = state.mmOsc || {};
  const oscInWindow = !!oscS.windowUntil && Date.now() < oscS.windowUntil;
  if (oscInWindow && oscS.dir === 1 && calcMMOscPullbackZone(oscEntry.osc, 1)) oscS.sawPullback = true;
  if (oscInWindow && oscS.dir === -1 && calcMMOscPullbackZone(oscEntry.osc, -1)) oscS.sawPullback = true;
  const oscRawLong = oscEntry.long && mmOscCanFire(state, 'long');
  const oscRawShort = oscEntry.short && mmOscCanFire(state, 'short');
  const oscReLong = oscRawLong && oscInWindow && oscS.dir === 1 && oscS.sawPullback;
  const oscReShort = oscRawShort && oscInWindow && oscS.dir === -1 && oscS.sawPullback;
  const oscBestLong = oscRawLong && !oscReLong;
  const oscBestShort = oscRawShort && !oscReShort;
  if (oscRawLong) { markMMOscFired(state, 'long'); oscS.dir = 1; oscS.windowUntil = Date.now() + MMOSC_REWINDOW_MIN * 60000; oscS.sawPullback = false; }
  if (oscRawShort) { markMMOscFired(state, 'short'); oscS.dir = -1; oscS.windowUntil = Date.now() + MMOSC_REWINDOW_MIN * 60000; oscS.sawPullback = false; }
  state.mmOsc = oscS;

  const impulseAtr = calcImpulseAtrSignal(c5Closed);
  const confirmed = calcConfirmedSignal(c15Closed, c1hClosed);

  // fired е масив от {label, direction} обекти, не голи низове - direction
  // тук е ИЗТОЧНИКЪТ на истината за LONG/SHORT приноса на всеки сигнал (не се
  // извежда чрез повторно парсене на емоджита/текста на label по-долу).
  // longHits/shortHits НЕ се броят тук - броят се по-долу, САМО от newFired
  // (сигналите, които реално минават tagCanFire cooldown филтъра), за да не
  // влияят в %/посоката стари сигнали, потиснати заради cooldown в това
  // конкретно известие (виж TEST 1/6 в спецификацията).
  const fired = [];
  if (flush) fired.push({ label: '💥 FLUSH', direction: 'long' });
  if (blowoff) fired.push({ label: '🔥 BLOWOFF', direction: 'short' });
  if (base) fired.push({ label: '🔵 BASE', direction: 'long' });
  if (distribution) fired.push({ label: '🟠 DISTRIBUTION', direction: 'short' });
  if (squeeze) fired.push({ label: '🟣 SQUEEZE', direction: 'long' });
  if (dumpSqueeze) fired.push({ label: '🟣 DUMP SQUEEZE', direction: 'short' });
  if (shift) fired.push({ label: '🟠 SHIFT', direction: 'long', candleTime: shiftCandleTime });
  if (shiftDown) fired.push({ label: '🟠 SHIFT ▼', direction: 'short', candleTime: shiftCandleTime });
  if (impulse.long) fired.push({ label: '🟢 IMPULSE LONG', direction: 'long', candleTime: shiftCandleTime });
  if (impulse.short) fired.push({ label: '🔴 IMPULSE SHORT', direction: 'short', candleTime: shiftCandleTime });
  if (early.long) fired.push({ label: '🟡 EARLY BUILD-UP ▲', direction: 'long' });
  if (early.short) fired.push({ label: '🟡 EARLY BUILD-UP ▼', direction: 'short' });
  if (buildUpConfirmLong) fired.push({ label: '🟢 BUILD-UP CONFIRMED ▲', direction: 'long', candleTime: buildUpCandleTime });
  if (buildUpConfirmShort) fired.push({ label: '🔴 BUILD-UP CONFIRMED ▼', direction: 'short', candleTime: buildUpCandleTime });
  if (preImpulseLong) fired.push({ label: '🚀 PRE-IMPULSE ▲', direction: 'long', candleTime: buildUpCandleTime });
  if (preImpulseShort) fired.push({ label: '💥 PRE-IMPULSE ▼', direction: 'short', candleTime: buildUpCandleTime });
  if (warmTier === 'warm') fired.push({ label: `🔵 WARMING ${warming.direction === 'up' ? '▲' : '▼'}`, direction: warming.direction === 'up' ? 'long' : 'short' });
  if (warmTier === 'hot') fired.push({ label: `🟠 HOT ${warming.direction === 'up' ? '▲' : '▼'}`, direction: warming.direction === 'up' ? 'long' : 'short' });
  if (warmTier === 'super') fired.push({ label: `${warming.direction === 'up' ? '🟢' : '🔴'} SUPER ${warming.direction === 'up' ? '▲' : '▼'}`, direction: warming.direction === 'up' ? 'long' : 'short' });
  if (superDownDump) fired.push({ label: '🚨 SUPER DOWN (DUMP)', direction: 'short' });
  if (mmLong) fired.push({ label: '🟢 MM LONG', direction: 'long' });
  if (mmShort) fired.push({ label: '🔴 MM SHORT', direction: 'short' });
  if (mmX25Long) fired.push({ label: '💎 MM x25 LONG', direction: 'long' });
  if (mmX25Short) fired.push({ label: '💀 MM x25 SHORT', direction: 'short' });
  if (oscBestLong) fired.push({ label: '🟢▲ MM-OSC BEST LONG', direction: 'long' });
  if (oscBestShort) fired.push({ label: '🔴▼ MM-OSC BEST SHORT', direction: 'short' });
  if (oscReLong) fired.push({ label: '🟢△ MM-OSC RE-LONG', direction: 'long' });
  if (oscReShort) fired.push({ label: '🔴▽ MM-OSC RE-SHORT', direction: 'short' });
  if (impulseAtr.long) fired.push({ label: '⚡ IMPULSE+ATR ▲', direction: 'long', candleTime: impulseAtrCandleTime });
  if (impulseAtr.short) fired.push({ label: '⚡ IMPULSE+ATR ▼', direction: 'short', candleTime: impulseAtrCandleTime });
  if (confirmed.long) fired.push({ label: '✅ CONFIRMED ▲', direction: 'long', candleTime: confirmedCandleTime });
  if (confirmed.short) fired.push({ label: '✅ CONFIRMED ▼', direction: 'short', candleTime: confirmedCandleTime });

  const newFired = fired.filter(sig => tagCanFire(state, sig.label, sig.candleTime));
  newFired.forEach(sig => markTagFired(state, sig.label, sig.candleTime));
  const longHits = newFired.filter(sig => sig.direction === 'long').length;
  const shortHits = newFired.filter(sig => sig.direction === 'short').length;

  const price = c5.length ? c5[c5.length - 1].close : null;
  const { support, resistance } = calcSupportResistance(c1h, 20);
  const confidence = computeDirectionConfidence(longHits, shortHits);

  await saveSymbolState(env, symbol, state);

  return { fired: newFired.map(sig => sig.label), price, support, resistance, ...confidence };
}

// ---- Пазарни сигнали следене (извиква се от scheduled()) -------------------
// За разлика от checkDcaLevels(), сканира ВСИЧКИ записи от WATCHLIST -
// entryPrice/side не са нужни тук (следим монетата, не конкретна позиция).
async function checkMarketSignals(env, watchlist = WATCHLIST) {
  for (const pos of watchlist) {
    try {
      const { fired, price, support, resistance, direction, longPct, shortPct, longHits, shortHits, majority, ratioOK, enoughHits } = await scanSymbolSignals(env, pos.symbol);
      if (fired.length > 0) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const longShort = await fetchLongShortWorker(env, pos.symbol);
        const lines = [`🔥 ${symbolNoUsdt}`];
        if (price != null) lines.push(`💰 Цена: ${formatPrice(price)} USD`);
        // Три ясни състояния (виж спецификацията, т.13): A) ясна посока + доста
        // потвърждения -> Посока+Сигнали%+Потвърждения+TP1-5; B) ясна посока, но
        // под MIN_TP_CONFIRMATION_HITS -> същото без TP, вместо това предупреждение;
        // C) смесени сигнали (ratio не минава) -> "СМЕСЕНИ СИГНАЛИ", без TP.
        // "% от сигналите"/"100% увереност" НЕ се пише никъде - процентът е ясно
        // надписан "Сигнали: LONG X% / SHORT Y%", не вероятност за успех.
        if (direction && ratioOK) {
          lines.push(`📍 Посока: ${direction === 'long' ? 'LONG 🔵' : 'SHORT 🔴'}`);
          lines.push(`📊 Сигнали: LONG ${longPct}% / SHORT ${shortPct}%`);
          lines.push(`✅ Потвърждения: ${longHits} LONG / ${shortHits} SHORT`);
          if (enoughHits) {
            if (price != null) {
              calcTakeProfitLevels(price, direction).forEach((tp, i) => lines.push(`🎯 TP${i + 1}: ${formatPrice(tp)} USD`));
            }
          } else {
            lines.push(`⚠️ Само ${majority} потвърждение — TP не се показва`);
          }
        } else {
          lines.push(`⚠️ СМЕСЕНИ СИГНАЛИ`);
          lines.push(`📊 Сигнали: LONG ${longPct}% / SHORT ${shortPct}%`);
          lines.push(`✅ Потвърждения: ${longHits} LONG / ${shortHits} SHORT`);
        }
        if (resistance != null) lines.push(`🔺 Съпротива: ${formatPrice(resistance)} USD`);
        if (support != null) lines.push(`🔻 Подкрепа: ${formatPrice(support)} USD`);
        if (longShort) lines.push(`⚖️ Long/Short: ${longShort.longPct}% / ${longShort.shortPct}%`);
        lines.push('──────────');
        lines.push(...fired);
        await sendWhatsApp(env, lines.join('\n'));
      }
    } catch (e) { console.error(`Signal scan error for ${pos.symbol}: ${e.message}`); }
  }
}

// ---- DCA ниво следене (извиква се от scheduled()) --------------------------
async function checkDcaLevels(env, watchlist = WATCHLIST) {
  for (const pos of watchlist) {
    if (!pos.entryPrice || !pos.side) continue;
    try {
      const r = await fetch(`${env.RELAY_URL}/ticker?symbol=${pos.symbol}&token=${encodeURIComponent(env.RELAY_TOKEN)}`);
      const d = await r.json();
      const price = parseFloat(d.price);
      if (!price) continue;
      const symbolNoUsdt = pos.symbol.replace('USDT','');
      const steps = calcDCALevels(pos.entryPrice, pos.side, symbolNoUsdt);
      for (const step of steps) {
        if (step.step === 0) continue; // ВХОД е референтна точка, не тригер
        const crossed = pos.side === 'long' ? price <= step.levelPrice : price >= step.levelPrice;
        if (!crossed) continue;
        const kvKey = `dca:${pos.symbol}:${step.step}`;
        const last = env.ALERT_STATE ? await env.ALERT_STATE.get(kvKey) : null;
        if (last && (Date.now() - parseInt(last, 10)) < DCA_ALERT_COOLDOWN_MS) continue;
        const dirLabel = pos.side === 'long' ? 'LONG' : 'SHORT';
        await sendWhatsApp(env, `📉 ${symbolNoUsdt} (${dirLabel}) достигна ${step.label}\nЦена: ${formatPrice(price)} USD\nНиво: ${formatPrice(step.levelPrice)} USD\nСредна цена след ниво: ${formatPrice(step.avgPrice)} USD`);
        if (env.ALERT_STATE) await env.ALERT_STATE.put(kvKey, String(Date.now()));
      }
    } catch (e) { console.error(`DCA check error for ${pos.symbol}: ${e.message}`); }
  }
}

export { calcDCALevels, checkDcaLevels, sendWhatsApp, scanSymbolSignals, checkMarketSignals };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const search = url.search;

    if (path.startsWith("/yahoo/")) {
      const symbol = path.replace("/yahoo/", "");
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
      const response = await fetch(yahooUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
        }
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    if (path.startsWith("/football/")) {
      const footballPath = path.replace("/football", "");
      const footballUrl = `https://api.football-data.org/v4${footballPath}${search}`;
      const response = await fetch(footballUrl, {
        headers: {
          "X-Auth-Token": env.FOOTBALL_DATA_TOKEN
        }
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    if (path.startsWith("/apisports/")) {
      const apiPath = path.replace("/apisports", "");
      const apiUrl = `https://v3.football.api-sports.io${apiPath}${search}`;
      const response = await fetch(apiUrl, {
        headers: {
          "x-apisports-key": env.APISPORTS_KEY
        }
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    if (path === "/tv-alert" && (request.method === "POST" || request.method === "GET")) {
      const suppliedToken = (url.searchParams.get("token") || "").trim();
      const expectedToken = (env.TV_ALERT_TOKEN || "").trim();
      // fail-closed: ако TV_ALERT_TOKEN secret-ът липсва, expectedToken е "" и
      // старата проверка `expectedToken && ...` се прескачаше изцяло, пускайки
      // всякакви заявки без токен. Сега липсващ secret също отказва достъп.
      if (!expectedToken || suppliedToken !== expectedToken) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      // GET - за ръчно тестване директно от адресната лента на браузъра (query params
      // вместо JSON тяло). Реалният TradingView webhook винаги праща POST с JSON.
      let payload;
      if (request.method === "GET") {
        payload = Object.fromEntries(url.searchParams.entries());
      } else {
        try {
          payload = JSON.parse(await request.text());
        } catch (e) {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
      const val = (v, digits) => v == null ? "?" : (digits != null ? Number(v).toFixed(digits) : v);
      const text = `🔭 ALT CYCLE RADAR\nФаза: ${payload.phase || "?"}\nScore: ${val(payload.score, 1)}/100\n\n`
        + `BTC.D: ${val(payload.btcD, 2)}%\nALT/BTC: ${val(payload.altBtc, 4)}\n`
        + `Breadth 30/60/90: ${val(payload.breadth30, 0)}/${val(payload.breadth60, 0)}/${val(payload.breadth90, 0)}\n\n`
        + `Дата: ${payload.time || "?"}`;
      const cmResult = await sendWhatsApp(env, text);
      return new Response(JSON.stringify({ ok: true, callmebot: cmResult }), { headers: { "Content-Type": "application/json" } });
    }

    // Whitelist за CoinGlass прокси-то: без него ВСЕКИ path, който не съвпадне
    // с /yahoo, /football, /apisports, /tv-alert по-горе, минаваше директно
    // към CoinGlass с нашия платен CG_API_KEY - всеки, който знае Worker URL-а,
    // можеше да го ползва като безплатен прокси и да изразходва квотата ни.
    // В момента никой активен клиент (signal-scanner.html/football.html) не
    // ползва тази прокси функция (OI данните минават директно през Binance),
    // затова списъкът е празен - добави тук конкретни пътища, ако някога
    // потрябва отново реален CoinGlass proxy caller.
    const ALLOWED_COINGLASS_PATHS = [];
    if (!ALLOWED_COINGLASS_PATHS.some(p => path.startsWith(p))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      });
    }
    const target = "https://open-api-v4.coinglass.com" + path + search;
    const response = await fetch(target, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        "CG-API-KEY": env.CG_API_KEY
      }
    });
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([checkDcaLevels(env), checkMarketSignals(env)]));
  }
};
