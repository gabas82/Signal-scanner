// findFirstEntryTelemetryRecord - ПАГИНАЦИОНЕН ФИКС (2026-11-27). Старата
// версия правеше ЕДИН env.ALERT_STATE.list() без cursor (Cloudflare подразбиране
// 1000 ключа/страница) - за символ с >1000 telemetry: записа (реалистично,
// виж 130 283 общо записа на ~35 символа), ако истинският match падаше отвъд
// първата страница, функцията тихо връщаше null въпреки съществуващ match.
// Real cursor-respecting KV mock (огледално на worker-diagnostics-pagination.test.js
// makePaginatedKv) - доказва реалното поведение, не само структурна проверка.
import { describe, it, expect } from 'vitest';
import { findFirstEntryTelemetryRecord } from './worker/worker.js';

function makePaginatedKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  let listCalls = 0, getCalls = 0;
  return {
    m,
    listCallCount: () => listCalls,
    getCallCount: () => getCalls,
    get: async (k) => { getCalls++; return m.has(k) ? m.get(k) : null; },
    put: async (k, v) => { m.set(k, v); },
    list: async ({ prefix = '', cursor, limit = 1000 } = {}) => {
      listCalls++;
      const allKeys = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? parseInt(cursor, 10) : 0;
      const page = allKeys.slice(start, start + limit);
      const nextStart = start + limit;
      const list_complete = nextStart >= allKeys.length;
      return { keys: page.map(name => ({ name })), list_complete, cursor: list_complete ? undefined : String(nextStart) };
    },
  };
}

function seedTelemetryRecords(symbol, count, startAt = 1700000000000) {
  const seed = {};
  for (let i = 0; i < count; i++) {
    const at = startAt + i * 60000; // 1 record/min - 13-digit ms timestamps throughout
    const key = `telemetry:${symbol}:${at}:mean_reversion`;
    seed[key] = JSON.stringify({ symbol, at, decision: 'confirmed' });
  }
  return seed;
}

describe('findFirstEntryTelemetryRecord - regression: истински match отвъд първата 1000-ключова страница', () => {
  it('символ с 1500 telemetry: записа, sinceAt сочи към запис #1200 (отвъд старата 1000-таван страница) -> СЕГА се намира', async () => {
    const startAt = 1700000000000;
    const seed = seedTelemetryRecords('BTCUSDT', 1500, startAt);
    const kv = makePaginatedKv(seed);
    const sinceAt = startAt + 1200 * 60000; // записът #1200 - отвъд първите 1000
    const result = await findFirstEntryTelemetryRecord({ ALERT_STATE: kv }, 'BTCUSDT', sinceAt);
    expect(result).not.toBeNull();
    expect(result.at).toBe(sinceAt); // точно записът #1200, не null (старият бъг)
    // early-exit - намира match на 2-рата страница, не сканира до края без нужда.
    expect(kv.listCallCount()).toBeLessThanOrEqual(2);
    expect(kv.getCallCount()).toBe(1); // само ЕДНО .get() - за намереният match
  });

  it('1500 записа, sinceAt в рамките на ПЪРВАТА страница -> намира се с 1 list() извикване', async () => {
    const startAt = 1700000000000;
    const seed = seedTelemetryRecords('ETHUSDT', 1500, startAt);
    const kv = makePaginatedKv(seed);
    const sinceAt = startAt + 500 * 60000;
    const result = await findFirstEntryTelemetryRecord({ ALERT_STATE: kv }, 'ETHUSDT', sinceAt);
    expect(result.at).toBe(sinceAt);
    expect(kv.listCallCount()).toBe(1);
  });

  it('sinceAt отвъд всички съществуващи записи -> null (коректно, не грешка)', async () => {
    const startAt = 1700000000000;
    const seed = seedTelemetryRecords('SOLUSDT', 50, startAt);
    const kv = makePaginatedKv(seed);
    const result = await findFirstEntryTelemetryRecord({ ALERT_STATE: kv }, 'SOLUSDT', startAt + 100 * 60000);
    expect(result).toBeNull();
  });

  it('символ без никакви telemetry: записи -> null, без crash', async () => {
    const kv = makePaginatedKv({});
    const result = await findFirstEntryTelemetryRecord({ ALERT_STATE: kv }, 'NOPEUSDT', 0);
    expect(result).toBeNull();
  });

  it('връща ПЪРВИЯ (най-ранния) match, не произволен, когато многократни записи >= sinceAt съществуват', async () => {
    const startAt = 1700000000000;
    const seed = seedTelemetryRecords('XRPUSDT', 10, startAt);
    const kv = makePaginatedKv(seed);
    const sinceAt = startAt; // всичките 10 >= sinceAt
    const result = await findFirstEntryTelemetryRecord({ ALERT_STATE: kv }, 'XRPUSDT', sinceAt);
    expect(result.at).toBe(startAt); // най-ранният, не последният
  });
});
