# Current state — MyApi

> **Purpose.** 5-minute snapshot of where the project is today. Skim this before
> starting any session. Longer context lives in [`plan.md`](plan.md). Tactical
> tracker is [`TASKS.md`](TASKS.md).
>
> - Last updated: **2026-04-21**
> - Maintainer: repo owners + AI pairing sessions
> - Status: **pre-production.** Not yet deployed to real users; clean-rewrite
>   latitude granted per ADR-0007.

---

## 1. What MyApi is

A self-hosted personal API + AI-agent gateway that aggregates 40+ OAuth
providers and vault credentials behind one authenticated surface, issues scoped
tokens to agents with device approval, and produces a complete audit trail.

**Primary non-functional requirement:** key-custody integrity. Everything else
is subordinate.

## 1a. Quality baseline (2026-04-21)

| Gate | Today | Blocking? | Notes |
|------|-------|-----------|-------|
| `npm test` | **19 / 19 suites, 227 pass / 18 skip, exit 0** (~13 s) | **Hard gate** | Do not merge anything that reduces this count. |
| `npm audit --audit-level=high` | clean (ADR-0008) | **Hard gate** | Per ADR-0008, blocks at HIGH+. |
| `npm run lint:backend` | 243 problems (112 errors / 131 warnings) | Report-only (ADR-0012) | Ratchet-only: don't grow on files you touched. |
| `npm run typecheck` | 739 `error TS*` under strict `checkJs` | Report-only (ADR-0012) | Drops as legacy JS converts to TS (M7). |

Test-first workflow is binding — see `.cursor/rules/test-first.mdc` and
ADR-0012.

## 2. Stack snapshot

| Layer | Today |
|-------|-------|
| Backend | Node.js ≥ 20 (targeting 22), Express 5, `better-sqlite3` / PostgreSQL |
| Frontend | React 19, Vite 7, Tailwind 3, Zustand 5, react-router 7, @tanstack/react-query 5, DOMPurify 3 |
| Tests | Jest 30 + supertest 7, 19 backend test files, 50% coverage floor |
| CI | `.github/workflows/ci.yml` — frontend lint, Node 20+22 tests, `npm audit` (non-blocking), Docker build |
| Deploy | `docker-compose.{dev,prod}.yml` + nginx + Let's Encrypt, PM2 ecosystem file |
| Observability | Sentry, correlation-ID middleware, `src/lib/alerting.js`. **No** Pino, metrics, tracing, SBOM, secret scanning. |

## 3. Architecture today

- **Monolithic gateway** in `src/index.js` (~11.4k LOC) with 30 route modules
  mounted under `/api/v1/*`.
- **Two co-existing crypto modules**: `src/lib/encryption.js` (AES-256-GCM — correct)
  and `src/utils/encryption.js` (`crypto-js` without IV — broken). The broken
  one is still used by `src/vault/vault.js`.
- **Two SSRF filters**: `src/lib/ssrf-prevention.js` (robust, underused) and
  an inline `isPrivateHost` regex (used by the actual proxy endpoint).
- **Sessions + rate-limits** are in-process `Map`s by default.
- **MongoDB** support (`src/database-mongodb.js`) is still a branch but
  deprecated — scheduled for deletion (ADR-0001).

Target architecture is documented in `plan.md` §3.2.

## 4. Known critical risks (from `plan.md` §6.3)

Every item here must be closed before we onboard real users.

| Ref | Risk | Tracked in |
|-----|------|------------|
| [C] Unauthenticated DB export at `GET /api/v1/turso/export-sql` | Leaks every row in every table. | `TASKS.md` M1 |
| [C] Open SQL relay at `POST /api/v1/turso/execute` | SSRF + credential-laundering hop. | `TASKS.md` M1 |
| [C] Weak `crypto-js` path in `src/vault/vault.js` | Vault ciphertext is not IND-CPA secure. | `TASKS.md` M2 |
| [C] `default-vault-key-change-me` fallback in `src/database.js` | Secret validation only runs in `NODE_ENV=production`. | `TASKS.md` M2 |
| [C] Hardcoded Google OAuth client/secret strings (`REMOVED_…`) | Past secret exposure; rotate + remove. | `TASKS.md` M1 |
| [C] OAuth state not DB-validated + Discord bot-install state bypass | CSRF on every OAuth link flow. | `TASKS.md` M3 |
| [C] Proxy endpoint uses weak `isPrivateHost` regex | SSRF via URL obfuscation. | `TASKS.md` M5 |

High/Medium/Low risks are enumerated in `plan.md` §6.3.

## 5. What changed recently

- **2026-04-21 (latest)** — Pre-M2 baseline lock:
  - `npm install` run at the repo root (716 packages); `node_modules/`
    populated. Fixed Windows-only `EBUSY` teardown flake in
    `oauth-security-hardening.test.js` (new `safeUnlink` helper that retries
    and cleans `-wal` / `-shm` siblings).
  - Full `npm test --silent` rerun is **19 / 19 suites, 227 pass, 18 skip,
    exit 0, ~13 s**. Locked as the M2 gate.
  - Measured lint + tsc baselines on the legacy monolith: 243 problems
    (112 errors / 131 warnings) and 739 `tsc` diagnostics. Both are expected
    and progressive (per M0/M7); no PR may grow them on files it touches.
  - CI: `lint-backend` and `typecheck` jobs flipped to `continue-on-error`
    with baseline comments; `docker` job now depends only on `test` +
    `security`. `tsconfig.json` excludes `src/docs/**`.
  - New rule `.cursor/rules/test-first.mdc` codifies "run `npm test` before
    and after each step; add tests with every change". New ADR-0012 records
    the doctrine + the ratchet plan.
- **2026-04-21** — T1.6 gitleaks baseline scan:
  - `gitleaks 8.30.1` run in history mode (`--log-opts "--all --full-history"`,
    23 commits, 6.4 MB) and working-tree mode (`--no-git`, 5.2 MB).
  - 12 history + 14 worktree findings triaged. 11 are placeholders (curl
    examples, empty `.env` template keys, the redactor's own docstring,
    mock tokenIds) — now suppressed with rationale in `.gitleaksignore`.
  - 3 findings were real-looking `myapi_…` tokens: one in
    `docs/AGENT_README.md` and two (`MASTER_TOKEN`, `GUEST_TOKEN`) in
    `qa-tests/phase1-security.js`. All three removed from HEAD; the QA
    script now refuses to run without `QA_MASTER_TOKEN` / `QA_GUEST_TOKEN`
    env vars. Historical commits still hold the ciphertext, so those tokens
    must be **revoked in the MyApi DB** — catalogued in ADR-0011.
  - Rescan after fixes: **exit 0 / "no leaks found"** in both modes.
  - Owner confirmed the 3 Bucket-C tokens were dev-only test tokens against
    local `localhost:4500` instances → no provider rotation required. T1.6
    closed. T1.6b (CI `gitleaks protect`) deferred into M14. See
    `.context/decisions/ADR-0011-gitleaks-scan-2026-04-21.md`.
- **2026-04-21 (late)** — M0 foundations + M1 fire-fight landed:
  - `.context/` scaffolded with `current_state.md`, `roadmap.md`, task /
    decision / session templates, and 10 ADRs (`ADR-0001..ADR-0010`).
    Plan and task tracker moved under `.context/`.
  - Backend ESLint flat config (`eslint.config.js`) with `eslint:recommended`
    + `eslint-plugin-security` + `eslint-plugin-n`, stricter rules for
    security-critical paths, relaxed rules on the legacy monolith.
  - `tsconfig.json` at repo root with `checkJs + strict + noUncheckedIndexedAccess`
    (no `.ts` files yet).
  - `.editorconfig`, `.prettierrc.json`, `.prettierignore`.
  - `.github/CODEOWNERS`, `.github/pull_request_template.md` with security
    + `.context/` checklists.
  - `.cursor/rules/context-folder.mdc` teaches the agent to update
    `.context/` on every task transition.
  - CI (`.github/workflows/ci.yml`) gained `lint-backend`, `lint-frontend`,
    `typecheck` jobs; security audit is now blocking at HIGH+ (ADR-0008).
  - `package.json` gains `eslint`, `eslint-plugin-security`, `eslint-plugin-n`,
    `eslint-config-prettier`, `prettier`, `typescript` as devDeps and
    `lint`, `lint:backend`, `lint:frontend`, `typecheck`, `format`,
    `format:check` scripts. **Needs `npm install` locally to resolve.**
  - **M1 deletions:** the three Turso endpoints (`/turso-import`,
    `/api/v1/turso/export-sql`, `/api/v1/turso/execute`) and
    `src/public/turso-import.html` are gone.
    Hardcoded `REMOVED_CLIENT_ID` / `REMOVED_SECRET` Google OAuth fallbacks
    replaced with fail-closed defaults (`google.enabled` computed from env).
    Regression test suite in `src/tests/security-regression.test.js` locks
    the deletions.
- **2026-04-21 (earlier)** — `.context/` design finalized; 10 architectural
  decisions (ADR-0001..ADR-0010) ratified; `plan.md` and `TASKS.md` first
  drafted with 15 milestones and 120 tasks.

## 6. Active focus

- **Now:** M2 — consolidate crypto + one-shot vault migration. First task is
  inspecting the actual state of `src/utils/encryption.js` and the nested
  `src/package.json` / `src/package-lock.json` that still pull `crypto-js`
  (root `package.json` does not). Finding: the vulnerable path lives in
  a nested install, not the top-level dependency tree.
- **Next:** M3 OAuth state + PKCE hardening (DB-backed `state_tokens`,
  random PKCE verifier, remove Discord bypass).
- **Blocked / waiting on a human:**
  - **Google OAuth credential rotation** at the provider — tracked for M3
    hardening. Not urgent since `REMOVED_…` fallbacks are gone and
    `google.enabled` is now computed from env.
  - **`npm install`** at the repo root to pull the new devDeps
    (`eslint`, `typescript`, `prettier`, plugins) so `npm run lint:backend`
    and `npm run typecheck` work locally. CI will do this automatically.

## 7. Pointers

- Workstream breakdown: [`plan.md` §9](plan.md#9-workstreams-to-be-broken-into-tasks-later)
- Milestone tracker: [`TASKS.md`](TASKS.md)
- Ratified decisions: [`plan.md` §0.1](plan.md#01-decisions-log) + `decisions/ADR-*.md`
- Open design questions: [`plan.md` §10](plan.md#10-open-questions) (OQ-11..OQ-15)
