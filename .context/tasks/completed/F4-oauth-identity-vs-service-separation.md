# Task brief — Separate OAuth's identity role from its service role

## Identity

- **ID.** `F4` (post-M3 follow-up; surfaced after F3 Pass 2 failed to fully
  eliminate the Google consent prompt).
- **Title.** Split each OAuth provider's use between **authentication** (who
  is this person; minimal scope) and **service authorization** (what can an
  agent do on their behalf; full scope). Ensure the login-side provider
  account and the service-side provider account are fully independent.
- **Milestone.** Post-M3 / pre-M4 hardening.
- **Plan reference.** `.context/plan.md` §6.3 (OAuth threat model); extends
  ADR-0014 (M3 playbook), ADR-0016 (first-seen keying), ADR-0017 (prompt
  policy).
- **Workstream.** WS-backend + WS-frontend.

## Status

- **State.** completed (code + tests + docs; live smoke pending as a separate verification step).
- **Assignee.** me
- **Started.** 2026-04-25
- **Target done.** Same day (single atomic commit).
- **Actually done.** 2026-04-25.

## Why (1-paragraph context)

F3 Pass 1 dropped `max_age=0` from Google login; Pass 2 flipped the adapter
default to `prompt=select_account` and wired REAUTH_REQUIRED for dead refresh
tokens. Both were correct — but neither fixed the root cause: every provider
adapter (Google, GitHub, Facebook-via-generic) sends **one** scope string on
authorize regardless of whether the user is logging in or connecting a
service. Google: `gmail.modify calendar.readonly drive.file` on every login.
GitHub: `user repo gist` on every login. That forces Google (and any future
verified-scope-requiring provider) to re-consent on every session in Testing
mode and, more importantly, conflates two very different user intents. The
user must be able to log in with one Google account (personal) and connect
an entirely different Google account (work) as a proxiable service — today
those two collide on the same `oauth_tokens` row and thrash each other.

## What (scope + explicit non-goals)

- In scope:
  - Each login-capable adapter exposes `IDENTITY_SCOPES` and `SERVICE_SCOPES`.
  - `getAuthorizationUrl(state, runtimeAuthParams, { mode })` picks scope +
    `access_type=offline` based on mode.
  - New table `user_identity_links` decouples login-provider identity from
    service-provider tokens. Migration backfills from the existing
    `oauth_tokens.provider_subject` / `first_confirmed_at` columns.
  - New module `src/domain/oauth/identity-links.js` owns reads/writes to the
    new table; the `pending-confirm` module's first-seen queries move here.
  - Login-mode OAuth callback writes `user_identity_links`, does NOT write
    `oauth_tokens`.
  - Connect-mode callback writes `oauth_tokens` (unchanged) but provider_subject
    is no longer co-mingled with login identity.
  - Signup-mode is identity-only — implicit service connect at signup is
    retired (choice 3a during scoping).
- Out of scope:
  - Password auth — see F5.
  - SPA routing race — see F1.
  - Onboarding wizard decision — see F2.
- Non-goals:
  - Changing OAuth state / PKCE / pending-confirm invariants. Those stay.
  - Dropping `oauth_tokens.provider_subject` columns in F4; we null them going
    forward and schedule removal for a later milestone for rollback safety.

## How (implementation plan — red-first)

1. Recon (done 2026-04-25):
   - Only one production call site of `getAuthorizationUrl` (`src/index.js:8580`).
   - `hasConfirmedBefore` + `recordFirstConfirmation` read/write `oauth_tokens`
     — these MUST move atomically with the login-mode oauth_tokens-skip.
   - Pending-confirm payload carries access/refresh tokens; drop those for
     login-mode post-F4 (security bonus).
   - UI has no password inputs; F5 covers the password-auth gap.

2. Red-first tests (new file
   `src/tests/oauth-identity-service-separation.test.js`):
   - Google `mode=login` authorize URL contains exactly `openid email profile`,
     no Gmail/Calendar/Drive scopes, no `access_type=offline`.
   - Google `mode=connect` contains identity + service scopes + offline.
   - GitHub `mode=login` authorize URL contains exactly `read:user user:email`,
     no `repo` / `gist` / `workflow`.
   - GitHub `mode=connect` contains full service scopes.
   - Facebook `mode=login` contains exactly `email public_profile`.
   - Facebook `mode=connect` contains `FACEBOOK_SERVICE_SCOPE` extras.
   - Cross-provider scope isolation: GitHub adapter never sends `gmail.*`,
     etc.
   - `GOOGLE_SCOPE` / `GITHUB_SCOPE` / `FACEBOOK_SERVICE_SCOPE` env overrides
     affect connect mode only; login scope is never overridable.
   - User-identity-links decoupling (per provider): log in as A, connect as
     B, log in as A again → no gesture thrash, both independent.
   - UNIQUE constraint: two MyApi users cannot claim the same
     `(provider, provider_subject)`.
   - Migration backfill test: existing rows in `oauth_tokens` with
     `provider_subject` end up in `user_identity_links`.

3. Static tripwires in `src/tests/security-regression.test.js`:
   - Each adapter source contains `IDENTITY_SCOPES` and `SERVICE_SCOPES`
     constants or equivalent name split.
   - Login-mode callback branch in `src/index.js` does NOT call
     `storeOAuthToken(...tokenData.accessToken...)`.
   - Pending-confirm login-mode payload does NOT include `accessToken` /
     `refreshToken` (post-F4 hardening).

4. Implementation:
   - `src/database.js`: new table migration + backfill; simplify
     `storeOAuthToken` (drop the "reset first_confirmed_at on subject change"
     branch — that logic moves).
   - `src/domain/oauth/identity-links.js`: new module, mirrors the
     `pending-confirm` API shape; owns all reads/writes to the new table.
   - `src/domain/oauth/pending-confirm.js`: `hasConfirmedBefore` +
     `recordFirstConfirmation` delegate to identity-links.
   - `src/services/google-adapter.js`: split scopes; accept `{ mode }` third
     arg.
   - `src/services/github-adapter.js`: split scopes; accept `{ mode }`.
   - `src/services/generic-oauth-adapter.js`: accept `identityScope` +
     `serviceScope` config and `{ mode }` third arg; pick scope based on
     mode. Backwards-compatible: if only `scope` is configured, it's used
     for all modes (prevents breaking Discord/Slack/Twitter etc. which are
     service-only).
   - `src/index.js:498-506`: Facebook generic-adapter config split.
   - `src/index.js:8580`: authorize handler passes `{ mode }` to adapter.
   - `src/index.js:8760-8950`: login-mode callback branch — no oauth_tokens
     write; upsertIdentityLink instead; pending-confirm payload drops tokens.
   - `src/index.js:7198-7358` (signup-complete): remove service-token
     write-through; identity-only upsert per choice 3a.

5. Live smoke (extend
   `src/tests/oauth-authorize-url-live-smoke.test.js`):
   - Google login URL: scope exactly identity, no access_type.
   - Google connect URL: full scope + offline.
   - GitHub login + connect parity.

6. Full Docker regression. Expect 504 → ~520 passing tests.

7. Manual browser verification:
   - Google: first login shows account picker only, no consent screen. First
     "Connect Google" from Services shows full consent once. Returning login
     silent. Agent proxy call still works.
   - GitHub: first login shows GitHub auth page with only `read:user
     user:email`. Connect shows full scope.
   - Facebook: first login with email + public_profile only.
   - Cross-account property: log in as account A, connect account B, log in
     as A again — no thrash.

8. Documentation:
   - `ADR-0018-oauth-identity-vs-service-separation.md`: design, threat
     model, migration, rollback plan.
   - Update this brief's outcome section.
   - Update `.context/current_state.md` to queue M4 after F4 ships.
   - Update `CLAUDE.md` scope-policy reference.

9. Atomic commit + push to main.

## Dependencies

- Depends on: F3 Pass 1 + Pass 2 (prompt policy; REAUTH_REQUIRED contract).
- Blocks: M4 (OAuth plan §6.4).

## Testing

- Unit tests: scope-separation matrix per adapter; identity-links module.
- Integration tests: login-vs-service decoupling per provider; signup-complete
  no-longer-writes-oauth_tokens.
- Security regression tests: static tripwires in `security-regression.test.js`.
- Manual verification: browser OAuth flows for all three providers.

## Risks & rollback

- **Risk A:** `hasConfirmedBefore` + `recordFirstConfirmation` move is not
  atomic with the login-skip → every login re-fires gesture. **Mitigation:**
  single commit; never merge partial.
- **Risk B:** Migration backfill miscounts existing `(user, provider)` pairs
  → UNIQUE constraint trip on migrate. **Mitigation:** pre-flight query in
  migration; log + skip duplicates (keep earliest `first_confirmed_at`).
- **Risk C:** Users with ongoing Google service grants lose access because
  the row gets rewritten. **Mitigation:** connect-mode logic is unchanged;
  `oauth_tokens` rows for connect-mode are untouched.
- **Rollback:** revert single commit. Migration is additive (new table +
  null-out columns); rollback SQL restores the nulled columns from
  `user_identity_links`.

## Artifacts

- ADR: `ADR-0018-oauth-identity-vs-service-separation.md` (to be written).
- Related session notes: to be written after commit.

## Outcome

- **Summary of what actually landed.** Single atomic commit. Adapter
  scope split across Google, GitHub, and Facebook (identity vs service,
  identity hard-coded as a security primitive, service env-overridable).
  New `user_identity_links` table + `src/domain/oauth/identity-links.js`
  module, with PK `(user_id, provider)` and UNIQUE `(provider,
  provider_subject)`. Login-mode OAuth callback no longer writes
  `oauth_tokens` — writes identity-links instead. Signup follows choice
  3a (identity-only; user explicitly connects services afterwards).
  `pending-confirm` module delegates its first-seen queries to
  identity-links. Migration backfills existing rows from `oauth_tokens`
  into `user_identity_links`. Test baseline rose from **504/20/36** to
  **539/14/38** (passing / skipped / suites), exit 0. New behavioural
  suite `oauth-identity-service-separation.test.js` (22 tests) plus 7
  static tripwires in `security-regression.test.js`. Two pre-F4
  assertions were rewritten to the new `user_identity_links` contract.

- **Deviation from plan.** None material. The generalised plan
  (Google + GitHub + Facebook) was adopted as-written. Raised two issues
  during implementation that reinforced the plan without changing
  direction: (1) `hasConfirmedBefore` + `recordFirstConfirmation` must
  migrate atomically with the login-side `oauth_tokens` skip, else every
  login re-fires the gesture; mitigated by delegating those entry points
  from `pending-confirm` to `identity-links` in the same commit. (2) the
  pending-confirm payload no longer needs access/refresh tokens in
  login-mode; stripped them for a small security-at-rest win.

- **Follow-ups created.** `F5-password-auth-hardening-and-consolidation`
  (backlog). UI has no password inputs today and the backend has three
  duplicate password-auth route files (`src/index.js:6823`,
  `src/routes/auth.js`, `src/auth.js`) that need consolidation +
  modern-primitive upgrade + UI surfacing (if the product decision is
  to keep password auth). Plus a later-milestone cleanup: drop
  `oauth_tokens.{provider_subject, first_confirmed_at}` after a
  monitoring window confirms no reads remain.

- **Lessons learned.**
  - Scope was the root cause we kept missing in F3 Pass 1 + Pass 2.
    `max_age=0` and `prompt=consent` were real bugs, but the reason the
    consent screen kept surfacing was that the authorize URL was
    requesting sensitive scopes on every single sign-in. The UX symptom
    survived the first two fixes because it was downstream of the scope
    choice.
  - Adapters should be safe-by-default. Making IDENTITY_SCOPES a
    hard-coded module constant rather than an env-configurable default
    stops future operators from silently widening the sign-in surface.
  - Two-table decomposition beats one-table with a discriminator column
    here — the identity and service lifecycles are genuinely different
    and their shared surface was a trap every time a cross-account flow
    showed up.
