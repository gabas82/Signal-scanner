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
// entryPrice/side се попълват само за монети, за които искаш DCA известия за
// конкретна твоя позиция. symbol винаги е нужен (Binance формат, напр. 'BTCUSDT').
const WATCHLIST = [
  // { symbol: 'BTCUSDT', entryPrice: 65000, side: 'long' },
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

// ---- CallMeBot WhatsApp helper ---------------------------------------------
async function sendWhatsApp(env, text) {
  if (!env.CALLMEBOT_PHONE || !env.CALLMEBOT_APIKEY) { console.error('CallMeBot secrets not set - skipping notification'); return; }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(env.CALLMEBOT_PHONE)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(env.CALLMEBOT_APIKEY)}`;
  try { await fetch(url); } catch (e) { console.error('CallMeBot send error:', e); }
}

// ---- DCA ниво следене (извиква се от scheduled()) --------------------------
async function checkDcaLevels(env, watchlist = WATCHLIST) {
  for (const pos of watchlist) {
    if (!pos.entryPrice || !pos.side) continue;
    try {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pos.symbol}`);
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
        await sendWhatsApp(env, `📉 ${symbolNoUsdt} (${dirLabel}) достигна ${step.label}\nЦена: $${price}\nНиво: $${step.levelPrice.toFixed(6)}\nСредна цена след ниво: $${step.avgPrice.toFixed(6)}`);
        if (env.ALERT_STATE) await env.ALERT_STATE.put(kvKey, String(Date.now()));
      }
    } catch (e) { console.error('DCA check error for', pos.symbol, e); }
  }
}

export { calcDCALevels, checkDcaLevels, sendWhatsApp };

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
    ctx.waitUntil(checkDcaLevels(env));
  }
};
