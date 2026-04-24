# Current state — MyApi

> **Purpose.** 5-minute snapshot of where the project is today. Skim this before
> starting any session. Longer context lives in [`plan.md`](plan.md). Tactical
> tracker is [`TASKS.md`](TASKS.md).
>
> - Last updated: **2026-04-24** (F3 Pass 2 landed)
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
| `npm test` | **36 / 37 suites, 504 pass / 20 skip, exit 0** (~22 s in Docker; F3 Pass 2 added the `oauth-refresh-invalid-grant` suite + 2 adapter tests in `oauth-security-hardening` + 5 static tripwires in `security-regression`) | **Hard gate** | Do not merge anything that reduces this count. |
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

- **2026-04-24 (latest)** — **M3 wrap-up commit landed — M3 is now
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

- **Now:** **M3 ✅ Complete (2026-04-24).** All ten tasks
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
