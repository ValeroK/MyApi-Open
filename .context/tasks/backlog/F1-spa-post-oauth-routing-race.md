# Task brief — Fix SPA routing race after OAuth confirm-gesture completes

## Identity

- **ID.** `TBD` (to be assigned as `T9.x` when M9 opens; parked as follow-up `F1`
  until then).
- **Title.** SPA routes freshly-authenticated users to `/` instead of
  `/dashboard/` after the M3 confirm-gesture click.
- **Milestone.** M9 — Frontend & output hygiene (best fit: auth UX sits next to
  CSP + error-envelope work).
- **Plan reference.** N/A (not in §6.3 risks — this is a UX regression
  surfaced by the M3 live smoke on 2026-04-24).
- **Workstream.** WS-frontend.

## Status

- **State.** backlog (follow-up from M3 live smoke)
- **Assignee.** anyone
- **Started.** —
- **Target done.** Opportunistic; bundle with M9.
- **Actually done.** —

## Why (1-paragraph context)

During the M3 live-smoke on 2026-04-24 the operator completed the OAuth
confirm-gesture (`POST /api/v1/oauth/confirm`) successfully — server-side
session was established, `first_confirmed_at` was stamped, and
`storeOAuthToken` persisted the token with `provider_subject`. The `LogIn.jsx`
screen then called `redirectAfterLogin('/dashboard/...')` as expected. But
the dashboard shell re-mounted in an unauthenticated state, `App.jsx`'s
`redirectToLoginOnce()` effect fired before the session had been re-fetched,
and the user was bounced back to `/`. It took two manual clicks on "Open
Dashboard" for the auth hydration to settle. This is a **UX defect, not a
security defect**: the backend session is fine, and no unauthorized screen
was rendered. But for a returning user whose whole journey is "click Google →
see dashboard", this is the visible failure.

## What (scope + explicit non-goals)

- In scope:
  - The race in `App.jsx` between the one-shot `redirectToLoginOnce()` effect
    and the auth-state hydration that follows a fresh session cookie.
  - The "open dashboard twice" follow-on — the first click races too.
  - An explicit test (Playwright preferred; Vitest + RTL acceptable for the
    unit-level race) that simulates "cookie just arrived, store is still
    empty" and asserts the redirect does NOT fire.
- Out of scope:
  - Rebuilding the auth store or routing architecture. Surgical fix only.
  - The onboarding wizard's "Complete your profile" screen (that's `F2`).
  - Changing the server-side confirm-gesture flow (M3 closed cleanly).
- Non-goals:
  - Removing `redirectToLoginOnce()` entirely — it catches the legitimate
    unauthenticated case. The fix must keep that behaviour intact.

## How (implementation plan)

1. Reproduce in smoke: revoke master token, trigger a returning-user login,
   observe the bounce to `/`. Capture a browser trace.
2. Trace `App.jsx`'s `useEffect` ordering around `redirectToLoginOnce()` and
   the auth-store hydration. The hypothesis is that the effect reads the
   store synchronously before the `fetch('/auth/me')` response lands.
3. Fix: add a guard (`authHydrated` flag or `isLoading` gate on the store)
   that delays the redirect until the first `/auth/me` call has resolved
   either way.
4. Add a failing unit test first (Vitest + RTL): mount `<App>` with a
   just-arrived session cookie but empty store, tick the effect, assert no
   `window.location.href` assignment to `/`.
5. Implement the guard; assert the test goes green.
6. Live-smoke re-verify in `docker:smoke`: a fresh returning-user login
   lands on `/dashboard/` in one hop.

## Dependencies

- Depends on: —
- Blocks: — (not blocking, but worth bundling with M9 so the fix ships with
  the rest of the frontend hygiene pass).

## Testing

- Unit tests to add: Vitest + RTL test simulating the post-login-hydration
  race described above. Asserts the `one-shot redirect` effect waits for
  `authHydrated === true`.
- Integration tests to add: none required at the Jest layer (this is a
  client-side effect).
- Security regression tests (§5.4 of `plan.md`): none — this is UX, not
  security. Do not conflate with the session-fixation closure in T3.7.
- Manual verification steps: revoke master token, re-login via Google,
  expect one hop to `/dashboard/`.

## Risks & rollback

- What breaks if this ships wrong? If the guard is too aggressive, a
  legitimately-unauthenticated user stays stuck on `/` instead of being
  bounced to the login screen — i.e. the opposite UX regression. The
  unit test above is written to catch the too-tight variant too.
- How do we roll back? Revert the single SPA commit.
- What should we watch in logs/metrics for 24h after? Client-side
  correlation-ID'd auth requests post-OAuth — is the `/auth/me` latency
  budget being respected?

## Artifacts

- ADR(s): — (too small for an ADR; a PR description + this task brief is
  enough).
- Related session notes: `../sessions/2026-04-24-m3-smoke.md`.

## Outcome (fill in when completing)

- Summary of what actually landed: …
- Deviation from plan and why: …
- Follow-ups created (new task IDs): …
- Lessons learned: …
