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
  { symbol: 'BNBUSDT' },
  { symbol: 'XRPUSDT' },
  { symbol: 'LINKUSDT' },
  { symbol: 'NEARUSDT' },
  { symbol: 'ETCUSDT' },
  { symbol: 'AAVEUSDT' },
  { symbol: 'RENDERUSDT' },
  { symbol: 'ALGOUSDT' },
  { symbol: 'SEIUSDT' },
  { symbol: 'ARBUSDT' },
  { symbol: 'JUPUSDT' },
  { symbol: 'ENAUSDT' },
  { symbol: 'PENDLEUSDT' },
  { symbol: 'WIFUSDT' },
  { symbol: 'PEPEUSDT' },
  { symbol: 'DOGEUSDT' },
  { symbol: 'AVAXUSDT' },
  { symbol: 'FETUSDT' },
  { symbol: 'UBUSDT' },
  { symbol: 'KASUSDT' },
];

const DCA_ALERT_COOLDOWN_MS = 24 * 3600000; // не повтаря едно и също DCA ниво по-често от 24ч

// Ръчно зададени ценови зони за наблюдение - "RECLAIM/REJECTION" известие,
// когато 15м свещ или затвори НАД зоната (reclaim - бичи сигнал, зоната е
// "превзета" отгоре), или цената я тества (докосва high >= levelLow), но
// свещта пак затваря ПОД нея (rejection - мечи сигнал, зоната отблъсква).
// За разлика от WATCHLIST (следи ВСИЧКИ пазарни сигнали автоматично за всяка
// монета), тук ти сам решаваш кое ниво те интересува В МОМЕНТА - добавяш/
// махаш редове тук при нужда (label е само за четимост в известието).
const PRICE_LEVELS_WATCHLIST = [
  { symbol: 'ALGOUSDT', levelLow: 0.1038, levelHigh: 0.1042, label: 'ключова зона' },
];

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
// Логването на неуспешен HTTP отговор (добавено по-рано - виж git history)
// разкри реалната причина зад известия, които просто не пристигаха: TextMeBot
// отговаря с HTTP 403 "There is currently a limit of 1 messages per 5 seconds
// to prevent a ban from whatsapp".
const WHATSAPP_MIN_INTERVAL_MS = 5200; // малко над обявения лимит от 5 сек, за буфер
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// РЕАЛЕН БЪГ, потвърден директно от Cloudflare логовете (две HTTP 403 грешки
// със ЕДИН и същ requestId - значи от ЕДНА и съща scheduled() инвокация):
// първият опит за throttle ("прочети lastWhatsAppSendAt -> изчакай -> запиши
// lastWhatsAppSendAt") НЕ е атомарен. scheduled() пуска checkDcaLevels/
// checkMarketSignals/checkMacroSqueeze ПАРАЛЕЛНО (Promise.all) - всеки може
// да вика sendWhatsApp независимо. Две паралелни извиквания можеха да
// прочетат СЪЩИЯ стар timestamp, преди което и да е от тях да го обнови,
// да изчакат еднакво, и да пратят почти едновременно въпреки "throttle-а".
// Поправка: sendWhatsApp СИНХРОННО се "закача" към единна module-scope
// опашка (whatsAppChain) веднага при извикване, ПРЕДИ какъвто и да е await -
// JS е single-threaded, затова четенето+презаписването на whatsAppChain в
// една синхронна стъпка е атомарно дори при "паралелни" (Promise.all)
// извиквания, гарантирайки истинска сериализация на ВСИЧКИ изпращания,
// независимо от кой от трите извикващи потока идват.
let lastWhatsAppSendAt = 0;
let whatsAppChain = Promise.resolve();
function sendWhatsApp(env, text) {
  const p = whatsAppChain.then(() => sendWhatsAppSerialized(env, text));
  // .catch тук пази опашката жива - грешка на едно съобщение не бива да
  // блокира/чупи чакащите след него в опашката.
  whatsAppChain = p.catch(() => {});
  return p;
}

async function sendWhatsAppSerialized(env, text) {
  if (!env.CALLMEBOT_PHONE || !env.TEXTMEBOT_APIKEY) {
    console.error('TextMeBot secrets not set - skipping notification');
    return { ok: false, error: 'CALLMEBOT_PHONE/TEXTMEBOT_APIKEY not set' };
  }
  const waitMs = WHATSAPP_MIN_INTERVAL_MS - (Date.now() - lastWhatsAppSendAt);
  if (waitMs > 0) await sleep(waitMs);
  lastWhatsAppSendAt = Date.now();
  const url = `https://api.textmebot.com/send.php?recipient=${encodeURIComponent(env.CALLMEBOT_PHONE)}&apikey=${encodeURIComponent(env.TEXTMEBOT_APIKEY)}&text=${encodeURIComponent(text)}`;
  try {
    const r = await fetch(url);
    const body = await r.text();
    // Досега неуспешен HTTP отговор от TextMeBot (напр. изчерпан лимит, невалиден
    // recipient, изтекла връзка) минаваше напълно тихо - връщаше се {ok:false,...},
    // но НИКЪДЕ не се логваше, за разлика от мрежово изключение (catch по-долу).
    if (!r.ok) console.error(`TextMeBot non-OK response: HTTP ${r.status}: ${body.slice(0, 300)}`);
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

// Funding rate (Binance USDT-M futures) - през relay-я по същата причина като
// klines/ticker/longshort. Връща процент (fundingRate*100, напр. 0.075 значи
// 0.075%), byte-identical единица на coin.funding в signal-scanner.html
// (`parseFloat(fundR[0].fundingRate)*100`). Връща null при грешка/липсващи
// данни, за да не чупи checkMacroSqueeze заради спомагателна инфо.
async function fetchFundingWorker(env, symbol) {
  try {
    const r = await fetch(`${env.RELAY_URL}/funding?symbol=${symbol}&token=${encodeURIComponent(env.RELAY_TOKEN)}`);
    if (!r.ok) return null;
    const data = await r.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry) return null;
    const funding = parseFloat(entry.fundingRate);
    if (!isFinite(funding)) return null;
    return funding * 100;
  } catch (e) {
    return null;
  }
}

// Скорошни ликвидационни каскади (CoinGlass API - вече платен, CG_API_KEY
// secret вече съществува за проксито в fetch() handler-а по-долу). Пряко
// извикване, БЕЗ DigitalOcean relay - CoinGlass, за разлика от Binance, не
// блокира Cloudflare Workers IP-та на ниво WAF (виж съществуващия CoinGlass
// proxy път в fetch() handler-а - вика се директно, без relay, вече години).
// "side" в отговора: 1=Buy (SHORT позиции са били принудително ликвидирани ->
// форсирано купуване -> бичи натиск), 2=Sell (LONG позиции ликвидирани ->
// форсирана продажба -> мечи натиск) - огледално на CoinGlass конвенцията.
// ВАЖНО: точните query параметри и имена на полета в отговора са изведени
// САМО от публичната CoinGlass документация (docs.coinglass.com/reference/
// liquidation-order) - тази среда няма достъп до външни домейни, за да ги
// тества на живо. Прагът LIQUIDATION_CASCADE_USD_MIN е първоначална преценка,
// не калибрирана с реални данни - очаква се наблюдение и евентуална корекция
// след deploy (вижда се и в PR описанието).
// ПОПРАВКА (IDEA 08): `min_liquidation_amount` е ЗАДЪЛЖИТЕЛЕН query параметър
// според документацията, но липсваше досега - добавен с ниска стойност (1
// USD), за да не филтрира реално нищо, само да удовлетвори изискването.
// `price` полето вече също се извлича - нужно е за LIQUIDATION GRAVITY
// (виж по-долу), CASCADE логиката по-долу не го е ползвала и продължава да
// не го ползва.
async function fetchLiquidationOrdersWorker(env, symbol) {
  try {
    const r = await fetch(`https://open-api-v4.coinglass.com/api/futures/liquidation/order?symbol=${symbol}&exchange=Binance&min_liquidation_amount=1`, {
      headers: { 'CG-API-KEY': env.CG_API_KEY },
    });
    if (!r.ok) return null;
    const json = await r.json();
    const data = Array.isArray(json?.data) ? json.data : null;
    if (!data) return null;
    return data
      .map(d => ({ side: Number(d.side), usdValue: parseFloat(d.usd_value), time: Number(d.time), price: parseFloat(d.price) }))
      .filter(d => isFinite(d.usdValue) && isFinite(d.time));
  } catch (e) {
    return null;
  }
}
const LIQUIDATION_LOOKBACK_MIN = 15;
const LIQUIDATION_CASCADE_USD_MIN = 500000; // 500хил. USD - първоначален праг, нужна калибрация с реални данни
function calcLiquidationCascade(orders, opts = {}) {
  const lookbackMin = opts.lookbackMin ?? LIQUIDATION_LOOKBACK_MIN;
  const usdMin = opts.usdMin ?? LIQUIDATION_CASCADE_USD_MIN;
  if (!orders || !orders.length) return { bullish: false, bearish: false, buySumUsd: 0, sellSumUsd: 0 };
  const cutoff = Date.now() - lookbackMin * 60000;
  let buySumUsd = 0, sellSumUsd = 0;
  for (const o of orders) {
    if (o.time < cutoff) continue;
    if (o.side === 1) buySumUsd += o.usdValue;
    else if (o.side === 2) sellSumUsd += o.usdValue;
  }
  return { bullish: buySumUsd >= usdMin, bearish: sellSumUsd >= usdMin, buySumUsd, sellSumUsd };
}

// ═══ "SPARK" - ранно откриване ПРЕДИ импулса ═══════════════════════════════
// ВАЖНО: НЕ е същото като съществуващия "🚀 PRE-IMPULSE" таг по-долу (Etap 3
// от Build-Up Detector-а) - онзи е ПОСЛЕДНАТА стъпка от вече потвърден 4ч
// build-up (build-up confirm + ATR expansion), тук говорим за много по-ранен
// момент - ПРЕДИ дори Early Build-Up да се задейства, докато капиталът/
// позиционирането тепърва започват да се променят (OI/обем ускоряват,
// докато цената още не е направила голямо движение). Именуваме го SPARK, за
// да не се бърка с вече съществуващото значение на PRE-IMPULSE.
// Byte-identical копие на функциите от signal-logic.js (Scanner UI) - същата
// конвенция както при цялата останала PHASE CYCLE ENGINE логика по-долу.
function calcOiMultiDelta(oiHist) {
  const n = oiHist ? oiHist.length : 0;
  const deltaAt = (lookback) => {
    if (n < lookback + 1) return null;
    const now = oiHist[n - 1].oi, prev = oiHist[n - 1 - lookback].oi;
    if (!prev) return null;
    return ((now - prev) / prev) * 100;
  };
  return { delta5m: deltaAt(1), delta15m: deltaAt(3), delta1h: deltaAt(12) };
}

function calcVolAcceleration(candles1h, candles4h, opts = {}) {
  const avgLen = opts.avgLen ?? 20;
  if (!candles1h.length || candles4h.length < avgLen) return { ratio: null, tier: 'none' };
  const vol1h = candles1h[candles1h.length - 1].volume;
  const vol4hAvg = calcSMA(candles4h.map(c => c.volume), avgLen);
  if (vol4hAvg == null || vol4hAvg <= 0) return { ratio: null, tier: 'none' };
  const ratio = vol1h / vol4hAvg;
  let tier = 'none';
  if (ratio >= 2.0) tier = 'expansion';
  else if (ratio >= 1.5) tier = 'strong';
  else if (ratio >= 1.2) tier = 'buildup';
  return { ratio, tier };
}

function calcPriceChangePct(candles, barsBack = 1) {
  const n = candles.length;
  if (n < barsBack + 1) return null;
  const now = candles[n - 1].close, prev = candles[n - 1 - barsBack].close;
  if (!prev) return null;
  return ((now - prev) / prev) * 100;
}

function calcStructureShift(candles, opts = {}) {
  const emaLen = opts.emaLen ?? 20;
  const n = candles.length;
  if (n < emaLen + 4) return { long: false, short: false };
  const closes = candles.map(c => c.close);
  const emaSeries = calcEMASeries(closes, emaLen);
  const emaNow = emaSeries[n - 1], emaPrev = emaSeries[n - 2];
  if (emaNow == null || emaPrev == null) return { long: false, short: false };
  const last = candles[n - 1];
  const reclaim = last.close > emaNow && emaNow > emaPrev;
  const lose = last.close < emaNow && emaNow < emaPrev;
  const higherLowsStructure = candles[n-1].low > candles[n-2].low || candles[n-2].low > candles[n-3].low;
  const lowerHighsStructure = candles[n-1].high < candles[n-2].high || candles[n-2].high < candles[n-3].high;
  return { long: reclaim && higherLowsStructure, short: lose && lowerHighsStructure };
}

const SPARK_FUNDING_EXTREME = 0.05;
function calcSqueezeCondition({ funding, priceUp, oiUp, volUp }) {
  if (funding == null) return { bullish: false, bearish: false };
  const bullish = funding <= -SPARK_FUNDING_EXTREME && priceUp && oiUp && volUp;
  const bearish = funding >= SPARK_FUNDING_EXTREME && !priceUp && oiUp && volUp;
  return { bullish, bearish };
}

const SPARK_EXTENSION_1H_PCT = 20;
const SPARK_EXTENSION_4H_PCT = 35;
function calcPriceExtension(chg1h, chg4h) {
  const extendedUp = (chg1h != null && chg1h >= SPARK_EXTENSION_1H_PCT) || (chg4h != null && chg4h >= SPARK_EXTENSION_4H_PCT);
  const extendedDown = (chg1h != null && chg1h <= -SPARK_EXTENSION_1H_PCT) || (chg4h != null && chg4h <= -SPARK_EXTENSION_4H_PCT);
  return { extended: extendedUp || extendedDown, extendedUp, extendedDown };
}

const SPARK_OI_THRESHOLD = { major: 3, semi: 5, minor: 8 };
const SPARK_VOL_RATIO_THRESHOLD = { major: 1.3, semi: 1.5, minor: 1.8 };
function getSparkCoinTier(symbol) {
  if (MAJOR_COINS.has(symbol)) return 'major';
  if (SEMI_MAJOR_COINS.has(symbol)) return 'semi';
  return 'minor';
}

function calcSparkScore({ symbol, oiDelta15m, volAccel, chg1h, structureShift, squeeze, wallBias, htfAligned }) {
  const tier = getSparkCoinTier(symbol);
  const oiThreshold = SPARK_OI_THRESHOLD[tier];
  const volThreshold = SPARK_VOL_RATIO_THRESHOLD[tier];
  const oiAccelUp = oiDelta15m != null && oiDelta15m >= oiThreshold;
  const oiAccelDown = oiDelta15m != null && oiDelta15m <= -oiThreshold;
  const volAccelOK = volAccel != null && volAccel.ratio != null && volAccel.ratio >= volThreshold;
  const priceCompressed = chg1h != null && Math.abs(chg1h) <= 4;
  let longScore = 0, shortScore = 0;
  if (oiAccelUp) longScore++;
  if (oiAccelDown) shortScore++;
  if (volAccelOK) { longScore++; shortScore++; }
  if (priceCompressed) { longScore++; shortScore++; }
  if (structureShift?.long) longScore++;
  if (structureShift?.short) shortScore++;
  if (squeeze?.bullish) longScore++;
  if (squeeze?.bearish) shortScore++;
  if (wallBias === 'long') longScore++;
  if (wallBias === 'short') shortScore++;
  if (htfAligned === 'long') longScore++;
  if (htfAligned === 'short') shortScore++;

  // Задължителен "твърд" фактор - реално наблюдавани SPARK известия (виж git
  // history) достигаха 4/7+ САМО от "меки", direction-neutral фактори
  // (priceCompressed + структура/wall/HTF), докато OI и обем изобщо не бяха
  // ускорили - чист шум по време на тих пазар. Сега score-ът се брои
  // нормално (за диагностика/показване), но getSparkTier по-долу отказва да
  // класифицира каквото и да е като SPARK, ако нито OI, нито обемното
  // ускорение реално са се задействали в тази посока.
  const hasHardFactorLong = oiAccelUp || volAccelOK;
  const hasHardFactorShort = oiAccelDown || volAccelOK;

  return { longScore, shortScore, hasHardFactorLong, hasHardFactorShort };
}

const SPARK_LABELS = {
  none: null,
  earlyWatch: '👀 EARLY WATCH',
  spark: '🟡 SPARK',
  strongSpark: '🟠 STRONG SPARK',
  highProbability: '🔥 HIGH PROBABILITY',
  extreme: '🚨 EXTREME SETUP',
};
function getSparkTier(score, hasHardFactor) {
  if (!hasHardFactor) return 'none';
  if (score >= 7) return 'extreme';
  if (score >= 6) return 'highProbability';
  if (score >= 5) return 'strongSpark';
  if (score >= 4) return 'spark';
  if (score >= 3) return 'earlyWatch';
  return 'none';
}

// ═══ IDEA 07 - "RELATIVE FLOW" (BTC-independent flow) ═══════════════════════
// Разграничава "монетата се събужда сама" от "монетата просто следва BTC".
// Изцяло построен ВЪРХУ вече изчисления SPARK hard-factor gate (виж
// calcSparkScore/getSparkTier по-горе) - нула нови мрежови заявки/данни:
// BTC-ят вече минава през същия SPARK скан като всяка друга монета от
// WATCHLIST (виж checkMarketSignals по-долу), само реюзваме неговия резултат
// за сравнение. SHADOW MODE - изцяло информативно, не гейтва/блокира нищо
// съществуващо. Byte-identical копие на функцията от signal-logic.js.
const RELATIVE_FLOW_LABELS = {
  none: null,
  coinSpecific: '🎯 COIN-SPECIFIC',
  marketDriven: '🌊 MARKET-DRIVEN',
  mixed: '↔️ MIXED',
};
function calcRelativeFlow({ coinHasHardFactor, coinDirection, btcHasHardFactor, btcDirection, coinOiDelta15m, btcOiDelta15m, coinVolRatio, btcVolRatio }) {
  if (!coinHasHardFactor) {
    return { classification: 'none', oiDivergence: null, volDivergence: null };
  }
  const oiDivergence = (coinOiDelta15m ?? 0) - (btcOiDelta15m ?? 0);
  const volDivergence = (coinVolRatio ?? 0) - (btcVolRatio ?? 0);
  let classification;
  if (!btcHasHardFactor) classification = 'coinSpecific';
  else if (btcDirection === coinDirection) classification = 'marketDriven';
  else classification = 'mixed';
  return { classification, oiDivergence, volDivergence };
}

// ═══ TAKER BUY/SELL ОБЕМ - "CVD/Delta proxy" (инфраструктура за IDEA 01/05/06) ═
// Binance klines дават само комбиниран обем (buy+sell слети) - без разбивка
// не може да се различи "агресивно купуване" от "агресивна продажба", а точно
// това търсят IDEA 01 (Absorption/Trap), IDEA 05 (Flow Warming) и IDEA 06
// (Reload/Second Entry). futures/data/takerlongshortRatio е най-близкият
// безплатен Binance proxy до истинско CVD/Delta - връща агресивен taker
// buyVol/sellVol за периода (не суровен trader account ratio, какъвто е
// globalLongShortAccountRatio по-горе). Изцяло нов, отделен слой - засега само
// смята и връща данните (виж fetchTakerLongShortWorker и scanSymbolSignals
// по-долу), не гейтва/сменя нищо съществуващо. Byte-identical копие на
// функциите от signal-logic.js.
function calcTakerBuyPressure(entry) {
  if (!entry) return null;
  const total = entry.buyVol + entry.sellVol;
  if (!total) return null;
  return (entry.buyVol / total) * 100;
}
// Мулти-грануларна delta на taker buy pressure (5m/15m/1h), огледално на
// calcOiMultiDelta по-горе - от ЕДНА история с period=5m смятаме и трите delta
// (5m = 1 период назад, 15m = 3 периода назад, 1h = 12 периода назад).
// Ускоряващ се buyPressure БЕЗ пропорционално движение на цената е точно
// "абсорбция"/"flow warming" сигналът, който IDEA 01/05 търсят.
function calcTakerFlowDelta(takerHist) {
  const n = takerHist ? takerHist.length : 0;
  const now = n ? calcTakerBuyPressure(takerHist[n - 1]) : null;
  const deltaAt = (lookback) => {
    if (n < lookback + 1 || now == null) return null;
    const prev = calcTakerBuyPressure(takerHist[n - 1 - lookback]);
    if (prev == null) return null;
    return now - prev;
  };
  return { buyPressureNow: now, delta5m: deltaAt(1), delta15m: deltaAt(3), delta1h: deltaAt(12) };
}
// Taker buy/sell обем (Binance futures/data/takerlongshortRatio) - през
// relay-я по същата причина като klines/ticker/funding/openinterest. Връща
// масив {time, buyVol, sellVol} във възходящ хронологичен ред (най-новото
// последно), или null при грешка/липсващи данни - огледално на
// fetchOpenInterestHistWorker по-долу.
async function fetchTakerLongShortWorker(env, symbol, period = '5m', limit = 13) {
  try {
    const r = await fetch(`${env.RELAY_URL}/takerlongshort?symbol=${symbol}&period=${period}&limit=${limit}&token=${encodeURIComponent(env.RELAY_TOKEN)}`);
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;
    return data.map(d => ({ time: d.timestamp, buyVol: parseFloat(d.buyVol), sellVol: parseFloat(d.sellVol) })).filter(d => isFinite(d.buyVol) && isFinite(d.sellVol));
  } catch (e) {
    return null;
  }
}

// ═══ IDEA 05 - "FLOW WARMING" (Position Flow / Impulse Fuel Engine) ═══════════
// Ранно предупреждение ПРЕДИ SPARK/официалния IMPULSE да са се задействали.
// SPARK (виж calcSparkScore по-горе) вече гледа OI ускорение И обемно
// ускорение поотделно (ИЛИ едно от двете е достатъчно за hard factor), но
// никога taker CVD. Тук изискваме ДВОЕН, едновременен твърд фактор - OI
// ускорение И taker buy/sell CVD ускорение (calcTakerFlowDelta по-горе) в
// СЪЩАТА посока - по-строго от SPARK нарочно, за да хване по-рано точно
// комбинацията "капиталът/агресивният поток вече се събужда заедно", преди
// да е събрала достатъчно "меки" точки, за да мине SPARK прага. Byte-identical
// копие на функциите от signal-logic.js.
const FLOW_WARMING_TAKER_DELTA_THRESHOLD = 3; // пунктове (% buy pressure delta за 15м)
function calcFlowWarmingScore({ symbol, oiDelta15m, takerDelta15m, volAccel, chg1h }) {
  const tier = getSparkCoinTier(symbol);
  const oiThreshold = SPARK_OI_THRESHOLD[tier];
  const volThreshold = SPARK_VOL_RATIO_THRESHOLD[tier];
  const oiAccelUp = oiDelta15m != null && oiDelta15m >= oiThreshold;
  const oiAccelDown = oiDelta15m != null && oiDelta15m <= -oiThreshold;
  const takerAccelUp = takerDelta15m != null && takerDelta15m >= FLOW_WARMING_TAKER_DELTA_THRESHOLD;
  const takerAccelDown = takerDelta15m != null && takerDelta15m <= -FLOW_WARMING_TAKER_DELTA_THRESHOLD;
  const volAccelOK = volAccel != null && volAccel.ratio != null && volAccel.ratio >= volThreshold;
  const priceCompressed = chg1h != null && Math.abs(chg1h) <= 4;

  let longScore = 0, shortScore = 0;
  if (oiAccelUp && takerAccelUp) longScore += 2;
  if (oiAccelDown && takerAccelDown) shortScore += 2;
  if (volAccelOK) { longScore++; shortScore++; }
  if (priceCompressed) { longScore++; shortScore++; }

  // Твърд фактор тук е ДВОЙНО условие (за разлика от SPARK-овия hasHardFactor,
  // който е "ИЛИ") - изисква OI И CVD едновременно да ускоряват в СЪЩАТА
  // посока, не поотделно. Именно тази комбинация е новото спрямо SPARK.
  const hasHardFactorLong = oiAccelUp && takerAccelUp;
  const hasHardFactorShort = oiAccelDown && takerAccelDown;
  return { longScore, shortScore, hasHardFactorLong, hasHardFactorShort };
}
const FLOW_WARMING_LABELS = {
  none: null,
  warming: '🌡️ FLOW WARMING',
  leader: '🔥 EARLY FLOW LEADER',
};
// Максимален score е 4 (2т от двойния твърд фактор + 1т обем + 1т компресия).
function getFlowWarmingTier(score, hasHardFactor) {
  if (!hasHardFactor) return 'none';
  if (score >= 4) return 'leader';
  if (score >= 3) return 'warming';
  return 'none';
}

// ═══ IDEA 01 - "ABSORPTION / TRAP GATE" (PRE-IMPULSE) ═══════════════════════
// Търси "капан" за трейдъри на грешната страна - цена помита близка
// swing high/low (ликвидиране на стопове/лимитни поръчки на грешната страна),
// но веднага се "reclaim"-ва (SFP - Swing Failure Pattern), докато агресивният
// (taker CVD) поток в посоката на помитането е бил ПОГЪЛНАТ, не е продължил.
// ВАЖНО (изрично изискване на предложението): това е САМО ранно
// предупреждение/watch - НЕ автоматичен entry сигнал, виж TRAP_LABELS и
// известието по-долу. Byte-identical копие на функциите от signal-logic.js.
function calcLiquiditySweep(candles, opts = {}) {
  const lookback = opts.lookback ?? 20;
  const n = candles.length;
  if (n < lookback + 2) return { bullish: false, bearish: false, lowestLow: null, highestHigh: null };
  const last = candles[n - 1];
  const window = candles.slice(n - 1 - lookback, n - 1);
  const lowestLow = Math.min(...window.map(c => c.low));
  const highestHigh = Math.max(...window.map(c => c.high));
  const bullish = last.low < lowestLow && last.close > lowestLow && last.close > last.open;
  const bearish = last.high > highestHigh && last.close < highestHigh && last.close < last.open;
  return { bullish, bearish, lowestLow, highestHigh };
}

const TRAP_TAKER_DELTA_THRESHOLD = 2;
function calcTrapScore({ symbol, sweepBullish, sweepBearish, takerBuyPressure, takerDelta5m, oiDeltaPct, volAccel }) {
  const tier = getSparkCoinTier(symbol);
  const volThreshold = SPARK_VOL_RATIO_THRESHOLD[tier];
  const bullishAbsorbed = sweepBullish && ((takerBuyPressure != null && takerBuyPressure >= 50) || (takerDelta5m != null && takerDelta5m >= TRAP_TAKER_DELTA_THRESHOLD));
  const bearishAbsorbed = sweepBearish && ((takerBuyPressure != null && takerBuyPressure <= 50) || (takerDelta5m != null && takerDelta5m <= -TRAP_TAKER_DELTA_THRESHOLD));
  const oiHeld = oiDeltaPct != null && oiDeltaPct >= 0;
  const volAccelOK = volAccel != null && volAccel.ratio != null && volAccel.ratio >= volThreshold;

  let longScore = 0, shortScore = 0;
  if (bullishAbsorbed) longScore += 2;
  if (bearishAbsorbed) shortScore += 2;
  if (oiHeld) { longScore++; shortScore++; }
  if (volAccelOK) { longScore++; shortScore++; }

  return { longScore, shortScore, hasHardFactorLong: bullishAbsorbed, hasHardFactorShort: bearishAbsorbed };
}
const TRAP_LABELS = {
  none: null,
  watch: '🪤 TRAP WATCH',
  confirmed: '🪤 TRAP CONFIRMED',
};
function getTrapTier(score, hasHardFactor) {
  if (!hasHardFactor) return 'none';
  if (score >= 4) return 'confirmed';
  if (score >= 3) return 'watch';
  return 'none';
}

// ═══ IDEA 06 - "IMPULSE RELOAD / SECOND-ENTRY ENGINE" ═══════════════════════
// Решава "изпуснах първия вход" - IMPULSE -> контролиран pullback -> FLOW
// RELOAD (обем спада, CVD се обръща обратно в посоката на импулса) -> SECOND
// IMPULSE trigger (reclaim на micro-high/low + обем + CVD потвърждение).
// ИЗРИЧНО НЕ Е DCA модул (виж спецификацията) - RELOAD е НОВ, независим
// сигнал за вход, не осредняване на съществуваща позиция. "IMPULSE MEMORY" -
// за разлика от обикновения candleTime cooldown на IMPULSE тага по-горе (той
// само пречи на повторно известие за СЪЩИЯ impulse), тук изрично ПАЗИМ
// impulse-а "жив" в state.reloadWindow вместо да го забравяме веднага, точно
// за да хванем евентуален ВТОРИ вход. Изцяло Worker-only (виж прецедента с
// PHASE CYCLE ENGINE по-горе - state machine, специфична за WhatsApp cron
// потока, не част от browser Scanner UI-то, затова не се мирори в
// signal-logic.js/signal-scanner.html).
const RELOAD_MAX_HOURS = 12; // ако pullback+reload не се случат в тоя прозорец, забравяме impulse-а
const RELOAD_PULLBACK_MIN_PCT = 0.5; // под това е шум, не истински pullback
const RELOAD_PULLBACK_MAX_PCT = 8; // над това вече не е "контролиран" - инвалидира прозореца
const RELOAD_VOL_CONFIRM_RATIO = 1.3; // първоначална преценка, нужна калибрация с реални данни

function calcReloadPullbackPct(dir, extremePrice, price) {
  if (extremePrice == null || price == null || !extremePrice) return null;
  return dir === 1 ? ((extremePrice - price) / extremePrice) * 100 : ((price - extremePrice) / extremePrice) * 100;
}
// Веднъж открит истински pullback (pullbackPct >= MIN), "замразяваме" фазата -
// extremePrice спира да следва движението (виж wiring-а в scanSymbolSignals)
// и става фиксираният micro-high/low, който SECOND IMPULSE трябва да reclaim-не.
function calcReloadPhaseTransition({ phase, pullbackPct }) {
  if (phase === 'tracking' && pullbackPct != null && pullbackPct >= RELOAD_PULLBACK_MIN_PCT) return 'pullback';
  return phase;
}
function calcReloadInvalidated(pullbackPct) {
  return pullbackPct != null && pullbackPct > RELOAD_PULLBACK_MAX_PCT;
}
// SECOND IMPULSE trigger - reclaim на замразения micro-high/low + обем + CVD
// потвърждение, САМО след като реално сме преминали през 'pullback' фаза
// (не позволява да гръмне направо от 'tracking', без изобщо да е имало pullback).
function calcSecondImpulseTrigger({ phase, dir, extremePrice, price, volAccel, takerDelta5m }) {
  if (phase !== 'pullback' || extremePrice == null || price == null) return false;
  const reclaimed = dir === 1 ? price > extremePrice : price < extremePrice;
  const volConfirm = volAccel != null && volAccel.ratio != null && volAccel.ratio >= RELOAD_VOL_CONFIRM_RATIO;
  const cvdConfirm = dir === 1 ? (takerDelta5m != null && takerDelta5m > 0) : (takerDelta5m != null && takerDelta5m < 0);
  return reclaimed && volConfirm && cvdConfirm;
}

// ===================== VOLUME PROFILE ENGINE (обща основа за идеи 02/03/04) =====================
// Истински tick-ниво Volume Profile не е възможен през безплатните Binance REST
// ендпойнти (няма нито volume-profile, нито историческо orderbook API - само
// klines с общ обем на цялата свещ). Затова тук строим ПРИБЛИЖЕНИЕ: обемът на
// всяка свещ се разпределя пропорционално по ценовите нива, които тя покрива
// (high-low диапазонът ѝ), и се натрупва в bucketCount равни ценови кошчета през
// целия подаден прозорец от свещи (напр. последните 30 дневни затворени свещи -
// избора кои свещи и колко назад е на извикващия код, не на тази функция).
function buildVolumeProfile(candles, opts = {}) {
  const bucketCount = opts.bucketCount || 50;
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let rangeLow = Infinity, rangeHigh = -Infinity;
  for (const c of candles) {
    if (c.low < rangeLow) rangeLow = c.low;
    if (c.high > rangeHigh) rangeHigh = c.high;
  }
  if (!(rangeHigh > rangeLow)) return null;
  const bucketSize = (rangeHigh - rangeLow) / bucketCount;
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({ priceLow: rangeLow + i * bucketSize, priceHigh: rangeLow + (i + 1) * bucketSize, volume: 0 });
  }
  for (const c of candles) {
    const vol = c.volume || 0;
    if (!(vol > 0)) continue;
    const cRange = c.high - c.low;
    if (!(cRange > 0)) {
      // Свещ без диапазон (high===low) - целият ѝ обем отива в единственото
      // кошче, което съдържа тази цена.
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((c.high - rangeLow) / bucketSize)));
      buckets[idx].volume += vol;
      continue;
    }
    for (const b of buckets) {
      const overlapLow = Math.max(c.low, b.priceLow);
      const overlapHigh = Math.min(c.high, b.priceHigh);
      if (overlapHigh > overlapLow) {
        b.volume += vol * ((overlapHigh - overlapLow) / cRange);
      }
    }
  }
  const totalVolume = buckets.reduce((s, b) => s + b.volume, 0);
  return { buckets, rangeLow, rangeHigh, bucketSize, totalVolume };
}

// POC (Point of Control) - ценовото ниво (среда на кошчето) с най-голям натрупан обем.
function calcPOC(profile) {
  if (!profile || !profile.buckets || profile.buckets.length === 0) return null;
  let best = profile.buckets[0];
  for (const b of profile.buckets) if (b.volume > best.volume) best = b;
  return { price: (best.priceLow + best.priceHigh) / 2, priceLow: best.priceLow, priceHigh: best.priceHigh, volume: best.volume };
}

// Value Area (VAH/VAL) - стандартният "разширяване от POC навън" алгоритъм:
// тръгва се от кошчето на POC и се добавя по-обемното от двете съседни кошчета
// (ляво/дясно), докато покритият обем стигне targetPct (по подразбиране 70% -
// класическата стойност за volume/market profile) от общия обем на профила.
function calcValueArea(profile, opts = {}) {
  const targetPct = opts.targetPct || 0.70;
  if (!profile || !profile.buckets || profile.buckets.length === 0) return null;
  const buckets = profile.buckets;
  const totalVolume = profile.totalVolume || buckets.reduce((s, b) => s + b.volume, 0);
  if (!(totalVolume > 0)) return null;
  let pocIdx = 0;
  for (let i = 1; i < buckets.length; i++) if (buckets[i].volume > buckets[pocIdx].volume) pocIdx = i;
  let loIdx = pocIdx, hiIdx = pocIdx;
  let covered = buckets[pocIdx].volume;
  const target = totalVolume * targetPct;
  while (covered < target && (loIdx > 0 || hiIdx < buckets.length - 1)) {
    const volLo = loIdx > 0 ? buckets[loIdx - 1].volume : -1;
    const volHi = hiIdx < buckets.length - 1 ? buckets[hiIdx + 1].volume : -1;
    if (volHi >= volLo) { hiIdx++; covered += buckets[hiIdx].volume; }
    else { loIdx--; covered += buckets[loIdx].volume; }
  }
  return { val: buckets[loIdx].priceLow, vah: buckets[hiIdx].priceHigh, coveredPct: covered / totalVolume };
}

// HVN (High Volume Node) / LVN (Low Volume Node) - локални върхове/долини в
// профила спрямо средния обем на кошче. HVN = зони на приемане на цената
// ("магнити" - идея 02 ще ги ползва за target/destination score), LVN = зони на
// отхвърляне (пазарът обикновено минава бързо през тях, "празноти" в профила).
function getHVNLVN(profile) {
  if (!profile || !profile.buckets || profile.buckets.length < 3) return { hvn: [], lvn: [] };
  const buckets = profile.buckets;
  const avgVolume = profile.totalVolume / buckets.length;
  const hvn = [], lvn = [];
  for (let i = 1; i < buckets.length - 1; i++) {
    const prev = buckets[i - 1].volume, cur = buckets[i].volume, next = buckets[i + 1].volume;
    const mid = (buckets[i].priceLow + buckets[i].priceHigh) / 2;
    if (cur > prev && cur > next && cur > avgVolume) hvn.push({ price: mid, volume: cur });
    else if (cur < prev && cur < next && cur < avgVolume) lvn.push({ price: mid, volume: cur });
  }
  return { hvn, lvn };
}

// ═══ IDEA 02 - "TARGET / DESTINATION SCORE" ═══════════════════════════════════
// POC-ът от Volume Profile Engine (виж по-горе) е ОСНОВНАТА цел - "магнит", към
// който пазарът обичайно се връща (mean-reversion) след достатъчно отдалечаване
// от него. HVN зоните са ДОПЪЛНИТЕЛНИ магнити по пътя - чисто информативни,
// НЕ участват в score-а. Score-ът е нарочно САМО разстояние+сила на нивото (БЕЗ
// OI/CVD hard factor изискване, за разлика от TRAP/FLOW WARMING) - потвърден с
// потребителя.
const TARGET_MIN_DISTANCE_PCT = 3; // под това % разстояние от POC няма смисъл от "цел" - вече е твърде близо

function calcTargetDistancePct(price, targetPrice) {
  if (price == null || targetPrice == null || !(price > 0)) return null;
  return ((targetPrice - price) / price) * 100;
}

// Score 0-5: до 3т за разстояние (колкото по-отдалечена е цената от POC, толкова
// по-силен обратен "пул"), до 2т за силата на самия POC (какъв дял държи от
// целия обем на профила - по-голям дял = по-ясно изразен, по-надежден магнит).
function calcTargetScore({ price, poc, profileTotalVolume }) {
  if (price == null || !poc || poc.price == null) {
    return { score: 0, direction: null, distancePct: null, levelStrengthPct: null, targetPrice: null };
  }
  const distancePct = calcTargetDistancePct(price, poc.price);
  const absDistance = Math.abs(distancePct);
  const direction = distancePct > 0 ? 'long' : 'short'; // POC над цената -> очакван "пул" нагоре (LONG); под цената -> надолу (SHORT)
  const levelStrengthPct = (profileTotalVolume != null && profileTotalVolume > 0) ? (poc.volume / profileTotalVolume) * 100 : null;

  let distancePts = 0;
  if (absDistance >= 10) distancePts = 3;
  else if (absDistance >= 6) distancePts = 2;
  else if (absDistance >= TARGET_MIN_DISTANCE_PCT) distancePts = 1;

  let strengthPts = 0;
  if (levelStrengthPct != null) {
    if (levelStrengthPct >= 8) strengthPts = 2;
    else if (levelStrengthPct >= 4) strengthPts = 1;
  }

  return { score: distancePts + strengthPts, direction, distancePct, levelStrengthPct, targetPrice: poc.price };
}

const TARGET_LABELS = {
  none: null,
  watch: '🎯 TARGET WATCH',
  strong: '🎯 TARGET STRONG',
};
// Изисква ЯВНО минимално разстояние (TARGET_MIN_DISTANCE_PCT) - под него цената
// е твърде близо до POC, за да има смисъл от "цел" (вече почти е стигнала).
function getTargetTier(score, distancePct) {
  if (distancePct == null || Math.abs(distancePct) < TARGET_MIN_DISTANCE_PCT) return 'none';
  if (score >= 4) return 'strong';
  if (score >= 2) return 'watch';
  return 'none';
}

// Намира най-близките HVN "магнити" ПО ПЪТЯ към POC (строго между текущата цена
// и целта, в правилната посока) - чисто информативни, НЕ влизат в score-а.
function findNearestMagnets(price, direction, targetPrice, hvnList = [], limit = 2) {
  if (price == null || !direction || targetPrice == null || !Array.isArray(hvnList)) return [];
  const relevant = hvnList.filter(n => direction === 'long'
    ? (n.price > price && n.price <= targetPrice)
    : (n.price < price && n.price >= targetPrice));
  relevant.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  return relevant.slice(0, limit);
}

// ═══ HYSTERESIS (анти-flapping буфер) ═══════════════════════════════════════
// Общ помощник за ВСИЧКИ score-базирани детектори (TARGET/TRAP/AUCTION/
// MIGRATION/FLOW WARMING/LIQUIDATION GRAVITY) - без него дребно колебание на
// score-а точно около границата на tier (напр. TARGET distancePct 10.0% ->
// 9.8%, score 4 -> 3) сменя key-я (long:strong -> long:watch) и предизвиква
// НОВО известие само на минути разстояние, макар посоката да е СЪЩАТА (реален
// случай, видян в production). Правило: смяна на key ВИНАГИ пали известие
// ВЕДНАГА, АКО посоката (direction) също се е сменила (long<->short е
// съществена промяна, не шум) - но ако посоката е СЪЩАТА, а само tier/score-ът
// е трепнал, изчакваме поне HYSTERESIS_COOLDOWN_MIN минути от последното
// известие на този детектор, преди да позволим ново.
const HYSTERESIS_COOLDOWN_MIN = 30;
function canFireWithHysteresis(entry, key, direction, cooldownMin = HYSTERESIS_COOLDOWN_MIN) {
  if (key === 'none') return false;
  if (!entry || entry.key == null) return true;
  if (entry.key === key) return false;
  if (entry.direction !== direction) return true;
  return (Date.now() - entry.at) >= cooldownMin * 60000;
}

// TARGET - огледално на flowWarmingCanFire/markFlowWarmingFired по-горе (LIVE-
// style, без candleTime - key е чисто direction:tier, защото профилът се мени
// бавно, веднъж на затворен ден), собствен KV state ключ (state.target).
function targetCanFire(state, key, direction) {
  return canFireWithHysteresis(state.target, key, direction);
}
function markTargetFired(state, key, direction) {
  state.target = { key, direction, at: Date.now() };
}

// ═══ IDEA 03 - "AUCTION QUALITY" ═══════════════════════════════════════════════
// Оценява БАЛАНСА на Value Area от Volume Profile Engine (виж по-горе): широка/
// тясна (ширина спрямо POC цената) и симетрична/скосена (къде седи POC вътре
// във VAL..VAH). Тясна + скосена Value Area = "IMBALANCED/TREND" пазар - едната
// страна доминира, автентично двупосочно наддаване е спряло. За разлика от
// IDEA 02 (чисто структурно), тук ИМА hard factor изискване (OI и/или CVD да
// потвърждават посоката на скоса) - потвърдено с потребителя.
const AUCTION_NARROW_WIDTH_PCT = 6; // Value Area под 6% от POC цената = "тясна"
const AUCTION_SKEW_THRESHOLD = 0.15; // |skewRatio| >= 0.15 (от -0.5..+0.5 обхват) = достатъчно скосена от центъра

// skewRatio: -0.5 (POC точно на VAL) .. 0 (POC точно по средата, симетрично) .. +0.5 (POC точно на VAH).
function calcAuctionQualityScore({ poc, vah, val, oiDeltaPct, takerDelta, volAccel }) {
  if (!poc || poc.price == null || vah == null || val == null || !(vah > val) || !(poc.price > 0)) {
    return { longScore: 0, shortScore: 0, hasHardFactorLong: false, hasHardFactorShort: false, widthPct: null, skewRatio: null };
  }
  const widthPct = ((vah - val) / poc.price) * 100;
  const skewRatio = (poc.price - val) / (vah - val) - 0.5;
  const isNarrow = widthPct < AUCTION_NARROW_WIDTH_PCT;
  const isSkewedLong = skewRatio >= AUCTION_SKEW_THRESHOLD; // POC изместен към VAH - купувачите защитават високите нива
  const isSkewedShort = skewRatio <= -AUCTION_SKEW_THRESHOLD; // POC изместен към VAL - продавачите защитават ниските нива

  const oiConfirmLong = oiDeltaPct != null && oiDeltaPct > 0;
  const oiConfirmShort = oiDeltaPct != null && oiDeltaPct < 0;
  const cvdConfirmLong = takerDelta != null && takerDelta > 0;
  const cvdConfirmShort = takerDelta != null && takerDelta < 0;
  const volOK = volAccel != null && volAccel.tier !== 'none';

  const hasHardFactorLong = isNarrow && isSkewedLong && (oiConfirmLong || cvdConfirmLong);
  const hasHardFactorShort = isNarrow && isSkewedShort && (oiConfirmShort || cvdConfirmShort);

  let longScore = 0, shortScore = 0;
  if (isNarrow) { longScore++; shortScore++; }
  if (isSkewedLong) longScore += 2;
  if (isSkewedShort) shortScore += 2;
  if (volOK) { longScore++; shortScore++; }

  return { longScore, shortScore, hasHardFactorLong, hasHardFactorShort, widthPct, skewRatio };
}

const AUCTION_LABELS = {
  none: null,
  watch: '⚖️ AUCTION WATCH',
  confirmed: '⚖️ AUCTION CONFIRMED',
};
// Максимален score е 4 (1т тясна + 2т скос + 1т обем), огледално на getTrapTier по-горе.
function getAuctionQualityTier(score, hasHardFactor) {
  if (!hasHardFactor) return 'none';
  if (score >= 4) return 'confirmed';
  if (score >= 3) return 'watch';
  return 'none';
}

// AUCTION - огледално на flowWarmingCanFire/markFlowWarmingFired по-горе (LIVE-
// style, без candleTime), собствен KV state ключ (state.auction).
function auctionCanFire(state, key, direction) {
  return canFireWithHysteresis(state.auction, key, direction);
}
function markAuctionFired(state, key, direction) {
  state.auction = { key, direction, at: Date.now() };
}

// ═══ AUTO VAH/VAL STRUCTURE DETECTOR ═══════════════════════════════════════════
// Автоматично следи VAH/VAL (от Volume Profile Engine по-горе, вече изчислени
// за ВСЯКА монета) за ВСИЧКИТЕ 23 WATCHLIST монети - БЕЗ ръчно въвеждане (за
// разлика от PRICE_LEVELS_WATCHLIST по-долу, който остава отделен модул за
// специфични ръчни нива). Чисто structure/price-based - OI/CVD НЕ са hard
// factor тук (за разлика от TRAP/AUCTION/MIGRATION) - самият reclaim/rejection
// на VAH/VAL Е структурното потвърждение. Изцяло независим от TARGET - двата
// НЕ се гейтват едно друго; комбинацията им (напр. TARGET SHORT + VAH
// REJECTION) е чисто информационна конвергенция, наблюдавана в известията.
//
// 4 събития: VAH RECLAIM/REJECTION, VAL RECLAIM/REJECTION - и двете нива се
// "атакуват" САМО откъм страната, от която цената идва (виж бележките при
// calcVahValStructureEvent) - WICK ≠ SIGNAL, изисква се CONFIRMED close отвъд
// нивото (VAHVAL_CONFIRM_BUFFER_PCT буфер, не просто минимално прекосяване).
//
// Anti-spam: "armed/re-arm" state machine, не candleTime dedup (chop около
// нивото би дал различен candleTime на всяка свещ и пак би спамил) - веднъж
// произведено събитие, detector-ът се "обезоръжава" (armed=false) и чака ЕДНО
// от: (а) цената да се отдалечи достатъчно (VAHVAL_REARM_DISTANCE_PCT), (б)
// cooldown да изтече (VAHVAL_REARM_COOLDOWN_MIN), или (в) самото ниво да се
// измести структурно (>=1%, Volume Profile-ът се обновява дневно) - преди да
// позволи ново събитие на СЪЩОТО ниво.
//
// Timeframe: ползва последната затворена 15м свещ (c15Closed, вече изтеглена
// за структурните тагове) - нарочно изолирано в call site-а по-долу, лесно
// сменяемо с c1hClosed/c4hClosed, ако бъде решено по-късно след наблюдение.
const VAHVAL_CONFIRM_BUFFER_PCT = 0.15; // % отвъд нивото, нужен за "потвърден" close
const VAHVAL_REARM_DISTANCE_PCT = 1.5; // % отдалечаване от нивото -> re-arm
const VAHVAL_REARM_COOLDOWN_MIN = 60; // алтернативно: толкова минути от последното събитие -> re-arm

// Обновява/връща резултат за ЕДНО ниво (VAH или VAL) - вика се 2 пъти
// (веднъж за VAH, веднъж за VAL) от scanSymbolSignals по-долу. `entry` е
// state.vahStruct/state.valStruct - мутира се directly (огледално на
// reloadWindow другаде в този файл).
function calcVahValStructureEvent(entry, candle, level) {
  if (!candle || level == null || !(level > 0)) return { fired: false };
  const bufferAbs = level * VAHVAL_CONFIRM_BUFFER_PCT / 100;
  const confirmedAbove = candle.close > level + bufferAbs;
  const confirmedBelow = candle.close < level - bufferAbs;
  const distancePct = Math.abs(candle.close - level) / level * 100;

  if (entry.side == null) {
    // Първо наблюдение за тази монета+ниво - само baseline, без събитие.
    entry.side = confirmedAbove ? 'above' : 'below';
    entry.lastLevel = level;
    return { fired: false };
  }

  if (!entry.armed) {
    const levelShifted = entry.lastLevel != null && Math.abs(level - entry.lastLevel) / entry.lastLevel * 100 >= 1;
    const movedAway = distancePct >= VAHVAL_REARM_DISTANCE_PCT;
    const cooledDown = entry.lastEventAt != null && (Date.now() - entry.lastEventAt) >= VAHVAL_REARM_COOLDOWN_MIN * 60000;
    if (levelShifted || movedAway || cooledDown) entry.armed = true;
  }

  let fired = false, eventType = null;
  if (entry.side === 'below') {
    if (confirmedAbove) {
      if (entry.armed) { fired = true; eventType = 'reclaim'; entry.armed = false; entry.lastEventAt = Date.now(); }
      entry.side = 'above';
    } else if (candle.high >= level && entry.armed) {
      fired = true; eventType = 'rejection'; entry.armed = false; entry.lastEventAt = Date.now();
    }
  } else if (confirmedBelow) {
    entry.side = 'below'; // тих "give-back" - не е едно от 4-те събития, само reset на side
  }
  entry.lastLevel = level;
  // Пази последния РЕАЛЕН eventType (не се трие при give-back/тихи тикове) -
  // ползва се от SETUP слоя (ENTRY ENGINE, виж по-долу) за да знае "текущата
  // структурна позиция" на нивото, не само моментния tick, в който е паднало.
  if (fired) entry.lastEventType = eventType;

  return fired ? { fired: true, eventType, level, distancePct } : { fired: false };
}

const VAHVAL_LABELS = {
  'vah:reclaim': '📈 VAH RECLAIM',
  'vah:rejection': '📉 VAH REJECTION',
  'val:reclaim': '📈 VAL RECLAIM',
  'val:rejection': '📉 VAL REJECTION',
};

// ═══ ENTRY ENGINE - ЕТАП 1: "SETUP" ═════════════════════════════════════════════
// Пълна поредица: 🎯 TARGET ("има цел") -> 👀 SETUP ("наблюдавай") -> ⚡ ARMED
// ("подготвя се") -> 🔥 ENTRY CONFIRMED ("ТОВА Е ВХОД") -> exit management.
// SETUP е ПЪРВИЯТ слой - НЕ Е entry, само "тази монета вече заслужава внимание
// в LONG/SHORT посока". База (задължителна): TARGET (tier != none) + VAH/VAL
// structure alignment в СЪЩАТА посока (viж vahvalEventDirection по-долу) -
// двете заедно са ДОСТАТЪЧНИ за SETUP. TRAP/AUCTION QUALITY/VALUE MIGRATION
// са ДОПЪЛНИТЕЛНИ quality/score фактори, НЕ hard gate - липсата им не отменя
// SETUP (потвърдено изрично с потребителя - не искаме over-gate на този слой,
// истинското филтриране идва в по-късните етапи ARMED/ENTRY TRIGGER).
function vahvalEventDirection(eventType) {
  if (eventType === 'reclaim') return 'long';
  if (eventType === 'rejection') return 'short';
  return null;
}

// Връща { direction, score, breakdown } - direction е null, ако базата
// (TARGET + VAH/VAL alignment) не е изпълнена (= няма SETUP). score е 2-5:
// 2 винаги (базата), +1 за всеки допълнителен фактор в СЪЩАТА посока.
function calcSetupState({
  targetDirection, targetTier, vahLastEventType, valLastEventType,
  trapDirection, trapTier, auctionDirection, auctionTier, migrationDirection, migrationTier,
}) {
  if (targetTier === 'none' || !targetDirection) return { direction: null, score: 0, breakdown: {} };
  const vahDir = vahvalEventDirection(vahLastEventType);
  const valDir = vahvalEventDirection(valLastEventType);
  if (vahDir !== targetDirection && valDir !== targetDirection) return { direction: null, score: 0, breakdown: {} };

  const direction = targetDirection;
  const breakdown = {
    trap: trapTier !== 'none' && trapDirection === direction,
    auction: auctionTier !== 'none' && auctionDirection === direction,
    migration: migrationTier !== 'none' && migrationDirection === direction,
  };
  let score = 2; // TARGET + VAH/VAL база
  if (breakdown.trap) score++;
  if (breakdown.auction) score++;
  if (breakdown.migration) score++;
  return { direction, score, breakdown };
}

// Anti-spam: НЕ е score/tier дребно колебание (виж canFireWithHysteresis по-
// горе) - SETUP е по-скоро БИНАРНО "включено/изключено" събитие. Затова
// firing логиката е нарочно по-проста: пали САМО при нова активация (от
// изключено -> включено) или при смяна на посоката - НЕ при промяна на
// quality score-а, докато посоката остава същата (score-ът е чисто
// информационен, виж бележката при calcSetupState). Когато SETUP стане
// неактивен, state.setup изрично се изчиства - следваща активация в СЪЩАТА
// посока по-късно ще пали НАНОВО (за разлика от canFireWithHysteresis, където
// същия key никога не пали пак - тук искаме точно обратното).
function setupCanFire(state, direction) {
  if (!direction) return false;
  return !state.setup || state.setup.direction !== direction;
}
function markSetupFired(state, direction, score, price) {
  state.setup = { direction, score, at: Date.now(), price: price ?? null };
}

// ═══ ENTRY ENGINE - ЕТАП 2: "ARMED" ══════════════════════════════════════════════
// Чисто structure/price-action - БЕЗ momentum/CVD/OI (те остават за ENTRY
// TRIGGER, Етап 3). Non-repainting N-bar fractal swing detection на 5м:
// свещ `i` се потвърждава като swing high/low едва когато `i+N` вече е
// затворена - "сега" винаги гледа назад, никога напред (виж
// updateSwingStructure по-долу). ARMED gate е sticky - веднъж достигнат,
// остава активен докато SETUP не се деактивира/смени посока, или изтече
// ARMED_EXPIRY_HOURS (виж wiring-а в scanSymbolSignals).
const SWING_FRACTAL_N = 2; // свещи от всяка страна, нужни за потвърждение на pivot
const SWING_MIN_AMPLITUDE_PCT = 0.3; // минимална амплитуда - филтрира плоски/незначителни pivot-и
const STRUCTURE_BREAK_BUFFER_PCT = 0.15; // confirmed close буфер (WICK != SIGNAL, огледално на VAHVAL_CONFIRM_BUFFER_PCT)
const ARMED_EXPIRY_HOURS = 6; // ARMED изтича, ако ENTRY TRIGGER не дойде до толкова часа - първоначална преценка

function isSwingHigh(candles, i, n) {
  const h = candles[i].high;
  for (let k = i - n; k <= i + n; k++) { if (k !== i && candles[k].high >= h) return false; }
  return true;
}
function isSwingLow(candles, i, n) {
  const l = candles[i].low;
  for (let k = i - n; k <= i + n; k++) { if (k !== i && candles[k].low <= l) return false; }
  return true;
}
function swingAmplitudePct(candles, i, n, isHigh) {
  if (isHigh) {
    let minLow = Infinity;
    for (let k = i - n; k <= i + n; k++) { if (k !== i) minLow = Math.min(minLow, candles[k].low); }
    return (candles[i].high - minLow) / candles[i].high * 100;
  }
  let maxHigh = -Infinity;
  for (let k = i - n; k <= i + n; k++) { if (k !== i) maxHigh = Math.max(maxHigh, candles[k].high); }
  return (maxHigh - candles[i].low) / candles[i].low * 100;
}

// Обработва ВСИЧКИ новопотвърдими pivot кандидати от последната обработена
// свещ насам (state.swingStruct.lastCheckedTime) - всеки кандидат се
// обработва ТОЧНО ВЕДНЪЖ между тиковете, никога повторно. Мутира `entry`
// directly (огледално на reloadWindow/vahStruct другаде в този файл).
function updateSwingStructure(entry, candles) {
  const n = SWING_FRACTAL_N;
  if (!Array.isArray(candles) || candles.length < 2 * n + 1) return;
  const maxCheckableIndex = candles.length - 1 - n;
  let startIndex = n;
  if (entry.lastCheckedTime != null) {
    const foundIdx = candles.findIndex(c => c.openTime === entry.lastCheckedTime);
    if (foundIdx !== -1) startIndex = foundIdx + 1;
  }
  for (let i = startIndex; i <= maxCheckableIndex; i++) {
    if (i - n < 0) continue;
    if (isSwingHigh(candles, i, n) && swingAmplitudePct(candles, i, n, true) >= SWING_MIN_AMPLITUDE_PCT) {
      entry.prevSwingHigh = entry.lastSwingHigh;
      entry.lastSwingHigh = { price: candles[i].high, time: candles[i].openTime };
    }
    if (isSwingLow(candles, i, n) && swingAmplitudePct(candles, i, n, false) >= SWING_MIN_AMPLITUDE_PCT) {
      entry.prevSwingLow = entry.lastSwingLow;
      entry.lastSwingLow = { price: candles[i].low, time: candles[i].openTime };
    }
    entry.lastCheckedTime = candles[i].openTime;
  }
}

function calcLowerHigh(entry) {
  return !!(entry.lastSwingHigh && entry.prevSwingHigh && entry.lastSwingHigh.price < entry.prevSwingHigh.price);
}
function calcHigherLow(entry) {
  return !!(entry.lastSwingLow && entry.prevSwingLow && entry.lastSwingLow.price > entry.prevSwingLow.price);
}
// "Loss of structure" (SHORT) / "reclaim" (LONG) - CONFIRMED 5м close отвъд
// последния потвърден swing low/high + буфер - wick сам по себе си е само
// sweep/информация, не structure break (виж дискусията).
function calcStructureLossDown(entry, lastClosedCandle) {
  if (!entry.lastSwingLow || !lastClosedCandle) return false;
  return lastClosedCandle.close < entry.lastSwingLow.price * (1 - STRUCTURE_BREAK_BUFFER_PCT / 100);
}
function calcStructureReclaimUp(entry, lastClosedCandle) {
  if (!entry.lastSwingHigh || !lastClosedCandle) return false;
  return lastClosedCandle.close > entry.lastSwingHigh.price * (1 + STRUCTURE_BREAK_BUFFER_PCT / 100);
}

// ARMED gate - чисто структурен: SETUP посока + (lowerHigh/higherLow ИЛИ
// structure loss/reclaim). Връща 'long'/'short', ако условието е изпълнено
// точно СЕГА (wiring-ът решава дали да армира/остане sticky - виж по-долу).
function calcArmedTrigger(setupDirection, swingEntry, lastClosedCandle) {
  if (setupDirection === 'short') {
    return (calcLowerHigh(swingEntry) || calcStructureLossDown(swingEntry, lastClosedCandle)) ? 'short' : null;
  }
  if (setupDirection === 'long') {
    return (calcHigherLow(swingEntry) || calcStructureReclaimUp(swingEntry, lastClosedCandle)) ? 'long' : null;
  }
  return null;
}

// ═══ ENTRY ENGINE - ЕТАП 3: "ENTRY TRIGGER" ══════════════════════════════════════
// Последният преход: ARMED -> 🔥 ENTRY CONFIRMED (или ⚠️ MISSED). 5м = execution
// (самата trigger свещ), 15м = само non-contradiction филтър (не самостоятелен
// trigger), 1ч/4ч = контекст (score boost, не hard gate) - виж дискусията.
const TRIGGER_MIN_RANGE_ATR_MULTIPLE = 0.5; // trigger/15м свещта трябва да е поне толкова × ATR range - филтрира doji/шум
const CHASE_MAX_ATR_MULTIPLE = 1.5; // ако trigger close е по-далеч от структурната референция с толкова × ATR -> MISSED

// Trigger свещ: CONFIRMED close в посоката (не wick) + истинско тяло спрямо
// ATR (не doji-шум).
function isTriggerCandle(candle, direction, atr) {
  if (!candle || !(atr > 0)) return false;
  if (candle.high - candle.low < atr * TRIGGER_MIN_RANGE_ATR_MULTIPLE) return false;
  return direction === 'short' ? candle.close < candle.open : candle.close > candle.open;
}
// 15м "противоречи" = силна свещ (истинско тяло спрямо 15м ATR) в ОБРАТНАТА
// посока - не изисква собствен trigger, само не бива да е активно против нас.
function contradicts15m(candle15, direction, atr15) {
  if (!candle15 || !(atr15 > 0)) return false;
  if (candle15.high - candle15.low < atr15 * TRIGGER_MIN_RANGE_ATR_MULTIPLE) return false;
  return direction === 'short' ? candle15.close > candle15.open : candle15.close < candle15.open;
}
// CHASE PROTECTION - структурната референция (currentSwingReference) вече по
// конструкция НЕ гони цената по време на силен едностранен импулс (fractal-ът
// изисква истинска пауза от 2 свещи от двете страни, за да потвърди нов swing
// - виж дискусията) - remove risk от overfit чрез фиксирана % дистанция,
// вместо това ATR-relative (адаптира се към волатилността на всяка монета).
function isTooExtended(triggerClose, structRef, atr) {
  if (structRef == null || !(atr > 0)) return false;
  return Math.abs(triggerClose - structRef) > atr * CHASE_MAX_ATR_MULTIPLE;
}

// FLOW - асиметрична логика (потвърдена с потребителя): supportive -> +1
// score; neutral (нито един от двата детектора активен) -> не влияе; opposing
// (TRAP/FLOW WARMING с hard factor в ОБРАТНАТА посока) -> temporary VETO -
// НЕ чупи ARMED, просто не пали ENTRY този тик (изчаква следващ тик/trigger).
// Реюзва вече калибрираните TRAP/FLOW WARMING прагове - без нови "магически"
// OI%/CVD% граници.
function calcFlowVeto({ direction, flowWarmingDirection, flowWarmingTier, trapDirection, trapTier }) {
  return (flowWarmingTier !== 'none' && flowWarmingDirection !== direction) ||
    (trapTier !== 'none' && trapDirection !== direction);
}
function calcFlowBoost({ direction, flowWarmingDirection, flowWarmingTier, trapDirection, trapTier }) {
  return (flowWarmingTier !== 'none' && flowWarmingDirection === direction) ||
    (trapTier !== 'none' && trapDirection === direction);
}

// Обединява всичко - връща { status: 'none'|'veto'|'missed'|'entry', ... }.
// 'veto' е ДИАГНОСТИЧНО отделен от 'none' (виж TELEMETRY по-долу) - самото
// поведение е идентично на преди (не пали ENTRY, не консумира ARMED), само
// етикетът е по-конкретен за наблюдение. ENTRY SCORE 2 (STRUCTURE+TRIGGER
// база, гарантирани щом статусът е 'entry') + до 3 boost точки (15м
// confirmation, FLOW, HTF context) - същата рамка като SETUP score-а.
function calcEntryTrigger({ direction, candle5m, atr5m, candle15m, atr15m, structRef, flowVeto, flowBoost, htfAligned }) {
  if (!isTriggerCandle(candle5m, direction, atr5m)) return { status: 'none' };
  if (flowVeto) return { status: 'veto', triggerClose: candle5m.close, structRef };
  if (isTooExtended(candle5m.close, structRef, atr5m)) {
    return { status: 'missed', triggerClose: candle5m.close, structRef };
  }
  const confirmation15m = !contradicts15m(candle15m, direction, atr15m);
  const score = 2 + (confirmation15m ? 1 : 0) + (flowBoost ? 1 : 0) + (htfAligned ? 1 : 0);
  return { status: 'entry', score, confirmation15m, flowBoost, htfAligned, triggerClose: candle5m.close, structRef };
}

// ═══ ENTRY ENGINE - TELEMETRY (диагностика, НЕ променя ENTRY логиката) ═════════
// Записва структурирани данни за всяко ENTRY CONFIRMED/MISSED/VETO събитие,
// плюс outcome след фиксиран прозорец (+15м) - изцяло observability слой, не
// участва в score/gate решенията по-горе. Собствен KV namespace (telemetry:),
// не се чете обратно от ENTRY логиката.
const TELEMETRY_OUTCOME_WINDOW_MIN = 15;

function calcFlowState(flowVeto, flowBoost) {
  if (flowVeto) return 'opposing';
  if (flowBoost) return 'supportive';
  return 'neutral';
}

function buildTelemetryRecord({
  symbol, direction, decision, setupScore, setupBreakdown, armedAt, structRef,
  triggerClose, atr5m, triggerRange, confirmation15m, flowState,
  trapTier, trapDirection, flowWarmingTier, flowWarmingDirection, entryScore,
}) {
  const chaseDistance = (structRef != null && triggerClose != null) ? Math.abs(triggerClose - structRef) : null;
  return {
    symbol, direction, decision, at: Date.now(),
    setupScore, setupBreakdown, armedAt,
    structRef, triggerClose, atr5m,
    triggerRangeAtrRatio: (atr5m > 0 && triggerRange != null) ? triggerRange / atr5m : null,
    chaseDistance,
    chaseDistanceAtrRatio: (atr5m > 0 && chaseDistance != null) ? chaseDistance / atr5m : null,
    confirmation15m: confirmation15m ?? null, flowState,
    trapTier: trapTier ?? 'none', trapDirection: trapDirection ?? null,
    flowWarmingTier: flowWarmingTier ?? 'none', flowWarmingDirection: flowWarmingDirection ?? null,
    entryScore: entryScore ?? null,
    outcome15m: null, // попълва се по-късно от finalizePendingOutcomes/wiring-а в scanSymbolSignals
  };
}

// Outcome спрямо ПОСОКАТА: положителен % = цената се е движила В очакваната
// посока (SHORT -> надолу е "добър" outcome), огледално за LONG.
function calcOutcomePct(direction, entryPrice, laterPrice) {
  if (entryPrice == null || laterPrice == null || !(entryPrice > 0)) return null;
  const rawPct = (laterPrice - entryPrice) / entryPrice * 100;
  return direction === 'short' ? -rawPct : rawPct;
}

// Агрегира вече заредени/филтрирани telemetry записи (чисто in-memory, БЕЗ
// KV достъп тук - виж /telemetry ендпойнта в fetch() handler-а по-долу) -
// брой по decision/symbol/direction, среден ENTRY SCORE, среден
// chaseDistance/ATR, outcome статистика (win rate = дял записи с
// положителен outcome15m).
function buildTelemetrySummary(records) {
  const summary = {
    totalConfirmed: 0, totalMissed: 0, totalVeto: 0,
    bySymbol: {},
    byDirection: { long: { confirmed: 0, missed: 0, veto: 0 }, short: { confirmed: 0, missed: 0, veto: 0 } },
    avgEntryScore: null, avgChaseDistanceAtrRatio: null,
    outcome: { count: 0, avgOutcomePct: null, winRatePct: null },
  };
  let scoreSum = 0, scoreCount = 0, chaseSum = 0, chaseCount = 0, outcomeSum = 0, outcomeCount = 0, outcomeWins = 0;
  for (const r of records) {
    const bucket = r.decision === 'confirmed' ? 'totalConfirmed' : r.decision === 'missed' ? 'totalMissed' : r.decision === 'veto' ? 'totalVeto' : null;
    if (bucket) summary[bucket]++;
    if (!summary.bySymbol[r.symbol]) summary.bySymbol[r.symbol] = { confirmed: 0, missed: 0, veto: 0 };
    if (r.decision === 'confirmed' || r.decision === 'missed' || r.decision === 'veto') summary.bySymbol[r.symbol][r.decision]++;
    if ((r.direction === 'long' || r.direction === 'short') && (r.decision === 'confirmed' || r.decision === 'missed' || r.decision === 'veto')) {
      summary.byDirection[r.direction][r.decision]++;
    }
    if (r.decision === 'confirmed' && r.entryScore != null) { scoreSum += r.entryScore; scoreCount++; }
    if (r.chaseDistanceAtrRatio != null) { chaseSum += r.chaseDistanceAtrRatio; chaseCount++; }
    if (r.outcome15m != null) { outcomeSum += r.outcome15m; outcomeCount++; if (r.outcome15m > 0) outcomeWins++; }
  }
  if (scoreCount) summary.avgEntryScore = scoreSum / scoreCount;
  if (chaseCount) summary.avgChaseDistanceAtrRatio = chaseSum / chaseCount;
  if (outcomeCount) {
    summary.outcome.count = outcomeCount;
    summary.outcome.avgOutcomePct = outcomeSum / outcomeCount;
    summary.outcome.winRatePct = (outcomeWins / outcomeCount) * 100;
  }
  return summary;
}

// ═══ IDEA 04 - "VALUE MIGRATION" ═══════════════════════════════════════════════
// Сравнява POC на ВЧЕРАШНИЯ (затворен) дневен профил с POC на ДНЕШНИЯ (все още
// незавършен) дневен профил, построени от 1ч свещи - миграция на POC нагоре/
// надолу през деня е ранен индикатор, че пазарът приема нова "справедлива цена"
// (value), не просто шум около старата. ИМА hard factor изискване (OI/CVD да
// потвърждават посоката на миграцията) - потвърдено с потребителя, огледално
// на TRAP/AUCTION.
const MIGRATION_MIN_PCT = 1; // под това % разлика между двата POC - шум, не истинска миграция
const MIGRATION_MIN_CANDLES = 3; // минимум свещи за "днес", преди да има смисъл от сравнение

// Разделя подадените 1ч свещи по UTC календарен ден (openTime в ms) - връща Map
// от "YYYY-MM-DD" -> масив свещи, само за съответния ден.
function splitCandlesByUtcDay(candles) {
  const map = new Map();
  if (!Array.isArray(candles)) return map;
  for (const c of candles) {
    if (c.openTime == null) continue;
    const dayKey = new Date(c.openTime).toISOString().slice(0, 10);
    if (!map.has(dayKey)) map.set(dayKey, []);
    map.get(dayKey).push(c);
  }
  return map;
}

// Взима свещите за "днес" (последния наличен UTC ден в данните) и "вчера"
// (предходния) - последните 2 УНИКАЛНИ дни в подадения масив, не системния
// часовник директно (детерминирано, работи еднакво и в тестове).
function getTodayYesterdayCandles(candles) {
  const byDay = splitCandlesByUtcDay(candles);
  const days = Array.from(byDay.keys()).sort();
  if (days.length < 2) return { today: [], yesterday: [] };
  return { today: byDay.get(days[days.length - 1]) || [], yesterday: byDay.get(days[days.length - 2]) || [] };
}

// Score 0-4: hard factor (OI/CVD потвърждение на посоката) гейтва tier-а изцяло
// (виж getValueMigrationTier) - огледално на TRAP/AUCTION.
function calcValueMigrationScore({ todayCandles, yesterdayCandles, oiDeltaPct, takerDelta, volAccel }) {
  if (!Array.isArray(todayCandles) || todayCandles.length < MIGRATION_MIN_CANDLES ||
      !Array.isArray(yesterdayCandles) || yesterdayCandles.length === 0) {
    return { longScore: 0, shortScore: 0, hasHardFactorLong: false, hasHardFactorShort: false, migrationPct: null, todayPoc: null, yesterdayPoc: null };
  }
  const todayPoc = calcPOC(buildVolumeProfile(todayCandles));
  const yesterdayPoc = calcPOC(buildVolumeProfile(yesterdayCandles));
  if (!todayPoc || !yesterdayPoc || !(yesterdayPoc.price > 0)) {
    return { longScore: 0, shortScore: 0, hasHardFactorLong: false, hasHardFactorShort: false, migrationPct: null, todayPoc: null, yesterdayPoc: null };
  }
  const migrationPct = ((todayPoc.price - yesterdayPoc.price) / yesterdayPoc.price) * 100;
  const absMigration = Math.abs(migrationPct);
  const migratingUp = migrationPct >= MIGRATION_MIN_PCT;
  const migratingDown = migrationPct <= -MIGRATION_MIN_PCT;

  const oiConfirmLong = oiDeltaPct != null && oiDeltaPct > 0;
  const oiConfirmShort = oiDeltaPct != null && oiDeltaPct < 0;
  const cvdConfirmLong = takerDelta != null && takerDelta > 0;
  const cvdConfirmShort = takerDelta != null && takerDelta < 0;
  const volOK = volAccel != null && volAccel.tier !== 'none';

  const hasHardFactorLong = migratingUp && (oiConfirmLong || cvdConfirmLong);
  const hasHardFactorShort = migratingDown && (oiConfirmShort || cvdConfirmShort);

  let longScore = 0, shortScore = 0;
  if (migratingUp) longScore += 2;
  if (migratingDown) shortScore += 2;
  if (absMigration >= MIGRATION_MIN_PCT * 3) { if (migratingUp) longScore++; if (migratingDown) shortScore++; }
  if (volOK) { longScore++; shortScore++; }

  return { longScore, shortScore, hasHardFactorLong, hasHardFactorShort, migrationPct, todayPoc: todayPoc.price, yesterdayPoc: yesterdayPoc.price };
}

const MIGRATION_LABELS = {
  none: null,
  watch: '🔀 VALUE MIGRATION WATCH',
  confirmed: '🔀 VALUE MIGRATION CONFIRMED',
};
// Максимален score е 4 (2т посока + 1т силна миграция + 1т обем), огледално на getTrapTier по-горе.
function getValueMigrationTier(score, hasHardFactor) {
  if (!hasHardFactor) return 'none';
  if (score >= 4) return 'confirmed';
  if (score >= 3) return 'watch';
  return 'none';
}

// VALUE MIGRATION - огледално на auctionCanFire/markAuctionFired по-горе (LIVE-
// style, без candleTime), собствен KV state ключ (state.migration).
function migrationCanFire(state, key, direction) {
  return canFireWithHysteresis(state.migration, key, direction);
}
function markMigrationFired(state, key, direction) {
  state.migration = { key, direction, at: Date.now() };
}

// ═══ IDEA 08 - "LIQUIDATION GRAVITY" ═══════════════════════════════════════════
// Worker-only (огледално на IDEA 06/PHASE CYCLE ENGINE прецедент - виж git
// history) - за разлика от Volume Profile Engine (строи се НАНОВО всеки тик от
// вече изтеглени свещи), тук профилът се НАТРУПВА постоянно в KV между
// тиковете, месеци напред. Причината: Binance klines може да се преизтеглят
// назад по всяко време (история), но CoinGlass `/liquidation/order` връща само
// последните 7 дни И максимум 200 записа на заявка - НЯМА начин да се построи
// профил еднократно от миналото, той расте единствено напред във времето,
// натрупвайки новите ликвидации тик по тик (виж accumulateLiquidationGravity).
// Затова профилът структурно не може да съществува извън persistent KV state -
// UI-то (signal-scanner.html) няма собствено персистентно съхранение и не се
// мирorира там, същата логика като PHASE CYCLE/RELOAD.
//
// Логаритмични (не линейни) ценови кошчета - за разлика от Volume Profile
// buckets (фиксиран линеен диапазон от ЕДНА моментна снимка свещи), тук
// профилът обхваща месеци движение на цената без предварително известен
// диапазон, затова процентно-базирано (log-scale) кошче е единственият начин
// да остане смислено сравним, докато цената се движи през времето.
const LIQ_GRAVITY_BUCKET_PCT = 0.005; // 0.5% логаритмична ширина на кошче
const LIQ_GRAVITY_PROXIMITY_PCT = 2; // "наближава" клъстер = под 2% разстояние - първоначална преценка, нужна калибрация
const LIQ_GRAVITY_CLUSTER_MIN_USD = 2000000; // 2 млн. USD натрупани в кошче = "силен" клъстер - първоначална преценка, нужна калибрация

function priceToLiqBucket(price) {
  if (!(price > 0)) return null;
  return Math.round(Math.log(price) / Math.log(1 + LIQ_GRAVITY_BUCKET_PCT));
}
function liqBucketToPrice(bucketIndex) {
  return Math.pow(1 + LIQ_GRAVITY_BUCKET_PCT, bucketIndex);
}

// Натрупва само НОВИТЕ поръчки (o.time > lastSeenTime) в state.liqGravity.buckets
// - вика се веднъж на тик, БЕЗ да пресмята нищо наново, само добавя delta.
// Мутира state directly (както buildUpWindow/reloadWindow другаде в този файл).
function accumulateLiquidationGravity(state, orders) {
  if (!state.liqGravity) state.liqGravity = { buckets: {}, lastSeenTime: 0 };
  const g = state.liqGravity;
  if (!Array.isArray(orders)) return;
  let maxTime = g.lastSeenTime;
  for (const o of orders) {
    if (!(o.time > g.lastSeenTime) || !(o.price > 0) || !(o.usdValue > 0)) continue;
    const bucket = priceToLiqBucket(o.price);
    if (bucket == null) continue;
    g.buckets[bucket] = (g.buckets[bucket] || 0) + o.usdValue;
    if (o.time > maxTime) maxTime = o.time;
  }
  g.lastSeenTime = maxTime;
}

// Намира най-близкия "силен" клъстер (кошче с натрупан USD обем >= usdMin) до
// текущата цена - null, ако profile-ът е празен или няма нито едно кошче над прага.
function findNearestLiquidationCluster(state, price, opts = {}) {
  const usdMin = opts.usdMin ?? LIQ_GRAVITY_CLUSTER_MIN_USD;
  const g = state?.liqGravity;
  if (!g || !g.buckets || price == null) return null;
  let best = null, bestDist = Infinity;
  for (const key of Object.keys(g.buckets)) {
    const usd = g.buckets[key];
    if (usd < usdMin) continue;
    const bucketPrice = liqBucketToPrice(Number(key));
    const dist = Math.abs(bucketPrice - price);
    if (dist < bestDist) { bestDist = dist; best = { price: bucketPrice, usd }; }
  }
  return best;
}

// Score 0-4: hard factor (OI/CVD потвърждение на посоката) гейтва tier-а
// изцяло (виж getLiquidationGravityTier) - огледално на TRAP/AUCTION/MIGRATION.
function calcLiquidationGravityScore({ price, cluster, oiDeltaPct, takerDelta, volAccel }) {
  if (price == null || !(price > 0) || !cluster) {
    return { longScore: 0, shortScore: 0, hasHardFactorLong: false, hasHardFactorShort: false, distancePct: null, clusterPrice: null, clusterUsd: null };
  }
  const distancePct = ((cluster.price - price) / price) * 100;
  const absDistance = Math.abs(distancePct);
  const isNear = absDistance <= LIQ_GRAVITY_PROXIMITY_PCT;
  const direction = distancePct > 0 ? 'long' : 'short'; // клъстер НАД цената -> цената приближава го отдолу (LONG посока на движение натам)

  const oiConfirmLong = oiDeltaPct != null && oiDeltaPct > 0;
  const oiConfirmShort = oiDeltaPct != null && oiDeltaPct < 0;
  const cvdConfirmLong = takerDelta != null && takerDelta > 0;
  const cvdConfirmShort = takerDelta != null && takerDelta < 0;
  const volOK = volAccel != null && volAccel.tier !== 'none';

  const hasHardFactorLong = isNear && direction === 'long' && (oiConfirmLong || cvdConfirmLong);
  const hasHardFactorShort = isNear && direction === 'short' && (oiConfirmShort || cvdConfirmShort);

  let longScore = 0, shortScore = 0;
  if (isNear && direction === 'long') longScore += 2;
  if (isNear && direction === 'short') shortScore += 2;
  if (volOK) { longScore++; shortScore++; }
  if (cluster.usd >= LIQ_GRAVITY_CLUSTER_MIN_USD * 2) { if (direction === 'long') longScore++; if (direction === 'short') shortScore++; }

  return { longScore, shortScore, hasHardFactorLong, hasHardFactorShort, distancePct, clusterPrice: cluster.price, clusterUsd: cluster.usd };
}

const LIQ_GRAVITY_LABELS = {
  none: null,
  watch: '🧲 LIQUIDATION GRAVITY WATCH',
  confirmed: '🧲 LIQUIDATION GRAVITY CONFIRMED',
};
// Максимален score е 4 (2т посока+близост + 1т обем + 1т особено силен клъстер), огледално на getTrapTier по-горе.
function getLiquidationGravityTier(score, hasHardFactor) {
  if (!hasHardFactor) return 'none';
  if (score >= 4) return 'confirmed';
  if (score >= 3) return 'watch';
  return 'none';
}

// LIQUIDATION GRAVITY - огледално на auctionCanFire/markAuctionFired по-горе
// (LIVE-style, без candleTime), собствен KV state ключ (state.liqGravityFired -
// различен от state.liqGravity по-горе, който пази самия натрупан профил).
function liqGravityCanFire(state, key, direction) {
  return canFireWithHysteresis(state.liqGravityFired, key, direction);
}
function markLiqGravityFired(state, key, direction) {
  state.liqGravityFired = { key, direction, at: Date.now() };
}

// ============================================================================
// PHASE CYCLE ENGINE - "ПРЕДЛОЖЕНИЕ: ДВА ОТДЕЛНИ РЕЖИМА ЗА ТЪРГОВИЯ (IMPULSE
// HUNTER + EXHAUSTION/TOP HUNTER)". Изцяло нов, отделен слой ВЪРХУ съществуващия
// LONG/SHORT точков резултат (SIGNAL_WEIGHTS/SIGNAL_FAMILY_MAX/computeDirectionConfidence
// по-горе НЕ са пипнати с нищо тук) - класифицира монетата в една от 11 фази на
// пазарния цикъл (WARMING → LONG WATCH/SETUP → STRONG LONG → OVERHEATED/NO CHASE →
// TOP WATCH → SHORT WATCH/SETUP → STRONG SHORT → BREAKDOWN → пак компресия/
// WARMING), вместо просто LONG/SHORT/MIXED. Праща СОБСТВЕНО, отделно WhatsApp
// известие само при РЕАЛНА смяна на фазата (виж cyclePhaseCanFire по-долу) -
// не участва в MIN_NOTIFY_SCORE/newFired на checkMarketSignals.
// Четири нови типа данни, които Worker-ът не тегли никъде другаде досега:
// Open Interest история, order book Buy/Sell стени, 24ч % промяна, ликвидации.

// Open Interest история (Binance futures/data/openInterestHist) - за "OI Δ15m"
// от предложението (секция E: OI трябва да се чете СПРЯМО цената, не самостоятелно).
// Връща масив {time, oi} във възходящ хронологичен ред (най-новото последно),
// или null при грешка/липсващи данни.
async function fetchOpenInterestHistWorker(env, symbol, period = '5m', limit = 6) {
  try {
    const r = await fetch(`${env.RELAY_URL}/openinterest?symbol=${symbol}&period=${period}&limit=${limit}&token=${encodeURIComponent(env.RELAY_TOKEN)}`);
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;
    return data.map(d => ({ time: d.timestamp, oi: parseFloat(d.sumOpenInterest) })).filter(d => isFinite(d.oi));
  } catch (e) {
    return null;
  }
}
// % промяна на OI за последните `lookback` периода (по подразбиране 3x5м=15м,
// точно "OI Δ15m" от предложението). null ако няма достатъчно история.
function calcOiDeltaPct(oiHist, lookback = 3) {
  if (!oiHist || oiHist.length < lookback + 1) return null;
  const now = oiHist[oiHist.length - 1].oi;
  const prev = oiHist[oiHist.length - 1 - lookback].oi;
  if (!prev) return null;
  return ((now - prev) / prev) * 100;
}

// Order book Buy/Sell стени (Binance futures/v1/depth) - PRIORITY F от предложението
// ("ORDER BOOK WALL FILTER"): само стени в разумно разстояние (по подразбиране
// 15%) от текущата цена се броят - далечни стени на +100%/+200% не трябва да
// влияят на локалния bias (реалният проблем, докладван при AIXBT). Връща null
// при грешка/липсващи данни, за да не чупи PHASE CYCLE заради спомагателна инфо.
const ORDER_BOOK_WALL_MAX_DISTANCE_PCT = 15;
async function fetchOrderBookWallsWorker(env, symbol, price) {
  try {
    const r = await fetch(`${env.RELAY_URL}/depth?symbol=${symbol}&limit=500&token=${encodeURIComponent(env.RELAY_TOKEN)}`);
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data.bids) || !Array.isArray(data.asks) || price == null) return null;
    const inRange = ([p]) => Math.abs((parseFloat(p) - price) / price * 100) <= ORDER_BOOK_WALL_MAX_DISTANCE_PCT;
    const buyWallUsd = data.bids.filter(inRange).reduce((sum, [p, q]) => sum + parseFloat(p) * parseFloat(q), 0);
    const sellWallUsd = data.asks.filter(inRange).reduce((sum, [p, q]) => sum + parseFloat(p) * parseFloat(q), 0);
    return { buyWallUsd, sellWallUsd };
  } catch (e) {
    return null;
  }
}

// 24ч % промяна (Binance futures/v1/ticker/24hr) - за OVERHEATED/NO CHASE
// детектора (секция C от предложението). Връща null при грешка/липсващи данни.
async function fetch24hChangeWorker(env, symbol) {
  try {
    const r = await fetch(`${env.RELAY_URL}/ticker24hr?symbol=${symbol}&token=${encodeURIComponent(env.RELAY_TOKEN)}`);
    if (!r.ok) return null;
    const data = await r.json();
    const chg = parseFloat(data.priceChangePercent);
    return isFinite(chg) ? chg : null;
  } catch (e) {
    return null;
  }
}

// Секция E от предложението - "OI ТРЯБВА ДА СЕ ТЪЛКУВА СПРЯМО ЦЕНАТА": не
// ползваме OI Δ самостоятелно, само в комбинация с посоката на цената.
// PRICE↑+OI↑ = продължение; PRICE↑+OI↓ = възможно изчерпване (затваряния);
// PRICE↓+OI↑ = SHORT продължение; PRICE↓+OI↓ = flush/exhaustion (ликвидации).
const OI_DELTA_SIGNIFICANT_PCT = 2; // праг под който Δ се смята за шум, не реална промяна
function interpretOiPriceCross(priceUp, oiDeltaPct) {
  if (oiDeltaPct == null) return 'unknown';
  if (Math.abs(oiDeltaPct) < OI_DELTA_SIGNIFICANT_PCT) return 'flat';
  const oiUp = oiDeltaPct > 0;
  if (priceUp && oiUp) return 'long_continuation';
  if (priceUp && !oiUp) return 'long_exhaustion_risk';
  if (!priceUp && oiUp) return 'short_continuation';
  return 'long_flush_or_exhaustion';
}

// "DEATH X" от предложението - Death Cross на дневна база (EMA50 пресича ЛОЛУ
// EMA200) като ЕДНОКРАТНО СЪБИТИЕ (crossunder), не просто "текущ bear режим"
// (за това вече си имаме calcEmaTrendFilter.bear по-горе - steady-state режим,
// не самото пресичане). candles трябва да са ЗАТВОРЕНИ дневни свещи.
function calcDeathCross(candles, opts = {}) {
  const fastLen = opts.fastLen ?? 50, slowLen = opts.slowLen ?? 200;
  const closes = candles.map(c => c.close);
  const fastSeries = calcEMASeries(closes, fastLen);
  const slowSeries = calcEMASeries(closes, slowLen);
  const n = candles.length;
  const f0 = fastSeries[n - 1], f1 = fastSeries[n - 2], s0 = slowSeries[n - 1], s1 = slowSeries[n - 2];
  if (f0 == null || f1 == null || s0 == null || s1 == null) return false;
  return f1 >= s1 && f0 < s0;
}

// Секция C от предложението - "OVERHEATED / NO CHASE": прекомерен 24ч/7д ръст
// САМ ПО СЕБЕ СИ не е SHORT сигнал, но комбиниран с голямо разстояние от EMA50
// (дневна) блокира нови LONG входове, без все още да е потвърдено обръщане.
// chg7d се смята от вече наличните дневни свещи (без нужда от допълнителна
// заявка) - close сега срещу close преди 7 затворени дневни свещи.
const OVERHEATED_CHG24H_PCT = 15;
const OVERHEATED_CHG7D_PCT = 40;
const OVERHEATED_EMA_DISTANCE_PCT = 12;
function calcChg7dPct(candles1dClosed) {
  const n = candles1dClosed.length;
  if (n < 8) return null;
  const now = candles1dClosed[n - 1].close, prev = candles1dClosed[n - 8].close;
  if (!prev) return null;
  return ((now - prev) / prev) * 100;
}
function calcOverheated(chg24h, chg7d, price, ema50d) {
  const bigMove = (chg24h != null && chg24h >= OVERHEATED_CHG24H_PCT) || (chg7d != null && chg7d >= OVERHEATED_CHG7D_PCT);
  if (!bigMove) return false;
  if (ema50d == null || price == null || ema50d <= 0) return false;
  return ((price - ema50d) / ema50d) * 100 >= OVERHEATED_EMA_DISTANCE_PCT;
}

// Секция B - "TOP WATCH фактори" (gate преди да броим SHORT CONFIRMATION):
// прекалено положителен funding ИЛИ прекалено презареден Long/Short към LONG
// ИЛИ вече установен OVERHEATED - кое да е от трите отваря TOP WATCH прозореца.
const TOP_WATCH_FUNDING_MIN = 0.06; // същия праг като MACRO_SQUEEZE_FUNDING_MIN
const TOP_WATCH_LONGPCT_MIN = 65;
function isTopWatch(overheated, funding, longPct) {
  return overheated || (funding != null && funding >= TOP_WATCH_FUNDING_MIN) || (longPct != null && longPct >= TOP_WATCH_LONGPCT_MIN);
}

// Секция F - Sell стена трябва да доминира с разумен марж (не само 51%/49%),
// за да се брои като реален SHORT confirmation фактор, огледално на
// calcWallBias/DOMINANCE_RATIO=1.5 в signal-logic.js.
const WALL_DOMINANCE_RATIO = 1.5;

// MACD (12,26,9) bullish/bearish crossover на ДНЕВНА база - исторически бичи
// crossover на MACD линията срещу сигналната линия е бил надежден сигнал за
// край на мечи цикъл и начало на нов възходящ (напр. BTC 2012 - MACD bullish
// crossover, последван от рали $5→$283). Индикаторът е чисто математически,
// НЕ BTC-специфичен - смята се еднакво за всяка монета от watchlist-а.
// BTC-специфично е само конкретният брой дни между цикли (произлиза от
// halving-а, който altcoins нямат собствен еквивалент на) - затова тук
// НЕ хардкодваме никакъв брой дни, само самото пресичане (crossover/
// crossunder като еднократно събитие, не steady-state режим - огледално на
// calcDeathCross по-горе). candles трябва да са ЗАТВОРЕНИ дневни свещи.
function calcMACDCrossover(candles, opts = {}) {
  const fastLen = opts.fastLen ?? 12, slowLen = opts.slowLen ?? 26, signalLen = opts.signalLen ?? 9;
  const n = candles.length;
  if (n < slowLen + signalLen + 1) return { bullish: false, bearish: false };
  const closes = candles.map(c => c.close);
  const fastSeries = calcEMASeries(closes, fastLen);
  const slowSeries = calcEMASeries(closes, slowLen);
  const macdSeries = fastSeries.map((f, i) => (f == null || slowSeries[i] == null) ? null : f - slowSeries[i]);
  const firstValid = macdSeries.findIndex(v => v != null);
  if (firstValid === -1) return { bullish: false, bearish: false };
  // calcEMASeries очаква масив от числа без null-ове - подаваме само валидната
  // опашка на MACD линията (от firstValid нататък), после подравняваме обратно
  // с leading null-ове, за да пазим същите индекси като macdSeries.
  const macdValid = macdSeries.slice(firstValid);
  const signalValid = calcEMASeries(macdValid, signalLen);
  const signalSeries = new Array(firstValid).fill(null).concat(signalValid);
  const m0 = macdSeries[n - 1], m1 = macdSeries[n - 2];
  const s0 = signalSeries[n - 1], s1 = signalSeries[n - 2];
  if (m0 == null || m1 == null || s0 == null || s1 == null) return { bullish: false, bearish: false };
  return { bullish: m1 <= s1 && m0 > s0, bearish: m1 >= s1 && m0 < s0 };
}

// LONG_SCORE (Секция A "IMPULSE HUNTER") - 9 точки, подбрани от предложението
// с приоритет на вече съществуващи, тествани детектори (WARMING/EARLY BUILD-UP/
// BUILD-UP CONFIRMED/PRE-IMPULSE/4H CLUSTER вече покриват COMPRESSION/CASCADE
// имплицитно - COMPRESSION е вграден гейт в calcWarmingTier, 4H CLUSTER UP е
// calc4HBigVolume). Новите данни (OI, funding, wall bias, MACD, ликвидационни
// каскади) добавят 4 допълнителни точки. Скàлата на изхода следва предложението
// (0-2=NEUTRAL, 3=WATCH, 4=SETUP, 5+=STRONG) - абсолютните прагове не са
// преизчислени за новия максимум от 9 (вместо 7), умишлено: по-лесно
// достигане на STRONG с допълнителните фактори е приемливо, не грешка.
function calcCycleLongScore({ warmDirectionUp, earlyLong, buildUpConfirmLong, preImpulseLong, bigVol4hUp, oiCross, fundingOK, wallBiasLong, macdBullishCross, liquidationCascadeBullish }) {
  let score = 0;
  if (warmDirectionUp) score++;
  if (earlyLong) score++;
  if (buildUpConfirmLong) score++;
  if (preImpulseLong) score++;
  if (bigVol4hUp) score++;
  if (oiCross === 'long_continuation') score++;
  if (fundingOK && wallBiasLong) score++;
  if (macdBullishCross) score++;
  if (liquidationCascadeBullish) score++;
  return score;
}
// SHORT_SCORE (Секция B "EXHAUSTION/TOP HUNTER") - оценява се САМО когато
// isTopWatch() вече е true (виж checkMarketSignals/scanSymbolSignals по-долу) -
// огледално на предложението, където SHORT CONFIRMATION идва СЛЕД TOP WATCH.
// 9 точки (7 от предложението + MACD bearish crossunder + ликвидационна каскада,
// огледално на LONG_SCORE).
function calcCycleShortScore({ deathCross, dmaBear, oiReversal, bearishStructureActive, sellWallDominant, longOverloaded, structuralShortConfirm, macdBearishCross, liquidationCascadeBearish }) {
  let score = 0;
  if (deathCross) score++;
  if (dmaBear) score++;
  if (oiReversal) score++;
  if (bearishStructureActive) score++;
  if (sellWallDominant) score++;
  if (longOverloaded) score++;
  if (structuralShortConfirm) score++;
  if (macdBearishCross) score++;
  if (liquidationCascadeBearish) score++;
  return score;
}

// Секция G - крайният изход на картата (11 фази вместо просто LONG/SHORT/
// NEUTRAL). Изчислява се НАНОВО всеки тик от текущите резултати (не строга
// последователност от предишната фаза) - по-устойчиво от строг state machine,
// който може да "заседне"; секция D диаграмата се получава естествено, защото
// прагът на всяка следваща фаза е по-строг от предишната.
const PHASE_LABELS = {
  WARMING: '🟡 WARMING',
  LONG_WATCH: '🟢 LONG WATCH',
  LONG_SETUP: '🟢 LONG SETUP',
  STRONG_LONG: '🚀 STRONG LONG',
  OVERHEATED_NO_CHASE: '🔥 OVERHEATED — NO CHASE',
  TOP_WATCH: '👀 TOP WATCH',
  SHORT_WATCH: '🔴 SHORT WATCH',
  SHORT_SETUP: '🔴 SHORT SETUP',
  STRONG_SHORT: '💥 STRONG SHORT',
  BREAKDOWN: '💥 BREAKDOWN',
  NEUTRAL: '⚪ NEUTRAL / NO TRADE',
};
function computeCyclePhase({ longScore, shortScore, overheated, topWatch, warmTierActive, breakdownConfirmed }) {
  if (topWatch && shortScore >= 5 && breakdownConfirmed) return 'BREAKDOWN';
  if (topWatch && shortScore >= 5) return 'STRONG_SHORT';
  if (topWatch && shortScore >= 4) return 'SHORT_SETUP';
  if (topWatch && shortScore >= 3) return 'SHORT_WATCH';
  if (topWatch) return 'TOP_WATCH';
  if (overheated) return 'OVERHEATED_NO_CHASE';
  if (longScore >= 5) return 'STRONG_LONG';
  if (longScore >= 4) return 'LONG_SETUP';
  if (longScore >= 3) return 'LONG_WATCH';
  if (warmTierActive) return 'WARMING';
  return 'NEUTRAL';
}

// Известие само при РЕАЛНА смяна на фазата (не при всеки тик, докато е в
// същата фаза - иначе спам). ВАЖНО - НЯМА допълнителен времеви cooldown тук:
// първи опит с плосък 60-мин cooldown погрешно блокираше и ЛЕГИТИМНА бърза
// прогресия през фазите (напр. WARMING→LONG_WATCH→LONG_SETUP→STRONG_LONG за
// 15-20 мин при истински бърз импулс - точно сценарият, който "IMPULSE HUNTER"
// цели да хване рано), не само нежелано флип-флопване. Всеки от 9-те входни
// фактора вече си има собствен cooldown/хистерезис по-горе (WARMING/EARLY
// BUILD-UP/и т.н.), затова резкия tick-to-tick "флип-флоп" на самата ФАЗА е
// естествено рядък - не е нужен допълнителен таймер тук.
function cyclePhaseCanFire(state, newPhase) {
  return state.cycle?.phase !== newPhase;
}
function markCyclePhase(state, newPhase) {
  state.cycle = { phase: newPhase, at: Date.now() };
}

// SPARK - огледално на cyclePhaseCanFire/markCyclePhase по-горе. key е
// `${direction}:${tier}` (напр. "long:strongSpark"), или 'none' когато
// score<3 или монетата е extended (виж calcPriceExtension) - firing само на
// ГЕНУИННА промяна към нов активен SPARK сигнал, никога при изчистване.
function sparkCanFire(state, key) {
  return key !== 'none' && state.spark?.key !== key;
}
function markSparkFired(state, key) {
  state.spark = { key, at: Date.now() };
}

// FLOW WARMING - огледално на sparkCanFire/markSparkFired по-горе, собствен
// KV state ключ (state.flowWarming, не state.spark) - собствено, независимо
// известие, огледално на SPARK/🔮 ЦИКЪЛ.
function flowWarmingCanFire(state, key, direction) {
  return canFireWithHysteresis(state.flowWarming, key, direction);
}
function markFlowWarmingFired(state, key, direction) {
  state.flowWarming = { key, direction, at: Date.now() };
}

// TRAP - огледално на flowWarmingCanFire/markFlowWarmingFired по-горе,
// собствен KV state ключ (state.trap).
function trapCanFire(state, key, direction) {
  return canFireWithHysteresis(state.trap, key, direction);
}
function markTrapFired(state, key, direction) {
  state.trap = { key, direction, at: Date.now() };
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
// точковия резултат на мнозинството, не суров брой сигнали (виж SIGNAL_WEIGHTS/
// SIGNAL_FAMILY_MAX по-горе). При праг 3.0 НИТО ЕДИН единичен сигнал - дори
// най-силният, PRE-IMPULSE (2.50) - не може сам да отключи TP; винаги трябва
// комбинация от поне два (нов + активен от паметта), чиято обща family-capped
// сума достига 3.0 (напр. CONFIRMED 2.00 + HOT 1.00, или PRE-IMPULSE 2.50 +
// EARLY BUILD-UP 0.50). Все пак прагът е СЪЩЕСТВЕНО по-нисък от старата система,
// където всеки отделен сигнал (слаб или силен) се брояха еднакво като "1 сигнал"
// и трябваше да се съберат МНОГО повече на брой, за да минат.
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
  const c1dClosed = c1d.slice(0, -1); // за PHASE CYCLE ENGINE (Death Cross/50 DMA/chg7d) по-долу

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

  // ---- PHASE CYCLE ENGINE (виж дефинициите на константите/функциите по-горе,
  // непосредствено след fetchFundingWorker) - реюзва вече изчислените в тази
  // функция detektori (warmTier/warming/bigVol4h/early/buildUpConfirmLong-Short/
  // preImpulseLong-Short/confirmed/shiftDown), само 5 нови паралелни заявки за
  // данните, които Worker-ът не тегли никъде другаде (OI/order book/24ч/
  // Long-Short/funding - последните две вече се теглят от checkMacroSqueeze за
  // друга цел, тук е отделно извикване, огледално на съществуващия прецедент).
  // НЕ променя по никакъв начин longScore/shortScore/confidence по-горе.
  const [oiHist, wallsRaw, chg24h, longShortCycle, fundingCycle, liquidationOrders, takerHist] = await Promise.all([
    fetchOpenInterestHistWorker(env, symbol, '5m', 13),
    fetchOrderBookWallsWorker(env, symbol, price),
    fetch24hChangeWorker(env, symbol),
    fetchLongShortWorker(env, symbol),
    fetchFundingWorker(env, symbol),
    fetchLiquidationOrdersWorker(env, symbol),
    fetchTakerLongShortWorker(env, symbol, '5m', 13),
  ]);
  const oiDeltaPct = calcOiDeltaPct(oiHist);
  const oiCross = interpretOiPriceCross(warming.direction === 'up', oiDeltaPct);
  const wallBiasLong = !!wallsRaw && wallsRaw.buyWallUsd > wallsRaw.sellWallUsd;
  const sellWallDominant = !!wallsRaw && wallsRaw.sellWallUsd >= wallsRaw.buyWallUsd * WALL_DOMINANCE_RATIO;
  const chg7d = calcChg7dPct(c1dClosed);
  const ema50dSeries = calcEMASeries(c1dClosed.map(x => x.close), 50);
  const ema50d = ema50dSeries.length ? ema50dSeries[ema50dSeries.length - 1] : null;
  const overheated = calcOverheated(chg24h, chg7d, price, ema50d);
  const cycleLongPct = longShortCycle ? parseFloat(longShortCycle.longPct) : null;
  const topWatch = isTopWatch(overheated, fundingCycle, cycleLongPct);
  const fundingOK = fundingCycle == null || fundingCycle < TOP_WATCH_FUNDING_MIN;
  const deathCross = c1dClosed.length ? calcDeathCross(c1dClosed) : false;
  const dmaBear = calcEmaTrendFilter(c1dClosed).bear;
  const bearishStructureActive = (warmTier !== 'none' && warming.direction === 'down') || buildUpConfirmShort || preImpulseShort;
  const structuralShortConfirm = shiftDown || confirmed.short;
  const oiReversal = oiCross === 'short_continuation' || oiCross === 'long_exhaustion_risk';
  const macdCross = c1dClosed.length ? calcMACDCrossover(c1dClosed) : { bullish: false, bearish: false };
  const liquidationCascade = calcLiquidationCascade(liquidationOrders);

  const cycleLongScore = calcCycleLongScore({
    warmDirectionUp: warmTier !== 'none' && warming.direction === 'up',
    earlyLong: early.long,
    buildUpConfirmLong, preImpulseLong,
    bigVol4hUp: bigVol4h.active && bigVol4h.direction === 'up',
    oiCross, fundingOK, wallBiasLong,
    macdBullishCross: macdCross.bullish,
    liquidationCascadeBullish: liquidationCascade.bullish,
  });
  // SHORT_SCORE се смята САМО ако вече сме в TOP WATCH (секция B от
  // предложението - SHORT CONFIRMATION идва СЛЕД TOP WATCH gate-а, не преди).
  const cycleShortScore = topWatch ? calcCycleShortScore({
    deathCross, dmaBear, oiReversal, bearishStructureActive, sellWallDominant,
    longOverloaded: cycleLongPct != null && cycleLongPct >= TOP_WATCH_LONGPCT_MIN,
    structuralShortConfirm, macdBearishCross: macdCross.bearish,
    liquidationCascadeBearish: liquidationCascade.bearish,
  }) : 0;
  const cyclePhase = computeCyclePhase({
    longScore: cycleLongScore, shortScore: cycleShortScore, overheated, topWatch,
    warmTierActive: warmTier !== 'none',
    breakdownConfirmed: structuralShortConfirm,
  });
  const cyclePhaseChanged = cyclePhaseCanFire(state, cyclePhase);
  if (cyclePhaseChanged) markCyclePhase(state, cyclePhase);

  // ---- SPARK (виж дефинициите непосредствено след calcLiquidationCascade по-
  // горе) - реюзва вече изчислените в тази функция c1h/c4h (LIVE, за най-бърза
  // реакция - същата конвенция както WARMING/Early Build-Up), trend4h,
  // wallBiasLong/sellWallDominant, fundingCycle, и същия oiHist fetch (вече
  // разширен на limit=13 по-горе, за да не се прави отделна мрежова заявка).
  // НЕ променя по никакъв начин cycleLongScore/cycleShortScore/cyclePhase.
  // РЕАЛЕН БЪГ (открит при тестване на FLOW WARMING) - getSparkCoinTier
  // (викана вътре в calcSparkScore/calcFlowWarmingScore) очаква "чист" символ
  // без USDT наставка (MAJOR_COINS/SEMI_MAJOR_COINS съдържат 'BTC', 'ETH' и
  // т.н., НЕ 'BTCUSDT'), но `symbol` тук е пълният watchlist символ
  // ('BTCUSDT') - `MAJOR_COINS.has('BTCUSDT')` винаги е false, затова ВСЯКА
  // монета (включително BTC) тихо падаше в 'minor' tier (най-строгите
  // прагове: 8% OI/1.8x обем вместо 3%/1.3x за major). В Scanner UI
  // (signal-scanner.html) този бъг го няма - там вече се подава coin.symbol
  // (чист, без USDT). Поправка: чистим наставката ТУК, преди двете
  // извиквания по-долу - byte-identical принцип не важи тук, защото UI-то
  // никога не е имало бъга, само Worker-ът трябваше да го наследи погрешно.
  const symbolNoUsdt = symbol.replace('USDT', '');
  const oiMulti = calcOiMultiDelta(oiHist);
  const volAccel = calcVolAcceleration(c1h, c4h);
  const sparkChg1h = calcPriceChangePct(c1h, 1);
  const sparkChg4h = calcPriceChangePct(c4h, 1);
  const sparkStructureShift = calcStructureShift(c1h);
  const sparkWallBias = wallBiasLong ? 'long' : sellWallDominant ? 'short' : null;
  const sparkHtfAligned = trend4h.bull ? 'long' : trend4h.bear ? 'short' : null;
  const sparkSqueeze = calcSqueezeCondition({
    funding: fundingCycle, priceUp: sparkChg1h != null && sparkChg1h > 0,
    oiUp: oiMulti.delta15m != null && oiMulti.delta15m > 0, volUp: volAccel.tier !== 'none',
  });
  const sparkExtension = calcPriceExtension(sparkChg1h, sparkChg4h);
  const sparkScore = calcSparkScore({
    symbol: symbolNoUsdt, oiDelta15m: oiMulti.delta15m, volAccel, chg1h: sparkChg1h,
    structureShift: sparkStructureShift, squeeze: sparkSqueeze,
    wallBias: sparkWallBias, htfAligned: sparkHtfAligned,
  });
  const sparkDirection = sparkScore.longScore >= sparkScore.shortScore ? 'long' : 'short';
  const sparkMaxScore = Math.max(sparkScore.longScore, sparkScore.shortScore);
  // Задължителен твърд фактор (виж бележката при calcSparkScore) - реално
  // наблюдавани SPARK известия достигаха 4/7+ САМО от "меки", direction-
  // neutral фактори (priceCompressed + структура/wall/HTF), докато OI/VOL
  // ускорението изобщо не се е задействало - чист шум по време на тих пазар.
  const sparkHasHardFactor = sparkDirection === 'long' ? sparkScore.hasHardFactorLong : sparkScore.hasHardFactorShort;
  const sparkTier = getSparkTier(sparkMaxScore, sparkHasHardFactor);
  // т.8 от предложението - "3/7 показва в скенера, 4/7 задейства alert" -
  // WhatsApp известие пали само от 4/7 нагоре (spark/strongSpark/highProbability/
  // extreme), НЕ на 3/7 (earlyWatch). getSparkTier вече връща 'none', ако
  // sparkHasHardFactor е false, но проверяваме и тук изрично за защита.
  const sparkKey = (sparkMaxScore >= 4 && sparkHasHardFactor && !sparkExtension.extended) ? `${sparkDirection}:${sparkTier}` : 'none';
  const sparkFired = sparkCanFire(state, sparkKey);
  if (sparkFired) markSparkFired(state, sparkKey);

  // Taker buy/sell обем (виж calcTakerFlowDelta по-горе) - засега само се
  // смята и връща, не участва в sparkKey/sparkFired/cyclePhase - инфраструктура
  // за предстоящите IDEA 01/05/06 детектори (виж git history за плана).
  const takerFlow = calcTakerFlowDelta(takerHist);

  // ---- FLOW WARMING (виж дефинициите непосредствено след fetchTakerLongShortWorker
  // по-горе) - реюзва вече изчислените oiMulti/volAccel/sparkChg1h (нула нови
  // мрежови заявки), собствено, независимо известие/cooldown от SPARK.
  const flowWarmingScore = calcFlowWarmingScore({
    symbol: symbolNoUsdt, oiDelta15m: oiMulti.delta15m, takerDelta15m: takerFlow.delta15m,
    volAccel, chg1h: sparkChg1h,
  });
  const flowWarmingDirection = flowWarmingScore.longScore >= flowWarmingScore.shortScore ? 'long' : 'short';
  const flowWarmingMaxScore = Math.max(flowWarmingScore.longScore, flowWarmingScore.shortScore);
  const flowWarmingHasHardFactor = flowWarmingDirection === 'long' ? flowWarmingScore.hasHardFactorLong : flowWarmingScore.hasHardFactorShort;
  const flowWarmingTier = getFlowWarmingTier(flowWarmingMaxScore, flowWarmingHasHardFactor);
  const flowWarmingKey = (flowWarmingMaxScore >= 3 && flowWarmingHasHardFactor) ? `${flowWarmingDirection}:${flowWarmingTier}` : 'none';
  const flowWarmingFired = flowWarmingCanFire(state, flowWarmingKey, flowWarmingDirection);
  if (flowWarmingFired) markFlowWarmingFired(state, flowWarmingKey, flowWarmingDirection);

  // ---- TRAP (IDEA 01, виж дефинициите непосредствено след
  // fetchTakerLongShortWorker по-горе) - реюзва вече изчислените c1hClosed
  // (sweep detection на затворена свещ, огледално на SHIFT/CONFIRMED),
  // oiDeltaPct/volAccel/takerFlow - нула нови мрежови заявки.
  const sweep = calcLiquiditySweep(c1hClosed);
  const trapScore = calcTrapScore({
    symbol: symbolNoUsdt, sweepBullish: sweep.bullish, sweepBearish: sweep.bearish,
    takerBuyPressure: takerFlow.buyPressureNow, takerDelta5m: takerFlow.delta5m,
    oiDeltaPct, volAccel,
  });
  const trapDirection = trapScore.longScore >= trapScore.shortScore ? 'long' : 'short';
  const trapMaxScore = Math.max(trapScore.longScore, trapScore.shortScore);
  const trapHasHardFactor = trapDirection === 'long' ? trapScore.hasHardFactorLong : trapScore.hasHardFactorShort;
  const trapTier = getTrapTier(trapMaxScore, trapHasHardFactor);
  // sweep candleTime (последната затворена 1ч свещ) - собствен key компонент,
  // за да не се повтори известието на СЪЩАТА затворена свещ (огледално на
  // candleTime конвенцията за структурните тагове, но с key вместо label).
  const trapCandleTime = c1hClosed.length ? c1hClosed[c1hClosed.length - 1].openTime : null;
  const trapKey = (trapMaxScore >= 3 && trapHasHardFactor) ? `${trapDirection}:${trapTier}:${trapCandleTime}` : 'none';
  const trapFired = trapCanFire(state, trapKey, trapDirection);
  if (trapFired) markTrapFired(state, trapKey, trapDirection);

  // ---- RELOAD (IDEA 06, виж дефинициите непосредствено след getTrapTier
  // по-горе) - реюзва вече изчислените impulse/price/volAccel/takerFlow, нула
  // нови мрежови заявки. IMPULSE MEMORY (state.reloadWindow) е независима от
  // sparkKey/flowWarmingKey/trapKey - собствено, изцяло отделно известие.
  if (impulse.long || impulse.short) {
    const dir = impulse.long ? 1 : -1;
    const existing = state.reloadWindow;
    // Ре-армираме САМО ако няма активен прозорец, той е изтекъл, или новият
    // impulse е в ПРОТИВОПОЛОЖНА посока (flip) - ако вече следим impulse в
    // СЪЩАТА посока, не нулираме прогреса му (pullback фазата) на всеки тик.
    if (!existing || Date.now() >= existing.until || existing.dir !== dir) {
      state.reloadWindow = { dir, extremePrice: price, until: Date.now() + RELOAD_MAX_HOURS * 3600000, phase: 'tracking' };
    }
  }
  const reloadWindow = state.reloadWindow;
  const reloadActive = !!reloadWindow && Date.now() < reloadWindow.until;
  let reloadFired = false, reloadDirection = null;
  if (reloadActive && price != null) {
    // Докато сме във фаза 'tracking', extremePrice продължава да следва
    // движението (нов екстремум) - "замръзва" чак когато реален pullback
    // е засечен (виж calcReloadPhaseTransition).
    if (reloadWindow.phase === 'tracking') {
      if (reloadWindow.dir === 1 && price > reloadWindow.extremePrice) reloadWindow.extremePrice = price;
      if (reloadWindow.dir === -1 && price < reloadWindow.extremePrice) reloadWindow.extremePrice = price;
    }
    const pullbackPct = calcReloadPullbackPct(reloadWindow.dir, reloadWindow.extremePrice, price);
    if (calcReloadInvalidated(pullbackPct)) {
      // Pullback-ът стана твърде дълбок - вече не е "контролиран" (IDEA 06
      // изрично НЕ Е DCA модул) - забравяме impulse-а изцяло.
      state.reloadWindow = null;
    } else {
      reloadWindow.phase = calcReloadPhaseTransition({ phase: reloadWindow.phase, pullbackPct });
      const triggered = calcSecondImpulseTrigger({
        phase: reloadWindow.phase, dir: reloadWindow.dir, extremePrice: reloadWindow.extremePrice,
        price, volAccel, takerDelta5m: takerFlow.delta5m,
      });
      if (triggered) {
        reloadFired = true;
        reloadDirection = reloadWindow.dir === 1 ? 'long' : 'short';
        state.reloadWindow = null; // веднъж отключен, забравяме - следващ RELOAD изисква нов IMPULSE
      }
    }
  }

  // ===================== VOLUME PROFILE ENGINE (обща основа за идеи 02/03/04) ==
  // Строи се от вече изтеглените 200 дневни свещи (c1dClosed) - БЕЗ никакви
  // допълнителни мрежови заявки/subrequests. Прозорец от последните 30
  // затворени дни ("месечен" профил) - разумен баланс между актуалност и
  // достатъчно данни за стабилен POC/Value Area. Резултатите засега само се
  // връщат - следващите идеи (02/03/04) ще ги ползват за target/destination
  // score и т.н., затова НЕ участват все още в checkMarketSignals по-долу.
  const volumeProfile = buildVolumeProfile(c1dClosed.slice(-30));
  const vpPoc = calcPOC(volumeProfile);
  const vpValueArea = calcValueArea(volumeProfile);
  const vpNodes = getHVNLVN(volumeProfile);

  // IDEA 02 - "TARGET / DESTINATION SCORE" (виж calcTargetScore по-горе) -
  // изцяло отделно известие, огледално на FLOW WARMING/TRAP. Строи се directly
  // върху горния Volume Profile - POC е целта, HVN nodes-ите по-долу са само
  // информативни допълнителни магнити (не влизат в score-а).
  const targetScore = calcTargetScore({ price, poc: vpPoc, profileTotalVolume: volumeProfile?.totalVolume });
  const targetTier = getTargetTier(targetScore.score, targetScore.distancePct);
  const targetKey = targetTier !== 'none' ? `${targetScore.direction}:${targetTier}` : 'none';
  const targetFired = targetCanFire(state, targetKey, targetScore.direction);
  if (targetFired) markTargetFired(state, targetKey, targetScore.direction);
  const targetMagnets = findNearestMagnets(price, targetScore.direction, targetScore.targetPrice, vpNodes.hvn);

  // IDEA 03 - "AUCTION QUALITY" (виж calcAuctionQualityScore по-горе) -
  // изцяло отделно известие, огледално на TRAP (ИМА hard factor изискване,
  // за разлика от TARGET по-горе - потвърдено с потребителя).
  const auctionScore = calcAuctionQualityScore({
    poc: vpPoc, vah: vpValueArea ? vpValueArea.vah : null, val: vpValueArea ? vpValueArea.val : null,
    oiDeltaPct, takerDelta: takerFlow.delta5m, volAccel,
  });
  const auctionDirection = auctionScore.longScore >= auctionScore.shortScore ? 'long' : 'short';
  const auctionMaxScore = Math.max(auctionScore.longScore, auctionScore.shortScore);
  const auctionHasHardFactor = auctionDirection === 'long' ? auctionScore.hasHardFactorLong : auctionScore.hasHardFactorShort;
  const auctionTier = getAuctionQualityTier(auctionMaxScore, auctionHasHardFactor);
  const auctionKey = auctionTier !== 'none' ? `${auctionDirection}:${auctionTier}` : 'none';
  const auctionFired = auctionCanFire(state, auctionKey, auctionDirection);
  if (auctionFired) markAuctionFired(state, auctionKey, auctionDirection);

  // AUTO VAH/VAL STRUCTURE DETECTOR (виж calcVahValStructureEvent по-горе) -
  // изцяло независим от TARGET/AUCTION - реизползва вече изтеглената c15Closed
  // (структурен таймфрейм, лесно сменяем) и вече изчисления vpValueArea -
  // БЕЗ никакви допълнителни мрежови заявки.
  if (!state.vahStruct) state.vahStruct = {};
  if (!state.valStruct) state.valStruct = {};
  const structCandle = c15Closed.length ? c15Closed[c15Closed.length - 1] : null;
  const vahEvent = calcVahValStructureEvent(state.vahStruct, structCandle, vpValueArea ? vpValueArea.vah : null);
  const valEvent = calcVahValStructureEvent(state.valStruct, structCandle, vpValueArea ? vpValueArea.val : null);

  // IDEA 04 - "VALUE MIGRATION" (виж calcValueMigrationScore по-горе) -
  // изцяло отделно известие, огледално на TRAP/AUCTION. Строи се от c1h (ЖИВИ
  // свещи, включително недовършената текуща - "днес" нарочно е незавършеният
  // ден, виж спецификацията) - БЕЗ никакви допълнителни мрежови заявки.
  const { today: migrationToday, yesterday: migrationYesterday } = getTodayYesterdayCandles(c1h);
  const migrationScore = calcValueMigrationScore({
    todayCandles: migrationToday, yesterdayCandles: migrationYesterday,
    oiDeltaPct, takerDelta: takerFlow.delta5m, volAccel,
  });
  const migrationDirection = migrationScore.longScore >= migrationScore.shortScore ? 'long' : 'short';
  const migrationMaxScore = Math.max(migrationScore.longScore, migrationScore.shortScore);
  const migrationHasHardFactor = migrationDirection === 'long' ? migrationScore.hasHardFactorLong : migrationScore.hasHardFactorShort;
  const migrationTier = getValueMigrationTier(migrationMaxScore, migrationHasHardFactor);
  const migrationKey = migrationTier !== 'none' ? `${migrationDirection}:${migrationTier}` : 'none';
  const migrationFired = migrationCanFire(state, migrationKey, migrationDirection);
  if (migrationFired) markMigrationFired(state, migrationKey, migrationDirection);

  // IDEA 08 - "LIQUIDATION GRAVITY" (виж calcLiquidationGravityScore по-горе) -
  // изцяло отделно известие, огледално на TRAP/AUCTION/MIGRATION. Реизползва
  // liquidationOrders (вече изтеглени по-горе за LIQUIDATION CASCADE) - БЕЗ
  // никакви допълнителни мрежови заявки. Натрупва delta-та в state, после
  // проверява дали цената наближава вече идентифициран силен клъстер.
  accumulateLiquidationGravity(state, liquidationOrders);
  const liqCluster = findNearestLiquidationCluster(state, price);
  const liqGravityScore = calcLiquidationGravityScore({ price, cluster: liqCluster, oiDeltaPct, takerDelta: takerFlow.delta5m, volAccel });
  const liqGravityDirection = liqGravityScore.longScore >= liqGravityScore.shortScore ? 'long' : 'short';
  const liqGravityMaxScore = Math.max(liqGravityScore.longScore, liqGravityScore.shortScore);
  const liqGravityHasHardFactor = liqGravityDirection === 'long' ? liqGravityScore.hasHardFactorLong : liqGravityScore.hasHardFactorShort;
  const liqGravityTier = getLiquidationGravityTier(liqGravityMaxScore, liqGravityHasHardFactor);
  const liqGravityKey = liqGravityTier !== 'none' ? `${liqGravityDirection}:${liqGravityTier}` : 'none';
  const liqGravityFired = liqGravityCanFire(state, liqGravityKey, liqGravityDirection);
  if (liqGravityFired) markLiqGravityFired(state, liqGravityKey, liqGravityDirection);

  // ENTRY ENGINE - ЕТАП 1: "SETUP" (виж calcSetupState по-горе) - реюзва вече
  // изчислените TARGET/VAH/VAL/TRAP/AUCTION/MIGRATION резултати по-горе, БЕЗ
  // никакви допълнителни мрежови заявки.
  const setupState = calcSetupState({
    targetDirection: targetScore.direction, targetTier,
    vahLastEventType: state.vahStruct.lastEventType, valLastEventType: state.valStruct.lastEventType,
    trapDirection, trapTier, auctionDirection, auctionTier, migrationDirection, migrationTier,
  });
  const setupFired = setupCanFire(state, setupState.direction);
  if (setupFired) markSetupFired(state, setupState.direction, setupState.score, price);
  if (!setupState.direction) state.setup = null; // деактивирано - следваща активация ще пали НАНОВО

  // ENTRY ENGINE - ЕТАП 2: "ARMED" (виж calcArmedTrigger по-горе) - чисто
  // structure/price-action, БЕЗ momentum/CVD/OI (за Етап 3). Реюзва вече
  // изтеглената c5Closed - БЕЗ нови мрежови заявки. ARMED е sticky - веднъж
  // достигнат, остава активен докато SETUP не се деактивира/смени посока
  // (проверката по-долу), или изтече ARMED_EXPIRY_HOURS.
  if (!state.swingStruct) state.swingStruct = {};
  updateSwingStructure(state.swingStruct, c5Closed);
  if (!setupState.direction || (state.armed && state.armed.direction !== setupState.direction)) {
    state.armed = null; // SETUP деактивиран или смени посока -> RESET към IDLE
  }
  if (state.armed && (Date.now() - state.armed.at) >= ARMED_EXPIRY_HOURS * 3600000) {
    state.armed = null; // expiry - твърде стар ARMED без дошъл ENTRY TRIGGER
  }
  let armedFired = false;
  if (setupState.direction && !state.armed) {
    const lastClosed5m = c5Closed.length ? c5Closed[c5Closed.length - 1] : null;
    const armedDirection = calcArmedTrigger(setupState.direction, state.swingStruct, lastClosed5m);
    if (armedDirection) {
      // priceAtArm е ЧИСТО информационен (за контекст в известията) - НЕ
      // участва в chase protection (виж calcEntryTrigger/isTooExtended по-горе
      // и дискусията защо currentSwingReference е правилната референция).
      state.armed = { direction: armedDirection, at: Date.now(), priceAtArm: price };
      armedFired = true;
    }
  }
  const armedDirection = state.armed ? state.armed.direction : null;
  const armedLowerHigh = calcLowerHigh(state.swingStruct);
  const armedHigherLow = calcHigherLow(state.swingStruct);
  const armedStructureLossDown = calcStructureLossDown(state.swingStruct, c5Closed.length ? c5Closed[c5Closed.length - 1] : null);
  const armedStructureReclaimUp = calcStructureReclaimUp(state.swingStruct, c5Closed.length ? c5Closed[c5Closed.length - 1] : null);

  // ENTRY ENGINE - ЕТАП 3: "ENTRY TRIGGER" (виж calcEntryTrigger по-горе) -
  // изчислява се САМО докато ARMED е активен. Реюзва вече изтеглените c5Closed/
  // c15Closed + вече изчислените FLOW WARMING/TRAP/trend4h/emaFilter - БЕЗ нови
  // мрежови заявки. ENTRY/MISSED консумират ARMED (сядат в state.armed=null) -
  // едностранно събитие на епизод, огледално на самия state machine дизайн.
  let entryResult = { status: 'none' };
  if (state.armed) {
    const entryDirection = state.armed.direction;
    const atr5m = calcATR(c5Closed, 14);
    const atr15m = calcATR(c15Closed, 14);
    const structRef = entryDirection === 'short'
      ? (state.swingStruct.lastSwingLow ? state.swingStruct.lastSwingLow.price : null)
      : (state.swingStruct.lastSwingHigh ? state.swingStruct.lastSwingHigh.price : null);
    const flowVeto = calcFlowVeto({ direction: entryDirection, flowWarmingDirection, flowWarmingTier, trapDirection, trapTier });
    const flowBoost = calcFlowBoost({ direction: entryDirection, flowWarmingDirection, flowWarmingTier, trapDirection, trapTier });
    const htfAligned = entryDirection === 'long' ? (trend4h.bull || emaFilter.bull) : (trend4h.bear || emaFilter.bear);
    const lastClosed5mCandle = c5Closed.length ? c5Closed[c5Closed.length - 1] : null;
    entryResult = calcEntryTrigger({
      direction: entryDirection,
      candle5m: lastClosed5mCandle, atr5m,
      candle15m: c15Closed.length ? c15Closed[c15Closed.length - 1] : null, atr15m,
      structRef, flowVeto, flowBoost, htfAligned,
    });
    // TELEMETRY - записва се за entry/missed/veto (виж buildTelemetryRecord
    // по-горе), НЕЗАВИСИМО от гейт логиката по-долу - чисто observability.
    if (entryResult.status === 'entry' || entryResult.status === 'missed' || entryResult.status === 'veto') {
      const decision = entryResult.status === 'entry' ? 'confirmed' : entryResult.status;
      const record = buildTelemetryRecord({
        symbol, direction: entryDirection, decision,
        setupScore: setupState.score, setupBreakdown: setupState.breakdown,
        armedAt: state.armed.at,
        structRef: entryResult.structRef ?? structRef,
        triggerClose: entryResult.triggerClose, atr5m,
        triggerRange: lastClosed5mCandle ? (lastClosed5mCandle.high - lastClosed5mCandle.low) : null,
        confirmation15m: entryResult.confirmation15m,
        flowState: calcFlowState(flowVeto, flowBoost),
        trapTier, trapDirection, flowWarmingTier, flowWarmingDirection,
        entryScore: entryResult.score,
      });
      if (env.ALERT_STATE) {
        const telemetryKey = `telemetry:${symbol}:${record.at}`;
        await env.ALERT_STATE.put(telemetryKey, JSON.stringify(record));
        if (decision === 'confirmed' || decision === 'missed') {
          if (!state.pendingOutcomes) state.pendingOutcomes = [];
          state.pendingOutcomes.push({
            key: telemetryKey, dueAt: record.at + TELEMETRY_OUTCOME_WINDOW_MIN * 60000,
            entryPrice: record.triggerClose, direction: entryDirection,
          });
        }
      }
    }
    if (entryResult.status === 'entry' || entryResult.status === 'missed') {
      entryResult.direction = entryDirection;
      entryResult.priceAtArm = state.armed.priceAtArm; // само за контекст в известието
      state.armed = null; // епизодът приключва (ENTRY или MISSED) - ново SETUP->ARMED е нужно за следващ опит
    }
  }

  // TELEMETRY - довършва "чакащите" outcome записи (+15м прозорец) за ТАЗИ
  // монета, реюзвайки вече изчислената `price` от тази обиколка - БЕЗ никакви
  // допълнителни мрежови заявки. Изцяло observability, не влияе на ENTRY.
  if (state.pendingOutcomes && state.pendingOutcomes.length && env.ALERT_STATE) {
    const stillPending = [];
    for (const p of state.pendingOutcomes) {
      if (Date.now() >= p.dueAt && price != null) {
        const raw = await env.ALERT_STATE.get(p.key);
        if (raw) {
          const rec = JSON.parse(raw);
          rec.outcome15m = calcOutcomePct(p.direction, p.entryPrice, price);
          await env.ALERT_STATE.put(p.key, JSON.stringify(rec));
        }
      } else {
        stillPending.push(p);
      }
    }
    state.pendingOutcomes = stillPending;
  }

  await saveSymbolState(env, symbol, state);

  return {
    newFired: newFired.map(sig => sig.label),
    activeFired: activeSignals.map(sig => sig.label),
    price, support, resistance, ...confidence,
    cyclePhase, cyclePhaseChanged, cycleLongScore, cycleShortScore,
    sparkKey, sparkFired, sparkDirection, sparkTier, sparkMaxScore,
    sparkOiDelta5m: oiMulti.delta5m, sparkOiDelta15m: oiMulti.delta15m, sparkOiDelta1h: oiMulti.delta1h,
    sparkVolRatio: volAccel.ratio, sparkChg1h, sparkChg4h, sparkExtended: sparkExtension.extended,
    takerBuyPressure: takerFlow.buyPressureNow, takerDelta5m: takerFlow.delta5m,
    takerDelta15m: takerFlow.delta15m, takerDelta1h: takerFlow.delta1h,
    flowWarmingKey, flowWarmingFired, flowWarmingDirection, flowWarmingTier, flowWarmingMaxScore,
    trapFired, trapDirection, trapTier, trapMaxScore, oiDeltaPct,
    reloadFired, reloadDirection,
    vpPoc: vpPoc ? vpPoc.price : null,
    vpVah: vpValueArea ? vpValueArea.vah : null,
    vpVal: vpValueArea ? vpValueArea.val : null,
    vpHvn: vpNodes.hvn, vpLvn: vpNodes.lvn,
    targetFired, targetTier, targetDirection: targetScore.direction, targetScore: targetScore.score,
    targetDistancePct: targetScore.distancePct, targetLevelStrengthPct: targetScore.levelStrengthPct,
    targetPrice: targetScore.targetPrice, targetMagnets,
    auctionFired, auctionTier, auctionDirection, auctionMaxScore,
    auctionWidthPct: auctionScore.widthPct, auctionSkewRatio: auctionScore.skewRatio,
    migrationFired, migrationTier, migrationDirection, migrationMaxScore,
    migrationPct: migrationScore.migrationPct, migrationTodayPoc: migrationScore.todayPoc, migrationYesterdayPoc: migrationScore.yesterdayPoc,
    liqGravityFired, liqGravityTier, liqGravityDirection, liqGravityMaxScore,
    liqGravityDistancePct: liqGravityScore.distancePct, liqGravityClusterPrice: liqGravityScore.clusterPrice, liqGravityClusterUsd: liqGravityScore.clusterUsd,
    vahEvent, valEvent,
    setupFired, setupDirection: setupState.direction, setupScore: setupState.score, setupBreakdown: setupState.breakdown,
    armedFired, armedDirection, armedLowerHigh, armedHigherLow, armedStructureLossDown, armedStructureReclaimUp,
    entryResult,
  };
}

// ---- Пазарни сигнали следене (извиква се от scheduled()) -------------------
// За разлика от checkDcaLevels(), сканира ВСИЧКИ записи от WATCHLIST -
// entryPrice/side не са нужни тук (следим монетата, не конкретна позиция).
// btcFlowContextOverride (DISCOVERY RADAR - Stage E) - опционален, добавен
// БЕЗ да пипа стария call site (checkMarketSignals(env) от CORE си остава
// байт-идентичен по поведение). Позволява на DISCOVERY-driven извикването
// (различен watchlist, БЕЗ BTCUSDT в него - виж updateDiscoveryPromotion) да
// преизползва ПОСЛЕДНИЯ реален BTC контекст от CORE-ния run (виж
// persistBtcFlowContext по-долу), вместо да пада на neutral default само
// защото BTCUSDT никога не е позиция 0 в pool-а.
async function checkMarketSignals(env, watchlist = WATCHLIST, btcFlowContextOverride = null) {
  // IDEA 07 - "RELATIVE FLOW" (виж calcRelativeFlow по-горе) - BTC е ВИНАГИ
  // watchlist[0] (виж WATCHLIST по-горе), а for-of цикълът е строго
  // последователен (await вътре), затова BTC гарантирано се обработва ПЪРВИ и
  // резултатът му може да се преизползва за всички следващи монети в СЪЩИЯ
  // тик - нула допълнителни заявки. Default стойността (без hard factor)
  // важи само за самата BTC итерация, преди да е записан собственият ѝ резултат.
  let btcFlowContext = btcFlowContextOverride || { hasHardFactor: false, direction: 'long', oiDelta15m: null, volRatio: null };
  for (const pos of watchlist) {
    try {
      const { newFired, activeFired, price, support, resistance, direction, longPct, shortPct, longScore, shortScore, majority, ratioOK, enoughScore, cyclePhase, cyclePhaseChanged, cycleLongScore, cycleShortScore, sparkKey, sparkFired, sparkDirection, sparkTier, sparkMaxScore, sparkOiDelta5m, sparkOiDelta15m, sparkOiDelta1h, sparkVolRatio, sparkChg1h, takerDelta5m, takerDelta15m, flowWarmingFired, flowWarmingDirection, flowWarmingTier, flowWarmingMaxScore, trapFired, trapDirection, trapTier, trapMaxScore, oiDeltaPct, reloadFired, reloadDirection, targetFired, targetTier, targetDirection, targetScore, targetDistancePct, targetLevelStrengthPct, targetPrice, targetMagnets, auctionFired, auctionTier, auctionDirection, auctionMaxScore, auctionWidthPct, auctionSkewRatio, migrationFired, migrationTier, migrationDirection, migrationMaxScore, migrationPct, migrationTodayPoc, migrationYesterdayPoc, liqGravityFired, liqGravityTier, liqGravityDirection, liqGravityMaxScore, liqGravityDistancePct, liqGravityClusterPrice, liqGravityClusterUsd, vahEvent, valEvent, setupFired, setupDirection, setupScore, setupBreakdown, armedFired, armedDirection, armedLowerHigh, armedHigherLow, armedStructureLossDown, armedStructureReclaimUp, entryResult } = await scanSymbolSignals(env, pos.symbol);
      if (pos.symbol === 'BTCUSDT') {
        btcFlowContext = {
          hasHardFactor: sparkTier !== 'none', direction: sparkDirection,
          oiDelta15m: sparkOiDelta15m, volRatio: sparkVolRatio,
        };
        if (env.ALERT_STATE) await env.ALERT_STATE.put('btcflowcontext', JSON.stringify(btcFlowContext));
      }
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
      // IDEA 02 - "TARGET / DESTINATION SCORE" (виж calcTargetScore по-горе) -
      // изцяло отделно известие, огледално на FLOW WARMING/TRAP. POC е целта
      // (mean-reversion магнит), HVN nodes-ите по пътя са само информативни
      // допълнителни магнити - НЕ влизат в score-а. Score-ът е чисто
      // разстояние+сила на нивото, БЕЗ OI/CVD hard factor изискване (потвърдено
      // изрично с потребителя - виж дискусията за идея 02).
      if (targetFired) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const fmtPct = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
        const targetLines = [
          `${TARGET_LABELS[targetTier]} ${symbolNoUsdt} ${targetDirection === 'long' ? '▲ LONG' : '▼ SHORT'}`,
          `TARGET SCORE: ${targetScore}/5`,
          `POC (цел): ${formatPrice(targetPrice)} USD · Разстояние: ${fmtPct(targetDistancePct)}`,
          `Сила на нивото: ${targetLevelStrengthPct != null ? targetLevelStrengthPct.toFixed(1) + '%' : '--'} от обема`,
        ];
        if (targetMagnets.length) {
          targetLines.push(`Магнити по пътя: ${targetMagnets.map(m => formatPrice(m.price)).join(' → ')}`);
        }
        targetLines.push(`⚠️ Ориентировъчна цел (mean-reversion) - НЕ Е entry сигнал`);
        await sendWhatsApp(env, targetLines.join('\n'));
      }
      // IDEA 03 - "AUCTION QUALITY" (виж calcAuctionQualityScore по-горе) -
      // изцяло отделно известие, огледално на TRAP. Тясна+скосена Value Area,
      // потвърдена от OI/CVD в посоката на скоса - "IMBALANCED/TREND" пазар,
      // не двупосочен/balanced.
      if (auctionFired) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const fmtPct = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
        const auctionLines = [
          `${AUCTION_LABELS[auctionTier]} ${symbolNoUsdt} ${auctionDirection === 'long' ? '▲ LONG' : '▼ SHORT'}`,
          `AUCTION SCORE: ${auctionMaxScore}/4`,
          `Value Area ширина: ${auctionWidthPct != null ? auctionWidthPct.toFixed(1) + '%' : '--'} от POC · Skew: ${auctionSkewRatio != null ? (auctionSkewRatio * 200).toFixed(0) + '%' : '--'}`,
          `OI: ${fmtPct(oiDeltaPct)} · CVD (taker) 5м: ${fmtPct(takerDelta5m)}`,
          `⚠️ Тесен/скосен профил - вероятен trend режим, НЕ Е entry сигнал сам по себе си`,
        ];
        await sendWhatsApp(env, auctionLines.join('\n'));
      }
      // IDEA 04 - "VALUE MIGRATION" (виж calcValueMigrationScore по-горе) -
      // изцяло отделно известие, огледално на TRAP/AUCTION. Сравнява POC на
      // днешния (незавършен) профил с вчерашния (затворен), потвърдено от
      // OI/CVD в посоката на миграцията.
      if (migrationFired) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const fmtPct = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
        const migrationLines = [
          `${MIGRATION_LABELS[migrationTier]} ${symbolNoUsdt} ${migrationDirection === 'long' ? '▲ LONG' : '▼ SHORT'}`,
          `VALUE MIGRATION SCORE: ${migrationMaxScore}/4`,
          `Вчерашен POC: ${formatPrice(migrationYesterdayPoc)} USD → Днешен POC: ${formatPrice(migrationTodayPoc)} USD (${fmtPct(migrationPct)})`,
          `OI: ${fmtPct(oiDeltaPct)} · CVD (taker) 5м: ${fmtPct(takerDelta5m)}`,
          `⚠️ Value migration - НЕ Е entry сигнал сам по себе си`,
        ];
        await sendWhatsApp(env, migrationLines.join('\n'));
      }
      // IDEA 08 - "LIQUIDATION GRAVITY" (виж calcLiquidationGravityScore
      // по-горе) - изцяло отделно известие, огледално на TRAP/AUCTION/
      // MIGRATION. Профилът е ХИПОТЕЗА за тестване (натрупан от реални
      // станали ликвидации, НЕ прогнозен heatmap) - дали цена, отдалечена от
      // зона с много исторически ликвидации, се връща пак там, предстои да
      // видим емпирично.
      if (liqGravityFired) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const fmtPct = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
        const liqGravityLines = [
          `${LIQ_GRAVITY_LABELS[liqGravityTier]} ${symbolNoUsdt} ${liqGravityDirection === 'long' ? '▲ LONG' : '▼ SHORT'}`,
          `LIQUIDATION GRAVITY SCORE: ${liqGravityMaxScore}/4`,
          `Клъстер: ${formatPrice(liqGravityClusterPrice)} USD (${liqGravityClusterUsd != null ? Math.round(liqGravityClusterUsd).toLocaleString('en-US') : '--'} USD натрупани) · Разстояние: ${fmtPct(liqGravityDistancePct)}`,
          `OI: ${fmtPct(oiDeltaPct)} · CVD (taker) 5м: ${fmtPct(takerDelta5m)}`,
          `⚠️ Хипотеза за тестване (историческа ликвидационна зона) - НЕ Е entry сигнал`,
        ];
        await sendWhatsApp(env, liqGravityLines.join('\n'));
      }
      // AUTO VAH/VAL STRUCTURE DETECTOR (виж calcVahValStructureEvent по-горе) -
      // изцяло отделни известия, независими от TARGET (не се гейтват едно
      // друго). Ако TARGET има активен tier за същата монета, показваме го
      // информативно - конвергенцията (напр. TARGET SHORT + VAH REJECTION) е
      // точно комбинацията, която си заслужава наблюдение (виж дискусията).
      const symbolNoUsdt = pos.symbol.replace('USDT', '');
      const fmtPct = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
      for (const [ev, levelName] of [[vahEvent, 'VAH'], [valEvent, 'VAL']]) {
        if (!ev.fired) continue;
        const labelKey = `${levelName.toLowerCase()}:${ev.eventType}`;
        const lines = [
          `${VAHVAL_LABELS[labelKey]} ${symbolNoUsdt}`,
          `${levelName} ниво: ${formatPrice(ev.level)} USD · Разстояние при close: ${ev.distancePct.toFixed(2)}%`,
          `OI: ${fmtPct(oiDeltaPct)} · CVD (taker) 5м: ${fmtPct(takerDelta5m)}`,
        ];
        if (targetTier !== 'none') {
          lines.push(`🎯 TARGET: ${targetDirection === 'long' ? 'LONG' : 'SHORT'} ${targetTier.toUpperCase()} (за същата монета)`);
        }
        lines.push(`⚠️ Структурно събитие - НЕ Е entry сигнал сам по себе си`);
        await sendWhatsApp(env, lines.join('\n'));
      }
      // ENTRY ENGINE - ЕТАП 1: "SETUP" (виж calcSetupState по-горе) - ПЪРВИЯТ
      // слой от последователността TARGET -> SETUP -> ARMED -> ENTRY
      // CONFIRMED. Все още НЕ Е entry - означава само "тази монета вече
      // заслужава внимание". Пали САМО при нова активация/смяна на посоката
      // (виж setupCanFire), не при промяна на quality score-а.
      if (setupFired) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const b = setupBreakdown;
        const setupLines = [
          `👀 SETUP ${setupDirection === 'long' ? 'LONG' : 'SHORT'} ${symbolNoUsdt}`,
          `Base: TARGET + VAH/VAL ${setupDirection === 'long' ? 'reclaim' : 'rejection'} ✓`,
          `TRAP: ${b.trap ? '✓' : '—'}`,
          `AUCTION QUALITY: ${b.auction ? '✓' : '—'}`,
          `VALUE MIGRATION: ${b.migration ? '✓' : '—'}`,
          `SETUP QUALITY: ${setupScore}/5`,
          `⚠️ Все още НЕ Е entry - следи за развитие (Етап 2: ARMED)`,
        ];
        await sendWhatsApp(env, setupLines.join('\n'));
      }
      // ENTRY ENGINE - ЕТАП 2: "ARMED" (виж calcArmedTrigger по-горе) - чисто
      // структурно, sticky (не трепка при всяка промяна на swing точките).
      // Все още НЕ Е entry - чакаме ENTRY TRIGGER (Етап 3).
      if (armedFired) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const reasons = [];
        if (armedDirection === 'short') {
          if (armedLowerHigh) reasons.push('Lower High потвърден');
          if (armedStructureLossDown) reasons.push('Structure loss (5м close под swing low)');
        } else {
          if (armedHigherLow) reasons.push('Higher Low потвърден');
          if (armedStructureReclaimUp) reasons.push('Structure reclaim (5м close над swing high)');
        }
        const armedLines = [
          `⚡ ARMED ${armedDirection === 'long' ? 'LONG' : 'SHORT'} ${symbolNoUsdt}`,
          reasons.join(' + '),
          `⚠️ Все още НЕ Е entry - чакаме ENTRY TRIGGER (Етап 3)`,
        ];
        await sendWhatsApp(env, armedLines.join('\n'));
      }
      // ENTRY ENGINE - ЕТАП 3: "ENTRY TRIGGER" (виж calcEntryTrigger по-горе) -
      // финалният преход: 🔥 ENTRY CONFIRMED ("ТОВА Е ВХОД") или ⚠️ ENTRY
      // MISSED (посоката е вярна, но цената вече е избягала твърде далеч от
      // структурата - WAIT RETEST, бъдещ Етап 4).
      if (entryResult.status === 'entry' || entryResult.status === 'missed') {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const dirLabel = entryResult.direction === 'long' ? 'LONG' : 'SHORT';
        if (entryResult.status === 'entry') {
          const entryLines = [
            `🔥 ENTRY CONFIRMED ${symbolNoUsdt}`,
            dirLabel,
            `ENTRY: ${formatPrice(entryResult.triggerClose)} USD`,
            `STRUCTURE: ARMED (${entryResult.direction === 'short' ? 'lower high / structure loss' : 'higher low / structure reclaim'}) ✓`,
            `5м TRIGGER: ${dirLabel} ✓`,
            `15м CONFIRMATION: ${entryResult.confirmation15m ? '✓' : '—'}`,
            `FLOW: ${entryResult.flowBoost ? '✓ потвърждава' : '—'}`,
            `HTF CONTEXT: ${entryResult.htfAligned ? '✓ съвпада' : '—'}`,
            `ENTRY SCORE: ${entryResult.score}/5`,
            `⚠️ Не гони цената отвъд ${formatPrice(entryResult.structRef)} USD`,
          ];
          await sendWhatsApp(env, entryLines.join('\n'));
        } else {
          const missedLines = [
            `⚠️ ENTRY MISSED ${symbolNoUsdt}`,
            dirLabel,
            `Цената вече е твърде отдалечена от структурата (${formatPrice(entryResult.structRef)} USD)`,
            `Trigger close: ${formatPrice(entryResult.triggerClose)} USD`,
            `WAIT RETEST`,
          ];
          await sendWhatsApp(env, missedLines.join('\n'));
        }
      }
      // PHASE CYCLE ENGINE - изцяло отделно известие от горното, независимо
      // от MIN_NOTIFY_SCORE/newFired на класическия LONG/SHORT поток. Праща се
      // САМО при реална смяна на фазата (виж cyclePhaseCanFire в scanSymbolSignals).
      if (cyclePhaseChanged) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const cycleLines = [
          `🔮 ЦИКЪЛ: ${symbolNoUsdt}`,
          `Фаза: ${PHASE_LABELS[cyclePhase]}`,
          `LONG SCORE: ${cycleLongScore}/9`,
          `SHORT SCORE: ${cycleShortScore}/9`,
        ];
        await sendWhatsApp(env, cycleLines.join('\n'));
      }
      // SPARK - ранно откриване ПРЕДИ импулса (виж бележката при
      // calcSparkScore по-горе). Изцяло отделно известие, огледално на
      // "🔮 ЦИКЪЛ" - праща се САМО при нов/променен активен SPARK сигнал
      // (sparkFired, виж sparkCanFire), никога при изчистване ('none' не
      // може да е sparkKey, който предизвиква firing - виж scanSymbolSignals).
      if (sparkFired) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const fmtPct = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
        // IDEA 07 - "RELATIVE FLOW" - добавен ред към вече съществуващото SPARK
        // известие (не ново отделно съобщение, за да не създава нов спам поток -
        // виж git history за коментара за EARLY WATCH спама). SHADOW MODE -
        // чисто информативно, не влияе на sparkFired/sparkKey firing логиката.
        const relativeFlow = calcRelativeFlow({
          coinHasHardFactor: sparkTier !== 'none', coinDirection: sparkDirection,
          btcHasHardFactor: btcFlowContext.hasHardFactor, btcDirection: btcFlowContext.direction,
          coinOiDelta15m: sparkOiDelta15m, btcOiDelta15m: btcFlowContext.oiDelta15m,
          coinVolRatio: sparkVolRatio, btcVolRatio: btcFlowContext.volRatio,
        });
        const sparkLines = [
          `${SPARK_LABELS[sparkTier]} ${symbolNoUsdt} ${sparkDirection === 'long' ? '▲ LONG' : '▼ SHORT'}`,
          `SPARK SCORE: ${sparkMaxScore}/7`,
          `OI 5м: ${fmtPct(sparkOiDelta5m)} · OI 15м: ${fmtPct(sparkOiDelta15m)} · OI 1ч: ${fmtPct(sparkOiDelta1h)}`,
          `VOL 1ч/4ч ср.: ${sparkVolRatio != null ? sparkVolRatio.toFixed(2) + 'x' : '--'} · Цена 1ч: ${fmtPct(sparkChg1h)}`,
        ];
        if (RELATIVE_FLOW_LABELS[relativeFlow.classification]) {
          sparkLines.push(`${RELATIVE_FLOW_LABELS[relativeFlow.classification]} спрямо BTC`);
        }
        sparkLines.push(`⚠️ Все още НЕ Е entry - следи за развитие`);
        await sendWhatsApp(env, sparkLines.join('\n'));
      }
      // FLOW WARMING (IDEA 05, виж calcFlowWarmingScore по-горе) - изцяло
      // отделно известие, огледално на SPARK/"🔮 ЦИКЪЛ" - праща се САМО при
      // нов/променен активен flow warming сигнал (flowWarmingFired, виж
      // flowWarmingCanFire), независимо от sparkFired/sparkKey - целта е да
      // хване монети, при които OI+CVD вече ускоряват заедно, ПРЕДИ SPARK
      // да е събрал достатъчно "меки" точки, за да гръмне.
      if (flowWarmingFired) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const fmtPct = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
        const flowWarmingLines = [
          `${FLOW_WARMING_LABELS[flowWarmingTier]} ${symbolNoUsdt} ${flowWarmingDirection === 'long' ? '▲ LONG' : '▼ SHORT'}`,
          `FLOW WARMING SCORE: ${flowWarmingMaxScore}/4`,
          `OI 15м: ${fmtPct(sparkOiDelta15m)} · CVD (taker) 15м: ${fmtPct(takerDelta15m)}`,
          `VOL 1ч/4ч ср.: ${sparkVolRatio != null ? sparkVolRatio.toFixed(2) + 'x' : '--'} · Цена 1ч: ${fmtPct(sparkChg1h)}`,
          `⚠️ Все още НЕ Е entry - следи за развитие`,
        ];
        await sendWhatsApp(env, flowWarmingLines.join('\n'));
      }
      // TRAP (IDEA 01, виж calcTrapScore по-горе) - изцяло отделно известие,
      // огледално на SPARK/FLOW WARMING. ИЗРИЧНО НЕ Е entry сигнал (виж
      // предупредителния ред по-долу) - само ранно предупреждение за
      // потенциален капан (sweep + reclaim + CVD поглъщане на противоположния
      // агресивен поток) - потвърждаването/невалидирането му идва от
      // следващото реално движение, не от самия TRAP сигнал.
      if (trapFired) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const fmtPct = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
        const trapLines = [
          `${TRAP_LABELS[trapTier]} ${symbolNoUsdt} ${trapDirection === 'long' ? '▲ LONG' : '▼ SHORT'}`,
          `TRAP SCORE: ${trapMaxScore}/4`,
          `OI: ${fmtPct(oiDeltaPct)} · CVD (taker) 5м: ${fmtPct(takerDelta5m)}`,
          `⚠️ САМО ранно предупреждение - НЕ Е entry сигнал, изчакай потвърждение`,
        ];
        await sendWhatsApp(env, trapLines.join('\n'));
      }
      // RELOAD (IDEA 06, виж calcSecondImpulseTrigger по-горе) - изцяло
      // отделно известие. За разлика от SPARK/FLOW WARMING/TRAP, това е
      // реален, независим сигнал за ВТОРИ вход (не DCA, не просто watch) -
      // IMPULSE MEMORY (state.reloadWindow) вече е потвърдила контролиран
      // pullback + reclaim + обем + CVD преди да гръмне.
      if (reloadFired) {
        const symbolNoUsdt = pos.symbol.replace('USDT', '');
        const reloadLines = [
          `🔁 RELOAD ${symbolNoUsdt} ${reloadDirection === 'long' ? '▲ LONG' : '▼ SHORT'}`,
          `Втори вход след контролиран pullback (IMPULSE MEMORY)`,
        ];
        if (price != null) reloadLines.push(`Цена: ${formatPrice(price)} USD`);
        reloadLines.push(`⚠️ Провери графиката преди вход - независим сигнал, не DCA`);
        await sendWhatsApp(env, reloadLines.join('\n'));
      }
    } catch (e) { console.error(`Signal scan error for ${pos.symbol}: ${e.message}`); }
  }
}

// ---- Macro SQUEEZE следене (извиква се от scheduled()) ---------------------
// Вариант 2 от предложението "ПРЕДЛОЖЕНИЯ ЗА СЛЕДВАЩА АКТУАЛИЗАЦИЯ" (Priority 1,
// FINAL STATE ENGINE) - Scanner UI (calcSignal() в signal-logic.js) и Worker-ът
// мерят фундаментално различни неща (macro/funding-базирано срещу candle-
// детектори + SIGNAL_WEIGHTS), затова пълно обединяване в единна логика не е
// прост рефакторинг (виж PR #56). Вместо да пипаме съществуващите детектори/
// SIGNAL_WEIGHTS/SIGNAL_FAMILY_MAX/cooldown-и, Worker-ът получава ТОЧНО СЪЩАТА
// SQUEEZE проверка като Scanner UI-то (funding rate + балансирани Long/Short
// позиции), напълно отделна и независима от съществуващия LONG/SHORT поток -
// собствен KV state ключ (macrosqueeze:SYMBOL, не sigstate:SYMBOL), собствен
// cooldown, собствено WhatsApp известие. НЕ участва в MIN_NOTIFY_SCORE/
// newFired/longScore/shortScore на checkMarketSignals по-горе.
const MACRO_SQUEEZE_FUNDING_MIN = 0.06; // същия праг като calcSignal() в signal-logic.js:570
const MACRO_SQUEEZE_BALANCE_MAX_DEV = 15; // |longPct-50| < 15, същия праг
// Funding rate се обновява на Binance на всеки 8ч, а не при всеки 5-мин cron
// тик - 4ч cooldown е достатъчен да не спамва многократно, докато условието
// остане вярно между две funding обновявания.
const MACRO_SQUEEZE_COOLDOWN_MIN = 240;

function macroSqueezeCanFire(state) {
  const s = state.macroSqueezeCooldown;
  if (!s) return true;
  return (Date.now() - s.at) >= MACRO_SQUEEZE_COOLDOWN_MIN * 60000;
}
function markMacroSqueezeFired(state) {
  state.macroSqueezeCooldown = { at: Date.now() };
}
async function loadMacroSqueezeState(env, symbol) {
  if (!env.ALERT_STATE) return {};
  const raw = await env.ALERT_STATE.get(`macrosqueeze:${symbol}`);
  return raw ? JSON.parse(raw) : {};
}
async function saveMacroSqueezeState(env, symbol, state) {
  if (!env.ALERT_STATE) return;
  await env.ALERT_STATE.put(`macrosqueeze:${symbol}`, JSON.stringify(state));
}

async function checkMacroSqueeze(env, watchlist = WATCHLIST) {
  for (const pos of watchlist) {
    try {
      const [funding, longShort] = await Promise.all([
        fetchFundingWorker(env, pos.symbol),
        fetchLongShortWorker(env, pos.symbol),
      ]);
      if (funding == null || !longShort) continue;
      const longPct = parseFloat(longShort.longPct);
      const isSqueeze = funding > MACRO_SQUEEZE_FUNDING_MIN && Math.abs(longPct - 50) < MACRO_SQUEEZE_BALANCE_MAX_DEV;
      if (!isSqueeze) continue;
      const state = await loadMacroSqueezeState(env, pos.symbol);
      if (!macroSqueezeCanFire(state)) continue;
      const symbolNoUsdt = pos.symbol.replace('USDT', '');
      const lines = [
        '🟡 SQUEEZE',
        symbolNoUsdt,
        `⚡ Funding: ${funding.toFixed(4)}%`,
        `⚖️ Long/Short: ${longShort.longPct}% / ${longShort.shortPct}%`,
        '──────────',
        'Натрупване/напрежение (екстремен funding + балансирани позиции), без ясна LONG/SHORT посока още',
      ];
      await sendWhatsApp(env, lines.join('\n'));
      markMacroSqueezeFired(state);
      await saveMacroSqueezeState(env, pos.symbol, state);
    } catch (e) { console.error(`Macro squeeze check error for ${pos.symbol}: ${e.message}`); }
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

// Класифицира реакция на ЕДНА (последната затворена) 15м свещ спрямо
// зададена ръчна зона [levelLow, levelHigh] - виж бележката при
// PRICE_LEVELS_WATCHLIST по-горе за пълния контекст на 'reclaim'/'rejection'.
function calcLevelReaction(candle, levelLow, levelHigh) {
  if (!candle || levelLow == null || levelHigh == null) return 'none';
  if (candle.close > levelHigh) return 'reclaim';
  if (candle.high >= levelLow && candle.close < levelLow) return 'rejection';
  return 'none';
}

// Чете последно записаното PRICE LEVEL състояние от KV. Поддържа и стария
// формат (`reaction:openTime`, plain string) за backward-compat веднага след
// deploy - връща само reaction частта, timestamp-ът не участва в dedup-а.
function parsePriceLevelState(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.reaction === 'string') return parsed.reaction;
  } catch (e) { /* стар формат - "reaction:openTime" plain string */ }
  const legacyMatch = /^(reclaim|rejection)/.exec(raw);
  return legacyMatch ? legacyMatch[1] : null;
}

// State-transition dedup (НЕ cooldown) - известие само при РЕАЛНА смяна на
// състоянието спрямо последно записаното, независимо колко свещи е траяло:
// NEUTRAL/REJECTION -> RECLAIM = SEND, RECLAIM -> RECLAIM = NO SEND,
// RECLAIM -> REJECTION = SEND, REJECTION -> REJECTION = NO SEND,
// REJECTION -> RECLAIM = SEND. Cooldown умишлено не се ползва - той само би
// скрил проблема и след изтичането му непроменено състояние пак би пратило.
function shouldNotifyPriceLevel(lastReaction, reaction) {
  return lastReaction !== reaction;
}

// ---- Ръчни ценови нива следене (извиква се от scheduled()) -----------------
// Worker-only (огледално на checkDcaLevels по-горе - собствен KV namespace
// `pricelevel:`, НЕ споделя `sigstate:` с scanSymbolSignals, за да няма race
// condition между двете паралелни ctx.waitUntil извиквания в scheduled()).
async function checkPriceLevels(env, watchlist = PRICE_LEVELS_WATCHLIST) {
  for (const lvl of watchlist) {
    try {
      const k15 = await fetchKlinesWorker(env, lvl.symbol, '15m', 3);
      const c15 = klinesToCandles(k15);
      const c15Closed = c15.slice(0, -1);
      if (!c15Closed.length) continue;
      const lastClosed = c15Closed[c15Closed.length - 1];
      const reaction = calcLevelReaction(lastClosed, lvl.levelLow, lvl.levelHigh);
      if (reaction === 'none') continue;
      const kvKey = `pricelevel:${lvl.symbol}:${lvl.levelLow}`;
      const stored = env.ALERT_STATE ? await env.ALERT_STATE.get(kvKey) : null;
      const lastReaction = parsePriceLevelState(stored);
      if (!shouldNotifyPriceLevel(lastReaction, reaction)) continue; // същото състояние - вече известено
      const symbolNoUsdt = lvl.symbol.replace('USDT', '');
      const label = lvl.label || 'зона';
      const zoneStr = `${formatPrice(lvl.levelLow)}–${formatPrice(lvl.levelHigh)} USD`;
      const lines = reaction === 'reclaim'
        ? [`🟩 RECLAIM ${symbolNoUsdt}`, `15м свещ затвори НАД ${label} (${zoneStr})`, `Close: ${formatPrice(lastClosed.close)} USD`]
        : [`🟥 REJECTION ${symbolNoUsdt}`, `Цената тества ${label} (${zoneStr}), но 15м свещ затвори обратно под нея`, `Close: ${formatPrice(lastClosed.close)} USD`];
      await sendWhatsApp(env, lines.join('\n'));
      // timestamp-ът (openTime на свещта) се пази само за бъдещ анализ - не
      // участва в dedup решението (виж shouldNotifyPriceLevel по-горе).
      if (env.ALERT_STATE) await env.ALERT_STATE.put(kvKey, JSON.stringify({ reaction, at: lastClosed.openTime }));
    } catch (e) { console.error(`Price level check error for ${lvl.symbol}: ${e.message}`); }
  }
}

// ---- DISCOVERY RADAR (Stage B) - чисти scoring функции ---------------------
// Архитектура (обсъдена в чата, не тук): отделен, ВРЕМЕНЕН pre-filter слой
// преди CORE WATCHLIST - сканира целия пазар евтино (relay bulk /ticker24hr,
// виж Stage A), намира до 6 кандидата с необичайна/ускоряваща се активност,
// и само за тях пуска пълния (скъп) анализ (scanSymbolSignals/checkMarketSignals
// - непроменени). CORE WATCHLIST, ENTRY ENGINE и всички съществуващи прагове
// НЕ се пипат тук. Тая секция е Stage B: САМО чисти функции, БЕЗ wiring в
// scheduled() - снемане на bulk данни, KV persistence и cron интеграция идват
// в следващи Stages (C+).
//
// Договорка за реда на извикване (виж пълния конвейер в Stage C):
//   1. metrics     = calcDiscoverySnapshotMetrics(prevSnapshot, currSnapshot)
//   2. activity    = calcDiscoveryActivityScore(metrics, oldBaseline)   <- oldBaseline е ПРЕДИ тоя tick
//   3. direction   = calcDiscoveryDirection(metrics)
//   4. confidence  = calcDiscoveryConfidence(metrics, oldBaseline, direction)
//   5. newBaseline = updateDiscoveryBaseline(oldBaseline, metrics, direction) <- пази се за следващия tick
//
// v1 умишлено НЕ ползва funding/premiumIndex (виж чата - orязан scope) и
// умишлено няма "финални" калибрирани прагове - константите по-долу са
// начална точка за калибрация след реална telemetry, не постоянни стойности.
const DISCOVERY_BASELINE_EMA_ALPHA = 0.3; // тежест на новия tick в rolling средната на монетата
const DISCOVERY_MIN_BASELINE_TICKS = 3; // под толкова тикове baseline-ът се счита за "все още узряващ"
const DISCOVERY_ACTIVITY_MAX_SCORE = 5;

// Сурови delta метрики между ДВА последователни bulk /ticker24hr snapshot-а
// за ЕДНА монета. Нищо стателно, нищо мрежово - чисто аритметика. curr.high/
// curr.low са rolling 24ч стойности (не "интервален" high/low), затова
// newHigh/newLow тук значат "точно в тоя snapshot е зададен НОВ 24ч екстремум"
// - директен, чист сигнал за "накъде точно сега", без нужда от допълнителни
// заявки за истински интервален range.
function calcDiscoverySnapshotMetrics(prev, curr) {
  if (!prev || !curr) return null;
  const volumeDelta = curr.quoteVolume - prev.quoteVolume;
  const countDelta = curr.count - prev.count;
  const priceDeltaPct = prev.price > 0 ? ((curr.price - prev.price) / prev.price) * 100 : 0;
  const rangePct = curr.price > 0 ? ((curr.high - curr.low) / curr.price) * 100 : 0;
  const newHigh = curr.high > prev.high;
  const newLow = curr.low < prev.low;
  return { volumeDelta, countDelta, priceDeltaPct, rangePct, newHigh, newLow };
}

// Пази rolling (EMA) собствена база на монетата - volumeRatio/countRatio се
// смятат СПРЯМО СОБСТВЕНАТА история на монетата, никога спрямо други монети
// (малка монета никога не може честно да се сравнява по абсолютен обем с
// BTC). Извиква се СЛЕД score/direction/confidence за тоя tick (виж
// договорката по-горе) - връща НОВИЯ baseline за следващия tick, не мутира
// подадения.
function updateDiscoveryBaseline(baseline, metrics, direction) {
  const b = baseline || {
    ticks: 0, avgVolumeDelta: 0, avgCountDelta: 0, avgRangePct: 0,
    lastVolumeDelta: null, lastRangePct: null, prevRangePct: null, lastDirection: null,
  };
  if (!metrics) return b;
  const volumeDeltaClamped = Math.max(0, metrics.volumeDelta);
  const countDeltaClamped = Math.max(0, metrics.countDelta);
  const alpha = b.ticks === 0 ? 1 : DISCOVERY_BASELINE_EMA_ALPHA; // първи tick - директно сядане, не EMA
  return {
    ticks: b.ticks + 1,
    avgVolumeDelta: b.avgVolumeDelta + alpha * (volumeDeltaClamped - b.avgVolumeDelta),
    avgCountDelta: b.avgCountDelta + alpha * (countDeltaClamped - b.avgCountDelta),
    avgRangePct: b.avgRangePct + alpha * (metrics.rangePct - b.avgRangePct),
    lastVolumeDelta: volumeDeltaClamped,
    prevRangePct: b.lastRangePct,
    lastRangePct: metrics.rangePct,
    lastDirection: direction,
  };
}

// DISCOVERY ACTIVITY SCORE - "колко необичайна/ускоряваща се е активността",
// НЕ посока. volumeRatio/countRatio = тоя tick спрямо СОБСТВЕНАТА rolling
// средна (null, ако baseline-ът още няма история). acceleration = тоя tick
// delta-та е по-голяма от ПРЕДИШНАТА delta (втора производна - истинско
// ускорение, не просто "голямо е"). compressionExpansion = диапазонът се е
// свивал (baseline.prevRangePct -> baseline.lastRangePct) и СЕГА се разширява
// (baseline.lastRangePct -> metrics.rangePct) - класическата "coiled spring"
// сигнатура.
function calcDiscoveryActivityScore(metrics, baseline) {
  if (!metrics) {
    return {
      score: 0, acceleration: false, compressionExpansion: false,
      wasCompressing: false, nowExpanding: false, volumeRatio: null, countRatio: null,
    };
  }
  const hasBaseline = !!(baseline && baseline.ticks > 0);
  const volumeRatio = hasBaseline && baseline.avgVolumeDelta > 0
    ? Math.max(0, metrics.volumeDelta) / baseline.avgVolumeDelta : null;
  const countRatio = hasBaseline && baseline.avgCountDelta > 0
    ? Math.max(0, metrics.countDelta) / baseline.avgCountDelta : null;
  const acceleration = !!(hasBaseline && baseline.lastVolumeDelta != null && baseline.lastVolumeDelta > 0
    && metrics.volumeDelta > baseline.lastVolumeDelta);
  // Разбити на отделни полета (не само крайния compressionExpansion boolean) -
  // telemetry-то трябва да пази СУРОВИТЕ trigger metrics, за да можем после да
  // разберем ЗАЩО дадена монета е получила дадения score, не само колко е бил.
  const wasCompressing = !!(hasBaseline && baseline.lastRangePct != null && baseline.prevRangePct != null
    && baseline.lastRangePct < baseline.prevRangePct);
  const nowExpanding = !!(hasBaseline && baseline.lastRangePct != null && metrics.rangePct > baseline.lastRangePct);
  const compressionExpansion = wasCompressing && nowExpanding;

  let score = 0;
  if (volumeRatio != null) score += Math.min(2, volumeRatio);
  if (countRatio != null) score += Math.min(1, countRatio * 0.5);
  if (acceleration) score += 1;
  if (compressionExpansion) score += 1;
  score = Math.min(DISCOVERY_ACTIVITY_MAX_SCORE, score);

  return { score, acceleration, compressionExpansion, wasCompressing, nowExpanding, volumeRatio, countRatio };
}

// DISCOVERY DIRECTION - LONG/SHORT/NEUTRAL. Умишлено НЕ от priceChangePercent
// сам по себе си - изисква посоката на цената в СЪЩИЯ прозорец да СЪВПАДА с
// коя страна на диапазона се е разширила (нов high при качване, нов low при
// падане). Ако не съвпадат (или няма ясен нов екстремум) -> NEUTRAL, валидна
// класификация сама по себе си (BUILD-UP без ясна посока още).
function calcDiscoveryDirection(metrics) {
  if (!metrics) return 'neutral';
  const priceUp = metrics.priceDeltaPct > 0;
  const priceDown = metrics.priceDeltaPct < 0;
  if (priceUp && metrics.newHigh && !metrics.newLow) return 'long';
  if (priceDown && metrics.newLow && !metrics.newHigh) return 'short';
  return 'neutral';
}

// DISCOVERY CONFIDENCE (0-1) - колко убедителна е класификацията, НЕЗАВИСИМО
// от Activity Score. v1 умишлено БЕЗ funding модификатор (виж чата - orязан
// scope, funding идва по-късно като допълнение). Фактори: (а) достатъчно
// история за да имаме доверие в baseline-а, (б) посоката е ясна (не neutral),
// (в) наказание, ако посоката точно СЕГА се е обърнала спрямо предишния
// snapshot (флип-флоп = ниско доверие дори при висок Activity).
function calcDiscoveryConfidence(metrics, baseline, direction) {
  if (!metrics) return 0;
  let confidence = 0;
  const hasEnoughHistory = !!(baseline && baseline.ticks >= DISCOVERY_MIN_BASELINE_TICKS);
  if (hasEnoughHistory) confidence += 0.4;
  if (direction !== 'neutral') confidence += 0.3;
  const priorDirection = baseline ? baseline.lastDirection : null;
  const flipped = !!(priorDirection && direction !== 'neutral' && priorDirection !== 'neutral' && priorDirection !== direction);
  if (flipped) confidence -= 0.3;
  return Math.max(0, Math.min(1, confidence));
}

// ---- DISCOVERY RADAR (Stage C) - bulk fetch + 15-мин gate + persistence ---
// Свързва Stage B чистите функции с реални данни: relay bulk /ticker24hr
// (Stage A - целия пазар в 1 заявка) + KV persistence на snapshot/baseline
// състоянието на монета. Пуска се на ВСЕКИ CORE cron tick (5 мин), но
// вътрешно е no-op освен на всеки ~3-ти тик (DISCOVERY_RADAR_INTERVAL_MIN) -
// същия KV-timestamp gate патерн като HYSTERESIS_COOLDOWN_MIN/
// VAHVAL_REARM_COOLDOWN_MIN. Все още БЕЗ pool ranking/eviction (Stage D) и
// БЕЗ FULL ANALYSIS wiring (Stage E) - тук само сканираме и пазим score-овете.
const DISCOVERY_RADAR_INTERVAL_MIN = 15; // v1 начална точка - виж чата (5м прекалено шумно за rolling 24ч delta, 30м прекалено бавно)

async function fetchMarketWideTicker24hrWorker(env) {
  const r = await fetch(`${env.RELAY_URL}/ticker24hr?token=${encodeURIComponent(env.RELAY_TOKEN)}`);
  if (!r.ok) throw new Error(`bulk /ticker24hr HTTP ${r.status}`);
  return await r.json();
}

// Филтрира bulk отговора до DISCOVERY "вселената": само USDT-M perpetual (без
// quarterly/delivery контракти, разпознаваеми по "_" в символа), без монетите
// вече в CORE WATCHLIST (те си имат пълно 24/7 покритие - DISCOVERY е само за
// ОСТАНАЛИЯ пазар). Пропуска редове с невалидни/липсващи числови полета, без
// throw.
function filterDiscoveryUniverse(bulkTicker, coreSymbols) {
  const coreSet = new Set(coreSymbols);
  const bySymbol = {};
  if (!Array.isArray(bulkTicker)) return bySymbol;
  for (const t of bulkTicker) {
    if (!t || typeof t.symbol !== 'string') continue;
    if (!t.symbol.endsWith('USDT') || t.symbol.includes('_')) continue;
    if (coreSet.has(t.symbol)) continue;
    const price = parseFloat(t.lastPrice);
    const quoteVolume = parseFloat(t.quoteVolume);
    const count = parseFloat(t.count);
    const high = parseFloat(t.highPrice);
    const low = parseFloat(t.lowPrice);
    if (![price, quoteVolume, count, high, low].every(Number.isFinite)) continue;
    bySymbol[t.symbol] = { price, quoteVolume, count, high, low };
  }
  return bySymbol;
}

// Гейтнато обновяване (извиква се от scheduled() на всеки CORE тик, но реално
// работи само на ~DISCOVERY_RADAR_INTERVAL_MIN мин). Собствени KV ключове
// (discoverysnapshot/discoverybaseline/discoveryscores) - не споделя нищо със
// sigstate:/pricelevel:/macrosqueeze:, за да няма race condition. Собствен
// try/catch на най-горно ниво - грешка тук (напр. relay недостъпен) не бива
// да чупи error видимостта на другите, вече работещи проверки в Promise.all.
async function updateDiscoverySnapshotState(env, watchlist = WATCHLIST) {
  try {
    if (!env.ALERT_STATE || !env.RELAY_URL) return;
    const rawState = await env.ALERT_STATE.get('discoverysnapshot');
    const state = rawState ? JSON.parse(rawState) : { at: 0, bySymbol: {} };
    const now = Date.now();
    if (now - state.at < DISCOVERY_RADAR_INTERVAL_MIN * 60000) return; // още не е време

    const bulk = await fetchMarketWideTicker24hrWorker(env);
    const coreSymbols = watchlist.map((w) => w.symbol);
    const currBySymbol = filterDiscoveryUniverse(bulk, coreSymbols);

    const rawBaseline = await env.ALERT_STATE.get('discoverybaseline');
    const baselines = rawBaseline ? JSON.parse(rawBaseline) : {};

    const newBaselines = {};
    const newScores = {};
    for (const [symbol, curr] of Object.entries(currBySymbol)) {
      const prev = state.bySymbol[symbol];
      const metrics = calcDiscoverySnapshotMetrics(prev, curr);
      const oldBaseline = baselines[symbol] || null;
      const direction = calcDiscoveryDirection(metrics);
      if (metrics) {
        const activity = calcDiscoveryActivityScore(metrics, oldBaseline);
        const confidence = calcDiscoveryConfidence(metrics, oldBaseline, direction);
        newScores[symbol] = {
          score: activity.score, acceleration: activity.acceleration, compressionExpansion: activity.compressionExpansion,
          wasCompressing: activity.wasCompressing, nowExpanding: activity.nowExpanding,
          volumeRatio: activity.volumeRatio, countRatio: activity.countRatio,
          direction, confidence, price: curr.price, at: now,
        };
      }
      newBaselines[symbol] = updateDiscoveryBaseline(oldBaseline, metrics, direction);
    }

    await env.ALERT_STATE.put('discoverysnapshot', JSON.stringify({ at: now, bySymbol: currBySymbol }));
    await env.ALERT_STATE.put('discoverybaseline', JSON.stringify(newBaselines));
    await env.ALERT_STATE.put('discoveryscores', JSON.stringify(newScores));

    // Pool-ъпдейтът тръгва СЛЕД като score-овете вече са трайно записани по-горе
    // (дори ако тук долу гръмне нещо, score-овете за тоя tick не се губят) - и
    // само когато реално е имало нов radar tick (не на всеки 5-мин CORE tick),
    // за да не брои weakTicks/TTL по-често от истинския ~15-мин radar interval.
    await updateDiscoveryPool(env, newScores, now);
  } catch (e) { console.error(`DISCOVERY RADAR snapshot update error: ${e.message}`); }
}

// ---- DISCOVERY RADAR (Stage D) - pool ranking/eviction ---------------------
// Управлява DISCOVERY_POOL (макс. 6 монети): ranking по Activity Score (не
// "първите намерени"), TTL + weak-score eviction, и твърда защита - монета с
// активно ENTRY ENGINE състояние (SETUP или ARMED, виж sigstate:{symbol}) НЕ
// може да отпадне нито от TTL, нито от слаб score, нито от ranking
// displacement. FULL ANALYSIS (Stage E) все още не съществува, затова пуловите
// кандидати днес никога реално нямат setup/armed - защитата вече е коректна и
// тествана със синтетично sigstate, но е "тиха" в продукция до Stage E.
const DISCOVERY_POOL_MAX_SIZE = 6;
const DISCOVERY_POOL_TTL_MS = 48 * 3600000; // 48ч - начална точка (виж чата), не финална
const DISCOVERY_WEAK_SCORE_THRESHOLD = 1; // Activity Score под това ниво се брои "слаб" tick
const DISCOVERY_WEAK_TICK_LIMIT = 4; // толкова ПОРЕДНИ слаби тика (~1ч при 15-мин radar interval) -> eviction

// Твърдата защита - "заключена" монета (активен SETUP или ARMED) никога не
// отпада, независимо от TTL/score/ranking. sigstate е точно това, което
// loadSymbolState(env, symbol) връща (виж по-горе) - state.setup/state.armed
// са обекти при активно състояние, null иначе.
function isDiscoveryPoolMemberLocked(sigstate) {
  return !!(sigstate && (sigstate.setup || sigstate.armed));
}

// Чиста orchestrator функция - взима текущия pool + тазтиковите score-ове +
// кои symbol-и в pool-а са заключени, връща новия pool + списък изгонени (с
// причина). Три отделни, независими начина за напускане на pool-а:
//   - 'ttl_expired'  - изтекъл TTL (само НЕзаключени)
//   - 'weak_score'   - DISCOVERY_WEAK_TICK_LIMIT поредни слаби тика (само НЕзаключени)
//   - 'displaced'    - нов/друг кандидат с по-висок Activity Score е заел
//                      мястото му при ranking-а (само НЕзаключени, и само за
//                      кандидати, които РЕАЛНО вече са били в pool-а - нов
//                      кандидат, който просто не е бил избран тоя tick, не се
//                      брои за "изгонен", защото никога не е влизал)
// Заключените членове ВИНАГИ пазят слота си - остатъчният капацитет
// (maxSize - брой заключени) се конкурира само измежду НЕзаключените
// оцелели + новите кандидати, ранкирани по Activity Score низходящо.
function computeDiscoveryPoolUpdate({ currentPool, scoresBySymbol, lockedSymbols, now, config }) {
  const isLocked = (symbol) => !!(lockedSymbols && lockedSymbols.has(symbol));

  const ttlSurvivors = [];
  const ttlOrWeakExited = [];
  for (const member of currentPool) {
    const scoreEntry = scoresBySymbol[member.symbol];
    if (isLocked(member.symbol)) {
      ttlSurvivors.push({
        ...member, locked: true,
        lastScore: scoreEntry ? scoreEntry.score : member.lastScore,
        lastDirection: scoreEntry ? scoreEntry.direction : member.lastDirection,
        lastConfidence: scoreEntry ? scoreEntry.confidence : member.lastConfidence,
      });
      continue;
    }
    const isWeakTick = !scoreEntry || scoreEntry.score < config.weakScoreThreshold;
    const refreshed = {
      ...member, locked: false,
      weakTicks: isWeakTick ? (member.weakTicks || 0) + 1 : 0,
      lastScore: scoreEntry ? scoreEntry.score : member.lastScore,
      lastDirection: scoreEntry ? scoreEntry.direction : member.lastDirection,
      lastConfidence: scoreEntry ? scoreEntry.confidence : member.lastConfidence,
    };
    if (now - member.enteredAt >= config.ttlMs) { ttlOrWeakExited.push({ ...refreshed, exitReason: 'ttl_expired' }); continue; }
    if (refreshed.weakTicks >= config.weakTickLimit) { ttlOrWeakExited.push({ ...refreshed, exitReason: 'weak_score' }); continue; }
    ttlSurvivors.push(refreshed);
  }

  const lockedMembers = ttlSurvivors.filter((m) => m.locked);
  const unlockedSurvivors = ttlSurvivors.filter((m) => !m.locked);
  const survivorSymbols = new Set(ttlSurvivors.map((m) => m.symbol));
  // Символ, изгонен ТОЧНО тоя tick (TTL/weak-score), НЕ бива веднага да се
  // третира като "нов кандидат" само защото пак присъства в scoresBySymbol -
  // иначе TTL/weak-score изгонването реално никога не се случва, докато
  // score-ът му е достатъчно добър за ranking-а.
  const justExitedSymbols = new Set(ttlOrWeakExited.map((m) => m.symbol));
  const newCandidates = Object.keys(scoresBySymbol)
    .filter((symbol) => !survivorSymbols.has(symbol) && !isLocked(symbol) && !justExitedSymbols.has(symbol))
    .map((symbol) => ({
      symbol, enteredAt: now, weakTicks: 0, locked: false,
      lastScore: scoresBySymbol[symbol].score, lastDirection: scoresBySymbol[symbol].direction,
      lastConfidence: scoresBySymbol[symbol].confidence,
      // Immutable "снимка" от МОМЕНТА на влизане в pool-а (за разлика от
      // last* по-горе, които се презаписват всеки tick) - DISCOVERY EPISODE
      // TELEMETRY (Stage F) се нуждае от ОРИГИНАЛНАТА цена/score/посока/
      // увереност, не от най-скорошните.
      discoveryPrice: scoresBySymbol[symbol].price, discoveryScore: scoresBySymbol[symbol].score,
      discoveryDirection: scoresBySymbol[symbol].direction, discoveryConfidence: scoresBySymbol[symbol].confidence,
    }));

  const openSlots = Math.max(0, config.maxSize - lockedMembers.length);
  const ranked = [...unlockedSurvivors, ...newCandidates]
    .sort((a, b) => (b.lastScore ?? -Infinity) - (a.lastScore ?? -Infinity));
  const kept = ranked.slice(0, openSlots);
  const displaced = ranked.slice(openSlots)
    .filter((m) => unlockedSurvivors.includes(m))
    .map((m) => ({ ...m, exitReason: 'displaced' }));

  return { newPool: [...lockedMembers, ...kept], exited: [...ttlOrWeakExited, ...displaced] };
}

// Wiring: чете/пише discoverypool в KV, чете sigstate само за текущите (макс.
// 6) pool членове, за да прецени locked статуса им - собствен try/catch, за
// да не завлече вече записаните score-ове по-горе, ако тук нещо гръмне.
async function updateDiscoveryPool(env, scoresBySymbol, now = Date.now()) {
  if (!env.ALERT_STATE) return;
  try {
    const rawPool = await env.ALERT_STATE.get('discoverypool');
    const currentPool = rawPool ? JSON.parse(rawPool) : [];

    const lockedSymbols = new Set();
    for (const member of currentPool) {
      const sigstate = await loadSymbolState(env, member.symbol);
      if (isDiscoveryPoolMemberLocked(sigstate)) lockedSymbols.add(member.symbol);
    }

    const { newPool, exited } = computeDiscoveryPoolUpdate({
      currentPool, scoresBySymbol, lockedSymbols, now,
      config: {
        maxSize: DISCOVERY_POOL_MAX_SIZE, ttlMs: DISCOVERY_POOL_TTL_MS,
        weakScoreThreshold: DISCOVERY_WEAK_SCORE_THRESHOLD, weakTickLimit: DISCOVERY_WEAK_TICK_LIMIT,
      },
    });

    await env.ALERT_STATE.put('discoverypool', JSON.stringify(newPool));
    if (exited.length) console.log(`DISCOVERY RADAR pool exits: ${exited.map((e) => `${e.symbol}(${e.exitReason})`).join(', ')}`);
  } catch (e) { console.error(`DISCOVERY RADAR pool update error: ${e.message}`); }
}

// ---- DISCOVERY RADAR (Stage E) - FULL ANALYSIS wiring ----------------------
// Пуска СЪЩАТА, напълно непроменена checkMarketSignals/scanSymbolSignals
// верига (TARGET/TRAP/AUCTION/MIGRATION/VAH-VAL/CYCLE/SPARK/ENTRY ENGINE) за
// текущите DISCOVERY_POOL членове - нулев нов логически риск, само различен
// watchlist подаден. За разлика от updateDiscoverySnapshotState/
// updateDiscoveryPool (гейтнати на ~15 мин), тук се пуска на ВСЕКИ CORE cron
// tick (5 мин) - членството в pool-а се решава рядко (Stage D), но веднъж
// избрана, монетата се следи със СЪЩАТА честота като CORE WATCHLIST, за да не
// изостава ENTRY ENGINE прецизността ѝ (5м trigger candle, 15м confirmation).
// Приема, че pool-ът МОЖЕ да е до ~5 мин остарял спрямо последния Stage D
// ъпдейт (двете вървят паралелно в Promise.all, не последователно) - дребно,
// самокоригиращо се разминаване на следващия tick, приемливо на фона на
// вече съществуващата ~5-мин "davност" на BTC контекста по-долу.
async function runDiscoveryFullAnalysis(env, watchlist = WATCHLIST) {
  try {
    if (!env.ALERT_STATE) return;
    const rawPool = await env.ALERT_STATE.get('discoverypool');
    const pool = rawPool ? JSON.parse(rawPool) : [];
    if (!pool.length) return;
    // Explicit dedup guard (defense-in-depth) - filterDiscoveryUniverse (Stage
    // C) вече изключва CORE символите при влизане в pool-а, но тук пак
    // филтрираме - за да не разчитаме СИГУРНОСТТА "един symbol никога не се
    // анализира два пъти в един цикъл" единствено на коректността на друг,
    // по-раншен stage. Дори ако CORE WATCHLIST/pool-ът се разминат по някаква
    // бъдеща причина, тоя ред гарантира нулево дублиране тук и сега.
    const coreSymbols = new Set(watchlist.map((w) => w.symbol));
    const dedupedPool = pool.filter((m) => !coreSymbols.has(m.symbol));
    if (!dedupedPool.length) return;
    const rawBtc = await env.ALERT_STATE.get('btcflowcontext');
    const btcFlowContext = rawBtc ? JSON.parse(rawBtc) : null; // null -> checkMarketSignals пада на neutral default (виж по-горе)
    const poolWatchlist = dedupedPool.map((m) => ({ symbol: m.symbol }));
    await checkMarketSignals(env, poolWatchlist, btcFlowContext);
    // Stage F - ХРОНОЛОГИЧНО СЛЕД FULL ANALYSIS по-горе (не отделен Promise.all
    // запис), за да вижда най-пресните sigstate/telemetry от тик-а, който
    // току-що приключи, вместо да рискува ~5-мин race condition.
    await updateDiscoveryEpisodes(env, dedupedPool);
  } catch (e) { console.error(`DISCOVERY RADAR full analysis error: ${e.message}`); }
}

// ---- DISCOVERY RADAR (Stage F) - discovery episode telemetry --------------
// Свързва целия lifecycle DISCOVERY -> SETUP -> ARMED -> ENTRY -> OUTCOME в
// ЕДНО проследимо "episode" гнездо на symbol (собствен KV namespace
// discoveryepisode:{symbol}:{enteredAt} - enteredAt е и episode ID, и
// DISCOVERY timestamp-а, вече пазен от Stage D pool member-а). ЧИСТО
// telemetry - нито един праг/gate/notification по-горе не чете тия записи
// обратно. Всички данни идват от вече съществуващи, вече изчислени
// източници - НУЛА нови мрежови заявки:
//   - discovery: discoveryPrice/discoveryScore/discoveryDirection/
//     discoveryConfidence от самия pool member (Stage D, вече immutable)
//   - setup: sigstate.setup.{at,price} - price добавен в markSetupFired
//     по-горе (чисто описателно поле, никой threshold/gate не го чете)
//   - armed: sigstate.armed.{at,priceAtArm} - priceAtArm вече съществуваше
//     отпреди (ENTRY TRIGGER контекст), само го четем тук
//   - entry/outcome: съществуващият telemetry:{symbol}:{at} запис
//     (buildTelemetryRecord/finalizePendingOutcomes по-горе) - четем го, не
//     го променяме

// Първи (най-ранен) SETUP след DISCOVERY - еднократно, никога не се презаписва.
function applyDiscoveryEpisodeSetup(episode, sigstate) {
  if (episode.setup || !sigstate || !sigstate.setup) return episode;
  const at = sigstate.setup.at;
  const setupPrice = sigstate.setup.price ?? null;
  const leadTimeSetupMin = (at - episode.discovery.at) / 60000;
  const pctMoveToSetup = (setupPrice != null && episode.discovery.price > 0)
    ? ((setupPrice - episode.discovery.price) / episode.discovery.price) * 100 : null;
  return {
    ...episode, setup: { at, price: setupPrice },
    derived: { ...episode.derived, leadTimeSetupMin, pctMoveToSetup },
    status: 'setup',
  };
}

// Първи (най-ранен) ARMED след DISCOVERY - еднократно, никога не се презаписва.
function applyDiscoveryEpisodeArmed(episode, sigstate) {
  if (episode.armed || !sigstate || !sigstate.armed) return episode;
  const at = sigstate.armed.at;
  const armedPrice = sigstate.armed.priceAtArm ?? null;
  const leadTimeArmedMin = (at - episode.discovery.at) / 60000;
  const pctMoveToArmed = (armedPrice != null && episode.discovery.price > 0)
    ? ((armedPrice - episode.discovery.price) / episode.discovery.price) * 100 : null;
  return {
    ...episode, armed: { at, price: armedPrice },
    derived: { ...episode.derived, leadTimeArmedMin, pctMoveToArmed },
    status: 'armed',
  };
}

// Първо ENTRY/MISSED/VETO телеметрично събитие след DISCOVERY - еднократно.
// ATR-нормализираният price travel (atrMoveToEntry) се смята САМО тук, защото
// atr5m е вече изчислен и записан в СЪЩЕСТВУВАЩИЯ telemetry запис - никакъв
// нов fetch, точно за SETUP/ARMED нямаме готов ATR под ръка, затова там няма
// ATR-нормализирана метрика (умишлено, виж заявката).
function applyDiscoveryEpisodeEntry(episode, entryTelemetryRecord) {
  if (episode.entry || !entryTelemetryRecord) return episode;
  const { at, decision, triggerClose: entryPrice, entryScore, atr5m, chaseDistanceAtrRatio, outcome15m } = entryTelemetryRecord;
  const leadTimeEntryMin = (at - episode.discovery.at) / 60000;
  const pctMoveToEntry = (entryPrice != null && episode.discovery.price > 0)
    ? ((entryPrice - episode.discovery.price) / episode.discovery.price) * 100 : null;
  const atrMoveToEntry = (atr5m > 0 && entryPrice != null && episode.discovery.price != null)
    ? Math.abs(entryPrice - episode.discovery.price) / atr5m : null;
  return {
    ...episode,
    entry: {
      at, price: entryPrice, decision, entryScore: entryScore ?? null,
      atr5m: atr5m ?? null, chaseDistanceAtrRatio: chaseDistanceAtrRatio ?? null,
      outcome15m: outcome15m ?? null,
    },
    derived: { ...episode.derived, leadTimeEntryMin, pctMoveToEntry, atrMoveToEntry },
    // 'missed'/'veto' нямат смислен outcome за измерване (нищо не е отворено) -
    // завършваме епизода веднага; 'confirmed' чака съществуващия +15м outcome механизъм.
    status: decision === 'confirmed' ? 'entry_pending_outcome' : 'complete',
  };
}

// Опреснява outcome15m от СЪЩИЯ вече записан entry telemetry запис, веднъж
// щом съществуващият +15м outcome механизъм (finalizePendingOutcomes) го
// попълни - чисто четене, никаква нова логика за самия outcome.
function applyDiscoveryEpisodeOutcome(episode, freshOutcome15m) {
  if (!episode.entry || episode.entry.decision !== 'confirmed' || episode.entry.outcome15m != null || freshOutcome15m == null) {
    return episode;
  }
  return { ...episode, entry: { ...episode.entry, outcome15m: freshOutcome15m }, status: 'complete' };
}

// Построява НАЧАЛНИЯ episode запис от pool member-а (Stage D discoveryPrice/
// discoveryScore/discoveryDirection/discoveryConfidence - immutable снимка
// от момента на влизане в pool-а).
function buildDiscoveryEpisode(poolMember) {
  return {
    symbol: poolMember.symbol,
    enteredAt: poolMember.enteredAt,
    discovery: {
      at: poolMember.enteredAt, price: poolMember.discoveryPrice ?? null,
      activityScore: poolMember.discoveryScore ?? null, direction: poolMember.discoveryDirection ?? null,
      confidence: poolMember.discoveryConfidence ?? null,
    },
    setup: null, armed: null, entry: null, derived: {},
    status: 'discovery',
  };
}

// Намира ПЪРВИЯ (най-ранен) telemetry:{symbol}:* запис с at >= sinceAt - без
// да тегли стойностите на всички кандидати, само листва ключовете (евтино),
// сортира по вградения в самия ключ timestamp, после чете САМО избрания.
async function findFirstEntryTelemetryRecord(env, symbol, sinceAt) {
  const listResult = await env.ALERT_STATE.list({ prefix: `telemetry:${symbol}:` });
  const candidates = (listResult.keys || [])
    .map((k) => ({ name: k.name, at: parseInt(k.name.split(':')[2], 10) }))
    .filter((c) => Number.isFinite(c.at) && c.at >= sinceAt)
    .sort((a, b) => a.at - b.at);
  if (!candidates.length) return null;
  const raw = await env.ALERT_STATE.get(candidates[0].name);
  return raw ? JSON.parse(raw) : null;
}

// Wiring: за всеки текущ (дедупликиран, виж runDiscoveryFullAnalysis) pool
// член - зарежда/създава episode-а, напредва setup/armed от sigstate,
// намира/опреснява entry+outcome от съществуващия telemetry:. Собствен
// try/catch НА СИМВОЛ (един счупен episode не бива да спре останалите).
async function updateDiscoveryEpisodes(env, pool) {
  if (!env.ALERT_STATE || !pool || !pool.length) return;
  for (const member of pool) {
    try {
      const episodeKey = `discoveryepisode:${member.symbol}:${member.enteredAt}`;
      const rawEpisode = await env.ALERT_STATE.get(episodeKey);
      let episode = rawEpisode ? JSON.parse(rawEpisode) : buildDiscoveryEpisode(member);
      if (episode.status === 'complete') continue;

      const sigstate = await loadSymbolState(env, member.symbol);
      episode = applyDiscoveryEpisodeSetup(episode, sigstate);
      episode = applyDiscoveryEpisodeArmed(episode, sigstate);

      if (!episode.entry) {
        const entryRecord = await findFirstEntryTelemetryRecord(env, member.symbol, episode.discovery.at);
        episode = applyDiscoveryEpisodeEntry(episode, entryRecord);
      } else if (episode.status === 'entry_pending_outcome') {
        const rawTelemetry = await env.ALERT_STATE.get(`telemetry:${member.symbol}:${episode.entry.at}`);
        const freshRecord = rawTelemetry ? JSON.parse(rawTelemetry) : null;
        episode = applyDiscoveryEpisodeOutcome(episode, freshRecord ? freshRecord.outcome15m : null);
      }

      await env.ALERT_STATE.put(episodeKey, JSON.stringify(episode));
    } catch (e) { console.error(`DISCOVERY RADAR episode update error for ${member.symbol}: ${e.message}`); }
  }
}

// Агрегира вече заредени/филтрирани discoveryepisode: записи (чисто
// in-memory, БЕЗ KV достъп тук - виж /discovery-episodes ендпойнта по-долу),
// огледално на buildTelemetrySummary по-горе.
function buildDiscoveryEpisodeSummary(episodes) {
  const summary = {
    total: episodes.length,
    byStatus: { discovery: 0, setup: 0, armed: 0, entry_pending_outcome: 0, complete: 0 },
    bySymbol: {},
    avgLeadTimeSetupMin: null, avgLeadTimeArmedMin: null, avgLeadTimeEntryMin: null,
    avgPctMoveToSetup: null, avgPctMoveToArmed: null, avgPctMoveToEntry: null,
    avgAtrMoveToEntry: null,
    outcome: { count: 0, avgOutcomePct: null, winRatePct: null },
  };
  const acc = { leadSetup: [], leadArmed: [], leadEntry: [], pctSetup: [], pctArmed: [], pctEntry: [], atrEntry: [], outcomes: [] };
  for (const ep of episodes) {
    if (summary.byStatus[ep.status] != null) summary.byStatus[ep.status]++;
    summary.bySymbol[ep.symbol] = (summary.bySymbol[ep.symbol] || 0) + 1;
    const d = ep.derived || {};
    if (d.leadTimeSetupMin != null) acc.leadSetup.push(d.leadTimeSetupMin);
    if (d.leadTimeArmedMin != null) acc.leadArmed.push(d.leadTimeArmedMin);
    if (d.leadTimeEntryMin != null) acc.leadEntry.push(d.leadTimeEntryMin);
    if (d.pctMoveToSetup != null) acc.pctSetup.push(d.pctMoveToSetup);
    if (d.pctMoveToArmed != null) acc.pctArmed.push(d.pctMoveToArmed);
    if (d.pctMoveToEntry != null) acc.pctEntry.push(d.pctMoveToEntry);
    if (d.atrMoveToEntry != null) acc.atrEntry.push(d.atrMoveToEntry);
    if (ep.entry && ep.entry.decision === 'confirmed' && ep.entry.outcome15m != null) acc.outcomes.push(ep.entry.outcome15m);
  }
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  summary.avgLeadTimeSetupMin = avg(acc.leadSetup);
  summary.avgLeadTimeArmedMin = avg(acc.leadArmed);
  summary.avgLeadTimeEntryMin = avg(acc.leadEntry);
  summary.avgPctMoveToSetup = avg(acc.pctSetup);
  summary.avgPctMoveToArmed = avg(acc.pctArmed);
  summary.avgPctMoveToEntry = avg(acc.pctEntry);
  summary.avgAtrMoveToEntry = avg(acc.atrEntry);
  summary.outcome.count = acc.outcomes.length;
  summary.outcome.avgOutcomePct = avg(acc.outcomes);
  summary.outcome.winRatePct = acc.outcomes.length ? (acc.outcomes.filter((o) => o > 0).length / acc.outcomes.length) * 100 : null;
  return summary;
}

export {
  calcDCALevels, checkDcaLevels, checkPriceLevels, sendWhatsApp, scanSymbolSignals, checkMarketSignals, checkMacroSqueeze,
  updateDiscoverySnapshotState, runDiscoveryFullAnalysis,
};

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

    // ENTRY ENGINE TELEMETRY - read-only debug ендпойнт (виж buildTelemetrySummary
    // по-горе). Fail-closed token auth (TELEMETRY_TOKEN secret), огледално на
    // /tv-alert по-горе. Чисто READ - никакво управление/промяна на прагове,
    // само извличане на вече натрупаните telemetry: KV записи за анализ.
    if (path === "/telemetry" && request.method === "GET") {
      const suppliedToken = (url.searchParams.get("token") || "").trim();
      const expectedToken = (env.TELEMETRY_TOKEN || "").trim();
      if (!expectedToken || suppliedToken !== expectedToken) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { "Content-Type": "application/json" }
        });
      }
      if (!env.ALERT_STATE) {
        return new Response(JSON.stringify({ error: "ALERT_STATE not configured" }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
      const symbolFilter = url.searchParams.get("symbol");
      const decisionFilter = url.searchParams.get("decision"); // confirmed|missed|veto
      const directionFilter = url.searchParams.get("direction"); // long|short
      const since = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : null;
      const until = url.searchParams.get("until") ? Number(url.searchParams.get("until")) : null;
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);
      const MAX_KEYS_SCANNED = 2000; // безопасен таван - предпазва от прекалено скъпа заявка

      const prefix = symbolFilter ? `telemetry:${symbolFilter}:` : "telemetry:";
      let allKeys = [];
      let cursor;
      do {
        const listResult = await env.ALERT_STATE.list({ prefix, cursor, limit: 1000 });
        allKeys.push(...listResult.keys);
        cursor = listResult.list_complete ? undefined : listResult.cursor;
      } while (cursor && allKeys.length < MAX_KEYS_SCANNED);
      const truncated = allKeys.length > MAX_KEYS_SCANNED;
      allKeys = allKeys.slice(0, MAX_KEYS_SCANNED);

      const records = [];
      for (const k of allKeys) {
        const raw = await env.ALERT_STATE.get(k.name);
        if (!raw) continue;
        let rec;
        try { rec = JSON.parse(raw); } catch (e) { continue; }
        if (decisionFilter && rec.decision !== decisionFilter) continue;
        if (directionFilter && rec.direction !== directionFilter) continue;
        if (since != null && rec.at < since) continue;
        if (until != null && rec.at > until) continue;
        records.push(rec);
      }
      records.sort((a, b) => b.at - a.at); // най-новите първи

      return new Response(JSON.stringify({
        count: records.length, truncated,
        records: records.slice(0, limit),
        summary: buildTelemetrySummary(records),
      }), { headers: { "Content-Type": "application/json" } });
    }

    // DISCOVERY RADAR - discoveryepisode: read-only debug ендпойнт (Stage F
    // companion, виж buildDiscoveryEpisodeSummary по-горе). Огледален на
    // /telemetry по-горе - същия TELEMETRY_TOKEN, същия fail-closed auth,
    // същия MAX_KEYS_SCANNED таван. Чисто READ - никакво управление на pool/
    // episode състоянието тук.
    if (path === "/discovery-episodes" && request.method === "GET") {
      const suppliedToken = (url.searchParams.get("token") || "").trim();
      const expectedToken = (env.TELEMETRY_TOKEN || "").trim();
      if (!expectedToken || suppliedToken !== expectedToken) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { "Content-Type": "application/json" }
        });
      }
      if (!env.ALERT_STATE) {
        return new Response(JSON.stringify({ error: "ALERT_STATE not configured" }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
      const symbolFilter = url.searchParams.get("symbol");
      const statusFilter = url.searchParams.get("status"); // discovery|setup|armed|entry_pending_outcome|complete
      const since = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : null;
      const until = url.searchParams.get("until") ? Number(url.searchParams.get("until")) : null;
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);
      const MAX_KEYS_SCANNED = 2000;

      const prefix = symbolFilter ? `discoveryepisode:${symbolFilter}:` : "discoveryepisode:";
      let allKeys = [];
      let cursor;
      do {
        const listResult = await env.ALERT_STATE.list({ prefix, cursor, limit: 1000 });
        allKeys.push(...listResult.keys);
        cursor = listResult.list_complete ? undefined : listResult.cursor;
      } while (cursor && allKeys.length < MAX_KEYS_SCANNED);
      const truncated = allKeys.length > MAX_KEYS_SCANNED;
      allKeys = allKeys.slice(0, MAX_KEYS_SCANNED);

      const records = [];
      for (const k of allKeys) {
        const raw = await env.ALERT_STATE.get(k.name);
        if (!raw) continue;
        let rec;
        try { rec = JSON.parse(raw); } catch (e) { continue; }
        if (statusFilter && rec.status !== statusFilter) continue;
        const discoveredAt = rec.discovery ? rec.discovery.at : null;
        if (since != null && (discoveredAt == null || discoveredAt < since)) continue;
        if (until != null && (discoveredAt == null || discoveredAt > until)) continue;
        records.push(rec);
      }
      records.sort((a, b) => (b.discovery ? b.discovery.at : 0) - (a.discovery ? a.discovery.at : 0)); // най-новите първи

      return new Response(JSON.stringify({
        count: records.length, truncated,
        records: records.slice(0, limit),
        summary: buildDiscoveryEpisodeSummary(records),
      }), { headers: { "Content-Type": "application/json" } });
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
    ctx.waitUntil(Promise.all([checkDcaLevels(env), checkMarketSignals(env), checkMacroSqueeze(env), checkPriceLevels(env), updateDiscoverySnapshotState(env), runDiscoveryFullAnalysis(env)]));
  }
};
