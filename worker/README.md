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
3. Cooldown/ARM/прозорец състоянието (за да не спамва един и същ сигнал постоянно) се пази в KV между извикванията, по символ.
4. Ако нещо ново се е задействало, праща едно консолидирано WhatsApp съобщение: текуща цена (последно 5м затваряне), посока (LONG/SHORT — определена от преобладаващия тип на задействалите се сигнали), 5 TP нива, близка съпротива/подкрепа (най-висока/ниска от последните 20 1ч свещи), лонг/шорт съотношение (Binance global account ratio, 1ч) и списъка на задействалите се сигнали.

**TP нивата** (`TP_PCTS` в `worker.js`) са фиксирана %-стълба (+1.26% / +2.34% / +3.58% / +4.52% / +8.23% от текущата цена, обратно за SHORT), извлечена от target 1/3/4/5/7 на външен VIP сигнален канал (Cornix формат) — потвърдено с два реални техни сигнала на различни монети, че процентите са относителни, не абсолютни нива. Няма втори вход/stop loss в тази стълба — има собствена DCA стратегия за допълнителни входове (виж `checkDcaLevels`).

**Посока и увереност** (`computeDirectionConfidence` в `worker.js`): всеки от 14-те детектора гласува LONG или SHORT (виж `longHits`/`shortHits` в `scanSymbolSignals`). Понеже детекторите са напълно независими (различни timeframes/логика), е възможно в една обиколка да се задействат и в двете посоки едновременно за една и съща монета. Затова посока+TP стълба се показват само при **мнозинство поне 4:1** (напр. 4 срещу 1, 8 срещу 2) — при по-слабо мнозинство (напр. 3:2, 2:1) известието показва `⚠️ СМЕСЕНИ СИГНАЛИ` с %-но разпределение вместо подвеждащо уверена посока/TP.

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
