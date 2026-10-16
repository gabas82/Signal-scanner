// Transport mitigation (виж discussion-а "Provider rate-limit root-cause
// анализ" - football.html Dashboard-ова страна). Cloudflare Observability
// потвърди реален cluster от 3 идентични /apisports/fixtures?live=all
// заявки в рамките на <2s, вкл. поне веднъж от трафик, който НЕ носи
// сигнатурата на Dashboard-а самия (utm_source параметър). Worker-ът
// дотогава нямаше НИКАКЪВ caching/inflight dedup за тоя endpoint. Тук се
// тества РЕАЛНИЯТ worker.js код (не копие) - директен ESM import на
// export default-а, с мокнати глобални `fetch`/`caches` (Cloudflare Workers
// Cache API), огледално на вече установения extraction/harness подход за
// football.html, но тук не е нужна текстова екстракция - worker.js вече е
// ES module с explicit export.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './worker/worker.js';

function makeEnv() {
  return { APISPORTS_KEY: 'test-apisports-key' };
}

function okFetchResponse(body) {
  return new Response(JSON.stringify(body), { status: 200 });
}

// Лек, in-memory мок на Cloudflare Workers Cache API (caches.default) -
// само .match()/.put(), keyed по req.url (методът е винаги GET тук),
// зачита Cache-Control: max-age=N за TTL expiry.
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

const BASE = 'https://orange-grass-d809.gabas82.workers.dev';
const CANONICAL_UPSTREAM = 'https://v3.football.api-sports.io/fixtures?live=all';

let mockCache;
beforeEach(() => {
  mockCache = createMockCache();
  vi.stubGlobal('caches', { default: mockCache });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('worker.js /apisports/fixtures?live=all - transport mitigation (cache + single-flight)', () => {
  it('A) първа live=all заявка -> 1 upstream fetch, успешен отговор се cache-ва', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ errors: [], results: 1, response: [{ fixture: { id: 1 } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    const data = await res.json();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(CANONICAL_UPSTREAM);
    expect(data.results).toBe(1);
    expect(mockCache.size()).toBe(1);
  });

  it('B) втора live=all заявка в рамките на TTL -> 0 допълнителен upstream fetch', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ errors: [], results: 2, response: [{ fixture: { id: 2 } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    fetchMock.mockClear();
    const res2 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    const data2 = await res2.json();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data2.results).toBe(2);
  });

  it('C) tracking параметри (utm_source) не създават отделен cache entry', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ errors: [], results: 3, response: [{ fixture: { id: 3 } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    fetchMock.mockClear();
    const res2 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all&utm_source=chatgpt.com'), makeEnv());
    const data2 = await res2.json();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data2.results).toBe(3);
    expect(mockCache.size()).toBe(1); // не 2 - една и съща canonical identity
  });

  it('D) след изтичане на 15s TTL -> нов upstream fetch', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => okFetchResponse({ errors: [], results: 4, response: [{ fixture: { id: 4 } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    expect(mockCache.size()).toBe(1); // потвърждава, че наистина е cache-нато (response.length>0)
    fetchMock.mockClear();
    vi.advanceTimersByTime(15 * 1000 + 1000);
    const res2 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    const data2 = await res2.json();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data2.results).toBe(4);
  });

  it('E) конкурентни live=all заявки (преди cache population) -> точно 1 upstream fetch', async () => {
    let resolveFetch;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchMock);
    const p1 = worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    const p2 = worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    // Изчакваме микротаск опашката да се "източи" до момента, в който И
    // двете заявки вече са минали през await cache.match() и са стигнали до
    // single-flight проверката - resolveFetch() се вика в `finally`, за да
    // НЕ оставим `pending` вечно неразрешен (би запушил module-level
    // apisportsLiveAllInflightPromise за всички следващи тестове) дори ако
    // assertion-ът по-долу се провали.
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 1 });
    } finally {
      resolveFetch(okFetchResponse({ errors: [], results: 5 }));
    }
    const [res1, res2] = await Promise.all([p1, p2]);
    const [d1, d2] = await Promise.all([res1.json(), res2.json()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(d1.results).toBe(5);
    expect(d2.results).toBe(5);
  });

  it('F) upstream errors.rateLimit НЕ се cache-ва - следваща заявка пак отива upstream', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => okFetchResponse({ errors: { rateLimit: 'Too many requests. You have exceeded the maximum number of requests allowed.' }, results: 0, response: [] }))
      .mockImplementationOnce(() => okFetchResponse({ errors: [], results: 6 }));
    vi.stubGlobal('fetch', fetchMock);
    const res1 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    const data1 = await res1.json();
    expect(data1.errors.rateLimit).toBeTruthy();
    expect(mockCache.size()).toBe(0); // не cache-нато
    const res2 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    const data2 = await res2.json();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(data2.results).toBe(6);
  });

  it('G) друг provider error (не rateLimit, array форма) също НЕ се cache-ва', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => okFetchResponse({ errors: ['Invalid season value.'], results: 0, response: [] }))
      .mockImplementationOnce(() => okFetchResponse({ errors: [], results: 7 }));
    vi.stubGlobal('fetch', fetchMock);
    await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    expect(mockCache.size()).toBe(0);
    const res2 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    const data2 = await res2.json();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(data2.results).toBe(7);
  });

  it('H) /fixtures?league=... остава непроменен - винаги реален upstream fetch, без cache/single-flight', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ errors: [], results: 1, response: [{ fixture: { id: 99 } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await worker.fetch(new Request(BASE + '/apisports/fixtures?league=172&season=2026'), makeEnv());
    await worker.fetch(new Request(BASE + '/apisports/fixtures?league=172&season=2026'), makeEnv());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockCache.size()).toBe(0); // мокнатия cache никога не се пипа за тоя path
  });

  it('I) /players/topscorers и /standings остават непроменени - без cache/single-flight', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ errors: [], results: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await worker.fetch(new Request(BASE + '/apisports/players/topscorers?league=172&season=2026'), makeEnv());
    await worker.fetch(new Request(BASE + '/apisports/players/topscorers?league=172&season=2026'), makeEnv());
    await worker.fetch(new Request(BASE + '/apisports/standings?league=172&season=2026'), makeEnv());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mockCache.size()).toBe(0);
  });

  it('J) Signal-scanner routes (напр. /tv-alert) остават напълно незасегнати', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/tv-alert'), { TV_ALERT_TOKEN: 'secret' });
    expect(res.status).toBe(401); // липсващ token - непроменено поведение
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // PRE-MERGE корекция (виж discussion-а "transient/anomalous zero response
  // caching риск", production наблюдение: 6 live мача -> 0 -> 0 -> 6 отново,
  // БЕЗ user interaction). `results:0` е структурно неразличимо от "наистина
  // няма live мачове" - затова НИКАКВА нула не се кешира, uniform, без
  // heuristic/сравнение с предишно състояние.
  it('K) errors:[], results:0, response:[] -> response се връща нормално на caller-а, cache остава празен', async () => {
    const fetchMock = vi.fn(() => okFetchResponse({ errors: [], results: 0, response: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    const data = await res.json();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data.results).toBe(0);
    expect(data.response).toEqual([]);
    expect(mockCache.size()).toBe(0); // НЕ cache-нато
  });

  it('L) след zero response следваща заявка пак отива upstream (не се сервира stale нула)', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => okFetchResponse({ errors: [], results: 0, response: [] }))
      .mockImplementationOnce(() => okFetchResponse({ errors: [], results: 6, response: [1, 2, 3, 4, 5, 6].map(id => ({ fixture: { id } })) }));
    vi.stubGlobal('fetch', fetchMock);
    const res1 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    const data1 = await res1.json();
    expect(data1.results).toBe(0);
    const res2 = await worker.fetch(new Request(BASE + '/apisports/fixtures?live=all'), makeEnv());
    const data2 = await res2.json();
    expect(fetchMock).toHaveBeenCalledTimes(2); // вторият пак е реален upstream fetch, не cache hit
    expect(data2.results).toBe(6);
    expect(mockCache.size()).toBe(1); // сега вече кешираме, защото response.length>0
  });
});
