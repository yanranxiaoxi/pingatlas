# PingAtlas — Design Notes

Implementation plan and design record for the PingAtlas online network-testing service.

## Goal

A web service that runs Globalping measurements from a browser-selected set of probes and renders the results **without a map**: a probe list plus the full per-probe detail.

| # | Requirement | Decision |
| --- | --- | --- |
| 1 | Test features comparable to globalping.io | All 5 measurement types + the full option set of each |
| 2 | Window design similar to `lg.nxtrace.org` | Two-column layout (form panel + result panel), same meter styling cues |
| 3 | No map (Mainland China map-approval number) | Only the probe list and the result details are rendered |
| 4 | Commands go from the browser to globalping.io using the visitor's anonymous 250/h quota, shown bottom-left | Duplicated by the `ip` quota meter and by every measurement response's `X-RateLimit-*` headers |
| 5 | Reuse the `node-server-falsework` framework, the `LibreTranslate-FrontPage` OIDC flow, no front-end framework, PWA | Framework copied verbatim wherever possible; hand-written TypeScript SPA; `manifest.webmanifest` + service worker |
| 6 | After sign-in the server-side token may be used as a fallback; both quotas shown bottom-left | Backend `/api/*` proxy with token injection, no quota accounting |

## Framework boundary

Files are copied from `node-server-falsework`. The goal is to keep the framework byte-identical
so future framework updates can be merged in; application behaviour lives in new files instead.

### Copied verbatim (safe to re-sync from the framework)

```
config/esbuild.common.ts     config/esbuild.dev.ts     config/tsconfig.json
tsconfig.json                pnpm-workspace.yaml       .vscode/settings.json
src/controller/controller.ts           src/controller/main.controller.ts
src/entry/index.ts                     src/exceptions/basic.exception.ts
src/main/main.ts                       src/middleware/api.middleware.ts
src/middleware/parameter.middleware.ts src/middleware/trace.middleware.ts
src/utils/interface.ts                 src/utils/logger.ts
src/utils/router.ts                    src/utils/utils.ts
src/utils/venation/driver.ts           src/utils/venation/index.ts
src/utils/venation/transport.ts
```

### Adapted from the framework (re-diff before re-syncing)

| File | Change |
| --- | --- |
| `package.json` | Project name/version, dev script runs the front-end watcher too, extra deps (`openid-client`, `jose`, Jest tool-chain), extra scripts (`test`, `test:watch`, `test:coverage`) |
| `src/config/config.ts` | Globalping / OIDC / session configuration instead of the framework demo values |
| `src/router/index.ts` | `/api/*` routes plus the front-end static catch-all (the framework's `/test` router was dropped) |
| `config/esbuild.prod.ts` | Adds the browser bundle (content-hashed entry) and the `public/` → `dist/public/` copy |
| `.env.example` | Project-specific variables |
| `README.md`, `README.zh-Hans.md`, `PLAN.md` | Project documentation |
| `eslint.config.mjs` | Ignores `coverage/**` and relaxes `node/prefer-global/*` inside `test/**` |
| `pnpm-workspace.yaml` | `allowBuilds` explicitly set for `@parcel/watcher` / `unrs-resolver` (optional native accelerators of Jest; skipping the build falls back to pure JS) |

`config/esbuild.common.ts` is shared unchanged with `LibreTranslate-FrontPage` (both projects export
runtime dependencies as ESM externals); it differs from the framework's own copy, which targets a
different build mode.

### Application code (new; the framework is untouched here)

```
src/service/oidc.ts                        src/utils/{cookie,session,respond,request,mime}.ts
src/middleware/session.middleware.ts       src/controller/{auth,frontend}.controller.ts
src/controller/globalping.controller.ts     # the only new business backend
src/utils/probe-index.ts                    # probe-index builder shared by backend & tests
src/frontend/{main,api,auth,quota,measure,results,i18n,theme,ui,types}.ts
src/frontend/location-suggest.ts            # location autocomplete combobox
public/{index.html,sw.js,manifest.webmanifest,favicon.svg,css/style.css,locales/*.json}
test/{backend,frontend,integration,service,helpers,setup}/   jest.config.mjs   tsconfig.test.json
```

Removed framework demo files: `src/controller/test.controller.ts`, `src/router/test.ts`.

## Architecture

```mermaid
flowchart LR
	subgraph browser["Browser"]
		ui["index.html + src/frontend/*.ts"]
	end
	subgraph server["PingAtlas server (framework + controllers)"]
		cfg["GET /api/config"]
		auth["/api/auth/* OIDC"]
		proxy["/api/limits, /api/measurements/* (injects GP_TOKEN)"]
		static["static files + SPA fallback"]
	end
	gp["api.globalping.io"]

	ui -->|"direct (own 250/h ip quota)"| gp
	ui -->|"fallback (signed in)"| proxy
	ui --> cfg
	ui --> auth
	proxy --> gp
	static --> ui
```

## Globalping API contract (verified against the live API and the OpenAPI spec)

- Base `https://api.globalping.io`
- `GET /v1/limits` — **does not consume quota**, safe to poll every 5 minutes
- `POST /v1/measurements` — `202` + `Location`; anonymous `limit <= 50`, authenticated `limit <= 500`
- `GET /v1/measurements/{id}` — publicly readable, does not consume create-quota
- `GET /v1/probes` — probe catalogue
- CORS is fully open and `X-RateLimit-*`, `X-Request-Cost`, `X-Credits-*`, `Retry-After` are exposed → the browser can call the API directly
- `inProgressUpdates: true` only streams the first 5 results in real time
- Polling is throttled: wait 500 ms after the previous response, at most 2 requests/second per measurement
- `limit` semantics: top level = shared across locations (default 1); inside a location object = per-location. The two are mutually exclusive
- `locations` may be a previous measurement id to reuse its probe set
- `timeout` is 5–30 s; the client adds a 15 s grace period
- Error body: `{ error: { type, message, params? }, links? }`

## Quota strategy

State model:

- `localQuota` — `{ status, limit, remaining, reset, type: 'ip' }`, read from the direct API
- `proxyQuota` — `type: 'user'`, may carry `credits.remaining`, read through `/api/limits`
- `modePreference` — `'auto' | 'proxy'`, persisted in `localStorage` key `pa-quota-preference`

Routing decision, evaluated per measurement:

1. direct API unreachable → proxy (or report "no quota channel available")
2. `localQuota.remaining <= 0` → proxy
3. `probeCount > 50` and the proxy is available → proxy
4. `modePreference === 'proxy'` → proxy
5. otherwise → direct

Refresh policy:

| Trigger | Behaviour |
| --- | --- |
| Start-up / sign-in state change | immediate `GET /v1/limits` |
| Heartbeat | every 5 minutes |
| `remaining === 0` | re-check precisely at `reset + 2 s` |
| Tab returns to foreground | re-check if the last check is older than 30 s |
| Any measurement response | update in place from `X-RateLimit-*` |

Reset detection relies on `remaining` going from 0 to a positive value (not on the clock), and
resets `modePreference` to `'auto'` with a toast. The meter is a `<button>`, so the visitor can
force the proxy path at any time; the automatic switch-back overrides that preference.

A persisted `'proxy'` preference is only carried over when the local quota is exhausted: after a
page load the first local-quota result decides — with quota left the preference returns to `'auto'`
(silently, since this happens on every refresh), and only an exhausted quota keeps `'proxy'`. An
explicit `setPreference()` call during the session outranks that load-time default.

Probe-count limits: `ANONYMOUS_MAX_PROBES = 50`, `AUTHENTICATED_MAX_PROBES = 500`,
`UI_DEFAULT_PROBES = 3`; the preset list is `1, 3, 5, 10, 25, 50, 100, 500`.

## Backend API

All `/api/*` responses are raw JSON (no framework `{ success, code, result }` envelope) so upstream
error bodies and status codes can be passed through unchanged.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/config` | public | `{ apiUrl, proxyAvailable, maxProbes }` |
| `GET` | `/api/auth/status` | public | `{ loggedIn, authEnabled, user }` |
| `GET` | `/api/auth/login` | public | 302 → IdP |
| `GET` | `/api/auth/callback` | public | code exchange → session cookie → `/` |
| `GET` | `/api/auth/logout` | public | clear session, optional IdP end-session redirect |
| `GET` | `/api/limits` | login + `GP_TOKEN` | proxied `GET /v1/limits` |
| `GET` | `/api/probes` | public | de-duplicated probe index for location autocomplete (no token, no quota) |
| `GET` | `/api/probe-list` | public | per-probe list for the "Probes list" tab, built from the same upstream fetch as `/api/probes` |
| `POST` | `/api/measurements` | login + `GP_TOKEN` | proxied `POST /v1/measurements` |
| `GET` | `/api/measurements/:id` | login + `GP_TOKEN` | proxied `GET /v1/measurements/{id}` |

`GP_TOKEN` is never sent to the browser. Upstream errors are mapped to `502 { error: { type: 'upstream_error' } }`
so the front end can render them with the same code path as native API errors.

`GET /api/probes` is the one upstream call that carries no token: it fetches `GET /v1/probes` once and
folds the 5000+ entries (2.1 MB) into a de-duplicated index that `src/utils/probe-index.ts` builds —
roughly 121 countries / 21 regions / 1047 cities / 1464 networks / 1285 tags in ~92 KB of JSON.
A module-level cache serves it for 5 minutes (`PROBE_INDEX_TTL`) and the response is sent with
`Cache-Control: public, max-age=300` plus an `X-Probe-Index: hit|miss` marker. A stale copy is served
when the upstream call fails; with no copy at all the endpoint answers `502` and the front end
silently disables suggestions.

The same upstream response also feeds `buildProbeList()`, which keeps **every** probe as a compact
`[city, country, continent, region, asn, network, tags]` tuple (~500 KB, gzip ~70 KB) instead of
aggregating it. `/api/probe-list` serves that array from the shared cache, so opening both the
autocomplete and the probe list only hits the upstream once. The browser keeps it in memory only
(never `localStorage`) and fetches it lazily — see the probe list tab below.

## Front-end structure

- Plain static markup in `public/index.html`, translated in place by `applyI18n()` using
  `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria-label`
- `src/frontend/*.ts` compiled into a single bundle by esbuild (`main-<hash>.js` in production,
  `main.js` in watch mode); `public/index.html` and `public/sw.js` record the hashed name
- i18n dictionaries at `public/locales/{en,zh-Hans}.json`, resolved at runtime, with `en` as the
  fallback; switching language reloads the page
- Theme follows `prefers-color-scheme` and can be overridden; the choice is persisted
- The top-right user area (language switcher, user chip, sign-in / sign-out buttons) and the
  sign-in / sign-out modals follow one shared visual spec. Their rules live in the `.topbar-actions`
  / `.modal-dialog` scoped blocks of `public/css/style.css`, which keeps the form and result areas
  on this project's own `.btn` / `.select` styling. Keep the two areas in sync when either changes
- Service worker caches the app shell network-first and skips `/api/` and cross-origin requests
- `src/frontend/location-suggest.ts` turns each location input into an ARIA combobox. The probe index
  is loaded lazily on first focus, then cached in memory → `localStorage` (`pa-probe-index`, 24 h TTL,
  background refresh after the TTL, discarded after 3 days) → the network. Scoring is
  exact > prefix > substring > subsequence (`Fuzho` → `Fuzhou`); whitespace splits the query into
  AND-ed tokens, probe count breaks ties, and personal `u-*` tags take a 500-point penalty. The panel
  is appended to `document.body` with `position: fixed` so it overlays the panels around it and can
  be placed with viewport coordinates, re-positions on scroll/resize, and flips above the input when
  the space below is
  under `MIN_PANEL_HEIGHT`. `mousedown` is cancelled on options so selection does not blur the input,
  and `Enter` is consumed while an option is highlighted so it never submits the form
- Result tables live in `.table-wrap`; below 620px the header row is hidden visually (still exposed
  to assistive tech) and each row becomes a flex card driven by `data-label` pseudo-element labels.
  Hostnames wrap, numeric columns stay single-line, and the four MTR stat columns share one row —
  the page never scrolls horizontally. Touch targets are enlarged below 620px and on any coarse
  pointer device
- The result panel is a three-tab view (`src/frontend/panel.ts` + `src/frontend/probe-list.ts`):
  **Probes list** / **Matched probes** / **Results**. Only visibility and ARIA state change on
  switch, so rendered content and scroll position survive. The default is *Results* — that keeps the
  pre-tab behaviour and avoids pulling 500 KB on every page load. Tabs auto-switch on:
  starting a measurement → *Results*; editing a structured location field → *Probes list*;
  editing magic → *Matched probes* (the natural counterpart, since magic is what that list is
  derived from)
- The two probe lists differ only in filtering scope, which is what keeps the "+ then + again"
  workflow usable:
  - **Probes list** applies the *structured* filters only (continent / country / city / ASN /
    network / tags) and ignores magic — otherwise every "+" would shrink the candidate set down to
    the probe just picked. Columns are location / ASN / network / tags / action; region and
    continent are folded into the location cell's `title` because an extra column squeezed network
    names into mid-word breaks
  - **Matched probes** applies the *full* filter — exactly what will be sent upstream, because it
    goes through the same `readLocationFilters()` as `buildLocation()` (structured fields win over
    magic when any is set). Each row's `×` removes the magic token that identifies that probe
  - Both are capped at `PROBE_LIST_LIMIT = 160` rows (the upstream total can be 5000+) with a
    "showing N of M" line both above and below the table — the top one scrolls out of view long
    before the end of a 160-row list, so the bottom copy saves a scroll back up. The lower bound is
    stated only when the list is actually truncated (`shown < total`, so exactly 160 hits reads as a
    plain "160 matching probes"). The bottom copy is `aria-hidden` (repeating the same sentence in
    one region is just noise for screen readers; the top copy already carries it) and is omitted
    when nothing matched, where the top line and the empty table header are already on screen
    together. `+`/`×` only touch the magic textarea and then re-render
- The page has exactly **one** scrollbar. No in-page block sets `max-height` + `overflow-y`, so the
  form panel, the probe lists and each result card all take their natural height and the document
  scrolls as a whole. This is deliberate: stacked scrollbars (page + probe list inside it) make
  scrolling unpredictable. Consequences worth keeping in mind:
  - `.form-panel` is *not* sticky. Sticky is incompatible with "no internal scrolling" — a panel
    taller than the viewport would be pinned at `top: 72px` with its lower half unreachable, which
    is exactly what the old `max-height: calc(100dvh - 96px); overflow-y: auto` worked around
  - `.raw-text` (the raw-output block) keeps `overflow-x: auto` for long lines but has no height
    cap, so an opened raw output expands in place. Only `overflow-x` is declared, so a vertical
    scrollbar appears only if the height were capped — it never is
  - The autocomplete `.suggest-panel` is the one exception, and only because it is `position: fixed`
    rather than in the document flow: without a cap its 5000 candidates would extend past the
    viewport. It is an overlay, not part of the page layout
  - `.panel-tabs` deliberately declares **no** `overflow`. Writing `overflow-x: auto` (to scroll the
    tabs horizontally) would also set `overflow-y` to `auto` — per spec, a non-`visible` axis forces
    the other axis to `auto` — and since `.panel-tab`'s `margin-bottom: -1px` (which lets the active
    underline cover the container border) makes the content 1px taller than the box, that 1px
    rendered as a stray vertical scrollbar. The three labels are short, so the bar uses
    `flex-wrap: wrap` instead and never needs to scroll
- Magic fragments are built as `City+Country+AS<asn>[+datacenter-network][+eyeball-network]`
  (`probeFragment`), the shape Globalping's magic accepts and the one verified against the live API.
  Matching (`probes.ts`) mirrors Globalping: comma separates **OR** conditions, `+` separates **AND**
  fragments within a condition, bare or `AS`-prefixed digits compare the ASN exactly,
  `eyeball(-network)` / `datacenter(-network)` test tags, and everything else is a case-insensitive
  "field contains fragment" test over country / city / region / continent / network / tags.
  The tags *array* filter is AND — verified empirically: asking for `datacenter-network` together
  with `eyeball-network` returns `no_probes_found`
- The magic field is a `<textarea rows="2">` with `resize: vertical`, so long fragment lists can be
  dragged taller instead of scrolling horizontally in a one-line input. Newlines are not valid magic
  separators, so `normalizeMagic()` folds them (and stray duplicate separators) into `, ` both when
  reading the form and when writing it back

## Testing

- Jest 30 (ESM + ts-jest, `node --experimental-vm-modules`) with `test/**` as the only root;
  `jest.config.mjs` maps `../../package.json` to a TypeScript shim (JSON named exports do not work
  under ESM) and `test/setup/env.ts` pins a baseline environment before every suite
- `test/backend` — framework glue: router, venation driver/transport, config, logger, cookie,
  session, request/respond/mime helpers; `test/service` — OIDC; `test/frontend` — jsdom suites for
  every SPA module plus two stylesheet-level suites: `responsive.test.ts` parses
  `public/css/style.css` and asserts the narrow-screen table rules stay in place, and
  `quota-note.test.ts` pins the quota-meter note layout (direct-child flex items with a horizontal
  gap rather than pseudo-element punctuation) and the short mode labels, while
  `footer-credit.test.ts` renders the footer attribution from the real locale files and pins the
  three outbound links; `test/integration` — controllers plus an end-to-end run against a real
  `node:http` server started from `createServer()`
- `test/backend/probe-index.test.ts` covers the index builder (de-duplication, count aggregation,
  ordering, malformed input) and `test/frontend/location-suggest.test.ts` covers autocomplete end to
  end: scoring tiers, subsequence matching, diacritic/case folding, index caching & TTL behaviour,
  panel positioning/flipping and every keyboard interaction. jsdom has no global `Response`, so the
  suite injects a minimal stand-in, and `ui` is mocked with deterministic English country names
  because the real `countryName()` depends on the host locale
- 37 suites / 951 cases, ~98.3% lines. Remaining uncovered branches are defensive guards that no
  code path can reach (e.g. `compact()`'s empty-object skip, `buildMeasurementOptions()`'s
  type-guarded `default`, `pollMeasurement()`'s second token check) or need real navigation
  (`window.location.href` assignments, which jsdom cannot perform)
- `test/frontend/*` files must keep `/** @jest-environment jsdom */` as the very first lines:
  ESLint's import sorting will move a type-only import above the docblock, and Jest then silently
  falls back to the `node` environment

## Build & deploy

- `pnpm build` → `dist/index.js` (backend, ESM) + `dist/public/` (front end incl. hashed assets)
- `Dockerfile` — `node:24-alpine`, `pnpm install --prod`, copies `dist/`, exposes `3001`
- `.gitlab-ci.yml` — typecheck, lint, test, build, then build & push the image on the default branch only

## Scope & non-goals

- OIDC sign-in only; no local accounts, no per-user Globalping token input
- No server-side quota accounting or measurement persistence
- No map, no measurement history, no share links
- Sessions are stateless and signed with `SESSION_SECRET`; a restart invalidates them
