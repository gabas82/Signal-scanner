# Cloudflare Worker (orange-grass-d809) — setup

Този Worker прави две неща: (1) прокси за Yahoo/football-data.org/api-sports.io/CoinGlass заявките на приложенията, и (2) на cron разписание следи личен watchlist за DCA нива и праща WhatsApp известие през CallMeBot.

`worker.js` **не съдържа никакви ключове в кода** — всички се четат от Worker Secrets, за да могат безопасно да стоят в публичния Signal-scanner repo.

## 1. Качи кода в Cloudflare

Dashboard → Workers & Pages → **orange-grass-d809** → **Edit code** → замени съдържанието на `worker.js` с това от този файл → **Deploy**.

## 2. Добави Secrets

Dashboard → orange-grass-d809 → **Settings → Variables and Secrets** → Add → тип **Secret** (криптирано, не Plaintext) за всяко от:

| Име | Стойност |
|---|---|
| `CG_API_KEY` | твоят съществуващ CoinGlass ключ |
| `FOOTBALL_DATA_TOKEN` | твоят съществуващ football-data.org token |
| `APISPORTS_KEY` | твоят съществуващ api-sports.io ключ |
| `CALLMEBOT_PHONE` | твоят WhatsApp номер с код на държавата, напр. `+359...` |
| `CALLMEBOT_APIKEY` | apikey от CallMeBot (стъпка 4) |

## 3. Добави KV namespace (за cooldown паметта на известията)

Dashboard → **Storage & Databases → KV** → Create namespace, име напр. `signal-alert-state` → после в orange-grass-d809 → **Settings → Bindings → Add → KV Namespace** → Variable name **точно** `ALERT_STATE`, избери новия namespace.

Без това известията пак ще работят, но при всяко cron изпълнение ще спамят едно и също ниво (няма памет между извикванията).

## 4. Активирай CallMeBot (безплатно, без регистрация)

1. Добави `+34 694 25 79 52` като контакт в телефона си.
2. От WhatsApp прати на този контакт точно текста: `I allow callmebot to send me messages`
3. До 2 минути ще получиш отговор с текст като `API Activated for your phone number. Your APIKEY is 123456` — това число е `CALLMEBOT_APIKEY` от стъпка 2. Ако не дойде до 2 мин, опитай пак след 24ч.

Endpoint-ът, който Worker-ът ползва зад кулисите: `https://api.callmebot.com/whatsapp.php?phone=...&text=...&apikey=...`

## 5. Попълни watchlist-а

В `worker.js`, редактирай `WATCHLIST` в началото на файла:

```js
const WATCHLIST = [
  { symbol: 'BTCUSDT', entryPrice: 65000, side: 'long' },
  { symbol: 'ETHUSDT', entryPrice: 3200, side: 'short' },
];
```

`symbol` е задължителен (Binance формат, с `USDT` накрая). `entryPrice`/`side` са нужни само ако искаш DCA известия за конкретна твоя позиция в тази монета — без тях записът засега не прави нищо (CAPITULATION/WARMING/MM пазарни известия за монети без позиция са фаза 2, все още не са включени тук).

## 6. Добави Cron Trigger

Dashboard → orange-grass-d809 → **Settings → Triggers → Cron Triggers → Add Cron Trigger**, напр. `*/5 * * * *` (на всеки 5 минути).

## Как работи

На всяко cron изпълнение, за всеки запис от `WATCHLIST` с `entryPrice`+`side`:
1. Взима текущата цена от Binance.
2. Изчислява DCA нивата (същата формула като DCA калкулатора в приложението — ВХОД / DCA1 (-24%) / DCA2 (-40%) / DCA3 (-35% от DCA2)).
3. Ако цената е пресякла ниво, което не е било известено през последните 24ч, праща WhatsApp съобщение и пази маркер в KV за да не спамва повторно.

## Локални тестове

Логиката (`calcDCALevels`, `checkDcaLevels`, `sendWhatsApp`) е тествана локално с Node (mock `fetch` + mock KV) - виж историята на промените, ако искаш да пуснеш проверката пак.
