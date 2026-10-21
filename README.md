[English](./README.md) | [简体中文](./README.zh-Hans.md)

# PingAtlas

> [!WARNING]
> This project was written through **Vibe Coding**. Although the code has been
> reviewed by humans, it cannot be guaranteed to be 100% controlled or
> bug-free. Use it at your own risk.

PingAtlas is an online network-testing service built on [Globalping](https://globalping.io) and on the project's own Node.js + TypeScript framework. It provides a measurement console for ping, traceroute, DNS, MTR and HTTP, a live result viewer, optional OpenID Connect sign-in, and PWA support.

The interface presents the **probe list** and the **measurement result details**; no map view is provided, as publishing online maps in Mainland China requires a map-approval number (审图号).

## Features

- **Five measurement types** — `ping`, `traceroute`, `dns`, `mtr`, `http`, each exposing the option set of the upstream API (packets, protocol, port, IP version, query type, resolver, HTTP method/path/query/headers, timeout, …)
- **Probe selection** — free-form `magic` target plus continent / country / city / ASN / network / tag filters, with **3 probes by default**, clamped to the upstream hard limit for the current mode (50 anonymous, 500 authenticated)
- **Location autocomplete** — every location field is an ARIA combobox backed by a de-duplicated probe index (`GET /api/probes`, which consumes no Globalping quota). Matching is fuzzy, ranked as exact > prefix > substring > **subsequence** (for example, `Fuzho` matches `Fuzhou`). Each suggestion shows its probe count, personal `u-*` tags are de-prioritised, and keyboard navigation (↑/↓/Enter/Esc) is supported alongside pointer selection. The index is cached in memory, in `localStorage` (24 h TTL) and by the browser's HTTP cache (`max-age=300`)
- **Result viewer**:
  - Probe list: one card per probe with country / city / ASN / network / tags
  - Per-probe detail: ping RTT timing bars & packet loss, traceroute/MTR hops, DNS answers, HTTP status / headers / body preview / timings / TLS
  - Collapsible raw output for every probe
  - Live progress while the measurement is running, and structured rendering of upstream errors
- **Dual-path requests**:
  - The browser calls `https://api.globalping.io` **directly** using the visitor's own anonymous quota (250/hour, per IP); this is the default path
  - When the local quota is exhausted, or when more than 50 probes are requested, requests fall back to this service's `/api/*` proxy, which injects the server-side `GP_TOKEN`
  - Both quota meters are displayed at the bottom-left; the server-token path is available only while signed in
- **OpenID Connect sign-in only** — authorization code flow with S256 PKCE (`openid-client` v6), compatible with Keycloak and adaptable to other IdPs through environment variables; the signed-in user name (`preferred_username`) is displayed
- **PWA** — `manifest.webmanifest` and a service worker with versioned app-shell caching
- **i18n** — Simplified Chinese and English are built in; a new language requires one locale file and one registration entry
- **Light / dark theme** — follows the system preference and can also be toggled manually
- **Responsive layout** — below 620px wide, result tables reflow into stacked cards; long hostnames wrap while numeric columns remain on a single line, preventing horizontal scrolling

## Quota strategy

Two quota sources are available, and the front end selects one per measurement:

| Meter | Owner | Source | Notes |
| --- | --- | --- | --- |
| Left | `ip` (your own) | `GET {apiUrl}/v1/limits`, called directly from the browser | 250/h per public IP; polling does not consume quota |
| Right | `user` (server token) | `GET /api/limits` through this service | Displayed only when signed in and `GP_TOKEN` is configured; may additionally report `credits.remaining` |

Routing rules, evaluated for every measurement:

1. If the direct API is unreachable → proxy (or report "no quota channel available")
2. If the local quota `remaining <= 0` → proxy
3. If more probes are requested than the anonymous limit allows (>50) → proxy
4. If the visitor explicitly switched to the proxy meter → proxy
5. Otherwise → direct (local quota)

Additional behaviour:

- The direct path is used **by default** while the local quota has remaining capacity.
- The local quota is refreshed by a **5-minute heartbeat**, and re-checked precisely 2 s after the reported `reset` time once `remaining` reaches 0. Returning to the tab also triggers a re-check, throttled to 30 s.
- Every measurement response updates the meter in place from the `X-RateLimit-*` headers, so no additional requests are required.
- **Clicking the meter** forces the proxy path. When the local quota resets (`remaining` changes from 0 to a positive value), the preference is cleared automatically and a notification reports that the local quota is available again.

## How requests flow

```
Browser ── local quota left ────────► {GP_API_URL}/v1/measurements       (direct, anonymous ip limit)
       │                              {GP_API_URL}/v1/measurements/{id}   (public read, no cost)
       │
       └── local quota exhausted ──► /api/measurements ─► {GP_API_URL}/…   (server injects GP_TOKEN)
           (also used when >50 probes are requested, or when the direct API is unreachable)
```

- `GET /api/config` returns `{ apiUrl, proxyAvailable, maxProbes: { direct, proxy } }`, allowing the browser to determine where to call directly and how many probes it may request in each mode.
- `GET /api/limits`, `POST /api/measurements` and `GET /api/measurements/:id` proxy the upstream response transparently (same status code and JSON body) and pass through the rate-limit headers. `GP_TOKEN` is never sent to the browser.
- `GET /api/probes` is the only endpoint that talks to the upstream *without* the token: it fetches `GET /v1/probes` once and condenses the 5000+ entries into a de-duplicated index (countries / regions / cities / networks / tags, 92 KB JSON, `Cache-Control: public, max-age=300` plus an in-process 5-minute cache), which it serves to the browser for autocomplete. It does not consume Globalping quota. If the upstream is unreachable, a stale copy is served; if no copy exists, the endpoint answers `502` and the front end disables autocomplete without showing an error.
- Polling is throttled as required by the upstream: 500 ms after the previous response arrives, at most 2 requests/second per measurement.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GP_API_URL` | no | `https://api.globalping.io` | Upstream Globalping base URL (no `/v1`) |
| `GP_TOKEN` | no | — | Server-side Globalping access token. When empty the proxy is disabled entirely (`proxyAvailable: false`) and only the local meter is shown |
| `GP_TIMEOUT` | no | `30000` | Upstream request timeout in milliseconds |
| `OIDC_ISSUER` | no* | — | OpenID Provider issuer URL (e.g. `https://sso.example.com/realms/master`) |
| `OIDC_CLIENT_ID` | no* | — | OIDC client id |
| `OIDC_CLIENT_SECRET` | no* | — | OIDC client secret |
| `OIDC_REDIRECT_URI` | no* | — | Callback URI, must exactly match the IdP redirect URI, e.g. `https://your.domain/api/auth/callback` |
| `OIDC_SCOPE` | no | `openid profile email` | Requested scope |
| `OIDC_USERNAME_CLAIM` | no | `preferred_username` | Claim used as the user name (use `name`/`sub` for IdPs without it) |
| `OIDC_PROVIDER_NAME` | no | localized default | SSO provider name shown on the login dialog button |
| `OIDC_ACCOUNT_URL` | no | — | SSO account centre URL; when set, the user name in the top bar becomes a link to it (`http`/`https` only) |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | no | site root of `OIDC_REDIRECT_URI` | Where the IdP returns after "also sign out of SSO"; register it at the IdP |
| `SESSION_SECRET` | no* | — | ≥32 random chars used to sign the session cookie |
| `SESSION_COOKIE_NAME` | no | `pa_session` | Session cookie name |
| `SESSION_TTL` | no | `604800` | Session lifetime in seconds |
| `STATIC_DIR` | no | auto | Static directory (auto resolves: `dist/public` in prod, `public` in dev) |

\* Sign-in is disabled unless all OIDC fields **and** `SESSION_SECRET` are set — the sign-in button is then hidden, and with it the whole proxy path.

Other inherited server variables: `SERVER_HOST`, `SERVER_PORT` (default `80`; the Docker image sets `3001`), `LOG_LEVEL`, `PROJECT_NAME`, `SERVER_NAME`, `ENV_PRODUCT`.

## Quick start

```bash
pnpm install
pnpm build        # backend → dist/index.js (ESM) + frontend → dist/public/ (single build)
pnpm dev          # backend dev (nodemon + tsx, serves ./public) + frontend esbuild watch
```

Run:

```bash
GP_TOKEN='…' \
SESSION_SECRET='…' \
node dist/index.js
```

Open http://localhost:80 (or `SERVER_PORT`) once the service has started. No configuration is required to run measurements: the browser calls the public Globalping API directly, and `GP_TOKEN` enables only the signed-in fallback path.

## Testing

Jest (ESM + ts-jest) covers the backend framework utilities, the Globalping proxy controller, the OIDC service and every frontend module, plus end-to-end runs against a real `node:http` server.

```bash
pnpm test            # run the whole suite once (33 suites / 839 cases)
pnpm test:watch      # watch mode
pnpm test:coverage   # write coverage/ (html + lcov + text summary)
pnpm lint            # ESLint (includes the test files)
pnpm typecheck       # tsc --noEmit
```

Layout: `test/backend` (framework utils, router, venation, config, logger), `test/service` (OIDC), `test/frontend` (jsdom SPA modules), `test/integration` (controllers + real HTTP server), `test/helpers` and `test/setup` (shared fixtures and baseline env). No coverage thresholds are enforced; the suite currently reaches ~98.9% line and ~98.7% statement coverage.

## OIDC: Keycloak example

1. In Keycloak create a client:
   - **Access Type / Client authentication**: `confidential`
   - **Standard flow**: enabled (Authorization Code + PKCE S256)
   - **Valid redirect URIs**: `https://your.domain/api/auth/callback`
2. Export/set env vars: `OIDC_ISSUER` (realm URL), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, and a `SESSION_SECRET`.
3. Restart the service. The top-right corner then offers *Sign in*, leading to the Keycloak login; afterwards it shows the user name (`preferred_username`) and *Sign out*, and the second quota meter appears at the bottom-left.

For other IdPs (Authentik, Google, GitLab OIDC, …) adjust `OIDC_ISSUER` and, if needed, `OIDC_USERNAME_CLAIM`.

## API endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/config` | `{ apiUrl, proxyAvailable, maxProbes }` (public) |
| `GET` | `/api/auth/status` | `{ loggedIn, authEnabled, user }` |
| `GET` | `/api/auth/login` | 302 → IdP |
| `GET` | `/api/auth/callback` | OIDC callback → session cookie → `/` |
| `GET` | `/api/auth/logout` | clears session → `/` |
| `GET` | `/api/limits` | proxied `GET /v1/limits` of the server token (login + `GP_TOKEN` required) |
| `GET` | `/api/probes` | de-duplicated probe index for location autocomplete (public, no token, no quota) |
| `POST` | `/api/measurements` | proxied `POST /v1/measurements` (login + `GP_TOKEN` required) |
| `GET` | `/api/measurements/:id` | proxied `GET /v1/measurements/{id}` (login + `GP_TOKEN` required) |
| any other GET | `/` or static files | front-end pages and assets |

## Add a language

1. Create `public/locales/<code>.json` modeled on `zh-Hans.json`.
2. Register the language code in `SUPPORTED_LANGS` inside `src/frontend/i18n.ts`.

## PWA notes

The service worker maintains a versioned app-shell cache and prefers the network (`no-cache` for html/js/css) with a cache fallback. Increment `CACHE_VERSION` in `public/sw.js` whenever the app shell changes. PWA requires HTTPS or `localhost`.

## Docker

Published image: [`docker.io/yanranxiaoxi/pingatlas`](https://hub.docker.com/r/yanranxiaoxi/pingatlas) (`latest` follows the default branch).

```bash
docker run -d --name pingatlas \
  -p 3001:3001 \
  -e GP_TOKEN='…' \
  -e SESSION_SECRET='…' \
  docker.io/yanranxiaoxi/pingatlas:latest
```

To build locally instead, then run your own tag:

```bash
pnpm build
docker build -t pingatlas .
docker run -d --name pingatlas -p 3001:3001 \
  -e GP_TOKEN='…' \
  -e SESSION_SECRET='…' \
  pingatlas
```

The image is also available from the GitLab registry as `registry.gitlab.soraharu.com/xiaoxi/pingatlas:latest`. It runs `pnpm install --prod` and copies `dist/` (backend + `public/`).

## Limitations

- Sign-in is OIDC-only: there are no local accounts, and visitors cannot supply their own Globalping token.
- Measurements are not persisted; results exist only in the current page, without history, sharing links or dashboards.
- Sessions are stateless, so restarting the service invalidates them.
- The proxy does not store upstream response bodies; only the session user and upstream errors are logged.

See [PLAN.md](./PLAN.md) for the complete design notes.
