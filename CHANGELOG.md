# Changelog

All notable changes to MyApi (this fork) are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version line in `package.json` and `src/package.json` MUST match the
latest released tag here. The release pipeline at
[.github/workflows/release.yml](.github/workflows/release.yml) publishes the
matching multi-arch image to
[`ghcr.io/valerok/myapi-open`](https://github.com/ValeroK/MyApi-Open/pkgs/container/myapi-open)
on every `v*` tag push.

## [Unreleased]

Tracked in `.context/TASKS.md` (milestone `M-import` for the rolling
upstream-backport batch — ADR-0024).

## [0.6.0] — 2026-05-04

First public release of the hardened fork. Establishes the foundation that
every subsequent release builds on: governance via `.context/`, a binding
test-first gate, M0 through M5 closed, and the cardinal MVP property
(`scripts/agent-walkthrough.mjs` proves a `services:read` agent token reads
real Gmail through the gateway with no credential markers in the response)
verified end-to-end.

Image: `ghcr.io/valerok/myapi-open:v0.6.0` (linux/amd64 + linux/arm64).
Compose: `docker-compose.release.yml` (see `README.md` "Run the release").

### Versioning policy

Per [ADR-0023](.context/decisions/ADR-0023-release-versioning-and-publishing.md),
v0.6.0 is milestone-aligned (M0..M5 done = 6 milestones). v1.0.0 is reserved
for the SOC2 / M7-finish state. The rolling upstream-backport batch
(ADR-0024) targets v0.7.0.

### Foundation (M0 — `c99fded`)

- Bootstrap of `.context/` source-of-truth (plan, roadmap, TASKS, ADRs,
  capability-gap ledger, runbooks, session notes).
- Binding test-first discipline (`.cursor/rules/test-first.mdc`) and
  context-folder discipline (`.cursor/rules/context-folder.mdc`).
- Gitleaks scan baseline (T1.6, ADR-0011).

### M1 — Critical fixes (`94a85d9`..`c99fded`)

- Removed unauthenticated `/api/v1/turso/export-sql` (closed [C] in
  `plan.md` §6.3).
- Removed open SQL relay `POST /api/v1/turso/execute`.
- Removed hardcoded Google OAuth client/secret strings.

### M2 — Crypto consolidation (ADR-0013)

- Deleted orphan `src/utils/encryption.js` (the `crypto-js` no-IV path),
  `src/vault/vault.js`, `src/routes/api.js`, `src/routes/management.js`,
  `src/brain/brain.js`, `src/gateway/tokens.js`. `crypto-js` is removed
  from both `package.json` files; pinned non-resolvable by
  `src/tests/legacy-vault-inventory.test.js`.
- Added `deriveSubkey(root, purpose)` HKDF-SHA-256 in `src/lib/encryption.js`
  for domain-separated subkeys (`oauth:v1`, `session:v1`, `audit:v1`).
- Removed `default-vault-key-change-me` fallback in `src/database.js`
  (`fda13b8`); pinned by `src/tests/default-vault-key-removed.test.js`.
- Added `src/lib/validate-secrets.js` boot-time gate that rejects empty,
  whitespace, or banned values for `SESSION_SECRET`, `JWT_SECRET`,
  `ENCRYPTION_KEY`, `VAULT_KEY` in **every** `NODE_ENV` (T2.5,
  `380b9af`); pinned by `src/tests/validate-required-secrets.test.js`.
- Open-redirect regression in dashboard Login fixed
  (`src/lib/redirect-safety.js`, `4353932`).

### M3 — OAuth state hardening (ADRs 0006 / 0014 / 0016)

- Moved all OAuth state off `req.session` into two DB tables:
  `oauth_state_tokens` (authorize ↔ callback handshake, random PKCE
  verifier) and `oauth_pending_logins` (callback ↔ confirm-gesture
  accept/reject). Pre-M3 helpers (`createStateToken` / `validateStateToken`
  / `cleanupExpiredStateTokens`) are deleted; reintroducing them fails
  `src/tests/oauth-state-inventory.test.js`.
- Added `src/domain/oauth/state.js`, `pending-confirm.js`,
  `prune-scheduler.js`, `identity-links.js`.
- First-seen confirm-gesture screen and `oauth_tokens.first_confirmed_at`
  pinning (M3 / ADR-0016).
- Background prune scheduler is env-configurable
  (`OAUTH_PRUNE_INTERVAL_MS`, `OAUTH_PRUNE_GRACE_SEC`).
- Comprehensive §5.4 regression matrix in
  `src/tests/security-regression.test.js`.

### M4 — Pluggable session + rate-limit infra (ADR-0002 / 0019)

- New `SessionStore` interface with `memory` and `sqlite` drivers
  (`src/infra/session/`). `src/index.js` now wires sessions via
  `createSessionStore({ env, db })` (T4.1 + T4.2 + T4.4).
- New `RateLimitStore` interface with `memory` and `sqlite` drivers
  (T4.5). `src/index.js` no longer owns bespoke `Map`s + `setInterval`
  GC for rate limits (T4.6).
- Env-driven `TRUSTED_PROXIES` via `src/lib/trust-proxy.js` (T4.8 — closes
  H5 from `plan.md` §6.3).
- Stage-0 + M4 cleanup pre-stage gates G0.1..G0.6 + G4.1..G4.3 — 8
  snapshot tests pinning the API surface, boot side-effects, error
  envelope, middleware chain, rate-limit contract, security headers,
  session cookie/persistence, and trust-proxy contract.

### F4 — OAuth identity-vs-service scope separation (ADR-0018)

- Login/signup grants and per-service connect grants no longer
  cross-contaminate.
- 22-test behavioural suite
  (`src/tests/oauth-identity-service-separation.test.js`) + 7 static
  tripwires in `src/tests/security-regression.test.js`.

### F5 — Password-auth parity + reset/change

- F5.1 P1a/b/c: ported 2FA, audit, rate-limit, session-cap onto live
  password routes; deleted shadow handlers; closed logout-audit gap.
- F5.2 P1: password reset (`/auth/password/reset/{request,confirm}`,
  2h TTL).
- F5.2 P2+P3: change-password endpoint + dashboard UI surface.
- F5.3: auth UX hardening + canonical SPA cache policy + dev-plan
  bypass for tests.
- TOTP verify window widened ±60s → ±120s; `TOTP_CODE_TTL_MS` raised
  90s → 270s (real-incident driver: Android NTP drift on enrolment;
  `8bbe282`, ADR-0022 totp-window-tolerance). Pinned by
  `src/tests/totp-window-tolerance.test.js`.
- 2FA challenge per-IP rate-limit cap raised 3/min → 10/min, source-pinned
  in `src/tests/2fa-rate-limit-cap.test.js`.

### F3 — OAuth UX (ADRs 0017 / 0021 / 0022 oauth-connected-account-display)

- F3 Pass 1: dropped `max_age=0` on Google login to stop forcing
  re-consent every time.
- F3 Pass 2: safe-by-default prompt + `invalid_grant` recovery +
  `REAUTH_REQUIRED` surface.
- F3 Pass 3: connect-mode now pins `prompt=consent` for Google so refresh
  tokens actually land.
- F3 Pass 4: persist + display the connected provider account on each
  service grant (`oauth_tokens.connected_email`, COALESCE-on-update so
  refresh paths can't wipe it).

### F6 — Agent capability verification (closes GAP-002, GAP-010, files GAP-012)

- L1: 8 in-process supertest suites (`google-mount-auth-posture`,
  `agent-discovery-contract`, `services-proxy-behavioral`,
  `services-execute-behavioral`, `ask-endpoint-behavioral`,
  `handshake-flow-behavioral`, `connectors-master-only`,
  `agent-capabilities-end-to-end`).
- L2: 5 live-smoke suites (`oauth-authorize-url-live-smoke`,
  `services-proxy-google-live-smoke`, `services-proxy-github-live-smoke`,
  `agent-discovery-live-smoke`, `skills-and-handshakes-live-smoke`,
  `agent-google-gmail-week-fetch-live-smoke`) — skip silently when
  `SMOKE_URL` etc. unset.
- L3: `scripts/agent-walkthrough.mjs` end-to-end walkthrough — drives the
  shipped binary as an external agent. Latest: **21 OK / 0 FAIL** (Phase
  0 sanity, Phase 3 discovery, Phase 4 scoped Gmail proxy, Phase 5
  master-only writes denied to agent, Phase 6 SSRF probe matrix 5/5
  rejected — `127.0.0.1`, `169.254.169.254` AWS-metadata canary,
  `localhost`, `0177.0.0.1` octal, `2130706433` decimal-encoded
  loopback —, Phase 7 handshake/no-token-leak, Phase 8 skills shape).
- Connector spike landed (ADR-0020 Option C):
  `src/lib/schemas/connector-spec.js`.

### Real-incident fixes

- Per-user master-token lookup; dropped legacy `'owner'` fallback
  (`1ddacea`).
- Audit-log status badge now derives green/red/amber/info from
  `statusCode` or action name (`5018d29`).
- Full IANA timezone list via `Intl.supportedValuesOf('timeZone')`
  (`5018d29`).
- Dashboard onboarding modal: server-side dismiss endpoint
  `POST /api/v1/auth/onboarding/dismiss` so dismissals persist
  (`60d4088`).
- Notifications: correct timestamp + mark-all-as-read (`30a1a9b`).
- Master-token-owner FK seed for device-approval (ADR-0015,
  `23baf7f`).
- Dashboard never serves a stale SPA shell after rebuild (`1f17a5e`).

### Test gate

Today: **71 / 77 suites passing, 898 / 946 tests passed, 28 / 28
snapshots, exit 0** in ~70 s with `--detectOpenHandles --forceExit`.
Six suites skip silently (the L2 live-smoke set; activate by setting
`SMOKE_URL` etc.).

### Known limitations of v0.6.0

- M5 cleanup-pre-stage cleanup work is in progress (G0.1..G0.6 + G4.1..G4.3
  in place; the actual cleanup pass not yet landed).
- M6 monolith extraction not started — `src/index.js` is still ~11.4k LOC.
- M7 TypeScript conversion not started — 739 `tsc` errors under strict
  `checkJs` (report-only per ADR-0012).
- Lint baseline 243 problems (112 errors / 131 warnings) — report-only
  ratchet per ADR-0012.
- Image is unsigned (cosign deferred — see ADR-0023 §5).
- No SBOM yet (deferred to v0.7.0+).

### Required environment variables

Per `validate-secrets.js`, the process exits 1 in any `NODE_ENV` if any
of these is missing, whitespace, or set to a banned value (`change-me`,
`changeme`, `secret`, `password`, `default-vault-key-change-me`, or any
verbatim placeholder from `src/.env.example`):

- `SESSION_SECRET`
- `JWT_SECRET`
- `ENCRYPTION_KEY`
- `VAULT_KEY`

Generate each with `openssl rand -hex 32`.

[Unreleased]: https://github.com/ValeroK/MyApi-Open/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/ValeroK/MyApi-Open/releases/tag/v0.6.0
