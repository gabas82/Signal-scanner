# CoinGlass `/futures/liquidation/order` — технически диагностичен доклад

Branch: `claude/coinglass-liquidation-heatmap-telemetry` (от `main` @ `4ed29e9`)
Дата: 2026-11-15 · Статус: **само диагностика и подготовка — без merge, без deploy**

---

## 1. Резюме

LIQUIDATION CASCADE (9-ият фактор на PHASE CYCLE) и LIQUIDATION GRAVITY почти сигурно никога не са получавали данни. Worker-ът подава двойка (`BTCUSDT`) там, където CoinGlass очаква монета (`BTC`). Според документацията двойка връща празен масив. KV наблюдението `sigstate:BTCUSDT → liqGravity: {buckets:{}, lastSeenTime:0}` съвпада точно с това поведение.

SETUP / ARMED / ENTRY **не са засегнати**: не четат нищо ликвидационно.

Подготвен е shadow диагностичен модул. Той е изключен по подразбиране, пише само в нов KV prefix `liqdiag:`, не влияе на сигналите (доказано с end-to-end тест) и дава read-only endpoint и ръчна проба, които дават окончателното доказателство с реален API отговор.

---

## 2. Доказани проблеми (от кода и документацията, потвърдени с тестове)

| # | Проблем | Доказателство |
|---|---|---|
| P1 | `symbol` е двойка (`BTCUSDT`), а не монета (`BTC`) | `worker.js` legacy fetch; тест (A)1 улавя реалния URL. CoinGlass docs: „symbol is a coin, e.g. BTC; passing BTCUSDT returns an empty array“ |
| P2 | `json.code` не се проверява. CoinGlass връща HTTP 200 и при грешки (401/403 са в body) | Тестове (A)4–5: `{code:"401"}` дава `null`; `{code:"403", data:[]}` дава `[]` |
| P3 | Празен отговор, API грешка, HTTP грешка, timeout и реална нула са **неразличими** и нищо не се логва | Тест (A)7: `[]`, `null` и стари поръчки дават идентичен CASCADE резултат |
| P4 | При `[]` или `null` GRAVITY остава `{buckets:{}, lastSeenTime:0}` завинаги и никога не стреля | Тест (A)8; съвпада 1:1 с KV наблюдението за BTCUSDT |
| P5 | Няма `start_time`. При правилен символ и `min=1` всяка заявка би теглила **7 дни** ликвидации (35 монети на тик), а лимитът на записи под 100000 USD е недокументиран | CoinGlass docs (default = последните 7 дни; 200-record таван само при min ≥ 100000) |
| P6 | Скалата на PHASE CYCLE реално е 0–8, не 0–9 | 9-ият фактор (`liquidationCascadeBullish/Bearish`) винаги е `false` при P1 |
| P7 | Тестово покритие за този път липсваше | Няма liquidation тестове преди този branch |

## 3. Вероятни проблеми (изискват реален API отговор)

| # | Хипотеза | Как ще се потвърди |
|---|---|---|
| V1 | P1 е **единствената** причина (а не план или права) | `/liq-diagnostics/probe?symbol=BTCUSDT` дава verdict `symbol_format_bug_confirmed` |
| V2 | Същото важи за всички 35 монети | KV `sigstate:<SYM>` (ETH/SOL/1000PEPE) и `liqdiag:` статистиката след shadow период |
| V3 | `1000PEPEUSDT` → `PEPE` | probe с `coin=PEPE` и `coin=1000PEPE`; поле `baseAssets` в диагностиката |
| V4 | Покритие за редки монети (RIVER, UB, KAS, HYPE…) | `neverOk` списъкът в `/liq-diagnostics` |
| V5 | **Посоката на `side`.** Кодът приема 1 = Buy = ликвидирани SHORT позиции (бичи сигнал). Документацията казва само „1 is buy, 2 is sell“ и изрично предупреждава да не се превръща директно в long/short | Shadow събитията пазят `price`; сравнение с последващото движение на цената |
| V6 | При `symbol=BTC` и `exchange=Binance` отговорът може да включва и BTCUSDC / COIN-M двойки | `pairCounts` в диагностиката |
| V7 | Отрязване на отговора при min=1 | `truncatedSuspectCount`, `maxCount` |
| V8 | Планът е Standard (`/liquidation/order` изисква Standard или по-висок) | probe връща `ok` (или `api_error` + code/msg) |

## 4. Път на данните (одит)

```
fetchLiquidationOrdersWorker(env, 'BTCUSDT')     ← P1, P2, P5
  └─ liquidationOrders ([] / null)
       ├─ calcLiquidationCascade → bullish/bearish (праг 500k USD / 15 мин)
       │     └─ calcCycleLongScore / calcCycleShortScore (9-и фактор)
       │           └─ computeCyclePhase → известие „🔮 ЦИКЪЛ“ (само при смяна на фазата)
       └─ accumulateLiquidationGravity(state) → state.liqGravity (KV sigstate:)
             └─ findNearestLiquidationCluster (≥ 2M USD) → calcLiquidationGravityScore
                   └─ getLiquidationGravityTier → известие „🧲 LIQUIDATION GRAVITY“
calcSetupState / ARMED / ENTRY ← НЕ ползват нищо от горното (source guard тест)
```

Единственото място, което вика endpoint-а, е `fetchLiquidationOrdersWorker`. Той се вика от `scanSymbolSignals` за всички 35 монети от WATCHLIST. Scanner UI-то (`signal-scanner.html`) не вика CoinGlass, а CoinGlass прокси whitelist-ът е празен.

## 5. Прагове и последствия при активиране (тестове от група B)

- **CASCADE 500k USD / 15 мин, само за Binance.** За BTC/ETH се достига при умерени движения, за малки монети почти никога. Прагът е некалибриран. Shadow хистограмата (`cascadeHist`, кошчета 0/10k/50k/100k/250k/500k/1M/2.5M/5M) дава реалното разпределение по монета.
- **GRAVITY: незабавен backfill.** При `lastSeenTime=0` първата успешна заявка поглъща целия върнат прозорец. Тест (B)2 показва CONFIRMED още на **първия тик** след поправката.
- **GRAVITY: няма decay.** Кошчетата растат вечно. След седмици с реални данни около BTC почти винаги ще има „силен“ клъстер в рамките на 2%, а hard factor е само OI > 0 или taker > 0. Очакване: честите известия са гейтнати само от хистерезиса. Освен това `sigstate:` расте неограничено.
- **GRAVITY: клъстер в кошчето на текущата цена.** Посоката зависи от знака на минимално разстояние (тест B5), което я прави случайна.
- **GRAVITY: строго `>` по `lastSeenTime`.** Поръчки със същата милисекунда, дошли в следваща заявка, се губят (тест B4). Ефектът е малък.
- **PHASE CYCLE.** Добавянето на реален 9-и фактор вдига scores, така че се очакват повече преходи към LONG_WATCH / LONG_SETUP / STRONG_LONG и SHORT_* фазите.

**Извод:** поправка само на P1 без калибриране би включила два некалибрирани модула едновременно.

## 6. Подготвени промени (само в този branch)

`worker/worker.js`: **+304 реда, 0 изтрити или променени.** Legacy пътят е byte-identical.

- **Shadow модул** `COINGLASS LIQUIDATION DIAGNOSTICS`:
  - `isLiqDiagEnabled(env)`: активно **само** при `LIQ_DIAG_ENABLED === '1'`. Deploy без този var означава нулева промяна.
  - `toCoinGlassCoin(symbol)`: двойка → монета. `1000PEPEUSDT → PEPE` е маркиран `verified:false`.
  - `classifyCoinGlassLiqResponse`: `ok / empty / api_error / bad_shape / http_error / parse_error / timeout / network / no_key`.
  - `fetchLiquidationOrdersDiag`: правилен coin, `start_time = now − 20 мин`. Ключът е само в header-а и никога в резултата.
  - `applyLiqShadowStep` (чиста функция): реизползва **същите** production функции и прагове, за да покаже какво *би* направил production. Записва:
    - броячи по статус и последен `code/msg`;
    - `pairCounts / baseAssets` (V3, V6);
    - хистограма на 15-мин сумите (калибриране);
    - отделен shadow gravity профил;
    - „would-fire“ събития (rising edge, с `price`);
    - 24-часов таймлайн с shadow и legacy стойности, за join по време с `/telemetry`.
  - `runLiqShadowDiagnostics`: никога не хвърля и пише само в `liqdiag:<SYMBOL>`.
- **Wiring в `scanSymbolSignals`:** един ред стартира shadow заявката паралелно (само при включен флаг) и един блок я записва след legacy GRAVITY. Не чете и не пише `state`.
- **Endpoint `GET /liq-diagnostics?token=…`** (защитата е `TELEMETRY_TOKEN`): read-only обобщение за 35-те монети (`totals`, `neverOk`, `unverifiedCoins`, `withEvents`, `bySymbol`; `&full=1` връща и суровите данни).
- **Endpoint `GET /liq-diagnostics/probe?token=…&symbol=BTCUSDT[&coin=PEPE]`:** две леки заявки (pair срещу coin, 60-мин прозорец, coin пробата с min=100000) и verdict. Работи и без включен флаг.
- **Тестове** `worker-liquidation-diagnostics.test.js` (36 теста).

## 7. Извършени тестове и резултати

| Набор | Резултат |
|---|---|
| `worker-liquidation-diagnostics.test.js` (нов) | **36/36 PASS** |
| `signal-logic.test.js` | 178/178 PASS (идентично с main) |
| `worker-entry-telemetry-integrity.test.js` | 46/47 (идентично с main*) |
| `worker-apisports-liveall.test.js` | 11/12 (идентично с main*) |
| `football-worker.test.js` | 31/31 PASS |

\* Двата отказа са ограничения на локалния vitest shim (`rejects.toThrow`, fake timers). Npm registry е недостъпен в средата и тестовете са пуснати през `node:test` с малък shim, който не е commit-нат. Резултатите са същите на `main` без промените. В CI (истински vitest) се очаква пълен PASS.

**Ключови доказателства:**
- **End-to-end тест:** `scanSymbolSignals('BTCUSDT')` с флаг изключен и включен (симулирани Binance свещи + CoinGlass по документацията) дава **идентичен return обект и идентичен `sigstate:`**. Единствената разлика е новият ключ `liqdiag:BTCUSDT`. Legacy профилът остава празен, а shadow вижда 750k USD ликвидация и отбелязва would-fire CASCADE.
- **Мутационна проверка:** нарочно изтичане на shadow данни в `state` → end-to-end тестът **пада**. Тестът наистина пази изолацията.

## 8. Неизвършени проверки (ограничения на достъпа)

- Реални заявки към `open-api-v4.coinglass.com`: shell-ът е блокиран от proxy allowlist, а `CG_API_KEY` е Cloudflare secret и нарочно не е в тази среда.
- Четене на KV за останалите 34 монети: няма Cloudflare достъп от тук.
- Пълно vitest изпълнение: npm е недостъпен.

## 9. Мерене на качеството на сигналите (задача 7)

Shadow данните са проектирани така, че да мерят, без да генерират:
- `events[]` (would-fire CASCADE/GRAVITY с `price` и `at`) се оценяват офлайн срещу последващите Binance свещи (forward return / MFE / MAE). Това дава и емпирична проверка на V5 (посоката на `side`).
- `timeline[]` (24 часа) позволява join по `symbol + at` с ENTRY записите от `/telemetry`, например „имаше ли ликвидационен натиск в момента на ENTRY?“, **без промяна** в ENTRY телеметрията.
- `cascadeHist` / `cascadeMax` дават данни за калибриране на 500k прага по монета.

## 10. Цена при включване

- CoinGlass: +35 заявки на cron тик. При 5-мин cron това е около 7/мин срещу лимит 300/мин за Standard. Плановете са абонамент без такса на заявка.
- Cloudflare KV: +1 read и +1 write на монета на тик, около 10k writes/ден (~300k/месец). Преди включване проверете KV лимитите на текущия Cloudflare план. Безплатният KV лимит за writes е значително по-нисък и вероятно не би стигнал.

## 11. Препоръчителен ред за безопасно внедряване

1. **Ревю на този branch** (PR без merge, или директно преглед).
2. **Проба без постоянно включване:** deploy на branch кода **без** `LIQ_DIAG_ENABLED`. Поведението остава идентично, нужни са само 3 probe заявки (`BTCUSDT`, `1000PEPEUSDT` с `coin=PEPE` и `coin=1000PEPE`). Това потвърждава V1, V3 и V8. *(Изисква изрично одобрение, защото е deploy.)*
3. **Shadow период 1–2 седмици:** `LIQ_DIAG_ENABLED=1`. Събират се `neverOk`, хистограми, `pairCounts` и would-fire събития. Нула влияние върху сигналите.
4. **Анализ:** калибриране на CASCADE прага (по монета или по процентил), решение за GRAVITY (decay или прозорец, backfill политика, ограничение на размера), проверка на `side` (V5).
5. **Отделен PR за поправката:** coin символ + `start_time` + проверка на `json.code` + статус в логовете. CASCADE и GRAVITY остават зад собствени флагове, **изключени**.
6. **Поетапно активиране:** първо CASCADE (по-прост, без състояние), наблюдение, после GRAVITY с нов празен профил и калибрирани прагове.
7. ЕТАП 2 от основния план не е започнат и чака отделно одобрение.
