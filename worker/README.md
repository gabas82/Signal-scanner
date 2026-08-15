# Cloudflare Worker (orange-grass-d809) — setup

Този Worker прави две неща: (1) прокси за Yahoo/football-data.org/api-sports.io/CoinGlass заявките на приложенията, и (2) на cron разписание следи личен watchlist за DCA нива И/ИЛИ пазарни сигнали (WARMING/HOT/SUPER, MM LONG/SHORT/x25, FLUSH/BASE/SQUEEZE/SHIFT/IMPULSE) и праща WhatsApp известие през TextMeBot.

`worker.js` **не съдържа никакви ключове в кода** — всички се четат от Worker Secrets, за да могат безопасно да стоят в публичния Signal-scanner repo.

## 0. Workers Paid план ($5/месец) — нужен при watchlist с много монети

Всяка монета в пазарното сканиране прави 5 заявки (15м/5м/1ч/4ч/1д свещи) на едно cron изпълнение. Безплатният Cloudflare план има таван от **50 външни заявки на изпълнение** — при ~10+ монети (текущият watchlist е 15) това го надвишава и по-късните монети в списъка биха останали несканирани. Workers Paid ($5/мес) вдига тавана до 10 000 заявки. Dashboard → **Account Home → Plans** (или директно при опит да добавиш Cron Trigger, Cloudflare обикновено предлага upgrade там).

## 1. Качи кода в Cloudflare

Dashboard → Workers & Pages → **orange-grass-d809** → **Edit code** → замени съдържанието на `worker.js` с това от този файл → **Deploy**.

## 2. Добави Secrets

Dashboard → orange-grass-d809 → **Settings → Variables and Secrets** → Add → тип **Secret** (криптирано, не Plaintext) за всяко от:

| Име | Стойност |
|---|---|
| `CG_API_KEY` | твоят съществуващ CoinGlass ключ |
| `FOOTBALL_DATA_TOKEN` | твоят съществуващ football-data.org token |
| `APISPORTS_KEY` | твоят съществуващ api-sports.io ключ |
| `CALLMEBOT_PHONE` | твоят WhatsApp номер с код на държавата, напр. `+359...` (името е историческо, вижда се и за TextMeBot - същият номер, за да не се дублира secret) |
| `TEXTMEBOT_APIKEY` | apikey от TextMeBot (стъпка 4) |
| `RELAY_URL` | адресът на DigitalOcean relay-я, напр. `https://signal-scanner-relay-l7rin.ondigitalocean.app` (виж `relay/README.md`) |
| `RELAY_TOKEN` | същият таен код, зададен като `RELAY_TOKEN` в DigitalOcean |
| `TV_ALERT_TOKEN` | произволен таен код по твой избор (виж "ALT CYCLE RADAR webhook" по-долу) |

### Защо има relay

Binance блокира заявки от Cloudflare Workers-ите на ниво WAF (HTTP 403) — заради това `worker.js` вече не вика `fapi.binance.com` директно, а през малкия relay сървър на DigitalOcean (`relay/` в този repo). Виж `relay/README.md` за deploy инструкции.

## 3. Добави KV namespace (за cooldown паметта на известията)

Dashboard → **Storage & Databases → KV** → Create namespace, име напр. `signal-alert-state` → после в orange-grass-d809 → **Settings → Bindings → Add → KV Namespace** → Variable name **точно** `ALERT_STATE`, избери новия namespace.

Без това известията пак ще работят, но при всяко cron изпълнение ще спамят едно и също ниво (няма памет между извикванията).

## 4. Активирай TextMeBot

1. На `https://textmebot.com/` вземи API ключ (безплатен 3-дневен demo, или директно $1/месец план "1 recipient" - достатъчен е, защото пращаме само на себе си).
2. Ще получиш имейл с ключа и линк `https://api.textmebot.com/addphone.php?apikey=...` за свързване на WhatsApp номера.
3. На тази страница ще се появи QR код — трябва да го сканираш **от WhatsApp на телефона** (Settings → Linked Devices → Link a Device), докато страницата е отворена на **друг** екран (компютър), не на самия телефон — камерата не може да сканира собствения си екран.
4. След успешно свързване страницата показва "DB Status: Connected" и зелена отметка.

Endpoint-ът, който Worker-ът ползва зад кулисите: `https://api.textmebot.com/send.php?recipient=...&apikey=...&text=...`

(Заменихме CallMeBot, защото изчерпа безплатния си лимит съобщения и след това плащанията за абонамент бяха постоянно счупени от тяхна страна.)

## 5. Попълни watchlist-а

В `worker.js`, редактирай `WATCHLIST` в началото на файла:

```js
const WATCHLIST = [
  { symbol: 'BTCUSDT' },                                    // само пазарни сигнали
  { symbol: 'ETHUSDT', entryPrice: 3200, side: 'short' },    // пазарни сигнали + DCA известия
];
```

`symbol` е задължителен (Binance формат, с `USDT` накрая) — **всеки** запис автоматично се следи за пазарни сигнали (WARMING/HOT/SUPER, MM LONG/SHORT/x25, FLUSH/BASE/SQUEEZE/SHIFT/IMPULSE), независимо дали имаш позиция. `entryPrice`/`side` добавяш само ако искаш И DCA известия за конкретна твоя позиция в тази монета.

## 6. Добави Cron Trigger

Dashboard → orange-grass-d809 → **Settings → Triggers → Cron Triggers → Add Cron Trigger**, напр. `*/5 * * * *` (на всеки 5 минути).

## Как работи

На всяко cron изпълнение:

**DCA известия** (само за записи с `entryPrice`+`side`):
1. Взима текущата цена от Binance.
2. Изчислява DCA нивата (същата формула като DCA калкулатора в приложението — ВХОД / DCA1 (-24%) / DCA2 (-40%) / DCA3 (-35% от DCA2)).
3. Ако цената е пресякла ниво, което не е било известено през последните 24ч, праща WhatsApp съобщение и пази маркер в KV за да не спамва повторно.

**Пазарни сигнали** (за ВСЕКИ запис в watchlist-а, независимо от позиция):
1. Изтегля 15м/5м/1ч/4ч(210 свещи, за EMA200)/1д свещи от Binance за символа (същите timeframes като CAPITULATION таба в приложението).
2. Изчислява byte-identical логика с приложението:
   - **Capitulation Suite**: FLUSH/BASE/SQUEEZE/SHIFT/IMPULSE (дъно) + огледалните им връх версии BLOWOFF/DISTRIBUTION/DUMP SQUEEZE/SHIFT ▼ (следи и прегрят, и подценен пазар)
   - **WARMING Gate**: WARM/HOT/SUPER + 4Ч обем + Dump Cascade
   - **MM WARMING→IMPULSE**: MM LONG/SHORT + MM x25
   - **Build-Up Detector**: EARLY BUILD-UP → BUILD-UP CONFIRMED → PRE-IMPULSE (18ч прозорец между Early и Confirm)
   - **MM-OSC Entry Companion**: MM-OSC BEST LONG/SHORT + RE-LONG/RE-SHORT (90мин prozorec за "чист" ретест преди повторен вход в СЪЩАТА посока)
   - **IMPULSE+ATR + CONFIRMED**: пробив с ATR% "здравословен диапазон" филтър + 15м/1ч multi-timeframe потвърждение на продължение на тренда (CME Gap и BTC.D филтрите от оригинала не са пренесени - изискват данни, каквито Binance API не дава)

   **EARLY/LIVE срещу CONFIRMED свещи**: EARLY BUILD-UP, WARMING/HOT/SUPER (+SUPER DOWN), MM/MM x25 и MM-OSC са предупредителни по дизайн и гледат текущата, ОЩЕ НЕЗАТВОРЕНА свещ (бърза реакция е целта им). SHIFT, SHIFT ▼, IMPULSE, IMPULSE+ATR, CONFIRMED, BUILD-UP CONFIRMED и PRE-IMPULSE са структурни/потвърждаващи сигнали и гледат само последната ЗАТВОРЕНА свещ (`c15Closed`/`c1hClosed`/`c4hClosed`/`c5Closed` = `.slice(0, -1)` в `scanSymbolSignals`), за да не се появяват и изчезват насред все още отворена свещ.
3. Cooldown/ARM/прозорец състоянието (за да не спамва един и същ сигнал постоянно) се пази в KV между извикванията, по символ. LIVE детекторите (WARMING/HOT/SUPER/MM/MM x25/MM-OSC/FLUSH/BASE/DISTRIBUTION/SQUEEZE/DUMP SQUEEZE/EARLY BUILD-UP) имат общ филтър (`tagCanFire`/`SIGNAL_REPEAT_COOLDOWN_MIN` = 20 мин), който потиска повторение на СЪЩИЯ таг по-рано от 20 мин. CONFIRMED/структурните детектори (SHIFT/SHIFT▼/IMPULSE/IMPULSE+ATR/CONFIRMED/BUILD-UP CONFIRMED/PRE-IMPULSE) вместо това пазят "1 сигнал на затворена свещ" — веднъж пратен сигнал за конкретна затворена свещ (по `openTime`), не се повтаря, докато не се затвори нова свещ, дори ако това стане след по-малко от 20 мин; нова свещ веднага отключва нов сигнал, без изкуствено чакане. `longScore`/`shortScore` (виж по-долу) се смятат СЛЕД този филтър, само от сигналите, които реално влизат в текущото известие — стар сигнал, потиснат от cooldown, не влияе на %/посоката.
4. Ако нещо ново се е задействало (и не е било пратено за същата монета/свещ), праща едно консолидирано WhatsApp съобщение с едно от три ясни състояния:
   - **A) Ясна посока + достатъчно точки** (мнозинството точки ≥ `MIN_TP_SCORE` = 3.0): `📍 Посока`, `📊 Сигнали: LONG X% / SHORT Y%`, `✅ Точки: X.XX LONG / Y.YY SHORT`, после `🎯 TP1-5`.
   - **B) Ясна посока, но под прага**: същия хедър, но вместо TP — `⚠️ Само X.XX точки — TP не се показва`.
   - **C) Смесени сигнали** (мнозинството не покрива `DIRECTION_CONFIDENCE_RATIO` = 4:1 спрямо малцинството): `⚠️ СМЕСЕНИ СИГНАЛИ` + %-но разпределение + точки, без TP.

   Съобщението винаги включва и текуща цена (последно 5м затваряне), близка съпротива/подкрепа (най-висока/ниска от последните 20 1ч свещи) и лонг/шорт съотношение (Binance global account ratio, 1ч).

**TP нивата** (`TP_PCTS` в `worker.js`) са фиксирана %-стълба (+1.26% / +2.34% / +3.58% / +4.52% / +8.23% от текущата цена, обратно за SHORT), извлечена от target 1/3/4/5/7 на външен VIP сигнален канал (Cornix формат) — потвърдено с два реални техни сигнала на различни монети, че процентите са относителни, не абсолютни нива. Няма втори вход/stop loss в тази стълба — има собствена DCA стратегия за допълнителни входове (виж `checkDcaLevels`).

**Тегла и корелирани семейства** (`SIGNAL_WEIGHTS`/`SIGNAL_FAMILY_MAX`/`computeFamilyCappedScore` в `worker.js`): всеки сигнал носи собствена тежест вместо да брои за "1" — слаб/ранен сигнал (EARLY BUILD-UP/WARMING) тежи 0.50, структурно потвърждение (CONFIRMED/PRE-IMPULSE) тежи 2.00-2.50. Детектори от едно и също "семейство" (напр. WARMING/HOT/SUPER/SQUEEZE/DUMP SQUEEZE — Family "volumeMomentum") често реагират на едно и също реално движение (volume/ATR/EMA/candle body) — една силна свещ, която пали и трите едновременно, не е 3 независими доказателства. Затова сумата на всяко семейство се ограничава до негов таван, преди да се добави към общия резултат за посоката. Пет семейства: `volumeMomentum` (1.50), `mmEngine` (2.00), `impulseFamily` (2.00), `structure` (3.00), `extreme` (2.00). EARLY BUILD-UP е без семейство (единствен тригер на отделната Build-Up верига) — брои се изцяло, без таван.

**Посока и увереност** (`computeDirectionConfidence` в `worker.js`): всеки задействал се сигнал носи собствена посока и тегло (`fired.push({ label, direction, weight, family })` в `scanSymbolSignals` — не се извежда чрез парсене на текста на label-а). `longScore`/`shortScore` се смятат само от сигналите, които реално влизат в текущото известие (след cooldown филтъра), с прилагане на семейните тавани по-горе. Понеже детекторите са напълно независими (различни timeframes/логика), е възможно в една обиколка да се задействат и в двете посоки едновременно за една и съща монета.

Две отделни условия решават какво се показва:
- **Посока се показва** при мнозинство точки поне 4:1 (`ratioOK` — напр. 4.0 срещу 1.0, или каквото и да е срещу 0). При по-слабо мнозинство известието показва `⚠️ СМЕСЕНИ СИГНАЛИ` вместо подвеждащо уверена посока.
- **TP1-5 се показва** само ако точковото мнозинство достига `MIN_TP_SCORE` = 3.0 (`enoughScore`). Целта е 1 слаб сигнал (0.5-1.25т) да не отключва TP сам, докато 1 наистина силно структурно потвърждение (CONFIRMED/PRE-IMPULSE, 2.0-2.5т) — може.

Процентите (`Сигнали: LONG X% / SHORT Y%`) винаги значат "дял от точковия резултат на новите активни сигнали в тази обиколка", никога вероятност за успех на сделката — никъде не пише "100% увереност".

**RSI/ATR изглаждане**: `calcRSI`/`calcATR` ползват Wilder RMA изглаждане (`alpha = 1/period`, носи цялата история напред), а не обикновена SMA на последния прозорец — за да съвпадат максимално с TradingView `ta.rsi()`/`ta.atr()`. Byte-identical промяна и в `signal-logic.js`, за да не се разминат Worker/dashboard сигналите.

**Сигурност**: `/tv-alert` е fail-closed — липсващ `TV_ALERT_TOKEN` secret отказва достъп, вместо тихо да пропуска auth проверката. CoinGlass прокси пътят изисква whitelist (в момента празен по подразбиране — добави конкретни пътища в `ALLOWED_COINGLASS_PATHS`, ако някога потрябва реален CoinGlass proxy caller).

**Защо `formatPrice` слага "USD" след числото, не "$" преди него**: реални тествани известия показаха, че WhatsApp/Android понякога разпознава `$` залепено директно за низ от цифри като телефонен/тракинг номер и чупи и визуализацията, и copy-paste (напр. `$65061.30` се показа като `5061.30`, `$0.3520` — като `.3520`, дори `/system/bin/sh.` префикс). `formatPrice` вече слага разделител по хиляди (`toLocaleString`) и `$` никъде не е директно залепен за цифра в известията.

## ALT CYCLE RADAR webhook (TradingView → WhatsApp)

`worker.js` приема `POST /tv-alert?token=TV_ALERT_TOKEN` — приема JSON тяло `{phase, score, btcD, altBtc, breadth30, breadth60, breadth90, time}` и праща WhatsApp известие през `sendWhatsApp` (същата функция/секрети като пазарните сигнали). Предназначен е за webhook alert на Pine Script индикатора "ALT CYCLE RADAR" (`worker/alt-cycle-radar.pine`).

Настройка:
1. Добави `TV_ALERT_TOKEN` secret (стъпка 2 по-горе) — произволен таен низ по твой избор.
2. В TradingView, на индикатора "ALT CYCLE RADAR" → **Create Alert** → Condition: **"Any alert() function call"** → Webhook URL:
   ```
   https://orange-grass-d809.gabas82.workers.dev/tv-alert?token=ТВОЯТ_TV_ALERT_TOKEN
   ```
3. Съобщението (alert message) остава каквото индикаторът генерира сам (`alert()` в скрипта вече изпраща готов JSON) — не пипай полето Message в TradingView.
4. На Plus план alert-ите изтичат след известно време на неактивност — ако спрат да идват известия, провери в TradingView дали alert-ът все още е "Active" и го рестартирай при нужда.

Без валиден `token` заявката връща 401 — пази URL-а по същия начин като останалите тайни ключове.

## Локални тестове

Цялата логика (`calcDCALevels`, `checkDcaLevels`, `sendWhatsApp`, `scanSymbolSignals`, `checkMarketSignals`) е тествана локално с Node (mock `fetch` + mock KV), плюс diff-проверка байт-по-байт срещу оригиналните функции в `signal-logic.js` - виж историята на промените, ако искаш да пуснеш проверката пак.
