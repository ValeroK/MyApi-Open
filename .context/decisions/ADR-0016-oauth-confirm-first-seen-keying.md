# ADR-0016 — OAuth confirm-gesture first-seen keying on `{service, user, provider_subject}`

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** @kobiv (with AI pair)
- **Related.** `plan.md` §6.3 C3, `TASKS.md` M3 (T3.7), ADR-0006, ADR-0014
- **Tags.** security / oauth / frontend / backend

## Context

M3 Step 6 / T3.7 closes the session-fixation variant of C3: the OAuth
callback used to `req.session.user = …` immediately after the provider
redirect, which means an attacker who lured a victim through a
pre-initiated OAuth flow could end up with the victim's cookie pointing
at the attacker's provider account (or vice versa, depending on the
variant). ADR-0006 committed us to a user-facing confirmation gesture
between "OAuth callback succeeded" and "session promoted to logged in".

Forcing the gesture on **every** successful OAuth callback is a
regression in UX: the overwhelming majority of real callbacks are a
returning user re-authenticating the same provider account into the same
local account they already use. The gesture has to be **first-seen**:
show it exactly once per "this is a new pairing", silently skip it
afterwards.

The non-trivial question is: what is the key for "first-seen"?

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | `(service, user_id)` — skip the gesture whenever *any* token row exists for this local user on this provider. | Simplest; one column; can be derived from existing `oauth_tokens(service_name, user_id)` unique pair. | A single local account can legitimately have its provider identity rotated (email change on Google, GitHub username change, re-install, etc.) and we'd never re-gate. Worse, if the provider lets two different `sub`s end up mapped to the same local account through a signup bug, we never notice. |
| B | `(service, user_id, provider_subject)` — also require the provider's stable subject id to match. | Catches the "same local account, different provider identity" case and forces the gesture the first time a new subject lands on an existing local account. Matches exactly the threat model of C3 (attacker's provider account silently binding to victim's local account). | One extra column on `oauth_tokens`; callers of `storeOAuthToken` need to pass the subject; we need a safe default for legacy rows that predate the column. |
| C | Gesture on **every** callback, no first-seen skip. | Simplest threat model; no keying decision needed; still closes C3. | Gesture fatigue → users click through without reading → social-engineering path back in. Also materially worse UX for the 95%+ of callbacks that are benign re-auth. |

## Decision

We chose **Option B**: `{service, user_id, provider_subject}`.

Concretely, `oauth_tokens` gains two columns (additive migration):

- `provider_subject TEXT NULL` — the provider's stable id for the
  authenticated identity (`sub` on Google, `id` on GitHub, …).
  Populated by `storeOAuthToken(… providerSubject)` going forward.
- `first_confirmed_at TEXT NULL` — ISO-8601 timestamp of the FIRST
  successful accept for this `{service, user_id, provider_subject}`
  tuple. `NULL` ⇒ the gesture is required on the next callback.

The OAuth callback now consults `hasConfirmedBefore({db, userId,
serviceName, providerSubject})`. On `true` it skips the gesture,
re-persists the token (so refresh rotations and scope drift still land)
and establishes the session directly. On `false` it mints a row in
`oauth_pending_logins` and redirects to the user-facing gesture screen;
the accept endpoint then stamps `first_confirmed_at` via
`recordFirstConfirmation`.

`storeOAuthToken` resets `first_confirmed_at` to `NULL` if an
**existing** row for `{service_name, user_id}` has a non-NULL
`provider_subject` that **differs** from the incoming one. That's the
"same local account, different provider identity" case — we do NOT
want to silently keep the old confirmation in effect. Callers that
don't know the subject (pre-T3.7 callers, migrations, manual fixups)
pass `null` and we `COALESCE` the existing value, which preserves
backward compatibility without granting a bypass.

## Consequences

- **Positive**
  - C3 (session-fixation variant) is closed end-to-end: no session is
    ever promoted without a user-driven accept.
  - The gesture is first-seen, so returning users aren't punished for
    correct behaviour.
  - `provider_subject` gives us a per-row audit key we didn't have
    before — useful for detecting e.g. the same Google account landing
    under two different local `user_id`s (account-takeover signal).
  - Scope is local and reversible: the two columns are nullable and
    additive, there is no destructive migration.

- **Negative / costs**
  - Every OAuth adapter must now surface the provider's stable subject
    id to `storeOAuthToken`. M3 Step 6 only does so for the login-mode
    flow that lands in the callback; connect-mode flows that go through
    different code paths are tracked for `m3-wrap` hardening.
  - Legacy rows (rows that existed before this ADR) have
    `provider_subject = NULL`; the very first post-ADR callback for
    them triggers the gesture. This is intentional — we'd rather
    re-confirm once than silently inherit an un-audited binding.

- **Code changes (high level)**
  - `src/database.js`: schema + migrations (`used_at`, `outcome` on
    `oauth_pending_logins`; `provider_subject`, `first_confirmed_at`
    on `oauth_tokens`) + `storeOAuthToken` update semantics.
  - `src/domain/oauth/pending-confirm.js`: new domain module — SSOT
    for the pending-login lifecycle. Handlers do NOT hand-roll SQL.
  - `src/index.js`: callback first-seen gate + `/confirm/preview`,
    `/confirm`, `/confirm/reject` endpoints; removes all
    `req.session.oauth_confirm` / `oauth_login_pending` usage.
  - `src/public/dashboard-app/src/pages/LogIn.jsx`: user-facing
    gesture UI (Continue / Cancel). Duplicate `Login.jsx` removed.
  - `src/public/dashboard-app/src/App.jsx`: auto-POST block deleted.

- **Operational**
  - Inventory gates in `src/tests/oauth-state-inventory.test.js` now
    assert the absence of `req.session.oauth_confirm`,
    `req.session.oauth_login_pending`, `fetch('/api/v1/oauth/confirm'…)`
    in `App.jsx`, and the on-disk absence of the duplicate
    `Login.jsx`.

## Follow-ups

- `T3.8` (M3 Step 7): replay/missing/expired/valid regression matrix
  for the new confirm endpoints — we have unit coverage in
  `src/tests/oauth-confirm-handler.test.js`, but not yet a named
  matrix suite.
- `T3.9` (M3 Step 8): extend the background prune job that already
  runs for `oauth_state_tokens` to also prune expired rows from
  `oauth_pending_logins` (the `pruneExpiredPendingConfirms` primitive
  is in place, just needs to be wired to the scheduler).
- **`m3-wrap`**: thread `provider_subject` through the signup-mode
  and connect-mode code paths so `storeOAuthToken` is NEVER called
  with `providerSubject=null` in M4+. Until then, the `COALESCE`
  fallback silently accepts those call sites.
- **When to revisit.** If providers start rotating `sub` values under
  our feet (Google has historically committed that they won't, GitHub
  is numeric and stable), this keying breaks and we either need to
  widen the key (e.g. to email as a fallback) or accept forced
  re-gestures. Add an alert if `first_confirmed_at IS NULL` grows
  by more than 10× daily average.
