// MEXC ДИАГНОСТИКА (т.3 от директивата 2026-11-26) - отговаря на въпроса
// "достижим ли е MEXC Spot/Futures ОТ САМАТА Cloudflare Workers edge мрежа".
// Виж коментара при runMexcDiagProbe в worker.js за пълния контекст (sandbox
// средата на тая conversation няма достъп до api.mexc.com, което не отговаря
// на реалния въпрос за Worker-а). Публични ticker ендпойнти - без търговски
// API ключ. Директен ESM import, огледално на другите *-diagnostics тестове.
import { describe, it, expect, afterEach } from 'vitest';
import worker, {
  fetchMexcDiagEndpoint, runMexcDiagProbe, MEXC_DIAG_SPOT_URL, MEXC_DIAG_FUTURES_URL,
} from './worker/worker.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('fetchMexcDiagEndpoint - pure, inject-ваем fetch (без реална мрежова заявка в тестовете)', () => {
  it('успешен JSON отговор -> reachable:true, httpStatus, latencyMs, parsed sample', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ symbol: 'BTCUSDT', price: '95000.12' }), { status: 200 });
    const r = await fetchMexcDiagEndpoint('https://example.test/x', 'spot', fakeFetch);
    expect(r.reachable).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.sample).toEqual({ symbol: 'BTCUSDT', price: '95000.12' });
    expect(typeof r.latencyMs).toBe('number');
  });

  it('не-JSON отговор -> sample е суровия текст (orязан до 300 символа), без crash', async () => {
    const fakeFetch = async () => new Response('not json', { status: 200 });
    const r = await fetchMexcDiagEndpoint('https://example.test/x', 'spot', fakeFetch);
    expect(r.reachable).toBe(true);
    expect(r.sample).toBe('not json');
  });

  it('мрежова грешка (напр. proxy 403 "no rule allows this host") -> reachable:false, error непразен', async () => {
    const fakeFetch = async () => { throw new Error('agent proxy: no rule or network setting allows this host'); };
    const r = await fetchMexcDiagEndpoint('https://example.test/x', 'futures', fakeFetch);
    expect(r.reachable).toBe(false);
    expect(r.error).toContain('no rule');
  });

  it('timeout (AbortSignal.timeout) -> error:"timeout", разграничено от истинска network грешка', async () => {
    const timeoutErr = new DOMException('The operation timed out.', 'TimeoutError');
    const fakeFetch = async () => { throw timeoutErr; };
    const r = await fetchMexcDiagEndpoint('https://example.test/x', 'spot', fakeFetch);
    expect(r.reachable).toBe(false);
    expect(r.error).toBe('timeout');
  });
});

describe('runMexcDiagProbe - orchestration: spot + futures паралелно', () => {
  it('извиква и двата URL-а (spot+futures), връща at + двата резултата', async () => {
    const calledUrls = [];
    const fakeFetch = async (u) => { calledUrls.push(u); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
    const result = await runMexcDiagProbe(fakeFetch);
    expect(calledUrls.sort()).toEqual([MEXC_DIAG_FUTURES_URL, MEXC_DIAG_SPOT_URL].sort());
    expect(result.spot.label).toBe('spot');
    expect(result.futures.label).toBe('futures');
    expect(typeof result.at).toBe('number');
  });

  it('spot достижим, futures не -> двата се виждат независимо (не "all or nothing")', async () => {
    const fakeFetch = async (u) => {
      if (u === MEXC_DIAG_SPOT_URL) return new Response(JSON.stringify({ price: '1' }), { status: 200 });
      throw new Error('blocked');
    };
    const result = await runMexcDiagProbe(fakeFetch);
    expect(result.spot.reachable).toBe(true);
    expect(result.futures.reachable).toBe(false);
  });
});

describe('/mexc-diag endpoint - read-only, token-защитен (огледално на /liq-diagnostics)', () => {
  const call = (path, env) => worker.fetch(new Request(`https://w.mock${path}`), env, { waitUntil() {} });

  it('без/грешен token -> 401', async () => {
    expect((await call('/mexc-diag', { TELEMETRY_TOKEN: 'tok' })).status).toBe(401);
    expect((await call('/mexc-diag?token=bad', { TELEMETRY_TOKEN: 'tok' })).status).toBe(401);
    expect((await call('/mexc-diag?token=x', {})).status).toBe(401); // без изобщо конфигуриран TELEMETRY_TOKEN -> fail-closed
  });

  it('коректен token -> 200, връща spot+futures диагностика (fetch мокнат)', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ symbol: 'BTCUSDT', price: '95000' }), { status: 200 });
    const res = await call('/mexc-diag?token=tok', { TELEMETRY_TOKEN: 'tok' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spot.reachable).toBe(true);
    expect(body.futures.reachable).toBe(true);
  });

  it('endpoint-ът НЕ пише в KV (чист read-only, нулев производствен товар)', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
    const kv = { put: async () => { throw new Error('/mexc-diag must not write to KV'); }, get: async () => { throw new Error('/mexc-diag must not read KV either - no dependency on it'); } };
    const res = await call('/mexc-diag?token=tok', { TELEMETRY_TOKEN: 'tok', ALERT_STATE: kv });
    expect(res.status).toBe(200);
  });
});
