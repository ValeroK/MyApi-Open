# ADR-0014 — M3 execution playbook: OAuth state + PKCE + callback hardening

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** ADR-0006 (the *target design* for DB-backed OAuth state),
  ADR-0012 (test-first discipline), ADR-0013 (execution-playbook format),
  `plan.md` §6.3 (critical items C3 + C6), `TASKS.md` M3 (T3.1–T3.9)
- **Tags.** security, oauth, csrf, pkce, planning

## Context

ADR-0006 decided *what* the new OAuth state subsystem must look like:
DB-backed, single-use, 10-minute TTL, random PKCE verifier stored alongside
the state row, no Discord carve-out. This ADR decides *how* to get there
safely — the commit-by-commit execution plan, the test-first gating per
step, and the deletion sequence for the legacy primitives
(`buildPkcePairFromState`, `req.session.oauthStateMeta`, `isDiscordBotInstall`).

The inventory work done while scoping this ADR confirmed the scale of the
change:

| Legacy fact | Where it lives today |
|---|---|
| `oauth_state_tokens` schema has only 5 columns (`id`, `state_token`, `service_name`, `created_at`, `expires_at`) | `src/database.js:274`. No `user_id`, `mode`, `return_to`, `code_verifier`, `used_at`. |
| Deterministic PKCE verifier derived from `HMAC(SESSION_SECRET, "pkce:"+state)` | `src/index.js:8338` (`buildPkcePairFromState`). Single `SESSION_SECRET` leak compromises every PKCE exchange past, present, future. |
| State metadata (mode, returnTo, OAuth subject cache) kept in in-memory session map | `src/index.js:8406`, `:8435`, `:8605`, `:7611` (`req.session.oauthStateMeta[state]`). Lost on restart; breaks across two tabs / two session cookies; does not survive a multi-node deploy. |
| Discord bot-install bypasses state entirely | `src/index.js:8553` (`isDiscordBotInstall = service === 'discord' && !state && req.query.guild_id`). Documented critical finding C6 in `plan.md` §6.3. |
| No replay prevention | No `used_at` column; no second-use rejection anywhere in the code path. |

## Options considered

| # | Option | Verdict |
|---|--------|---------|
| A | One giant "big-bang" M3 commit that ships schema + helper + authorize + callback + UI + tests all at once | **Rejected.** Unreviewable, hard to bisect, violates ADR-0012's per-task gate. |
| B | **Eight focused commits, test-first, commit-and-push after each step.** Each step lands a red-first regression test *before* its implementation and a green gate *after*. | **Selected.** Same cadence as M2; gives CI bisect ability; keeps every intermediate state green. |
| C | Ship the domain module first, keep `buildPkcePairFromState` as a dual-write for one release, then deprecate | **Rejected.** There is no production user of the current broken PKCE to preserve compatibility for; dual-write extends the broken crypto window with zero upside. |

## Decision

**Option B — eight-step, test-first, commit-and-push cadence.**

Every step obeys the ADR-0012 contract:

1. `npm test` must be **exit 0** before the step starts (i.e. the previous
   step's green gate is intact).
2. The step's *first* artifact is a red-first test suite that encodes the
   new behaviour. The suite MUST fail before the implementation lands.
3. The implementation lands in the *same commit* as the test, so the test
   ships green.
4. `npm run lint` and `npm run typecheck` MUST report **zero new findings**
   on any file the step touches (repo-wide baselines stay report-only
   until M14).
5. `.context/current_state.md` and `.context/TASKS.md` are updated in the
   same commit.
6. Commit + push before starting the next step.

### Step-by-step plan

All line numbers below are from `HEAD = 4353932` (post-M2 wrap-up +
open-redirect hardening). Tasks refer to `TASKS.md` M3.

---

#### Step 1 — ADR + inventory regression test (this commit, T3.0 / prep)

**Goal.** Lock today's broken facts as assertions so the later refactor
cannot silently skip any of them.

**Artifacts.**

- `.context/decisions/ADR-0014-m3-oauth-state-hardening-plan.md`
  (this file).
- `src/tests/oauth-state-inventory.test.js` — new Jest suite, ~10
  assertions:
  - schema inventory: `oauth_state_tokens` has exactly the 5 legacy
    columns and is missing each of `user_id`, `mode`, `return_to`,
    `code_verifier`, `used_at`;
  - textual inventory: `src/index.js` contains the literal strings
    `buildPkcePairFromState`, `oauthStateMeta`, `isDiscordBotInstall`;
  - runtime inventory: calling `buildPkcePairFromState(state)` twice
    with the same `state` returns the *same* `codeVerifier` (proof of
    determinism — will flip to "throws / does not exist" after Step 4).
- `.context/current_state.md` — new §5 entry noting M3 start +
  locked gate.
- `.context/TASKS.md` — T3.0 (new, inventory) marked `[x]`; M3 progress
  flipped to `[~]`.

**Acceptance criteria.** `npm test` ≥ 27 / 27 suites, **≥ 352 pass**,
exit 0. All five schema-gap assertions pass *today*. Every assertion
has an explicit TODO comment pointing at the step that will flip it.

**Commit title.** `test(oauth-state): inventory gate + M3 plan (ADR-0014)`

---

#### Step 2 — schema migration (T3.1)

**Goal.** `oauth_state_tokens` gains the five missing columns via an
idempotent, backfill-safe migration. Old rows (if any in a dev DB) get
`NULL` for the new columns.

**Artifacts.**

- `src/database.js` — replace the legacy `CREATE TABLE oauth_state_tokens`
  with the full ADR-0006 shape + add `ALTER TABLE … ADD COLUMN IF NOT
  EXISTS` shims for existing DBs. New indexes:
  `idx_oauth_state_tokens_expires`, `idx_oauth_state_tokens_used`.
- `src/tests/oauth-state-schema.test.js` — new suite, ~6 assertions:
  fresh init has all ten columns, correct types, correct NOT NULL /
  NULL-allowed shape; both indexes exist; the `state_token UNIQUE`
  constraint is preserved.
- The schema-gap assertions in `oauth-state-inventory.test.js` flip from
  "column missing" to "column present" (snapshot inversion, same pattern
  we used in M2 Step 2 for the `legacy-vault-inventory` test).

**Acceptance criteria.** `npm test` ≥ 28 / 28 suites; no existing
regression test breaks. Step MUST be reversible by dropping the new
columns — no backfill logic that depends on row content.

**Commit title.** `feat(db): expand oauth_state_tokens schema for M3 (T3.1)`

---

#### Step 3 — domain module `src/domain/oauth/state.js` (T3.2 + T3.3)

**Goal.** Pure, testable functions for issuing and consuming state rows.
Closes ADR-0006 H1 (random PKCE verifier) as part of the same commit
because the helper returns `{ state, codeVerifier, codeChallenge,
expiresAt }` and the authorize handler will adopt it in Step 4 without
touching the broken literal.

**Artifacts.**

- `src/domain/oauth/state.js` — new file, exports:
  - `createStateToken({ db, serviceName, mode, returnTo, userId?, ttlSec=600, now?=Date.now })`
    — writes a row, returns the full created record. `state` and
    `codeVerifier` are each `crypto.randomBytes(32)` → base64url.
    `codeChallenge` = `base64url(sha256(codeVerifier))` (PKCE S256).
  - `consumeStateToken({ db, state, serviceName, now?=Date.now })` —
    inside a transaction: look up, reject if missing / expired / already
    used / wrong service, set `used_at = now`, return the row. Errors
    are symbolic: `'STATE_NOT_FOUND'`, `'STATE_EXPIRED'`,
    `'STATE_REUSED'`, `'STATE_SERVICE_MISMATCH'`.
  - `pruneExpiredStateTokens({ db, now?=Date.now, graceSec=3600 })` —
    deletes rows where `expires_at < now - graceSec` OR `used_at IS NOT
    NULL AND used_at < now - graceSec`. Returns `{ removed: number }`.
- `src/tests/oauth-state-domain.test.js` — new suite, ~22 assertions:
  module surface, happy path, cross-service mismatch rejection, replay
  rejection, expiry rejection, PKCE S256 correctness against RFC 7636
  Appendix B vector, determinism of `now` injection, `ttlSec` bounds,
  `pruneExpiredStateTokens` honours grace, `createStateToken` rejects
  unknown `mode` and missing `serviceName`.

**Acceptance criteria.** `npm test` ≥ 29 / 29 suites. The new module has
zero `require`s of `src/index.js`, zero use of `req.session`. Test-first:
file the empty stub, watch the suite go red (`TypeError: createStateToken
is not a function`), fill in the impl, watch it go green inside the same
commit.

**Commit title.** `feat(oauth): domain/oauth/state.js with random PKCE verifier (T3.2, T3.3)`

---

#### Step 4 — rewire `/api/v1/oauth/authorize/:service` (T3.4)

**Goal.** Authorize handler reads/writes through the new domain module.
`buildPkcePairFromState` and every `req.session.oauthStateMeta =` site
are deleted in this commit.

**Artifacts.**

- `src/index.js` — authorize handler calls `createStateToken(...)`
  instead of constructing `state` + `oauthStateMeta` inline. The
  `code_challenge` query parameter for the upstream OAuth provider is
  read from the helper's return value. Every call-site of
  `buildPkcePairFromState` inside the authorize path is removed. The
  `req.session.oauthStateMeta = req.session.oauthStateMeta || {}` and
  `req.session.oauthStateMeta[state] = { … }` lines are deleted.
  `delete req.session.oauthStateMeta[state]` lines in the happy/unhappy
  paths are deleted (the DB row is the source of truth).
- `src/tests/oauth-authorize-handler.test.js` — new integration suite,
  ~10 assertions, built on `supertest`:
  1. `GET /api/v1/oauth/authorize/google` returns 302 with a `state`
     query param that maps to a row in `oauth_state_tokens`.
  2. The row's `service_name === 'google'`, `used_at IS NULL`,
     `expires_at` is within `[now+9m30s, now+10m30s]`.
  3. The row's `code_verifier` is a valid base64url string of length 43.
  4. `req.session.oauthStateMeta` is never mutated (spy-asserted via
     middleware).
  5. The upstream redirect URL contains `code_challenge=<S256 of
     verifier>` and `code_challenge_method=S256`.
- Inventory test's "deterministic verifier" assertion flips to a textual
  gate: `grep` for `buildPkcePairFromState` in `src/**/*.js` must return
  zero hits. (Same pattern as the M2 `crypto-js` sweep.)

**Acceptance criteria.** `npm test` ≥ 30 / 30 suites. Manual smoke test
is **not** required — the supertest assertions cover the hot path.

**Commit title.** `feat(oauth): authorize handler uses state-row PKCE verifier (T3.4)`

---

#### Step 5 — rewire `/api/v1/oauth/callback/:service` + remove Discord bypass (T3.5 + T3.6)

**Goal.** Callback handler calls `consumeStateToken(...)`; the Discord
`isDiscordBotInstall` branch is deleted. Replay → 400, expired → 400,
missing → 400, wrong service → 400.

**Artifacts.**

- `src/index.js` — callback handler refactored. The `const
  isDiscordBotInstall = …` line and every branch gated on it are
  deleted. The `stateMeta` session lookup is replaced with
  `consumeStateToken({ db, state, serviceName: service })`. The PKCE
  verifier for the upstream token exchange is read from the consumed
  row, not from `buildPkcePairFromState`. `buildPkcePairFromState` is
  fully deleted from the file in this commit (Step 4 already removed
  its only other call-site).
- `src/tests/oauth-callback-handler.test.js` — new integration suite,
  ~12 assertions built on `supertest`:
  1. Valid state → 302, row has `used_at` set.
  2. Second use of the same state → 400 `STATE_REUSED`, row unchanged.
  3. Unknown state → 400 `STATE_NOT_FOUND`.
  4. Expired state (`now > expires_at`) → 400 `STATE_EXPIRED`.
  5. State issued for a different service → 400 `STATE_SERVICE_MISMATCH`.
  6. Discord callback WITHOUT a valid `state` row → 400 (no more
     `guild_id` carve-out).
  7. Discord callback WITH a valid `state` row → 302 (parity with
     other providers).
- Inventory test's Discord-bypass and `oauthStateMeta` textual gates
  flip to "not present".

**Acceptance criteria.** `npm test` ≥ 31 / 31 suites. `grep -r` for
`buildPkcePairFromState|oauthStateMeta|isDiscordBotInstall` across
`src/**/*.js` returns zero lines.

**Commit title.** `feat(oauth): callback uses state-row consume; remove Discord bypass (T3.5, T3.6)`

---

#### Step 6 — Login.jsx confirm screen for `oauth_status=confirm_login` (T3.7)

**Goal.** User-gesture confirmation before calling
`/api/v1/oauth/confirm`, showing the OAuth subject email.

**Artifacts.**

- `src/public/dashboard-app/src/pages/LogIn.jsx` — in the
  `confirm_login` branch, instead of POSTing to `/api/v1/oauth/confirm`
  immediately, fetch the pending subject (new endpoint
  `GET /api/v1/oauth/confirm/preview?token=…` — returns
  `{ subject: string, service: string, expiresAt: number }`), render
  a confirm panel with a primary button ("Continue as <email>") and a
  cancel link, and only POST on button click. The existing hardened
  `redirectAfterLogin()` sink is reused after success.
- `src/index.js` — new `GET /api/v1/oauth/confirm/preview` endpoint
  that reads the pending login row and returns the minimal subject
  shape (no token, no secrets). Gated by the same rate limit as
  `/api/v1/oauth/confirm`.
- `src/tests/oauth-confirm-preview.test.js` — new supertest suite,
  ~6 assertions: 200 + correct shape on valid token, 404 on missing,
  410 on expired, 429 under rate limit, no secrets in the response
  body, no auth cookie set by the endpoint.
- `src/tests/login-jsx-confirm-screen.test.js` — new textual gate,
  ~6 assertions: `LogIn.jsx` no longer POSTs to
  `/api/v1/oauth/confirm` inside the `useEffect` callback; a new
  component / JSX block with `data-testid="oauth-confirm-button"` is
  present; the button's `onClick` references the confirm POST.

**Acceptance criteria.** `npm test` ≥ 33 / 33 suites. The M2 open-redirect
guard (`isSafeInternalRedirect`) is preserved — the new code path
continues to funnel through `redirectAfterLogin()`.

**Commit title.** `feat(dashboard): require user-gesture OAuth confirm screen (T3.7)`

---

#### Step 7 — integration regression suite (T3.8)

**Goal.** Pin the attacker-facing behaviours as permanent gates in
`security-regression.test.js`.

**Artifacts.**

- `src/tests/security-regression.test.js` — gains four new end-to-end
  assertions:
  1. replay of the same `state` → 400;
  2. missing `state` + `guild_id` on Discord → 400;
  3. expired `state` → 400;
  4. valid flow end-to-end → 302 + row marked used.
- `src/tests/oauth-state-regression.test.js` — new file, dedicated
  table-driven matrix covering all combinations of
  `{valid, expired, missing, used} × {google, github, discord}` so
  a regression on any one provider trips a labelled test.

**Acceptance criteria.** `npm test` ≥ 34 / 34 suites. No changes to
production code in this commit — tests-only, per ADR-0012's "add
relevant tests in the same PR" rule.

**Commit title.** `test(oauth-state): replay/expired/missing/valid regression matrix (T3.8)`

---

#### Step 8 — background prune job (T3.9)

**Goal.** Keep `oauth_state_tokens` small. Use the existing background
scheduler (`setInterval` in `src/index.js`). Configurable interval
(default 10 min) and grace (default 1 hour) via env.

**Artifacts.**

- `src/index.js` — new scheduler entry near the other `setInterval`
  blocks. Calls `pruneExpiredStateTokens({ db })`. Logs
  `{ removed: number, ms: number }` when `removed > 0`; silent
  otherwise.
- `src/tests/oauth-state-prune.test.js` — new suite, ~5 assertions:
  prunes expired rows, prunes used rows past grace, does not prune
  fresh rows, honours `OAUTH_STATE_PRUNE_GRACE_SEC`, returns correct
  `{ removed }` count. The scheduler itself is *not* tested (setInterval
  is an implementation detail); only the pure `pruneExpiredStateTokens`
  invocation is asserted.

**Acceptance criteria.** `npm test` ≥ 35 / 35 suites. No unhandled
promise rejections (the prune job swallows and logs its own errors).

**Commit title.** `feat(oauth): prune expired oauth_state_tokens (T3.9)`

---

### Wrap-up commit (post-Step 8)

`CLAUDE.md`, `SECURITY.md`, `README.md`, `.context/current_state.md`,
`.context/TASKS.md` updated to reflect:

- M3 marked `✅ Done` in `TASKS.md` with per-step commit SHAs.
- `SECURITY.md` gains an "OAuth state + PKCE" subsection naming the
  domain module and the six regression tests.
- `current_state.md` §1a baseline bumped to whatever `npm test` reports
  after Step 8.
- The C3 + C6 rows in the `current_state.md` critical-risks table
  flipped to "closed by M3 (ADR-0006, ADR-0014)".

## Consequences

- **Security posture improves at each commit**; no intermediate state is
  worse than HEAD. Steps 1–3 add code but leave the old broken path
  running. Step 4 removes `buildPkcePairFromState` from authorize.
  Step 5 removes it from callback and deletes the Discord bypass. From
  that commit on, every OAuth exchange uses random PKCE verifiers and
  single-use DB rows.
- **Easy bisect.** If a regression surfaces in production after M3,
  `git bisect` over the 8 commits isolates the culprit within one
  responsibility boundary.
- **Review surface stays small.** The largest single commit (Step 4 or
  Step 5) touches one handler in `src/index.js` and a handful of tests.
- **Roll-forward recovery.** If any step's CI goes red, we fix forward
  in a new commit — never force-push, never rewrite history across a
  pushed commit. (ADR-0012 doctrine.)

## Follow-ups

- M3 closes critical findings C3 (OAuth state not DB-validated +
  Discord bypass) and H1 (deterministic PKCE verifier) from
  `plan.md` §6.3.
- M4 (session store dual-driver) no longer has to carry the
  `oauthStateMeta` map across processes — M3 deletes it entirely.
- M14 (CI ratchet) will retroactively cover the `src/domain/oauth/`
  tree under the stricter lint profile; no action needed during M3.
