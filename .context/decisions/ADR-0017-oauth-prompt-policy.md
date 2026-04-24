# ADR-0017 — OAuth `prompt` policy: `select_account` default, `consent` only for forced-regrant, `invalid_grant` triggers REAUTH_REQUIRED

- **Status.** Accepted
- **Date.** 2026-04-24
- **Decision makers.** @kobiv (with AI pair)
- **Related.** F3 Pass 1 (dropped `max_age=0`), F3 Pass 2 (this ADR), ADR-0006, ADR-0016
- **Tags.** security / oauth / ux / backend / frontend

## Context

F3 (`.context/tasks/backlog/F3-oauth-consent-prompt-once-per-grant.md`)
describes a UX regression: returning Google users were being shown the
full scope-approval screen on every login, not just on the initial
grant and not just on legitimate grant changes. Users described it as
"very frustrating." The investigation found two distinct root causes
which had been layered on top of each other over time:

1. **F3 Pass 1 (2026-04-24, shipped).** `src/index.js` was adding
   `max_age=0` to Google's authorize URL in `login` mode whenever
   `forcePrompt=1` was in the query. `max_age=0` asks Google to treat
   the user as if they had *never* authenticated, which in Google's
   pipeline cascades into a full re-consent screen every time — even
   for users whose grant was still valid. Pass 1 removed `max_age=0`
   and set `prompt=select_account` as the login-mode override. Google
   now silently passes through returning users with a valid grant,
   shows the account picker when multiple accounts are present, and
   only escalates to consent when the grant actually needs
   re-approval. See the Pass 1 commit for behavioural + unit + live
   smoke coverage.

2. **F3 Pass 2 (this ADR).** Two problems remain after Pass 1:

   a. **`src/services/google-adapter.js` hard-coded `prompt: 'consent'`
      as the adapter default.** The server-side login override
      (`runtimeAuthParams.prompt = 'select_account'`) rescued the login
      path, but `mode=connect` (the "Connect Google" button on the
      Services page) had no override and fell straight through to the
      adapter default. That meant every attempt to add Google to the
      dashboard surfaced a full consent screen — even if the user was
      reconnecting a grant they had just revoked and wanted to re-grant
      silently. The adapter was not safe-by-default.

   b. **Dead refresh tokens were never detected.** When Google returns
      `error: 'invalid_grant'` on a refresh, the stored `refresh_token`
      is dead — the user revoked the grant on Google's side, Google
      rotated the token, or the issuing flow was buggy. The old
      `refreshOAuthToken` just bubbled the error back up. Every
      subsequent proxy call re-tried the refresh, got the same
      `invalid_grant`, surfaced a generic "Token expired and refresh
      failed" to the caller, and the dashboard kept showing the row as
      `status: "connected"` — a lie. There was no way for the user to
      know they needed to reauthorize until they happened to observe
      an agent failure and chased the logs.

## Options considered

### Pass 2 Item A — adapter default `prompt`

| # | Option | Pros | Cons |
|---|--------|------|------|
| A1 | Leave adapter default as `consent`; override in connect mode too. | Minimal diff. | Perpetuates the anti-pattern — the adapter is still the most aggressive option by default and future callers that forget to override silently force consent. |
| A2 | Flip adapter default to `select_account`; override to `consent` only where explicitly needed. | Safe-by-default. Every call path is as unobtrusive as possible unless code explicitly escalates. Matches how `access_type: 'offline'` is already handled (sensible default, overridable). | One extra test update. Need to make sure any legacy caller that actually needed forced consent is still escalated. |
| A3 | Drop `prompt` from the default entirely (let Google choose). | Simplest. | Removes the UX signal that says "show picker." Users with two Google accounts would no longer get an account chooser on reauth — Google would just pick "most recently used," which can silently bind the wrong account. |

### Pass 2 Item B — dead refresh_token handling

| # | Option | Pros | Cons |
|---|--------|------|------|
| B1 | Leave dead tokens in place; keep returning generic "refresh failed." | Zero code change. | Dashboard lies about connection state; every proxy call burns a redundant round-trip to Google; no actionable signal for the user. |
| B2 | Delete the entire `oauth_tokens` row on `invalid_grant`. | Clean DB; "disconnected" status surfaces naturally. | Destroys the `provider_subject` first-seen pairing from ADR-0016, so the next successful authorize would force the confirm-gesture screen again. We lose the `scope` history and `connected_at` audit trail. |
| B3 | Null out only the `refresh_token` column; keep the row. | Preserves the first-seen pairing and audit history. The row represents "was connected, grant revoked, reauth to restore" — a real state worth tracking. Downstream endpoints have a clean sentinel (`refreshToken IS NULL AND isTokenExpired`) for `reauth_required`. | One extra possible state (`reauth_required`) surfaced through the whole stack. |

### Pass 2 Item C — proxy / execute endpoint surface

| # | Option | Pros | Cons |
|---|--------|------|------|
| C1 | Keep returning generic "Token expired and refresh failed." | No change. | Caller can't distinguish "retry later" from "reauth now" — they're genuinely different remediations. |
| C2 | Return a discriminated 401 `{error: 'REAUTH_REQUIRED', service, message}` when the refresh path flags `reauthRequired: true`. | Dashboard can render an actionable "Reauthorize" button. Agents can propagate a clean signal to their orchestrator. Logs have a distinct error code to alert on. | One new response envelope to document; frontend has to learn the new shape. |

## Decision

- **Item A.** Option **A2** — flip the adapter default to `select_account`.
- **Item B.** Option **B3** — null only the `refresh_token` column on
  `invalid_grant`, keep the row (and therefore keep the first-seen
  pairing from ADR-0016).
- **Item C.** Option **C2** — discriminated `REAUTH_REQUIRED` envelope
  on proxy + execute; `reauth_required` state on `/api/v1/oauth/status`.

Concretely, the Pass 2 commit ships:

1. **`src/services/google-adapter.js`** — `prompt` default is now
   `'select_account'`. Callers that genuinely need forced consent
   (admin tools, scope-upgrade flows) still get it by passing
   `runtimeAuthParams: { prompt: 'consent' }`; the spread after the
   default overrides cleanly.

2. **`src/database.js` `refreshOAuthToken`** — on
   `result.body.error === 'invalid_grant'`:
   - Execute `UPDATE oauth_tokens SET refresh_token = NULL, updated_at = ?`
     for the `(service_name, user_id)` pair.
   - Return `{ ok: false, error: 'invalid_grant', errorDescription,
     reauthRequired: true, status }`.
   - Other errors (transient 5xx, `invalid_client`, network failures)
     continue to bubble up unchanged and DO NOT clear the
     `refresh_token`.

3. **`src/index.js`** — two parallel updates:
   - `/api/v1/services/:serviceName/proxy` and
     `/api/v1/services/:serviceName/execute`: when the stored token is
     expired AND (`refresh_token` is already NULL OR the refresh
     returns `reauthRequired: true`), return
     `401 { error: 'REAUTH_REQUIRED', service, message }` and
     invalidate the in-memory token cache via
     `invalidateCachedOAuthToken`.
   - `/api/v1/oauth/status`: `connectionStatus` now has three values
     instead of two — `connected`, `disconnected`, `reauth_required`.
     The last one is emitted exactly when
     `token && !token.revoked_at && !token.refreshToken &&
     isTokenExpired(token)`.

4. **`src/public/dashboard-app/src/pages/ServiceConnectors.jsx`** —
   `reauth_required` is a first-class status with:
   - An amber (warning, not error) status chip.
   - A per-card "Reauthorize" button that routes through the existing
     `handleConnect(service)` path.
   - A top-of-page banner when any service is in this state, so the
     user notices it before they click into a specific card.

5. **Tests.** Coverage is red-first then green:
   - `src/tests/oauth-refresh-invalid-grant.test.js` — 5 behavioural
     cases against a real DB + loopback HTTP token server. Proves the
     `invalid_grant` branch clears the column, proves other error
     classes do not.
   - `src/tests/oauth-security-hardening.test.js` — two Pass 2 cases:
     a direct adapter unit test (`GoogleAdapter().getAuthorizationUrl`
     default ⇒ `prompt=select_account`) and an HTTP-level connect-mode
     assertion.
   - `src/tests/oauth-authorize-url-live-smoke.test.js` — connect-mode
     live smoke flipped to expect `select_account`.
   - `src/tests/security-regression.test.js` — five static-analysis
     tripwires that fire if a refactor silently removes the
     `REAUTH_REQUIRED` branches, the `invalidateCachedOAuthToken`
     call, the `reauth_required` status value, the
     `providerError === 'invalid_grant'` branch in `refreshOAuthToken`,
     or the `select_account` adapter default.

## Consequences

**Positive.**

- Returning users with a valid grant are no longer re-consented — the
  UX promise of "connect once" actually holds across logins (paired
  with Pass 1's `max_age=0` removal).
- The adapter is now safe-by-default. A future caller that forgets to
  override `prompt` gets the least intrusive UX, not the most.
- Dead grants are surfaced in the dashboard immediately (next status
  poll) instead of hidden behind an agent-side failure trail. The
  error taxonomy (`REAUTH_REQUIRED` vs `Token expired and refresh
  failed`) matches the remediation (reauth vs retry).
- Proxy + execute endpoints stop pointlessly retrying dead refresh
  tokens, reducing outbound traffic to Google and reducing the
  log-noise that was masking real refresh-path failures.
- First-seen confirm-gesture pairing from ADR-0016 is preserved across
  grant revocations — the row stays in place, only the dead
  refresh_token is cleared.

**Negative / costs.**

- One new response envelope (`REAUTH_REQUIRED`) to document and
  version. Agents integrating with the proxy must learn to recognise
  it; the `error` field value is stable and can be string-matched.
- One new frontend state (`reauth_required`) to maintain across future
  UI refactors. The static tripwires in
  `security-regression.test.js` will catch accidental removal, but
  intentional refactors must be aware of the contract.
- A test against a loopback HTTP server is slightly slower than a
  pure mock (~50–100 ms overhead); acceptable for the behavioural
  confidence gain.

**Things this ADR deliberately does NOT do.**

- It does not flip other adapters' defaults
  (`discord-adapter.js`, `github-adapter.js`, etc.). They can be
  audited individually; some providers have different semantics for
  `prompt` and the Pass 2 change is deliberately scoped to Google
  where the UX regression was observed.
- It does not add a "Reauthorize all" bulk CTA. Multi-service regrant
  is rare enough that per-service clicks are acceptable for now; the
  top-of-page banner does tell the user how many services are
  affected.
- It does not change `mode=signup`. Signup flows go through their own
  explicit approval gesture (the onboarding wizard) and the consent
  screen during initial grant is not a UX regression — it's the
  correct "new user agreeing to scopes" moment.

## Rollback plan

If the adapter-default flip causes a provider-side incident (e.g.
Google changes its handling of `select_account` in a way that breaks
returning logins), revert
`src/services/google-adapter.js` to `prompt: 'consent'` — a one-line
change. The `refreshOAuthToken` invalid_grant branch and the
dashboard UI can stay; they're independent.

If the `REAUTH_REQUIRED` envelope turns out to confuse downstream
callers more than the generic "refresh failed" did, the rollback is
narrow: change the two `res.status(401).json({error: 'REAUTH_REQUIRED'
...})` branches in `src/index.js` back to the generic envelope and
leave the DB + UI work in place. The UI degrades gracefully because
the `reauth_required` status will still surface through
`/oauth/status`.
