# Session — 2026-04-24 — F5.1 Phase 1a: port hardening from shadow routes

- **Date.** 2026-04-24
- **Participants.** Cursor AI agent (F5.1 lead) + human reviewer.
- **Duration.** ~75 min.
- **Related work.** Follows directly from the Phase 0 audit
  (`2026-04-24-f5-phase0-audit.md`). Implements the test-first port
  step of `F5-password-auth-hardening-and-consolidation.md` Phase 1 with
  the human reviewer's choice of split (P1a port-and-fix → P1b delete).

## Goal

Bring every security/compliance behaviour that lived only in the shadow
routes (`src/index.js:6860/6887`) onto the live winning router
(`src/routes/auth.js`) **before** the shadows are deleted in Phase 1b.
The review surfaced that the supposedly-cleanup task was actually
hiding a latent **2FA-bypass on password login** because the shadow
route owning the TOTP gate was unreachable after `newAuthRoutes` won
the `/api/v1/auth/*` mount.

## Parity gap surfaced during planning

| Behaviour                                       | Shadow (`index.js`) | Winner (`routes/auth.js`) pre-P1a |
|-------------------------------------------------|:-------------------:|:---------------------------------:|
| 2FA TOTP check on password login                |          ✅          |                ❌                  |
| TOTP replay protection (`isTotpCodeUsed`)        |          ✅          |                ❌                  |
| `authRateLimit` on /login, /register, /token-login |       ✅          |                ❌                  |
| Audit log `user_register`                       |          ✅          |                ❌                  |
| Audit log `user_login`                          |          ✅          |                ❌                  |
| Audit log `failed_login` + `2fa_failed_attempt` |          ✅          |                ❌                  |
| `alerting.trackFailedLogin(ip)`                 |          ✅          |                ❌                  |
| `registerUserSession` (SOC2 CC6 cap)            |          ✅          |                ❌                  |
| `getOrEnsureUserWorkspace` on login             |          ✅          |                ❌                  |
| Username OR email login                         |          ✅          |          ❌ (email-only)           |
| Consent timestamps on register                  |          ✅          |                ❌                  |

The dashboard had no password-login UI yet (that is F5.2), so the
2FA-bypass was not exploitable through the UI; but the endpoint is
publicly reachable, so any curl caller with valid credentials would
have skipped 2FA entirely.

## What landed (test-first)

1. **Red contract suite first.**
   `src/tests/f5-password-auth-parity.test.js` — 13 tests pinning every
   behaviour above. Initial run: 12 red, 1 false-green (the trivial
   "valid TOTP succeeds" — kept as documentation of the happy path).

2. **Single source of truth for shared state.** New module
   `src/lib/authHardening.js` owns the **one** `authRateLimit`
   middleware, the **one** SOC2 `userSessionRegistry` Map, and the
   **one** TOTP-replay `usedTotpCodes` Map. Without this, any duplicate
   would have doubled the effective rate budget and re-opened the
   replay window across the password vs. OAuth-2FA gates.

3. **Refactored `src/index.js`** to import these helpers from the
   shared module (zero behavioural change). Verified the post-refactor
   tree still passed all 561 pre-existing tests + 22 skipped before
   any feature port.

4. **Ported features into `src/routes/auth.js`**:
   - `/login`: `authRateLimit` + username-or-email + `failed_login`
     audit + `alerting.trackFailedLogin` + 2FA TOTP check (window:2) +
     replay protection (`isTotpCodeUsed`/`markTotpCodeUsed`) +
     `2fa_failed_attempt` audit + `getOrEnsureUserWorkspace` +
     `req.session.currentWorkspace` + `registerUserSession` (after
     `req.session.save`) + `user_login` audit.
   - `/register`: `authRateLimit` + accepts and persists
     `accepted_terms_at` and `accepted_privacy_policy_at` (with
     graceful degradation to pre-migration schemas) + `user_register`
     audit.
   - `/token-login`: `authRateLimit`.

5. **One pre-existing test tightened.**
   `src/tests/phase3.audit-security.test.js` previously seeded an
   audit row with a hard-coded `workspaceId: 'ws_test'` and read it
   back via the audit endpoint. That endpoint scopes by
   `workspace_id = currentWorkspace OR workspace_id IS NULL`. Before
   P1a no `currentWorkspace` was set, so the cross-workspace seed
   leaked through; after P1a the (now-correct) workspace scoping
   filters it. Removing the unrelated `workspaceId` from the seed
   keeps the test focused on session-auth'd audit visibility instead
   of relying on the leak.

## Test posture

| Stage                                         | Pass | Skip | Fail |
|-----------------------------------------------|-----:|-----:|-----:|
| Phase 0 baseline                              |  560 |   22 |    0 |
| After authHardening.js extraction             |  561 |   22 |   12 (the new red F5 suite) |
| After feature port                            |  573 |   22 |    0 |

## Live smoke (against `myapi-smoke` container)

| Step | Result |
|---|---|
| `POST /auth/register` (new user) | **201 Created** + `user_register` audit row written with `requester_id = <newId>` |
| `POST /auth/login` by **email** | **200 OK** with `masterToken` |
| `POST /auth/login` by **username** | **200 OK** with `masterToken` |
| `POST /auth/login` with bad password | **401** + `failed_login` audit row written |
| Enable 2FA via direct DB seed |  Persisted `totp_secret` + `two_factor_enabled=1` |
| `POST /auth/login` (2FA on, no `totpCode`) | **401** + `requires2FA: true` (was 200 pre-P1a) |
| `POST /auth/login` (2FA on, valid `totpCode`) | **200 OK** |
| Replay same TOTP code | **401** `2FA code already used. Wait for the next code.` |

The 2FA bypass and TOTP replay window are confirmed closed live.

## Decisions captured

- **State sharing approach.** Extracted to `src/lib/authHardening.js`
  rather than duplicating per-handler maps. Rationale: any two-Map
  implementation would have silently doubled the effective per-IP
  attempt budget and split the TOTP replay window between handlers,
  re-opening exactly the gap we were trying to close.
- **Bcrypt cost.** Kept at 12 in the live register path (matching the
  pre-existing winner) rather than routing through `createUser()`
  which currently hashes at cost 10. The cost-14 upgrade with
  upgrade-on-login is scheduled for F5.2 / Phase 2 of the F5 plan.
- **Test-first discipline.** All 13 contract tests written and
  observed RED before any production-code edit landed.
- **Phase split.** Reviewer chose `P1a (port + fix) → P1b (delete
  shadows)` over a single mega-commit so the latent 2FA-bypass fix
  ships in its own visible commit.

## Open follow-ups

- **F5.1 Phase 1b (next).** Add three static delete-tripwires to
  `src/tests/security-regression.test.js`, then delete `src/auth.js`,
  the inline `/auth/register` and `/auth/login` handlers in
  `src/index.js:~6860/6887`, the `require('./auth')` at index.js
  line 2233, and the `app.use('/api/v1', authRoutes)` mount. Re-run
  Jest + live smoke. Single atomic commit.
- **F5.2 (later).** Surface password login + register in the dashboard
  UI. The backend is now ready; only the React work remains.
- **F5 Phase 2 (later).** Bcrypt cost 14 with upgrade-on-login + HIBP
  k-anonymity check + per-email account lockout + password reset and
  change flows.
