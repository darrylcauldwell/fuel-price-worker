/**
 * Fuel Price Worker
 *
 * CloudFlare Worker that proxies the UK Government Fuel Finder API.
 * Fetches station metadata and fuel prices, caches them in KV,
 * and serves a unified JSON endpoint for mobile app consumers.
 *
 * Credentials are stored as Worker secrets — never exposed to clients.
 */

export interface Env {
  FUEL_CACHE: KVNamespace;
  FUEL_API_CLIENT_ID: string;
  FUEL_API_CLIENT_SECRET: string;
}

// --- Constants ---

const API_BASE = "https://www.fuel-finder.service.gov.uk/api/v1";
const TOKEN_ENDPOINT = `${API_BASE}/oauth/generate_access_token`;
const STATIONS_ENDPOINT = `${API_BASE}/pfs`;
const PRICES_ENDPOINT = `${API_BASE}/pfs/fuel-prices`;
const BATCH_SIZE = 500;

// KV keys
const KV_STATIONS = "stations";
const KV_PRICES = "prices";
const KV_TOKEN = "oauth_token";
const KV_LAST_PRICE_SYNC = "last_price_sync";
const KV_LAST_SYNC_ERROR = "last_sync_error";
const KV_LAST_SYNC_OK = "last_sync_ok";

// Cache TTLs (seconds)
// TTLs are set long so cached data survives API outages.
// The cron refreshes every 5 minutes regardless — TTL is a safety net, not the refresh driver.
const STATIONS_TTL = 86400; // 24 hours — station metadata changes rarely
const PRICES_TTL = 86400; // 24 hours — stale prices are better than no prices during an outage
const TOKEN_TTL = 3500; // Just under 1 hour (tokens expire at 3600)

// CORS headers for mobile app access
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Headers to pass CloudFront WAF on the government API
const API_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Accept": "application/json, text/html, */*",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.fuel-finder.service.gov.uk/",
  "Origin": "https://www.fuel-finder.service.gov.uk",
};

// --- OAuth Token Management ---

interface OAuthToken {
  access_token: string;
  expires_at: number;
}

async function getAccessToken(env: Env): Promise<string> {
  // Check KV cache first
  const cached = await env.FUEL_CACHE.get(KV_TOKEN, "json") as OAuthToken | null;
  if (cached && cached.expires_at > Date.now()) {
    return cached.access_token;
  }

  // Fetch new token
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.FUEL_API_CLIENT_ID,
    client_secret: env.FUEL_API_CLIENT_SECRET,
    scope: "fuelfinder.read",
  });

  // Retry 403/429 with linear backoff. CloudFront's WAF challenges the OAuth
  // endpoint intermittently, and a fixed cron that fails the token refresh
  // would never recover until the KV TTLs drained. Same pattern as
  // fetchAllBatches but inlined because this is a one-shot POST.
  let resp: Response | undefined;
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    // Use redirect: "follow" and no-cache to avoid CloudFront WAF edge-IP blocks
    resp = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        ...API_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Connection": "keep-alive",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      body: body.toString(),
      redirect: "follow",
    });

    if (resp.ok) break;
    if ((resp.status === 429 || resp.status === 403) && attempt < MAX_RETRIES) {
      attempt++;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      continue;
    }
    break;
  }

  if (!resp || !resp.ok) {
    const status = resp?.status ?? 0;
    const text = resp ? (await resp.text()).substring(0, 200) : "";
    throw new Error(`OAuth token request failed (${status}) after ${attempt} retries: ${text}`);
  }

  const raw = await resp.text();
  const data = JSON.parse(raw) as Record<string, unknown>;

  // Handle nested response: {success: true, data: {access_token: ...}}
  const accessToken = (data.access_token || (data.data as Record<string, unknown>)?.access_token) as string;
  const expiresIn = (data.expires_in || (data.data as Record<string, unknown>)?.expires_in || 3600) as number;

  if (!accessToken) {
    throw new Error(`OAuth response missing access_token: ${raw.substring(0, 200)}`);
  }

  const token: OAuthToken = {
    access_token: accessToken,
    expires_at: Date.now() + expiresIn * 1000 - 60000, // 1 min buffer
  };

  await env.FUEL_CACHE.put(KV_TOKEN, JSON.stringify(token), { expirationTtl: TOKEN_TTL });
  return token.access_token;
}

// --- Paginated API Fetch ---

const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 2000;

async function fetchAllBatches(endpoint: string, token: string, extraParams?: Record<string, string>): Promise<unknown[]> {
  const allRecords: unknown[] = [];
  let batch = 1;
  let retries = 0;

  while (true) {
    const params = new URLSearchParams({ "batch-number": String(batch) });
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) {
        params.set(k, v);
      }
    }
    const url = `${endpoint}?${params.toString()}`;

    const resp = await fetch(url, {
      headers: {
        ...API_HEADERS,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!resp.ok) {
      // 403 with empty body is CloudFront WAF challenging — intermittent and
      // usually clears within a few seconds. Retry the same batch with a short
      // delay, up to a small cap, before giving up. 429 gets the same treatment.
      if ((resp.status === 429 || resp.status === 403) && retries < MAX_RETRIES) {
        retries++;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * retries));
        continue;
      }
      const text = await resp.text();
      throw new Error(`API request failed (${resp.status}): ${text.substring(0, 200)}`);
    }

    const raw = await resp.text();
    const parsed = JSON.parse(raw);

    // Response is a raw JSON array
    const records: unknown[] = Array.isArray(parsed) ? parsed : [];

    if (records.length === 0) {
      break;
    }

    allRecords.push(...records);

    // If we got fewer than BATCH_SIZE, we've reached the last page
    if (records.length < BATCH_SIZE) {
      break;
    }

    batch++;
    retries = 0; // Reset retry counter on each successful batch
  }

  return allRecords;
}

// --- Data Sync ---

async function syncStations(env: Env): Promise<void> {
  const token = await getAccessToken(env);
  const stations = await fetchAllBatches(STATIONS_ENDPOINT, token);

  await env.FUEL_CACHE.put(KV_STATIONS, JSON.stringify(stations), {
    expirationTtl: STATIONS_TTL,
  });

  console.log(`Synced ${stations.length} stations`);
}

// Maximum batches per invocation. Each batch is one API call (~500 records).
// Full dataset is ~16-18 batches (~45s wall clock). Set comfortably above that so
// a single cron run completes the full sync and `lastPriceSync` flips to a real
// timestamp, switching subsequent runs to fast incremental mode.
const MAX_BATCHES_PER_RUN = 25;
const KV_PRICE_BATCH_CURSOR = "price_batch_cursor";

async function syncPrices(env: Env): Promise<void> {
  const token = await getAccessToken(env);

  const lastSync = await env.FUEL_CACHE.get(KV_LAST_PRICE_SYNC);
  const existingRaw = await env.FUEL_CACHE.get(KV_PRICES);

  // Both timestamp AND cache must be present to safely go incremental.
  // If the cache expired (e.g. after a 24h quiet period with no incremental
  // changes refreshing its TTL) but the timestamp survived, an incremental
  // sync would lose every station that didn't happen to update in this window.
  // Fall back to a full sync instead.
  if (lastSync && existingRaw) {
    // Incremental: fetch only changes since last sync (usually 1 batch, very fast)
    const prices = await fetchAllBatches(PRICES_ENDPOINT, token, {
      "effective-start-timestamp": lastSync,
    });

    const existing = JSON.parse(existingRaw) as Record<string, unknown>[];
    const priceMap = new Map<string, unknown>();
    for (const p of existing) {
      const record = p as Record<string, unknown>;
      priceMap.set(record.node_id as string, record);
    }
    for (const p of prices) {
      const record = p as Record<string, unknown>;
      priceMap.set(record.node_id as string, record);
    }

    const merged = Array.from(priceMap.values());
    // Always re-write to refresh KV TTL, even when prices.length === 0 — keeps
    // the cache alive through quiet stretches when nothing changes upstream.
    await env.FUEL_CACHE.put(KV_PRICES, JSON.stringify(merged), { expirationTtl: PRICES_TTL });
    if (prices.length > 0) {
      console.log(`Merged ${prices.length} incremental updates (total: ${merged.length})`);
    }

    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    await env.FUEL_CACHE.put(KV_LAST_PRICE_SYNC, now, { expirationTtl: STATIONS_TTL });
  } else {
    // Reset cursor + timestamp before progressive full sync — otherwise a stale
    // KV_LAST_PRICE_SYNC could leak into the next run if full sync gets re-entered.
    if (lastSync) await env.FUEL_CACHE.delete(KV_LAST_PRICE_SYNC);
    // Full sync: progressive — fetch MAX_BATCHES_PER_RUN batches per invocation,
    // resume from cursor on next cron run until complete.
    const cursorStr = await env.FUEL_CACHE.get(KV_PRICE_BATCH_CURSOR);
    const startBatch = cursorStr ? parseInt(cursorStr, 10) : 1;

    console.log(`Full price sync: starting from batch ${startBatch}`);

    const allRecords: unknown[] = [];
    let batch = startBatch;
    let reachedEnd = false;

    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const params = new URLSearchParams({ "batch-number": String(batch) });
      const url = `${PRICES_ENDPOINT}?${params.toString()}`;

      const resp = await fetch(url, {
        headers: { ...API_HEADERS, Authorization: `Bearer ${token}` },
      });

      if (!resp.ok) {
        // 403 (WAF challenge) and 429 (rate limit) are both transient — pause
        // the progressive sync, save the cursor, and resume next cron. The
        // cursor logic below handles persisting where we got to.
        if (resp.status === 429 || resp.status === 403) {
          console.log(`Transient ${resp.status} during full sync at batch ${batch}, will resume next run`);
          break;
        }
        const text = await resp.text();
        throw new Error(`Price fetch failed (${resp.status}): ${text.substring(0, 200)}`);
      }

      const parsed = JSON.parse(await resp.text());
      const records: unknown[] = Array.isArray(parsed) ? parsed : [];

      if (records.length === 0) {
        reachedEnd = true;
        break;
      }

      allRecords.push(...records);
      if (records.length < BATCH_SIZE) {
        reachedEnd = true;
        break;
      }
      batch++;
    }

    // Merge with existing partial data (from a resumed progressive sync).
    // Re-read here rather than reusing the outer `existingRaw` because earlier
    // iterations of a progressive sync may have written partial data to KV.
    const partialRaw = await env.FUEL_CACHE.get(KV_PRICES);
    const existing = partialRaw ? (JSON.parse(partialRaw) as Record<string, unknown>[]) : [];

    const priceMap = new Map<string, unknown>();
    for (const p of existing) {
      const record = p as Record<string, unknown>;
      priceMap.set(record.node_id as string, record);
    }
    for (const p of allRecords) {
      const record = p as Record<string, unknown>;
      priceMap.set(record.node_id as string, record);
    }

    const merged = Array.from(priceMap.values());
    await env.FUEL_CACHE.put(KV_PRICES, JSON.stringify(merged), { expirationTtl: PRICES_TTL });
    console.log(`Full sync batch ${startBatch}-${batch}: fetched ${allRecords.length}, total cached: ${merged.length}`);

    if (reachedEnd) {
      // Full sync complete — set timestamp so future syncs are incremental
      const now = new Date().toISOString().replace("T", " ").substring(0, 19);
      await env.FUEL_CACHE.put(KV_LAST_PRICE_SYNC, now, { expirationTtl: STATIONS_TTL });
      await env.FUEL_CACHE.delete(KV_PRICE_BATCH_CURSOR);
      console.log(`Full price sync complete: ${merged.length} stations with prices`);
    } else {
      // Save cursor to resume next run
      await env.FUEL_CACHE.put(KV_PRICE_BATCH_CURSOR, String(batch), { expirationTtl: STATIONS_TTL });
      console.log(`Full sync paused at batch ${batch}, will resume next cron`);
    }
  }
}

// --- Demand-Driven Refresh ---

// How stale cached data is allowed to become before a request triggers a
// background refresh. 5 min sits well inside the CMA's 30-min publishing
// requirement — drivers see prices that are at most ~5 min behind whatever
// the retailer feed is publishing.
const SOFT_TTL_MS = 5 * 60 * 1000;

/**
 * Full sync flow shared by background refresh and the manual /api/v1/sync
 * endpoint. Records last-success / last-error to KV so /api/v1/health can
 * surface pipeline state without needing wrangler tail.
 */
async function performSync(env: Env, incremental: boolean): Promise<void> {
  try {
    const existingStations = await env.FUEL_CACHE.get(KV_STATIONS);
    if (!incremental || !existingStations) {
      await syncStations(env);
    }
    await syncPrices(env);
    await env.FUEL_CACHE.put(KV_LAST_SYNC_OK, new Date().toISOString(), { expirationTtl: STATIONS_TTL });
    await env.FUEL_CACHE.delete(KV_LAST_SYNC_ERROR);
  } catch (err) {
    console.error("Sync error:", err);
    const payload = JSON.stringify({
      at: new Date().toISOString(),
      message: String(err),
    });
    await env.FUEL_CACHE.put(KV_LAST_SYNC_ERROR, payload, { expirationTtl: STATIONS_TTL });
    throw err;
  }
}

/**
 * If cache is older than SOFT_TTL_MS (or missing entirely), fire a refresh
 * via ctx.waitUntil so the current response goes out immediately. The
 * refresh runs in the SAME fetch-handler invocation — its outbound gov API
 * calls therefore use the egress pool the WAF accepts. Scheduled triggers
 * and Service Bindings both inherit a different (blocked) egress, which is
 * why this whole architecture is demand-driven instead of cron-driven.
 */
async function maybeRefreshInBackground(env: Env, ctx: ExecutionContext): Promise<void> {
  const lastSyncStr = await env.FUEL_CACHE.get(KV_LAST_PRICE_SYNC);
  if (!lastSyncStr) {
    // Cold start — fire full sync. Current request will 503; next request
    // (iOS retries) lands on warm cache.
    ctx.waitUntil(performSync(env, false).catch(() => {}));
    return;
  }
  // KV_LAST_PRICE_SYNC is stored as "YYYY-MM-DD HH:MM:SS" UTC by syncPrices.
  const ageMs = Date.now() - Date.parse(lastSyncStr.replace(" ", "T") + "Z");
  if (ageMs > SOFT_TTL_MS) {
    ctx.waitUntil(performSync(env, true).catch(() => {}));
  }
}

// --- HTTP Request Handler ---

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Health check
  if (url.pathname === "/api/v1/health") {
    const stations = await env.FUEL_CACHE.get(KV_STATIONS);
    const prices = await env.FUEL_CACHE.get(KV_PRICES);
    const lastPriceSync = await env.FUEL_CACHE.get(KV_LAST_PRICE_SYNC);
    const lastSyncOk = await env.FUEL_CACHE.get(KV_LAST_SYNC_OK);
    const lastSyncError = await env.FUEL_CACHE.get(KV_LAST_SYNC_ERROR);

    return Response.json(
      {
        status: "ok",
        cache: {
          stations: stations ? "populated" : "empty",
          prices: prices ? "populated" : "empty",
          lastPriceSync: lastPriceSync || "never",
        },
        sync: {
          lastSuccess: lastSyncOk || "never",
          lastError: lastSyncError || null,
        },
      },
      { headers: CORS_HEADERS }
    );
  }

  // Manual sync trigger — for ops. Day-to-day refreshes happen on-demand,
  // driven by /stations + /motorway-stations requests. This endpoint still
  // exists for forcing a refresh from a terminal or for a daily safety-net
  // ping if one is ever added. `?incremental=true` skips the slow stations
  // resync when the cache is already populated.
  if (url.pathname === "/api/v1/sync") {
    try {
      const incremental = url.searchParams.get("incremental") === "true";
      await performSync(env, incremental);

      const health = {
        stations: await env.FUEL_CACHE.get(KV_STATIONS) ? "populated" : "empty",
        prices: await env.FUEL_CACHE.get(KV_PRICES) ? "populated" : "empty",
        lastPriceSync: await env.FUEL_CACHE.get(KV_LAST_PRICE_SYNC) || "never",
      };
      return Response.json(
        { status: "synced", cache: health },
        { headers: CORS_HEADERS }
      );
    } catch (err) {
      return Response.json(
        { status: "error", message: String(err) },
        { status: 500, headers: CORS_HEADERS }
      );
    }
  }

  // Stations + prices endpoint (primary endpoint for the iOS app).
  // Every call also checks cache age and may fire a background refresh.
  if (url.pathname === "/api/v1/stations") {
    await maybeRefreshInBackground(env, ctx);

    const stationsRaw = await env.FUEL_CACHE.get(KV_STATIONS);
    const pricesRaw = await env.FUEL_CACHE.get(KV_PRICES);

    if (!stationsRaw) {
      return Response.json(
        { error: "Data not yet available. Try again shortly." },
        { status: 503, headers: CORS_HEADERS }
      );
    }

    const stations = JSON.parse(stationsRaw) as Record<string, unknown>[];
    const prices = pricesRaw ? (JSON.parse(pricesRaw) as Record<string, unknown>[]) : [];

    // Build price lookup by node_id
    const priceMap = new Map<string, unknown>();
    for (const p of prices) {
      priceMap.set(p.node_id as string, p);
    }

    // Merge stations with their prices
    const merged = stations.map((station) => ({
      ...station,
      fuel_prices: priceMap.get(station.node_id as string) || null,
    }));

    return Response.json(
      {
        last_updated: await env.FUEL_CACHE.get(KV_LAST_PRICE_SYNC),
        count: merged.length,
        stations: merged,
      },
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=300", // Client can cache for 5 min
        },
      }
    );
  }

  // Motorway services only (convenience endpoint for motorway mode).
  // Same demand-driven refresh as /stations.
  if (url.pathname === "/api/v1/motorway-stations") {
    await maybeRefreshInBackground(env, ctx);

    const stationsRaw = await env.FUEL_CACHE.get(KV_STATIONS);
    const pricesRaw = await env.FUEL_CACHE.get(KV_PRICES);

    if (!stationsRaw) {
      return Response.json(
        { error: "Data not yet available. Try again shortly." },
        { status: 503, headers: CORS_HEADERS }
      );
    }

    const stations = JSON.parse(stationsRaw) as Record<string, unknown>[];
    const prices = pricesRaw ? (JSON.parse(pricesRaw) as Record<string, unknown>[]) : [];

    const priceMap = new Map<string, unknown>();
    for (const p of prices) {
      priceMap.set(p.node_id as string, p);
    }

    // Filter to motorway service stations only
    const motorway = stations
      .filter((s) => s.is_motorway_service_station === true)
      .map((station) => ({
        ...station,
        fuel_prices: priceMap.get(station.node_id as string) || null,
      }));

    return Response.json(
      {
        last_updated: await env.FUEL_CACHE.get(KV_LAST_PRICE_SYNC),
        count: motorway.length,
        stations: motorway,
      },
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=300",
        },
      }
    );
  }

  return Response.json({ error: "Not found" }, { status: 404, headers: CORS_HEADERS });
}

// --- Worker Entry Point ---

export default {
  // HTTP-only worker. No `scheduled` handler — Cloudflare cron triggers can't
  // reach the gov API (its WAF blocks scheduled-context egress, even when
  // routed through Service Bindings). Refreshes are demand-driven: each call
  // to /stations or /motorway-stations checks cache age and may fire a
  // background refresh via ctx.waitUntil. See maybeRefreshInBackground.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error("Request error:", err);
      return Response.json(
        { error: "Internal server error" },
        { status: 500, headers: CORS_HEADERS }
      );
    }
  },
};
