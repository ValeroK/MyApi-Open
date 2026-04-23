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
| `npm test` | **22 / 22 suites, 269 pass / 18 skip, exit 0** (~17 s) | **Hard gate** | Do not merge anything that reduces this count. |
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

- **2026-04-21 (latest)** — M2 Step 4 (T2.1): `deriveSubkey(root, purpose)`
  HKDF-SHA-256 primitive added to `src/lib/encryption.js`:
  - **API shape.** `deriveSubkey(root, purpose, opts?)` → `Buffer`.
    `root` is a Buffer or clean even-length hex string (≥ 32 bytes);
    `purpose` is a whitelisted label from the frozen export
    `SUBKEY_PURPOSES = ['oauth:v1', 'session:v1', 'audit:v1']`. Defaults
    to a 32-byte output (drops into AES-256-GCM); accepts 16..64. Opt
    `salt` is a third separation axis; RFC 5869 §2.2 default is a
    `HashLen` zero buffer when salt is absent.
  - **Implementation.** Node's native `crypto.hkdfSync('sha256', …)`.
    The `info` parameter carries the purpose label, which is what
    buys domain separation — two purposes produce statistically
    independent outputs from the same root.
  - **Fail-closed validation.** Unregistered purpose, empty purpose,
    non-string purpose, short/non-Buffer-non-string/malformed-hex root,
    length outside `[16, 64]` all throw the single generic message
    `"Subkey derivation failed"`; root + purpose never appear in
    errors. Test + KAT escape hatches (`allowUnregisteredPurpose`,
    `allowShortRoot`) exist only so RFC 5869 vectors can run without
    weakening the production contract.
  - **Test.** New `src/tests/encryption-deriveSubkey.test.js`, 22
    assertions across 5 describe blocks, written **red-first** (all
    failing with `TypeError: deriveSubkey is not a function`) and
    landed green in the same commit as the implementation. Covers:
    module surface + frozen purpose list, RFC 5869 Test Case 1 KAT
    (exact byte match on 42-byte OKM), determinism, three-way domain
    separation (oauth/session/audit), root-hex ↔ root-Buffer
    equivalence, obvious-distance sanity (output ≠ root[0..32],
    output ≠ sha256(root)), full input-validation matrix, and an
    end-to-end AES-256-GCM round-trip (oauth-encrypted ciphertext
    fails to decrypt under the session subkey — the whole point).
  - Full `npm test --silent` → **22 / 22 suites, 269 pass, 18 skip,
    exit 0** (was 21/21/247 at end of Step 3; +1 suite and +22 tests).
  - No behavior change for any existing `src/lib/encryption.js`
    consumer; the new function + constant are purely additive. Wiring
    consumers (OAuth token encryption, session cookie signing, audit
    MAC) is M3+ scope per ADR-0013 §Follow-ups.
  - Commit: `fce3074`.
- **2026-04-21** — M2 Step 3 (T2.10): nested Docker manifest
  scrubbed of `crypto-js`:
  - **Constraint discovered:** the repo's `Dockerfile` does
    `COPY src/package*.json ./src/` + `cd src && npm ci --only=production`
    and then runs `node index.js` from `/app/src` — so
    `src/package.json` is the production dep manifest for every
    containerized deploy, not a dead relic. Deleting it outright would
    break Docker. Kept in place; trimmed only.
  - **`src/package.json`** — removed `crypto-js ^4.2.0` from
    `dependencies`. Other declared deps kept as-is (version drift vs.
    root is a separate cleanup, not M2 scope).
  - **`src/package-lock.json`** — stripped the three `crypto-js`
    entries by hand (`packages[''].dependencies['crypto-js']`,
    `packages['node_modules/crypto-js']`, top-level
    `dependencies['crypto-js']`). `crypto-js` has zero transitive deps
    in this lockfile, so leaf-removal leaves every other package byte-
    identical — avoids the unwanted churn an `npm install
    --package-lock-only` would trigger.
  - **`src/tests/legacy-vault-inventory.test.js`** — gained two new
    dependency-gate assertions: nested `src/package.json` must not
    declare `crypto-js`, and nested `src/package-lock.json` must have
    zero `crypto-js` references across all three lockfile shapes
    (v2 `packages[''].dependencies`, v2 `packages` tree, legacy v1
    `dependencies`). Both assertions noop if the nested manifest is
    later deleted, so a future "retire nested package.json entirely"
    cleanup won't fail this gate.
  - Full `npm test --silent` → **21 / 21 suites, 247 pass, 18 skip,
    exit 0** (was 21/21/245/18 at end of Step 2; +2 from the new gate
    assertions).
  - Commit: `1025d81`.
- **2026-04-21** — M2 Step 2: orphan subsystem deleted, `init-db`
  rewritten onto the live token API:
  - **Deleted** in one commit (ADR-0013 / T2.7 + T2.9): `src/utils/encryption.js`,
    `src/vault/vault.js`, `src/routes/api.js`, `src/routes/management.js`,
    `src/brain/brain.js`, `src/gateway/tokens.js`. All were unreachable from
    `src/index.js`. Also removed the stray dangling
    `const createManagementRoutes = require('./routes/management');` at
    `src/index.js:2562` (no mount point).
  - **Rewrote `src/scripts/init-db.js`** to provision a real master access
    token via `createAccessToken(...)` against the live `access_tokens`
    table in `src/database.js`. Idempotent by default
    (`getExistingMasterToken(ownerId)` short-circuits), `--force` creates an
    additional master for rotation, `INIT_DB_OWNER_ID` overrides the default
    `"owner"` ownerId. Programmatic API: `seedMasterToken({ force, label })`.
  - **New test `src/tests/init-db-seed.test.js`** (8 tests): fresh-DB happy
    path, schema shape assertions (`scope='full'`, `token_type='master'`,
    `revoked_at IS NULL`), idempotency / no-op path, `--force` path,
    bcrypt round-trip of the raw token against the stored hash, custom
    `INIT_DB_OWNER_ID`. Ran **red** first against the broken script
    (`MODULE_NOT_FOUND: crypto-js`), green after the rewrite.
  - **Tightened `src/tests/legacy-vault-inventory.test.js`**: flipped the
    two existence-snapshot assertions from `toBe(true)` to `toBe(false)`;
    `SANCTIONED_LEGACY_CALLERS` is gone; added a textual gate that scans
    every `src/**/*.{js,cjs,mjs}` file (excluding `public/` + `node_modules/`)
    for literal `require('crypto-js')` / `require('…/utils/encryption')` /
    `require('…/vault/vault')` and asserts zero hits. This gate works
    even against specifiers whose target no longer exists on disk.
  - Full `npm test --silent` → **21 / 21 suites, 245 pass, 18 skip, exit 0**
    (was 20 / 20 / 237). New gate is +1 suite, +8 tests.
  - Remaining follow-ups still in M2: T2.10 (remove nested `crypto-js`
    dep in `src/package.json`), T2.1 (HKDF `deriveSubkey`), T2.4
    (`default-vault-key-change-me` fallback), T2.5 (secret validation in
    every `NODE_ENV`), T2.8 (docs pass).
- **2026-04-21** — M2 Step 1: legacy vault inventory + re-scoping:
  - Added `src/tests/legacy-vault-inventory.test.js` (10 assertions): BFS
    over static `require()` edges from `src/index.js`, asserts no reachable
    module loads `crypto-js` / the weak `Encryption` module / the `Vault`
    class, asserts root `package.json` has no `crypto-js`, and asserts
    `crypto-js` is not resolvable from the repo root. Also confirms the
    only callers of the legacy modules are the modules themselves and the
    (unmounted) `src/scripts/init-db.js`.
  - Full `npm test --silent` → **20 / 20 suites, 237 pass, 18 skip, exit 0**.
  - New **ADR-0013** records the finding: the legacy vault path is orphan
    and the planned one-shot migration (ADR-0005, Option C) is moot. M2
    pivots to pure deletion. ADR-0005 status updated to
    "Accepted; migration workflow superseded by ADR-0013".
- **2026-04-21** — Pre-M2 baseline lock:
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

- **Now:** M2 — consolidate crypto, **re-scoped to pure deletion** per
  **ADR-0013**. Steps 1 (inventory + regression test), 2 (deletions +
  `init-db` rewrite), 3 (nested manifest scrub), and 4 (HKDF
  `deriveSubkey` primitive) are done. Remaining M2 work:
  - **T2.4** — delete the `default-vault-key-change-me` fallback in
    `src/database.js`; add regression tests.
  - **T2.5** — run `validateRequiredSecrets()` in every `NODE_ENV` (not just
    production) with an expanded banned-defaults list; add regression tests.
  - **T2.8** — update `CLAUDE.md`, `SECURITY.md`, `README.md` to state
    "AES-256-GCM everywhere" truthfully and note the legacy deletion.
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
