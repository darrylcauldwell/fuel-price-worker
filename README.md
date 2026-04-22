# fuel-price-worker

A [CloudFlare Worker](https://developers.cloudflare.com/workers/) that proxies the [UK Government Fuel Finder API](https://www.developer.fuel-finder.service.gov.uk/), caching fuel station data and prices for consumption by mobile apps.

## What is a CloudFlare Worker?

A CloudFlare Worker is a small piece of code that runs on CloudFlare's global edge network — the same infrastructure that handles DNS and CDN for millions of websites. When a request arrives at a URL you define, CloudFlare intercepts it and runs your function on the nearest edge server (300+ locations worldwide) instead of routing to a traditional backend server.

Workers are ideal for lightweight tasks like caching and proxying APIs: no servers to manage, no containers to deploy, and responses are served from the edge location closest to the user.

## What is Wrangler?

[Wrangler](https://developers.cloudflare.com/workers/wrangler/) is CloudFlare's command-line tool for building and deploying Workers. It handles local development, testing, secret management, and deployment. Think of it as the `docker` CLI equivalent for CloudFlare Workers — one command to develop locally (`wrangler dev`), one to deploy (`wrangler deploy`).

## Why this exists

The UK Government mandates all fuel retailers to report prices via the Fuel Finder API. The API requires OAuth credentials that [must not be embedded in mobile apps](https://www.developer.fuel-finder.service.gov.uk/dev-guideline). This Worker holds the credentials, fetches data every 5 minutes, caches it in CloudFlare KV, and serves a simple JSON API that the [FuelFinder iOS app](https://github.com/darrylcauldwell/FuelFinder) can call without authentication.

## Architecture

```
UK Gov Fuel Finder API
    ↓ (OAuth, every 5 min via cron trigger)
CloudFlare Worker
    ↓ (caches in KV store)
CloudFlare Edge (300+ locations)
    ↓ (JSON over HTTPS)
FuelFinder iOS app / CarPlay
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/stations` | All UK fuel stations with current prices |
| `GET /api/v1/motorway-stations` | Motorway service stations only (filtered by `is_motorway_service_station`) |
| `GET /api/v1/health` | Cache status and last sync timestamp |

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [CloudFlare account](https://dash.cloudflare.com/sign-up)
- UK Government Fuel Finder API credentials (register at [developer.fuel-finder.service.gov.uk](https://www.developer.fuel-finder.service.gov.uk/get-started-ifr/onelogin))

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Authenticate with CloudFlare

```bash
npx wrangler login
```

This opens a browser to authorise Wrangler with your CloudFlare account.

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create FUEL_CACHE
```

Copy the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 4. Set API secrets

Secrets are stored in CloudFlare's secret manager — never in code, never in git, never in the app bundle.

```bash
npx wrangler secret put FUEL_API_CLIENT_ID
npx wrangler secret put FUEL_API_CLIENT_SECRET
```

Each command prompts for the value interactively.

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in your credentials:

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` is gitignored and never committed.

### 5. Deploy

```bash
npm run deploy
```

This deploys the Worker to CloudFlare's edge network. The cron trigger starts automatically, fetching data every 5 minutes.

## Local development

```bash
npm run dev
```

Starts a local Worker at `http://localhost:8787`. Uses `.dev.vars` for credentials and a local KV emulator.

Test endpoints:

```bash
curl http://localhost:8787/api/v1/health
curl http://localhost:8787/api/v1/stations
curl http://localhost:8787/api/v1/motorway-stations
```

## How it works

### Cron trigger (every 5 minutes)

1. **Station metadata** — fetched once per day (changes rarely). Includes location, brand, amenities, opening hours, and `is_motorway_service_station` flag.
2. **Fuel prices** — fetched every 5 minutes using incremental updates (`effective-start-timestamp`). Only changed prices are fetched and merged into the cached dataset.

### Request handling

When the iOS app calls `/api/v1/stations`, the Worker reads the cached data from KV and returns it. No live API call happens — the response is pre-cached. CloudFlare's `Cache-Control: public, max-age=300` header means the edge CDN can also cache the response, reducing KV reads.

### OAuth token management

Tokens are cached in KV for just under 1 hour (tokens expire at 3600s). A new token is fetched automatically when the cached one expires.

## Fair use compliance

The Worker complies with the [Fuel Finder Fair Use Policy](https://www.developer.fuel-finder.service.gov.uk/):

- Refreshes at least every 5 minutes (cron trigger)
- Serves data unmodified (no price manipulation or selective filtering)
- Timestamps preserved as-is
- Credentials stored in Worker secrets, not exposed to clients

## Monitoring

View live logs:

```bash
npm run tail
```

Check cache status:

```bash
curl https://fuel.dreamfold.dev/api/v1/health
```

## Costs

| Tier | Requests | Cost |
|------|----------|------|
| Free | 100,000/day | $0 |
| Paid | 10M/month | $5/month |
| Overage | Per additional million | $0.50 |

The free tier hard-stops at the limit (no surprise bills). KV storage: 1 GB free, $0.50/GB after.

## Related

- [FuelFinder iOS app](https://github.com/darrylcauldwell/FuelFinder) — the mobile app that consumes this API
- [UK Fuel Finder developer portal](https://www.developer.fuel-finder.service.gov.uk/) — register for API credentials
- [Fair Use Policy](https://www.developer.fuel-finder.service.gov.uk/dev-guideline) — data usage terms

## Licence

[MIT](LICENCE)
