// CME GAP TRACKER - TradingView webhook (CME_DL:BTC1!/ETH1!, 4h), два
// plain-text алерта: "CME GAP ENTERED"/"CME GAP FILLED". Stage 1 - чиста
// логика само, виж бележката преди parseCmeGapAlertText в worker.js.
import { describe, it, expect } from 'vitest';
import {
  parseCmeGapAlertText, normalizeCmeGapSymbol, openCmeGapRecord, finalizeCmeGapRecord,
  handleCmeGapEvent, buildCmeGapAlertMessage,
} from './worker/worker.js';

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
