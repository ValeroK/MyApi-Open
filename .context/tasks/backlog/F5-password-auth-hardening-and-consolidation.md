# Task brief — Password auth: consolidate, harden, and surface in UI

## Identity

- **ID.** `TBD` (assigned when milestone opens; parked as follow-up `F5`).
- **Title.** Password register/login is implemented on the backend but has no
  UI entry point; also has three duplicate route files. Consolidate, harden,
  and surface in the login UI.
- **Milestone.** TBD — likely bundled with M9 (Frontend & output hygiene) or
  its own auth-hardening milestone.
- **Plan reference.** N/A (post-F4 follow-up, surfaced during F4 scoping on
  2026-04-25).
- **Workstream.** WS-backend + WS-frontend.

## Status

- **State.** backlog (filed 2026-04-25)
- **Assignee.** anyone
- **Started.** —
- **Target done.** After F4 ships, opportunistic.
- **Actually done.** —

## Why (1-paragraph context)

During F4 scoping we confirmed that `src/public/dashboard-app/src/pages/LogIn.jsx`
and `SignUp.jsx` have **zero** password input fields and do not call
`/api/v1/auth/login` or `/api/v1/auth/register` — the frontend is OAuth-only.
Meanwhile, the backend has **three** duplicate password-auth code paths:
`src/index.js:6823` (`POST /api/v1/auth/register`, uses async `bcrypt.hash` at
cost 12 + beta slot gate), `src/routes/auth.js:223` (another
`POST /api/v1/auth/register`), and `src/auth.js:13` (a third `router.post` using
synchronous `bcrypt.hashSync`). Any of these could be hit if reachable via
routing; the exact order is unverified. That's a maintenance hazard (code drift
between three password-hashing implementations) and a security hazard (whichever
route "wins" at runtime might be the weakest). F5 consolidates to one route, lifts
it to modern primitives, and actually wires it into the UI if the product decision
is to support password auth at all.

## What (scope + explicit non-goals)

- In scope:
  - **Product decision first:** do we want password auth in the product at
    all, or is OAuth-only (Google / GitHub / Facebook) the end state? The
    answer drives every other decision below.
  - If yes to password auth:
    - Consolidate to **one** route file (suggested: keep `src/index.js:6823`
      since it has the async bcrypt + beta slot gate; delete the two duplicates
      after asserting no call sites / mounts point to them).
    - Upgrade bcrypt → argon2id (or at minimum bump bcrypt cost to 14 after
      benchmarking) via `src/lib/crypto-security.js`.
    - Password policy: minimum length, breach check via HIBP k-anonymity API
      (offline fallback on API failure), optional blocklist of common
      passwords.
    - Account lockout after N failed attempts per email + per IP.
    - Password reset via email token (new flow).
    - Change-password endpoint for authenticated users (re-auth required).
    - Force session revocation on password change.
    - UI: add password input to `LogIn.jsx`, a "forgot password" link, a
      proper register flow in `SignUp.jsx`, and a change-password card in
      `Settings.jsx`.
  - If no to password auth:
    - Delete all three backend route paths.
    - Decide on a legal/compliance path for "my OAuth provider broke, how do
      I get in?" (recovery email? admin override? we need something).
- Out of scope:
  - OAuth scope separation (that's F4).
  - 2FA — already implemented.
  - WebAuthn / passkeys — a possible F6.
- Non-goals:
  - Passwordless magic-link login (different feature; different brief).

## How (implementation plan — only if "yes")

1. Product decision + ADR ("Does MyApi support password auth?").
2. Inventory all three current route files; confirm which (if any) are
   actually mounted by `app.use(...)` and which are orphaned modules. Delete
   orphans in a prep commit.
3. Add argon2id (or bcrypt cost bump) via `src/lib/crypto-security.js` with a
   migration that re-hashes on next successful login (detect by hash prefix
   `$2a$` vs `$argon2id$`).
4. Add HIBP breach-check helper (k-anonymity: send SHA-1 prefix, check
   returned suffix list). Offline test fixture so regression tests don't hit
   the live API.
5. Add lockout (redis or in-DB counter with exponential cooldown).
6. Password reset flow: new endpoints + email template (wire into existing
   `emailService.js`).
7. UI: password field on `LogIn.jsx`; register form on `SignUp.jsx`; reset
   flow pages; change-password in `Settings.jsx`.
8. After F4 ships, consider whether `user_identity_links` should gain a
   `provider='password'` row convention so "how does this user authenticate"
   is one table. Probably yes — keeps identity linkage unified.
9. Security regression tests (§5.4 of `plan.md`): brute force protection,
   reset-token entropy and single-use, session revocation on password
   change.
10. Live smoke + docker regression + atomic commit(s).

## Dependencies

- Depends on: F4 (for the unified `user_identity_links` pattern; not strictly
  blocking but cleaner to land after).
- Blocks: Any work that assumes "users can log in without OAuth".

## Testing

- Unit tests: hashing primitives, password policy, reset-token generation,
  HIBP check behaviour on API failure.
- Integration tests: full register → login → change-password → reset-password
  flows via supertest.
- Security regression tests: brute-force lockout, reset-token single-use +
  entropy, session invalidation on password change, hash-upgrade-on-login.
- Manual verification: register via UI, log out, log in with password, reset
  via email link, change password, confirm old sessions are revoked.

## Risks & rollback

- Lockout false positives (user travel, shared IPs). Mitigated by per-email
  cooldown with exponential backoff + admin override endpoint.
- HIBP API outage → fall back to offline blocklist; never block registration
  silently.
- Password reset flow is the #1 attack surface for account takeover. Tokens
  must be single-use, short-TTL, entropy ≥ 256 bits, delivered only to the
  registered email, and invalidate all other sessions on successful reset.

## Artifacts

- ADR(s): "Does MyApi support password auth?" + "Password hashing choice".
- Related session notes: `../sessions/2026-04-25-f4-scoping.md` (to be written
  when F4 wraps).

## Outcome (fill in when completing)

- Summary of what actually landed: …
- Deviation from plan and why: …
- Follow-ups created (new task IDs): …
- Lessons learned: …
