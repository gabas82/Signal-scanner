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
  if (coin.funding > 0.06 && Math.abs(coin.longPct - 50) < 15) return {signal:'SQUEEZE',ls,ss};
  if (ls >= 3) return {signal:'LONG',ls,ss}; if (ss >= 3) return {signal:'SHORT',ls,ss};
  if (ls >= 2 && ls > ss) return {signal:'LONG',ls,ss}; if (ss >= 2 && ss > ls) return {signal:'SHORT',ls,ss};
  return {signal:'NEUTRAL',ls,ss};
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
  if (coin.funding > 0.08) shortPts++;
  if (coin.longPct > 70) shortPts++;
  if (coin.chg24 > 5 && coin.oiDelta < 0) shortPts++;
  if (sig.signal === 'SHORT') shortPts++;
  if (coin.goldenCross === false) shortPts++;
  if (detectTop(coin)) shortPts++;
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

// В браузъра (класически <script>) горните декларации стават глобални и се ползват
// directly от signal-scanner.html. В Node (Vitest) ги правим достъпни през module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DCA_LEVERAGE, DCA_ENTRY, MAJOR_COINS, SEMI_MAJOR_COINS,
    MAINTENANCE_RATE_MAJOR, MAINTENANCE_RATE_SEMI, MAINTENANCE_RATE_MINOR,
    SYMBOL_MAP, fixSymbol, calcSMA, calcRSI, detectBottom, detectTop,
    calcSignal, calcSetupQuality, isManipulable, formatNum, formatPrice,
    formatOIDelta, getMaintenanceRate, calcLiquidationPrice, calcDCALevels
  };
}
