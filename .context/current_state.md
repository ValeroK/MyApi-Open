# Current state — MyApi

> **Purpose.** 5-minute snapshot of where the project is today. Skim this before
> starting any session. Longer context lives in [`plan.md`](plan.md). Tactical
> tracker is [`TASKS.md`](TASKS.md).
>
> - Last updated: **2026-04-30** (Tactical fix: TOTP verify window widened from `window: 2` (±60 s) → `window: 4` (±120 s) at every verify call site in `src/index.js` and `src/routes/auth.js`; `TOTP_CODE_TTL_MS` raised 90 s → 270 s in `src/lib/authHardening.js` to cover the wider validity span. Real-incident driver: `mailer.kv@gmail.com` enrolment failed against a freshly-wiped DB and freshly-scanned QR; live `verifyDelta` against the running container proved the user's phone was running exactly +120 s ahead of server (Android NTP drift), outside the old ±60 s window. New source-pin test `src/tests/totp-window-tolerance.test.js` (6 tests: 3 behavioural ±90 s / +150 s assertions on `/auth/login` totpCode + 3 source-pins on every verify block + the replay TTL constant). Test baseline 66 / 71 / 870 → **67 / 72 / 876** (+1 suite, +6 tests, no regressions, 28/28 snapshots stable, exit 0, 61 s on Windows). Decision recorded in ADR-0022. Earlier 2026-04-29: 2FA challenge per-IP rate-limit cap raised from 3/min → 10/min in `src/index.js` (`twoFactorRateLimit`). Original BUG-15 cap of 3/min locked legitimate users out after a single double-submit + one mistyped TOTP code; 10/min keeps brute-force protection intact (≈14 days for 50% probability against the 1M-code TOTP space, and the 30s code rotation is the binding control anyway) while giving real users headroom for honest typos. Source-pinned to band [10, 30] in `src/tests/2fa-rate-limit-cap.test.js` (4 tests). G4.1 + G0.3 snapshots regenerated for the +7-line comment-block drift (content-stable, line-only). Test baseline 64 / 69 / 855 → **66 / 71 / 870** (+1 suite, +4 tests; 5 skipped suites unchanged, 28 / 28 snapshots stable, exit 0). 2026-04-28: F6 — Agent capability verification — ✅ Complete. All 8 tasks (F6.0–F6.7) landed in one session: gap-ledger bootstrap, 8 L1 supertest suites, L3 walkthrough script, 4 L2 live-smoke suites, connector spike (ADR-0020 Option C — `src/lib/schemas/connector-spec.js` + handler wiring), gap-ledger triage with follow-up briefs F8 / F9 / F10. Closed GAP-002 P0 in the same change as the test that surfaced it. Test baseline 55 / 56 / 767 → **64 / 69 / 855** (+9 suites, +88 tests, 5 L2 suites correctly skip when env unset, 28 / 28 snapshots stable, exit 0). Earlier 2026-04-27: M4-T4.8 landed — `app.set('trust proxy', 1)` replaced with `app.set('trust proxy', parseTrustedProxies(process.env.TRUSTED_PROXIES))`; closes H5 from plan.md §6.3.)
> - Maintainer: repo owners + AI pairing sessions
> - Status: **pre-production.** Not yet deployed to real users; clean-rewrite
>   latitude granted per ADR-0007.

---

## 1. What MyApi is

A self-hosted personal API + AI-agent gateway that aggregates 40+ OAuth
providers and vault credentials behind one authenticated surface, issues scoped
tokens to agents with device approval, and produces a complete audit trail.

**Primary non-functional requirement:** key-custody integrity. Everything else
is subordinate.

## 1a. Quality baseline (2026-04-21)

| Gate | Today | Blocking? | Notes |
|------|-------|-----------|-------|
| `npm test` | **67 / 72 suites, 876 pass / 42 skip, 28 / 28 snapshots, exit 0** (~61 s locally with `--forceExit` on Windows; 2026-04-30: TOTP verify window widened ±60 s → ±120 s at every verify call site (`src/index.js` 4 sites + `src/routes/auth.js` 1 site) + `TOTP_CODE_TTL_MS` 90 s → 270 s in `src/lib/authHardening.js`; new source-pin suite `src/tests/totp-window-tolerance.test.js` (+1 suite / +6 tests). Decision in ADR-0022. Pre-fix baseline was 66 / 71 / 870. Earlier 2026-04-29: 2FA challenge cap raised 3 → 10/min/IP, source-pinned in new `src/tests/2fa-rate-limit-cap.test.js` (+1 suite / +4 tests); G4.1 + G0.3 snapshots regenerated for content-stable +7-line comment drift; pre-fix baseline was 64 / 69 / 855. Earlier 2026-04-28: **F6 ✅ Complete** — added 8 new behavioral L1 suites (+88 tests across L1) plus 4 L2 live-smoke suites that skip silently when `SMOKE_URL` etc. are unset (5 skipped suites total: 4 F6 + the existing `oauth-authorize-url-live-smoke`); F6 connector spike added 7 more tests + 1 schema module (`src/lib/schemas/connector-spec.js`); G0.3 snapshot regenerated twice in same change set for legitimate line-number drift (GAP-002 fix + connector validator wiring); L1 suites included: `google-mount-auth-posture` (closes GAP-002 P0; regenerates G0.1 / G0.2 / G0.3 snapshots in same change), `agent-discovery-contract`, `services-proxy-behavioral` (surfaces GAP-008 + GAP-009; static SSRF resilience gate), `services-execute-behavioral` (surfaces GAP-010), `ask-endpoint-behavioral`, `handshake-flow-behavioral` (surfaces GAP-011; pins GAP-005), `connectors-master-only`, `agent-capabilities-end-to-end`. Pre-F6.1 baseline was 55 / 56 / 767. Earlier 2026-04-27: M4-T4.8 G4.3 expanded from 6 → 41 tests, G0.2 / G0.3 / G4.1 snapshots updated for `trust proxy: 1 → ['loopback']` + 7-line drift; pre-stage gate G4.3 originally added 6 tests + 1 snapshot earlier the same day, M4-T4.6 deleted 2 legacy snapshots + added 1 new + added 1 negative-assertion test on 2026-04-27, +23 tests from M4-T4.5 RateLimitStore contract suite, +20 tests from M4-T4.1 + T4.2 SessionStore contract suite, +15 tests from the M4 pre-stage gates G4.1–G4.2, +30 tests from the Stage-0 cleanup gates G0.1–G0.6 — see ADR-0019; F4 added the `oauth-identity-service-separation` suite [22 tests] + 7 static tripwires in `security-regression`) | **Hard gate** | Do not merge anything that reduces this count. |
| `npm audit --audit-level=high` | clean (ADR-0008) | **Hard gate** | Per ADR-0008, blocks at HIGH+. |
| `npm run lint:backend` | 243 problems (112 errors / 131 warnings) | Report-only (ADR-0012) | Ratchet-only: don't grow on files you touched. |
| `npm run typecheck` | 739 `error TS*` under strict `checkJs` | Report-only (ADR-0012) | Drops as legacy JS converts to TS (M7). |

Test-first workflow is binding — see `.cursor/rules/test-first.mdc` and
ADR-0012.

## 2. Stack snapshot

| Layer | Today |
|-------|-------|
| Backend | Node.js ≥ 20 (targeting 22), Express 5, `better-sqlite3` / PostgreSQL |
| Frontend | React 19, Vite 7, Tailwind 3, Zustand 5, react-router 7, @tanstack/react-query 5, DOMPurify 3 |
| Tests | Jest 30 + supertest 7, 19 backend test files, 50% coverage floor |
| CI | `.github/workflows/ci.yml` — frontend lint, Node 20+22 tests, `npm audit` (non-blocking), Docker build |
| Deploy | `docker-compose.{dev,prod}.yml` + nginx + Let's Encrypt, PM2 ecosystem file |
| Observability | Sentry, correlation-ID middleware, `src/lib/alerting.js`. **No** Pino, metrics, tracing, SBOM, secret scanning. |

## 3. Architecture today

- **Monolithic gateway** in `src/index.js` (~11.4k LOC) with 30 route modules
  mounted under `/api/v1/*`.
- **Two co-existing crypto modules**: `src/lib/encryption.js` (AES-256-GCM — correct)
  and `src/utils/encryption.js` (`crypto-js` without IV — broken). The broken
  one is still used by `src/vault/vault.js`.
- **Two SSRF filters**: `src/lib/ssrf-prevention.js` (robust, underused) and
  an inline `isPrivateHost` regex (used by the actual proxy endpoint).
- **Sessions + rate-limits** are in-process `Map`s by default.
- **MongoDB** support (`src/database-mongodb.js`) is still a branch but
  deprecated — scheduled for deletion (ADR-0001).

Target architecture is documented in `plan.md` §3.2.

## 4. Known critical risks (from `plan.md` §6.3)

Every item here must be closed before we onboard real users.

| Ref | Risk | Tracked in |
|-----|------|------------|
| [C] Unauthenticated DB export at `GET /api/v1/turso/export-sql` | Leaks every row in every table. | `TASKS.md` M1 |
| [C] Open SQL relay at `POST /api/v1/turso/execute` | SSRF + credential-laundering hop. | `TASKS.md` M1 |
| [C] Weak `crypto-js` path in `src/vault/vault.js` | Vault ciphertext is not IND-CPA secure. | `TASKS.md` M2 |
| [C] `default-vault-key-change-me` fallback in `src/database.js` | Secret validation only runs in `NODE_ENV=production`. | `TASKS.md` M2 |
| [C] Hardcoded Google OAuth client/secret strings (`REMOVED_…`) | Past secret exposure; rotate + remove. | `TASKS.md` M1 |
| [C] OAuth state not DB-validated + Discord bot-install state bypass | CSRF on every OAuth link flow. | `TASKS.md` M3 |
| [C] Proxy endpoint uses weak `isPrivateHost` regex | SSRF via URL obfuscation. | `TASKS.md` M5 |

High/Medium/Low risks are enumerated in `plan.md` §6.3.

## 5. What changed recently

- **2026-05-02** — **Settings UX fixes:** Audit Logs tab rendered every row
  as `unknown` because the frontend read `log.status` but the backend
  (`/api/v1/audit/logs` in `src/routes/auditSecurity.js`) returns
  `statusCode`, and for inline lifecycle events (`oauth_authorize_start`,
  `oauth_status_persisted`, `oauth_callback_success`, `oauth_disconnect`,
  `db_integrity_warning`, …) `createAuditLog` in `src/database.js`
  persists `status_code = null` because no HTTP response is involved.
  `Settings.jsx` now owns a `deriveAuditBadge(log)` helper that renders
  HTTP-coded events as green `success (2xx/3xx)` / red `failed (4xx/5xx)`,
  falls back to `log.status`, and for status-less events infers the tone
  from the action name (`*_success/completed/connected/…` → green,
  `*_error/failed/denied/revoked/…` → red, `*_warning/suspicious/…` →
  amber, everything else → neutral `info`). Timezone dropdowns on Profile
  (Settings.jsx) and Identity used a hardcoded ~17-zone list; both pages
  now import a shared `src/public/dashboard-app/src/utils/timezones.js`
  which calls `Intl.supportedValuesOf('timeZone')` (full IANA list, ~400
  zones) with a curated ~50-zone fallback for older runtimes. Frontend
  `npm run build` green; backend suite unchanged at **70 / 75 passed**.
- **2026-04-30** — **Dashboard onboarding modal:** `users.needs_onboarding`
  was never cleared after signup; `App.jsx` also called `restartOnboarding()`
  on every load, wiping local dismiss keys. Added `POST /api/v1/auth/onboarding/dismiss`
  (same auth resolution as `/auth/me`, `clearUserOnboarding` in DB), wired
  `OnboardingModal` skip/close/finish to call it and patch `needsOnboarding` in
  the auth store; stopped calling `restartOnboarding()` on automatic open
  (still used from Settings). Tests: `src/tests/auth-onboarding-dismiss.test.js`
  (+2); snapshots updated for new route + `RATE_LIMIT_EXEMPT_PATHS` line shift.
  Full gate: **70 / 75 suites passed** (5 skipped), **894 passed**, exit 0.
  **Follow-up:** `Dashboard.jsx` checklist auto-complete now calls the same
  dismiss endpoint when `needsOnboarding` is still true (plan optional), and
  only clears local checklist state after a successful POST.
- **2026-04-30 (latest)** — **F3 Pass 4 (ADR-0022): persist + display
  the connected provider account on each service grant.** Same review
  cycle as Pass 3, separate concern: the dashboard had no way to show
  which provider account holds a service grant when the user picks a
  different account on Google's account picker than the one they're
  logged in with. `oauth_tokens` gains one column `connected_email`,
  `storeOAuthToken` goes 7-arg → 8-arg (8th = `connectedEmail`,
  COALESCE-on-update so refresh paths don't wipe), connect-mode
  callback in `src/index.js` captures email from the `verifyToken`
  response or the id_token `email` claim (Google prefers signed
  source), `/api/v1/oauth/status` exposes `connectedEmail` per
  service, and `ServiceConnectors.jsx` renders "Connected as
  alice@work.gmail.com" beneath each connected card. Multi-account
  independence is locked: a behavioural test asserts that an existing
  `user_identity_links` row for the LOGIN account (e.g. sub=11111,
  email=alice@personal) is NOT mutated when the connect callback
  writes a SERVICE row with a different account (sub=99999,
  email=alice@work). Test coverage: 2 new behavioural suites
  (`oauth-connect-account-display.test.js`, 5 tests;
  `oauth-connect-no-email-graceful.test.js`, 4 tests) + 3 new static
  tripwires + 1 flipped tripwire (oauth-state-inventory 7-arg → 8-arg).
  Targeted bundle: 220 → **232 passing** (+12), same 16 skipped,
  exit 0. Full non-cleanup-pre-stage suite: 60 of 60 active suites
  passing, 805 tests.
- **2026-04-30** — **F3 Pass 3 (ADR-0021): connect-mode for
  Google now forces `prompt=consent` in the authorize URL.** Bug
  reproducer: dashboard "Connect Google" with `mailer.kv@gmail.com`
  (existing identity-only grant) silently re-issued an access_token
  *without* a refresh_token because (a) the F3 Pass 2 adapter default
  is `select_account`, (b) the `explicitForcePrompt=false` branch in
  `src/index.js` NULLs the prompt for `forcePrompt=0`, (c) F4
  added `include_granted_scopes=true` for connect-mode. Combined,
  the URL went out with no `prompt=`, no consent screen rendered,
  and Google's policy ("refresh_token only on consent shown") meant
  the row landed with `refresh_token IS NULL` → ~1h fuse to
  `REAUTH_REQUIRED` → every reconnect re-produced the same broken
  row. **Fix:** `src/index.js` authorize handler now appends
  `runtimeAuthParams.prompt = 'consent'` for
  `mode === 'connect' && service === 'google'`, after the
  explicitForcePrompt nullification block (so it wins regardless of
  `forcePrompt`). Adapter default stays `select_account` — policy
  at the call site, preserving the ADR-0017 boundary. Login/signup
  modes are untouched, so the F3 Pass 1 + Pass 2 login UX win is
  preserved end-to-end. Test coverage: +3 behavioural tests in
  `src/tests/oauth-security-hardening.test.js` (HTTP authorize URL
  emits `prompt=consent` regardless of `forcePrompt`, plus a
  cross-cutting "complete connect-mode contract" test asserting the
  four properties — prompt + access_type + include_granted_scopes +
  full service scope set — together), +1 static tripwire in
  `src/tests/security-regression.test.js`, +1 flip in
  `src/tests/oauth-authorize-url-live-smoke.test.js`. 13 OAuth-
  related suites green post-fix: **220 passing, 8 skipped**.
  Behavioural baseline for the targeted bundle (3 suites:
  `oauth-security-hardening` + `security-regression` +
  `oauth-identity-service-separation`): 82 → **85 passing** (+3),
  same 8 skipped, exit 0. ADR-0021 supersedes the connect-mode arm
  of ADR-0017 (login/signup arm of ADR-0017 stands).
- **2026-04-30** — **TOTP verify window widened from
  `window: 2` (±60 s) → `window: 4` (±120 s) at every verify call
  site, and replay-tracker TTL raised 90 s → 270 s.** Real-incident
  driver, second day in a row of `mailer.kv@gmail.com` 2FA
  enrolment failures: after the 2026-04-29 ops fix didn't stick,
  the operator wiped `data/myapi.db` clean (5 files: `myapi.db`,
  `-wal`, `-shm`, `sessions.sqlite`, `.db_integrity`), restarted
  the container, re-signed up via Google, scanned a fresh QR, and
  still hit `Invalid 2FA code` on every verify attempt. Live
  instrumentation against the running container (read in-process
  via a second `better-sqlite3` connection inside the container so
  WAL writes from the live app process are visible — host-side
  reads get masked by the container's open WAL on Windows Docker
  bind mounts) proved the failure was not a server bug:
  `speakeasy.totp.verifyDelta({ secret, encoding: 'base32',
  token: '910278', window: 10 })` returned `{ delta: +4 }` — the
  user's phone TOTP step was exactly +120 s ahead of server. The
  previous `window: 2` only accepts ±60 s, so every honest code
  was rejected at the verifier despite QR generation,
  secret storage, container clock, session auth, and account
  routing all being verified correct under direct probe. Operator
  judgement call: bump tolerance to `window: 4` rather than make
  the user run "Time correction for codes" (which they had already
  done — the drift re-acquired the same +120 s, consistent with
  cheap Android NTP). **Code changes:** 4 sites in `src/index.js`
  (`/auth/2fa/verify`, `/auth/2fa/disable`, `/auth/2fa/challenge`,
  `/admin/security/rotate-key`) + 1 site in `src/routes/auth.js`
  (`POST /auth/login` 2FA gate) flipped from `window: 2` → `window:
  4`; `TOTP_CODE_TTL_MS` in `src/lib/authHardening.js` raised
  `90_000` → `270_000` because the verifier's validity span at
  `window: 4` is 240 s and the replay-tracker TTL must cover it
  (with a 30 s buffer for clock skew between the verify call and
  the replay-mark write); the inline comment block updated to
  point at the new source-pin test. **Decision rationale + brute-
  force math + revisit trigger** are recorded in
  `.context/decisions/ADR-0022-totp-window-tolerance.md`. **Test-
  first discipline:** new `src/tests/totp-window-tolerance.test.js`
  (6 tests, written red-first against the pre-fix tree — 5 fail /
  1 pass — then flipped green by the bumps): three behavioural
  assertions against `POST /api/v1/auth/login` with `totpCode`
  generated at `±90 s` (accepted) and `+150 s` (rejected); two
  source-pins that fail the build if any future edit silently
  re-tightens the window in either `src/index.js` or
  `src/routes/auth.js`; one source-pin on `TOTP_CODE_TTL_MS >=
  240_000` so the replay-tracker TTL can never silently drop
  below the verifier's validity span. **No `.context/`
  follow-up required** beyond this entry + the ADR — F11 (the
  master-only `POST /api/v1/admin/users/:id/2fa/reset` endpoint)
  remains the right next step for the operator-side recovery
  story; this fix closes the *enrolment-side* failure mode but
  not the *post-enrolment-loss* failure mode. Test baseline:
  66 / 71 / 870 → **67 / 72 / 876** (+1 suite, +6 tests, no
  regressions, 28 / 28 snapshots stable, exit 0, 61 s on Windows
  with `--forceExit`).
- **2026-04-29** — **2FA challenge per-IP rate-limit cap
  raised from 3/min → 10/min** (`twoFactorRateLimit` in
  `src/index.js:2195-2204`). Direct follow-up to today's earlier
  ops-fix entry below (`mailer.kv@gmail.com` failing
  `/auth/2fa/challenge` six times in a row before the operator
  manually nulled their TOTP secret): part of the reason that
  user got stuck was BUG-15's 3-attempts-per-minute-per-IP cap,
  which kicked in after a single dashboard double-submit + two
  fat-fingered TOTP codes and bounced every subsequent attempt
  with a generic `429 Rate limit exceeded` for the rest of the
  60s window. 3/min was hostile to legitimate users. Brute-force
  math against the 6-digit TOTP space (1M codes, speakeasy
  `window: 2` ≈ 5 codes per submission) tolerates 10/min with
  no meaningful security loss — at 10/min it still takes ~14
  days to hit 50% probability against the keyspace, and the
  binding control is the 30s code rotation + per-user replay
  guard in `src/lib/authHardening.js`, not the per-minute cap.
  Test-first discipline: new `src/tests/2fa-rate-limit-cap.test.js`
  (4 tests, written red-first against the `3` literal — 1 fail
  / 3 pass — then flipped green by the bump) source-pins the
  production cap to the band **[10, 30]** so a future edit can
  neither silently re-introduce the UX bug (cap < 10) nor
  silently weaken the brute-force ratchet (cap > 30) without
  breaking the gate. Also pins the `'2fa-attempts'` namespace
  (so the limiter can't quietly collapse into the broader
  `authRateLimit` bucket) and the `app.post('/api/v1/auth/2fa/-
  challenge', twoFactorRateLimit, …)` wiring (so the route
  can't be silently un-throttled). The inline comment block
  grew 1 line → 8 lines explaining the trade-off + linking the
  new test, which caused content-stable +7-line drift in two
  pre-stage gate snapshots (`cleanup-pre-stage-rate-limit-
  contract.test.js` G4.1 + `cleanup-pre-stage-boot-side-
  effects-inventory.test.js` G0.3 — the latter twice for the
  timer-registration line list and the orphan-timer ratchet);
  all three regenerated in the same change per ADR-0019. **No
  ADR opened** — this is a security-control tuning fix, not a
  new architectural decision, and the design rationale lives
  in the suite header + the source comment. **No code change
  outside `src/index.js:2195-2204`.** Test baseline: 64 / 69 /
  855 → **66 / 71 / 870** (+1 suite, +4 tests; 5 skipped suites
  unchanged, 28 / 28 snapshots stable, exit 0). Does NOT close
  F11 — that brief still tracks the master-only "Reset 2FA"
  endpoint + the defensive `409 ALREADY_ENROLLED` guard on
  `/auth/2fa/setup`, both of which remain unaddressed.
- **2026-04-29** — **Ops fix: reset 2FA for `mailer.kv@gmail.com`
  + filed F11 backlog brief.** User was failing
  `/auth/2fa/challenge` six times in a row today (last successful
  challenge was 2026-04-28T08:24Z). Diagnosis: not a code
  regression — F5.1 (2026-04-25) is the only commit that reworked
  2FA and it only touched the password-login path; the OAuth-side
  challenge handler at `src/index.js:7445` (which is where the user
  actually lives, since they sign in via Google) has been
  byte-stable through F6. Most likely root cause: phone-side
  authenticator entry drift — the audit log shows two
  `2fa_setup_started` rows ~45 s apart on 2026-04-25, and
  `/auth/2fa/setup` (`src/index.js:7314`) silently overwrites
  `users.totp_secret` on every call, so a user who scans QR #1 and
  then accidentally re-loads setup ends up with QR #2 in the DB.
  Operator fix: direct SQL update of the user row
  (`two_factor_enabled = 0, totp_secret = NULL`). **Second-step
  finding:** prompt was still showing post-reset because two stale
  rows in `data/sessions.sqlite` carried a frozen
  `pending_2fa_user.twoFactorEnabled: true` snapshot from the
  OAuth callback's session stash (`src/index.js:8708`). DB write
  alone does not clear that — `/auth/2fa/challenge` rechecks the
  live DB and returns `400 "2FA is not enabled for this account"`,
  but the SPA keeps showing the prompt. Cleared the stale rows.
  **Third-step finding (the real root cause):** even after the
  host DB write AND the session-clear, fresh OAuth callbacks
  continued to route through `pending_2fa`. Diagnosis: the
  running `myapi-smoke` container holds `myapi.db-wal` and
  `myapi.db-shm` open inside the container, **invisible to the
  host's `ls`** (Windows Docker bind-mount semantics). The
  host-side `UPDATE` landed in the base file but was masked by
  the container's WAL-shadowed snapshot view, so `getUsers()`
  inside the container kept returning `twoFactorEnabled: true`.
  `docker restart myapi-smoke` checkpointed the WAL and reopened
  the base file; verified by tailing the container log — first
  post-restart OAuth callback at `2026-04-29T16:11:42Z` logged
  `routing=fast_path_returning` instead of `routing=pending_2fa`.
  **F11 brief updated** with two non-negotiable requirements
  derived from this incident: (a) the admin endpoint must scrub
  sessions in the same call, and (b) it must execute through
  the app's running DB connection (host-side / sidecar SQL is
  silently masked by the container's open WAL). User re-enrolls
  cleanly via Settings on next login. **No code change.** Filed
  `.context/tasks/backlog/F11-2fa-reset-mechanism.md` so the next
  occurrence does not require hand-editing SQLite — scope is a
  master-only `POST /api/v1/admin/users/:id/2fa/reset` endpoint, a
  dashboard "Reset 2FA" affordance for operators, plus a defensive
  `409 ALREADY_ENROLLED` guard on `/auth/2fa/setup` so a re-run
  cannot silently rotate the live secret. Global progress
  136 → 137; F11 row at 0/1.
- **2026-04-28** — **F6 ✅ Complete — Agent capability
  verification.** All 8 tasks (F6.0–F6.7) landed in one session,
  +88 passing tests, 5 new live-smoke suites (gated, silent in
  `npm test`), one new schema module + handler wiring in
  `src/index.js`, three follow-up briefs filed (F8 / F9 / F10).
  Net: every agent-facing capability now has a green test, and
  every known limitation has a `GAP-NNN` row pointing at a
  milestone. **Production-code changes:** GAP-002 one-liner
  (`authenticate` middleware on the `/api/v1/google` mount,
  `src/index.js`) + connector schema validator wiring
  (`src/index.js:6389-6411`, calls into the new
  `src/lib/schemas/connector-spec.js`). Both are tiny diffs
  guarded by static gates so future edits show up as deliberate
  changes. **What this proves about the gateway:** (a) the agent
  cannot reach Gmail without a token; (b) `/openapi.json` +
  `/api/v1/capabilities` + `/api/v1/tokens/me/capabilities` are
  faithful discovery surfaces — the agent can reason about its
  own scope without ever being shown a credential; (c) the
  proxy + execute + ask handlers gate auth → scope → validation
  → connection in that order, never reaching upstream without
  every gate green; (d) the SSRF posture by construction
  (proxy reads only `path/method/body/query` from `req.body`)
  is now a static ratchet; (e) the handshake bootstrap flow is
  end-to-end safe — public POST + public poll never carry the
  issued token, only `/handshakes/:id/approve` (master-only)
  surfaces it. **What this surfaces:** GAP-002 P0 (resolved),
  plus 4 new gaps GAP-008 through GAP-011, all triaged into M6 /
  M14 / new F8-F10 briefs. **Documentation:** `agent-real-life.md`
  runbook (markdown only, plan-mode) walks the same trajectory
  manually. `agent-walkthrough.mjs` script runs the runbook
  programmatically with a single bearer. Test baseline: 55 / 56
  / 767 → **64 / 69 / 855**, 28 / 28 snapshots stable. Earlier
  same-day session log:
  `.context/sessions/2026-04-28-f6-agent-verification.md` (this
  session's wrap-up).
- **2026-04-28** — **F6.1 landed: 8 L1 supertest
  behavioral suites for the agent-facing surface; closes GAP-002
  P0 in the same change; surfaces GAP-008..GAP-011 with
  disposition.** New suites under `src/tests/`:
  `google-mount-auth-posture` (5 tests; runtime + static gate
  forcing `authenticate` middleware on the `/api/v1/google` mount
  — pre-F6.1 the mount was naked, and `resolveUserId` falling
  back to `'owner'` meant Gmail data was reachable to any
  unauthenticated remote caller on a connected deployment),
  `agent-discovery-contract` (12 tests; pins `/openapi.json`
  public, `/api/v1/capabilities` narrowed by scope, `/api/v1/-
  tokens/me/capabilities` echoes scope without leaking the raw
  token, `/api/v1/gateway/context` master-only with
  vault-tokens-metadata-only — pins GAP-003's mismatch with
  `llms.txt`), `services-proxy-behavioral` (12 tests; pins the
  auth/scope/validation/connection gates AND a static
  SSRF-resilience gate on the `req.body` destructure — handler
  reads only `path/method/body/query`, refuses
  `baseUrl/host/apiRoot/origin/url` overrides; surfaces GAP-008
  scope-hierarchy not implemented + GAP-009 `validateScope` /
  `grantScopes` self-contradiction), `services-execute-behavioral`
  (9 tests; pins the `{method, params}` validation + 404 / 400
  / 403 envelopes; surfaces GAP-010 `seedServiceCategories();
  seedServices();` boot calls commented out — service catalog
  is empty on every clean boot), `ask-endpoint-behavioral`
  (8 tests; pins the LLM-availability 503 + the no-services-
  connected 400 BEFORE any OpenAI call — cardinal cost-control
  property), `handshake-flow-behavioral` (16 tests; covers the
  whole agent bootstrap flow public-POST → public-status-poll →
  master-approve → token-issued-out-of-band, asserts no token
  ever appears in the public poll envelope; surfaces GAP-011
  duplicate `/status` handler at `src/index.js:7847` — count
  pinned at exactly 2 with a static gate; pins GAP-005 `user_id
  = 'owner'` literal), `connectors-master-only` (8 tests; pins
  master-vs-scoped + round-trip + scoped-POST-does-not-persist
  defense in depth), `agent-capabilities-end-to-end` (11 tests;
  the composite walk — public discover → master mints scoped
  agent token via `POST /api/v1/tokens` → agent uses scoped
  token for `/capabilities` and `/tokens/me/capabilities` →
  agent reaches proxy connection gate cleanly → agent CANNOT
  reach `gateway/context` / `connectors` / `audit` /
  handshake-approve). **GAP-002 fix: `app.use('/api/v1/google',
  authenticate, createGoogleRoutes())`** with a comment block
  cross-referencing the gap and the test. Snapshot impact: 3
  G0.x snapshots regenerated in the same change (G0.1 API surface
  now pins `M(2)` middleware count for the Google mount; G0.2
  middleware-chain order shifts by 1 layer; G0.3 boot-side-
  effects line numbers drift +1) — diffs ARE the security-fix
  evidence per ADR-0019. **No production-code change other than
  the GAP-002 one-liner + comment block.** New `.context/
  capability-gaps.md` ledger went from 7 pre-seeded rows to 11
  rows: GAP-002 marked `resolved P0` with full audit trail; new
  rows GAP-008 (P1, scope hierarchy not implemented), GAP-009
  (P1, `validateScope` accepts narrow regex but `grantScopes`
  fails FK), GAP-010 (P1, service catalog seed is dead code at
  boot), GAP-011 (P2, duplicate `/status` handler at
  `src/index.js:7847` is unreachable). Test baseline: 55 / 56
  suites + 767 / 789 passing → **63 / 64 / 848 / 870**, 28 /
  28 snapshots stable, exit 0; full sweep ~64 s on Windows. F6
  global progress: 1 / 8 → 2 / 8. F6.2 (L3 walkthrough script),
  F6.3 / F6.4 / F6.5 (L2 live-smoke trio), F6.6 (connector
  schema spike per ADR-0020), F6.7 (gap-ledger triage)
  remaining.
- **2026-04-27** — **M4-T4.8 landed: `app.set('trust
  proxy', 1)` replaced with `app.set('trust proxy', parseTrusted-
  Proxies(process.env.TRUSTED_PROXIES))`; closes H5 from plan.md
  §6.3.** New `src/lib/trust-proxy.js` (0-dep regex-based) parses
  a comma-separated list of CIDRs / bare IPs / symbolic names
  (`loopback`, `linklocal`, `uniquelocal`); fails loud with a
  message echoing the bad entries when given garbage; defaults to
  `['loopback']` so X-Forwarded-For is only honored when the
  immediate connection is from `127.0.0.1` / `::1`. Two escape
  hatches: `none` / `false` → returns `false` (paranoid mode,
  trust nobody); empty/unset → secure default. Pre-T4.8 the
  literal `1` honored a single-hop XFF from any client, allowing
  any caller on the network to spoof `req.ip` and bypass the
  ~3 IP-keyed rate-limit sites + ~50 audit-log writes + ~5
  security-warning logs that depend on it. **G4.3 expanded from
  6 → 41 tests:** 28 unit cases for `parseTrustedProxies` (every
  documented input shape + every fail-loud case), 1 spot-check
  on `isValidEntry`, 2 axiom tests preserved (trust=1 honors XFF;
  trust=false ignores XFF — kept as regression anchors), 6 new
  integration probes calling Express's compiled `trust proxy fn`
  directly with various IPs (`127.0.0.1` ✓ trusted by default,
  `203.0.113.42` ✓ NOT trusted by default, `uniquelocal` does
  NOT auto-include loopback, etc.), 1 supertest e2e (default +
  loopback connection still honors XFF — by design, the fix
  closes spoofs from PUBLIC clients not from the host itself),
  3 negative ratchets flipped to positive (`TRUSTED_PROXIES` IS
  in src/index.js, `parseTrustedProxies` IS imported,
  `src/lib/trust-proxy.js` exists). Snapshot impact: G0.2 (G4.3
  pin) `'trust proxy': 1` → `['loopback']` (intentional content
  change), G0.3 timer inventory + G4.1 rate-limit source slices
  shifted +7 lines (matches the 7-line block I added: 1 require
  + 6-line comment justifying the change). `.env.smoke.example`
  and the gitignored `.env.smoke` both set `TRUSTED_PROXIES=
  loopback,uniquelocal` so curl-from-host through the docker
  bridge gets per-client `req.ip` resolution during e2e (the
  comment block in `.env.smoke.example` documents the production
  alternatives). E2e probe (echo server + 3 trust configs ran
  inside the container, scripts deleted post-verification)
  confirmed: default `['loopback']` blocks `req.ip` spoofs from
  any non-loopback source; `['loopback','uniquelocal']` adds
  the docker bridge to the trust set; the legacy literal `1`
  unconditionally honored XFF from any source — exactly H5.
  Live `/api/v1/auth/me` + `/ping` continue to respond 401 / 200.
  Test baseline: **55 / 55 suites, 767 / 789 passing / 22
  skipped, 28 / 28 snapshots, exit 0** in ~11 s. **Env / docs
  alignment** also folded in: `.env.example` and `src/.env.example`
  gained the 5 vars that had drifted into smoke without being
  documented (`SESSION_DB_PATH`, `TRUSTED_PROXIES`, `OAUTH_PRUNE_
  INTERVAL_MS`, `OAUTH_PRUNE_GRACE_SEC`, `LOG_LEVEL` formalized
  out of the "Advanced/commented" section), plus `SESSION_COOKIE_
  DOMAIN` which was referenced by code (`src/index.js:1226` +
  `src/routes/auth.js:112`) but never templated. README §
  Configuration → Optional table reformatted with explicit defaults
  and a new "Trust Proxy & Session DB notes" subsection covering
  the H5 risk-and-fix in user-facing language. README §
  Production / Self-Hosting nginx block now ends with the matching
  `TRUSTED_PROXIES=loopback` env directive. New end-of-README
  "Step-by-Step Setup Guide" section covers all four supported
  topologies (Local Dev / Docker Dev / Docker Smoke / Docker
  Production) with per-topology env-file recipes and verification
  curls. Folded into the same commit: `.cursor/rules/commit-
  message-hygiene.mdc`
  (`alwaysApply: true`) — forbidding any AI/Cursor/agent
  attribution in commit messages, PR titles, PR bodies, or
  squash-merge messages, captured per the owner's "put in
  memory" instruction. Next: pause on M4 follow-ups (T4.3 +
  T4.7 still blocked on OQ-11 Redis TLS; T4.9 is a different
  layer — FK migration on access_tokens.owner_id) and discuss
  whether to keep grinding M4 or shift to M5 (SSRF unification).

- **2026-04-27** — **M4-T4.6 landed: `src/index.js`
  fully behind both M4 store factories; bespoke rate-limit
  in-memory maps + hourly GC interval + drifted exempt-path
  lists all DELETED.** This is the M4 critical-path completion
  for OSS-only deployments — T4.3 (Redis), T4.7 (testcontainers
  Redis), T4.8 (CIDR trust-proxy), T4.9 (FK ADR-0015 Option B)
  remain as deferred / follow-up items but the gateway no longer
  carries any bespoke state for sessions or rate-limits. Concrete
  deletions: `const globalRateLimitMap`, `const rateLimitMap`,
  `const rateLimitCleanupInterval = setInterval(...)` (28 lines
  including its sweep body — the driver runs its own GC), the
  inline list of exempt paths in the global middleware, and the
  drifted `RATE_LIMIT_EXEMPT_PATHS = [...]` declaration that lived
  ~1100 lines below. Concrete additions: a single
  `RATE_LIMIT_EXEMPT_PATHS` + `isRateLimitExempt(req)` helper at
  the top of `src/index.js`, a module-level `let rateLimitStore =
  null` that's assigned in the M4 store-init block (after
  `createSessionStore`, sharing the same `sessionDb` handle),
  and store-backed rewrites of the global middleware and the
  per-namespace `rateLimit()` factory. **Orphan-timer count:
  6 → 5** (G0.3 ratchet acknowledged via snapshot update). HTTP
  envelopes preserved bit-for-bit at every call site — the three
  distinct shapes (bearer literal `retryAfter: 60`, IP-global
  `retryAfter: <calc>`, per-namespace `retryAfterSeconds: <calc>`)
  all pass through the new store with zero observable change.
  G4.1 test surgery: deleted 2 dead snapshots, added 2 new ones
  (`store-backed global limiter source` positive snapshot +
  `M4-T4.6 deletions: legacy in-memory rate-limit symbols are
  gone` negative-assertion ratchet using a `stripComments` helper
  so the explanatory comments that REFERENCE the deleted names
  don't trip the assertion). Net diff in `src/index.js`: **−4
  lines** (92 ins / 96 del) but the structural diff is much
  larger — see commit body. Snapshot count: 28 → 27 (−2 deleted,
  +1 new). Test baseline: **54 / 54 suites, 726 / 748 passing
  / 22 skipped, exit 0** in ~11 s. **Folded follow-on (same
  commit):** `/ping` route handler added — was a dead entry
  in the consolidated `RATE_LIMIT_EXEMPT_PATHS` list, surfaced
  during e2e (curl returned 404). Now `GET /ping → 200
  {"ok":true}`. Three downstream snapshots auto-shifted:
  G0.1 router shape (+1 entry), G0.1 mount table (+1 entry),
  G0.3 timer-inventory line drift (+8 lines, content stable),
  G0.4 middleware-chain index drift (`srcIdx 268→269`). Live
  e2e re-verification post-commit: 119/130 flood requests
  allowed → 11 throttled with `Retry-After: 6`, body
  `{ error: 'Rate limit exceeded', retryAfter: 6 }`, atomic
  UPSERT into `rate_limit_counters` confirmed at the SQLite
  layer (key=`global:<ip>`, count increments per consume).
  Three findings noted for follow-up: (a) `SESSION_DB_PATH`
  in `.env.smoke` overrides the `__dirname/db.sqlite` default
  to `/app/data/sessions.sqlite` — code-vs-runtime drift worth
  a comment; (b) `req.ip` resolves to the docker bridge
  gateway because `app.set('trust proxy', ...)` isn't pinned
  — already on the roadmap as **T4.8**; (c) `DELETE
  /api/v1/users/:id` and `DELETE /api/v1/account` both refuse
  if `email === POWER_USER_EMAIL` — structural deadlock for
  power-user-email duplicates, blocked the F5 migration
  recovery (resolved one-off via cascade-mirroring SQL — see
  M4 follow-up notes). Next: review the deferred M4 sub-tasks
  (T4.3 / T4.7 / T4.8 / T4.9) and decide which unblock vs
  which can roll into a later milestone — **T4.8 is the
  natural next step** because the e2e directly exposed why
  it matters.

- **2026-04-27** — **M4-T4.5 landed: `RateLimitStore`
  interface + memory + sqlite drivers under `src/infra/rate-limit/`
  + 23-test driver-agnostic contract suite.** No change to
  `src/index.js` yet (that's T4.6). The contract:
  `consume(key, max, windowMs)` returns
  `{ allowed, remaining, retryAfterSec, resetAt, limit }`; `reset(
  key)` clears the bucket; `close()` is idempotent and stops the
  GC timer. **Semantic switch: sliding-log → fixed-window.** The
  bespoke implementation in `src/index.js` uses sliding-log
  (timestamp arrays per key, count those within `windowMs`) which
  is precise but allocates per request and is O(req) on SQLite —
  orders of magnitude worse than fixed-window. We deliberately
  switch to fixed-window so the SQLite driver is O(1) per request
  via a single atomic `INSERT … ON CONFLICT DO UPDATE` per
  consume. Trade-off: a burst landing at the window boundary can
  allow up to 2× the limit in the worst case. G4.1 pins the 429
  envelope shape, NOT the burst-precision behavior, so this
  trade-off is in-contract. Both drivers expose `.unref()`'d GC
  timers + idempotent `.close()` — same orphan-timer discipline
  as M4-T4.2's `SqliteSessionStore`. SqliteRateLimitStore creates
  its own `rate_limit_counters` table on construction (`CREATE
  TABLE IF NOT EXISTS` — same pattern as
  `better-sqlite3-session-store`), so no migration file is
  required for T4.5; T4.6 will only need to swap the call sites
  in `src/index.js`. The factory's selection rule mirrors the
  session factory's exactly (test → memory; REDIS_URL → throw
  loud not-implemented; DATABASE_URL → memory; else → sqlite),
  so a deployment that picks SQLite for sessions automatically
  picks SQLite for rate-limits. Test baseline jumped from
  **703 → 726 passing / 22 skipped / 54 suites, exit 0** in ~11 s.
  Next: T4.6 (replace bespoke `rateLimit()` factory +
  `globalRateLimitMap` + `rateLimitMap` + `rateLimitCleanupInterval`
  + the two drifted exempt-path lists with calls into the new
  store).

- **2026-04-27** — **M4-T4.4 landed: `src/index.js`
  session wiring now goes through `createSessionStore({ env, db })`.**
  Pure refactor under the protection of every Stage-0 + G4.x gate.
  Net diff: +6 lines in `src/index.js` (24 ins / 18 del). The
  `BetterSqlite3StoreFactory` import and the inline `new
  BetterSqlite3StoreFactory(...)` are gone — replaced by a single
  factory call that returns `{ store, driver }`. The `app.use(
  session({ ... }))` block lost its conditional spread (`...(
  sessionStore ? { store: sessionStore } : {})`) since the factory
  always returns a Store; in test/legacy-Mongo modes that Store is
  the same `express-session.MemoryStore` express-session would
  have allocated by default, so runtime behavior is bit-for-bit
  identical. **Behavior preservation hatch:** `setAuthHardeningSession-
  Store(...)` is now invoked with the store only when `driver ===
  'sqlite'`, mirroring today's "test mode → null sessionStore in
  authHardening" semantics so concurrent-session-cap tests do not
  shift underneath us. Snapshot updates: 1 intentional in G4.2
  (the `app.use(session({...}))` source block); 5 line-number-only
  in G4.1 (globalRateLimitMap + expressRateLimit configs) and
  G0.3 (timer registrations + module-load timers + orphan timer
  ratchet) — every diff body byte-identical. Test baseline holds
  at **703 / 703 passing / 22 skipped / 53 suites, exit 0** in
  ~11 s. Next: T4.5 (`RateLimitStore` interface + memory + sqlite
  drivers).

- **2026-04-27** — **M4-T4.1 + T4.2 landed: `SessionStore`
  interface + memory + sqlite drivers + factory under `src/infra/session/`,
  with a 20-test driver-agnostic contract suite
  (`src/tests/cleanup-m4-session-store-contract.test.js`).** No
  change to `src/index.js` yet — that's T4.3, behind every Stage-0
  + G4.x gate. The factory's selection rule (NODE_ENV=test →
  memory; REDIS_URL set → throw "T4.6 not yet implemented" loud
  fail; DATABASE_URL set → memory parity with legacy Mongo path;
  default → sqlite) preserves today's behavior bit-for-bit so
  T4.3 will be a pure refactor. Real finding fixed in flight:
  `better-sqlite3-session-store@0.1.0` calls `setInterval(...)`
  in its constructor and discards the returned handle (see
  `node_modules/better-sqlite3-session-store/src/index.js:43`),
  meaning every Store instance leaks a timer for the process
  lifetime — exactly one of the four orphan timers G0.3 flagged.
  Our `SqliteSessionStore` wrapper neutralizes this by
  intercepting `global.setInterval` for the synchronous
  construction window, capturing the handle, calling `.unref()`,
  and exposing `.close()` on the returned store. The full Jest
  sweep (53 suites) now runs in **~11 s** (down from ~55 s) and
  the test process no longer prints any open-handle warnings
  for the new contract suite. Test baseline jumped from
  **683 → 703 passing / 22 skipped / 53 suites, exit 0**. Next:
  T4.3 (swap inline sessionStore wiring in `src/index.js` for
  `createSessionStore({ env, db })`).

- **2026-04-27** — **M4 pre-stage gates G4.1–G4.2 landed
  ahead of any source change to the session / rate-limit code
  (ADR-0019 §"Per-milestone follow-ups").** Two new test files
  (`src/tests/cleanup-pre-stage-rate-limit-contract.test.js` and
  `cleanup-pre-stage-session-cookie-and-persistence.test.js`)
  pin the M4 deletion target as a literal source snapshot
  (bespoke `rateLimit()` factory, `globalRateLimitMap`,
  `rateLimitMap`, `rateLimitCleanupInterval`,
  `RATE_LIMIT_EXEMPT_PATHS`, every `expressRateLimit({ ... })`
  configuration, `app.use(session({ ... }))` block, idle-timeout
  middleware) plus the OBSERVABLE contract that any compliant
  store driver must preserve (429 response envelope with
  `Retry-After` and `RateLimit-*` headers, session-cookie
  attributes from a real `Set-Cookie`, persistence of
  `req.session.user` mutations across requests, login-rotates-
  cookie regenerate semantics, destroy-invalidates-session
  semantics, middleware-order invariant). Real finding already
  surfaced: there are **TWO drifted exempt-path lists** —
  `RATE_LIMIT_EXEMPT_PATHS` (8 entries) and an inline
  `isExempt` block (different membership: includes `/health`,
  `/ping`, `GET /api/v1/privacy/cookies`; excludes
  `/api/v1/oauth/status`). M4 must consolidate. Test baseline:
  **668 → 683 passing / 22 skipped / 53 suites, exit 0**. Both
  gates are snapshot-stable across re-runs (CSP nonces and
  cookie values scrubbed/excluded). Next: start M4 task T4.1
  (`SessionStore` interface) under the protection of these
  gates plus the Stage-0 baseline.

- **2026-04-27** — **Cleanup Stage-0 baseline gates landed
  (ADR-0019).** Six new test files (`src/tests/cleanup-pre-stage-*`)
  pin the cross-cutting properties every upcoming cleanup milestone
  (M4 dual-driver session/rate-limit, M6 monolith extraction, M7
  TypeScript migration, M8 MongoDB/legacy/dead-code deletion, M9
  frontend & output hygiene) is at risk of silently regressing:
  the route-mounting graph (G0.1), top-level middleware chain +
  app-level settings (G0.2), every `setInterval`/`setTimeout`
  registration in `src/index.js` plus orphan-timer ratchet (G0.3),
  the password-auth lifecycle as a state machine — register → /me
  → change-password → logout → re-login → /me → logout on a
  single supertest agent (G0.4), the JSON error envelope at six
  representative status codes (G0.5), and the security-header
  policy per response family with CSP nonce scrubbed for snapshot
  stability (G0.6). Real findings already surfaced by writing the
  gates: unknown `/api/v1` paths return 401 (not 404) because a
  session-requiring middleware sits in front of the catch-all;
  the error envelope is inconsistent (most are `{error}` only,
  only `409 EMAIL_EXISTS` is `{error, code}` — M9 target); four
  orphan `setInterval` timers in `src/index.js` lack `.unref()`
  and lack captured handles, forcing every Jest run through
  `--forceExit` (M4/M6 target); `x-powered-by: Express` is still
  on every response (M9 helmet target). Test baseline jumped from
  **638 passing → 668 passing / 22 skipped / 51 suites, exit 0**.
  ADR-0019 records the rationale, the per-gate property pinned,
  and the snapshot-update procedure that downstream milestone
  commits MUST follow. Next: start M4 (dual-driver
  session/rate-limit) under the protection of these gates.

- **2026-04-25** — **F4 landed: OAuth identity role separated
  from service role across Google, GitHub, and Facebook.** Single atomic
  commit. Motivation: F3 Pass 1 + Pass 2 tried to eliminate Google's
  per-login consent screen by dropping `max_age=0` and flipping the
  adapter default to `prompt=select_account`, but both attempts still
  triggered consent because the *root cause* was scope conflation —
  every "Sign in with Google" call was requesting Gmail + Calendar +
  Drive, which Google rightfully treats as sensitive and re-prompts for.
  Same structural bug existed on GitHub (`repo gist` on every sign-in)
  and Facebook. F4 fixes this at the architectural layer by splitting
  each login-capable adapter into `IDENTITY_SCOPES` (baked into the
  adapter, NOT env-overridable — security primitive) and `SERVICE_SCOPES`
  (env-overridable via `GOOGLE_SCOPE` / `GITHUB_SCOPE` /
  `FACEBOOK_SERVICE_SCOPE`). The authorize handler threads a new
  `{ mode }` argument into `getAuthorizationUrl` so login/signup pick
  identity-only and connect picks identity + service. Alongside the
  scope split, F4 introduces a new `user_identity_links` table
  (`PRIMARY KEY (user_id, provider)` + `UNIQUE (provider,
  provider_subject)`) that owns identity state separately from
  `oauth_tokens`, plus a new `src/domain/oauth/identity-links.js`
  domain module. The login-mode callback branch in `src/index.js` no
  longer writes `oauth_tokens` — it writes the identity link instead
  (first-seen marker + returning-user fast path both migrated). Signup
  flow follows choice 3a (identity-only at signup; user explicitly
  connects services afterwards). Test baseline jumped to **539
  passing / 14 skipped / 38 suites, exit 0**. New coverage:
  `src/tests/oauth-identity-service-separation.test.js` (22 tests:
  adapter scope matrix across all three providers, identity-link
  invariants, login/service decoupling) plus 7 static tripwires in
  `security-regression.test.js`. Two pre-F4 assertions that locked in
  the old "login writes oauth_tokens" contract were rewritten to the
  new `user_identity_links` contract. Migration backfills existing
  rows with populated `(provider_subject, first_confirmed_at)` on
  `oauth_tokens` into `user_identity_links` so upgrade-in-place is a
  no-op for returning users. See ADR-0018, F4 task brief, and
  `.context/tasks/backlog/F5-password-auth-hardening-and-consolidation.md`
  (filed as a follow-up: the UI has no password inputs today and the
  backend has three duplicate password-auth route files that need
  consolidation). Next: M4 (scope + consent per ADR-0014 roadmap).

- **2026-04-24** — **M3 wrap-up commit landed — M3 is now
  ✅ Complete.** Atomic commit ships the four work items that were
  intentionally deferred out of T3.7–T3.9 so they could be batched behind
  one live-smoke run:
    - **Task A — `provider_subject` threading through every
      `storeOAuthToken` call site.** Signup-complete handler in
      `src/index.js` now forwards `pending.providerUserId` (already
      stashed on `req.session.oauth_signup` by the callback's
      signup-required redirect — no upstream plumbing needed) and also
      calls `recordFirstConfirmation(...)` so signup carries **implicit
      consent** and the very next login-mode callback short-circuits
      past the confirm-gesture screen. Connect-mode + non-primary-
      login-mode branches in the callback handler also pass
      `providerUserId` (same `verifyToken()`-derived value the login-mode
      branch was already using). Net effect: no more
      `oauth_tokens.provider_subject = NULL` rows after a fresh signup
      or a connect-mode link. Closes the `COALESCE`-fallback window
      flagged in ADR-0016 §Follow-ups.
    - **Task B — legacy state-token exports retired.** Deleted the
      now-unused `createStateToken` / `validateStateToken` /
      `cleanupExpiredStateTokens` functions **and their exports** from
      `src/database.js`. Verified zero live callers remain (the T3.4+T3.5
      handler refactor dropped the authorize/callback sites; T3.9's
      prune scheduler took over `cleanupExpiredStateTokens`'s tick; the
      test-suite destructures of the legacy names were never
      executed). Everything OAuth-state now goes through
      `src/domain/oauth/state.js` (authorize, callback) and
      `src/domain/oauth/prune-scheduler.js` (tick), with zero
      hand-rolled SQL outside those two modules.
    - **Task C — docs rebaseline.** `SECURITY.md` / `README.md` /
      `CLAUDE.md` / `.env.smoke.example` updated to describe the M3
      reality: DB-backed single-use state rows, random 32-byte PKCE
      verifier stored in-row, no Discord carve-out, first-seen confirm
      gesture with `provider_subject` keying, `OAUTH_PRUNE_INTERVAL_MS`
      + `OAUTH_PRUNE_GRACE_SEC` env knobs for the scheduler. Stale
      references to `buildPkcePairFromState` / `req.session.oauthStateMeta`
      / the Discord bypass are gone.
    - **Task D — live Google OAuth smoke.** Ran a real round-trip
      through `docker:smoke` against a live GCP project. Five phases
      all passed their M3-relevant assertions:
        1. **Token auto-refresh** — aged the token's `expires_at` into
           the past; proxy call succeeded and refreshed the row. (First
           attempt false-negatived because `TOKEN_CACHE_TTL=5min` served
           a stale-but-not-expired cache entry; container restart
           flushed the cache and the retry correctly exercised the
           refresh path. The cache TTL is a separate concern, not M3.)
        2. **Prune scheduler** — aged every `oauth_state_tokens` row
           into the past; invoked `runPruneOnce({ db })`; all aged rows
           deleted; empty ticks silent at INFO as designed.
        3. **Real proxy (Gmail + Calendar + Drive)** — Gmail proxy
           round-trip succeeded end-to-end (scope granted, call made,
           token refresh verified). Calendar + Drive calls returned
           `403 PERMISSION_DENIED` from Google because those APIs were
           not enabled in the operator's GCP project — **MyApi proxied
           correctly, Google refused; not a MyApi defect** and not in
           M3 scope.
        4. **SSRF guards** — proxy calls with targets pointing at
           `127.0.0.1`, `169.254.169.254`, `localhost:4500`,
           `0177.0.0.1`, `2130706433` all rejected at the
           `isPrivateHost` guard before the outbound request fired.
           (Full SSRF unification is M5; M3's defence-in-depth still
           holds under live conditions.)
        5. **Returning-user login skips the gesture** — a second
           login-mode authorize → callback cycle for a user with
           stamped `first_confirmed_at` 302'd directly to
           `/dashboard/`; no `oauth_status=confirm_login`, no
           `oauth_pending_logins` row created. Confirms the ADR-0016
           first-seen key does what it says — one gesture ever, not
           one per login.
    - **Task E — `TASKS.md` + this file flipped.** M3 header in
      `TASKS.md` now reads ✅ Complete (2026-04-24); this file's §6
      updates the "Active focus" to M3-complete / next-up = `F3`.
  **Non-M3 follow-ups surfaced during the live smoke** (filed as task
  briefs in `.context/tasks/backlog/`, to be picked up after the wrap-up
  push):
    - **`F1` — SPA post-OAuth routing race.** After the confirm-gesture
      click, `App.jsx`'s `redirectToLoginOnce()` fires before the
      auth-store has hydrated, bouncing the user to `/` instead of
      `/dashboard/`. Pure UX defect; backend session was always fine.
      Filed as
      `.context/tasks/backlog/F1-spa-post-oauth-routing-race.md`.
      Bundles with M9.
    - **`F2` — onboarding wizard is half-wired.** The frontend `vite
      build` initially failed with `"dismissModal" is not exported by
      onboardingUtils.js` — the module only exported one of the eight
      helpers `App.jsx` / `Settings.jsx` / `Dashboard.jsx` /
      `OnboardingModal.jsx` import. Stubbed the other seven as
      localStorage-backed no-ops that keep onboarding inert (shipped in
      the separate `fix(dashboard):` commit that preceded the M3
      wrap-up). Product-level "ship it vs. retire it" decision filed
      as
      `.context/tasks/backlog/F2-onboarding-wizard-completion.md`.
      Bundles with M9.
    - **`F3` — Google consent screen shown on every login.**
      `src/public/dashboard-app/src/pages/LogIn.jsx` hard-codes
      `forcePrompt=1` on login-mode authorize URLs, which the server
      translates to Google's `prompt=consent`. Intentional
      belt-and-suspenders defense from the original signup hardening;
      redundant now that DB-backed state + first-seen confirm gesture
      are live. User-hostile. Filed as
      `.context/tasks/backlog/F3-oauth-consent-prompt-once-per-grant.md`.
      **Queued as the next work session per operator direction on
      2026-04-24.**
  **Full Docker regression after the wrap-up:** **35 suites / 490 pass
  / 14 skip / 0 fail** (+5 tests vs the T3.9 baseline of 485: signup-
  mode E2E in `security-regression.test.js` plus the `storeOAuthToken`
  arity static gate + the three legacy-export-absence gates in
  `oauth-state-inventory.test.js`, all written red-first). **M3
  header in `TASKS.md` is now ✅ Complete (2026-04-24).** C3 + C6 are
  closed end-to-end; H1 remains closed. Session log:
  `.context/sessions/2026-04-24-m3-smoke.md`.

- **2026-04-24** — **M3 Step 8 / T3.9 landed: OAuth
  prune scheduler (state + pending-confirm, env-configurable).**
  Closes M3 at the implementation level; only the M3 wrap-up
  commit (docs + legacy-export retirement + one live Google
  smoke) remains. New module `src/domain/oauth/prune-scheduler.js`
  is a thin composition layer over the two pure primitives shipped
  earlier (`pruneExpiredStateTokens` T3.2, `pruneExpiredPendingConfirms`
  T3.7). **Surface:**
    - `runPruneOnce({ db, now?, graceSec?, logger? })`
      → `{ prunedState, prunedPending, elapsedMs }`. Synchronous,
      NEVER throws — independent try/catch around each prune so a
      failure in one doesn't skip the other; both swallow-and-log
      via `logger.error`. Ticks with non-zero prunes emit ONE
      structured `logger.info('pruned expired OAuth rows',
      { pruned_state, pruned_pending, elapsed_ms })` line;
      empty ticks are silent at INFO so healthy steady state
      never spams the log.
    - `startPruneScheduler({ db, intervalMs?, graceSec?, logger?,
      timers? })` → `stop()`. Registers via `timers.setInterval`,
      calls `handle.unref()` when available so an idle scheduler
      never blocks `process.exit()`. Injected `timers` seam lets
      the suite test interval wiring without real time passing.
    - `DEFAULTS = Object.freeze({ intervalMs: 600_000, graceSec:
      3600 })`. One source of truth shared by tests and the
      bootstrap.
  **`src/index.js` bootstrap wiring.** New block near the other
  `setInterval` sites reads `OAUTH_PRUNE_INTERVAL_MS` (integer
  ≥ 1000) and `OAUTH_PRUNE_GRACE_SEC` (integer ≥ 0) from env
  and calls `startOAuthPruneScheduler({ db, intervalMs,
  graceSec })`. The legacy `cleanupExpiredStateTokens()`
  invocation from the old BUG-11 hourly tick (naive
  `DELETE … WHERE expires_at < now`, no grace window, no
  pending-confirm awareness) is **removed**; its companion
  `cleanupOldRateLimits(24)` is kept on its own tick. The
  `cleanupExpiredStateTokens` import is dropped from the
  `./database` destructure; the primitive is left on disk in
  `src/database.js` for now so any stray caller keeps resolving
  (retirement tracked for M3 wrap-up). **Red-first suite**
  `src/tests/oauth-prune-scheduler.test.js` (10 assertions) filed
  at 10/10 FAIL (MODULE_NOT_FOUND) → 10/10 green after impl,
  covering module surface, DEFAULTS shape + frozenness, empty-DB
  silence, state-side happy path + structured log payload,
  pending-confirm-side happy path, `graceSec` override (zero-grace
  prunes where default-grace keeps), fault isolation (one prune
  throws → scheduler returns the other's count, logs error,
  does not throw), interval wiring via injected timers,
  DEFAULTS fallback, and `.unref()` behaviour. **Full Docker
  regression green:** **35 suites / 485 pass / 14 skip / 0
  fail** (+1 suite / +10 tests vs T3.8 baseline of 34 / 475 /
  14 / 0). **M3 is now 10/10 at the implementation level
  (T3.0–T3.9 complete).** Remaining: the M3 wrap-up commit
  (`CLAUDE.md` + `SECURITY.md` + `README.md` updates, legacy
  state-token export retirement, signup/connect-mode
  `provider_subject` threading, one live Google smoke).

- **2026-04-24** — **M3 Step 7 / T3.8 landed: §5.4 OAuth
  regression matrix in `security-regression.test.js`.** The
  `describe.skip('[M3] OAuth state + PKCE hardening (to be added in
  T3.8)')` placeholder is flipped to a live `describe` with 5 named
  tests pinning the plan.md §5.4 bullets: (1) replayed state → 400
  `STATE_REUSED`, (2) Discord missing-state + `guild_id` → 400
  (carve-out gone), (3) expired state → 400 `STATE_EXPIRED` with
  `row.used_at` kept NULL (benign-retry path preserved), (4) valid
  happy-path → 302 whose `Location` carries
  `oauth_status=confirm_login` + a fresh confirm `token=…`, and (5)
  replayed pending-confirm token → 400 `pending_confirm_reused` +
  attacker agent's `/auth/me` does NOT leak the victim's email.
  Status-code deviation from §5.4 wording ("→ 401" for the confirm
  replay) is documented inline: implementation returns the
  discriminated-400 taxonomy, same family as the state-row 400s.
  Env + mock bootstrap (test-grade `GOOGLE_CLIENT_*`, stubbed
  `google-adapter` returning a deterministic `verifyToken` profile)
  added at the file level; a seeded users row matching the mocked
  email funnels tests 4 + 5 through the T3.7 first-seen branch
  rather than `signup_required`. Not re-coverage of
  `oauth-state-domain.test.js` / `oauth-authorize-handler.test.js` /
  `oauth-callback-handler.test.js` / `oauth-confirm-handler.test.js`
  — this suite's job is the §5.4 **regression lock** on five named
  threat-model bullets, not re-exercising already-pinned surfaces.
  **Full Docker regression green:** **34 suites / 475 pass / 14
  skip / 0 fail** (+5 tests vs T3.7 baseline; three previously-
  skipped M3 `test.todo`s promoted into passing tests, hence -4
  in the skip bucket). No production code touched — pure
  test-first regression lock-in per ADR-0012. **M3 is now 9/10
  (T3.0–T3.8 done); T3.9 — scheduler wiring for
  `pruneExpiredStateTokens` + `pruneExpiredPendingConfirms` — is
  the only remaining before the M3 wrap-up commit.**

- **2026-04-24** — **M3 Step 6 / T3.7 landed: user-facing
  OAuth confirm-gesture screen + first-seen gating + row-as-SSOT
  refactor.** Closes the session-fixation variant of C3 end-to-end.
  ADR-0016 records the first-seen keying decision
  (`{service, user_id, provider_subject}`, not just
  `{service, user_id}`). Shape of the change:
    - **Schema.** `oauth_pending_logins` gains
      `used_at TEXT NULL` + `outcome TEXT NULL` (mirrors the
      `oauth_state_tokens` "first-write-wins burn" pattern from Step
      2); `oauth_tokens` gains `provider_subject TEXT NULL` +
      `first_confirmed_at TEXT NULL`. All additive, all idempotent
      via `safeMigration()`.
    - **New domain module** `src/domain/oauth/pending-confirm.js`
      — single entry point for `createPendingConfirm`,
      `previewPendingConfirm`, `consumePendingConfirm`,
      `hasConfirmedBefore`, `recordFirstConfirmation`,
      `pruneExpiredPendingConfirms`. Handlers and the scheduler
      (Step 8) MUST go through this module — no hand-rolled SQL,
      no `req.session.oauth_*` state. Mirrors the `state.js`
      module shipped in Step 3.
    - **`src/index.js` callback handler** now consults
      `hasConfirmedBefore({db, userId, serviceName,
      providerSubject})` after provider-token exchange. On `true`
      (returning user with an already-confirmed
      `{service, user, subject}` tuple): `storeOAuthToken(...)`
      refresh-rotates the token, establishes the session, and
      302s to the safe `returnTo` — zero gesture. On `false`
      (first-seen or subject changed): `createPendingConfirm(...)`
      mints a row, 302s to
      `/dashboard/?oauth_service=…&oauth_status=confirm_login&next=…&token=…`.
      **No code path sets `req.session.user` pre-gesture anymore.**
    - **Three new endpoints.**
      `GET /api/v1/oauth/confirm/preview?token=…` is a read-only
      surface the SPA calls to render "Continue as X?"; it maps
      `PendingConfirmError` codes (`NOT_FOUND` / `EXPIRED` /
      `REUSED`) to HTTP 400 with discriminated error strings.
      `POST /api/v1/oauth/confirm` (rewritten) consumes the row
      with `outcome='accepted'`, calls `storeOAuthToken(...)`
      including `providerSubject`, calls
      `recordFirstConfirmation(...)` to stamp
      `first_confirmed_at`, then establishes the session
      (`req.session.user` / `currentWorkspace` / masterTokenRaw).
      `POST /api/v1/oauth/confirm/reject` consumes the row with
      `outcome='rejected'` without setting session — explicit
      cancel path so the short-lived token cannot be replayed
      out-of-band.
    - **`storeOAuthToken`** now accepts an optional
      `providerSubject`. On UPDATE it resets
      `first_confirmed_at → NULL` iff the incoming subject
      differs from the stored one (same local account, different
      provider identity — ADR-0016 §Case B). Callers that don't
      know the subject pass `null` and `COALESCE` preserves the
      existing value; this keeps backward compatibility with
      pre-T3.7 call sites (signup-mode / connect-mode paths —
      hardened in `m3-wrap`).
    - **Frontend rewired.**
      `src/public/dashboard-app/src/App.jsx` deletes the
      landing-page auto-POST `useEffect` (the handler that
      silently set `req.session.user` with no user gesture —
      the C3 session-fixation variant we are closing).
      `src/public/dashboard-app/src/pages/LogIn.jsx` now owns
      the gesture end-to-end: a new `pendingConfirm` state
      machine (`loading` → `ready` → `accepting | rejecting`)
      renders a dedicated screen above every other login/signup
      branch; a preview fetch calls `/confirm/preview` on
      mount, and only user-driven **Continue** / **Cancel**
      clicks reach `/confirm` or `/confirm/reject`. URL params
      are stripped on mount so a reload / bookmark cannot
      replay the confirm token.
    - **NTFS duplicate `Login.jsx` deleted.** The repo tracked
      both `LogIn.jsx` and `Login.jsx` (git is case-sensitive,
      NTFS is not) — deleting `Login.jsx` on Windows had the
      byproduct of wiping `LogIn.jsx` too, which had to be
      restored from HEAD and the gesture edits re-applied. The
      inventory gate uses `fs.readdirSync()` (NOT
      `fs.existsSync()`) to detect the duplicate, because
      Docker bind-mounts on Windows inherit NTFS's
      case-insensitivity and `existsSync('Login.jsx')` returns
      `true` even when only `LogIn.jsx` is on disk. Root
      `<Route path="/">` now renders `LogIn` (was `Login`).
    - **Inventory gates added** in
      `src/tests/oauth-state-inventory.test.js`: absence of
      `session.oauth_confirm` / `session.oauth_login_pending`
      references in `src/index.js` (comment-stripped so the
      deletion rationale prose doesn't re-trigger them),
      presence of the `pending-confirm.js` module with its
      T3.7 export surface, absence of executable
      `fetch('/api/v1/oauth/confirm'…)` in `App.jsx`
      (comment-stripped again), `readdirSync`-based duplicate
      `Login.jsx` gate, and four schema-column gates on
      `oauth_pending_logins.used_at` /
      `oauth_pending_logins.outcome` /
      `oauth_tokens.provider_subject` /
      `oauth_tokens.first_confirmed_at`. **+10 assertions
      vs end of Step 5.**
    - **New test suites (red-first, 2026-04-24).**
      `src/tests/oauth-pending-confirm-domain.test.js` — 24
      domain-level assertions covering the full lifecycle
      (create → preview → consume-accept / consume-reject,
      error taxonomy, `hasConfirmedBefore` /
      `recordFirstConfirmation` semantics including Case B
      subject-change reset, prune grace window).
      `src/tests/oauth-confirm-handler.test.js` — 15
      supertest assertions covering `/confirm/preview`
      (happy / NOT_FOUND / EXPIRED / REUSED), `/confirm`
      (happy-sets-session + stamps `first_confirmed_at` +
      persists token with subject, error mapping,
      session-free behaviour), and `/confirm/reject` (happy
      does NOT set session, errors map cleanly).
    - **Full Docker regression GREEN.**
      `docker compose -f docker-compose.test.yml run --rm
      myapi-test npm test -- --forceExit` → **34 suites,
      470 pass / 18 skipped / 0 fail** (+2 suites / +48 tests
      vs Step 5's 32/422). ~7s.
    - **Intentionally out of scope (→ `m3-wrap`):** threading
      `provider_subject` through signup-mode and connect-mode
      code paths (both still pass `null`, which the
      `COALESCE` branch tolerates); one live Google E2E
      smoke; retirement of the now-unreferenced legacy
      `createStateToken` / `validateStateToken` exports from
      `src/database.js`.
  **What this unlocks:**
    - Step 7 / T3.8 (replay / missing / expired / valid
      regression matrix) can now reshape BOTH the callback
      tests AND the new confirm tests into the §5.4
      security-regression frame. Everything it needs is on disk.
    - Step 8 / T3.9 (background prune scheduler) just needs
      to wire `pruneExpiredStateTokens(...)` (shipped in T3.2)
      AND `pruneExpiredPendingConfirms(...)` (shipped in
      T3.7) into the scheduler — no new primitives required.
  ADR: `.context/decisions/ADR-0016-oauth-confirm-first-seen-keying.md`.

- **2026-04-23** — **M3 Steps 4 + 5 / T3.4 + T3.5 + T3.6
  paired in one atomic commit.** Collapsed per explicit direction to
  preserve `oauth-signup-flow.test.js`'s end-to-end coverage across
  the refactor — splitting 4 and 5 would have left that suite
  temporarily red on an intermediate SHA. This is the commit that
  actually closes the C3 ("OAuth state not DB-validated") and C6
  ("Discord state bypass") findings from `plan.md` §6.3 at the
  handler level; Steps 1–3 had set up the machinery, this one
  rewires the call-sites.
    - **`src/index.js` — authorize handler
      (`/api/v1/oauth/authorize/:service`).** Replaces the
      session-backed `req.session.oauthStateMeta[state] = {...}`
      write with a single `createOAuthStateRow({ db, serviceName,
      mode, returnTo, userId })` call (domain `createStateToken`
      aliased to `createOAuthStateRow` to avoid a name collision
      with the retired legacy same-named export from
      `./database`, which no route handler calls after this
      commit and is scheduled for deletion in a follow-up
      cleanup). `stateRow.codeChallenge` is what now goes into
      the provider auth URL's `code_challenge` parameter —
      **not** `buildPkcePairFromState(state).codeChallenge`. The
      two "CRITICAL" comments reminding future maintainers to
      keep the session write alive are gone.
    - **`src/index.js` — callback handler
      (`/api/v1/oauth/callback/:service`).** State parameter is
      now **mandatory** for every provider (a missing `state`
      returns 400 with `code: 'STATE_MISSING'`); the session
      lookup is replaced by a single
      `consumeStateToken({ db, state, serviceName: service })`
      call whose error taxonomy surfaces as discriminated 400s
      (`STATE_NOT_FOUND` / `STATE_EXPIRED` / `STATE_REUSED` /
      `STATE_SERVICE_MISMATCH`); a `stateMeta` object is
      reconstructed from the consumed row (`mode`, `ownerId`,
      `returnTo`, `codeVerifier`) so all downstream code paths
      in the handler keep working without further edits. The
      PKCE verifier sent to the provider's token-exchange
      endpoint is now `stateMeta.codeVerifier` — the
      **persisted random 43-char base64url value** from T3.3,
      not `buildPkcePairFromState(state).codeVerifier`.
    - **`src/index.js` — Discord carve-out gone.** The
      `isDiscordBotInstall` variable, its `!state && guild_id`
      detection, and the 302-bypass branch it guarded are
      deleted. Discord now follows the same mandatory-state
      path as every other provider. Verified Discord's
      authorize flow does persist `state` across the upstream
      redirect, so no adapter change was required.
    - **`src/index.js` — dead primitives deleted.** The
      `base64UrlNoPad` and `buildPkcePairFromState` function
      declarations are gone. These were the H1 finding from
      `plan.md` §6.3 (deterministic HMAC PKCE verifier). H1
      is now closed at the handler level — the primitive-level
      closure landed in Step 3.
    - **Inventory regression gates flipped.** Four assertions
      in `src/tests/oauth-state-inventory.test.js` that were
      `TODO(M3 Step 5)` / `(M3 Step 4+5)` now assert the
      **absence** of: `buildPkcePairFromState(`, the
      `` createHmac('sha256', secret).update(`pkce:${state}`) ``
      literal, any `req.session.oauthStateMeta` reference,
      and any `isDiscordBotInstall` token. Same snapshot-
      inversion pattern used in M2 Step 2 on
      `legacy-vault-inventory`.
    - **New test files (both written red-first).**
      `src/tests/oauth-authorize-handler.test.js` — supertest
      integration suite locking the authorize refactor:
      state-row persistence with correct `service_name` /
      `mode` / `return_to` / `user_id` / `code_verifier`
      shape, PKCE challenge passed to the provider URL as
      base64url(sha256(verifier)), fresh-row uniqueness
      across sequential authorize calls, absence of any
      session-side state write (readback of the cookie jar
      shows no `oauthStateMeta` key).
      `src/tests/oauth-callback-handler.test.js` — 8-scenario
      supertest suite mocking `src/services/google-adapter.js`
      (no real OAuth provider contact): happy path 302 +
      `used_at` populated, replay → `STATE_REUSED` (row stays
      consumed), unknown → `STATE_NOT_FOUND`, service mismatch
      (google-issued / twitter-called) → `STATE_SERVICE_MISMATCH`,
      expired (`expires_at` forced into the past) →
      `STATE_EXPIRED` with `used_at` kept NULL, Discord without
      `state` + with `guild_id` → 400 (was 302 pre-Step-5),
      cookies-dropped / fresh-agent round-trip → 302 proving
      session independence, twitter row stores a 43-char random
      base64url verifier used by the callback unchanged.
    - **Test-first discipline observable.** The inventory gate
      flip + both new supertest suites were filed before
      `src/index.js` was touched. The interim RED state was
      captured implicitly by the existing
      `oauth-signup-flow.test.js` failing on a callback-only
      refactor — which is precisely why the user elected to
      pair Steps 4 + 5: running that implicit RED for the
      duration of just this one commit is acceptable; running
      it across two commits would have left an intermediate
      SHA broken, violating ADR-0012's every-commit-exits-0
      gate.
    - **Fix applied during the refactor.** The callback
      handler test initially failed to load because its
      `beforeAll` set `GOOGLE_*` env vars before
      `require('../index')` but forgot `TWITTER_*`, so the
      `issue('twitter')` helper hit the 400 "service not
      enabled" branch and `new URL(res.headers.location)`
      threw on `undefined`. Fix was additive: set
      `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` /
      `TWITTER_REDIRECT_URI` in `beforeAll` before the
      `require`, and switch the `issue()` helper to hit
      `?json=1` so state is returned in the body — robust
      against redirect-shape changes and surfaces real errors
      instead of URL-constructor stack traces.
    - **Full Docker regression GREEN.**
      `docker-compose -f docker-compose.test.yml run --rm myapi-test
      npx jest --forceExit` → **32 suites / 422 pass / 18
      skipped / 0 fail** in **~7.3 s** (+2 suites / +20 tests
      vs the ADR-0015 baseline of 30 / 402 / 18). The
      `--forceExit` is required because `src/index.js`
      schedules `setInterval` timers at module load (log
      rotation + heartbeat); without it, Jest hangs waiting
      for the event loop to drain. Documented as a
      testing-infrastructure note in the suite headers.
    - **Intentionally deferred to M3 wrap-up (`m3-wrap`):**
      - *One live end-to-end Google OAuth smoke* through
        `docker-compose -f docker-compose.smoke.yml`. The new
        handler tests already drive the exact state-consumption
        path against a real DB; batching a single real-provider
        round-trip at M3 wrap-up (after Steps 6–8 land) is
        cheaper than one per Step and exercises the
        fully-integrated surface.
      - *Retirement of the legacy `createStateToken` +
        `validateStateToken` exports* from `src/database.js`
        (now unreferenced). Not time-sensitive; the deprecated
        exports don't affect correctness, and deleting them
        touches the schema layer we just stabilised.
  **What this unlocks for M3:**
    - Step 6 / T3.7 (`LogIn.jsx` confirm-screen gesture +
      `/api/v1/oauth/confirm/preview` endpoint) can now assume
      the callback's `stateMeta.mode === 'confirm'` path is
      backed by a DB row the confirm-preview endpoint can
      re-read without session dependency — same row-as-SSOT
      invariant already locked by the new callback tests.
    - Step 7 / T3.8 (replay / missing / expired / valid
      regression matrix) is now a "combine what we have" job:
      the callback test suite already covers replay, missing,
      expired, and valid individually; T3.8 just needs to
      reshape the assertions into the §5.4 security-regression
      framework.
    - Step 8 / T3.9 (background prune job) becomes the only
      remaining engineering work in M3 — the
      `pruneExpiredStateTokens(...)` primitive already ships
      from T3.2; all that's left is scheduling and an ops log
      line.

- **2026-04-21** — **Docker-first integration scaffolding
  (pre-Step 4).** Addresses the "I want to actually boot the app and
  run integration tests — and I want all of it in Docker, not on my
  PC" request surfaced during M3 review. Artefacts:
    - `Dockerfile.dev` — small dev/test image that installs the
      root `package.json` (incl. devDeps so jest is present) and
      skips the dashboard build entirely. Needed because
      `src/Dockerfile`'s from-scratch build is broken today
      (runs `vite build` without installing vite — observed
      `sh: 1: vite: not found`), and the root `Dockerfile` uses
      `npm ci --only=production` so it can't run tests. This
      file sidesteps both issues for dev iteration; the
      production Dockerfiles stay untouched (cleanup tracked
      for M3 wrap-up).
    - `docker-compose.test.yml` — one-shot container that runs
      `npm test` against an in-memory SQLite DB with test-grade
      inline secrets. `--abort-on-container-exit` + `--exit-code-from`
      make it CI-safe. Bind-mounts `./src/` so iterating on a test
      file does not require `--build`. Network is `internal: true`
      so tests cannot reach the outside world (parity with CI).
    - `docker-compose.smoke.yml` — hot-reload smoke harness on
      port 4500. Bind-mounts `./src/` (Node 22's built-in
      `--watch --watch-path=/app/src` — no nodemon needed, which
      matters because nodemon is in `src/package.json` devDeps
      but NOT in the root `package.json` the image installs),
      `./data/` (SQLite persistence across restarts), and
      `./connectors/` (ro). Uses `.env.smoke` (git-ignored)
      copied from the new committed template.
    - `.env.smoke.example` — committed template with non-banned
      test-grade JWT / SESSION / ENCRYPTION / VAULT values. Chosen
      to satisfy `src/lib/validate-secrets.js` without polluting
      the ban-list; `cp .env.smoke.example .env.smoke` and the
      app boots. Explicit warning: not production-safe.
    - `package.json` — 9 new scripts: `test:integration`,
      `test:oauth`, `docker:test`, `docker:test:integration`,
      `docker:test:oauth`, `docker:smoke`, `docker:smoke:down`,
      `docker:smoke:logs`, `docker:smoke:shell`,
      `docker:smoke:init`. `test:integration` covers the
      supertest-driven handler suites; `test:oauth` covers the
      five OAuth-specific files (M3 state + schema + inventory +
      security hardening + signup flow).
    - `.context/runbooks/manual-smoke.md` — Docker-first runbook
      covering one-time setup, boot, master-token seeding, HTTP
      smoke curls, post-Step-4 OAuth state verification via the
      live `oauth_state_tokens` table, tear-down, and gotchas
      (Windows bind-mount polling, `:memory:` vs file DB, which
      compose file is for what). Replaces ad-hoc tribal knowledge.
    - `.gitignore` — `.env.smoke` and `/data/` added (template
      `.env.smoke.example` stays tracked).
  **Zero-risk on source:** no file under `src/` was touched, so
  `npm test` remains at 29/29 suites / 394 pass / 18 skip. The
  commit is pure test-infrastructure + documentation.
  **What this unlocks for M3:**
    - Step 4 (authorize rewire) ships its own supertest
      integration suite that `npm run docker:test:oauth` picks up
      automatically — no further scaffolding needed.
    - Step 5 (callback rewire) can add an end-to-end
      authorize → simulated-upstream → callback round-trip test
      that runs identically in `docker:test` and in CI.
    - Manual QA has a single documented sequence
      (`docker:smoke` → `docker:smoke:init` → curl → exec-in for
      `sqlite3` inspection) — no more "wait, what env do I need?"
      every time.
  Intentionally out of scope (deferred to M3 wrap-up `m3-wrap`):
  retiring `docker-compose.dev.yml` (still mentions MongoDB
  deleted in M1) and reconciling root `Dockerfile` vs
  `src/Dockerfile` (docker-compose.yml references the former,
  every other compose file references the latter).
  **Live validation before commit (2026-04-21):**
    - `docker-compose.smoke.yml` build + boot → clean. Server
      logs `✅ All required secrets validated`, migrations
      applied (11 including the M3 Step 2 oauth_state_tokens
      migration), `Server ready on http://0.0.0.0:4500`.
    - `GET /health` → `200` with `{"status":"ok","database":{"healthy":true}}`.
    - `GET /api/v1/health` → `401` without auth, correct JSON
      error body.
    - `docker:smoke:init --force` → created new master token;
      `GET /api/v1/services` with `Authorization: Bearer ...`
      → `200` / 7.7 KB payload. Confirms auth middleware
      works end-to-end in the container.
    - Inspected `/app/data/myapi.db` from inside the container
      via `better-sqlite3` REPL: `oauth_state_tokens` has all
      10 M3 columns (`user_id`, `mode`, `return_to`,
      `code_verifier`, `used_at` present) and all 3 required
      indexes (`idx_oauth_state_tokens_state` / `_expires` /
      `_used`). **The M3 Step 2 schema migration is now
      verified not just in :memory: but against a real
      file-backed SQLite DB the container creates at first
      boot.**
    - `docker-compose -f docker-compose.test.yml up` on the
      first run hit 9 failures in `critical-security-fixes.test.js`
      with `Cannot find module '../../connectors/afp-daemon/lib/daemon.js'`
      — connectors dir was not mounted. Added
      `./connectors:/app/connectors:ro` to the test compose;
      rerun went **29 passed / 29 suites / 394 tests pass /
      18 skipped**, identical to the host baseline.
  **One pre-existing bug surfaced (not in scope for this commit):**
  `GET /api/v1/me` returns `403 DEVICE_APPROVAL_FAILED` with
  `details: FOREIGN KEY constraint failed`. The device-approval
  middleware tries to insert an approval row referencing a FK
  that doesn't exist. Reproduces on the host too. Documented in
  the runbook's "Known gotchas" table. Scheduled for a separate
  fix once M3 is complete. **→ FIXED 2026-04-23, see below.**
  **Commit:** `8d9a7d4`.

- **2026-04-23** — **Device-approval FK bug fixed (ADR-0015 Option A).**
  Root cause: `bootstrap()` in `src/index.js` seeded `access_tokens`
  with `owner_id = 'owner'` but never created a matching `users`
  row; the first `/api/v1/me` request tripped
  `device_approvals_pending.user_id -> users(id)` and the
  fail-closed middleware returned `403 DEVICE_APPROVAL_FAILED`.
  Fix: exported `ensureOwnerUserRow(ownerId)` from
  `src/database.js` (idempotent `INSERT OR IGNORE`, non-bcrypt
  sentinel password); called it from `bootstrap()`, from
  `src/scripts/init-db.js` (both create + self-heal branches), and
  from the master-regenerate handler. Added test-first coverage:
  5 new FK-integrity assertions to `src/tests/init-db-seed.test.js`
  and a new 3-assertion integration suite
  `src/tests/device-approval-fk-integrity.test.js` that boots the
  real app and asserts `/api/v1/me` no longer returns
  `DEVICE_APPROVAL_FAILED`. **Live-smoke verified on a wiped
  `./data/`: `/api/v1/me` now returns the intended
  `403 DEVICE_APPROVAL_REQUIRED` with a persisted pending-approval
  row.** Option B — elevating `access_tokens.owner_id` to a real
  FK on `users(id)` — scheduled for M4 T4.9 so the inconsistency
  becomes representationally impossible. Docker regression
  **30 suites / 402 pass (+8 new) / 18 skipped / 0 fail**.
  ADR: `.context/decisions/ADR-0015-master-token-user-fk.md`.

- **2026-04-21** — **M3 Step 3 / T3.2 + T3.3: pure
  `src/domain/oauth/state.js` module.** The single entry point for
  OAuth state lifecycle is now on disk; no route handler needs to
  hand-roll SQL against `oauth_state_tokens`, and no route handler
  needs to keep state metadata in `req.session`. Closes H1
  (deterministic PKCE verifier) at the primitive level — the broken
  `buildPkcePairFromState` in `src/index.js` stays on disk but
  unused until Steps 4 + 5 remove the call-sites and declaration.
  Exported surface (documented in the file header):
    - `createStateToken({ db, serviceName, mode, returnTo?,
      userId?, ttlSec?=600, now? })` → `{ id, state, codeVerifier,
      codeChallenge, expiresAt, createdAt }`. `state` and
      `codeVerifier` are each 32 random bytes base64url-encoded
      (43 chars, 256 bits of entropy each, drawn independently).
      `codeChallenge` is PKCE S256 (`base64url(sha256(verifier))`).
    - `consumeStateToken({ db, state, serviceName, now? })` →
      consumed row, or throws `StateTokenError` with one of five
      symbolic codes (`STATE_NOT_FOUND` / `STATE_EXPIRED` /
      `STATE_REUSED` / `STATE_SERVICE_MISMATCH` /
      `STATE_INVALID_MODE` / `STATE_INVALID_SERVICE`). Uses a
      guarded UPDATE (`WHERE state_token = ? AND used_at IS NULL`)
      rather than `db.transaction(fn)` — this repo's
      `SQLiteAdapter.transaction()` is an async-Promise wrapper
      (see `src/lib/db-abstraction.js:132`), not the native
      better-sqlite3 sync API, so the single-statement UPDATE guard
      gives the same "first wins, losers see REUSED" invariant
      without coupling to the adapter shape. Service mismatch
      intentionally does NOT consume the row (benign retry succeeds).
    - `pruneExpiredStateTokens({ db, now?, graceSec?=3600 })` →
      `{ removed }`. Deletes rows where `expires_at < now-grace`
      OR `used_at < now-grace`. Consumed by the Step 8 / T3.9
      scheduler.
    - `computeCodeChallenge(verifier)`, `StateTokenError.CODES`,
      `VALID_MODES` also exported for HTTP handlers / tests.
  **Red-first discipline:** `src/tests/oauth-state-domain.test.js`
  (22 assertions) was filed in its red state with 22/22 fail
  (MODULE_NOT_FOUND against HEAD), then the implementation landed
  in the same commit and flipped it to 22/22 green. Suite
  includes:
    - Module surface (3 functions + StateTokenError + CODES enum).
    - **RFC 7636 Appendix B known-answer test** for `S256`
      (`verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"` →
      `challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"`).
      A silent drift off the PKCE S256 spec is a user-facing
      OAuth break; this KAT catches it.
    - Happy path, uniqueness, shape, row persistence,
      NULL-when-unset for `user_id` / `return_to`.
    - Reject paths: invalid mode, missing serviceName.
    - `ttlSec` honoured with an injected clock.
    - `consumeStateToken`: happy path with `used_at` populated,
      replay → REUSED, unknown → NOT_FOUND, expired → EXPIRED,
      service mismatch → SERVICE_MISMATCH (+ row NOT consumed,
      benign retry still works).
    - `pruneExpiredStateTokens`: expired past grace pruned,
      used past grace pruned, `graceSec=0` override, fresh rows
      kept, `{ removed: 0 }` when nothing qualifies.
  The Step 3 inventory gate ("domain module does not exist") was
  flipped to two assertions ("exists" + "exports the ADR-0006
  surface") in the same commit. Full `npm test` →
  **29 / 29 suites, 394 pass, 18 skip, exit 0** (+1 suite, +23
  assertions vs Step 2). No handler code rewritten in this commit
  — the broken primitives in `src/index.js` still ship and run;
  Steps 4 + 5 wire the new module in and delete them.
- **2026-04-21** — **M3 Step 2 / T3.1: additive schema
  migration on `oauth_state_tokens`.** The table gains five columns and
  two indexes that collectively let the row carry everything a flow
  needs (so the in-memory `oauthStateMeta` map can be deleted in Steps
  4 + 5 and the deterministic `buildPkcePairFromState` can be replaced
  by a real random verifier stored alongside the state). **Red-first
  discipline honoured:** new `src/tests/oauth-state-schema.test.js`
  (8 assertions) was filed and run to **6 failures / 2 passes** before
  the migration landed; after the migration it runs green in the same
  commit. New columns (rationale captured inline in `src/database.js`
  and in the test header):
  - `user_id TEXT NULL` — populated on `link` flows for already-
    authenticated users; NULL on `login` flows. TEXT to match this
    repo's `users.id` convention (ADR-0006 §Schema says INTEGER; this
    deviation is documented in the test file header).
  - `mode TEXT NOT NULL DEFAULT 'login'` — one of `login` / `link` /
    `install`. `DEFAULT 'login'` lets the ALTER succeed on non-empty
    tables without a backfill script; the domain module (Step 3)
    enforces the enum at write time.
  - `return_to TEXT NULL` — post-callback redirect target, validated
    by `isSafeInternalRedirect` at the edge (M2 hardening).
  - `code_verifier TEXT NOT NULL DEFAULT ''` — random base64url
    PKCE verifier written at issue time. DEFAULT `''` exists only so
    the ALTER succeeds on non-empty tables; the domain module never
    writes the empty string and any row carrying one is inherently
    invalid (`consumeStateToken` rejects + the prune job ages it out).
  - `used_at TEXT NULL` — set inside the same transaction that
    consumes the row; single-source-of-truth for replay detection.
  New indexes: `idx_oauth_state_tokens_expires` (for the prune scan
  in Step 8 / T3.9) and `idx_oauth_state_tokens_used` (for replay
  checks + prune grace window). Migration is **additive and
  idempotent**: fresh DBs get the full shape from the `CREATE TABLE`;
  existing deployments pick up the columns via `safeMigration()`
  ALTERs on next boot — no downtime, no backfill script, no data
  loss (pre-migration state tokens are ephemeral 10-minute rows
  anyway). The five schema-gap assertions in `oauth-state-inventory`
  flipped from `toBe(false)` → `toBe(true)` in the same commit (same
  snapshot-inversion pattern M2 Step 2 used on `legacy-vault-inventory`).
  The C3 finding is still open at the handler level (Steps 4 + 5
  finish the job); this commit makes the handlers *capable* of being
  rewritten without extending an in-memory map. `npm test` →
  **28 / 28 suites, 371 pass, 18 skip, exit 0** (+1 suite / +8
  assertions vs Step 1).
- **2026-04-21** — **M3 Step 1 / T3.0: execution playbook +
  inventory regression gate.** New `ADR-0014-m3-oauth-state-hardening-plan.md`
  ratifies the 8-commit execution path for M3 (target design is frozen
  at ADR-0006 — DB-backed single-use state rows, random 32-byte PKCE
  verifier stored in-row, no Discord bypass). The ADR pins a
  per-step test-first contract: every step files a red-first test
  suite *before* the implementation and ships the green gate in the
  same commit, with `npm test` exit 0 + no new lint/typecheck
  findings on touched files as hard commit gates. Companion
  `src/tests/oauth-state-inventory.test.js` (12 assertions) locks
  the four broken-today facts as `TODO(M3 Step N)`-labelled gates:
  - **schema gap (flips in Step 2 / T3.1).** `oauth_state_tokens`
    has only the 5 legacy columns; each of `user_id`, `mode`,
    `return_to`, `code_verifier`, `used_at` is asserted MISSING
    today; each assertion is paired with its ADR-0006 rationale
    and the exact step that will flip it to `toBe(true)`.
  - **deterministic PKCE verifier (flips in Step 5 / T3.5).**
    `src/index.js` contains `function buildPkcePairFromState(` AND
    the literal `createHmac('sha256', secret).update(`pkce:${state}`)`
    — the H1 finding from plan.md §6.3. Step 5 deletes both.
  - **in-memory state map (flips in Steps 4+5).** `src/index.js`
    contains ≥ 4 occurrences of `oauthStateMeta` (the session-Map
    replaced by the DB row in Step 4).
  - **Discord carve-out (flips in Step 5 / T3.6).** `src/index.js`
    contains `isDiscordBotInstall`, C6 in plan.md §6.3.
  - **domain module (flips in Step 3 / T3.2).**
    `src/domain/oauth/state.js` does not exist on disk today.
  Rationale for textual gates on (b)–(d): the broken primitives are
  module-scope private symbols in the monolith (not exported), so
  textual gates on unique identifier names give a clean signal
  without the cost of booting the full server for reflection.
  Same pattern used successfully in M2 Step 2 / `legacy-vault-inventory`.
  Ran green against HEAD today (12/12). Full `npm test` →
  **27 / 27 suites, 363 pass, 18 skip, exit 0** (was 26/351 at end
  of M2 wrap-up; +1 suite / +12 assertions). No production code
  touched in this commit — pure test-first pre-work per ADR-0012.
- **2026-04-21** — Frontend open-redirect hardening in
  `src/public/dashboard-app/src/pages/LogIn.jsx` (folded into the M2
  wrap-up commit). The mid-session merge from the upstream dashboard
  rewrite had introduced a same-origin guard regression: four
  post-authentication sites (`confirm_login` branch, `connected`
  branch, 2FA challenge handler, and the authenticated-redirect fast
  path) were assigning `window.location.href = pending` without
  validating that `pending` was an absolute same-origin path.
  `pending` was read from `?returnTo=` (attacker-controllable) and
  re-hydrated from `sessionStorage`, so a phishing link like
  `/dashboard/login?returnTo=https://evil.example/harvest` could
  hijack the user after a successful OAuth round-trip.
  - **Fix.** A new pure helper `isSafeInternalRedirect(target)` accepts
    only strings that (a) start with a single `/`, (b) are not
    protocol-relative (`//…` or `/\…`), and (c) contain no control
    characters. Authoritative copy lives at
    `src/lib/redirect-safety.js` (CJS, testable by the backend Jest
    config); a byte-parity ESM mirror at
    `src/public/dashboard-app/src/utils/redirectSafety.js` is consumed
    by `LogIn.jsx`.
  - **Wiring.** All four vulnerable sites now funnel through a single
    hardened sink — `redirectAfterLogin(serverPreferredTarget?)` —
    which consults `serverPreferredTarget || sessionStorage ||
    ?returnTo=` in order and falls back to `/dashboard/` whenever the
    candidate fails the guard. The three inline `if (pending) { … }
    else { … }` blocks in the OAuth callback branches and the 2FA
    handler were deleted and replaced with a single call to this sink,
    so future edits can't re-introduce the bare-assignment pattern.
  - **Tests.** 51-assertion behavioural suite
    `src/tests/redirect-safety.test.js` exercises the algorithm
    (accept table, non-strings, every common URL scheme,
    protocol-relative / backslash-smuggled paths, scheme-like strings
    without a leading slash, and control-character vectors). 10-assertion
    textual gate `src/tests/login-jsx-redirect-safety.test.js` scans
    `LogIn.jsx` to assert (a) the import is present, (b) a
    `redirectAfterLogin` sink exists, (c) no banned symbol-name
    (`pending`, `pendingReturnTo`, `serverReturnTo`, `clientReturnTo`)
    is assigned directly to `window.location.href`, and (d) every
    remaining `window.location.href = …` RHS is either the guarded
    `target` local or a hardcoded same-origin literal. A second
    describe block enforces source parity between the CJS
    authoritative copy and the ESM frontend mirror (four defensive
    checks must appear in the same order in both files).
  - Full `npm test --silent` → **26 / 26 suites, 351 pass, 18 skip,
    exit 0** (was 24 / 290 at end of T2.8; +2 suites, +61 assertions).
    Lint + typecheck report zero new findings in any changed file.
- **2026-04-21** — M2 wrap-up (T2.8): docs aligned to
  "AES-256-GCM everywhere" and to the M2 deletions / gates.
  - `CLAUDE.md` — the Request-Flow diagram no longer references the
    deleted `src/brain/brain.js` + `src/vault/vault.js`; the "Key
    Source Files" table now lists `src/database.js` (not the
    long-gone `src/config/database.js`), `src/lib/encryption.js`
    with HKDF `deriveSubkey` called out, and
    `src/lib/validate-secrets.js`. Added an explicit "Removed in M2
    (ADR-0013)" paragraph enumerating the six deleted modules and the
    `crypto-js` drop. The Environment section now documents the
    boot-time secret gate and lists `SESSION_SECRET` alongside the
    other three required secrets.
  - `SECURITY.md` — §"Security Practices" reorganised into
    Cryptography / Boot-time secret validation / Operational. The
    cryptography sub-section makes the four M2 guarantees explicit:
    AES-256-GCM everywhere, HKDF-SHA-256 domain separation (with the
    frozen purpose whitelist and the RFC 5869 regression test named),
    no legacy weak-crypto path (with the six deleted modules named
    and the inventory test named), no default-key fallback (with the
    T2.4 regression test named). The secrets gate is documented as
    "runs on every NODE_ENV, fail-closed".
  - `README.md` — the §"What MyApi stores" table already claimed
    AES-256-GCM for both `oauth_tokens` and `vault_tokens`; the
    request-flow diagram now says "database layer
    (src/database.js)" instead of the deleted "brain/vault"
    waypoint. A bordered "Boot-time validation" admonition was added
    below the required-secrets table pointing operators at the gate
    and explaining why they get a hard exit if any placeholder from
    `src/.env.example` is left in place. `ENCRYPTION_KEY` /
    `VAULT_KEY` descriptions bumped from "AES-256" to "AES-256-GCM"
    for accuracy.
  - Full `npm test --silent` → **24 / 24 suites, 290 pass, 18 skip,
    exit 0** (unchanged from end of Step 6; docs-only commit plus
    the M2 wrap-up log entry below).
- **2026-04-21** — M2 Step 6 (T2.5): `validateRequiredSecrets()`
  extracted into the pure helper `src/lib/validate-secrets.js` and
  now runs fail-closed in every `NODE_ENV`. Blocklist widened to
  cover every verbatim `src/.env.example` placeholder for the four
  required secrets in addition to the historical weak literals
  (`change-me`, `changeme`, `secret`, `password`,
  `default-vault-key-change-me`). Exports are test-pinned:
  `REQUIRED_SECRETS` is a frozen array of the four names,
  `BANNED_DEFAULTS` is a behaviourally-immutable Set (`.add` /
  `.delete` / `.clear` throw). 14-test suite
  `src/tests/validate-required-secrets.test.js` locks surface,
  blocklist contents, every-NODE_ENV behaviour, whitespace handling,
  multi-violation reporting, and `process.env` plumbing. The T2.4
  regression gate was updated to track the blocklist's move from
  inline `src/index.js` into the new helper. Commit `380b9af`.
- **2026-04-21** — M2 Step 5 (T2.4): four `default-vault-key-change-me`
  fallback sites in `src/database.js` removed:
  - `decryptVaultToken` legacy AES-256-CBC path no longer honours
    `ALLOW_LEGACY_DEFAULT_VAULT_KEY`.
  - The `LEGACY_DEFAULT_VAULT_KEY` constant is gone.
  - `getOAuthKeyCandidates()` no longer offers the legacy default as
    a recovery candidate.
  - `createKeyVersion()` and `rotateEncryptionKey()` both throw a
    clear error when the current `VAULT_KEY` is unset; `rotate` also
    validates its `newVaultKey` argument.
  New test `src/tests/default-vault-key-removed.test.js` (7 tests,
  test-first red-first / green-after) provides a textual gate across
  `src/**/*.js` and behavioural gates against the rewritten
  functions. Commit `fda13b8`.
- **2026-04-21** — M2 Step 4 (T2.1): `deriveSubkey(root, purpose)`
  HKDF-SHA-256 primitive added to `src/lib/encryption.js`:
  - **API shape.** `deriveSubkey(root, purpose, opts?)` → `Buffer`.
    `root` is a Buffer or clean even-length hex string (≥ 32 bytes);
    `purpose` is a whitelisted label from the frozen export
    `SUBKEY_PURPOSES = ['oauth:v1', 'session:v1', 'audit:v1']`. Defaults
    to a 32-byte output (drops into AES-256-GCM); accepts 16..64. Opt
    `salt` is a third separation axis; RFC 5869 §2.2 default is a
    `HashLen` zero buffer when salt is absent.
  - **Implementation.** Node's native `crypto.hkdfSync('sha256', …)`.
    The `info` parameter carries the purpose label, which is what
    buys domain separation — two purposes produce statistically
    independent outputs from the same root.
  - **Fail-closed validation.** Unregistered purpose, empty purpose,
    non-string purpose, short/non-Buffer-non-string/malformed-hex root,
    length outside `[16, 64]` all throw the single generic message
    `"Subkey derivation failed"`; root + purpose never appear in
    errors. Test + KAT escape hatches (`allowUnregisteredPurpose`,
    `allowShortRoot`) exist only so RFC 5869 vectors can run without
    weakening the production contract.
  - **Test.** New `src/tests/encryption-deriveSubkey.test.js`, 22
    assertions across 5 describe blocks, written **red-first** (all
    failing with `TypeError: deriveSubkey is not a function`) and
    landed green in the same commit as the implementation. Covers:
    module surface + frozen purpose list, RFC 5869 Test Case 1 KAT
    (exact byte match on 42-byte OKM), determinism, three-way domain
    separation (oauth/session/audit), root-hex ↔ root-Buffer
    equivalence, obvious-distance sanity (output ≠ root[0..32],
    output ≠ sha256(root)), full input-validation matrix, and an
    end-to-end AES-256-GCM round-trip (oauth-encrypted ciphertext
    fails to decrypt under the session subkey — the whole point).
  - Full `npm test --silent` → **22 / 22 suites, 269 pass, 18 skip,
    exit 0** (was 21/21/247 at end of Step 3; +1 suite and +22 tests).
  - No behavior change for any existing `src/lib/encryption.js`
    consumer; the new function + constant are purely additive. Wiring
    consumers (OAuth token encryption, session cookie signing, audit
    MAC) is M3+ scope per ADR-0013 §Follow-ups.
  - Commit: `fce3074`.
- **2026-04-21** — M2 Step 3 (T2.10): nested Docker manifest
  scrubbed of `crypto-js`:
  - **Constraint discovered:** the repo's `Dockerfile` does
    `COPY src/package*.json ./src/` + `cd src && npm ci --only=production`
    and then runs `node index.js` from `/app/src` — so
    `src/package.json` is the production dep manifest for every
    containerized deploy, not a dead relic. Deleting it outright would
    break Docker. Kept in place; trimmed only.
  - **`src/package.json`** — removed `crypto-js ^4.2.0` from
    `dependencies`. Other declared deps kept as-is (version drift vs.
    root is a separate cleanup, not M2 scope).
  - **`src/package-lock.json`** — stripped the three `crypto-js`
    entries by hand (`packages[''].dependencies['crypto-js']`,
    `packages['node_modules/crypto-js']`, top-level
    `dependencies['crypto-js']`). `crypto-js` has zero transitive deps
    in this lockfile, so leaf-removal leaves every other package byte-
    identical — avoids the unwanted churn an `npm install
    --package-lock-only` would trigger.
  - **`src/tests/legacy-vault-inventory.test.js`** — gained two new
    dependency-gate assertions: nested `src/package.json` must not
    declare `crypto-js`, and nested `src/package-lock.json` must have
    zero `crypto-js` references across all three lockfile shapes
    (v2 `packages[''].dependencies`, v2 `packages` tree, legacy v1
    `dependencies`). Both assertions noop if the nested manifest is
    later deleted, so a future "retire nested package.json entirely"
    cleanup won't fail this gate.
  - Full `npm test --silent` → **21 / 21 suites, 247 pass, 18 skip,
    exit 0** (was 21/21/245/18 at end of Step 2; +2 from the new gate
    assertions).
  - Commit: `1025d81`.
- **2026-04-21** — M2 Step 2: orphan subsystem deleted, `init-db`
  rewritten onto the live token API:
  - **Deleted** in one commit (ADR-0013 / T2.7 + T2.9): `src/utils/encryption.js`,
    `src/vault/vault.js`, `src/routes/api.js`, `src/routes/management.js`,
    `src/brain/brain.js`, `src/gateway/tokens.js`. All were unreachable from
    `src/index.js`. Also removed the stray dangling
    `const createManagementRoutes = require('./routes/management');` at
    `src/index.js:2562` (no mount point).
  - **Rewrote `src/scripts/init-db.js`** to provision a real master access
    token via `createAccessToken(...)` against the live `access_tokens`
    table in `src/database.js`. Idempotent by default
    (`getExistingMasterToken(ownerId)` short-circuits), `--force` creates an
    additional master for rotation, `INIT_DB_OWNER_ID` overrides the default
    `"owner"` ownerId. Programmatic API: `seedMasterToken({ force, label })`.
  - **New test `src/tests/init-db-seed.test.js`** (8 tests): fresh-DB happy
    path, schema shape assertions (`scope='full'`, `token_type='master'`,
    `revoked_at IS NULL`), idempotency / no-op path, `--force` path,
    bcrypt round-trip of the raw token against the stored hash, custom
    `INIT_DB_OWNER_ID`. Ran **red** first against the broken script
    (`MODULE_NOT_FOUND: crypto-js`), green after the rewrite.
  - **Tightened `src/tests/legacy-vault-inventory.test.js`**: flipped the
    two existence-snapshot assertions from `toBe(true)` to `toBe(false)`;
    `SANCTIONED_LEGACY_CALLERS` is gone; added a textual gate that scans
    every `src/**/*.{js,cjs,mjs}` file (excluding `public/` + `node_modules/`)
    for literal `require('crypto-js')` / `require('…/utils/encryption')` /
    `require('…/vault/vault')` and asserts zero hits. This gate works
    even against specifiers whose target no longer exists on disk.
  - Full `npm test --silent` → **21 / 21 suites, 245 pass, 18 skip, exit 0**
    (was 20 / 20 / 237). New gate is +1 suite, +8 tests.
  - Remaining follow-ups still in M2: T2.10 (remove nested `crypto-js`
    dep in `src/package.json`), T2.1 (HKDF `deriveSubkey`), T2.4
    (`default-vault-key-change-me` fallback), T2.5 (secret validation in
    every `NODE_ENV`), T2.8 (docs pass).
- **2026-04-21** — M2 Step 1: legacy vault inventory + re-scoping:
  - Added `src/tests/legacy-vault-inventory.test.js` (10 assertions): BFS
    over static `require()` edges from `src/index.js`, asserts no reachable
    module loads `crypto-js` / the weak `Encryption` module / the `Vault`
    class, asserts root `package.json` has no `crypto-js`, and asserts
    `crypto-js` is not resolvable from the repo root. Also confirms the
    only callers of the legacy modules are the modules themselves and the
    (unmounted) `src/scripts/init-db.js`.
  - Full `npm test --silent` → **20 / 20 suites, 237 pass, 18 skip, exit 0**.
  - New **ADR-0013** records the finding: the legacy vault path is orphan
    and the planned one-shot migration (ADR-0005, Option C) is moot. M2
    pivots to pure deletion. ADR-0005 status updated to
    "Accepted; migration workflow superseded by ADR-0013".
- **2026-04-21** — Pre-M2 baseline lock:
  - `npm install` run at the repo root (716 packages); `node_modules/`
    populated. Fixed Windows-only `EBUSY` teardown flake in
    `oauth-security-hardening.test.js` (new `safeUnlink` helper that retries
    and cleans `-wal` / `-shm` siblings).
  - Full `npm test --silent` rerun is **19 / 19 suites, 227 pass, 18 skip,
    exit 0, ~13 s**. Locked as the M2 gate.
  - Measured lint + tsc baselines on the legacy monolith: 243 problems
    (112 errors / 131 warnings) and 739 `tsc` diagnostics. Both are expected
    and progressive (per M0/M7); no PR may grow them on files it touches.
  - CI: `lint-backend` and `typecheck` jobs flipped to `continue-on-error`
    with baseline comments; `docker` job now depends only on `test` +
    `security`. `tsconfig.json` excludes `src/docs/**`.
  - New rule `.cursor/rules/test-first.mdc` codifies "run `npm test` before
    and after each step; add tests with every change". New ADR-0012 records
    the doctrine + the ratchet plan.
- **2026-04-21** — T1.6 gitleaks baseline scan:
  - `gitleaks 8.30.1` run in history mode (`--log-opts "--all --full-history"`,
    23 commits, 6.4 MB) and working-tree mode (`--no-git`, 5.2 MB).
  - 12 history + 14 worktree findings triaged. 11 are placeholders (curl
    examples, empty `.env` template keys, the redactor's own docstring,
    mock tokenIds) — now suppressed with rationale in `.gitleaksignore`.
  - 3 findings were real-looking `myapi_…` tokens: one in
    `docs/AGENT_README.md` and two (`MASTER_TOKEN`, `GUEST_TOKEN`) in
    `qa-tests/phase1-security.js`. All three removed from HEAD; the QA
    script now refuses to run without `QA_MASTER_TOKEN` / `QA_GUEST_TOKEN`
    env vars. Historical commits still hold the ciphertext, so those tokens
    must be **revoked in the MyApi DB** — catalogued in ADR-0011.
  - Rescan after fixes: **exit 0 / "no leaks found"** in both modes.
  - Owner confirmed the 3 Bucket-C tokens were dev-only test tokens against
    local `localhost:4500` instances → no provider rotation required. T1.6
    closed. T1.6b (CI `gitleaks protect`) deferred into M14. See
    `.context/decisions/ADR-0011-gitleaks-scan-2026-04-21.md`.
- **2026-04-21 (late)** — M0 foundations + M1 fire-fight landed:
  - `.context/` scaffolded with `current_state.md`, `roadmap.md`, task /
    decision / session templates, and 10 ADRs (`ADR-0001..ADR-0010`).
    Plan and task tracker moved under `.context/`.
  - Backend ESLint flat config (`eslint.config.js`) with `eslint:recommended`
    + `eslint-plugin-security` + `eslint-plugin-n`, stricter rules for
    security-critical paths, relaxed rules on the legacy monolith.
  - `tsconfig.json` at repo root with `checkJs + strict + noUncheckedIndexedAccess`
    (no `.ts` files yet).
  - `.editorconfig`, `.prettierrc.json`, `.prettierignore`.
  - `.github/CODEOWNERS`, `.github/pull_request_template.md` with security
    + `.context/` checklists.
  - `.cursor/rules/context-folder.mdc` teaches the agent to update
    `.context/` on every task transition.
  - CI (`.github/workflows/ci.yml`) gained `lint-backend`, `lint-frontend`,
    `typecheck` jobs; security audit is now blocking at HIGH+ (ADR-0008).
  - `package.json` gains `eslint`, `eslint-plugin-security`, `eslint-plugin-n`,
    `eslint-config-prettier`, `prettier`, `typescript` as devDeps and
    `lint`, `lint:backend`, `lint:frontend`, `typecheck`, `format`,
    `format:check` scripts. **Needs `npm install` locally to resolve.**
  - **M1 deletions:** the three Turso endpoints (`/turso-import`,
    `/api/v1/turso/export-sql`, `/api/v1/turso/execute`) and
    `src/public/turso-import.html` are gone.
    Hardcoded `REMOVED_CLIENT_ID` / `REMOVED_SECRET` Google OAuth fallbacks
    replaced with fail-closed defaults (`google.enabled` computed from env).
    Regression test suite in `src/tests/security-regression.test.js` locks
    the deletions.
- **2026-04-21 (earlier)** — `.context/` design finalized; 10 architectural
  decisions (ADR-0001..ADR-0010) ratified; `plan.md` and `TASKS.md` first
  drafted with 15 milestones and 120 tasks.

## 6. Active focus

- **Now:** **F6 ✅ Complete — Agent capability verification.**
  All 8 tasks landed 2026-04-28; the gateway has full L1 +
  partial L2 + L3 (manual + scripted) coverage of every agent-
  facing capability. The "is MyApi ready for OpenClaude /
  Hermes?" question now has a documented answer: **yes for the
  read path, with three known gaps (F8 / F9 / F10) the operator
  must accept or close before going live.**
- **Next, in priority order (operator pick):**
  1. **Run `npm run docker:smoke` once + the L2 smoke trio**
     (`smoke:agent` / `smoke:google` / `smoke:github`) against
     real OAuth apps. Captures whatever the L1 layer can't see
     (stale Docker image, env var typos, real Google/GitHub
     scope drift). Expected runtime ~30 s once the connect flow
     is green.
  2. **F10 (XS, half a day)** — uncomment the two
     `seedServiceCategories(); seedServices();` calls. Smallest
     possible win; un-blocks the dashboard's service catalog,
     `services/{name}/execute`, the runbook's Phase 1.
  3. **F8 (S, half a day)** — pick Option B (rewrite `llms.txt`
     to point at `/api/v1/capabilities` instead of
     `/gateway/context`); the L1 test in
     `agent-discovery-contract.test.js` already pins the
     current behavior so the diff IS the sign-off.
  4. **F9 (M, 1-2 days, naturally bundles into M6)** — the
     scope-hierarchy engine. Fixes GAP-008 + GAP-009 together.
     Until it lands, the runbook + walkthrough script tell
     operators to mint **broad** scopes (`services:read` /
     `services:write`) rather than narrow.
  5. **M5** — SSRF surface unification (a separate planned
     milestone). F7 (agent-defined connectors at runtime) is
     gated on M5 closing per ADR-0020.
- **Just landed (2026-04-28):** **F6 complete** + 3 follow-up
  briefs (F8 / F9 / F10). See §5 for the blow-by-blow.
- **Recently closed:** **M3 ✅ Complete (2026-04-24).** All ten tasks
  (T3.0–T3.9) landed plus the M3 wrap-up commit. C3 ("OAuth state
  not DB-validated" + the session-fixation variant) and C6
  ("Discord state bypass") from `plan.md` §6.3 are closed
  end-to-end, locked in the §5.4 regression frame
  (`security-regression.test.js`), and exercised against a
  real Google OAuth round-trip in the 2026-04-24 live smoke.
  H1 (deterministic PKCE verifier) remains closed. The OAuth
  callback cannot set `req.session.user` without a user-driven
  gesture; the first-seen key `{service, user_id,
  provider_subject}` prevents both gesture-fatigue on returning
  users and silent aliasing of a different provider identity
  onto an existing local account. The two expired-row tables
  (`oauth_state_tokens` + `oauth_pending_logins`) get pruned
  on a 10-min tick with structured operational logging.
- **Just landed (2026-04-24):** **`F3` complete — both passes shipped.**
  - Pass 1 (commit `959059c`): dropped `max_age=0` from the Google
    login authorize URL. The mechanical cause of "consent every
    login" is gone.
  - Pass 2 (this commit): flipped `google-adapter.js` default from
    `prompt: 'consent'` → `'select_account'` so connect-mode inherits
    the same UX; added `invalid_grant` recovery in
    `refreshOAuthToken` (nulls the dead `refresh_token` column so the
    row moves to a "reauth_required" state); surfaces
    `REAUTH_REQUIRED` as a distinct 401 envelope on proxy + execute;
    `/oauth/status` emits `reauth_required` as a third connection
    state; `ServiceConnectors.jsx` renders an amber banner + per-card
    "Reauthorize" CTA. ADR-0017 locks the policy. 12 new passing
    tests across 4 files (behavioural + static tripwires + live
    smoke), full Docker regression at 504 pass / 20 skip /
    36 suites. Brief archived in
    `.context/tasks/completed/F3-oauth-consent-prompt-once-per-grant.md`.
- **Next (operator-directed, queued for next work session):** **M4**
  (session + rate-limit dual-driver store) — see ADR-0002 +
  `TASKS.md` M4. T4.9 still carries the ADR-0015 Option B follow-up
  (representationally impossible `access_tokens.owner_id` →
  `users(id)` FK).
- **Other backlog (carried from M3 live smoke):**
  - **`F1`** — SPA routes freshly-authenticated users to `/`
    instead of `/dashboard/` after the confirm-gesture click
    (`App.jsx` redirect effect races the auth-store hydration).
    UX only. Bundles with M9.
  - **`F2`** — the onboarding-wizard surface is half-wired; M3
    wrap-up stubbed the missing `onboardingUtils.js` exports as
    localStorage-backed no-ops to unblock the SPA build. Either
    ship the wizard properly or retire it. Bundles with M9.
  - **`F11`** (filed 2026-04-29) — operator-driven 2FA reset
    surface. Today the only recovery path is hand-editing
    `users.totp_secret = NULL, two_factor_enabled = 0` in SQLite
    (we did this once for `mailer.kv@gmail.com`). F11 ships a
    master-only `POST /api/v1/admin/users/:id/2fa/reset`, a
    dashboard button, and a `409 ALREADY_ENROLLED` guard on
    `/auth/2fa/setup` so a re-run cannot silently rotate the
    secret. Effort: S (half a day to one day).
- **After F3/M3 wrap-up:** next-up is **M4** (section above).
- **Recently closed:** **M3 complete.** All ten tasks (T3.0–T3.9)
  + the wrap-up commit + the live Google smoke. Previous
  milestone **M2** complete: all eight in-scope tasks, three
  cancelled per ADR-0013; M2 wrap-up also folded in the
  frontend open-redirect hardening for `LogIn.jsx`.
- **Blocked / waiting on a human:**
  - **Google OAuth credential rotation** at the provider — tracked for M3
    hardening. Not urgent since `REMOVED_…` fallbacks are gone and
    `google.enabled` is now computed from env.
  - **`npm install`** at the repo root to pull the new devDeps
    (`eslint`, `typescript`, `prettier`, plugins) so `npm run lint:backend`
    and `npm run typecheck` work locally. CI will do this automatically.

## 7. Pointers

- Workstream breakdown: [`plan.md` §9](plan.md#9-workstreams-to-be-broken-into-tasks-later)
- Milestone tracker: [`TASKS.md`](TASKS.md)
- Ratified decisions: [`plan.md` §0.1](plan.md#01-decisions-log) + `decisions/ADR-*.md`
- Open design questions: [`plan.md` §10](plan.md#10-open-questions) (OQ-11..OQ-15)
