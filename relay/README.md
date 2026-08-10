# Signal-scanner Binance relay

## Защо съществува това

Cloudflare Workers-ът (`worker/worker.js`) вика Binance Futures API директно
(`fapi.binance.com`). Binance блокира IP адресите на Cloudflare Workers на
ниво WAF и връща HTTP 403 ("The request could not be satisfied") — това е
причината watchlist сигналите да не пращат известия по WhatsApp.

Този малък relay сървър решава проблема: качва се на DigitalOcean (обикновен
VPS IP, който Binance не блокира) и просто препраща двете нужни заявки към
Binance. Worker-ът вика relay-я вместо Binance директно.

Няма никакви external зависимости — само вградените `http`/`https` модули на
Node.js, така че `npm install` няма какво да инсталира.

## Endpoints

- `GET /` и `GET /health` — health check, без token (DigitalOcean го вика
  автоматично, за да провери дали приложението е живо).
- `GET /klines?symbol=BTCUSDT&interval=5m&limit=500&token=ТАЙНИЯ_КОД` —
  препраща към `https://fapi.binance.com/fapi/v1/klines`.
- `GET /ticker?symbol=BTCUSDT&token=ТАЙНИЯ_КОД` — препраща към
  `https://fapi.binance.com/fapi/v1/ticker/price`.
- `GET /longshort?symbol=BTCUSDT&period=1h&token=ТАЙНИЯ_КОД` — препраща към
  `https://fapi.binance.com/futures/data/globalLongShortAccountRatio`
  (съотношение дълги/къси позиции, за контекста в пазарните известия).

`token` е споделена тайна (задава се като `RELAY_TOKEN`), за да не може
случаен човек, който намери публичния URL на приложението, да го ползва
безплатно като чужд Binance proxy.

## Стъпки за deploy в DigitalOcean App Platform

1. **Create App** → избери **GitHub** като източник → избери repo-то
   `gabas82/Signal-scanner` → клон `main` (след merge на този PR).
2. **Source Directory**: задай `/relay` (App Platform ще build-не само тази
   папка, не целия repo).
3. DigitalOcean автоматично разпознава Node.js проект (заради
   `package.json`) и предлага `npm run start` като start command — остави го
   както е.
4. **Environment Variables** (App-Level, не Component-Level):
   - `RELAY_TOKEN` = избери си дълъг случаен таен код (напр. генерирай нещо
     като парола от 20+ символа). Маркирай го като **Encrypted**.
5. **Plan**: най-евтиния план (Basic, ~$5/мес) е напълно достатъчен — това е
   почти без трафик релей, не тежко приложение.
6. Натисни **Create Resources** / **Deploy**. След края на deploy-а
   DigitalOcean ще ти даде публичен URL от вида
   `https://signal-relay-xxxxx.ondigitalocean.app`.
7. Провери, че работи — отвори в браузъра:
   `https://signal-relay-xxxxx.ondigitalocean.app/health` → трябва да видиш
   `{"ok":true}`.
8. Провери и `/klines` с истинския token, напр.:
   `https://signal-relay-xxxxx.ondigitalocean.app/klines?symbol=BTCUSDT&interval=5m&limit=5&token=ТВОЯ_ТАЕН_КОД`
   → трябва да видиш JSON масив с candlestick данни от Binance (не грешка).

## Следваща стъпка

След като relay-ят е deploy-нат и провериш горните два адреса, дай ми
неговия URL и токена (RELAY_TOKEN) — ще ги сложим като нови Worker Secrets
(`RELAY_URL`, `RELAY_TOKEN`) в Cloudflare и ще обновим `worker/worker.js` да
вика relay-я вместо Binance директно.
