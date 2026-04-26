# Task brief — F5: Password auth — consolidate, harden, and surface in UI

## Identity

- **ID.** `F5`
- **Title.** Consolidate 4 shadow password-auth code paths into one hardened
  implementation, add password-reset/change flows, and surface password
  login/register in the dashboard UI alongside OAuth.
- **Milestone.** Split into **F5.1 / F5.2 / F5.3** (see plan below).
- **Plan reference.** This document is the long-range roadmap.
  The currently active sub-plan is
  [`F5.2-working-password-auth-and-activity-log-cleanup.md`](./F5.2-working-password-auth-and-activity-log-cleanup.md).
- **Workstream.** WS-backend + WS-frontend.

## Status

- **State.**
    - **F5.1** ✅ COMPLETE — P1a (`fb99b74`) + P1b+P1c (`72a1b47`).
      Backend consolidated to one router; shadows deleted; logout
      audit gap closed; dead `global.sessions` machinery removed.
    - **F5.2** 🟢 ACTIVE — see
      [`F5.2-working-password-auth-and-activity-log-cleanup.md`](./F5.2-working-password-auth-and-activity-log-cleanup.md).
      Covers password reset, change-password, full UI surface, and an
      activity-log noise cleanup that was promoted out of F5.1's
      verification findings.  This is what's currently in flight.
    - **F5.3** ⏸ DEFERRED — security posture hardening: bcrypt cost
      12 → 14 + upgrade-on-login (orig. Phase 2), HIBP k-anonymity +
      common-password block (orig. Phase 3), per-email account
      lockout (orig. Phase 4).  Deferred per user decision on
      2026-04-26: stable working system first, security posture
      second.
- **Assignee.** unassigned
- **Started.** F5.1 P1a 2026-04-23.
- **Target done.** F5.2 backend (P0+P1+P2) as one milestone, F5.2 UI
  (P3.1–P3.4) as the second milestone.  F5.3 future.
- **Actually done.** F5.1 — 2026-04-25 (`72a1b47`).

## Why (1-paragraph context)

During F4 scoping (2026-04-24) we confirmed two things that independently
justify this work:

1. **The dashboard has no password login path at all.** `LogIn.jsx` and
   `SignUp.jsx` contain zero password input fields and never call
   `/api/v1/auth/login` or `/api/v1/auth/register`. Users cannot authenticate
   without a working OAuth provider. This is both a UX problem (the first time
   Google's consent flow breaks, users are locked out) and a compliance
   problem (we have no non-OAuth recovery path).
2. **The backend has four overlapping password-auth code paths.** Audit on
   2026-04-24 confirmed:
   - `src/routes/auth.js` (mounted first at `/api/v1/auth`) — **the live
     winner**: async `bcrypt.hash` cost 12, CSRF, `requireBetaSlot`, welcome
     email. This is the one currently exercised by `phase3.audit-security.test.js`
     and `beta-mode.test.js`.
   - `src/index.js:6860` (`POST /api/v1/auth/register`, inline) — shadowed by
     the above; uses `createUser(...)` helper + `authRateLimit`.
   - `src/index.js:6887` (`POST /api/v1/auth/login`, inline) — shadowed;
     async `bcrypt.compare` + `authRateLimit` + failed-login alerting.
   - `src/auth.js` (mounted at `/api/v1`) — shadowed by both; uses synchronous
     `bcrypt.hashSync`, 6-character minimum, no CSRF, no rate limit. **This
     file is a loaded gun**: any future re-ordering of `app.use()` calls would
     silently expose the weakest implementation.

That's a maintenance hazard (four password-hashing implementations to keep in
sync) stacked on top of a product hazard (no password login UI at all).
F5 consolidates to one backend route, lifts it to modern primitives, adds the
missing reset/change flows, and surfaces it in the UI.

### Out-of-scope infrastructure F5 must NOT touch

Audit on 2026-04-24 surfaced one boot-time code path that *looks* like user
auth but is actually platform infrastructure. F5 must leave it alone:

- **`bootstrap()` → `ensureOwnerUserRow('owner')`** at `src/index.js:3308`
  seeds a non-login placeholder row in `users` (`id='owner'`,
  `password_hash='!seed-owner-nologin!'`, `email=NULL`). The sentinel hash is
  **not** a valid bcrypt string, so `bcrypt.compare(pw, sentinel)` always
  returns false — the row cannot be logged into with any password.
- The row exists to (a) anchor the `device_approvals_pending.user_id →
  users(id)` foreign key chain (ADR-0015 Option A, commit `23baf7f`) and
  (b) own the platform's initial master token (`myapi_<64 hex>`, `scope=full`,
  `token_type=master`), which is hashed with `bcrypt.hashSync(rawMaster, 10)`
  once at startup for use by AI agents / CLI callers.
- The master-token hash is intentionally low-cost (10) because it's compared
  on every API request — cost 14 on the hot path would blow latency. **F5's
  Phase-2 cost-14 bump applies to user password hashes only, not the master-
  token hash.**

Phase 1 (consolidation) and Phase 7 (F4 integration) each have a scoped
exception for this row — see their respective sections.

## What (scope + explicit non-goals)

### Product decision (resolved)

Password auth **stays in the product**. User confirmed during F4 kickoff:
*"i also want to incorporate user password login/registration"*. This brief
assumes yes and focuses on HOW, not WHETHER.

### In scope

- **Backend (F5.1):**
  - Delete `src/auth.js` (shadow #3) after confirming no live mounts.
  - Delete inline `app.post("/api/v1/auth/register" …)` and
    `app.post("/api/v1/auth/login" …)` from `src/index.js` (shadows #1/#2).
  - Retain `src/routes/auth.js` as the single source of truth for password auth.
  - Upgrade hashing: bump `bcrypt` cost factor from 12 → 14 **with
    upgrade-on-login** (re-hash in place on next successful login for users
    whose stored hash was produced at the old cost). Argon2id deferred to F5.3.
  - Add **HIBP k-anonymity breach check** on register + change-password, with
    offline test fixture and graceful degrade on API failure.
  - Add **per-email lockout** via new `user_login_attempts` table (in addition
    to the existing per-IP `authRateLimit`).
  - Add **password reset** flow: new `password_reset_tokens` table (64-byte
    random, hashed, single-use, 30-min TTL), `/auth/forgot-password`,
    `/auth/reset-password`, email template via existing `emailService.js`.
  - Add **change-password** endpoint for authenticated users
    (`/auth/change-password`), requires current password re-auth, invalidates
    all other sessions for the same user.
  - **F4 integration.** Represent password auth as
    `user_identity_links.provider='password', provider_user_id=<username>`
    row on register, so `"how does this user authenticate"` is one unified
    SELECT. Optional but cleaner — see Phase 7 for the deferral option.

- **Frontend (F5.2):**
  - Add email + password fields to `LogIn.jsx` below the OAuth buttons
    (co-equal, not primary/secondary).
  - Add email + password + confirm-password fields to `SignUp.jsx`, plus
    strength meter and Terms/Privacy checkboxes (already present in profile
    step — reuse).
  - Add **"Forgot password"** link → new `ForgotPassword.jsx` page.
  - Add **password reset** page at `/dashboard/reset-password?token=<hex>`
    (new `ResetPassword.jsx`).
  - Add **"Change password"** card to `Settings.jsx` (requires re-auth).
  - Handle account-locked state with countdown timer on LogIn.jsx.

- **Tests (split across both):**
  - Unit: `isStrongPassword` expanded tests, `hashPassword`/`verifyPassword`
    helper tests, HIBP offline fallback, reset-token entropy + TTL.
  - Integration (supertest): full register → login → forgot → reset →
    change-password → logout → login-with-new-password flow.
  - Security regression tripwires: no `bcrypt.hashSync`/`compareSync` in
    `src/routes/auth.js` (bootstrap master-token hash in `src/index.js` is
    explicitly allowed), no `src/auth.js` in tree, no inline
    `/auth/register` or `/auth/login` in `src/index.js`, reset tokens
    always hashed-at-rest, change-password requires current password,
    all-other-sessions-revoked on password change.
  - Browser smoke via Chrome DevTools MCP: register with weak password
    (should reject), register happy path, logout, login, forgot-password
    email received (MailHog/local SMTP fixture), reset, re-login with new.

### Out of scope (explicit non-goals)

- **OAuth scope separation.** That was F4, already shipped.
- **2FA.** Already implemented (speakeasy TOTP).
- **WebAuthn / passkeys.** Captured as future `F6: passkeys` when we have
  appetite.
- **Passwordless magic-link login.** Different feature; different brief.
- **Migrating existing bcrypt-12 hashes to argon2id.** Deferred to F5.3.
- **Admin-override / impersonation.** Separate trust-boundary concern.

## Detailed plan (phased, test-first, atomic commits)

### Phase 0 — Baseline & verification (no code change)

**Goal.** Confirm the mount-order claim, capture existing test coverage
against the current live path, and establish the green-test baseline before
touching anything.

- Run full Jest suite — record pass count (should be 560 after F4).
- Grep every `app.use` / `router.post` targeting `/auth/*` and `/api/v1/auth/*`.
- Run a canary request against the live server — log which handler fires for
  `POST /api/v1/auth/register` (add a temporary log line in each of the 4
  handlers, remove it in a cleanup commit).
- Write this down in `.context/sessions/2026-XX-XX-f5-phase0.md`.

**Exit criteria.** We know, with evidence, which handler wins and which tests
exercise it.

### Phase 1 — Consolidate backend to one route file

**Status:** ✅ COMPLETE — split into P1a (`fb99b74`, 2026-04-24) and
P1b (this commit). P1a ported every missing security control onto the
live router (closed a latent 2FA bypass) and P1b deleted the shadow
code under static tripwire pinning. See
`.context/sessions/2026-04-24-f5-phase1a-port.md` and
`.context/sessions/2026-04-24-f5-phase1b-shadow-deletion.md`.

**Goal.** One password-auth implementation. No shadows.

**Test first:**
- Add static tripwires to `src/tests/security-regression.test.js`:
  ```
  it('F5.1: src/auth.js no longer exists')
  it('F5.1: src/index.js has no inline /auth/register or /auth/login handlers')
  it('F5.1: no bcrypt.hashSync/compareSync in password login/register paths')
  ```
  **Scope of the third tripwire is deliberately narrow:** it asserts that
  `src/routes/auth.js` (the surviving password-auth route file) contains no
  `bcrypt.hashSync` or `bcrypt.compareSync` calls. The file-wide ban would
  flag `src/index.js:3321` (`bcrypt.hashSync(rawMaster, 10)` in
  `bootstrap()`, which hashes the **master token**, not a user password —
  see "Out-of-scope infrastructure" above). A file-wide ban would also flag
  `src/routes/auth.js:551` (`bcrypt.hash(rawToken, 10)` in `/auth/me`'s
  master-token mint path). Grep target for the tripwire:
  `grep -E '(bcrypt\.hash|bcrypt\.compare)Sync' src/routes/auth.js` → must
  return nothing.
  These tests must **fail red** before the consolidation lands, then go green.

**Files:**
- `src/auth.js` — delete.
- `src/index.js` — delete inline routes at ~6860 and ~6887. Keep
  `authRateLimit` import for other routes.
- `src/routes/auth.js` — adopt `authRateLimit` so the surviving route keeps
  the per-IP throttle that used to live on the inline route.
- `src/tests/phase3.audit-security.test.js`, `src/tests/beta-mode.test.js` —
  re-verify still green.

**Observability:**
- `logger.info('password_register', { userId, emailDomain })` on success.
- `logger.warn('password_login_failed', { email_hash, reason, ip })` on
  failure — `email_hash = sha256(lowercased_email).slice(0, 12)` so logs
  don't leak PII but correlation across attempts still works.
- `createAuditLog({ action: 'password_register' | 'password_login' |
  'password_login_failed', … })`.

**Risks:**
- If any production runtime relies on the `src/auth.js` `/auth/has-users`
  endpoint (for first-run setup UX), we lose it. Mitigation: port to
  `src/routes/auth.js` before deletion.
- CSRF middleware in `src/routes/auth.js` currently guards session-based
  callers but skips Bearer — confirm this matches what the deleted inline
  routes did. Capture decision in a comment.

**Exit criteria.** Full suite green. Live docker smoke: register + login
still works. Tripwires green.

### Phase 1c — Post-shadow-deletion findings (logout audit + dead-code sweep)

**Status:** ✅ COMPLETE (2026-04-25). See
`.context/sessions/2026-04-25-f5-p1c-logout-audit.md`.

**Why this exists separate from P1a/P1b.**  P1b's full verification
matrix (rebuild + Jest + browser + DB forensics) surfaced two
non-blocking findings that were too narrow to block the shadow-deletion
commit but too compliance-relevant to defer to Phase 2:

1. The live `/logout` handler clears the session and unregisters the
   SOC2 concurrent-session entry but never emits a `user_logout` audit
   row.  Auditors could see `user_login` events that never end —
   session lifetimes were not reconstructable from the audit log
   alone.
2. `/register` writes `global.sessions[sessionToken]` and returns
   `data.token` to the client, but **nothing in the codebase ever reads
   `global.sessions`**.  The dashboard's real master Bearer token is
   minted lazily by `/auth/me` into `access_tokens`.  The register-time
   token was dead bytes that could be mistaken for a Bearer credential,
   and the 15-minute reaper in `src/index.js` (`cleanupExpiredSessions`)
   was sweeping a Map nobody read.

**Delivered.**
- `src/routes/auth.js` `/logout`: emit `createAuditLog({ action:
  'user_logout', requesterId: userId, scope: 'session', resource:
  '/users/<id>', ip, details: { sid } })` inside the
  `if (userId && sid)` guard so anonymous logouts skip; deleted the
  orphaned `global.sessions` sweep loop.  `[Auth/Logout] user_logout
  audited` `logger.info` breadcrumb correlates app log ↔ audit trail by
  sid.
- `src/routes/auth.js` `/register`: deleted the `sessionToken`
  generation, the `global.sessions[sessionToken] = …` write, and the
  `token` field in the 201 response.  Added an `[Auth/Register] user
  registered` breadcrumb.
- `src/index.js`: deleted the `cleanupExpiredSessions` function (~22
  lines) and its `setInterval(…, 15 * 60 * 1000)` registration.
- `src/tests/f5-logout-audit-and-session-cleanup.test.js` — 7 tests:
  audit emit (positive + anonymous-guard), `data.token` removal,
  `global.sessions` no-mutation, three static tripwires.

**Verification.**  Full Jest 589 pass / 22 skip / 0 fail (+7 new vs.
P1b baseline 582).  Static greps clean.  Docker smoke + live SQLite
forensics confirmed the three-row `user_register → user_login →
user_logout` lifecycle for a fresh password user; anonymous logout
produced 0 audit rows.  Browser e2e (Chrome devtools, fetch from
`/dashboard/`) reproduced the same lifecycle end-to-end.

**Breaking-change surface.**  `POST /api/v1/auth/register` no longer
returns a top-level `data.token` field.  The field carried no auth
power (it was a key into a write-only in-memory map).  No internal
caller or test reads it; no API consumer was found via grep.  Risk
classified low.

### Phase 2 — Harden hashing primitive

> **⏸ DEFERRED to F5.3** (2026-04-26 — user decision: stable working
> system first, security posture second).  Original detailed plan
> retained below for reference and pickup later.


**Goal.** bcrypt cost 12 → 14, with silent upgrade-on-login for existing
users.

**Test first:**
- `src/tests/password-hash-upgrade.test.js` (new):
  - `hashPassword(pw)` produces a bcrypt string at cost 14.
  - `verifyPassword(pw, oldCost12Hash)` returns `{valid: true, upgrade: true}`.
  - `verifyPassword(pw, newCost14Hash)` returns `{valid: true, upgrade: false}`.
  - Login handler rehashes at cost 14 iff `upgrade: true`, transparent to
    client.
- Benchmark: cost 14 hash time < 500 ms on the CI worker — capture in
  `.context/decisions/ADR-0019-password-hashing-cost.md`.

**Files:**
- `src/lib/password-hash.js` (new) — central `hashPassword` / `verifyPassword`
  wrapper that encapsulates the cost-factor constant.
- `src/routes/auth.js` — login path uses `verifyPassword`; if `upgrade` is
  true, fire-and-forget `hashPassword` + `UPDATE users SET password_hash = ?
  WHERE id = ?` and emit audit event `password_hash_upgraded`.
- `src/database.js::createUser` — switch to the new helper.
- Docker `.dockerignore` / `package.json` — no dep changes (bcrypt is
  already installed).

**Observability:**
- `logger.info('password_hash_upgraded', { userId })` — so we can watch the
  rehash front spread across the existing user base after deploy.

**Risks:**
- Cost 14 adds ~2× CPU per login compared with cost 12. If login p99 latency
  regresses above 800 ms, roll back to cost 13. Ship behind a feature flag
  `PASSWORD_HASH_COST` env var so operators can tune without a code change.

**Exit criteria.** All tests green including the new upgrade-on-login
integration test. Cost bump live in docker smoke.

### Phase 3 — Password policy + HIBP

> **⏸ DEFERRED to F5.3** (2026-04-26).  Original plan retained below.


**Goal.** Stop users from registering known-compromised passwords without
leaking the candidate to the API.

**Test first:**
- `src/tests/hibp-check.test.js` (new, offline fixture):
  - `checkHibp('P@ssw0rd')` with fixture returns `{ pwned: true, count: 12345 }`.
  - `checkHibp('zxq-unlikely-password-87463')` returns `{ pwned: false }`.
  - On HTTP 500 from HIBP, returns `{ pwned: null, error: 'upstream_failed' }`
    — **never throws**, never blocks registration silently.
- `src/tests/password-policy.test.js` — expand `isStrongPassword` coverage;
  add explicit "common password list" rejection for top 100 weakest.

**Files:**
- `src/lib/hibp.js` (new) — k-anonymity client: SHA-1 the password, send the
  first 5 hex chars, scan response for suffix match. 5-second timeout.
- `src/routes/auth.js` — register + change-password call `isStrongPassword`
  → `checkHibp`. On `pwned: true, count > 10`, reject with
  `PASSWORD_BREACHED`. On `pwned: null` (API down), log warn and allow
  (fail-open for availability, documented in ADR-0020).

**Observability:**
- `logger.warn('hibp_upstream_degraded', { error, latency_ms })` on failure.
- `createAuditLog({ action: 'password_policy_rejected', details: { reason } })`
  for every rejected password attempt (no password contents logged).

**Risks:**
- HIBP API changes. Pin a user-agent and document the fallback path.

**Exit criteria.** A user cannot register with "password123"; registration
still succeeds instantly when HIBP is stubbed to fail.

### Phase 4 — Account lockout (per-email + per-IP)

> **⏸ DEFERRED to F5.3** (2026-04-26).  F5.2 P1 mitigates the
> reset-flood vector with a per-email rate limit on
> `/auth/password/reset/request` (3/hour); broader account lockout
> stays in F5.3.  Original plan retained below.


**Goal.** Brute-force defense above the per-IP `authRateLimit` we already
have.

**Test first:**
- `src/tests/password-lockout.test.js` — integration:
  - 5 consecutive failed logins for the same email → 6th returns
    `ACCOUNT_LOCKED` with `retry_after` seconds.
  - Cooldown follows `2^n * 30s` capped at 1 hour.
  - Successful login resets the counter.
  - Lockout is email-keyed, not IP-keyed — user on a different laptop gets
    the same lockout (prevents IP rotation bypass).

**Files:**
- `src/database.js` — new table:
  ```
  CREATE TABLE user_login_attempts (
    email_hash TEXT PRIMARY KEY,         -- sha256(lower(email))
    failed_count INTEGER NOT NULL,
    first_failure_at TEXT NOT NULL,
    last_failure_at TEXT NOT NULL,
    locked_until TEXT                    -- NULL if not currently locked
  );
  ```
  With a migration + tripwire.
- `src/routes/auth.js` — login wraps failure path with
  `recordFailedLogin(email)` and success path with `clearFailedLogins(email)`.
- `src/domain/password/lockout.js` (new) — the counter/cooldown math lives
  here, not in the route.

**Observability:**
- `logger.warn('account_locked', { email_hash, failed_count, locked_until })`.
- Audit: `account_lockout_triggered`, `account_lockout_cleared`.

**Risks:**
- False positives on shared IPs with multiple legitimate failures — per-email
  keying sidesteps this.
- DOS vector: attacker locks out a target by repeatedly entering wrong
  passwords. Mitigated by: (a) per-IP rate limit kicks in first, (b) lockout
  is email-keyed so the attacker must keep guessing email, (c) account
  owner can still reset via email link (reset path is NOT gated on lockout).

**Exit criteria.** Lockout math verified in unit tests; integration test
covers the full lock → reset-email-bypass → success cycle.

### Phase 5 — Password reset flow

> **🟢 SUPERSEDED by F5.2 P1** (active).  See
> [`F5.2-working-password-auth-and-activity-log-cleanup.md`](./F5.2-working-password-auth-and-activity-log-cleanup.md)
> §"Phase 1 — Password reset flow" for the implementation plan that
> ships now (token TTL 2h per D3, etc.).  Original plan retained
> below for reference.


**Goal.** User forgets password, recovers via email, no pre-existing
session required.

**Test first:**
- `src/tests/password-reset-flow.test.js`:
  - `POST /auth/forgot-password` with valid email → 200 + email queued +
    token row created + hashed in DB (raw token never persisted).
  - `POST /auth/forgot-password` with unknown email → 200 (same response
    shape — no email-enumeration oracle), no token row.
  - `POST /auth/reset-password` with valid unexpired token + new password
    → 200 + password updated + token marked `used_at` + all sessions for
    that user revoked.
  - Replay attack: same token, second call → 401 `TOKEN_USED`.
  - Expired token (>30 min): → 401 `TOKEN_EXPIRED`.
  - Reset flow bypasses lockout (see Phase 4 risk note).

**Files:**
- `src/database.js` — new table:
  ```
  CREATE TABLE password_reset_tokens (
    id TEXT PRIMARY KEY,                 -- prt_<16 hex>
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,     -- sha256(raw)
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,                        -- NULL until consumed
    requester_ip TEXT,
    consumer_ip TEXT
  );
  CREATE INDEX idx_prt_user_unused
    ON password_reset_tokens(user_id) WHERE used_at IS NULL;
  ```
- `src/domain/password/reset-tokens.js` (new) — create / consume / invalidate.
  64 bytes of `crypto.randomBytes`, hex-encoded, sha256-hashed at rest.
- `src/services/emailService.js` — new `sendPasswordResetEmail(email,
  resetUrl)` template.
- `src/routes/auth.js` — two new routes, both `authRateLimit`-guarded.
- `src/domain/oauth/prune-scheduler.js` — extend existing pruner to also
  delete expired `password_reset_tokens` (keeps the "one scheduler to rule
  them all" pattern from M3).

**Observability:**
- Timeline logs: `password_reset_requested`, `password_reset_email_sent`,
  `password_reset_consumed`, `password_reset_invalid_token`,
  `password_reset_expired_token`.
- Audit entries for all of the above.

**Risks (critical).** The reset flow is the #1 account-takeover surface.
- Tokens single-use (enforced via `UNIQUE` + `used_at` check in a
  transaction).
- Tokens hashed at rest (raw only in email link; DB compromise ≠ token
  compromise).
- 30-minute TTL.
- On successful reset, delete **all** session store rows for the user so
  an attacker who had established a session can't ride it through.
- Response shape identical for known/unknown email to prevent
  email-enumeration.
- Reset URL uses `secrets.compare`-style constant-time comparison server-side.

**Exit criteria.** All the above tests green + live smoke (MailHog) confirms
the email link works end-to-end.

### Phase 6 — Change password (authenticated)

> **🟢 SUPERSEDED by F5.2 P2** (active).  See F5.2 §"Phase 2 — Change
> password + session revocation".  Original plan retained below.


**Goal.** A logged-in user can change their password without going through
the reset email dance.

**Test first:**
- `src/tests/password-change-flow.test.js`:
  - `POST /auth/change-password` with wrong `current_password` → 401.
  - With right current but weak new → 400 with the policy reason.
  - Happy path → 200 + hash rotated + **all OTHER sessions** for this user
    revoked (current session stays logged in).
  - Audit event emitted, `user_identity_links.last_used_at` touched if F4
    integration is in scope (see Phase 7).

**Files:**
- `src/routes/auth.js` — new `POST /auth/change-password`. Requires
  authenticated session (not Bearer — Bearer callers use the master-token
  regenerate endpoint, different trust boundary).
- `src/domain/password/session-revocation.js` (new) — helper that
  deletes every session row for a given user_id from the session store,
  excepting the current `sid`.

**Observability:**
- `logger.info('password_changed', { userId, other_sessions_killed: N })`.
- Audit: `password_changed`.

**Risks.**
- If we kill the current session too, the user is kicked out mid-flow and
  needs to re-login — poor UX. Explicit exclusion of current `sid` avoids
  this but requires knowing the current session's ID at the handler, which
  `express-session` exposes as `req.sessionID`. Confirm during impl.

**Exit criteria.** Integration test with two browsers (supertest cookie
jars) proves session A stays logged in and session B is 401 after the
password change.

### Phase 7 — F4 integration (optional — GO/NO-GO at Phase 0)

> **🟢 SUPERSEDED by F5.2 P3** (active).  See F5.2 §"Phase 3 —
> Dashboard UI surface" — split into P3.1 (LogIn.jsx), P3.2
> (SignUp.jsx), P3.3 (forgot/reset pages), P3.4 (change-password
> panel).  Original plan retained below.


**Goal.** Represent password auth as a row in `user_identity_links` so
*"how does this user authenticate"* is a single SELECT, not a union of
`users.password_hash IS NOT NULL` and `user_identity_links`.

**Decision gate.** If the F4 `user_identity_links` rollout has stabilized
by the time we reach this phase and no Google/GitHub/Facebook edge cases
are still in flight, **do it**. If F4 is still receiving hotfixes, **defer
to F5.3**.

**If in scope:**
- On register: also insert `('password', users.username, user_id, …)` row
  into `user_identity_links`.
- Migration: backfill one row per existing user with a non-null
  `password_hash` **AND** `password_hash != '!seed-owner-nologin!'` **AND**
  `id != 'owner'`. The `owner` seed row is infrastructure (ADR-0015 Option
  A), not a user account — see "Out-of-scope infrastructure" at the top of
  this doc. Backfilling it would create a phantom identity link for a row
  that can't be logged into.
- On password change: update `last_used_at` on the row.
- On account deletion (future): `ON DELETE CASCADE` already handles it.
- Tripwire: every `users` row with non-null `password_hash` **EXCEPT**
  `id='owner'` **AND** `password_hash != '!seed-owner-nologin!'` has a
  matching `user_identity_links` row where `provider='password'`. The
  exclusion clause is mandatory — without it the tripwire would
  permanently red-flag a healthy DB.

**Exit criteria.** F4 ADR-0018 updated to document the `password` provider
convention.

### Phase 8 — Frontend (F5.2)

**Goal.** Surface everything in the dashboard UI. Nothing in F5.1 is
user-visible until this ships.

**Pages to add/modify:**

| File | Change |
|------|--------|
| `LogIn.jsx` | Add email + password + submit below OAuth buttons. "Forgot password?" link under submit. Handle `ACCOUNT_LOCKED` with countdown. Handle 2FA TOTP prompt (already on server). |
| `SignUp.jsx` | Add email + password + confirm-password + strength meter. Reuse Terms/Privacy checkboxes. |
| `ForgotPassword.jsx` | New page. Single email input. 200 response shows generic "check your email" regardless of existence (prevents enumeration). |
| `ResetPassword.jsx` | New page at `/dashboard/reset-password?token=<hex>`. Token validated on mount via a server-side preview endpoint (`GET /auth/reset-password/:token/preview` returning `{valid: bool, expired: bool}`). New-password form. On success, redirect to LogIn with banner. |
| `Settings.jsx` | New "Change password" card. Current + new + confirm. On success, toast + stay on page. |

**Test first:**
- `src/tests/ui-password-flows.test.jsx` — React Testing Library:
  - LogIn renders password field, submit button disabled until both filled.
  - SignUp strength meter reflects policy state.
  - ResetPassword rejects expired token with friendly message.
  - Change-password shows current-password-wrong error inline.
- Browser smoke via Chrome DevTools MCP (recorded as script in
  `.context/sessions/F5-browser-smoke.md`):
  - Register → logout → login → forgot → reset email → reset → login new.

**Files:**
- `src/public/dashboard-app/src/pages/LogIn.jsx`
- `src/public/dashboard-app/src/pages/SignUp.jsx`
- `src/public/dashboard-app/src/pages/ForgotPassword.jsx` (new)
- `src/public/dashboard-app/src/pages/ResetPassword.jsx` (new)
- `src/public/dashboard-app/src/pages/Settings.jsx`
- `src/public/dashboard-app/src/utils/api.js` — add the 5 new calls.
- `src/public/dashboard-app/src/App.jsx` — register two new routes.

**Observability.** All front-end calls log `fetch` errors to the existing
`logger.warn` pipeline (`src/public/dashboard-app/src/utils/logger.js`).

**Risks.**
- If a user has only an OAuth identity (no password set) and tries to
  change-password from Settings, the flow should say "You don't have a
  password — set one here" and call a new `/auth/set-initial-password`
  endpoint. That variant gets its own sub-test.

**Exit criteria.** Full browser smoke green; dashboard rebuild succeeds;
docker smoke container shows no regressions in OAuth paths.

### Phase 9 — Security regression matrix + atomic commit

**Goal.** Ship F5.1 (and, when done, F5.2) as atomic commits with a
comprehensive tripwire suite so no future refactor silently re-introduces
any of the shadow paths.

**Tripwires added to `src/tests/security-regression.test.js`:**
- No `bcrypt.hashSync` or `bcrypt.compareSync` in `src/routes/auth.js`
  (the boot-time master-token hashSync in `src/index.js:3321` and the
  master-token-mint path in `src/routes/auth.js` are explicitly out of
  scope — they hash tokens, not passwords, see "Out-of-scope
  infrastructure").
- No inline `/auth/register` or `/auth/login` handlers in `src/index.js`.
- `src/auth.js` does not exist.
- `password_reset_tokens` table has `token_hash` (never a raw-token column).
- Reset-token creation uses `crypto.randomBytes(>= 64)`.
- Reset-token consume path is wrapped in a `db.transaction(...)`.
- Change-password handler calls `session-revocation.revokeOtherSessions(
  userId, currentSid)`.
- `LogIn.jsx` / `SignUp.jsx` use `<input type="password">` (catches
  accidental removal).

**Atomic commits (suggested):**

- `commit 1 — feat(auth): F5.1 step 1 — consolidate password routes to
  src/routes/auth.js (delete shadow paths)`
- `commit 2 — feat(auth): F5.1 step 2 — bcrypt cost 14 + upgrade-on-login`
- `commit 3 — feat(auth): F5.1 step 3 — HIBP k-anonymity check + common-
  password blocklist`
- `commit 4 — feat(auth): F5.1 step 4 — per-email account lockout`
- `commit 5 — feat(auth): F5.1 step 5 — password reset flow + reset-token
  table + email template`
- `commit 6 — feat(auth): F5.1 step 6 — change-password + session
  revocation`
- `commit 7 — feat(auth): F5.1 tripwires + regression matrix`
- `commit 8 — feat(dashboard): F5.2 — password login/register UI + forgot/
  reset/change pages`
- `commit 9 — docs(f5): ADR-0019 + ADR-0020 + F5 completion doc`

Each commit independently green on the full Jest suite. F5.1 commits 1–7
can ship without the UI (F5.2). F5.2 can ship independently once F5.1
lands and stabilizes.

## Dependencies

- **Depends on:** F4 (shipped 2026-04-24). F4's `user_identity_links` is
  used (optionally) in Phase 7.
- **Blocks:** Any future work that assumes non-OAuth login exists
  (e.g. "invite team member by email with temporary password").

## Design decisions (seeking user approval)

The following defaults are baked into the plan above; override any of them
before we start Phase 1.

1. **Hashing primitive.**
   - **(a) Recommended:** bump bcrypt cost 12 → 14 now (zero dep change,
     upgrade-on-login handles existing users). Defer argon2id to F5.3.
   - (b) Jump straight to argon2id via `@node-rs/argon2` (native, fast)
     with upgrade-on-login from bcrypt. Adds one native dep to the Docker
     build.
   - (c) Stay at bcrypt 12.

2. **Account lockout storage.**
   - **(a) Recommended:** DB-backed (`user_login_attempts` table) —
     matches the rest of the project's SQLite-first pattern.
   - (b) Add Redis dependency for hot-path counters.

3. **Session revocation on password change.**
   - **(a) Recommended:** revoke all OTHER sessions, keep current. Better
     UX.
   - (b) Revoke everything incl. current; force re-login. Stricter but
     friction-heavy.

4. **Rate-limit scope.**
   - **(a) Recommended:** keep existing per-IP `authRateLimit` + add
     per-email lockout (Phase 4). Both layers, belt & braces.
   - (b) Per-IP only.

5. **HIBP on API failure.**
   - **(a) Recommended:** fail-open (allow registration), log warning,
     audit. Availability > absolute policy.
   - (b) Fail-closed (block registration until HIBP is reachable).

6. **F4 integration (Phase 7).**
   - **(a) Recommended:** GO, assuming F4 is stable by the time we get
     there. Unified "how does this user log in" table.
   - (b) Defer to F5.3.

7. **Email identifier requirement.**
   - **(a) Recommended:** require email on password registration going
     forward (currently optional). Backfill is N/A because no password
     user exists without an email in the running DB.
   - (b) Keep email optional; fall back to a username-only recovery code.

8. **Milestone split.**
   - **(a) Recommended:** F5.1 (backend, 7 commits, no UI change) →
     ship & stabilize → F5.2 (frontend UI, 1–2 commits) → F5.3 (argon2id
     later).
   - (b) Ship F5.1 + F5.2 as one campaign.

## Testing strategy (aggregated)

- **Unit.** `password-hash.js`, `hibp.js`, `lockout.js`, `reset-tokens.js`,
  `session-revocation.js`, `isStrongPassword`.
- **Integration (supertest).** Full register → login → forgot → reset →
  change-password → logout flow against the live Express app with a
  disposable SQLite.
- **Security regression (static).** Tripwires above, plus grep-based
  guards against reintroduction.
- **Browser smoke (Chrome DevTools MCP).** Happy path + lockout + reset
  email received (MailHog) + 2FA interaction.
- **Load.** Login p99 latency before/after the cost bump. Capture in
  ADR-0019.

## Risks & rollback (aggregated)

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Shadow route deletion breaks a test we didn't find | Low | High | Phase 0 canary + full grep + suite gate. |
| bcrypt cost 14 blows p99 latency | Medium | Medium | Env-var `PASSWORD_HASH_COST` for instant rollback to 13. |
| HIBP outage blocks all registrations | Medium | High | Fail-open (design decision 5.a) + alarm. |
| Lockout DoS: attacker locks target user | Medium | Medium | Reset-email path bypasses lockout; per-IP limit blunts the attack cost. |
| Reset-email delivery delays | High | Medium | 30-min TTL (not 5-min); "resend" button with per-email cooldown. |
| Session-revocation on password change logs the user out | Low | Low | Exclude current `sid` explicitly. |
| Deleting `src/auth.js` breaks an `/auth/has-users` consumer | Low | Low | Port the one endpoint to `src/routes/auth.js` first. |

## Artifacts

- **ADR-0019** — Password hashing choice (bcrypt 14 now, argon2id roadmap).
- **ADR-0020** — HIBP integration: fail-open vs fail-closed.
- **Session note** — `2026-XX-XX-f5-phase0-audit.md` (after Phase 0).
- **Completion doc** — moves to `.context/tasks/completed/F5-…md` at F5.1
  and F5.2 ship points.

## Outcome (fill in when completing)

- Summary of what actually landed: …
- Deviation from plan and why: …
- Follow-ups created (new task IDs): …
- Lessons learned: …
