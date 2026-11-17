// PUBLIC GRAVITY (/liq-gravity-public) - за dashboard-а (gabas82.github.io),
// виж discussion-а "WLD картата/market maker ликвидност": показва посоката +
// разстоянието до най-близкия реален клъстер от Binance ликвидации,
// НЕЗАВИСИМО от WATCH/CONFIRMED tier прага (виж buildLiqGravityPublicSnapshot).
// Покрива:
// (A) buildLiqGravityPublicSnapshot - чист helper, null клъстер -> undefined
//     (пази byte-identical sigstate при липса на клъстер - виж call site-а в
//     scanSymbolSignals), direction = знакът на distancePct, не liqGravityDirection.
// (B) /liq-gravity-public endpoint - БЕЗ token (нарочно публичен), read-only
//     (не пише в KV), връща само символите с реален клъстер, пропуска останалите.
import { describe, it, expect, afterEach } from 'vitest';
import { buildLiqGravityPublicSnapshot, WATCHLIST } from './worker/worker.js';
import worker from './worker/worker.js';

const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

describe('(A) buildLiqGravityPublicSnapshot', () => {
  it('clusterPrice == null -> undefined (няма идентифициран клъстер)', () => {
    expect(buildLiqGravityPublicSnapshot({ tier: 'none', distancePct: null, clusterPrice: null, clusterUsd: null, price: 100 })).toBeUndefined();
  });

  it('клъстер НАД цената -> direction long (цената вероятно се тегли нагоре натам)', () => {
    Date.now = () => 1234567890000;
    const snap = buildLiqGravityPublicSnapshot({ tier: 'watch', distancePct: 2.5, clusterPrice: 102500, clusterUsd: 3000000, price: 100000 });
    expect(snap).toEqual({ tier: 'watch', direction: 'long', distancePct: 2.5, clusterPrice: 102500, clusterUsd: 3000000, price: 100000, at: 1234567890000 });
  });

  it('клъстер ПОД цената -> direction short', () => {
    const snap = buildLiqGravityPublicSnapshot({ tier: 'confirmed', distancePct: -1.8, clusterPrice: 98200, clusterUsd: 5000000, price: 100000 });
    expect(snap.direction).toBe('short');
  });

  it('tier none (под hasHardFactor прага) все пак се връща, щом клъстер е намерен - публичната снимка е НЕЗАВИСИМА от WhatsApp alert прага', () => {
    const snap = buildLiqGravityPublicSnapshot({ tier: 'none', distancePct: 5, clusterPrice: 105000, clusterUsd: 2100000, price: 100000 });
    expect(snap).toBeDefined();
    expect(snap.tier).toBe('none');
  });
});

describe('(B) /liq-gravity-public endpoint', () => {
  const call = (env) => worker.fetch(new Request('https://w.mock/liq-gravity-public'), env, { waitUntil() {} });
  function makeKv(seed = {}) {
    const m = new Map(Object.entries(seed));
    let wrote = false;
    return {
      m,
      wrote: () => wrote,
      get: async (k) => (m.has(k) ? m.get(k) : null),
      put: async (k, v) => { wrote = true; m.set(k, v); },
      delete: async (k) => { m.delete(k); },
      list: async () => ({ keys: [], list_complete: true }),
    };
  }

  it('без ALERT_STATE -> 500', async () => {
    const res = await call({});
    expect(res.status).toBe(500);
  });

  it('празен KV (нито една монета с клъстер) -> 0 от 35, clusters обект празен', async () => {
    const res = await call({ ALERT_STATE: makeKv() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalSymbols).toBe(WATCHLIST.length);
    expect(body.updatedSymbols).toBe(0);
    expect(body.clusters).toEqual({});
  });

  it('НЕ изисква token - достъпен без Authorization/token параметър', async () => {
    const res = await call({ ALERT_STATE: makeKv() });
    expect(res.status).not.toBe(401);
  });

  it('символи с liqGravityPublic в sigstate се връщат, останалите се пропускат', async () => {
    const btcSnap = { tier: 'watch', direction: 'long', distancePct: 2.1, clusterPrice: 102000, clusterUsd: 3500000, price: 99900, at: 1700000000000 };
    const kv = makeKv({
      'sigstate:BTCUSDT': JSON.stringify({ liqGravityPublic: btcSnap, otherField: 'untouched' }),
      'sigstate:ETHUSDT': JSON.stringify({ someOtherState: 1 }), // няма liqGravityPublic - пропуска се
    });
    const res = await call({ ALERT_STATE: kv });
    const body = await res.json();
    expect(body.updatedSymbols).toBe(1);
    expect(body.clusters.BTCUSDT).toEqual(btcSnap);
    expect(body.clusters.ETHUSDT).toBeUndefined();
  });

  it('read-only - не пише в KV', async () => {
    const kv = makeKv({ 'sigstate:BTCUSDT': JSON.stringify({ liqGravityPublic: { tier: 'watch', direction: 'long', distancePct: 1, clusterPrice: 100, clusterUsd: 2000000, price: 99, at: 1 } }) });
    await call({ ALERT_STATE: kv });
    expect(kv.wrote()).toBe(false);
  });

  it('CORS - достъпен от gabas82.github.io (Access-Control-Allow-Origin: *)', async () => {
    const res = await call({ ALERT_STATE: makeKv() });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
