// ============================================================================
// Signal-scanner Binance relay (DigitalOcean App Platform)
// ============================================================================
// Cloudflare Workers' fetch() calling fapi.binance.com directly gets a 403
// from Binance's WAF (blocks cloud/datacenter IP ranges) - see worker/README.md
// "Binance IP block" section. This tiny relay runs on a normal VPS-backed
// platform instead, whose IP isn't targeted the same way, and simply forwards
// the two Binance Futures endpoints the worker needs. No dependencies - only
// Node's built-in http/https modules, so `npm install` has nothing to do.
// ============================================================================
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8080;
// Shared secret so a random person who finds this app's public URL can't use
// it as a free open Binance proxy. Set as an App Platform environment
// variable (RELAY_TOKEN) - the Worker must send the same value as ?token=.
// .trim() guards against a stray trailing newline/space that platform UIs
// sometimes add when a secret value is pasted into a textarea.
const TOKEN = (process.env.RELAY_TOKEN || '').trim();
// RELAY_TOKEN_PREV (coordinated secret rotation, 2026-11-26) - по избор,
// ВРЕМЕННО приет ВТОРИ валиден token по време на ротация, за да може Worker-ът
// да премине към нов RELAY_TOKEN secret БЕЗ прекъсване: (1) тук се деплойва
// RELAY_TOKEN=нов + RELAY_TOKEN_PREV=стар (relay приема и двата); (2) Worker
// секретът се обновява на новата стойност; (3) след потвърждение,
// RELAY_TOKEN_PREV се маха. Празно по подразбиране - нулева промяна в
// поведението, докато не бъде изрично зададено.
const TOKEN_PREV = (process.env.RELAY_TOKEN_PREV || '').trim();
console.log(`RELAY_TOKEN configured: ${TOKEN ? 'yes (' + TOKEN.length + ' chars)' : 'no'}${TOKEN_PREV ? `, RELAY_TOKEN_PREV also accepted (${TOKEN_PREV.length} chars)` : ''}`);

// Чиста, тестваема проверка (параметризирана, не чете env/closure директно) -
// виж discussion-а за coordinated rotation по-горе.
function isValidToken(supplied, token, tokenPrev) {
  if (!token) return true; // no token configured - allow (not recommended, but don't hard-fail)
  if (supplied === token) return true;
  if (tokenPrev && supplied === tokenPrev) return true;
  return false;
}

// BINANCE LIQUIDATION COLLECTOR (виж liquidation-collector.js) - ИЗКЛЮЧЕН,
// освен ако LIQ_COLLECTOR_ENABLED=1. Държи 1 WebSocket към Binance
// !forceOrder@arr и обслужва /liquidations. Не пипа нито един от proxy
// endpoint-ите по-долу, нито /health (App Platform health check-ът НЕ зависи
// от колектора - прекъсване към Binance никога не води до рестарт на relay-я).
let liq = { collector: null, disabledReason: 'not initialised' };
try {
  liq = require('./liquidation-collector').createCollectorFromEnv(process.env);
  if (liq.collector) liq.collector.start();
  console.log(`Liquidation collector: ${liq.collector ? 'enabled' : 'disabled (' + liq.disabledReason + ')'}`);
} catch (e) {
  liq = { collector: null, disabledReason: 'init error: ' + (e && e.message ? e.message : e) };
  console.error('Liquidation collector init failed - relay continues without it:', e);
}

function proxyToBinance(targetUrl, res) {
  https.get(targetUrl, (binRes) => {
    let body = '';
    binRes.on('data', (chunk) => { body += chunk; });
    binRes.on('end', () => {
      res.writeHead(binRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  }).on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upstream fetch failed', message: e.message }));
  });
}

// DISCOVERY RADAR (Stage A) - symbol=null/undefined/'' -> bulk URL (целия
// пазар в 1 заявка), иначе непроменено per-symbol поведение.
function buildTicker24hrTarget(symbol) {
  return symbol
    ? `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`
    : `https://fapi.binance.com/fapi/v1/ticker/24hr`;
}

function requireToken(url, res) {
  const supplied = (url.searchParams.get('token') || '').trim();
  if (isValidToken(supplied, TOKEN, TOKEN_PREV)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // App Platform's health check hits "/" with no token - must stay open.
  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/klines') {
    if (!requireToken(url, res)) return;
    const symbol = url.searchParams.get('symbol');
    const interval = url.searchParams.get('interval');
    const limit = url.searchParams.get('limit') || '500';
    if (!symbol || !interval) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbol and interval are required' }));
      return;
    }
    const target = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
    proxyToBinance(target, res);
    return;
  }

  if (url.pathname === '/ticker') {
    if (!requireToken(url, res)) return;
    const symbol = url.searchParams.get('symbol');
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbol is required' }));
      return;
    }
    const target = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`;
    proxyToBinance(target, res);
    return;
  }

  if (url.pathname === '/funding') {
    if (!requireToken(url, res)) return;
    const symbol = url.searchParams.get('symbol');
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbol is required' }));
      return;
    }
    const target = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=1`;
    proxyToBinance(target, res);
    return;
  }

  if (url.pathname === '/longshort') {
    if (!requireToken(url, res)) return;
    const symbol = url.searchParams.get('symbol');
    const period = url.searchParams.get('period') || '1h';
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbol is required' }));
      return;
    }
    const target = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&limit=1`;
    proxyToBinance(target, res);
    return;
  }

  // За PHASE CYCLE ENGINE (Open Interest история - "OI Δ15m" от предложението).
  if (url.pathname === '/openinterest') {
    if (!requireToken(url, res)) return;
    const symbol = url.searchParams.get('symbol');
    const period = url.searchParams.get('period') || '5m';
    const limit = url.searchParams.get('limit') || '30';
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbol is required' }));
      return;
    }
    const target = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&limit=${encodeURIComponent(limit)}`;
    proxyToBinance(target, res);
    return;
  }

  // За IDEA 01/05/06 (Absorption/Flow Warming/Reload - виж worker/worker.js) -
  // Binance klines дават само комбиниран обем, без buy/sell разбивка.
  // futures/data/takerlongshortRatio е най-близкият безплатен Binance proxy
  // до истинско CVD/Delta (агресивен taker обем купуване срещу продаване),
  // за разлика от globalLongShortAccountRatio по-горе (trader account ratio).
  if (url.pathname === '/takerlongshort') {
    if (!requireToken(url, res)) return;
    const symbol = url.searchParams.get('symbol');
    const period = url.searchParams.get('period') || '5m';
    const limit = url.searchParams.get('limit') || '30';
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbol is required' }));
      return;
    }
    const target = `https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&limit=${encodeURIComponent(limit)}`;
    proxyToBinance(target, res);
    return;
  }

  // За PHASE CYCLE ENGINE (order book Buy/Sell стени - за wall bias с distance filter).
  if (url.pathname === '/depth') {
    if (!requireToken(url, res)) return;
    const symbol = url.searchParams.get('symbol');
    const limit = url.searchParams.get('limit') || '500';
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbol is required' }));
      return;
    }
    const target = `https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${encodeURIComponent(limit)}`;
    proxyToBinance(target, res);
    return;
  }

  // За PHASE CYCLE ENGINE (24ч % промяна - за OVERHEATED/NO CHASE детектора) +
  // DISCOVERY RADAR (Stage A) - symbol вече е опционален: без него Binance
  // връща 24ч статистика за ВСИЧКИ futures контракти в 1 заявка ("bulk"
  // режим) - радарът така сканира целия пазар без per-symbol заявки. Старото
  // per-symbol поведение (worker.js OVERHEATED детекторът) е непроменено.
  if (url.pathname === '/ticker24hr') {
    if (!requireToken(url, res)) return;
    const symbol = url.searchParams.get('symbol');
    proxyToBinance(buildTicker24hrTarget(symbol), res);
    return;
  }

  // BINANCE LIQUIDATION COLLECTOR - read-only достъп до събраните forceOrder
  // събития (виж liquidation-collector.js). Същата RELAY_TOKEN защита.
  //   /liquidations?symbol=BTCUSDT&since=<ms>&limit=<n>&token=...
  //   /liquidations/stats?token=...
  if (url.pathname === '/liquidations' || url.pathname === '/liquidations/stats') {
    if (!requireToken(url, res)) return;
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (!liq.collector) { send(503, { enabled: false, reason: liq.disabledReason, runtime: process.version }); return; }
      if (url.pathname === '/liquidations/stats') { send(200, liq.collector.getStats()); return; }
      const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
      if (!symbol) { send(400, { error: 'symbol is required' }); return; }
      if (!liq.collector.symbols.has(symbol)) { send(400, { error: 'symbol is not collected' }); return; }
      const sinceRaw = url.searchParams.get('since');
      const since = sinceRaw != null && sinceRaw !== '' ? Number(sinceRaw) : undefined;
      if (since !== undefined && !Number.isFinite(since)) { send(400, { error: 'since must be a number (ms)' }); return; }
      const limit = url.searchParams.get('limit');
      send(200, liq.collector.query(symbol, since, { limit: limit ? Number(limit) : undefined }));
    } catch (e) {
      send(500, { error: 'collector error', message: e && e.message ? e.message : String(e) });
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// require.main === module - само когато файлът се стартира директно
// (`node server.js`, точно както App Platform прави), не когато е require-нат
// като модул (виж unit тестовете за isValidToken/buildTicker24hrTarget) -
// предпазва от реално стартиране на HTTP сървър по време на тестове.
if (require.main === module) {
  server.listen(PORT, () => console.log(`Relay listening on port ${PORT}`));
}

module.exports = { isValidToken, buildTicker24hrTarget, requireToken, server };
