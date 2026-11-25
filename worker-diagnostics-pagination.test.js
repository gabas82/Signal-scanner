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
// собствени honest-truncation тестове). Тук тестваме КРАЙНИТЕ 4 endpoint-а:
// /cluster-diagnostics, /rotation-diagnostics, /cme-gap-diagnostics,
// /tag-outcome-diagnostics - структурно (реално викат helper-а) И
// функционално (>1000 seed-нати ключа -> пълен брой в отговора, не капнат).
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
// cursor, точно като истинския Cloudflare KV.list() - нужен е, за да се
// упражни реално do/while цикъла на listKvKeysWithTruncation през ендпойнта,
// не само през самия helper (той вече е тестван отделно).
function makePaginatedKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  let listCalls = 0;
  return {
    m,
    listCallCount: () => listCalls,
    get: async (k) => (m.has(k) ? m.get(k) : null),
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
});

describe('/cluster-diagnostics - функционална проверка (>1000 ключа)', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/cluster-diagnostics${qs}`), env, { waitUntil() {} });

  it('1200 clusterevent: записа -> closedCount=1200 (не капнато на 1000), truncated:false', async () => {
    const seed = {};
    for (let i = 0; i < 1200; i++) {
      const rec = { symbol: 'BTCUSDT', side: 'above', kind: 'control', openedAt: 1000 + i, closedAt: 2000 + i, closeReason: 'bounced' };
      seed[clusterEventKey(rec)] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&symbol=BTCUSDT&limit=1000');
    expect(res.status).toBe(200);
    const body = await res.json();
    // КЛЮЧОВАТА проверка - преди фикса closedCount спираше на 1000 (KV
    // page limit), независимо от истинския брой записи.
    expect(body.closedCount).toBe(1200);
    expect(kv.listCallCount()).toBe(2); // 2 реалистични страници (1000+200), не 1 - доказва, че пагинацията реално се случва
    // truncated:true тук е КОРЕКТНО (display ?limit= капва на 1000, а записите
    // са 1200) - отделна, легитимна причина от старата KV-пагинация дупка.
    expect(body.truncated).toBe(true);
  });
});

describe('/rotation-diagnostics - функционална проверка (>1000 ключа)', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/rotation-diagnostics${qs}`), env, { waitUntil() {} });

  it('1100 rotation: записа -> exitedCount=1100 (не капнато на 1000)', async () => {
    const seed = {};
    for (let i = 0; i < 1100; i++) {
      const rec = { symbol: `COIN${i}USDT`, enteredAt: 1000 + i, exitedAt: 2000 + i, outcome: 'ok' };
      seed[`rotation:${rec.symbol}:${rec.enteredAt}`] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=1000');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exitedCount).toBe(1100);
  });
});

describe('/cme-gap-diagnostics - функционална проверка (>1000 ключа)', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/cme-gap-diagnostics${qs}`), env, { waitUntil() {} });

  it('1050 cmegapevent: записа -> closedCount=1050 (не капнато на 1000)', async () => {
    const seed = {};
    for (let i = 0; i < 1050; i++) {
      const rec = { symbol: 'BTC', filledAt: 1000 + i, direction: 'up' };
      seed[cmeGapEventKey(rec)] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=1000');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closedCount).toBe(1050);
  });
});

describe('/tag-outcome-diagnostics - функционална проверка (>1000 ключа)', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/tag-outcome-diagnostics${qs}`), env, { waitUntil() {} });

  it('1300 tagoutcome: записа -> count=1300 (не капнато на 1000)', async () => {
    const seed = {};
    for (let i = 0; i < 1300; i++) {
      const rec = { symbol: 'ETHUSDT', type: 'flush', direction: 'long', at: 1000 + i, concurrentTypes: [] };
      seed[`tagoutcome:ETHUSDT:${1000 + i}:flush`] = JSON.stringify(rec);
    }
    const kv = makePaginatedKv(seed);
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret&limit=5000');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1300); // КЛЮЧОВАТА проверка - преди фикса би спряло на 1000
    expect(body.records.length).toBe(1300); // под ?limit=5000 - не е орязано и на display ниво
  });
});
