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
console.log(`RELAY_TOKEN configured: ${TOKEN ? 'yes (' + TOKEN.length + ' chars)' : 'no'}`);

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

function requireToken(url, res) {
  if (!TOKEN) return true; // no token configured - allow (not recommended, but don't hard-fail)
  const supplied = (url.searchParams.get('token') || '').trim();
  if (supplied === TOKEN) return true;
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

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`Relay listening on port ${PORT}`));
