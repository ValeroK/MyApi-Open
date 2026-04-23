# MyApi — Architecture, Design, Testing & Security Plan

> Living planning document. Captures the **as-is** state, the **target** state,
> and the **gap** between them across architecture, design, testing, and security.
> This file is the source material we'll break into concrete tasks in a later pass.
>
> - Repo: `omribenami/MyApi-Open`
> - Runtime: Node.js 20+, Express 5, React 19 (Vite), SQLite (better-sqlite3) / PostgreSQL (optional)
> - Product: self-hosted personal API + AI-agent gateway that stores OAuth tokens and vault credentials
> - Last updated: 2026-04-21
> - Owner: repo maintainers + AI pairing sessions
> - Companion folder (to create): `.context/` — `current_state.md`, `roadmap.md`, `decisions/`, `tasks/`, `sessions/`

---

## 0. How to use this document

1. **Read top-to-bottom once** to understand the product, gaps, and priorities.
2. When we begin task breakdown, each **Workstream (§9)** becomes an epic and each
   numbered bullet underneath becomes a candidate task.
3. **Decisions** (§10) must be answered before their dependent tasks are scheduled.
4. This document is living — update the "As-is" sections whenever code changes, and
   add a dated entry under `.context/decisions/` when anything here is overruled.
5. Severity tags used below: `[C]` Critical, `[H]` High, `[M]` Medium, `[L]` Low,
   `[I]` Informational / nice-to-have.

---

## 0.1 Decisions log

Ratified answers to the open questions in §10. Date-stamped for traceability.

| Date | ID | Decision |
|------|----|----------|
| 2026-04-21 | OQ-1 | **Drop MongoDB entirely.** Delete `src/database-mongodb.js`, remove `mongodb` dep, strip Mongo branches in DB init. |
| 2026-04-21 | OQ-2 | **Dual-driver session + rate-limit store.** SQLite by default (`better-sqlite3-session-store`), Redis enabled when `REDIS_URL` is set. Both tested in CI. |
| 2026-04-21 | OQ-3 | **Adopt TypeScript.** Enable `tsc` with `checkJs` first, then progressively convert `src/domain/**` and `src/infra/crypto,http,session/**` to `.ts`. Frontend stays JSX for now. |
| 2026-04-21 | OQ-4 | **Feature parity OSS ↔ cloud.** Single codebase. No cloud-only forks. Differences only through env flags (e.g. `BILLING_ENABLED`, `REDIS_URL`, `AUDIT_EXPORT_ENABLED`). |
| 2026-04-21 | OQ-5 | **One-shot offline vault migration.** Run a single migration script that decrypts legacy `crypto-js` ciphertext and re-encrypts under AES-256-GCM; delete the legacy path in the same PR. No dual-read, no maintenance window (not in production yet). |
| 2026-04-21 | OQ-6 | **DB-backed OAuth state tokens.** Single-use, 10-minute TTL, PKCE `code_verifier` stored server-side in the same row. No HMAC-signed stateless tokens. |
| 2026-04-21 | OQ-7 | **Clean rewrite allowed.** We may break HTTP/JSON contracts in a single PR; no dual-format rollout needed. |
| 2026-04-21 | OQ-8 | **`npm audit` blocks at HIGH.** CI fails PRs with any HIGH or CRITICAL advisory. No `\|\| true`. |
| 2026-04-21 | OQ-9 | **Tiered coverage.** 80% for `src/domain/**`, `src/infra/crypto/**`, `src/infra/http/**`, `src/infra/session/**`. 50% floor elsewhere. Raise the global floor once the monolith is dismantled. |
| 2026-04-21 | OQ-10 | **Single-codebase SOC2 evidence.** All SOC2 instrumentation lives in OSS and is toggled on by env flags in cloud. Follows directly from OQ-4. |

---

## 1. Product & scope recap

MyApi is a privacy-first gateway between **a user's third-party services** (Google,
GitHub, Slack, Notion, 40+ OAuth providers) and **AI agents / personal tooling**.
Its job is to:

- Aggregate OAuth tokens and API keys behind one authenticated surface.
- Issue **scoped tokens** to agents, with device approval and full audit trail.
- Expose a stable REST + OpenAPI surface that AI tools can discover.
- Store sensitive material (OAuth access/refresh tokens, vault API keys, identity
  documents) encrypted at rest.

Because the product **is** an API-key custodian, **data confidentiality and key-custody
integrity are the primary non-functional requirements.** Everything else (DX, feature
velocity, UX polish) is subordinate to them.

---

## 2. Current-state snapshot (as-is)

### 2.1 Top-level layout

```
MyApi-Open/
├── src/
│   ├── index.js                    ~11.4k LOC monolithic Express server
│   ├── database.js                 ~3.6k LOC DB abstraction (SQLite + PG)
│   ├── database-mongodb.js         deprecated alternative backend
│   ├── auth.js  server.js  onboard.js  mcp-server.js
│   ├── routes/                     30 route modules mounted under /api/v1
│   ├── middleware/                 auth, rbac, scope-validator, deviceApproval,
│   │                               multitenancy, betaCap, agent-approval, codeReviewGate
│   ├── lib/                        encryption, ssrf-prevention, csrf-protection,
│   │                               xss-prevention, path-traversal-prevention,
│   │                               idor-prevention, data-exposure-prevention,
│   │                               crypto-security, oauth-security, tenant-manager,
│   │                               context-engine, knowledge-base, billing,
│   │                               alerting, backup-manager, migrationRunner, …
│   ├── services/                   oauth adapters (google/github/slack/discord/
│   │                               whatsapp/generic), email, notifications,
│   │                               code review, integration-layer
│   ├── brain/brain.js              PersonalBrain (scope/privacy filter)
│   ├── vault/vault.js              identity/connector vault  ⚠ weak crypto path
│   ├── config/database.js          legacy DB module (init-db only)
│   ├── gateway/tokens.js, audit.js legacy token + audit modules
│   ├── utils/encryption.js         ⚠ weak crypto-js AES without IV
│   ├── migrations/                 12 SQL migration files
│   ├── public/
│   │   ├── dashboard-app/          React 19 + Vite 7 + Tailwind 3 + Zustand
│   │   ├── landing/  legal/
│   │   └── turso-import.html       ⚠ UI for unauthenticated DB export
│   ├── scripts/                    init-db, migrate, backup, tenant
│   └── tests/                      Jest + supertest (19 test files)
├── connectors/
│   ├── afp-app/        afp-daemon/        afp-oauth/        agent-auth/        openai/
├── docs/                           ~50 Markdown docs (design, SOC2, audit,
│                                   services matrix, runbooks, legal)
├── config/nginx/
├── .github/workflows/              ci.yml, deploy.yml, build-afp-app.yml, sync-upstream.yml
├── docker-compose.yml  .dev.yml  .prod.yml  Dockerfile
├── package.json   jest.config.js
├── CLAUDE.md   SECURITY.md   README.md
└── verify_security_fixes.sh        shell-based regex tripwire for past fixes
```

### 2.2 Runtime architecture (as-is)

```
                    ┌───────────────────────────────────────────────┐
 Browser (React) ──▶│  Express 5  (src/index.js)                    │
 CLI / AFP / ASC ──▶│  Helmet → CORS → rate-limit → session → auth  │
 AI agent (HTTP) ──▶│   → scope → RBAC → device-approval → route    │
                    └──────────────┬──────────┬──────────┬──────────┘
                                   │          │          │
                             src/routes/*  src/brain  src/vault  (30 modules)
                                   │          │          │
                           ┌───────┴──────────┴──────────┴───────┐
                           │  src/database.js  (SQLite / PG)     │
                           │  src/lib/encryption.js (AES-256-GCM)│
                           └─────────────────────────────────────┘
                                   │
                           OAuth adapters → external providers (Google, GitHub, …)
                           SafeHTTPClient / SSRF lib (defined, not fully wired)
                           Sentry, email, Stripe, notifications (side channels)
```

### 2.3 Request lifecycle (actual, not the idealized one in README)

1. `requestContextMiddleware` — attaches correlation ID.
2. Helmet CSP (nonce for scripts, `'unsafe-inline'` still on styles), HSTS, X-CTO, Referrer-Policy, Permissions-Policy.
3. `cors` — dynamic origin validator (all origins in dev, wildcard-subdomain + Cloudflare-tunnel in prod).
4. `express.json({ limit: '100kb' })` and URL-encoded parsers.
5. Rate limiters: a global `express-rate-limit`, plus several bespoke in-memory maps with a cleanup interval.
6. `express-session` (MemoryStore by default — see Gap §5.3), 8h cap, 20m idle.
7. Route-level `authenticate` middleware:
   - Session cookie (highest priority) → `Authorization: Bearer` → fail.
   - Personal + scoped tokens are bcrypt-verified; a small in-process cache speeds hot paths.
   - Device approval applied **only** to bearer tokens, not browser sessions.
8. `scope-validator` → `rbac` → route handler → `database.js` → response.
9. `audit_log` / `compliance_audit_log` write on sensitive ops.

### 2.4 Data model (groups)

| Group | Key tables |
|---|---|
| Auth | `access_tokens`, `vault_tokens`, `oauth_tokens`, `state_tokens`, `approved_devices` |
| Identity | `users`, `personas`, `handshakes`, `identity_vault`, `connectors` |
| AI / KB | `kb_documents`, `persona_documents`, `conversations`, `messages`, `context_cache` |
| Skills | `skills`, `skill_versions`, `marketplace_listings`, `marketplace_ratings` |
| Multi-tenancy | `workspaces`, `workspace_members`, `roles`, `role_permissions`, `tenants` |
| Billing / SOC2 | `billing_customers`, `billing_subscriptions`, `usage_daily`, `compliance_audit_log` |
| Audit / Ops | `audit_log`, migrations metadata, backup ledgers |

### 2.5 Frontend snapshot

- **Stack:** React 19, Vite 7, Tailwind 3, Zustand 5, react-router 7, @tanstack/react-query 5, DOMPurify 3.
- **Pages (33):** Login / SignUp / Activate / OAuthAuthorize / Onboarding, Dashboard / DashboardHome, Identity / Personas(New) / Memory / KnowledgeBase, AccessTokens / APIKeys / TokenVault / GuestAccess / DeviceManagement, Connectors / ServiceConnectors, Skills / Marketplace / MyListings / FalImageGenerator, Settings / EnterpriseSettings / TeamSettings, Tickets / NotificationCenter / ActivityLog / BetaAdmin / UserManagement / PlatformDocs / ApiDocs.
- **Stores (10):** authStore, identityStore, knowledgeStore, notificationStore, personaStore, planLimitStore, servicesStore, settingsStore, skillStore, tokenStore.
- **Entry concerns today:** `Settings.jsx` ~79 KB, `AccessTokens.jsx` ~35 KB, `Marketplace.jsx` ~44 KB — candidates for splitting.

### 2.6 Testing snapshot

- **Framework:** Jest 30 + supertest 7, Babel presets for React/env.
- **Location:** `src/tests/` (19 files), plus `src/tests/__tests__/*.skip` disabled.
- **Coverage threshold:** 50% (branches/functions/lines/statements) enforced by `jest.config.js`.
- **CI:** `.github/workflows/ci.yml` runs lint (frontend), tests on Node 20 + 22, `npm audit --audit-level=high || true` (**non-blocking — to be made blocking per OQ-8**), Docker build.
- **No tests for:** the React dashboard, the AFP connectors, the OAuth adapters end-to-end, or the monolithic `src/index.js` hot paths (most integration tests use `supertest` against the real app but only cover a slice).

### 2.7 Deploy & ops snapshot

- **Dev:** `docker-compose.dev.yml` (hot reload, Vite on :5173, API on :4500).
- **Prod:** `docker-compose.prod.yml` + nginx + Let's Encrypt scripts in `scripts/setup-ssl.sh`.
- **Process supervision:** `ecosystem.config.js` (PM2).
- **Backups:** `scripts/backup.sh`, `scripts/restore.sh`, `src/lib/backup-manager.js`.
- **No:** structured logging, metrics/Prometheus, tracing, on-call alerting beyond `src/lib/alerting.js`, Dependabot config, SBOM, secret scanning in CI.

---

## 3. Architecture — target state

### 3.1 Guiding design principles

1. **Fail closed.** Any unconfigured secret, unknown scope, unresolvable host, or
   unknown tenant must deny access — never fall back to a default string.
2. **One authoritative implementation per concern.** Crypto, SSRF prevention, CSRF,
   auth, audit, DB access — each has exactly one entry point. No parallel legacy copies.
3. **Separate the API surface from its internals.** The monolith in `src/index.js`
   must shrink to a thin bootstrap; routes, OAuth, proxy, LLM gateway, and discovery
   endpoints become independently testable modules.
4. **Least privilege for tokens and scopes.** No wildcard admin. No bypasses for
   "special" flows (Discord bot install, etc.). Every permission must be explicit.
5. **Defense in depth.** Even if one layer fails (e.g. auth bug), the next layer
   (scope, RBAC, device approval, rate-limit, audit) still bounds the blast radius.
6. **Observability is a feature.** Every security-relevant event must be loggable,
   queryable, and alertable within minutes, with correlation IDs end-to-end.
7. **Make the right thing the default.** Secure helpers (`SafeHTTPClient`,
   `encryptObject`, `validateURL`, `requireScopes`) are easier to use than the raw
   primitives they replace.

### 3.2 Target high-level architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       src/index.js  (< 500 LOC bootstrap)                │
│  Loads config → validates secrets → builds app via createApp()           │
└────────┬────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  src/app/createApp.js                                                    │
│   ├─ src/app/middleware/        (chain: context, helmet, cors,          │
│   │                              body-parse, rate-limit, session,       │
│   │                              authenticate, scope, rbac, device)     │
│   ├─ src/app/routes/            (auth, oauth, tokens, services,         │
│   │                              proxy, llm-gateway, discovery,         │
│   │                              admin, billing, audit, health)         │
│   ├─ src/app/discovery/         (openapi.json, ai-plugin.json, /ask)    │
│   └─ src/app/errors/            (ErrorResponse, handler, redaction)     │
└────────┬────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Core domain services (pure, DB-agnostic where possible)                 │
│   ├─ src/domain/tokens/         (issuance, validation, revocation)      │
│   ├─ src/domain/oauth/          (authorize, callback, refresh, adapters)│
│   ├─ src/domain/vault/          (identity + connector storage, GCM-only)│
│   ├─ src/domain/brain/          (scope-filtered data access)            │
│   ├─ src/domain/audit/          (audit + compliance log writers)        │
│   └─ src/domain/billing/, tenants/, skills/, knowledge/, notifications/ │
└────────┬────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Infrastructure adapters                                                 │
│   ├─ src/infra/db/              (SQLite + PG, one query layer)          │
│   ├─ src/infra/crypto/          (AES-256-GCM, PBKDF2, HKDF, HMAC)       │
│   ├─ src/infra/http/            (SafeHTTPClient; pinned-IP dialer)      │
│   ├─ src/infra/session/         (Redis or SQL-backed store)             │
│   ├─ src/infra/rate-limit/      (Redis or SQL-backed buckets)           │
│   ├─ src/infra/sentry/ logger/  (redactors, correlation IDs)            │
│   └─ src/infra/email/ stripe/ notifications/                            │
└─────────────────────────────────────────────────────────────────────────┘
```

Key moves:

- Delete `src/utils/encryption.js`, `src/vault/vault.js` (rewritten into `src/domain/vault/`), `src/config/database.js`, `src/gateway/*` — or move them to `archive/` until refs are removed and tests green.
- Keep `src/lib/*` but reorganize into `src/infra/*` and `src/domain/*`.
- `src/index.js` becomes a thin bootstrap that calls `createApp(config)` and `listen`.

### 3.3 Architectural decisions (locked)

| ID | Decision | Status |
|----|----------|--------|
| AD-1 | **SQLite for self-host, PostgreSQL for managed cloud.** MongoDB is removed. Single abstraction layer in `src/infra/db/`. | Locked (OQ-1) |
| AD-2 | **Dual-driver session + rate-limit store.** SQLite by default; Redis via `REDIS_URL`. One interface, two implementations, both tested. | Locked (OQ-2) |
| AD-3 | **Rate-limit uses the same driver as sessions.** No in-process maps in prod. | Locked (OQ-2) |
| AD-4 | **In-process scheduler** (single-node) for self-host; swap to BullMQ/Redis in cloud automatically when `REDIS_URL` is set. | Locked |
| AD-5 | **Telemetry = Pino structured logs + OpenTelemetry traces.** Prometheus `/metrics` optional. | Locked |
| AD-6 | **Frontend stack** = React 19 + Vite + Zustand + react-query. No Redux, no server components yet. Frontend stays JSX until backend TS work stabilizes. | Locked |
| AD-7 | **Deployment target = Docker Compose.** Kubernetes optional, not required. | Locked |
| AD-8 | **Language = TypeScript for backend.** Progressive adoption: `tsc` + `checkJs` first, then `.ts` for `src/domain/**` and `src/infra/crypto,http,session/**`. | Locked (OQ-3) |
| AD-9 | **OSS ↔ cloud feature parity.** Single codebase; cloud-specific behavior is gated by env flags only. | Locked (OQ-4) |
| AD-10 | **OAuth state tokens are DB-backed, single-use, TTL 10m, with PKCE verifier stored server-side.** No HMAC-stateless path. | Locked (OQ-6) |

---

## 4. Best practices to enforce

Each item here is a **guardrail** — a CI check or lint rule or code-review gate
that makes it impossible (or at least noisy) to regress.

### 4.1 Code-level

- **ESLint on backend.** There is no backend ESLint config today. Add one
  (`eslint:recommended` + `plugin:security/recommended` + `plugin:node/recommended`
  + `@typescript-eslint` + Prettier). Fail CI on errors.
- **TypeScript (AD-8).** Introduce `tsconfig.json` with `checkJs: true, strict: true,
  noUncheckedIndexedAccess: true`. Convert `src/domain/**`, `src/infra/crypto/**`,
  `src/infra/http/**`, `src/infra/session/**` to `.ts` first (these are the
  modules where a type-system mistake is a security mistake). Everything else
  runs under `checkJs` with JSDoc types until it gets converted opportunistically.
- **Dependency hygiene.** `npm audit --audit-level=high` **blocks** CI (OQ-8);
  the previous `|| true` is removed. Add Dependabot + Renovate config.
- **Commit + PR conventions.** Conventional Commits, `CODEOWNERS`, PR template with
  security checklist. `pr-prep` skill already exists — wire it in.
- **No `any` long strings concatenated into SQL.** A lint rule / `grep` gate that
  rejects template-literal SQL outside a small allow-list of files.
- **Secrets scanning.** Add `gitleaks` or `trufflehog` to CI, pre-commit hook, and
  as a Cursor hook (via `create-hook` skill).

### 4.2 API & HTTP

- One **global error envelope** (`{ error: { code, message, correlationId } }`),
  no `err.message` leakage to clients.
- One **zod** / `express-validator` schema per request body, params, query.
- One **outbound HTTP client** (`SafeHTTPClient`) with SSRF + DNS-rebinding
  protection; forbid direct `fetch` / `https.request` in domain code.
- **HTTP method purity.** `GET` must be safe and idempotent; mutations always
  `POST` / `PUT` / `DELETE`. Audit endpoints that violate this.
- Every route **declares required scope + RBAC role + rate-limit class** in its
  handler registration, not buried in middleware.

### 4.3 Data & crypto

- **One crypto module**: AES-256-GCM + PBKDF2 (≥600k) or HKDF with a per-purpose
  info string. Delete `crypto-js`. Ban `crypto.createCipher` (no IV) via lint.
- **Per-purpose keys** derived from a single root `ENCRYPTION_KEY` (`oauth:v1`,
  `vault:v1`, `session:v1`) so rotation is per-subsystem.
- **Key rotation runbook** with a dual-write window; covered by integration tests.
- **At-rest encryption everywhere** for: OAuth tokens, vault API keys, identity
  documents, connector credentials, backup files, export ZIPs.
- **No encrypted data in URL query strings or log lines.** Enforced by logger
  redactor + Sentry `beforeSend` + audit log schema.

### 4.4 Frontend

- **No token in localStorage** beyond short-lived client-side session handles; use
  `httpOnly` cookies for auth. (Check each store in §2.5.)
- **No `dangerouslySetInnerHTML`** without DOMPurify — add lint rule.
- **Route-level code splitting** (pages already lazy-loadable) + asset size budget
  (≤ 300 KB initial JS, ≤ 1 MB total gzipped).
- **Accessibility**: `eslint-plugin-jsx-a11y` + Lighthouse CI for dashboard pages
  used on onboarding / OAuth confirm.

### 4.5 Docs as code

- Every domain module (`src/domain/*/README.md`) describes its contract and threat
  model in < 1 page.
- `.context/decisions/NNN-*.md` for every non-trivial tradeoff.
- `docs/runbooks/` for: incident response, key rotation, DB restore, Stripe
  webhook replay, OAuth provider outage, device approval revocation at scale.
- Keep `CLAUDE.md` in sync with code (today it says vault uses AES-256-GCM — it
  doesn't; see §6).

---

## 5. Testing strategy

### 5.1 Test pyramid — target mix

| Layer | Target share | Tools | Notes |
|---|---|---|---|
| Unit (pure functions, crypto, validators) | ~50% | Jest / Vitest | No network, no DB. |
| Integration (route + DB + middleware) | ~35% | Jest + supertest + in-memory SQLite; testcontainers for PG + Redis | Drivers matter: every session / rate-limit test runs against **both** SQLite and Redis (AD-2). |
| Contract (OAuth adapters, Stripe webhooks) | ~5% | nock / msw | Record-replay fixtures. |
| E2E (browser) | ~7% | Playwright | Onboarding, OAuth confirm, token creation, revocation. |
| Security regression | ~3% | Jest | See §5.4. |

### 5.1.1 Coverage policy — tiered (OQ-9)

The monolithic `src/index.js` is being actively disassembled; forcing 80% on it
before the refactor means writing tests that get deleted with the file. Policy:

| Scope | Coverage floor | Rationale |
|-------|----------------|-----------|
| `src/domain/**` | **80%** | Business rules; security-critical. |
| `src/infra/crypto/**` | **80%** | A bug here leaks every user's tokens. |
| `src/infra/http/**` (SafeHTTPClient, SSRF) | **80%** | A bug here turns the service into an SSRF relay. |
| `src/infra/session/**` | **80%** | Session/ratelimit correctness under both SQLite and Redis drivers. |
| `src/app/**` (routes, middleware) | **70%** | Thin glue; integration tests dominate. |
| `src/index.js` and remaining legacy | **50%** (current floor) | Temporary — floor rises as code migrates out. |

`jest.config.js` will declare these thresholds per path via the `coverageThreshold`
map. A CI job fails the build if any tier dips below its floor. When the monolith
is fully extracted (end of Workstream 2), the global floor is raised to 70%.

### 5.2 What's missing today

- **No frontend tests at all.** Add Vitest + React Testing Library for stores and
  critical screens (Login, OAuthAuthorize, Settings 2FA, TokenVault).
- **No E2E browser tests.** Playwright against the dev compose stack, run nightly
  + on PRs touching frontend or auth.
- **No contract tests for OAuth adapters.** Build a fixture set per provider;
  prevent silent breaks when providers change scopes.
- **No property / fuzz tests** on SSRF, SQL builder fragments, scope evaluator.
  Use `fast-check` to generate adversarial URLs, scopes, and table/column names.
- **Security regression tests** today are a mix of `src/tests/critical-security-fixes.test.js`
  + a shell script (`verify_security_fixes.sh`). The shell script is fragile —
  convert each check to a Jest test.
- **Coverage threshold at 50%** is too low for a secrets custodian. Target 80%
  on `src/domain/**` and `src/infra/crypto/**` + `src/infra/http/**`.

### 5.3 Test-infra improvements

- **Parallel-safe DB** per test with `:memory:` SQLite (already used in CI).
  Extend to PG integration tests via testcontainers for cloud build.
- **Deterministic clock + crypto seeds** for OAuth state, PKCE verifier,
  audit timestamps.
- **Golden-file** OpenAPI diff check: generated spec vs committed file.
- **Mutation testing** (Stryker) on `src/domain/tokens`, `src/domain/oauth`,
  `src/infra/crypto`.
- **Test data factories** (`@faker-js/faker`) instead of hand-rolled fixtures.

### 5.4 Security regression tests to add

- Attempt to access `/api/v1/turso/export-sql` → expect 401/404.
- Attempt OAuth callback with `state` missing + `guild_id` → expect 400.
- Attempt OAuth callback with reused `state` → expect 400.
- Attempt proxy to `http://169.254.169.254/…`, `http://[::ffff:127.0.0.1]/`,
  `http://0177.0.0.1/`, `http://2130706433/`, DNS-rebind host → expect 400.
- Attempt scope `admin:*`, `*:*`, `billing:*` → expect 403.
- Attempt to log in with stale / replayed `confirm_login` token → expect 401.
- Attempt to upload a 100-MB JSON body → expect 413.
- Attempt SQL with `;--` in `tableName`, `columnName` — ensure no execution.

---

## 6. Security overview

This section folds in the findings from the code/security review done before this
plan (see chat history). Severity tags reference that review.

### 6.1 Threat model (summary)

**Assets:** OAuth access + refresh tokens; vault API keys; user identity docs
(USER.md / SOUL.md); session cookies; master token; Stripe customer/subscription
IDs; audit log integrity.

**Adversaries:** unauthenticated internet caller; authenticated but low-scope
caller; malicious OAuth provider; compromised AI agent; malicious browser
extension on the user's dashboard; someone with stolen backup / DB file; curious
insider with log access.

**Primary attack surfaces:**

1. Public HTTP surface on `:4500` (Express, Helmet, CORS, `trust proxy = 1`).
2. OAuth callback endpoints across 40+ providers.
3. Outbound fetch surface (proxy endpoint, `/api/v1/ask` LLM router, discovery).
4. Backup + export ZIP pipeline.
5. Dashboard JS (XSS, CSRF, redirect).
6. Config files + env vars on disk.

### 6.2 Controls — as-is

- **Helmet** CSP (nonce scripts, `'unsafe-inline'` styles), HSTS,
  `upgrade-insecure-requests`, CSP report endpoint.
- **CORS** with dynamic origin validator.
- **Rate limiting** (global + per-route, in-memory).
- **Sessions** (`httpOnly`, `sameSite=lax`, `secure` via env), 8h cap, 20m idle,
  concurrent session limit, cleanup interval.
- **Auth**: bcrypt + per-token prefix cache; TOTP 2FA (`speakeasy`, `qrcode`).
- **Scope validator** rejects `admin:*` wildcards with CVSS-tagged audit log.
- **RBAC** middleware; device approval middleware; multi-tenancy middleware.
- **Crypto**: AES-256-GCM + PBKDF2 (600k) in `src/lib/encryption.js`.
- **SSRF lib** (`src/lib/ssrf-prevention.js`) with DNS validation and
  `SafeHTTPClient`.
- **Audit logs** (`audit_log`, `compliance_audit_log`).
- **Production secret validator** banning known defaults; exits on boot.
- **CSP reports** piped to `/api/v1/security/csp-report`.
- **Responsible-disclosure** policy in `SECURITY.md`.

### 6.3 Known gaps / risks (with severity)

Critical (fix before anything else ships to users):

- `[C]` **Unauthenticated full-DB SQL export** at `GET /api/v1/turso/export-sql`
  and the `/turso-import` UI page. Leaks every table including auth material.
- `[C]` **Open SQL relay** at `POST /api/v1/turso/execute` — arbitrary SQL +
  arbitrary upstream URL + caller-supplied Authorization header. SSRF + creds
  laundering vector.
- `[C]` **Weak `crypto-js` AES path** still used by `src/vault/vault.js` for
  `identity_vault` / `connectors`. Contradicts README/SECURITY.md claim of
  AES-256-GCM everywhere.
- `[C]` **`default-vault-key-change-me` fallback** remains in `src/database.js`
  lines 1424, 2798, 2838 and is only blocked in `NODE_ENV=production`.
- `[C]` **Hardcoded Google OAuth fallback strings** (`REMOVED_CLIENT_ID` /
  `REMOVED_SECRET`) suggest past secret exposure; confirm rotation.
- `[C]` **OAuth callback doesn't validate state against DB** + **Discord bot
  install bypass** of the state check.
- `[C]` **Proxy endpoint uses the weak `isPrivateHost` regex** instead of
  `src/lib/ssrf-prevention.js`.

High:

- `[H]` **Deterministic PKCE verifier** derived from `SESSION_SECRET` + state.
  PKCE assumes the verifier is unpredictable even if your session store leaks.
- `[H]` **CSP allows `'unsafe-inline'` for styles**; HTML nonce injection is
  regex-based.
- `[H]` **`/api/v1/ask` makes loopback HTTP** with caller's token — LLM-driven
  route to internal-only endpoints + scope loophole.
- `[H]` **Session-only OAuth state** storage (MemoryStore default) breaks under
  multi-instance deploys and does not revoke state on use.
- `[H]` **`trust proxy = 1`** is honored from any upstream; IP spoofing affects
  rate limits and audit log IP.
- `[H]` **Dashboard auto-confirms `oauth_status=confirm_login`** without a user
  gesture.
- `[H]` **No log / Sentry redaction** of `Authorization`, `code`, `state`,
  `refresh_token`, `client_secret`.

Medium:

- `[M]` Dynamic SQL column-list interpolation in `src/database.js` (hardcoded
  today, no defensive allow-list).
- `[M]` Dynamic `UPDATE ... SET ${sets.join(',')}` pattern in 5 places.
- `[M]` Global `express.json({ limit: '100kb' })` is per-request, not
  per-connection or per-minute.
- `[M]` Dev CORS allows all origins + credentials.
- `[M]` In-memory `global.sessions` and rate-limit buckets.
- `[M]` bcrypt for high-entropy opaque tokens (overkill; use HMAC-SHA-256 + pepper).
- `[M]` Device approval only on bearer tokens, not on browser sessions.
- `[M]` Wildcard scope rejection only catches `admin:*`.
- `[M]` HTML nonce injection via regex (line 1330 of `src/index.js`).

Lower / code-quality:

- `[L]` `src/index.js` ~11.4k LOC; hot paths untestable.
- `[L]` Legacy/orphan stack (`config/database.js`, `gateway/tokens.js`,
  `gateway/audit.js`, `vault/vault.js`, `utils/encryption.js`, `scripts/init-db.js`).
- `[L]` `CLAUDE.md` inaccurate about vault crypto.
- `[L]` No central outbound-HTTP client in use.
- `[L]` No CSRF tokens for session-authed state-changing admin endpoints.
- `[L]` `oauth.json` loaded with no schema validation.
- `[L]` `.gitignore` does not ignore `/.env*` at root — only `.env` and `src/.env*`.
- `[L]` Error responses leak `err.message`.
- `[L]` No SRI on any CDN-served asset.

### 6.4 Target security controls (end-state)

- **Key management**: root `ENCRYPTION_KEY` stays out of DB and logs; per-purpose
  subkeys derived via HKDF; rotation runbook + `rotateKey()` helper.
- **Outbound HTTP**: `SafeHTTPClient` is the only way to call out; resolves DNS
  once, dials IP directly, re-validates on every redirect.
- **Inbound trust**: `trust proxy` is either disabled or set to a CIDR list;
  node listens only on loopback when behind a proxy.
- **OAuth state + PKCE (AD-10)**: DB-backed state rows in `state_tokens`, single-use
  (marked `used_at` on first callback hit), TTL 10m, random `code_verifier`
  generated with `crypto.randomBytes(32)` and stored in the same row. No HMAC /
  stateless path. No Discord-install or other bypasses. Expired / used rows
  pruned on a schedule.
- **Session + rate-limit (AD-2, AD-3)**: SQLite-backed by default; Redis when
  `REDIS_URL` is set. Same API surface in both. Both drivers exercised in CI.
- **Audit + compliance log**: append-only (enforced by SQL trigger), time-ordered,
  signed with monthly Merkle root published via `/.well-known/audit-root.json`.
- **Backup + export**: encrypted, integrity-checked (HMAC over manifest), restore
  covered by tests.
- **Supply chain**: Dependabot, Renovate, signed Docker images (cosign),
  SBOM generation via `cyclonedx-npm`, SLSA provenance where feasible.
- **Secrets**: secret scanning in CI + pre-commit; "banned defaults" list checked
  in all environments, not just prod.
- **Logging / monitoring**: Pino + OTel; redactor enforced; alerts on: auth spike,
  scope denial spike, CSP report spike, audit log write failure, backup failure.

---

## 7. Observability & operations

### 7.1 As-is

- `src/lib/alerting.js` (unknown depth of integration).
- `src/lib/request-context.js` for correlation IDs.
- Sentry is initialized at app boot.
- Backup CLI (`scripts/backup.sh`, `src/lib/backup-manager.js`).
- SSL scripts for Let's Encrypt (`scripts/setup-ssl.sh`).
- Health endpoint at `/api/v1/health`.

### 7.2 Target

- **Logs**: Pino, JSON, correlation ID every line; level controlled by env;
  field-level redactor for `authorization`, `cookie`, `code`, `state`, `token`,
  `refresh_token`, `client_secret`, `password`, `email` (configurable PII).
- **Metrics**: `/metrics` Prometheus endpoint (request count/latency, auth
  attempts, OAuth callbacks, audit write count, rate-limit hits).
- **Traces**: OpenTelemetry with OTLP exporter; trace ID == correlation ID.
- **Alerts** (starter): 5xx spike, auth failure spike, CSP violation spike, audit
  log write failure, backup failure, cert expiring ≤ 14 days.
- **Runbooks**: in `docs/runbooks/` — see §4.5.
- **Dashboards**: one-page Grafana / equivalent covering the metrics above.

---

## 8. CI/CD & quality gates

### 8.1 As-is

- CI jobs: lint (frontend only), test (Node 20 + 22), security (`npm audit`
  non-blocking), docker build. Deploy workflow exists.

### 8.2 Target gates (all blocking on PR to `main`)

1. Backend + frontend lint pass.
2. Tests pass with coverage ≥ 80% for `src/domain/**` and `src/infra/crypto/**`,
   `src/infra/http/**`; ≥ 60% overall.
3. `npm audit --audit-level=high` passes (OQ-8 — blocks on any HIGH or
   CRITICAL advisory; no `|| true`, no silent fallbacks).
4. `gitleaks` / `trufflehog` clean.
5. SBOM generated and uploaded as artifact.
6. Frontend bundle size within budget.
7. OpenAPI golden diff: no unintended schema changes.
8. Security regression suite (§5.4) green.
9. Docker image builds and scans (Trivy) with no HIGH/CRITICAL.

Nightly:

- Playwright E2E against dev stack.
- Mutation testing on crypto + token domain.
- `npm audit` + dependency freshness report.

---

## 9. Workstreams (to be broken into tasks later)

Each workstream has a rough order-of-magnitude effort tag: **XS** (≤0.5d),
**S** (1–2d), **M** (3–5d), **L** (1–2w), **XL** (≥2w). Priorities use a
MoSCoW scale.

### Workstream 0 — Planning & `.context/` scaffolding

- [Must, XS] Create `.context/` with `current_state.md`, `roadmap.md`,
  `decisions/`, `tasks/{backlog,in_progress,completed}/`, `sessions/`, and
  `TEMPLATE.md` files.
- [Must, XS] Seed `.context/current_state.md` from §2 of this plan.
- [Must, XS] Seed `.context/roadmap.md` from §9 workstream titles + target
  milestones.
- [Should, XS] Add a Cursor rule (`.cursor/rules/context-folder.md`) that
  reminds the agent to update `.context/` on task transitions.

### Workstream 1 — Critical security remediations (fire-fight)

Directly maps to §6.3 Critical findings.

- [Must, S] Remove `/turso-import` + `/api/v1/turso/export-sql` + `/api/v1/turso/execute`.
- [Must, S] Remove `REMOVED_CLIENT_ID` / `REMOVED_SECRET` OAuth fallbacks; rotate
  Google client credentials; audit git history for other leaked secrets.
- [Must, M] Kill `default-vault-key-change-me` fallback in all code paths; ensure
  unconditional secret validation at boot.
- [Must, M] **One-shot vault re-encryption (OQ-5).** Single migration script:
  read all `identity_vault` + `connectors` rows, decrypt with the legacy
  `crypto-js` code, re-encrypt under AES-256-GCM (`src/lib/encryption.js`),
  write back, verify row count + HMAC. Delete `src/utils/encryption.js` and
  rewrite `src/vault/vault.js` as `src/domain/vault/` in the **same PR**.
  No dual-read, no maintenance window (OQ-7: not in production yet).
- [Must, M] **DB-backed OAuth state (AD-10).** Replace session-based state
  validation with a `state_tokens` row lookup; mark `used_at` on first hit;
  reject expired, missing, or already-used rows. Remove the Discord
  bot-install state bypass. Store the PKCE verifier server-side in the same
  row — this also closes H1 (deterministic PKCE verifier).
- [Must, S] Wire `src/lib/ssrf-prevention.js` into the proxy endpoint,
  `/api/v1/ask`, discovery endpoints, and any webhook egress.
- [Must, XS] Update `CLAUDE.md`, `SECURITY.md`, and `README.md` to reflect reality
  once these land.

### Workstream 2 — Architecture refactor

- [Must, L] Extract a thin `src/index.js` bootstrap + `createApp()`.
- [Must, L] Split routes from `src/index.js` into `src/app/routes/*`.
- [Should, M] Move `src/lib/*` into `src/domain/*` and `src/infra/*` per §3.2.
- [Should, M] Delete `src/config/database.js`, `src/gateway/*`, `src/vault/vault.js`,
  `src/utils/encryption.js` once superseded. Archive `src/scripts/init-db.js` or
  rewrite on top of `src/database.js`.
- [Must, M] **Adopt TypeScript (AD-8, OQ-3).** `tsconfig.json` with
  `checkJs + strict + noUncheckedIndexedAccess`; convert `src/domain/**`,
  `src/infra/crypto/**`, `src/infra/http/**`, `src/infra/session/**` to `.ts`.
  Legacy files run under `checkJs` with JSDoc until converted.
- [Must, S] **Remove MongoDB entirely (OQ-1).** Delete `src/database-mongodb.js`,
  drop the `mongodb` dependency, strip Mongo branches from DB init in
  `src/index.js`, remove Mongo docs.

### Workstream 3 — Auth, session, and token hardening

- [Must, M] **Dual-driver session store (AD-2).** Define a `SessionStore`
  interface in `src/infra/session/`; implement `SqliteSessionStore` (default,
  using `better-sqlite3-session-store`) and `RedisSessionStore` (enabled when
  `REDIS_URL` is set). Wire into `express-session`. Integration-test both.
- [Must, S] **Dual-driver rate-limit store (AD-3).** Same pattern as sessions;
  shared backend between `express-rate-limit` and any bespoke limiters.
  Delete the in-memory `Map` buckets and `rateLimitCleanupInterval`.
- [Must, S] **Random server-side PKCE verifier.** Subsumed by the
  `state_tokens`-row change (AD-10); tracked here so it isn't missed.
- [Must, S] Replace bcrypt for opaque tokens with HMAC-SHA-256 + pepper
  (keep bcrypt for user passwords).
- [Must, S] Apply device-approval to browser sessions (configurable).
- [Must, XS] Harden `trust proxy` to a CIDR list or loopback-only bind.
- [Should, S] Generalize wildcard-scope rejection to all `*` forms.
- [Should, S] Require user gesture on `/oauth/confirm`.

### Workstream 4 — Output hygiene, CSP, frontend

- [Must, S] Strip `'unsafe-inline'` from CSS and move styles to files;
  replace regex HTML nonce injection with an HTML parser.
- [Must, S] Central error envelope + redactor + Sentry `beforeSend`.
- [Should, S] CSRF tokens for admin state-changing endpoints.
- [Should, M] Code-split heavy dashboard pages; asset budget in CI.
- [Should, S] `eslint-plugin-jsx-a11y` + Lighthouse CI.
- [Could, M] Replace localStorage token handoff with `httpOnly` cookie flow.

### Workstream 5 — Database, migrations, and integrity

- [Must, M] Replace dynamic-column SQL with an allow-list helper; add lint rule.
- [Must, S] Append-only audit log: DB trigger preventing update/delete.
- [Should, M] Monthly Merkle root of audit log; publish via
  `/.well-known/audit-root.json`.
- [Should, M] Strict `oauth.json` schema + validate at boot.
- [Could, L] PG integration tests via testcontainers; finalize PG parity.

### Workstream 6 — Testing uplift

- [Must, M] Backend ESLint config + Prettier; fail CI on errors.
- [Must, M] Raise coverage thresholds tiered by module (§5.1).
- [Must, M] Convert `verify_security_fixes.sh` into Jest suites.
- [Must, M] Add security regression suite per §5.4.
- [Should, L] Introduce Vitest + React Testing Library + Playwright.
- [Should, M] Contract tests for OAuth adapters.
- [Could, M] Mutation testing on crypto + token modules.

### Workstream 7 — Observability & ops

- [Must, M] Pino structured logging + redactor; replace `console.*`.
- [Must, S] Correlation ID on every log / Sentry event / audit row.
- [Should, M] Prometheus `/metrics` + minimal Grafana dashboard.
- [Should, M] OpenTelemetry traces; OTLP export.
- [Should, S] Alert rules for 5xx/auth/CSP/backup/cert expiry.
- [Should, M] Runbooks: incident, key rotation, DB restore, Stripe replay,
  OAuth provider outage, mass device revocation.

### Workstream 8 — CI/CD and supply-chain

- [Must, XS] **`npm audit` blocking at HIGH (OQ-8).** Remove `|| true` from
  `.github/workflows/ci.yml` security job; fail the build on any HIGH/CRITICAL.
- [Must, S] Add `gitleaks` / `trufflehog` in CI + pre-commit.
- [Must, S] SBOM via `cyclonedx-npm`; artifact retention.
- [Should, S] Trivy scan on Docker image.
- [Should, S] Dependabot + Renovate.
- [Could, M] Cosign image signing + SLSA provenance.

### Workstream 9 — Documentation & `.context/` upkeep

- [Must, XS] Fix `CLAUDE.md` vault-crypto claim.
- [Must, S] Consolidate overlapping docs in `docs/`.
- [Should, S] Document the `src/` target layout and migration.
- [Should, S] Architecture Decision Records under `.context/decisions/`.
- [Should, XS] This `plan.md` is the index; keep a "Last updated" header
  accurate.

---

## 10. Open questions

All ten original decisions (OQ-1 through OQ-10) have been ratified — see the
**Decisions log** in §0.1. New questions surfaced by the ratified answers:

| # | Decision | Dependency | Proposed default |
|---|----------|------------|------------------|
| OQ-11 | Redis TLS: require it whenever `REDIS_URL` is set, or only above a configurable flag? | WS-3 | Require TLS if the URL scheme is `rediss://`; warn but allow plain `redis://` for local dev only. |
| OQ-12 | Do we run Postgres integration tests in CI (testcontainers), or defer until the cloud deploy pipeline? | WS-5, WS-6 | Run on `main` pushes and nightly; skip on PR unless `ci:pg` label present. |
| OQ-13 | Which PII fields are redacted by default in the Pino logger (beyond credentials)? | WS-7 | `email`, `ipAddress`, `userAgent` off by default; opt-in via `LOG_INCLUDE_PII=1`. |
| OQ-14 | Target Node.js floor — stay at 20 or bump to 22 LTS? | WS-8 | Node 22 as minimum; matrix-test 20 + 22 during transition, drop 20 after two minor releases. |
| OQ-15 | TypeScript strictness ceiling — turn on `exactOptionalPropertyTypes` from day one or wait? | WS-2 | Turn on from day one in the new `src/domain/**` TS files only. |

Add new entries here as design choices arise during implementation; promote to
the Decisions log (§0.1) once resolved.

---

## 11. Summary — priorities in one paragraph

**Stop the bleeding first** (Workstream 1): remove the three Turso endpoints, kill
hardcoded OAuth fallbacks, retire `crypto-js`, DB-validate OAuth state, kill the
Discord bypass, and switch the proxy onto `SafeHTTPClient`. **Then break up the
monolith** (Workstream 2) just enough to make the crypto and outbound-HTTP paths
independently testable — this is where most remaining risk lives. **In parallel,
stand up the `.context/` folder, baseline tests, structured logs, and CI gates**
(Workstreams 0, 6, 7, 8) so every subsequent change carries its own proof. The
rest (frontend polish, OTel traces, TypeScript, marketplace features) follows
only after the custodial guarantees are airtight — because if MyApi leaks an API
key, none of the UX matters.

---

_End of plan.md — next step: scaffold `.context/` (Workstream 0) then break
Workstream 1 into concrete tasks under `.context/tasks/backlog/` using
`.context/tasks/TEMPLATE.md`._
