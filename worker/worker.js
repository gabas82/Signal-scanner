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

// Wilder RMA изглаждане (alpha = 1/period), не обикновена SMA на последните
// `period` разлики - TradingView ta.rsi() ползва точно тази смяна и носи
// напред цялата история с експоненциално затихващо тегло, докато старата
// версия гледаше само последния прозорец без памет отвъд него (реален пример:
// Worker RSI 28.8 vs TradingView RSI 30.3 на един и същ момент). За масив с
// точно period+1 стойности резултатът е идентичен на старата SMA версия
// (само seed стъпката, без допълнително изглаждане). Byte-identical копие на
// същата промяна в signal-logic.js.
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

// PRIORITY 4 от финалния анализ - линейна O(n) версия вместо предишната
// O(n^2): старата имплементация викаше calcRSI(closes.slice(0, i + 1), period)
// за ВСЯКА позиция, което означава пълно преизчисляване на Wilder RMA
// изглаждането от началото на масива на всеки индекс (нарастващо quadratic
// с по-голямата история от PRIORITY 3/т.8 - 200-500 свещи вместо 20-60).
// Тук seed стъпката (avgGain/avgLoss от closes[1..period]) се прави ВЕДНЪЖ,
// после Wilder RMA се пренася напред инкрементално - същата рекурсия като
// calcRSI по-горе, само изчислена веднъж, не преповторена за всеки индекс.
// Резултатът е byte-identical на старата версия (проверено с === сравнение
// на всеки индекс за няколко дължини/периода в отделен sanity скрипт) -
// самата Wilder формула не е променена, само начинът на изчисление.
function calcRSISeries(closes, period) {
  const n = closes.length;
  const series = new Array(n).fill(null);
  if (n < period + 1) return series;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  series[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    series[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
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
// Wilder RMA на True Range (същото изглаждане като calcRSI по-горе, а не
// плъзгаща SMA само на последния прозорец) - за да съвпада с TradingView
// ta.atr(). При масив с точно `period` TR стойности резултатът е идентичен
// на старата SMA версия (само seed, без допълнително изглаждане). Byte-identical
// копие на същата промяна в signal-logic.js.
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
const WARMING_COOLDOWN_MIN = { warm: 60, hot: 60, super: 120, superDown: 120 };
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

// CONFIRMED/структурните детектори (SHIFT/SHIFT▼/IMPULSE/IMPULSE+ATR/CONFIRMED/
// BUILD-UP CONFIRMED/PRE-IMPULSE) пазят openTime на затворената свещ, която ги
// е задействала - "1 сигнал на затворена свещ": ако condition-ът остане верен
// през целия прозорец и след него на СЪЩАТА свещ, вече не препраща втори път;
// нова свещ (нов openTime) веднага отключва нов сигнал. tagCanFire/markTagFired
// се ползват САМО за тези - LIVE детекторите вместо това ползват
// isNewLiveEvent/markLiveSeen по-долу (виж бележката там).
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

// LIVE детектори (FLUSH/BASE/DISTRIBUTION/SQUEEZE/DUMP SQUEEZE/EARLY BUILD-UP/
// WARMING/HOT/SUPER/SUPER DOWN/MM/MM x25/MM-OSC - всички, които НЕ подават
// candleOpenTime) преди ползваха същия плосък 20-мин cooldown като по-горе -
// проблем: ако condition-ът остане непрекъснато вярно повече от 20 мин (напр.
// SUPER LONG активен 13:00->13:20 без прекъсване), 20-мин таймера просто
// изтичаше и сигналът се връщаше обратно в newFired, макар нищо ново реално
// да не се е случило - комбинирано с Active Signal Memory това можеше да
// прати ВТОРО WhatsApp известие за същото продължаващо състояние (виж
// PRIORITY 1 от финалния анализ). Сега вместо "мина ли Х минути", следим
// НЕПРЕКЪСНАТОСТ на присъствието: state.liveSignalState[label].lastSeenAt се
// опреснява на ВСЕКИ тик, докато condition-ът е верен (за да не изтече
// паметта на активното доказателство - виж updateActiveSignals по-долу, което
// вече получава ВСИЧКИ текущо-верни LIVE сигнали, не само новите). Само ако
// мине повече от LIVE_PRESENCE_GAP_MS (толерира 1 пропуснат/забавен 5-мин cron
// тик) БЕЗ да е бил виждан, следващото му появяване се брои за NEW EVENT.
const LIVE_PRESENCE_GAP_MS = 12 * 60000;
function isNewLiveEvent(state, label, now) {
  const s = state.liveSignalState?.[label];
  if (!s) return true;
  return (now - s.lastSeenAt) > LIVE_PRESENCE_GAP_MS;
}
function markLiveSeen(state, label, now) {
  if (!state.liveSignalState) state.liveSignalState = {};
  state.liveSignalState[label] = { lastSeenAt: now };
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

// Колко пъти по-голям трябва да е точковият резултат на мнозинството спрямо
// малцинството, за да покажем посока+TP с увереност вместо предупреждение за
// смесени сигнали. 4 означава напр. 4:1 или 8:2 минава, 3:2 или 2:1 - не
// (само в известието се показва %-но разпределение). Прагът остава 4, но
// вече сравнява ТЕГЛОВНИ точки (виж SIGNAL_WEIGHTS/SIGNAL_FAMILY_MAX по-долу),
// не суров брой сигнали - иначе 1 слаб EARLY BUILD-UP (0.5т) срещу 1 силен
// CONFIRMED (2.0т) щеше да се брои 1:1 наравно, макар CONFIRMED да е 4х
// по-силно доказателство.
const DIRECTION_CONFIDENCE_RATIO = 4;
// Всеки сигнал носи собствена тежест вместо да брои за "1" - по-слаб/ранен
// сигнал (EARLY BUILD-UP/WARMING) тежи по-малко от структурно потвърждение
// (CONFIRMED/PRE-IMPULSE). Числата са по подадената спецификация; не пипай
// без нови натрупани реални резултати.
const SIGNAL_WEIGHTS = {
  flush: 1.25, blowoff: 1.25, base: 1.25, distribution: 1.25,
  squeeze: 1.00, dumpSqueeze: 1.00,
  shift: 1.25, shiftDown: 1.25,
  impulse: 1.75, impulseAtr: 2.00,
  earlyBuildUp: 0.50, buildUpConfirmed: 2.00, preImpulse: 2.50,
  warming: 0.50, hot: 1.00, super: 1.50, superDown: 1.50,
  mm: 1.50, mmX25: 1.75, mmOscBest: 1.50, mmOscRe: 1.25,
  confirmed: 2.00,
};
// Колко минути даден сигнал остава "активен" в ACTIVE SIGNAL MEMORY (виж
// updateActiveSignals/getActiveSignals по-долу) - LIVE детектори по-кратко
// (60 мин), структурни/по-бавни таймфреймове по-дълго (90 мин на 1ч/15м база,
// 240 мин = 4ч за BUILD-UP CONFIRMED/PRE-IMPULSE, които стъпват на 4ч свещи).
const SIGNAL_MEMORY_MINUTES = {
  warming: 60, hot: 60, super: 60, superDown: 60,
  mm: 60, mmX25: 60, mmOscBest: 60, mmOscRe: 60,
  impulse: 60, impulseAtr: 60,
  shift: 90, shiftDown: 90, confirmed: 90,
  earlyBuildUp: 90,
  buildUpConfirmed: 240, preImpulse: 240,
  flush: 90, blowoff: 90, base: 90, distribution: 90,
  squeeze: 60, dumpSqueeze: 60,
};
// Корелирани семейства - няколко детектора от едно и също семейство често
// реагират на СЪЩОТО реално движение (volume/ATR/EMA/candle body/breakout),
// затова не се сумират безкрайно, а се ограничават с таван на семейство: една
// силна зелена свещ, която пали и SUPER, и MM, и MM x25 едновременно, не е 3
// напълно независими доказателства, а 1 силно движение, видяно през 3 лещи.
// EARLY BUILD-UP умишлено няма семейство (family: null по-долу) - той е
// единственият тригер на отделната, защитена Build-Up верига (не пипана в
// тази промяна) и не ползва общите volume/ATR данни на Family A.
const SIGNAL_FAMILY_MAX = {
  volumeMomentum: 1.50, // WARMING/HOT/SUPER/SUPER DOWN/SQUEEZE/DUMP SQUEEZE
  mmEngine: 2.00,        // MM/MM x25/MM-OSC BEST/MM-OSC RE-ENTRY
  impulseFamily: 2.00,   // IMPULSE/IMPULSE+ATR
  structure: 3.00,       // SHIFT/BUILD-UP CONFIRMED/CONFIRMED/PRE-IMPULSE
  extreme: 2.00,         // FLUSH/BASE/BLOWOFF/DISTRIBUTION
};
// Сумира теглата на всички newFired сигнали в дадена посока, ограничавайки
// всяко семейство до неговия таван, преди да ги събере - сигнали БЕЗ family
// (EARLY BUILD-UP) се броят изцяло, без таван.
function computeFamilyCappedScore(signals, direction) {
  const byFamily = {};
  let uncapped = 0;
  for (const sig of signals) {
    if (sig.direction !== direction) continue;
    if (sig.family) byFamily[sig.family] = (byFamily[sig.family] || 0) + sig.weight;
    else uncapped += sig.weight;
  }
  let total = uncapped;
  for (const family in byFamily) total += Math.min(byFamily[family], SIGNAL_FAMILY_MAX[family]);
  return total;
}

// ACTIVE SIGNAL MEMORY - преди тази промяна longScore/shortScore се смятаха
// само от newFired (тик по тик), затова последователно развиващо се движение
// (WARMING @13:00 -> MM @13:05 -> CONFIRMED @13:15) никога не се комбинираше
// в общ резултат - всеки сигнал сам пали cooldown-а си и излиза от newFired
// на следващите тикове, преди да успее да се "срещне" с останалите. Сега
// всеки нов сигнал се пази в state.activeSignals (keyed по label, за dedup -
// повторен fire на СЪЩИЯ label просто обновява timestamp/expiresAt, не се
// трупа многократно), с изтичане според типа му (SIGNAL_MEMORY_MINUTES).
// longScore/shortScore се смятат от ВСИЧКИ още неизтекли активни сигнали (нови
// + запомнени), но family caps продължават да важат непроменени - паметта не
// заобикаля SIGNAL_FAMILY_MAX. Разни посоки (LONG memory + нов SHORT сигнал)
// НЕ се трият автоматично една друга - и двете участват в computeDirectionConfidence,
// за да могат да покажат СМЕСЕНИ СИГНАЛИ коректно.
function updateActiveSignals(state, newFired) {
  if (!state.activeSignals) state.activeSignals = {};
  const now = Date.now();
  for (const sig of newFired) {
    const minutes = SIGNAL_MEMORY_MINUTES[sig.type] ?? SIGNAL_REPEAT_COOLDOWN_MIN;
    state.activeSignals[sig.label] = {
      label: sig.label, direction: sig.direction, weight: sig.weight, family: sig.family,
      at: now, expiresAt: now + minutes * 60000,
    };
  }
}
// Връща масив от още неизтеклите активни сигнали (за computeFamilyCappedScore)
// и същевременно чисти изтеклите записи от state (не растат безкрайно в KV).
function getActiveSignals(state) {
  if (!state.activeSignals) return [];
  const now = Date.now();
  const active = [];
  for (const label in state.activeSignals) {
    const s = state.activeSignals[label];
    if (s.expiresAt > now) active.push(s);
    else delete state.activeSignals[label];
  }
  return active;
}
// Заменя старото MIN_TP_CONFIRMATION_HITS (брой сигнали) - сега сравнява
// точковия резултат на мнозинството. 1 слаб сигнал (0.5-1.25т) вече не може
// сам да отключи TP, но 1 наистина силно структурно потвърждение (CONFIRMED/
// PRE-IMPULSE, 2.0-2.5т) вече може - точно обратното на старата система,
// където И двата случая се брояха еднакво като "1 сигнал".
const MIN_TP_SCORE = 3.0;
// Отделен, по-нисък праг само за ДАЛИ изобщо да пратим WhatsApp известие -
// самотен слаб/ранен сигнал (WARMING/EARLY BUILD-UP 0.5т, MM 1.5т, MM x25
// 1.75т) вече не праща цяло известие (с цена/съпротива/подкрепа/Long-Short)
// сам по себе си - реален случай, докладван от потребителя: ~100 известия
// от 10ч насам, повечето под този праг, чист шум. WARMING/EARLY BUILD-UP си
// остават "рано предупреждение" - продължават да се смятат/пазят в KV
// cooldown-а нормално, само НЕ пращат известие, докато не се съберат с още
// нещо (или сами по себе си не достигнат по-силен сигнал като CONFIRMED/
// PRE-IMPULSE, 2.0-2.5т). Различен от MIN_TP_SCORE (3.0), който само решава
// дали TP1-5 се показват В известие, което вече се праща.
const MIN_NOTIFY_SCORE = 2.5;

function computeDirectionConfidence(longScore, shortScore) {
  const total = longScore + shortScore;
  const longPct = total ? Math.round((longScore / total) * 100) : 0;
  const shortPct = total ? 100 - longPct : 0;
  const majority = Math.max(longScore, shortScore);
  const minority = Math.min(longScore, shortScore);
  const ratioOK = total > 0 && (minority === 0 || majority >= minority * DIRECTION_CONFIDENCE_RATIO);
  const enoughScore = majority >= MIN_TP_SCORE;
  const confident = ratioOK && enoughScore;
  const direction = longScore === shortScore ? null : (longScore > shortScore ? 'long' : 'short');
  return { direction, confident, longPct, shortPct, longScore, shortScore, total, majority, ratioOK, enoughScore };
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

// Сканира един символ, обновява/пази неговото cooldown+ACTIVE SIGNAL MEMORY
// състояние в KV, и връща { newFired, activeFired, ... } - newFired са
// етикетите на ГЕНУИННО новите събития този тик (нова затворена свещ за
// структурните тагове, ново появяване/реокуряне за LIVE тагове - виж
// tagCanFire/isNewLiveEvent по-горе; празен масив = "нищо ново тази
// обиколка"); activeFired са ВСИЧКИ още неизтекли активни сигнали (текущо
// верни ОТ ТОЗИ тик, нови И продължаващи, + запомнени от предишни тикове),
// от които реално се смятат longScore/shortScore.
async function scanSymbolSignals(env, symbol) {
  const [k15, k5, k1h, k4h, k1d] = await Promise.all([
    // т.8 от анализа - увеличена история (от 60/40/60/210/20) за по-стабилно
    // Wilder RSI/ATR "warm-up" (Wilder RMA носи затихваща памет от ЦЯЛАТА
    // подадена история, не само последния period+1 прозорец - колкото повече
    // свещи назад, толкова по-близо до TradingView стойността за същия момент)
    // и по-стабилни EMA20/EMA50/EMA200. Самите Wilder формули (calcRSI/calcATR)
    // НЕ са пипнати тук - само броят подадени свещи.
    fetchKlinesWorker(env, symbol, '15m', 200),
    fetchKlinesWorker(env, symbol, '5m', 200),
    fetchKlinesWorker(env, symbol, '1h', 250),
    fetchKlinesWorker(env, symbol, '4h', 500), // нужни за EMA200 филтъра на Build-Up Detector-а
    fetchKlinesWorker(env, symbol, '1d', 200),
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
  // т.9 - early.long и early.short теоретично могат да са ВЕДНЪЖ и двете true
  // (независими условия), при което старото `dir: early.long ? 1 : -1` тихо
  // предпочиташе LONG без основание. Сега арминг на Build-Up прозореца става
  // само при ЕДНОЗНАЧНА посока (long !== short) - EARLY BUILD-UP сигналите
  // по-долу (fired.push) продължават да излизат и в двете посоки нормално,
  // само самият прозорец не се арм-ва в двусмисления случай.
  if ((early.long !== early.short) && buildUpCanArm(state)) {
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
  // Directional Warming Boost (PRIORITY 2 от финалния анализ) - boostActive
  // сам по себе си не казва НИЩО за посоката на текущото движение, само че
  // ИМА активен 4H BIG VOLUME boost в НЯКАКВА посока (boost.dir). Старият код
  // прилагаше easeFactor безусловно щом boostActive е true, независимо дали
  // boost.dir съвпада с посоката на свещта, която calcWarmingTier/superDownDump
  // всъщност оценяват в момента - 4H BIG VOLUME UP можеше да улесни прага и за
  // WARMING/SUPER DOWN движение, което е нелогично (up обем не би трябвало да
  // прави down движенията по-лесни за отключване). Директната посока на
  // ТЕКУЩАТА последна 1ч свещ се смята тук по същата формула като вътре в
  // calcWarmingTier (last.close > last.open), за да може easeFactor да се
  // прецени ПРЕДИ извикването - warmingPreviewDirection винаги съвпада с
  // warming.direction по-долу, защото е точно същото сравнение върху същата
  // свещ.
  const warmingLastCandle = c1h.length ? c1h[c1h.length - 1] : null;
  const warmingPreviewDirection = warmingLastCandle
    ? (warmingLastCandle.close > warmingLastCandle.open ? 'up' : warmingLastCandle.close < warmingLastCandle.open ? 'down' : 'flat')
    : 'flat';
  const boostMatchesDirection = boostActive && (
    (boost.dir === 1 && warmingPreviewDirection === 'up') ||
    (boost.dir === -1 && warmingPreviewDirection === 'down')
  );
  const easeFactor = boostMatchesDirection ? (1 - WARMING_BOOST_PCT) : 1;
  const dumpCascade = calcDumpCascade(c15);
  const warming = calcWarmingTier(c1h, { easeFactor });
  const warmPrice = c1h.length ? c1h[c1h.length - 1].close : null;
  // SUPER DOWN (DUMP) приоритет (т.10) - проверяваме ПЪРВО, с ОТДЕЛЕН cooldown
  // ключ ('superDown', не 'super'). Старият ред проверяваше/палеше нормалния
  // SUPER тир ПЪРВИ, който маркираше cooldown ключ 'super' с dir='down' В
  // СЪЩИЯ тик, преди superDownDump въобще да е бил проверен - warmingTierAllowed
  // за 'super'/'down' веднага виждаше s.dir === direction и връщаше false, така
  // че DUMP вариантът структурно никога не можеше да гръмне заедно с нормален
  // SUPER▼ на едно и също движение (споделен cooldown ключ = race). Сега DUMP
  // се проверява първо на собствен ключ, и ако гръмне, потиска нормалния
  // SUPER за СЪЩОТО движение (super+down) - не и HOT/WARM, които остават
  // независими и могат да гърмят паралелно с DUMP нормално.
  const compressOK = warming.atrPct != null && warming.atrPct <= 0.75;
  const superDownDump = dumpCascade.active && warming.direction === 'down' && compressOK
    && warming.volX != null && warming.volX >= (3.0 * easeFactor * WARMING_DUMP_EASE)
    && warmingTierAllowed(state, 'superDown', 'down', warmPrice);
  if (superDownDump) markWarmingFired(state, 'superDown', 'down', warmPrice);

  let warmTier = 'none';
  const superSuppressedByDump = superDownDump && warming.tier === 'super' && warming.direction === 'down';
  if (warming.tier !== 'none' && !superSuppressedByDump && warmingTierAllowed(state, warming.tier, warming.direction, warmPrice)) {
    warmTier = warming.tier;
    markWarmingFired(state, warming.tier, warming.direction, warmPrice);
  }

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

  // fired е масив от {label, direction, weight, family, candleTime, type} обекти -
  // direction/weight/family тук са ИЗТОЧНИКЪТ на истината за приноса на всеки
  // сигнал в LONG/SHORT точковия резултат (не се извежда чрез повторно
  // парсене на текста на label по-долу); type сочи към SIGNAL_MEMORY_MINUTES
  // (виж ACTIVE SIGNAL MEMORY по-горе). longScore/shortScore НЕ се смятат
  // тук - смятат се по-долу, от activeSignals (текущо-верни ОТ ТОЗИ тик +
  // още неизтекли стари сигнали от паметта), след като fired се раздели на
  // CLOSED (tagCanFire) и LIVE (isNewLiveEvent) - виж бележките там.
  const fired = [];
  if (flush) fired.push({ label: '💥 FLUSH', direction: 'long', weight: SIGNAL_WEIGHTS.flush, family: 'extreme', type: 'flush' });
  if (blowoff) fired.push({ label: '🔥 BLOWOFF', direction: 'short', weight: SIGNAL_WEIGHTS.blowoff, family: 'extreme', type: 'blowoff' });
  if (base) fired.push({ label: '🔵 BASE', direction: 'long', weight: SIGNAL_WEIGHTS.base, family: 'extreme', type: 'base' });
  if (distribution) fired.push({ label: '🟠 DISTRIBUTION', direction: 'short', weight: SIGNAL_WEIGHTS.distribution, family: 'extreme', type: 'distribution' });
  if (squeeze) fired.push({ label: '🟣 SQUEEZE', direction: 'long', weight: SIGNAL_WEIGHTS.squeeze, family: 'volumeMomentum', type: 'squeeze' });
  if (dumpSqueeze) fired.push({ label: '🟣 DUMP SQUEEZE', direction: 'short', weight: SIGNAL_WEIGHTS.dumpSqueeze, family: 'volumeMomentum', type: 'dumpSqueeze' });
  if (shift) fired.push({ label: '🟠 SHIFT', direction: 'long', weight: SIGNAL_WEIGHTS.shift, family: 'structure', candleTime: shiftCandleTime, type: 'shift' });
  if (shiftDown) fired.push({ label: '🟠 SHIFT ▼', direction: 'short', weight: SIGNAL_WEIGHTS.shiftDown, family: 'structure', candleTime: shiftCandleTime, type: 'shiftDown' });
  if (impulse.long) fired.push({ label: '🟢 IMPULSE LONG', direction: 'long', weight: SIGNAL_WEIGHTS.impulse, family: 'impulseFamily', candleTime: shiftCandleTime, type: 'impulse' });
  if (impulse.short) fired.push({ label: '🔴 IMPULSE SHORT', direction: 'short', weight: SIGNAL_WEIGHTS.impulse, family: 'impulseFamily', candleTime: shiftCandleTime, type: 'impulse' });
  // т.9 продължение - buildUpCanArm по-горе вече пази арминга на Build-Up
  // прозореца от двусмисления случай early.long===early.short===true, но
  // самите EARLY BUILD-UP▲/▼ сигнали по-долу бяха независими if-ове и
  // продължаваха да могат да гръмнат ЕДНОВРЕМЕННО в такъв случай - реално
  // наблюдавано в известие за INJ (choppy/свиващ се пазар), добавяйки 0.50т
  // едновременно в LONG и SHORT без реално основание (двете "ранни
  // предупреждения" са взаимно противоречиви, не независими доказателства).
  // Сега EARLY BUILD-UP гърми само при еднозначна посока, като арминга.
  const earlyUnambiguous = early.long !== early.short;
  if (earlyUnambiguous && early.long) fired.push({ label: '🟡 EARLY BUILD-UP ▲', direction: 'long', weight: SIGNAL_WEIGHTS.earlyBuildUp, family: null, type: 'earlyBuildUp' });
  if (earlyUnambiguous && early.short) fired.push({ label: '🟡 EARLY BUILD-UP ▼', direction: 'short', weight: SIGNAL_WEIGHTS.earlyBuildUp, family: null, type: 'earlyBuildUp' });
  if (buildUpConfirmLong) fired.push({ label: '🟢 BUILD-UP CONFIRMED ▲', direction: 'long', weight: SIGNAL_WEIGHTS.buildUpConfirmed, family: 'structure', candleTime: buildUpCandleTime, type: 'buildUpConfirmed' });
  if (buildUpConfirmShort) fired.push({ label: '🔴 BUILD-UP CONFIRMED ▼', direction: 'short', weight: SIGNAL_WEIGHTS.buildUpConfirmed, family: 'structure', candleTime: buildUpCandleTime, type: 'buildUpConfirmed' });
  if (preImpulseLong) fired.push({ label: '🚀 PRE-IMPULSE ▲', direction: 'long', weight: SIGNAL_WEIGHTS.preImpulse, family: 'structure', candleTime: buildUpCandleTime, type: 'preImpulse' });
  if (preImpulseShort) fired.push({ label: '💥 PRE-IMPULSE ▼', direction: 'short', weight: SIGNAL_WEIGHTS.preImpulse, family: 'structure', candleTime: buildUpCandleTime, type: 'preImpulse' });
  if (warmTier === 'warm') fired.push({ label: `🔵 WARMING ${warming.direction === 'up' ? '▲' : '▼'}`, direction: warming.direction === 'up' ? 'long' : 'short', weight: SIGNAL_WEIGHTS.warming, family: 'volumeMomentum', type: 'warming' });
  if (warmTier === 'hot') fired.push({ label: `🟠 HOT ${warming.direction === 'up' ? '▲' : '▼'}`, direction: warming.direction === 'up' ? 'long' : 'short', weight: SIGNAL_WEIGHTS.hot, family: 'volumeMomentum', type: 'hot' });
  if (warmTier === 'super') fired.push({ label: `${warming.direction === 'up' ? '🟢' : '🔴'} SUPER ${warming.direction === 'up' ? '▲' : '▼'}`, direction: warming.direction === 'up' ? 'long' : 'short', weight: SIGNAL_WEIGHTS.super, family: 'volumeMomentum', type: 'super' });
  if (superDownDump) fired.push({ label: '🚨 SUPER DOWN (DUMP)', direction: 'short', weight: SIGNAL_WEIGHTS.superDown, family: 'volumeMomentum', type: 'superDown' });
  if (mmLong) fired.push({ label: '🟢 MM LONG', direction: 'long', weight: SIGNAL_WEIGHTS.mm, family: 'mmEngine', type: 'mm' });
  if (mmShort) fired.push({ label: '🔴 MM SHORT', direction: 'short', weight: SIGNAL_WEIGHTS.mm, family: 'mmEngine', type: 'mm' });
  if (mmX25Long) fired.push({ label: '💎 MM x25 LONG', direction: 'long', weight: SIGNAL_WEIGHTS.mmX25, family: 'mmEngine', type: 'mmX25' });
  if (mmX25Short) fired.push({ label: '💀 MM x25 SHORT', direction: 'short', weight: SIGNAL_WEIGHTS.mmX25, family: 'mmEngine', type: 'mmX25' });
  if (oscBestLong) fired.push({ label: '🟢▲ MM-OSC BEST LONG', direction: 'long', weight: SIGNAL_WEIGHTS.mmOscBest, family: 'mmEngine', type: 'mmOscBest' });
  if (oscBestShort) fired.push({ label: '🔴▼ MM-OSC BEST SHORT', direction: 'short', weight: SIGNAL_WEIGHTS.mmOscBest, family: 'mmEngine', type: 'mmOscBest' });
  if (oscReLong) fired.push({ label: '🟢△ MM-OSC RE-LONG', direction: 'long', weight: SIGNAL_WEIGHTS.mmOscRe, family: 'mmEngine', type: 'mmOscRe' });
  if (oscReShort) fired.push({ label: '🔴▽ MM-OSC RE-SHORT', direction: 'short', weight: SIGNAL_WEIGHTS.mmOscRe, family: 'mmEngine', type: 'mmOscRe' });
  if (impulseAtr.long) fired.push({ label: '⚡ IMPULSE+ATR ▲', direction: 'long', weight: SIGNAL_WEIGHTS.impulseAtr, family: 'impulseFamily', candleTime: impulseAtrCandleTime, type: 'impulseAtr' });
  if (impulseAtr.short) fired.push({ label: '⚡ IMPULSE+ATR ▼', direction: 'short', weight: SIGNAL_WEIGHTS.impulseAtr, family: 'impulseFamily', candleTime: impulseAtrCandleTime, type: 'impulseAtr' });
  if (confirmed.long) fired.push({ label: '✅ CONFIRMED ▲', direction: 'long', weight: SIGNAL_WEIGHTS.confirmed, family: 'structure', candleTime: confirmedCandleTime, type: 'confirmed' });
  if (confirmed.short) fired.push({ label: '✅ CONFIRMED ▼', direction: 'short', weight: SIGNAL_WEIGHTS.confirmed, family: 'structure', candleTime: confirmedCandleTime, type: 'confirmed' });

  // Разделяне CLOSED-CANDLE (candleTime != null) от LIVE (candleTime == null) -
  // всеки тип ползва собствения си "ново ли е събитието" механизъм (виж
  // бележките при tagCanFire и isNewLiveEvent по-горе).
  const now = Date.now();
  const closedFiredRaw = fired.filter(sig => sig.candleTime != null);
  const liveFiredRaw = fired.filter(sig => sig.candleTime == null);

  const newClosedFired = closedFiredRaw.filter(sig => tagCanFire(state, sig.label, sig.candleTime));
  newClosedFired.forEach(sig => markTagFired(state, sig.label, sig.candleTime));

  // ВСЕКИ текущо-верен LIVE сигнал опреснява присъствието си (markLiveSeen),
  // независимо дали е ново или продължаващо събитие - иначе isNewLiveEvent
  // никога няма как да "знае", че сигналът е бил непрекъснато активен.
  const newLiveFired = liveFiredRaw.filter(sig => isNewLiveEvent(state, sig.label, now));
  liveFiredRaw.forEach(sig => markLiveSeen(state, sig.label, now));

  // newFired = само ГЕНУИННО нови събития (нова затворена свещ за структурните,
  // ново появяване/реокуряне за LIVE) - това е единственият източник за "има
  // ли изобщо нов сигнал" (виж checkMarketSignals), а не просто "минаха Х мин".
  const newFired = [...newClosedFired, ...newLiveFired];

  // ACTIVE SIGNAL MEMORY (виж updateActiveSignals/getActiveSignals по-горе) -
  // longScore/shortScore се смятат от ВСИЧКИ още неизтекли активни сигнали
  // (текущо-верни ОТ ТОЗИ тик, нови И продължаващи, + запомнени от предишни
  // тикове), не само от newFired - за да могат последователни сигнали
  // (WARMING -> MM -> CONFIRMED) реално да се съберат в общ резултат, и за да
  // не изтича паметта на едно продължаващо LIVE доказателство само защото не
  // се брои за "ново" (виж isNewLiveEvent по-горе).
  updateActiveSignals(state, [...newClosedFired, ...liveFiredRaw]);
  const activeSignals = getActiveSignals(state);
  const longScore = computeFamilyCappedScore(activeSignals, 'long');
  const shortScore = computeFamilyCappedScore(activeSignals, 'short');

  const price = c5.length ? c5[c5.length - 1].close : null;
  const { support, resistance } = calcSupportResistance(c1h, 20);
  const confidence = computeDirectionConfidence(longScore, shortScore);

  await saveSymbolState(env, symbol, state);

  return {
    newFired: newFired.map(sig => sig.label),
    activeFired: activeSignals.map(sig => sig.label),
    price, support, resistance, ...confidence,
  };
}

// ---- Пазарни сигнали следене (извиква се от scheduled()) -------------------
// За разлика от checkDcaLevels(), сканира ВСИЧКИ записи от WATCHLIST -
// entryPrice/side не са нужни тук (следим монетата, не конкретна позиция).
async function checkMarketSignals(env, watchlist = WATCHLIST) {
  for (const pos of watchlist) {
    try {
      const { newFired, activeFired, price, support, resistance, direction, longPct, shortPct, longScore, shortScore, majority, ratioOK, enoughScore } = await scanSymbolSignals(env, pos.symbol);
      // MIN_NOTIFY_SCORE - самотен слаб сигнал вече не праща цяло известие,
      // само защото нещо е "активно" (виж бележката при MIN_NOTIFY_SCORE).
      // ACTIVE SIGNAL MEMORY (т.4 от спецификацията) - стари сигнали от паметта
      // могат да УСИЛЯТ резултата (влизат в longScore/shortScore чрез
      // activeFired), но САМИ по себе си НЕ могат да породят ново известие -
      // задължително трябва да има поне един НОВ сигнал (newFired) в този тик.
      if (newFired.length > 0 && majority >= MIN_NOTIFY_SCORE) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const longShort = await fetchLongShortWorker(env, pos.symbol);
        const lines = [`🔥 ${symbolNoUsdt}`];
        if (price != null) lines.push(`💰 Цена: ${formatPrice(price)} USD`);
        // Три ясни състояния (виж спецификацията, т.13, вече на точкова база -
        // виж SIGNAL_WEIGHTS/SIGNAL_FAMILY_MAX): A) ясна посока + достатъчно
        // точки (>= MIN_TP_SCORE) -> Посока+Сигнали%+Точки+TP1-5; B) ясна
        // посока, но под MIN_TP_SCORE -> същото без TP, вместо това
        // предупреждение; C) смесени сигнали (ratio не минава) -> "СМЕСЕНИ
        // СИГНАЛИ", без TP. "% от сигналите"/"100% увереност" НЕ се пише
        // никъде - процентът е ясно надписан "Сигнали: LONG X% / SHORT Y%",
        // не вероятност за успех.
        if (direction && ratioOK) {
          lines.push(`📍 Посока: ${direction === 'long' ? 'LONG 🔵' : 'SHORT 🔴'}`);
          lines.push(`📊 Сигнали: LONG ${longPct}% / SHORT ${shortPct}%`);
          lines.push(`✅ Точки: ${longScore.toFixed(2)} LONG / ${shortScore.toFixed(2)} SHORT`);
          if (enoughScore) {
            if (price != null) {
              calcTakeProfitLevels(price, direction).forEach((tp, i) => lines.push(`🎯 TP${i + 1}: ${formatPrice(tp)} USD`));
            }
          } else {
            lines.push(`⚠️ Само ${majority.toFixed(2)} точки — TP не се показва`);
          }
        } else {
          lines.push(`⚠️ СМЕСЕНИ СИГНАЛИ`);
          lines.push(`📊 Сигнали: LONG ${longPct}% / SHORT ${shortPct}%`);
          lines.push(`✅ Точки: ${longScore.toFixed(2)} LONG / ${shortScore.toFixed(2)} SHORT`);
        }
        if (resistance != null) lines.push(`🔺 Съпротива: ${formatPrice(resistance)} USD`);
        if (support != null) lines.push(`🔻 Подкрепа: ${formatPrice(support)} USD`);
        if (longShort) lines.push(`⚖️ Long/Short: ${longShort.longPct}% / ${longShort.shortPct}%`);
        lines.push('──────────');
        // Две отделни секции (т.17) - "Нов сигнал" е ПРИЧИНАТА за това известие
        // точно сега; "Активни потвърждения" са по-стари сигнали от паметта
        // (виж ACTIVE SIGNAL MEMORY), които все още усилват точковия резултат,
        // но сами не биха пратили известие - за да е ясно кое е новото.
        lines.push('🆕 Нов сигнал:');
        lines.push(...newFired);
        const previouslyActive = activeFired.filter(label => !newFired.includes(label));
        if (previouslyActive.length > 0) {
          lines.push('🧠 Активни потвърждения:');
          lines.push(...previouslyActive);
        }
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

    // Whitelist за /football/ (PRIORITY 3 от финалния анализ): без него ВСЕКИ
    // path зад /football/ минаваше директно към football-data.org с нашия
    // FOOTBALL_DATA_TOKEN - всеки, който знае Worker URL-а, можеше да го
    // ползва като безплатен прокси и да изразходва квотата ни (аналогично на
    // вече фиксираната CoinGlass дупка). Токен (PROXY_TOKEN) НЕ е добавен
    // умишлено - football.html е публична страница на gabas82.github.io,
    // токен, вграден в публичен клиентски JS, се вижда веднага през
    // view-source и не крие нищо реално (същата причина, поради която
    // CoinGlass защитата по-долу също е чист whitelist, не token). Пътищата
    // тук са изведени директно от реалната употреба в football.html.
    const ALLOWED_FOOTBALL_PATHS = ['/competitions/', '/matches'];
    if (path.startsWith("/football/")) {
      const footballPath = path.replace("/football", "");
      if (!ALLOWED_FOOTBALL_PATHS.some(p => footballPath.startsWith(p))) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }
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

    // Whitelist за /apisports/ - същата причина/подход като /football/ по-горе.
    const ALLOWED_APISPORTS_PATHS = ['/fixtures', '/players/', '/standings'];
    if (path.startsWith("/apisports/")) {
      const apiPath = path.replace("/apisports", "");
      if (!ALLOWED_APISPORTS_PATHS.some(p => apiPath.startsWith(p))) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }
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
