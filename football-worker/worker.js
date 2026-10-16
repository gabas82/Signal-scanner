// football-worker/worker.js — предложено име на Cloudflare Worker-а:
// "football-dashboard-proxy" (НЕ е създаден в Cloudflare от тая задача).
//
// Extract/preparation artifact (PR 1) от архитектурното решение за
// разделяне на Football Dashboard proxy-то от production Signal-scanner
// Worker-а (orange-grass-d809). Този файл е BYTE-IDENTICAL копие на
// /football/ и /apisports/ branch-овете от Signal-scanner/worker/worker.js
// (merge commit 13e2c01baf8b1615041c00ab32bbe86d6e124227, вкл. PR #138's
// short-TTL cache + single-flight mitigation за /apisports/fixtures?live=all).
// Нулеви промени в самата логика - само преместен в собствен, самостоятелен
// Worker source, без останалите ~7185 реда код на crypto signal scanner
// продукта (вкл. всякакви cron-driven периодични проверки, известителни
// интеграции, diagnostic/debug ендпойнти и state на самия scanner).
//
// Dependencies (виж football-worker.test.js за dependency-confirmation
// тестовия доказателствен материал):
//   - env.FOOTBALL_DATA_TOKEN (secret)
//   - env.APISPORTS_KEY (secret)
//   - caches.default (вградена Cloudflare Cache API, не е binding)
// Нулева употреба на кой да е от secrets/bindings/helper-ите, специфични за
// производствения crypto signal scanner продукт (виж football-worker.test.js
// за точния, автоматично проверен списък на забранените идентификатори).
//
// НЕ е deploy-нат никъде. orange-grass-d809 остава production източник за
// Football Dashboard-а до изричен migration PR, който ще смени WORKER/
// WORKER_AS константите във football.html.

// Transport mitigation (виж discussion-а "Provider rate-limit root-cause
// анализ" - football.html Dashboard-ова страна) - Cloudflare Observability
// потвърди реален cluster от 3 идентични /apisports/fixtures?live=all заявки
// в рамките на <2s, стигащи до Worker-а (вкл. поне веднъж от трафик, който
// НЕ носи сигнатурата на Dashboard-а самия - utm_source параметър, който
// football.html никога не добавя). Worker-ът дотогава нямаше НИКАКЪВ
// caching/inflight dedup - всяка входяща заявка (от кой да е caller -
// Dashboard таб, устройство, external hit) тригерваше независим реален
// upstream fetch. `apisportsLiveAllInflightPromise` е ЕДИНСТВЕНОТО ново
// module-level състояние - single-flight lock, СКОПиран изключително до
// /fixtures?live=all branch-а по-долу (виж fetch()). НЕ е доказан root-cause
// fix - само защитно намалява реалния upstream call rate за near-duplicate
// заявки в кратък прозорец, независимо от произхода им.
let apisportsLiveAllInflightPromise = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const search = url.search;

    // Whitelist за /football/ (PRIORITY 3 от финалния анализ): без него ВСЕКИ
    // path зад /football/ минаваше директно към football-data.org с нашия
    // FOOTBALL_DATA_TOKEN - всеки, който знае Worker URL-а, можеше да го
    // ползва като безплатен прокси и да изразходва квотата ни (аналогична
    // дупка вече беше фиксирана с идентичен подход на друг proxy endpoint в
    // production scanner Worker-а). Токен (PROXY_TOKEN) НЕ е добавен
    // умишлено - football.html е публична страница на gabas82.github.io,
    // токен, вграден в публичен клиентски JS, се вижда веднага през
    // view-source и не крие нищо реално (същата причина, поради която онзи
    // другия whitelist също е чист whitelist, не token).
    // Пътищата тук са изведени директно от реалната употреба в football.html.
    const ALLOWED_FOOTBALL_PATHS = ['/competitions/', '/matches'];
    if (path.startsWith("/football/")) {
      const footballPath = path.replace("/football", "");
      if (!ALLOWED_FOOTBALL_PATHS.some(p => footballPath.startsWith(p))) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }
      const footballUrl = `https://api.football-data.org/v4${footballPath}${search}`;
      const response = await fetch(footballUrl, {
        headers: {
          "X-Auth-Token": env.FOOTBALL_DATA_TOKEN
        }
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Whitelist за /apisports/ - същата причина/подход като /football/ по-горе.
    const ALLOWED_APISPORTS_PATHS = ['/fixtures', '/players/', '/standings'];
    if (path.startsWith("/apisports/")) {
      const apiPath = path.replace("/apisports", "");
      if (!ALLOWED_APISPORTS_PATHS.some(p => apiPath.startsWith(p))) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }

      // Transport mitigation (виж коментара при apisportsLiveAllInflightPromise
      // по-горе) - СТРИКТНО скопирана до /fixtures?live=all, нищо друго под
      // /apisports/ не минава през тоя клон. Cache identity е canonical
      // upstream URL (без tracking/други query параметри от входящата
      // заявка - виж discussion-а "tracking параметри не трябва да създават
      // отделен cache entry"), не raw incoming request URL.
      if (apiPath === '/fixtures' && url.searchParams.get('live') === 'all') {
        const canonicalLiveAllUrl = 'https://v3.football.api-sports.io/fixtures?live=all';
        const cacheKey = new Request(canonicalLiveAllUrl, { method: 'GET' });
        const cache = caches.default;
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) return cachedResponse;

        if (!apisportsLiveAllInflightPromise) {
          apisportsLiveAllInflightPromise = (async () => {
            try {
              const response = await fetch(canonicalLiveAllUrl, {
                headers: { "x-apisports-key": env.APISPORTS_KEY }
              });
              const data = await response.json();
              // Огледално на вече доказания detection сигнал в apiFetchAS()
              // (football.html) - api-sports.io връща HTTP 200 дори при
              // достигнат лимит, с {"errors":{...}} тяло. Cache-ваме
              // ИЗКЛЮЧИТЕЛНО успешен отговор (празен errors обект/масив) -
              // provider грешка (rateLimit или друга) никога не влиза в
              // cache-а и никога не удължава TTL-а.
              const hasProviderError = !!(data && data.errors && Object.keys(data.errors).length);
              // PRE-MERGE корекция (виж discussion-а "transient/anomalous
              // zero response caching риск") - production наблюдение (6 live
              // мача -> 0 -> 0 -> 6 отново, без user interaction) доказа, че
              // upstream МОЖЕ да върне легитимен-изглеждащ `errors:[],
              // results:0, response:[]` временно, дори докато реално има live
              // мачове. `results:0` е структурно НЕРАЗЛИЧИМО от "наистина
              // няма live мачове в момента" - НЯМА надежден начин да се
              // различат без heuristic/hindsight (сравнение с предишно
              // известно състояние), което изрично не въвеждаме. Затова: НЕ
              // кешираме НИКАКВА нула, независимо от причината - единна,
              // uniform проверка, не "detection" на anomaly. Иначе 1
              // transient/anomalous нула би се споделяла към ВСИЧКИ caller-и
              // за 15s (cache-ът е shared между tabove/устройства), вместо да
              // си остане изолирана за 1 caller, 1 момент, каквото е pre-
              // mitigation поведението. Legitimate нула (действително няма
              // live мачове) просто губи cache защитата - всеки caller пак
              // прави собствена upstream заявка, точно както преди тая цяла
              // задача - нулева промяна в коректността, само по-малко
              // защитено от clustering през тия периоди.
              const hasLiveMatches = Array.isArray(data && data.response) && data.response.length > 0;
              if (!hasProviderError && hasLiveMatches) {
                const toCache = new Response(JSON.stringify(data), {
                  headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "max-age=15"
                  }
                });
                await cache.put(cacheKey, toCache);
              }
              return data;
            } finally {
              apisportsLiveAllInflightPromise = null;
            }
          })();
        }
        const data = await apisportsLiveAllInflightPromise;
        return new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      const apiUrl = `https://v3.football.api-sports.io${apiPath}${search}`;
      const response = await fetch(apiUrl, {
        headers: {
          "x-apisports-key": env.APISPORTS_KEY
        }
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Всичко извън /football/ и /apisports/ е извън scope-а на тоя Worker -
    // за разлика от стария orange-grass-d809 (където catch-all-ът в дъното
    // пада към друг proxy route), тук НЯМА друг proxy traffic да обслужва.
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
};
