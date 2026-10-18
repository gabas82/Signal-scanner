// football-worker/football-worker.test.js — PR 1 (EXTRACT/PREPARATION) тестове
// за новия self-contained Football-only Worker artifact (football-worker/worker.js,
// предложено Cloudflare име "football-dashboard-proxy", НЕ deploy-нат никъде).
// Директен ESM import на РЕАЛНИЯ export default (не копие/harness extraction),
// огледално на ../worker-apisports-liveall.test.js подхода за стария worker.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from './worker.js';

function okFetchResponse(body) {
  return new Response(JSON.stringify(body), { status: 200 });
}

// Лек, in-memory мок на Cloudflare Workers Cache API (caches.default) -
// същия мок, използван в ../worker-apisports-liveall.test.js.
function createMockCache() {
  const store = new Map();
  return {
    async match(req) {
      const entry = store.get(req.url);
      if (!entry) return undefined;
      if (Date.now() >= entry.expiresAt) { store.delete(req.url); return undefined; }
      return new Response(entry.body, { headers: new Headers(entry.headers) });
    },
    async put(req, res) {
      const body = await res.text();
      const cacheControl = res.headers.get('Cache-Control') || '';
      const m = /max-age=(\d+)/.exec(cacheControl);
      const maxAgeMs = m ? parseInt(m[1], 10) * 1000 : 0;
      store.set(req.url, { body, headers: Object.fromEntries(res.headers.entries()), expiresAt: Date.now() + maxAgeMs });
    },
    size() { return store.size; },
  };
}

const BASE = 'https://football-worker.test';
const CANONICAL_UPSTREAM = 'https://v3.football.api-sports.io/fixtures?live=all';

// DEPENDENCY CONFIRMATION (т.4 от задачата) - env обект, съдържащ
// ИЗКЛЮЧИТЕЛНО двата документирани secrets. Ако worker.js някога започне да
// очаква друго поле (напр. scanner-specific ALERT_STATE/RELAY_URL), всеки
// тест по-долу, който реално упражнява fetch логиката, веднага би получил
// `undefined` на мястото на тоя secret и съответният upstream header assertion
// би се провалил - това Е dependency-доказателството, не просто твърдение.
function makeMinimalEnv() {
  return { FOOTBALL_DATA_TOKEN: 'test-fd-token', APISPORTS_KEY: 'test-as-key' };
}

let mockCache;
beforeEach(() => {
  mockCache = createMockCache();
  vi.stubGlobal('caches', { default: mockCache });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('football-worker/worker.js - dependency confirmation (т.4)', () => {
  it('source не съдържа никакви scanner-specific идентификатори (ALERT_STATE/scheduled/WhatsApp/telemetry/discovery/CG_API_KEY/RELAY_/TV_ALERT_TOKEN/TELEMETRY_TOKEN)', () => {
    const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
    const forbidden = [
      'ALERT_STATE', 'scheduled', 'sendWhatsApp', 'CALLMEBOT', 'TEXTMEBOT',
      'TELEMETRY_TOKEN', 'TV_ALERT_TOKEN', 'RELAY_URL', 'RELAY_TOKEN',
      'CG_API_KEY', 'discoverywakeup', 'scanSymbolSignals', 'checkMarketSignals',
      'checkDcaLevels', 'checkMacroSqueeze', 'coinglass', 'CoinGlass',
    ];
    for (const token of forbidden) {
      expect(src.includes(token)).toBe(false);
    }
  });

  it('единствените env.* препратки в source-а са FOOTBALL_DATA_TOKEN и APISPORTS_KEY', () => {
    const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
    const matches = [...src.matchAll(/env\.[A-Z_]+/g)].map(m => m[0]);
    const unique = [...new Set(matches)];
    expect(unique.sort()).toEqual(['env.APISPORTS_KEY', 'env.FOOTBALL_DATA_TOKEN']);
  });

  it('работи коректно с env, съдържащ ИЗКЛЮЧИТЕЛНО FOOTBALL_DATA_TOKEN + APISPORTS_KEY (нулеви други полета)', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ matches: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/football/matches'), makeMinimalEnv());
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][1].headers['X-Auth-Token']).toBe('test-fd-token');
  });
});

describe('football-worker/worker.js - /football/ (football-data.org)', () => {
  it('разрешен path (/matches) -> проксира с X-Auth-Token, връща data', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ matches: [{ id: 1 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/football/matches?status=FINISHED'), makeMinimalEnv());
    const data = await res.json();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.football-data.org/v4/matches?status=FINISHED');
    expect(fetchMock.mock.calls[0][1].headers['X-Auth-Token']).toBe('test-fd-token');
    expect(data.matches[0].id).toBe(1);
  });

  it('разрешен path (/competitions/2000/scorers) -> проксира коректно', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ scorers: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await worker.fetch(new Request(BASE + '/football/competitions/2000/scorers?limit=50'), makeMinimalEnv());
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.football-data.org/v4/competitions/2000/scorers?limit=50');
  });

  it('забранен path (извън whitelist) -> 403 Forbidden, нулев upstream fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/football/areas'), makeMinimalEnv());
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('upstream provider грешка (напр. {"message":...}) минава through непроменена към caller-а', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ message: 'You reached your request limit.' }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/football/matches'), makeMinimalEnv());
    const data = await res.json();
    expect(res.status).toBe(200); // Worker-ът НЕ интерпретира тялото, само проксира
    expect(data.message).toBe('You reached your request limit.');
  });
});

describe('football-worker/worker.js - /apisports/ (api-sports.io) - основни пътища', () => {
  it('разрешен path (/fixtures?league=...) -> проксира с x-apisports-key', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ errors: [], results: 1, response: [{ fixture: { id: 1 } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/apisports/fixtures?league=172&season=2026'), makeMinimalEnv());
    const data = await res.json();
    expect(fetchMock.mock.calls[0][0]).toBe('https://v3.football.api-sports.io/fixtures?league=172&season=2026');
    expect(fetchMock.mock.calls[0][1].headers['x-apisports-key']).toBe('test-as-key');
    expect(data.results).toBe(1);
  });

  it('разрешен path (/standings) -> проксира коректно', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ response: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await worker.fetch(new Request(BASE + '/apisports/standings?league=172&season=2026'), makeMinimalEnv());
    expect(fetchMock.mock.calls[0][0]).toBe('https://v3.football.api-sports.io/standings?league=172&season=2026');
  });

  it('забранен path (извън whitelist) -> 403 Forbidden, нулев upstream fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/apisports/odds'), makeMinimalEnv());
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('upstream provider грешка (HTTP 200 + errors.rateLimit тяло) минава through непроменена', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ errors: { rateLimit: 'Too many requests.' }, results: 0, response: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/apisports/fixtures?league=172&season=2026'), makeMinimalEnv());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.errors.rateLimit).toBeTruthy();
  });
});

describe('football-worker/worker.js - /apisports/fixtures?live=all (PR #138 cache + single-flight)', () => {
  it('позитивен отговор (response.length>0) се cache-ва с 15s TTL', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ errors: [], results: 1, response: [{ fixture: { id: 1 } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeMinimalEnv());
    const data = await res.json();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(CANONICAL_UPSTREAM);
    expect(data.results).toBe(1);
    expect(mockCache.size()).toBe(1);

    fetchMock.mockClear();
    const res2 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeMinimalEnv());
    const data2 = await res2.json();
    expect(fetchMock).not.toHaveBeenCalled(); // cache hit
    expect(data2.results).toBe(1);
  });

  it('errors:[], results:0, response:[] - НЕ се cache-ва (uniform zero-response policy от PR #138 PRE-MERGE fix)', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ errors: [], results: 0, response: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeMinimalEnv());
    const data = await res.json();
    expect(data.results).toBe(0);
    expect(mockCache.size()).toBe(0);

    fetchMock.mockClear();
    await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeMinimalEnv());
    expect(fetchMock).toHaveBeenCalledTimes(1); // пак реален upstream, не stale нула
  });

  it('provider error (errors.rateLimit) НЕ се cache-ва', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => okFetchResponse({ errors: { rateLimit: 'Too many requests.' }, results: 0, response: [] }))
      .mockImplementationOnce(() => okFetchResponse({ errors: [], results: 6, response: [{ fixture: { id: 1 } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const res1 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeMinimalEnv());
    const data1 = await res1.json();
    expect(data1.errors.rateLimit).toBeTruthy();
    expect(mockCache.size()).toBe(0);

    const res2 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeMinimalEnv());
    const data2 = await res2.json();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(data2.results).toBe(6);
  });

  it('конкурентни live=all заявки (преди resolve) -> точно 1 реален upstream fetch (single-flight)', async () => {
    let resolveFetch;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchMock);
    const p1 = worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeMinimalEnv());
    const p2 = worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeMinimalEnv());
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 1 });
    } finally {
      // Винаги резолвираме, дори ако assertion-ът по-горе се провали - иначе
      // module-level apisportsLiveAllInflightPromise остава увиснал за
      // всички следващи тестове (същия защитен pattern като в
      // ../worker-apisports-liveall.test.js Test E).
      resolveFetch(okFetchResponse({ errors: [], results: 5, response: [{ fixture: { id: 5 } }] }));
    }
    const [res1, res2] = await Promise.all([p1, p2]);
    const [d1, d2] = await Promise.all([res1.json(), res2.json()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(d1.results).toBe(5);
    expect(d2.results).toBe(5);
  });
});

describe('football-worker/worker.js - CORS', () => {
  it('/football/ отговорът носи Access-Control-Allow-Origin: *', async () => {
    vi.stubGlobal('fetch', vi.fn(() => okFetchResponse({ matches: [] })));
    const res = await worker.fetch(new Request(BASE + '/football/matches'), makeMinimalEnv());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('/apisports/ отговорът носи Access-Control-Allow-Origin: *', async () => {
    vi.stubGlobal('fetch', vi.fn(() => okFetchResponse({ response: [] })));
    const res = await worker.fetch(new Request(BASE + '/apisports/standings?league=172&season=2026'), makeMinimalEnv());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('403 Forbidden отговорите НЕ носят Access-Control-Allow-Origin (непроменено поведение, огледално на стария worker.js)', async () => {
    const res = await worker.fetch(new Request(BASE + '/football/areas'), makeMinimalEnv());
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

// Diagnostic logging (репеир план basis - виж discussion-а "root-cause trace -
// API-Sports/football-data.org rate limit"). Тества: (1) правилните полета се
// логват за [FD-WORKER-DIAG]/[AS-WORKER-DIAG] в success/provider-error
// сценарии; (2) explicit 4-header allowlist се чете коректно, когато е
// налично в upstream response-а; (3) SECURITY BOUNDARY - нито env secret
// стойностите (FOOTBALL_DATA_TOKEN/APISPORTS_KEY), нито request headers
// (X-Auth-Token/x-apisports-key имена), нито blanket headers dump се появяват
// в кой да е console.log извикан от worker-а; (4) response contract-ът
// (status/body/headers към caller-а) остава byte-for-byte същия с/без
// diagnostic logging-а активен.
describe('football-worker/worker.js - diagnostic logging (repair plan basis)', () => {
  let logSpy;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('[FD-WORKER-DIAG] - успешен отговор логва upstreamStatus/hasMatchesArray/matchesCount коректно', async () => {
    vi.stubGlobal('fetch', vi.fn(() => okFetchResponse({ matches: [{ id: 1 }, { id: 2 }] })));
    await worker.fetch(new Request(BASE + '/football/matches?date=2026-10-18'), makeMinimalEnv());
    const call = logSpy.mock.calls.find(c => c[0] === '[FD-WORKER-DIAG]');
    expect(call).toBeTruthy();
    const logged = call[1];
    expect(logged.path).toBe('/matches?date=2026-10-18');
    expect(logged.upstreamStatus).toBe(200);
    expect(logged.providerMessage).toBeNull();
    expect(logged.providerErrorCode).toBeNull();
    expect(logged.hasMatchesArray).toBe(true);
    expect(logged.matchesCount).toBe(2);
  });

  it('[FD-WORKER-DIAG] - provider error body (message+errorCode) се логва коректно, hasMatchesArray=false', async () => {
    vi.stubGlobal('fetch', vi.fn(() => okFetchResponse({ message: 'You reached your request limit.', errorCode: 429 })));
    await worker.fetch(new Request(BASE + '/football/matches'), makeMinimalEnv());
    const logged = logSpy.mock.calls.find(c => c[0] === '[FD-WORKER-DIAG]')[1];
    expect(logged.providerMessage).toBe('You reached your request limit.');
    expect(logged.providerErrorCode).toBe(429);
    expect(logged.hasMatchesArray).toBe(false);
    expect(logged.matchesCount).toBeNull();
  });

  it('[AS-WORKER-DIAG] (generic branch) - успешен отговор логва hasProviderErrors=false, providerErrors от body', async () => {
    vi.stubGlobal('fetch', vi.fn(() => okFetchResponse({ errors: [], results: 1, response: [{ fixture: { id: 1 } }] })));
    await worker.fetch(new Request(BASE + '/apisports/fixtures?league=172&season=2026&date=2026-10-18'), makeMinimalEnv());
    const logged = logSpy.mock.calls.find(c => c[0] === '[AS-WORKER-DIAG]')[1];
    expect(logged.path).toBe('/fixtures?league=172&season=2026&date=2026-10-18');
    expect(logged.upstreamStatus).toBe(200);
    expect(logged.hasProviderErrors).toBe(false);
  });

  it('[AS-WORKER-DIAG] (generic branch) - provider rateLimit error + explicit 4-header allowlist се четат коректно', async () => {
    const upstreamHeaders = new Headers({
      'x-ratelimit-requests-limit': '7500',
      'x-ratelimit-requests-remaining': '0',
    });
    vi.stubGlobal('fetch', vi.fn(() => new Response(
      JSON.stringify({ errors: { rateLimit: 'Too many requests. You have reached your daily request limit.' }, results: 0, response: [] }),
      { status: 200, headers: upstreamHeaders }
    )));
    await worker.fetch(new Request(BASE + '/apisports/fixtures?league=203&season=2026&date=2026-10-18'), makeMinimalEnv());
    const logged = logSpy.mock.calls.find(c => c[0] === '[AS-WORKER-DIAG]')[1];
    expect(logged.hasProviderErrors).toBe(true);
    expect(logged.providerErrors.rateLimit).toContain('daily request limit');
    expect(logged.rateLimitRequestsLimit).toBe('7500');
    expect(logged.rateLimitRequestsRemaining).toBe('0');
    expect(logged.rateLimitLimit).toBeNull(); // различно header-name - не е подадено в тоя мок
    expect(logged.rateLimitRemaining).toBeNull();
  });

  it('[AS-WORKER-DIAG] (generic branch) - case-insensitive header lookup потвърден (различна casing в upstream отговора)', async () => {
    const upstreamHeaders = new Headers({ 'X-RateLimit-Limit': '300', 'X-RateLimit-Remaining': '5' });
    vi.stubGlobal('fetch', vi.fn(() => new Response(JSON.stringify({ response: [] }), { status: 200, headers: upstreamHeaders })));
    await worker.fetch(new Request(BASE + '/apisports/standings?league=172&season=2026'), makeMinimalEnv());
    const logged = logSpy.mock.calls.find(c => c[0] === '[AS-WORKER-DIAG]')[1];
    expect(logged.rateLimitLimit).toBe('300');
    expect(logged.rateLimitRemaining).toBe('5');
  });

  it('[AS-WORKER-DIAG] (live=all branch) - логва се отделно от cache/single-flight логиката, с правилните полета', async () => {
    const upstreamHeaders = new Headers({ 'x-ratelimit-requests-limit': '7500', 'x-ratelimit-requests-remaining': '7499' });
    vi.stubGlobal('fetch', vi.fn(() => new Response(
      JSON.stringify({ errors: [], results: 1, response: [{ fixture: { id: 1 } }] }),
      { status: 200, headers: upstreamHeaders }
    )));
    await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeMinimalEnv());
    const logged = logSpy.mock.calls.find(c => c[0] === '[AS-WORKER-DIAG]')[1];
    expect(logged.path).toBe('/fixtures?live=all');
    expect(logged.hasProviderErrors).toBe(false);
    expect(logged.rateLimitRequestsLimit).toBe('7500');
    expect(logged.rateLimitRequestsRemaining).toBe('7499');
  });

  it('SECURITY BOUNDARY - никой console.log извикан от worker-а не съдържа секретните стойности (FOOTBALL_DATA_TOKEN/APISPORTS_KEY)', async () => {
    vi.stubGlobal('fetch', vi.fn((url, init) => okFetchResponse({ matches: [], response: [] })));
    await worker.fetch(new Request(BASE + '/football/matches'), makeMinimalEnv());
    await worker.fetch(new Request(BASE + '/apisports/fixtures?league=172&season=2026'), makeMinimalEnv());
    const serialized = JSON.stringify(logSpy.mock.calls);
    expect(serialized).not.toContain('test-fd-token');
    expect(serialized).not.toContain('test-as-key');
  });

  it('SECURITY BOUNDARY - никой console.log не съдържа request header имена (X-Auth-Token/x-apisports-key) нито request обекта самия', async () => {
    vi.stubGlobal('fetch', vi.fn(() => okFetchResponse({ matches: [], response: [] })));
    await worker.fetch(new Request(BASE + '/football/matches'), makeMinimalEnv());
    await worker.fetch(new Request(BASE + '/apisports/fixtures?league=172&season=2026'), makeMinimalEnv());
    const serialized = JSON.stringify(logSpy.mock.calls);
    expect(serialized).not.toContain('X-Auth-Token');
    expect(serialized).not.toContain('x-apisports-key');
  });

  it('SECURITY BOUNDARY - нулев blanket headers dump (логнатите обекти имат точно документираните полета, не произволен headers обект)', async () => {
    const upstreamHeaders = new Headers({ 'x-ratelimit-requests-limit': '7500', 'some-other-upstream-header': 'irrelevant-value' });
    vi.stubGlobal('fetch', vi.fn(() => new Response(JSON.stringify({ response: [] }), { status: 200, headers: upstreamHeaders })));
    await worker.fetch(new Request(BASE + '/apisports/standings?league=172&season=2026'), makeMinimalEnv());
    const logged = logSpy.mock.calls.find(c => c[0] === '[AS-WORKER-DIAG]')[1];
    const keys = Object.keys(logged).sort();
    expect(keys).toEqual(['hasProviderErrors', 'path', 'providerErrors', 'rateLimitLimit', 'rateLimitRemaining', 'rateLimitRequestsLimit', 'rateLimitRequestsRemaining', 'upstreamStatus'].sort());
    const serialized = JSON.stringify(logSpy.mock.calls);
    expect(serialized).not.toContain('irrelevant-value'); // non-allowlisted header никога не достига до log-а
  });

  it('RESPONSE CONTRACT - diagnostic logging-ът НЕ променя body/status/headers на връщания Response (/football/)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => okFetchResponse({ matches: [{ id: 42 }] })));
    const res = await worker.fetch(new Request(BASE + '/football/matches'), makeMinimalEnv());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(data).toEqual({ matches: [{ id: 42 }] });
    expect(logSpy.mock.calls.some(c => c[0] === '[FD-WORKER-DIAG]')).toBe(true); // логването Е станало
  });

  it('RESPONSE CONTRACT - diagnostic logging-ът НЕ променя body/status/headers на връщания Response (/apisports/)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => okFetchResponse({ errors: [], results: 1, response: [{ fixture: { id: 7 } }] })));
    const res = await worker.fetch(new Request(BASE + '/apisports/fixtures?league=172&season=2026'), makeMinimalEnv());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(data.response[0].fixture.id).toBe(7);
    expect(logSpy.mock.calls.some(c => c[0] === '[AS-WORKER-DIAG]')).toBe(true);
  });
});

describe('football-worker/worker.js - непознат root route', () => {
  it('path извън /football/ и /apisports/ -> 404 Not found, нулев upstream fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/tv-alert'), makeMinimalEnv());
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Not found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('root "/" -> 404 Not found', async () => {
    const res = await worker.fetch(new Request(BASE + '/'), makeMinimalEnv());
    expect(res.status).toBe(404);
  });
});
