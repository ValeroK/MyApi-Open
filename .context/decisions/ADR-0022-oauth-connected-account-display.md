# ADR-0022 — Persist + display the connected provider account on each service grant

- **Status.** Accepted
- **Date.** 2026-04-30
- **Decision makers.** @kobiv (with AI pair)
- **Related.** Pairs with [ADR-0018](./ADR-0018-oauth-identity-vs-service-separation.md) (data-model identity-vs-service split) and [ADR-0021](./ADR-0021-oauth-connect-mode-force-consent.md) (refresh-token guarantee). F3 Pass 4.
- **Tags.** ux / oauth / backend / frontend

## Context

ADR-0018 (F4) split identity grants from service grants at the storage layer:
`user_identity_links` carries the LOGIN identity (provider, subject, email)
and `oauth_tokens` carries the SERVICE grant (tokens, scope, provider_subject).
The connect-mode authorize URL still requests `openid email profile` alongside
the service scopes — that is the correct shape per F4 because the callback
needs to identify the granting provider account before it can decide whether
the row is first-seen, and Google issues an `id_token` (with `sub` and
`email`) only when `openid` is requested.

What was missing was the user-visible half of multi-account support. A user
who logs in as `alice@personal.gmail.com` and connects Drive using
`alice@work.gmail.com` (by picking a different account on Google's account
picker) had no way to tell from the dashboard which account was actually
granting Drive access. The Services page just rendered "Connected" with the
green dot. That made disconnect/reconnect unsafe — users couldn't see whether
they were about to disconnect the account they meant to.

The user's explicit asks (2026-04-30 review):

1. Keep the current connect-mode scope shape (mixed identity+service is
   correct).
2. Keep the data-model separation (identity_links vs oauth_tokens — F4 is
   correct).
3. Enable connecting a service with a different account than the login
   account (existing flow already supports this on the OAuth side; the gap
   was on the storage + UI side).
4. Preserve which provider account is being used and present it in the UI.

This ADR closes asks 3 + 4 without touching 1 or 2.

## Decision

Persist the granting provider account's email on `oauth_tokens` and surface
it in `/api/v1/oauth/status` so the dashboard can render
`Connected as alice@work.gmail.com` beneath each connected service card.

### Schema

`oauth_tokens` gains one column:

```
connected_email TEXT
```

CREATE TABLE updated in [src/database.js](../../src/database.js); a
`safeMigration` row keeps existing dev DBs working without a wipe.

### `storeOAuthToken` signature

Extends from 7 to 8 positional args:

```
storeOAuthToken(serviceName, userId, accessToken, refreshToken, expiresAt,
                scope, providerSubject, connectedEmail)
```

The 8th arg defaults to `null`. UPDATE-path uses `COALESCE(?, connected_email)`
so a refresh-style call that doesn't re-fetch identity (and therefore passes
`null`) does NOT wipe the previously-stored email. Email is normalised
(`trim().toLowerCase()`) on write to avoid casing drift between id_token
claims and userinfo responses.

The source-level tripwire in
[src/tests/oauth-state-inventory.test.js](../../src/tests/oauth-state-inventory.test.js)
flips from "every call site passes ≥ 7 args" to "every call site passes ≥ 8 args"
so a future call site that forgets `connectedEmail` fails the build.

### Connect-mode callback

[src/index.js](../../src/index.js) connect-mode branch (the
`stateMeta.mode === 'connect'` arm of the OAuth callback) captures
`connectedEmail` from the same `verifyToken` response that already feeds
`providerUserId` extraction. For Google specifically the id_token `email`
claim is preferred (signed by Google, no extra HTTP) with a userinfo
response fallback. GitHub `/user` and Facebook `/me?fields=id,email` already
return `email` on the same response.

`connectedEmail` is then threaded as the 8th arg to `storeOAuthToken`.

### `/oauth/status` response

Each per-service object in the `/api/v1/oauth/status` response gains:

```js
connectedEmail: token?.connectedEmail || null
```

Sourced from `getOAuthToken(...).connectedEmail`. `null` for disconnected
services and for connected services where the provider returned no email
(e.g. Facebook `public_profile` without the `email` scope).

### SPA

[ServiceConnectors.jsx](../../src/public/dashboard-app/src/pages/ServiceConnectors.jsx)
`InlineServiceCard` renders `Connected as {service.connectedEmail}` beneath
the service label/category when `service.status === 'connected'` AND
`service.connectedEmail` is set. Plain text, with `data-testid` for future
end-to-end coverage.

## Consequences

### Positive

- Multi-account behaviour becomes visible. A user can verify at a glance
  which provider account holds the grant before clicking Disconnect.
- Independent from login identity: `user_identity_links.email` is unchanged
  by service-grant writes, so logging in as
  `alice@personal.gmail.com` continues to work even when Drive is granted
  via `alice@work.gmail.com`. Behavioural test in
  [oauth-connect-account-display.test.js](../../src/tests/oauth-connect-account-display.test.js)
  pins this.
- No new schema (one column on the existing table) and no new domain
  module — keeps the F4 conceptual split intact (identity_links for login,
  oauth_tokens + connected_email for service).
- Minimal SPA surface: one conditional line in one component.

### Neutral

- Email is opportunistic: when the provider doesn't return an email
  (Facebook with `public_profile` only, GitHub when the user hides their
  primary email, transient `verifyToken` HTTP failure that the existing
  callback already swallows), the column stays NULL and the SPA short-
  circuits to "no label". The card still renders with the green
  Connected chip — just without the per-account line. Behavioural test
  in [oauth-connect-no-email-graceful.test.js](../../src/tests/oauth-connect-no-email-graceful.test.js)
  pins this.

### Negative / future work

- Single-row-per-(service, user) is unchanged: connecting `alice@work` and
  then connecting `alice@side-project` for the same MyApi user overwrites
  the row, losing the previous email. Acceptable today (we don't expose a
  multi-grant UI), but the day we want a "linked accounts" surface this
  ADR will want to be superseded by an `oauth_service_account_links` table.

## Test evidence

- New behavioural suites:
  - [oauth-connect-account-display.test.js](../../src/tests/oauth-connect-account-display.test.js)
    — 5 tests covering DB round-trip, casing normalisation, COALESCE-on-update,
    `/oauth/status` shape, and multi-account independence.
  - [oauth-connect-no-email-graceful.test.js](../../src/tests/oauth-connect-no-email-graceful.test.js)
    — 4 tests covering null email, empty-string email, whitespace-only email,
    and a static tripwire on the connect-mode capture block.
- New static tripwires in
  [security-regression.test.js](../../src/tests/security-regression.test.js)
  for the schema column, the 8-arg signature, and the `/oauth/status`
  response key.
- Existing tripwire in
  [oauth-state-inventory.test.js](../../src/tests/oauth-state-inventory.test.js)
  flipped from 7 → 8.
- Targeted bundle (15 OAuth + security-regression suites): **15 passed,
  1 skipped (live smoke), 232 passed / 16 skipped tests, exit 0**. Up
  from the F3 Pass 3 baseline of 220 passing.

## Supersession

This ADR does **not** supersede ADR-0017 (still authoritative for
login-mode prompt policy), ADR-0018 (still authoritative for the
identity-vs-service data-model split — connect-mode mixed scopes are
correct), or ADR-0021 (still authoritative for connect-mode
`prompt=consent`). ADR-0022 layers on top of them and only adds the
connected-account label — no existing behaviour is removed.
