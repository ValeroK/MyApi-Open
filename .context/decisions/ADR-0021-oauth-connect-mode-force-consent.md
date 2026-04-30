# ADR-0021 — OAuth connect-mode forces `prompt=consent` on Google to guarantee a refresh token

- **Status.** Accepted
- **Date.** 2026-04-30
- **Decision makers.** @kobiv (with AI pair)
- **Related.** Refines part of [ADR-0017](./ADR-0017-oauth-prompt-policy.md) (connect-mode arm only); pairs with [ADR-0018](./ADR-0018-oauth-identity-vs-service-separation.md). F3 Pass 3.
- **Tags.** security / oauth / ux / backend

## Context

ADR-0017 (F3 Pass 2, 2026-04-24) flipped the Google adapter default from
`prompt=consent` to `prompt=select_account`, and ADR-0018 (F4) added
`include_granted_scopes=true` for connect-mode authorize URLs. Together
those two changes are correct for **login-mode** — returning users with a
valid identity grant are no longer re-consented on every sign-in, which
was the original UX regression. They are **wrong** for **connect-mode**.

Reproduction (2026-04-30, mailer.kv@gmail.com, observed by repo owner):

1. User clicks **Connect Google** in `/dashboard/services`.
2. Frontend `startOAuthFlow('google', { mode: 'connect' })` sends
   `forcePrompt=0` to `/api/v1/oauth/authorize/google`.
3. Server-side handler (`src/index.js`) sees `explicitForcePrompt === false`
   and NULLs `runtimeAuthParams.prompt`, suppressing the adapter's
   `select_account` default.
4. Outbound URL goes to Google with **no `prompt=`**, **`scope=openid email
   profile gmail.modify calendar.readonly drive.file`**,
   **`access_type=offline`**, **`include_granted_scopes=true`**.
5. mailer.kv@gmail.com had previously granted these exact scopes (see
   ADR-0017 context — same account where the F3 Pass 2 bug was first
   observed). Google's incremental-authorization path applies: the union of
   requested scopes equals the prior grant, no new approval is needed,
   **no consent screen renders**.
6. Google returns a fresh `access_token` (~1h lifetime) **without a
   `refresh_token`** because Google's documented policy is "refresh_token is
   only issued when consent is shown."
7. `oauth_tokens` row is stored with `refresh_token = NULL`,
   `expires_at = now + ~1h`.
8. ~1h later the access_token expires. The F3 Pass 2 dead-token branch in
   `/api/v1/services/:s/proxy` and `/oauth/status` correctly observes
   `refresh_token IS NULL && isTokenExpired(token)` and returns
   `REAUTH_REQUIRED`.
9. User clicks **Reauthorize** → exact same flow → exact same silent
   re-grant → exact same null `refresh_token`. **The system is on a
   stable bad fixed point: every connect produces a row that will break
   itself.**

Confirmed by direct DB inspection on 2026-04-30: `service_name='google'`
row exists with the full six-scope grant and `refresh_token IS NULL`,
created within the last second.

The root cause is that **connect-mode** is the inverse threat model of
**login-mode**. Login wants quiet returning-user UX; connect is "I am
asking Google to issue a long-lived offline grant for this agent to call
Drive/Gmail/Calendar on my behalf for months." Offline access is the
entire point of connect-mode — and Google's well-defined policy is "no
consent shown ⇒ no refresh_token." Combining the F3 Pass 2 quiet path
with the F4 incremental-authorization hint produces a connect flow that
silently fails to acquire the one piece of credential the connect was
supposed to acquire.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Revert F3 Pass 2 entirely — adapter default goes back to `prompt=consent`. | One-line change. Restores pre-F3 behavior. | Re-introduces the F3 Pass 1 + Pass 2 login-mode regression: every login re-prompts consent. Throws out the legitimate UX win. |
| B | Drop `include_granted_scopes=true` from connect-mode. | Forces Google to evaluate the full grant per request, which (under most circumstances) makes Google show a consent screen for sensitive scopes. | Breaks the genuine incremental-auth contract. If a user adds a *new* scope later (scope upgrade), Google won't fold the prior grant in, and the user is presented with a confusing "approve everything from scratch" screen. Loses the F4 "incremental upgrade" property. |
| C | Connect-mode forces `prompt=consent`. Login/signup-mode keeps F3 Pass 2's `select_account` (or no-prompt) defaults. Adapter default stays `select_account` (safe-by-default). Policy lives at the call site in `src/index.js`. | Refresh_token is guaranteed on every successful connect (Google's policy). Login UX win from F3 Pass 2 is preserved. Adapter remains safe-by-default per ADR-0017. The forced consent screen on connect is *the right UX* — it's the moment the user is granting offline access for an agent, and seeing the scope list is a security feature, not a bug. | Connect-mode users see a consent screen on every reconnect, even if they're re-granting the identical scope set. This is acceptable: connect is rare (once per service per device) and the consent screen is the explicit "I am giving an agent ongoing access to my data" moment. |
| D | Detect "row exists with `refresh_token IS NULL`" at authorize-time and only force `prompt=consent` in that case; otherwise keep silent reconnect. | Targets the exact bad state. Returning users with a healthy refresh_token still get the silent reconnect. | Adds a DB read to the authorize handler. The bad state can also arise on first connect (Google sometimes withholds refresh_token even on first grant if some prior internal state matches), so the conditional is unsound. Complexity > benefit. |

## Decision

We chose **Option C**:

1. In `src/index.js`'s `GET /api/v1/oauth/authorize/:service` handler,
   after the existing `explicitForcePrompt === false` block (which
   currently NULLs prompt for Google), add an unconditional override:
   ```js
   // F3 Pass 3 (ADR-0021): connect-mode for Google MUST request
   // prompt=consent so Google issues a refresh_token. Without consent
   // shown, Google's incremental-authorization path silently re-issues
   // an access_token with NO refresh_token, putting the row on a ~1h
   // fuse to REAUTH_REQUIRED. Pass 2 deliberately suppressed re-consent
   // for LOGIN-mode (returning users shouldn't be re-consented for an
   // identity-only sign-in); CONNECT-mode is the inverse — it's the
   // moment we're asking for long-lived offline access, and consent is
   // the price of admission.
   if (mode === 'connect' && service === 'google') {
     runtimeAuthParams.prompt = 'consent';
   }
   ```
   This sits *after* the explicitForcePrompt nullification block so it
   wins over any prior NULL.
2. The Google adapter default (`prompt: 'select_account'`) stays exactly
   as-is. The ADR-0017 "safe-by-default at the adapter, escalate at the
   call site" boundary is intentional and preserved.
3. `include_granted_scopes=true` for connect-mode stays. With
   `prompt=consent`, Google still shows a consent screen, BUT the screen
   correctly displays the union of (existing grant ∪ requested scopes)
   — the F4 incremental upgrade property is preserved for genuine
   scope-add scenarios.
4. Login/signup-mode are untouched. F3 Pass 1 + Pass 2 login wins are
   preserved end-to-end.
5. Other adapters (`facebook`, `github`, `generic-oauth`, etc.) are
   untouched. GitHub doesn't issue refresh tokens at all (single
   long-lived token model). Facebook uses long-lived access tokens via
   a separate exchange. The bug is Google-specific.

## Consequences

**Positive.**

- Every successful connect-mode flow on Google now stores a row with a
  valid `refresh_token`. The ~1h fuse to `REAUTH_REQUIRED` is gone.
- Users see the consent screen on connect — which is the right UX for
  "I am authorizing an agent to call Drive/Gmail/Calendar on my behalf."
  Visibility of the scope set at grant time is a security feature.
- Login/signup UX win from F3 Pass 1 + Pass 2 is preserved unchanged.
- Adapter remains safe-by-default. Connect-mode policy lives at the
  call site (`src/index.js`), exactly where ADR-0017 said it should.
- F4 incremental-authorization is preserved for scope-upgrade scenarios:
  if a user later connects with an expanded `GOOGLE_SCOPE`, Google's
  consent screen will show the additive scopes rather than "approve
  everything from scratch."

**Negative / costs.**

- One extra round-trip click for connect-mode reconnects. Not a
  regression vs. pre-F3 behavior; it's the pre-F3 behavior on the
  one path where it was actually correct.
- One additional `if` branch in the authorize handler.
- ADR-0017 connect-mode arm is partially superseded. We do NOT edit
  ADR-0017 — this ADR supersedes the connect-mode-prompt-policy half
  of ADR-0017's Decision section. Login/signup arm of ADR-0017 stands.

**Code changes required (high level).**

- `src/index.js` — add 3-line override block in
  `GET /api/v1/oauth/authorize/:service` handler.
- `src/tests/oauth-security-hardening.test.js` — flip the
  "google connect mode emits prompt=select_account" assertion to
  `prompt=consent`. Adapter-default direct-unit-test (line 136) stays
  as-is — it asserts the *adapter*, not the *handler*.
- `src/tests/oauth-authorize-url-live-smoke.test.js` — flip the
  `mode=connect` smoke assertion to `prompt=consent`. The test name
  is updated to point at this ADR.
- `src/tests/security-regression.test.js` — add a static-analysis
  tripwire that the `src/index.js` connect-mode override block exists
  (regex against the source file).
- New behavioural test: connect-mode HTTP authorize URL contains
  `prompt=consent` AND `access_type=offline` AND
  `include_granted_scopes=true` AND the full service scope set. This
  is the "all four properties together" assertion that locks the
  cross-cutting contract.

**Operational changes required.** None. This is a pure code change.
Existing rows in `oauth_tokens` with `refresh_token IS NULL` will
continue to surface as `REAUTH_REQUIRED` until the user reconnects;
their next reconnect (post-deploy) will store a refresh_token.

## Rollback plan

If forcing consent on every connect turns out to be excessively
intrusive in field testing (e.g. a high-frequency rotate-tokens
scenario we haven't anticipated), the revert is a one-line change:
delete the `if (mode === 'connect' && service === 'google')` block
from `src/index.js`. The system reverts to the F3 Pass 2 + F4 silent
behavior — including the refresh_token loss bug — and we're back where
we started. The static tripwire in `security-regression.test.js` will
fail, surfacing the rollback as a deliberate decision.

## Follow-ups

- Tasks created: F3 Pass 3 task brief filed under
  `.context/tasks/completed/` once this lands.
- Metrics/alerts to add: none required. The existing `REAUTH_REQUIRED`
  surface in `/oauth/status` is the operational signal that a row is
  unhealthy.
- When to revisit this decision: if Google changes its refresh_token
  issuance policy (e.g. relaxes the "consent must be shown" rule), or
  if a consumer with a legitimately high reconnect frequency reports
  the consent screen as a UX blocker.
