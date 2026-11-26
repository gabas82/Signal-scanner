// CME GAP TRACKER - TradingView webhook (CME_DL:BTC1!/ETH1!, 4h), два
// plain-text алерта: "CME GAP ENTERED"/"CME GAP FILLED". Stage 1 - чиста
// логика само, виж бележката преди parseCmeGapAlertText в worker.js.
import { describe, it, expect, afterEach } from 'vitest';
import {
  parseCmeGapAlertText, normalizeCmeGapSymbol, openCmeGapRecord, finalizeCmeGapRecord,
  handleCmeGapEvent, buildCmeGapAlertMessage,
  CME_GAP_KV_PREFIX, CME_GAP_EVENT_KV_PREFIX, cmeGapOpenKey, cmeGapEventKey,
  processCmeGapWebhook,
} from './worker/worker.js';
import worker from './worker/worker.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function makeKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix } = {}) => ({
      keys: [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
    }),
  };
}

const ENTERED_TEXT = 'CME GAP ENTERED — CME_DL:BTC1!\nPrice: 64083.1\nTime: 2026-11-17T16:00:00Z';
const FILLED_TEXT = 'CME GAP FILLED — CME_DL:BTC1!\nPrice: 64500.5\nTime: 2026-11-17T18:00:00Z';

describe('parseCmeGapAlertText', () => {
  it('парсва валиден ENTERED текст', () => {
    const e = parseCmeGapAlertText(ENTERED_TEXT);
    expect(e).toEqual({ type: 'entered', ticker: 'CME_DL:BTC1!', symbol: 'BTC', price: 64083.1, at: Date.parse('2026-11-17T16:00:00Z') });
  });
  it('парсва валиден FILLED текст', () => {
    const e = parseCmeGapAlertText(FILLED_TEXT);
    expect(e.type).toBe('filled');
    expect(e.price).toBe(64500.5);
  });
  it('парсва ETH1! коректно', () => {
    const e = parseCmeGapAlertText('CME GAP ENTERED — CME_DL:ETH1!\nPrice: 1820.37\nTime: 2026-11-17T16:00:00Z');
    expect(e.symbol).toBe('ETH');
    expect(e.ticker).toBe('CME_DL:ETH1!');
  });
  it('работи с нормално тире "-" вместо em-dash "—"', () => {
    const e = parseCmeGapAlertText('CME GAP ENTERED - CME_DL:BTC1!\nPrice: 100\nTime: 2026-11-17T16:00:00Z');
    expect(e).not.toBeNull();
  });
  it('нечувствителен е към регистъра на ENTERED/FILLED', () => {
    const e = parseCmeGapAlertText('CME GAP entered — CME_DL:BTC1!\nPrice: 100\nTime: 2026-11-17T16:00:00Z');
    expect(e.type).toBe('entered');
  });
  it('невалиден текст -> null, без грешка', () => {
    expect(parseCmeGapAlertText('random text')).toBeNull();
    expect(parseCmeGapAlertText('')).toBeNull();
    expect(parseCmeGapAlertText(null)).toBeNull();
    expect(parseCmeGapAlertText(undefined)).toBeNull();
    expect(() => parseCmeGapAlertText(123)).not.toThrow();
  });
  it('невалидна цена или час -> null', () => {
    expect(parseCmeGapAlertText('CME GAP ENTERED — CME_DL:BTC1!\nPrice: abc\nTime: 2026-11-17T16:00:00Z')).toBeNull();
    expect(parseCmeGapAlertText('CME GAP ENTERED — CME_DL:BTC1!\nPrice: 100\nTime: not-a-date')).toBeNull();
  });
});

describe('normalizeCmeGapSymbol', () => {
  it('премахва CME_DL: префикс и крайния 1!', () => {
    expect(normalizeCmeGapSymbol('CME_DL:BTC1!')).toBe('BTC');
    expect(normalizeCmeGapSymbol('CME_DL:ETH1!')).toBe('ETH');
  });
  it('невалиден вход се връща непроменен, без грешка', () => {
    expect(normalizeCmeGapSymbol(null)).toBeNull();
    expect(normalizeCmeGapSymbol(123)).toBe(123);
  });
});

describe('openCmeGapRecord / finalizeCmeGapRecord', () => {
  it('openCmeGapRecord пази ticker/symbol/enteredAt/enterPrice от събитието', () => {
    const event = parseCmeGapAlertText(ENTERED_TEXT);
    expect(openCmeGapRecord(event)).toEqual({ ticker: 'CME_DL:BTC1!', symbol: 'BTC', enteredAt: event.at, enterPrice: 64083.1 });
  });
  it('finalizeCmeGapRecord смята durationMin правилно при налично openRecord', () => {
    const openEvent = parseCmeGapAlertText(ENTERED_TEXT);
    const open = openCmeGapRecord(openEvent);
    const filledEvent = parseCmeGapAlertText(FILLED_TEXT);
    const rec = finalizeCmeGapRecord(open, filledEvent, 'filled');
    expect(rec.durationMin).toBe(120); // 16:00 -> 18:00
    expect(rec.originKnown).toBe(true);
    expect(rec.closeReason).toBe('filled');
  });
  it('finalizeCmeGapRecord с openRecord=null -> enteredAt/enterPrice null, originKnown false, durationMin null', () => {
    const filledEvent = parseCmeGapAlertText(FILLED_TEXT);
    const rec = finalizeCmeGapRecord(null, filledEvent, 'filled');
    expect(rec.enteredAt).toBeNull();
    expect(rec.enterPrice).toBeNull();
    expect(rec.originKnown).toBe(false);
    expect(rec.durationMin).toBeNull();
  });
});

describe('handleCmeGapEvent', () => {
  it('ENTERED без предходен отворен запис -> отваря нов, без closedRecords', () => {
    const event = parseCmeGapAlertText(ENTERED_TEXT);
    const { nextOpen, closedRecords } = handleCmeGapEvent(null, event);
    expect(nextOpen).toEqual(openCmeGapRecord(event));
    expect(closedRecords).toEqual([]);
  });
  it('FILLED след ENTERED -> затваря с closeReason filled, nextOpen null', () => {
    const entered = parseCmeGapAlertText(ENTERED_TEXT);
    const { nextOpen: open1 } = handleCmeGapEvent(null, entered);
    const filled = parseCmeGapAlertText(FILLED_TEXT);
    const { nextOpen, closedRecords } = handleCmeGapEvent(open1, filled);
    expect(nextOpen).toBeNull();
    expect(closedRecords.length).toBe(1);
    expect(closedRecords[0]).toMatchObject({ closeReason: 'filled', durationMin: 120 });
  });
  it('FILLED без предходен ENTERED -> затворен запис с originKnown false', () => {
    const filled = parseCmeGapAlertText(FILLED_TEXT);
    const { nextOpen, closedRecords } = handleCmeGapEvent(null, filled);
    expect(nextOpen).toBeNull();
    expect(closedRecords[0].originKnown).toBe(false);
  });
  it('нов ENTERED докато предходен е все още отворен -> затваря стария като superseded, отваря нов', () => {
    const entered1 = parseCmeGapAlertText(ENTERED_TEXT);
    const { nextOpen: open1 } = handleCmeGapEvent(null, entered1);
    const entered2 = parseCmeGapAlertText('CME GAP ENTERED — CME_DL:BTC1!\nPrice: 64200\nTime: 2026-11-17T17:00:00Z');
    const { nextOpen, closedRecords } = handleCmeGapEvent(open1, entered2);
    expect(closedRecords.length).toBe(1);
    expect(closedRecords[0].closeReason).toBe('superseded');
    expect(nextOpen.enterPrice).toBe(64200);
  });
  it('null събитие -> no-op, връща предходното състояние непроменено', () => {
    const prevOpen = { ticker: 'x', symbol: 'BTC', enteredAt: 1, enterPrice: 1 };
    const result = handleCmeGapEvent(prevOpen, null);
    expect(result.nextOpen).toBe(prevOpen);
    expect(result.closedRecords).toEqual([]);
  });
});

describe('buildCmeGapAlertMessage', () => {
  it('форматира ENTERED съобщение', () => {
    const event = parseCmeGapAlertText(ENTERED_TEXT);
    const msg = buildCmeGapAlertMessage(event);
    expect(msg).toContain('CME GAP ENTERED');
    expect(msg).toContain('BTC');
    expect(msg).toContain('64083.1');
  });
  it('форматира FILLED съобщение различно от ENTERED', () => {
    const event = parseCmeGapAlertText(FILLED_TEXT);
    const msg = buildCmeGapAlertMessage(event);
    expect(msg).toContain('CME GAP FILLED');
    expect(msg).not.toContain('ENTERED');
  });
});

describe('processCmeGapWebhook (Stage 2 - KV wiring)', () => {
  it('невалиден текст -> {ok:false}, без KV докосване', async () => {
    const kv = makeKv();
    const result = await processCmeGapWebhook({ ALERT_STATE: kv }, 'random garbage');
    expect(result.ok).toBe(false);
    expect(kv.m.size).toBe(0);
  });

  it('ENTERED пише cmegap:<symbol>', async () => {
    const kv = makeKv();
    const result = await processCmeGapWebhook({ ALERT_STATE: kv }, ENTERED_TEXT);
    expect(result.ok).toBe(true);
    expect(kv.m.has(cmeGapOpenKey('BTC'))).toBe(true);
    expect(JSON.parse(kv.m.get(cmeGapOpenKey('BTC')))).toMatchObject({ symbol: 'BTC', enterPrice: 64083.1 });
  });

  it('FILLED след ENTERED трие cmegap:<symbol> и пише cmegapevent:', async () => {
    const kv = makeKv();
    await processCmeGapWebhook({ ALERT_STATE: kv }, ENTERED_TEXT);
    await processCmeGapWebhook({ ALERT_STATE: kv }, FILLED_TEXT);
    expect(kv.m.has(cmeGapOpenKey('BTC'))).toBe(false);
    const eventKeys = [...kv.m.keys()].filter(k => k.startsWith(CME_GAP_EVENT_KV_PREFIX));
    expect(eventKeys.length).toBe(1);
    expect(JSON.parse(kv.m.get(eventKeys[0]))).toMatchObject({ closeReason: 'filled', durationMin: 120 });
  });

  it('пише САМО в cmegap:/cmegapevent: ключове - нищо друго', async () => {
    const kv = makeKv();
    await processCmeGapWebhook({ ALERT_STATE: kv }, ENTERED_TEXT);
    await processCmeGapWebhook({ ALERT_STATE: kv }, FILLED_TEXT);
    for (const key of kv.m.keys()) {
      expect(key.startsWith(CME_GAP_KV_PREFIX) || key.startsWith(CME_GAP_EVENT_KV_PREFIX)).toBe(true);
    }
  });

  it('KV грешка не пречи на опита за WhatsApp известие (известието е критичният път)', async () => {
    const badKv = { get: async () => { throw new Error('kv down'); }, put: async () => {}, delete: async () => {} };
    const result = await processCmeGapWebhook({ ALERT_STATE: badKv }, ENTERED_TEXT);
    expect(result.ok).toBe(true);
    expect(result.event.symbol).toBe('BTC');
  });

  it('без env.ALERT_STATE -> no-op за KV, пак връща {ok:true}', async () => {
    const result = await processCmeGapWebhook({}, ENTERED_TEXT);
    expect(result.ok).toBe(true);
  });

  it('реално праща WhatsApp известие, щом secrets са налични (mock fetch)', async () => {
    let sentText = null;
    globalThis.fetch = async (url) => { sentText = decodeURIComponent(String(url).match(/text=([^&]*)/)[1]); return new Response('{"success":true}'); };
    const kv = makeKv();
    const result = await processCmeGapWebhook({ ALERT_STATE: kv, CALLMEBOT_PHONE: '+1', TEXTMEBOT_APIKEY: 'k' }, ENTERED_TEXT);
    expect(result.ok).toBe(true);
    expect(sentText).toContain('CME GAP ENTERED');
    expect(sentText).toContain('BTC');
  });
});

describe('/tv-cme-gap endpoint', () => {
  const call = (env, { method = 'POST', qs = '', body } = {}) =>
    worker.fetch(new Request(`https://w.mock/tv-cme-gap${qs}`, { method, body }), env, { waitUntil() {} });

  it('без/грешен token -> 401', async () => {
    const res = await call({ ALERT_STATE: makeKv(), TV_ALERT_TOKEN: 'secret' }, { qs: '?token=wrong', body: ENTERED_TEXT });
    expect(res.status).toBe(401);
  });

  it('валиден token + валиден POST текст -> 200, пише в KV', async () => {
    const kv = makeKv();
    const res = await call({ ALERT_STATE: kv, TV_ALERT_TOKEN: 'secret' }, { qs: '?token=secret', body: ENTERED_TEXT });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(kv.m.has(cmeGapOpenKey('BTC'))).toBe(true);
  });

  it('валиден token + невалиден текст -> 400', async () => {
    const res = await call({ ALERT_STATE: makeKv(), TV_ALERT_TOKEN: 'secret' }, { qs: '?token=secret', body: 'garbage' });
    expect(res.status).toBe(400);
  });

  it('GET с ?text= работи за ръчно тестване', async () => {
    const kv = makeKv();
    const qs = `?token=secret&text=${encodeURIComponent(ENTERED_TEXT)}`;
    const res = await call({ ALERT_STATE: kv, TV_ALERT_TOKEN: 'secret' }, { method: 'GET', qs });
    expect(res.status).toBe(200);
    expect(kv.m.has(cmeGapOpenKey('BTC'))).toBe(true);
  });

  it('липсващ TV_ALERT_TOKEN secret -> fail-closed 401', async () => {
    const res = await call({ ALERT_STATE: makeKv() }, { qs: '?token=anything', body: ENTERED_TEXT });
    expect(res.status).toBe(401);
  });

  // TV_ALERT_TOKEN coordinated rotation (2026-11-26, одобрено от потребителя) -
  // TV_ALERT_TOKEN_PREV позволява безпрекъсваема ротация: виж isValidTvAlertToken в worker.js.
  it('TV_ALERT_TOKEN_PREV приема СТАРИЯ token по време на ротационен прозорец', async () => {
    const kv = makeKv();
    const res = await call(
      { ALERT_STATE: kv, TV_ALERT_TOKEN: 'new-secret', TV_ALERT_TOKEN_PREV: 'old-secret' },
      { qs: '?token=old-secret', body: ENTERED_TEXT },
    );
    expect(res.status).toBe(200);
  });
  it('TV_ALERT_TOKEN_PREV не отваря достъп за произволен token - само точно старата стойност', async () => {
    const res = await call(
      { ALERT_STATE: makeKv(), TV_ALERT_TOKEN: 'new-secret', TV_ALERT_TOKEN_PREV: 'old-secret' },
      { qs: '?token=something-else', body: ENTERED_TEXT },
    );
    expect(res.status).toBe(401);
  });
  it('без TV_ALERT_TOKEN_PREV зададен - старият token вече НЕ работи (ротацията приключила)', async () => {
    const res = await call(
      { ALERT_STATE: makeKv(), TV_ALERT_TOKEN: 'new-secret' },
      { qs: '?token=old-secret', body: ENTERED_TEXT },
    );
    expect(res.status).toBe(401);
  });
});

describe('/cme-gap-diagnostics endpoint', () => {
  const call = (env, qs = '') => worker.fetch(new Request(`https://w.mock/cme-gap-diagnostics${qs}`), env, { waitUntil() {} });

  it('без/грешен token -> 401', async () => {
    const res = await call({ ALERT_STATE: makeKv(), TELEMETRY_TOKEN: 'secret' });
    expect(res.status).toBe(401);
  });

  it('с валиден token връща отворените гапове и затворените записи', async () => {
    const openRecord = { ticker: 'CME_DL:BTC1!', symbol: 'BTC', enteredAt: 1000, enterPrice: 64000 };
    const closedRecord = { ticker: 'CME_DL:ETH1!', symbol: 'ETH', enteredAt: 500, enterPrice: 1800, filledAt: 2000, fillPrice: 1820, durationMin: 25, closeReason: 'filled', originKnown: true };
    const kv = makeKv({
      [cmeGapOpenKey('BTC')]: JSON.stringify(openRecord),
      [cmeGapEventKey(closedRecord)]: JSON.stringify(closedRecord),
    });
    const res = await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.open.BTC).toMatchObject({ symbol: 'BTC' });
    expect(body.open.ETH).toBeNull();
    expect(body.closedCount).toBe(1);
    expect(body.closed[0].symbol).toBe('ETH');
  });

  it('read-only - не пише в KV', async () => {
    const kv = makeKv({ [cmeGapOpenKey('BTC')]: JSON.stringify({ symbol: 'BTC' }) });
    let wrote = false;
    const originalPut = kv.put;
    kv.put = async (...args) => { wrote = true; return originalPut(...args); };
    await call({ ALERT_STATE: kv, TELEMETRY_TOKEN: 'secret' }, '?token=secret');
    expect(wrote).toBe(false);
  });
});
