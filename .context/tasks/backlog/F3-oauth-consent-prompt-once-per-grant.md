# Task brief — Only show the OAuth consent screen once per grant, not on every login

## Identity

- **ID.** `TBD` (to be assigned as `T3.10` or a new `M3.post` row when
  picked up; parked as follow-up `F3`). Up next per operator direction
  after the M3 wrap-up push on 2026-04-24.
- **Title.** Stop forcing `prompt=consent` on every login-mode OAuth
  authorize; let the provider show its own consent screen only when the
  grant actually needs it.
- **Milestone.** M3.post (UX follow-up after M3's security hardening).
- **Plan reference.** Not listed in §6.3 — this is a UX follow-up from the
  2026-04-24 live smoke. ADR-0006 / ADR-0014 / ADR-0016 define the
  surrounding security envelope this fix must respect.
- **Workstream.** WS-oauth.

## Status

- **State.** backlog → **queued for next work session** (operator direction
  2026-04-24).
- **Assignee.** anyone
- **Started.** —
- **Target done.** Same week.
- **Actually done.** —

## Why (1-paragraph context)

During the M3 live-smoke on 2026-04-24 the operator observed Google's
"deny / allow permissions" consent screen appearing on **every** login,
including the returning-user path where MyApi already has a valid grant and
a stamped `first_confirmed_at`. This is user-hostile — the user already
consented, MyApi's confirm-gesture screen (T3.7) already closes the
session-fixation variant of C3, and re-asking Google for consent every
single time adds nothing to the threat model we've actually closed. Root
cause: `src/public/dashboard-app/src/pages/LogIn.jsx` hard-codes
`forcePrompt=1` on the authorize URL for login-mode, which the
`src/index.js` authorize handler translates to Google's
`prompt=consent`. That was belt-and-suspenders defence during the original
signup hardening; it is redundant now that the DB-backed state + first-seen
confirm gesture are live. Removing it correctly still requires keeping the
flows that genuinely *need* to force re-consent (token revocation → reauth;
scope upgrade; fresh-device sensitive actions).

## What (scope + explicit non-goals)

- In scope:
  - Delete the unconditional `forcePrompt=1` on login-mode authorize URLs in
    `LogIn.jsx`.
  - Audit the server-side translation in `src/index.js` authorize handler:
    what does `forcePrompt=1` currently do, which `prompt=…` value does it
    send to Google / the other providers, and where else can it be set?
  - Decide and document when we *do* want `prompt=consent`:
    - Brand-new signup? — probably yes (explicit-consent signal).
    - Grant revoked and user is re-linking? — yes.
    - Scope upgrade? — yes.
    - Returning user, same scope, valid grant? — **no** (this is the
      user-visible fix).
  - Implement the gating. Likely: `LogIn.jsx` passes `forcePrompt=1` only
    for signup-mode or a re-consent flag, not for plain login.
  - Integration test in `src/tests/` that asserts the authorize URL for a
    plain returning-user login-mode does NOT carry
    `prompt=consent` (and does carry it for signup-mode / explicit
    re-consent).
- Out of scope:
  - Changing MyApi's own first-seen confirm-gesture screen (that's
    orthogonal — it fires on our side regardless of what Google shows).
  - Scope-upgrade UX (separate future task; only the "same scope" path is
    in scope here).
  - Changing the device-approval layer.
- Non-goals:
  - Removing `forcePrompt` entirely — keep the knob, tighten who turns it
    on.

## How (implementation plan)

1. Reproduce: boot `docker:smoke`, log in as a returning user, observe
   Google's consent screen. Capture the authorize URL's query string for
   evidence.
2. Audit: `rg -n "forcePrompt"` in `src/public/dashboard-app/` and
   `src/index.js`. Trace the full server-side translation to each
   provider's `prompt=` parameter (Google: `consent`; Microsoft:
   `consent`; others: provider-specific).
3. Red-first: new Jest supertest in
   `src/tests/oauth-authorize-handler.test.js` (or a new file)
   asserting:
   - `GET /api/v1/oauth/authorize/google?mode=login` **without**
     `forcePrompt` → authorize URL has no `prompt=consent`.
   - `GET /api/v1/oauth/authorize/google?mode=signup` → authorize URL
     has `prompt=consent` (explicit-consent signal for fresh grants).
   - `GET /api/v1/oauth/authorize/google?mode=login&forcePrompt=1` →
     authorize URL has `prompt=consent` (knob preserved).
4. Implement: flip the default in `LogIn.jsx` login-mode to omit
   `forcePrompt`. Keep it for signup-mode. Make sure the server-side
   authorize handler's default (`prompt` absent unless opted-in) matches
   Google's docs — a returning user with a valid grant will auto-approve;
   a user with a stale / revoked grant will see the consent screen
   naturally.
5. Live-smoke verify: revoke master token, rebuild, re-login as a returning
   user — expect one hop to `/dashboard/` with no Google consent screen.
   Re-run for signup-mode — expect the consent screen.
6. Security regression gate: add a row to
   `src/tests/security-regression.test.js` asserting the signup-mode path
   still ships `prompt=consent` so the new-grant explicit-consent signal
   is never silently lost.

## Dependencies

- Depends on: —
- Blocks: — (cosmetic / UX; not on any critical path).

## Testing

- Unit tests to add: authorize-URL shaping tests (see step 3 above).
- Integration tests to add: end-to-end authorize → callback →
  confirm-gesture test on login-mode asserting no `prompt=consent` on the
  second invocation.
- Security regression tests (§5.4 of `plan.md`): one new assertion
  locking the signup-mode `prompt=consent` contract.
- Manual verification steps: documented in step 5 above.

## Risks & rollback

- What breaks if this ships wrong? Two failure modes:
  1. **Over-reach:** we remove `prompt=consent` from signup mode too —
     signup stops surfacing the explicit consent UX. Caught by step 3 / 6
     tests.
  2. **Under-reach:** we leave `prompt=consent` on login mode for the
     first click (e.g. before sessionStorage caches the auth state) —
     user still sees consent on every login. Caught by live-smoke step 5.
- How do we roll back? Revert the single PR; hard-coded `forcePrompt=1`
  returns. No DB migration involved.
- What should we watch in logs/metrics for 24h after? OAuth authorize
  request count vs. callback completion rate. If removing the consent
  screen somehow *increases* drop-off, that's a red flag.

## Artifacts

- ADR(s): probably one — "when does MyApi force OAuth consent vs. defer to
  the provider's own cache?". Short; slots between ADR-0014 and ADR-0016.
- Related session notes: `../sessions/2026-04-24-m3-smoke.md`.

## Outcome (fill in when completing)

- Summary of what actually landed: …
- Deviation from plan and why: …
- Follow-ups created (new task IDs): …
- Lessons learned: …
