# ADR-0018 — Separate OAuth's identity role from its service role

- **Status.** Accepted.
- **Date.** 2026-04-25.
- **Supersedes.** Part of the ADR-0016 keying story (provider_subject + first-seen) — the storage location moves; the invariant stays.
- **Related.** ADR-0006 (OAuth design), ADR-0014 (M3 playbook), ADR-0016 (first-seen keying), ADR-0017 (prompt policy, F3).
- **Scope.** OAuth providers that are usable as **both** login identity and delegated service: Google, GitHub, Facebook. Service-only providers (Slack, Discord, Twitter, Airtable, Canva, WhatsApp, Instagram, Notion, …) are unaffected.

## 1. Context

F3 Pass 1 (2026-04-24) dropped `max_age=0` from Google's login authorize URL. F3 Pass 2 flipped the Google adapter default from `prompt=consent` to `prompt=select_account` and wired a `REAUTH_REQUIRED` recovery path for dead refresh tokens. Both were correct as individual changes. **Neither fixed the symptom the user reported.**

After Pass 2 the user tried Google login and still hit the scope-approval screen ("Allow MyApi to read, compose, send, and permanently delete all your email from Gmail…") on every single sign-in. They also surfaced a related, more structural concern:

> Google is been used for authentication to the application itself and in the scope we only need access to email and name. And we have Google as a service which there we need to have a full scope as much as possible, we need to make sure we differentiate between the two.

The symptom and the structural concern are the same root cause. Every login-capable adapter — `src/services/google-adapter.js`, `src/services/github-adapter.js`, `src/services/generic-oauth-adapter.js` (Facebook) — sends **one** scope string on authorize, regardless of whether the user is logging in or connecting a service. For Google that was `userinfo.email userinfo.profile gmail.modify calendar.readonly drive.file` on every single "Sign in with Google" click. For GitHub it was `user repo gist` on every sign-in. Google treats the sensitive scopes as warranting re-consent; the user sees an "intrusive" consent screen on every login. More importantly, a user's **login-provider account** and **service-provider account can legitimately be different Google/GitHub/Facebook accounts** (personal vs work), and the pre-F4 design collapsed them onto the same `oauth_tokens` row, thrashing first-seen gesture state between them.

### Threat model — what breaks at each layer

| Layer | What happens pre-F4 | Why it matters |
|-------|--------------------|----|
| User experience | Login re-prompts for "read your Gmail" on every session | Correctness bug: the consent is for a grant that's not needed for sign-in. |
| Google policy | App gets flagged for requesting sensitive scopes without need | Verification rejection risk; Testing-mode 7-day token expiry |
| Cross-account | Log in as `personal@gmail`, connect `work@gmail` — both write to the same `(user_id, 'google')` oauth_tokens row | Service grant overwrites identity state; gesture screen re-fires every login; potential account-takeover if a second user claims an already-linked provider account |
| Audit | "Did Alice authenticate as A or B?" is inferred from a column that's been mutated by both flows | No reliable identity record |

## 2. Decision

### 2.1 Adapter contract

Each login-capable adapter exposes **two** scope sets as module-level constants:

| Adapter | `IDENTITY_SCOPES` (hard-coded) | `SERVICE_SCOPES` (env-overridable) |
|---------|--------------------------------|------------------------------------|
| Google  | `openid email profile` | `GOOGLE_SCOPE` env or default `gmail.modify calendar.readonly drive.file` |
| GitHub  | `read:user user:email` | `GITHUB_SCOPE` env or default `repo gist workflow` |
| Facebook (via `GenericOAuthAdapter`) | `email public_profile` (env-overridable via `FACEBOOK_IDENTITY_SCOPE`) | `FACEBOOK_SERVICE_SCOPE` env (empty by default) |

`getAuthorizationUrl(state, runtimeAuthParams, { mode })` picks which set to request:

- `mode === 'login'` or `mode === 'signup'` → `IDENTITY_SCOPES` only, and for Google specifically NO `access_type=offline` (no refresh token needed for sign-in).
- `mode === 'connect'` or undefined → `IDENTITY_SCOPES + SERVICE_SCOPES` + `access_type=offline` where supported.

Why hard-code identity scopes: they are a **security primitive**, not a feature flag. A misconfigured `IDENTITY_SCOPE` env var would widen the sign-in surface silently. Service scopes are operationally tunable (expand/contract agent powers) and stay env-overridable.

The service-only adapters (Slack, Discord, WhatsApp, Twitter, Airtable, Canva, Instagram, Notion, Snapchat) still use the legacy single-`scope` path — their `getAuthorizationUrl` accepts the third `{mode}` arg and ignores it. `GenericOAuthAdapter._resolveScope` falls back to `this.scope` when neither `identityScope` nor `serviceScope` is configured, keeping them zero-maintenance.

### 2.2 Storage: new `user_identity_links` table

Identity state moves off `oauth_tokens` onto a dedicated table:

```sql
CREATE TABLE user_identity_links (
  user_id            TEXT NOT NULL,
  provider           TEXT NOT NULL,         -- 'google' | 'github' | 'facebook'
  provider_subject   TEXT NOT NULL,         -- Google sub, GitHub id, Facebook id
  email              TEXT,
  first_confirmed_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
CREATE UNIQUE INDEX idx_user_identity_links_provider_subject
  ON user_identity_links (provider, provider_subject);
```

Two DB-enforced invariants:

- **PK `(user_id, provider)`** — one identity per provider per MyApi user. If a user re-logs in with a different Google `sub` (e.g. they switched Google accounts), ADR-0016 Case B applies: we overwrite subject, null `first_confirmed_at`, and the next callback re-fires the gesture screen.
- **UNIQUE `(provider, provider_subject)`** — one MyApi user per provider account. This blocks account takeover: an attacker who briefly controls the OAuth callback cannot claim an already-linked provider identity onto a different MyApi user.

A new domain module `src/domain/oauth/identity-links.js` owns all reads and writes to this table — no hand-rolled SQL anywhere else. The `pending-confirm` module's `hasConfirmedBefore` + `recordFirstConfirmation` entry points re-export from identity-links (call-site signatures unchanged, `serviceName` accepted as an alias for `provider`).

### 2.3 `oauth_tokens` becomes service-only

- **Login-mode callback** (`src/index.js` returning-user fast-path + first-seen path): NO `storeOAuthToken` call. Writes only `user_identity_links`.
- **Login-mode pending-confirm payload**: no longer carries `accessToken` / `refreshToken`. The identity-authorize call returns a scope-`openid email profile` token that cannot call any service API; discarding it is safer than persisting it in an `oauth_pending_logins` row for up to 5 minutes.
- **Signup-mode** (choice 3a): identity-only. `storeOAuthToken` call removed from signup-complete. Users who want Google as a service explicitly connect it from the Services page afterwards — one extra click, but principle-of-least-authority onboarding.
- **Connect-mode** (unchanged): writes `oauth_tokens` with encrypted access + refresh token + `provider_subject` of the service account. The service-account subject may differ from the login-account subject; they are independent.
- **`storeOAuthToken` simplification**: the pre-F4 "reset first_confirmed_at on subject change" branch is gone. `first_confirmed_at` on `oauth_tokens` is no longer written and will be dropped in a later milestone. The `provider_subject` column is still written for audit / display ("connected as <email>") but no longer gates anything.

### 2.4 Migration

Additive. The `user_identity_links` table is created unconditionally. A backfill loop copies rows from `oauth_tokens` where `provider_subject IS NOT NULL AND first_confirmed_at IS NOT NULL` into `user_identity_links` via `INSERT OR IGNORE` — idempotent against repeat runs. Rows without populated identity markers (connect-mode grants without a login gesture) are skipped.

- **Upgrade-in-place behaviour**: returning users who were already first-seen-confirmed pre-F4 continue to be; their first login post-deploy sees no gesture screen. Users whose pre-F4 state was incomplete will see a one-time gesture screen on their next login, which is the documented M3 post-deploy UX.
- **Rollback**: the migration is additive. The revert-commit path restores `src/index.js` to write `oauth_tokens` on login, and the `user_identity_links` table can be left in place (unused) or dropped.

## 3. Alternatives considered

### 3.1 Stay with a single adapter scope and toggle it via the `runtimeAuthParams.scope` override in `src/index.js`

- Pro: smaller diff (one file).
- Con: the adapter stays unsafe-by-default. A stray code path calling `getAuthorizationUrl` outside the authorize handler gets full scopes. The exact same trap F3 Pass 2 closed for `prompt=consent`.

Rejected. We want the security primitive at the adapter layer.

### 3.2 Put identity on `oauth_tokens` with a `grant_type` column (`'identity' | 'service'`)

- Pro: one table.
- Con: breaks the (user, service) uniqueness assumption baked into every existing read. Every query that says "does this user have a Google connection?" would need a grant_type filter. High blast radius.

Rejected. Separate tables with separate lifecycles is the right shape.

### 3.3 Keep signup writing `oauth_tokens` (choice 3b during scoping)

- Pro: "connect Gmail at signup" is a common onboarding flow.
- Con: Perpetuates the "full consent on login" UX. Also conflicts with the least-authority principle the rest of F4 embraces.

Rejected (choice 3a taken). Users who want a service connection explicitly connect it afterwards.

## 4. Consequences

### Positive

- Google login stops re-prompting for sensitive scopes on every session. Same for GitHub and Facebook.
- Login-provider account and service-provider account are fully independent — a user can log in with personal Google and connect work Google as a service without any interference.
- Identity state has an audit-grade home (`user_identity_links`) with DB-enforced invariants, not a shared column mutated by two flows.
- `oauth_pending_logins` rows no longer carry secrets for login-mode confirms (fewer secrets at rest for the gesture-screen TTL).
- The adapter layer is safe-by-default — any caller that skips the `{mode}` hint gets connect-mode behaviour (full scope), so there's no login-mode trap for stray call sites.

### Negative

- `storeOAuthToken`'s old "first_confirmed_at reset on subject change" branch is gone. If any out-of-tree caller was relying on it, they lose the behaviour. No in-tree callers remain (verified via grep).
- Upgrade-in-place may show a single extra gesture screen to returning users whose `oauth_tokens` row had incomplete identity markers pre-F4 — acceptable, documented.
- Users who did OAuth-signup pre-F4 kept their service grant at signup. Post-F4 signup does NOT write a service grant — returning users who depended on this at sign-in will need to connect explicitly. The migration backfill copies their identity link; their `oauth_tokens` row is untouched.

### Neutral

- Test baseline rises from 504 passing / 20 skipped (F3 Pass 2) to 539 passing / 14 skipped (38 suites). +22 behavioural (the F4 file), +7 static tripwires, -2 legacy assertions rewritten to the new contract.
- Roughly 650 LOC net (+~900 new, ~-250 from the simpler `storeOAuthToken` + the retired legacy signup-complete branch).

## 5. Follow-ups

- `user_identity_links` should eventually gain a `provider='password'` row convention when F5 (password auth consolidation) ships, so "how does this user authenticate" is one table. Filed as backlog `F5`.
- `oauth_tokens.{provider_subject, first_confirmed_at}` are deprecated for login purposes. Drop the columns in a later milestone after monitoring confirms no reads remain.
- Live smoke verification (Google, GitHub, Facebook) across login and connect flows is pending and will be appended to this ADR's evidence section after completion.

## 6. Verification

- `npm test` — 38 suites, 539 pass / 14 skip, exit 0.
- `src/tests/oauth-identity-service-separation.test.js` — 22 behavioural tests covering all three adapters, DB invariants, and the login-vs-service decoupling property.
- `src/tests/security-regression.test.js` — 7 new F4 static tripwires locking the adapter split, the `{mode}` thread-through in the authorize handler, the absence of `storeOAuthToken` on the login-mode fast path, the absence of `storeOAuthToken` on signup-complete, and the schema invariants.
