// TV_ALERT_TOKEN - coordinated rotation support (2026-11-26, одобрено от
// потребителя) - огледално на RELAY_TOKEN_PREV в relay/server.js. Споделен
// между /tv-alert (ALT CYCLE RADAR) и /tv-cme-gap (виж worker-cme-gap-tracker.test.js
// за /tv-cme-gap-специфичните тестове) - тук само isValidTvAlertToken
// (чистата проверка) + /tv-alert endpoint-ния rotation path.
import { describe, it, expect, vi } from 'vitest';
import { isValidTvAlertToken } from './worker/worker.js';
import worker from './worker/worker.js';

describe('isValidTvAlertToken', () => {
  it('fail-closed: без конфигуриран expected token -> винаги false, дори supplied е празно', () => {
    expect(isValidTvAlertToken('anything', '', '')).toBe(false);
    expect(isValidTvAlertToken('', '', '')).toBe(false);
  });
  it('точно съвпадение с expected -> true', () => {
    expect(isValidTvAlertToken('secret', 'secret', '')).toBe(true);
  });
  it('грешен token, без expectedPrev -> false', () => {
    expect(isValidTvAlertToken('wrong', 'secret', '')).toBe(false);
  });
  it('съвпада с expectedPrev (ротационен прозорец) -> true', () => {
    expect(isValidTvAlertToken('old-secret', 'new-secret', 'old-secret')).toBe(true);
  });
  it('празен expectedPrev не отваря "приема всичко"', () => {
    expect(isValidTvAlertToken('', 'new-secret', '')).toBe(false);
  });
});

describe('/tv-alert endpoint - TV_ALERT_TOKEN_PREV rotation window', () => {
  const call = (env, qs) => worker.fetch(new Request(`https://w.mock/tv-alert${qs}`, { method: 'GET' }), env, { waitUntil() {} });

  it('TV_ALERT_TOKEN_PREV приема стария token по време на ротация', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":true}')));
    const res = await call({ TV_ALERT_TOKEN: 'new-secret', TV_ALERT_TOKEN_PREV: 'old-secret' }, '?token=old-secret');
    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
  });
  it('без TV_ALERT_TOKEN_PREV - стар token вече не работи', async () => {
    const res = await call({ TV_ALERT_TOKEN: 'new-secret' }, '?token=old-secret');
    expect(res.status).toBe(401);
  });
  it('нов token винаги работи, независимо дали PREV е зададен', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":true}')));
    const res = await call({ TV_ALERT_TOKEN: 'new-secret', TV_ALERT_TOKEN_PREV: 'old-secret' }, '?token=new-secret');
    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
  });
});
