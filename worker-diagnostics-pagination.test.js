// DIAGNOSTICS ENDPOINT PAGINATION FIX (2026-11-25, виж discussion-а
// "/cluster-diagnostics пагинация") - четирите диагностични endpoint-а по-долу
// правеха единична env.ALERT_STATE.list({prefix}) заявка без да проверяват
// list_complete/cursor. Cloudflare KV връща макс. 1000 ключа на страница -
// при >1000 натрупани записа предишният код мълчаливо показваше само ЧАСТ
// (в лексикографски, НЕ хронологичен ред), докато closedCount/count твърдяха,
// че това Е пълният брой. Потвърдено с реални production данни: /cluster-
// diagnostics показваше 1000 от реално 6467 clusterevent: записа (седмичен
// анализ, 24.11.2026); /tag-outcome-diagnostics - 1000 от реално 2118
// (седмичен преглед, 22.11.2026).
//
// Поправката реюзва вече доказания listKvKeysWithTruncation helper (същия,
// който вече коректно захранва /trend-observation-diagnostics, /telemetry,
// /tc-lifecycle - виж worker-entry-telemetry-integrity.test.js за неговите
// собствени honest-truncation тестове).
//
// SUBREQUEST LIMIT HOTFIX (СЪЩИЯ ден, няколко минути след първия deploy) -
// първият опит тук ползваше MAX_KEYS_SCANNED=10000/5000/2000 - всеки .get()
// по-долу е отделна Worker subrequest, а Cloudflare капва на ~1000
// subrequests/invocation. /cluster-diagnostics (10000, ~6467 реални записа)
// реално хвърли 500 на живо секунди след deploy ("error code: 1101"
// - uncaught exception). Моите mock-базирани тестове НЕ можеха да хванат
// това, защото mock-овете нямат такъв лимит - затова тук сега тестваме и
// изрично "голям реалистичен dataset -> НЕ хвърля грешка" регресионно, не
// само "не капва на старата 1000-page граница".
//
// Крайна стойност: MAX_KEYS_SCANNED=500 за всичките 4 - сигурен марж под
// subrequest лимита (+35 за WATCHLIST trackedEntries в /cluster-diagnostics).
// Честно по-тесен прозорец от преди, но НИКОГА не крашва, и truncated вече
// казва истината.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import {
  clusterEventKey, cmeGapEventKey,
} from './worker/worker.js';
import worker from './worker/worker.js';

const workerSrc = fs.readFileSync('./worker/worker.js', 'utf8');

// Реалистичен многостраничен KV мок - за разлика от еднократните makeKv()
// мокове в другите test файлове (винаги list_complete:true, игнорират
// limit/cursor), този РЕАЛНО капва всяка страница на подадения limit и връща
// cursor, точно като истинския Cloudflare KV.list(); брои и .get() повикванията
// - за да можем да докажем, че общият брой subrequests остава безопасно
// ограничен дори при хиляди seed-нати ключа (регресионен тест за днешния 500).
function makePaginatedKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  let listCalls = 0, getCalls = 0;
  return {
    m,
    listCallCount: () => listCalls,
    getCallCount: () => getCalls,
    get: async (k) => { getCalls++; return m.has(k) ? m.get(k) : null; },
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
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

describe('Структурна проверка - и 4-те endpoint-а вече викат listKvKeysWithTruncation', () => {
  it('/cluster-diagnostics', () => {
    expect(workerSrc).toMatch(/listKvKeysWithTruncation\(env\.ALERT_STATE, CLUSTER_EVENT_KV_PREFIX, MAX_KEYS_SCANNED\)/);
  });
  it('/rotation-diagnostics', () => {
    expect(workerSrc).toMatch(/listKvKeysWithTruncation\(env\.ALERT_STATE, "rotation:", MAX_KEYS_SCANNED\)/);
  });
  it('/cme-gap-diagnostics', () => {
    expect(workerSrc).toMatch(/listKvKeysWithTruncation\(env\.ALERT_STATE, CME_GAP_EVENT_KV_PREFIX, MAX_KEYS_SCANNED\)/);
  });
  it('/tag-outcome-diagnostics', () => {
    expect(workerSrc).toMatch(/listKvKeysWithTruncation\(env\.ALERT_STATE, "tagoutcome:", MAX_KEYS_SCANNED\)/);
  });
  it('нито един от 4-те вече НЕ прави директен list({prefix: ...}) без cursor (старият бъг)', () => {
    // Единствените оставащи "голи" .list({ prefix заявки трябва да са: helper-ът
    // самия (1), maybeSendDailyRotationDigest (production cron, отделен discussion,
    // не диагностичен endpoint) и findFirstEntryTelemetryRecord (per-symbol, нисък
    // обем) - вижда се по broя срещи по-долу.
    const bareListMatches = [...workerSrc.matchAll(/\.list\(\{\s*prefix:(?!\s*,\s*cursor)/g)];
    expect(bareListMatches.length).toBe(3); // helper-ът, rotation digest, findFirstEntryTelemetryRecord
  });
  it('MAX_KEYS_SCANNED за всичките 4 е безопасно под Cloudflare subrequest лимита (500, не 10000/5000/2000 както при първия, счупен опит)', () => {
    const matches = [...workerSrc.matchAll(/const MAX_KEYS_SCANNED = (\d+);/g)].map(m => Number(m[1]));
    // 10 общо в целия файл (4-те тук + 6-те по-стари, недокоснати endpoint-а) -
    // проверяваме само че никой от НАШИТЕ 4 вече не е >500.
    const highValues = matches.filter(v => v > 500);
    expect(highValues.length).toBeLessThanOrEqual(6); // колкото бяха ПРЕДИ тази промяна (другите 6 endpoint-а, недокоснати тук)
  });
});

describe('/cluster-diagnostics - функционална проверка', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/cluster-diagnostics${qs}`), env, { waitUntil() {} });

  it('200 clusterevent: записа (под 500) -> closedCount=200, truncated:false', async () => {
    const seed = {};
    for (let i = 0; i < 200; i++) {
      const rec = { symbol: 'BTCUSDT', side: 'above', kind: 'control', openedAt: 1000 + i, closedAt: 2000 + i, closeReason: 'bounced' };
      seed[clusterEventKey(rec)] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&symbol=BTCUSDT&limit=1000');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closedCount).toBe(200);
    expect(body.truncated).toBe(false);
  });

  it('РЕГРЕСИОНЕН ТЕСТ за днешния production инцидент: 6467 clusterevent: записа (реалният обем) -> НЕ хвърля грешка, честно капва на 500 с truncated:true, общо <600 .get() извиквания', async () => {
    const seed = {};
    for (let i = 0; i < 6467; i++) {
      const rec = { symbol: `COIN${i % 35}USDT`, side: i % 2 ? 'above' : 'below', kind: i % 10 === 0 ? 'cluster' : 'control', openedAt: 1000 + i, closedAt: 2000 + i, closeReason: 'bounced' };
      seed[clusterEventKey(rec)] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=500');
    expect(res.status).toBe(200); // КЛЮЧОВО - преди hotfix-а това би хвърлило 500 на живо
    const body = await res.json();
    expect(body.closedCount).toBe(500); // честен, нов таван - не 6467, но и не крашва
    expect(body.truncated).toBe(true);
    // 35 WATCHLIST символа (trackedEntries) + ~1-2 list() страници + 500 event gets
    expect(kv.getCallCount()).toBeLessThan(600);
  });
});

describe('/rotation-diagnostics - функционална проверка', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/rotation-diagnostics${qs}`), env, { waitUntil() {} });

  it('300 rotation: записа (под 500) -> exitedCount=300', async () => {
    const seed = {};
    for (let i = 0; i < 300; i++) {
      const rec = { symbol: `COIN${i}USDT`, enteredAt: 1000 + i, exitedAt: 2000 + i, outcome: 'ok' };
      seed[`rotation:${rec.symbol}:${rec.enteredAt}`] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=1000');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exitedCount).toBe(300);
  });

  it('1500 rotation: записа (над 500) -> НЕ хвърля грешка, exitedCount=500, truncated:true', async () => {
    const seed = {};
    for (let i = 0; i < 1500; i++) {
      const rec = { symbol: `COIN${i}USDT`, enteredAt: 1000 + i, exitedAt: 2000 + i, outcome: 'ok' };
      seed[`rotation:${rec.symbol}:${rec.enteredAt}`] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=500');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exitedCount).toBe(500);
    expect(body.truncated).toBe(true);
  });
});

describe('/cme-gap-diagnostics - функционална проверка', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/cme-gap-diagnostics${qs}`), env, { waitUntil() {} });

  it('100 cmegapevent: записа (под 500) -> closedCount=100', async () => {
    const seed = {};
    for (let i = 0; i < 100; i++) {
      const rec = { symbol: 'BTC', filledAt: 1000 + i, direction: 'up' };
      seed[cmeGapEventKey(rec)] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=1000');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closedCount).toBe(100);
  });

  it('1200 cmegapevent: записа (над 500) -> НЕ хвърля грешка, closedCount=500, truncated:true', async () => {
    const seed = {};
    for (let i = 0; i < 1200; i++) {
      const rec = { symbol: 'BTC', filledAt: 1000 + i, direction: 'up' };
      seed[cmeGapEventKey(rec)] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=500');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closedCount).toBe(500);
    expect(body.truncated).toBe(true);
  });
});

describe('/tag-outcome-diagnostics - функционална проверка', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/tag-outcome-diagnostics${qs}`), env, { waitUntil() {} });

  it('400 tagoutcome: записа (под 500) -> count=400', async () => {
    const seed = {};
    for (let i = 0; i < 400; i++) {
      const rec = { symbol: 'ETHUSDT', type: 'flush', direction: 'long', at: 1000 + i, concurrentTypes: [] };
      seed[`tagoutcome:ETHUSDT:${1000 + i}:flush`] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=5000');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(400);
    expect(body.records.length).toBe(400);
  });

  it('РЕГРЕСИОНЕН ТЕСТ: 2118 tagoutcome: записа (реалният обем от седмичния преглед) -> НЕ хвърля грешка, count=500, truncated:true', async () => {
    const seed = {};
    for (let i = 0; i < 2118; i++) {
      const rec = { symbol: 'ETHUSDT', type: 'flush', direction: 'long', at: 1000 + i, concurrentTypes: [] };
      seed[`tagoutcome:ETHUSDT:${1000 + i}:flush`] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=5000');
    expect(res.status).toBe(200); // КЛЮЧОВО - преди hotfix-а (MAX_KEYS_SCANNED=10000) това би рискувало 500
    const body = await res.json();
    expect(body.count).toBe(500);
    expect(body.truncated).toBe(true);
    expect(kv.getCallCount()).toBeLessThan(550);
  });
});
