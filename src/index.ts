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

// Cache TTLs (seconds)
const STATIONS_TTL = 86400; // 24 hours — station metadata changes rarely
const PRICES_TTL = 600; // 10 minutes — prices update frequently
const TOKEN_TTL = 3500; // Just under 1 hour (tokens expire at 3600)

// CORS headers for mobile app access
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Headers to pass CloudFront WAF on the government API
const API_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  "Accept": "application/json, */*",
  "Accept-Language": "en-GB,en;q=0.9",
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

  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { ...API_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OAuth token request failed (${resp.status}): ${text}`);
  }

  const raw = await resp.text();
  console.log("OAuth response:", raw);
  const data = JSON.parse(raw) as Record<string, unknown>;
  // Extract token — handle nested response formats
  const accessToken = (data.access_token || (data.data as Record<string, unknown>)?.access_token) as string;
  const expiresIn = (data.expires_in || (data.data as Record<string, unknown>)?.expires_in || 3600) as number;

  if (!accessToken) {
    throw new Error(`OAuth response missing access_token: ${raw}`);
  }

  console.log(`Token obtained, expires in ${expiresIn}s, starts with: ${accessToken.substring(0, 20)}...`);

  const token: OAuthToken = {
    access_token: accessToken,
    expires_at: Date.now() + expiresIn * 1000 - 60000, // 1 min buffer
  };

  await env.FUEL_CACHE.put(KV_TOKEN, JSON.stringify(token), { expirationTtl: TOKEN_TTL });
  return token.access_token;
}

// --- Paginated API Fetch ---

async function fetchAllBatches(endpoint: string, token: string, extraParams?: Record<string, string>): Promise<unknown[]> {
  const allRecords: unknown[] = [];
  let batch = 1;

  while (true) {
    const params = new URLSearchParams({ "batch-number": String(batch) });
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) {
        params.set(k, v);
      }
    }
    const url = `${endpoint}?${params.toString()}`;
    console.log(`Fetching: ${url}`);

    const resp = await fetch(url, {
      headers: {
        ...API_HEADERS,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!resp.ok) {
      if (resp.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const text = await resp.text();
      throw new Error(`API request failed (${resp.status}): ${text}`);
    }

    const raw = await resp.text();
    console.log(`Batch ${batch}: ${raw.length} bytes, first 200 chars: ${raw.substring(0, 200)}`);
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

async function syncPrices(env: Env): Promise<void> {
  const token = await getAccessToken(env);

  // Use incremental update if we have a last sync timestamp
  const lastSync = await env.FUEL_CACHE.get(KV_LAST_PRICE_SYNC);
  const extraParams = lastSync
    ? { "effective-start-timestamp": lastSync }
    : undefined;

  const prices = await fetchAllBatches(PRICES_ENDPOINT, token, extraParams);

  if (lastSync && prices.length > 0) {
    // Merge incremental updates with existing cached prices
    const existingRaw = await env.FUEL_CACHE.get(KV_PRICES);
    const existing = existingRaw ? (JSON.parse(existingRaw) as Record<string, unknown>[]) : [];

    // Build lookup by node_id for fast merge
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
    await env.FUEL_CACHE.put(KV_PRICES, JSON.stringify(merged), {
      expirationTtl: PRICES_TTL,
    });
    console.log(`Merged ${prices.length} price updates (total: ${merged.length})`);
  } else {
    await env.FUEL_CACHE.put(KV_PRICES, JSON.stringify(prices), {
      expirationTtl: PRICES_TTL,
    });
    console.log(`Synced ${prices.length} prices (full refresh)`);
  }

  // Record sync timestamp
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  await env.FUEL_CACHE.put(KV_LAST_PRICE_SYNC, now, { expirationTtl: STATIONS_TTL });
}

// --- HTTP Request Handler ---

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Health check
  if (url.pathname === "/api/v1/health") {
    const stations = await env.FUEL_CACHE.get(KV_STATIONS);
    const prices = await env.FUEL_CACHE.get(KV_PRICES);
    const lastSync = await env.FUEL_CACHE.get(KV_LAST_PRICE_SYNC);

    return Response.json(
      {
        status: "ok",
        cache: {
          stations: stations ? "populated" : "empty",
          prices: prices ? "populated" : "empty",
          lastPriceSync: lastSync || "never",
        },
      },
      { headers: CORS_HEADERS }
    );
  }

  // Stations + prices endpoint (primary endpoint for the iOS app)
  if (url.pathname === "/api/v1/stations") {
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

  // Motorway services only (convenience endpoint for motorway mode)
  if (url.pathname === "/api/v1/motorway-stations") {
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
  // HTTP request handler
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error("Request error:", err);
      return Response.json(
        { error: "Internal server error" },
        { status: 500, headers: CORS_HEADERS }
      );
    }
  },

  // Cron trigger — runs every 5 minutes
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      // Sync stations once per day (check if cached)
      const existingStations = await env.FUEL_CACHE.get(KV_STATIONS);
      if (!existingStations) {
        await syncStations(env);
      }

      // Always sync prices
      await syncPrices(env);
    } catch (err) {
      console.error("Scheduled sync error:", err);
    }
  },
};
