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

- **State.** **Pass 1 + Pass 2 landed on main (2026-04-24)**. F3 is now
  ✅ **Complete**. Pass 1 = `959059c` (drop `max_age=0` + unit +
  live-smoke coverage). Pass 2 = atomic commit shipping the adapter
  default flip, `invalid_grant` recovery, `REAUTH_REQUIRED` envelope,
  dashboard banner, and ADR-0017.
- **Assignee.** anyone
- **Started.** 2026-04-24.
- **Target done.** Same week.
- **Actually done.** 2026-04-24.

### Pass 1 (landed 2026-04-24, commit `959059c`)

- Dropped `max_age=0` from the Google login-mode authorize URL in
  `src/index.js`. `max_age=0` was forcing Google to treat every returning
  user as unauthenticated, which cascaded into a full re-consent screen on
  every login. With only `prompt=select_account`, Google silently passes
  returning users through (or shows the picker for multiple-account users)
  and only re-surfaces consent on genuine grant changes (revoke, scope
  upgrade, brand-new account) — which is the correct threat model.
- **Unit-test coverage added** to
  `src/tests/oauth-security-hardening.test.js`:
  - `prompt=select_account`, `max_age=null` on `forcePrompt=1` login.
  - `prompt=null`, `max_age=null` on explicit `forcePrompt=0` (agent
    silent flow).
  - `prompt=select_account`, `max_age=null` on landing-modal snake_case
    `force_prompt=1` path (regression guard — that path falls through to
    the `mode==='login'` default; pinning the behavior so any future
    default change is visible in review).
  - `prompt=consent`, `max_age=null` on `mode=connect` — documents the
    current adapter-default fall-through and leaves an explicit Pass 2
    marker.
- **Live smoke test harness added** in
  `src/tests/oauth-authorize-url-live-smoke.test.js`, runnable against
  any MyApi deployment via `SMOKE_URL=... npm run smoke:oauth`. Skipped
  silently in normal `npm test`. Catches failure modes unit tests miss
  (stale Docker image, bind-mount/COPY mismatch, env-var misconfig).
- **Browser-level verification** performed 2026-04-24 with Chrome
  DevTools MCP against the running smoke container:
  all three login entry points (landing modal, React LogIn.jsx, React
  SignUp.jsx) confirmed to emit `prompt=select_account`, no `max_age`.

### Pass 2 (landed 2026-04-24 — code hygiene + recovery + ADR)

All four work items landed in one atomic commit:

- **Adapter default flip.** `src/services/google-adapter.js:38` now
  defaults `prompt: 'select_account'` instead of `'consent'`.
  Connect-mode (the "Connect Google" button on the Services page) no
  longer has any path that forces the scope-approval screen by
  default. Callers that genuinely need forced consent still get it by
  passing `runtimeAuthParams: { prompt: 'consent' }`.
- **`invalid_grant` recovery.** `src/database.js` `refreshOAuthToken`
  now detects `result.body.error === 'invalid_grant'`, nulls the
  `refresh_token` column for that `(service, user)` pair, and returns
  `{ ok: false, error: 'invalid_grant', reauthRequired: true }`.
  Transient errors (5xx, network, `invalid_client`) continue to bubble
  up and do NOT clear the column — they're retryable.
- **`REAUTH_REQUIRED` surface.** `src/index.js`:
  - `/api/v1/services/:name/proxy` + `/execute`: when the stored token
    is expired AND (`refresh_token` is null OR the refresh returned
    `reauthRequired: true`), the handler returns
    `401 { error: 'REAUTH_REQUIRED', service, message }` and
    invalidates the in-memory token cache.
  - `/api/v1/oauth/status`: `connectionStatus` now emits
    `reauth_required` as a third state alongside `connected` and
    `disconnected`, exactly when the token row exists, isn't revoked,
    has a null `refresh_token`, and the access_token is expired.
- **Dashboard banner.**
  `src/public/dashboard-app/src/pages/ServiceConnectors.jsx` now has
  first-class `reauth_required` rendering: amber status chip, per-card
  "Reauthorize" button, and a top-of-page warning banner when any
  service is in the state.
- **Tests.** 12 new passing tests across 4 files:
  - `src/tests/oauth-refresh-invalid-grant.test.js` — 5 behavioural
    cases against a loopback HTTP mock of the token endpoint.
  - `src/tests/oauth-security-hardening.test.js` — 2 new: direct
    adapter unit test + HTTP-level connect-mode expectation flip.
  - `src/tests/oauth-authorize-url-live-smoke.test.js` — connect-mode
    live smoke expectation flipped.
  - `src/tests/security-regression.test.js` — 5 static-analysis
    tripwires locking the Pass 2 contract against silent refactors.
- **ADR-0017-oauth-prompt-policy.md** documents the full decision
  matrix for all three work items.
- **Regression.** Full Docker jest run: **36 / 37 suites, 504 pass /
  20 skip, exit 0** (up from 490 at M3 wrap-up; +14 from Pass 1 +
  Pass 2 combined).
- **Live smoke.** All 6 authorize-URL live-smoke tests pass against
  the Pass-2-patched smoke container (`SMOKE_URL=http://localhost:4500
  npx jest src/tests/oauth-authorize-url-live-smoke.test.js`),
  including the connect-mode flip.

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

## Outcome (2026-04-24)

- **Summary of what actually landed.** Two-pass delivery.
  - **Pass 1 (commit `959059c`).** Dropped `max_age=0` from Google
    login authorize URL; pinned `prompt=select_account` on login-mode
    with `forcePrompt=1`. Unit + live-smoke coverage. All observed
    returning-user consent-screen loops eliminated from that
    parameter.
  - **Pass 2 (this commit).** Flipped adapter default to
    `select_account` so `mode=connect` inherits the same UX.
    Implemented `invalid_grant` recovery in `refreshOAuthToken` (null
    the dead refresh_token, surface `reauthRequired: true`). Added
    `REAUTH_REQUIRED` envelope on proxy + execute, `reauth_required`
    state on `/oauth/status`, amber banner + per-card CTA in the
    Services page. ADR-0017 locks the policy.
- **Deviation from plan and why.** None material. Original plan called
  for "delete unconditional `forcePrompt=1` in LogIn.jsx" — investigation
  showed the hard-coding was cosmetic (server-side override already did
  the right thing in login mode), so the actual fix was server-side
  (Pass 1) + adapter default (Pass 2), not frontend. Plan otherwise
  followed to the letter.
- **Follow-ups created.** None required for F3 itself. F1 (SPA routing
  race) and F2 (onboarding wizard completion) remain separate and
  untouched.
- **Lessons learned.**
  1. `max_age=0` in OAuth URLs is a trap that explicitly forces
     re-consent even on valid grants — never hard-code it in a login
     path.
  2. Google's `invalid_grant` is a terminal state for a stored
     refresh_token; retrying is wasted bandwidth. Treat it as a signal
     to null the column and raise a user-visible CTA.
  3. Adapter defaults are policy. "The server override will save us"
     is wrong when a single new call site forgets the override. Make
     the adapter safe-by-default and the server's role becomes
     enforcement, not rescue.
  4. A live-smoke test harness (`SMOKE_URL=...`) that runs against a
     real deployment catches Docker-image-staleness bugs that pure
     unit tests miss. Worth the ~50ms per assertion for the
     confidence.
