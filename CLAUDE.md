# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Backend** (run from repo root):
```bash
node src/index.js          # Start server (port 4500)
npm test                   # Full integration test suite
npm run test:watch         # Watch mode
npm run test:coverage      # Coverage report (50% threshold enforced)

# Run a single test file
npx jest src/tests/integration.test.js --detectOpenHandles

# Run a specific test by name
npx jest --testNamePattern="vault token" --detectOpenHandles
```

**Frontend** (run from `src/public/dashboard-app/`):
```bash
npm run dev      # Vite dev server on port 5173 (hot reload)
npm run build    # Build to ../dist/ (served by Express at /dashboard/)
npm run lint     # ESLint
```

**Database**:
```bash
node src/scripts/init-db.js   # Initialize or reset DB schema
```

## Architecture

Three-tier: React dashboard → Express API gateway → SQLite database

### Backend Entry Point: `src/index.js`

Monolithic server file (~11.4k lines) that:
- Starts Express on port 4500 with Helmet, CORS, rate limiting
- Configures OAuth for 45+ services from `config/oauth.json` or env vars (pattern: `${VAR_NAME}` substitution, feature flags `ENABLE_OAUTH_{SERVICE}`)
- Initializes the DB and runs migrations on startup
- Mounts all routes from `src/routes/` under `/api/v1/`
- Serves the built React app from `src/public/dist/` at `/dashboard/`

### Request Flow

```
Request → auth middleware (src/middleware/auth.js)
        → scope-validator (src/middleware/scope-validator.js)
        → RBAC (src/middleware/rbac.js)
        → device approval gate (src/middleware/deviceApproval.js)
        → route handler (inlined in src/index.js, plus files under src/routes/)
        → database layer (src/database.js)
```

**Auth headers**: `Authorization: Bearer {token}` + `X-Workspace-ID: {id}` for multi-tenancy.

### Token Types

- **Access tokens** (`access_tokens` table): Master tokens for the owner
  (`token_type = 'master'`, full scope) and scoped tokens for agents.
  Stored as `bcrypt` hashes with AES-256-GCM-encrypted raw copies for
  dashboard display. Created via `createAccessToken()` in
  `src/database.js`; the CLI seed path is `npm run db:init` → 
  `src/scripts/init-db.js`, which calls the same function so headless
  installs produce usable master tokens.
- **Vault tokens** (`vault_tokens` table): Operator-added third-party API
  keys (OpenAI, Stripe, …). Stored encrypted with `VAULT_KEY`-derived
  AES-256-GCM (legacy AES-256-CBC decryption path is retained for
  backward compatibility and requires the real `VAULT_KEY` — no
  publicly-known default fallback).
- **OAuth tokens** (`oauth_tokens` table): Access + refresh tokens from
  the 45+ providers, AES-256-GCM with scoped `ENCRYPTION_KEY`. Carries
  `provider_subject` (provider stable id — Google `sub`, GitHub `id`,
  …) and `first_confirmed_at` (M3 / ADR-0016) for the first-seen
  confirm-gesture gate. **Always call `storeOAuthToken(service,
  userId, accessToken, refreshToken, expiresAt, scope, providerSubject)`
  with the 7th arg** — a source-level test in
  `src/tests/oauth-state-inventory.test.js` fails the build on any
  6-arg call.
- Scope hierarchy for access tokens: `admin:*` > `services:*` >
  `services:{name}:read`.

### OAuth state + confirm gesture (M3)

- **Do NOT stash OAuth state on `req.session`.** The legacy keys
  (`req.session.oauth_state`, `req.session.oauth_confirm`,
  `req.session.oauth_login_pending`, …) have been removed. All
  state lives in two DB tables: `oauth_state_tokens` (authorize ↔
  callback handshake, random PKCE verifier) and `oauth_pending_logins`
  (callback ↔ confirm-gesture accept/reject). The only session key
  that still survives from the OAuth flow is `req.session.oauth_signup`,
  which carries signup-wizard pending data.
- **All state-lifecycle calls go through `src/domain/oauth/`.**
  `state.js` owns `createStateToken` / `consumeStateToken` /
  `pruneExpiredStateTokens`. `pending-confirm.js` owns
  `createPendingConfirm` / `previewPendingConfirm` /
  `consumePendingConfirm` / `hasConfirmedBefore` /
  `recordFirstConfirmation` / `pruneExpiredPendingConfirms`.
  `prune-scheduler.js` composes the two `pruneExpired...` primitives
  into a single env-configurable background tick
  (`OAUTH_PRUNE_INTERVAL_MS`, `OAUTH_PRUNE_GRACE_SEC`).
- The pre-M3 `createStateToken` / `validateStateToken` /
  `cleanupExpiredStateTokens` exports have been deleted from
  `src/database.js`. Adding them back will fail
  `oauth-state-inventory.test.js`.
- Regression matrix for all five §5.4 scenarios lives in
  `src/tests/security-regression.test.js`. See `.context/decisions/`
  ADR-0006, ADR-0014, ADR-0016 for the full design rationale.

### Key Source Files

| File | Purpose |
|------|---------|
| `src/database.js` | SQLite (better-sqlite3), WAL mode, 50+ tables, all CRUD operations, schema migrations, token creation / OAuth token store / vault token store, key versioning and rotation. |
| `src/routes/` | Focused route modules: `admin`, `auth`, `services`, `skills`, `vault-instructions`, `workspaces`, `notifications`, `devices`, `email`, `invitations`, `import`, `export`. Most identity / preference / connector endpoints remain inlined in `src/index.js` pending the M6 monolith extraction. |
| `src/lib/encryption.js` | AES-256-GCM with PBKDF2 (600k iterations), authenticated encryption, key rotation, and (M2 / T2.1) `deriveSubkey(root, purpose)` HKDF-SHA-256 for domain-separated subkeys (`oauth:v1`, `session:v1`, `audit:v1`). |
| `src/lib/validate-secrets.js` | Boot-time gate for `SESSION_SECRET`, `JWT_SECRET`, `ENCRYPTION_KEY`, `VAULT_KEY`. Pure function; rejects empty / banned defaults (e.g. `change-me`, `default-vault-key-change-me`, and the verbatim `src/.env.example` placeholders) under every `NODE_ENV`. See ADR-0013 / T2.5. |
| `src/lib/context-engine.js` | Context caching and retrieval for AI interactions. |
| `src/lib/knowledge-base.js` | Knowledge base document operations. |

**Removed in M2 (ADR-0013)**: `src/utils/encryption.js` (weak `crypto-js`
module), `src/vault/vault.js`, `src/routes/api.js`,
`src/routes/management.js`, `src/brain/brain.js`, and
`src/gateway/tokens.js`. These were unreachable from `src/index.js` and
have been deleted. `crypto-js` itself is removed from `package.json` and
the nested `src/package.json`, and is enforced non-resolvable by
`src/tests/legacy-vault-inventory.test.js`. `src/gateway/audit.js` is
the lone survivor under `src/gateway/` — still orphaned today, tracked
for removal outside M2.

### Database

SQLite at `src/data/myapi.db` (controlled by `DB_PATH` env var). Key table groups:
- **Auth**: `vault_tokens`, `access_tokens`, `oauth_tokens`, `oauth_state_tokens`, `oauth_pending_logins`
- **Users/Identity**: `users`, `personas`, `handshakes`
- **AI/Knowledge**: `kb_documents`, `persona_documents`, `conversations`, `messages`, `context_cache`
- **Skills/Marketplace**: `skills`, `skill_versions`, `marketplace_listings`, `marketplace_ratings`
- **Multi-tenancy**: `workspaces`, `workspace_members`, `roles`, `role_permissions`
- **Billing/Compliance**: `billing_customers`, `billing_subscriptions`, `usage_daily`, `compliance_audit_log`
- **Audit**: `audit_log` (written for every API request)

### Frontend Structure

Base path `/dashboard/` (configured in `vite.config.js`). Key directories:
- `src/pages/` — 27 pages (Settings.jsx is ~79KB, AccessTokens.jsx ~35KB, Marketplace.jsx ~44KB)
- `src/components/` — 36 components; Layout.jsx is the nav/sidebar shell
- `src/stores/` — Zustand stores (authStore is central: user, tokens, workspaces, session)
- `src/utils/apiClient.js` — Axios instance with auth interceptors, workspace header injection, rate-limit backoff, and auto-redirect on 401

**Tailwind**: v3 (NOT v4). `postcss.config.js` uses `tailwindcss: {}` + `autoprefixer: {}`. `index.css` uses `@tailwind base/components/utilities` directives. v4 was intentionally reverted for old Android Chrome compatibility.

### Tests

Tests live in `src/tests/`. Jest is configured via `jest.config.js` with:
- `setupFiles`: `src/tests/setup-env.js` (env var setup)
- `setupFilesAfterEnv`: `src/tests/setup.js` (test lifecycle hooks)
- 10s timeout per test
- supertest for HTTP-level integration testing against a real in-memory DB

Test files follow phase-based naming: `integration.test.js`, `phase1-workspaces.test.js`, `phase2-billing.test.js`, `phase3.audit-security.test.js`, `phase5-retention.test.js`, etc.

**Live smoke tests** (run against a running server, not the in-memory app):
- `src/tests/oauth-authorize-url-live-smoke.test.js` — verifies the OAuth
  authorize URL the shipped binary produces (`prompt=select_account`, no
  `max_age=0` for Google login; connect-mode defaults, etc.). Gated on
  `SMOKE_URL` env var — skipped silently in normal `npm test` runs, only
  runs when explicitly pointed at a live server. Catches failure modes
  that unit tests can't: stale Docker image, bind-mount vs. COPY
  mismatch, env-var misconfig.
  ```powershell
  # Windows PowerShell
  $env:SMOKE_URL = "http://localhost:4500"; npm run smoke:oauth

  # Unix
  SMOKE_URL=http://localhost:4500 npm run smoke:oauth
  ```

### Environment

Copy `src/.env.example` to `src/.env`. Critical variables:
```
PORT=4500
ENCRYPTION_KEY=<32-char>     # AES-256-GCM OAuth token encryption
VAULT_KEY=<32-char>          # AES-256-GCM vault token encryption
JWT_SECRET=<secret>
SESSION_SECRET=<secret>
DB_PATH=./data/myapi.db
```

`src/index.js` calls `validateRequiredSecrets()` from
`src/lib/validate-secrets.js` during bootstrap, **in every NODE_ENV**.
The process exits with code 1 if any of `SESSION_SECRET`,
`JWT_SECRET`, `ENCRYPTION_KEY`, or `VAULT_KEY` is missing, whitespace,
or set to a known-insecure value — `change-me`, `changeme`, `secret`,
`password`, `default-vault-key-change-me`, or one of the verbatim
placeholders shipped in `src/.env.example` (e.g.
`your-vault-key-here-change-in-production`). Regenerate all four
secrets with `openssl rand -hex 32` (or equivalent) before booting, in
any environment.
