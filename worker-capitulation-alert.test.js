// CAPITULATION ALERT (FLUSH/BASE) - проверка, поискана от потребителя преди
// merge/deploy (виж discussion-а "CAPITULATION-а за 35-те монети"):
// (A) 30-минутният hysteresis гарантира ново WhatsApp съобщение само при
//     ДЕЙСТВИТЕЛНО ново събитие (edge-detection), не просто защото е
//     изминало времето - и не блокира ПЕРМАНЕНТНО след първото известие.
// (B) Претоварна защита - максимален брой пълни известия на тик
//     (CAPITULATION_ALERT_MAX_PER_TICK), с остатъка обобщен вместо залял
//     WhatsApp опашката при едновременно активиране на много символи.
import { describe, it, expect, afterEach } from 'vitest';
import {
  flushCanFire, markFlushFired, baseCanFire, markBaseFired,
  CAPITULATION_ALERT_MAX_PER_TICK, admitCapitulationAlert,
} from './worker/worker.js';

const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

describe('(A) flushCanFire/baseCanFire - edge-detection + истински time cooldown', () => {
  it('първо активиране -> гърми; REAL FIX за стария bug: продължаващо (state.flushActive оставащ true) НЕ прегърми отново', () => {
    const state = {};
    expect(flushCanFire(state)).toBe(true);
    markFlushFired(state);
    state.flushActive = true; // call site-ът го прави безусловно всеки тик докато flush е true

    // същото продължаващо събитие, 5 минути по-късно - все още активно
    Date.now = () => realNow() + 5 * 60000;
    expect(flushCanFire(state)).toBe(false);

    // дори 2 часа по-късно, ако условието НИКОГА не е паднало (active си остава true)
    Date.now = () => realNow() + 120 * 60000;
    expect(flushCanFire(state)).toBe(false);
  });

  it('не е "стария bug" - НЕ блокира перманентно след първото събитие веднъж приключило', () => {
    const state = {};
    expect(flushCanFire(state)).toBe(true);
    markFlushFired(state);
    state.flushActive = true;
    // събитието приключва (условието пада под прага) - call site-ът пише undefined
    state.flushActive = undefined;

    // веднага след прекъсване, преди cooldown-а да изтече - ПРЕЖЕЛЕНО потиснато
    // (пази от бърз flap на границата на прага), не заради "продължаващо", а
    // заради реалния 30-мин cooldown
    expect(flushCanFire(state)).toBe(false);

    // 25 минути по-късно - все още под 30-мин cooldown
    Date.now = () => realNow() + 25 * 60000;
    expect(flushCanFire(state)).toBe(false);

    // 31 минути по-късно, ДЕЙСТВИТЕЛНО ново събитие (не просто време минало,
    // а условието реално пада и после пак гърми) -> разрешено
    Date.now = () => realNow() + 31 * 60000;
    expect(flushCanFire(state)).toBe(true);
  });

  it('пълен реалистичен timeline - гърми веднъж, потиска продължаването, потиска твърде ранен flap, после разрешава ДЕЙСТВИТЕЛНО нов епизод', () => {
    const state = {};
    const t0 = realNow();

    // T+0: ново събитие
    Date.now = () => t0;
    expect(flushCanFire(state)).toBe(true);
    markFlushFired(state);
    state.flushActive = true;

    // T+10m: същото продължаващо събитие, няколко тика все още active=true
    Date.now = () => t0 + 10 * 60000;
    expect(flushCanFire(state)).toBe(false);
    state.flushActive = true;

    // T+20m: условието за момент пада (active=false оставен от call site-а),
    // после веднага пак active - flap близо до прага
    Date.now = () => t0 + 20 * 60000;
    state.flushActive = undefined;
    Date.now = () => t0 + 25 * 60000; // T+25m, твърде рано (под 30 мин cooldown)
    expect(flushCanFire(state)).toBe(false);
    state.flushActive = true;

    // T+40m: събитието реално приключва и ДЕЙСТВИТЕЛНО нов епизод започва
    Date.now = () => t0 + 35 * 60000;
    state.flushActive = undefined;
    Date.now = () => t0 + 40 * 60000;
    expect(flushCanFire(state)).toBe(true); // > 30 мин от T+0 fire, И не е "продължаващо"
  });

  it('baseCanFire/markBaseFired - симетрично на flush, независим state key', () => {
    const state = {};
    expect(baseCanFire(state)).toBe(true);
    markBaseFired(state);
    state.baseActive = true;
    expect(baseCanFire(state)).toBe(false);
    // flush и base не си пречат - различни state ключове
    expect(flushCanFire(state)).toBe(true);
  });
});

describe('(B) admitCapitulationAlert - претоварна защита при едновременно активиране', () => {
  it(`първите ${CAPITULATION_ALERT_MAX_PER_TICK} заявки на тик се допускат, остатъкът отива в overflow`, () => {
    const budget = { count: 0, overflow: [] };
    const admitted = [];
    // симулираме 70 банера (35 символа x FLUSH+BASE) в един tick, както при
    // едновременна активация на цялата watchlist
    for (let i = 0; i < 70; i++) {
      const label = `SYM${i} FLUSH`;
      if (admitCapitulationAlert(budget, label)) admitted.push(label);
    }
    expect(admitted).toHaveLength(CAPITULATION_ALERT_MAX_PER_TICK);
    expect(budget.count).toBe(CAPITULATION_ALERT_MAX_PER_TICK);
    expect(budget.overflow).toHaveLength(70 - CAPITULATION_ALERT_MAX_PER_TICK);
    expect(budget.overflow[0]).toBe(`SYM${CAPITULATION_ALERT_MAX_PER_TICK} FLUSH`);
  });

  it('под лимита -> всички се допускат, overflow празен', () => {
    const budget = { count: 0, overflow: [] };
    for (let i = 0; i < CAPITULATION_ALERT_MAX_PER_TICK - 1; i++) {
      expect(admitCapitulationAlert(budget, `SYM${i}`)).toBe(true);
    }
    expect(budget.overflow).toHaveLength(0);
  });

  it('бюджетът е локален за tick-а - нов budget обект на следващия tick започва на 0', () => {
    const budgetTick1 = { count: 0, overflow: [] };
    for (let i = 0; i < CAPITULATION_ALERT_MAX_PER_TICK + 3; i++) admitCapitulationAlert(budgetTick1, `A${i}`);
    expect(budgetTick1.overflow.length).toBeGreaterThan(0);

    const budgetTick2 = { count: 0, overflow: [] };
    expect(admitCapitulationAlert(budgetTick2, 'B0')).toBe(true);
    expect(budgetTick2.overflow).toHaveLength(0);
  });
});
