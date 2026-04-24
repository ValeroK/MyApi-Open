# MyApi — Execution Tracker

> Companion to [`plan.md`](plan.md). `plan.md` explains **why**; this document owns
> **what, in what order, and at what status**. Update task checkboxes and the
> per-milestone progress counters as work lands.
>
> - Last updated: **2026-04-24**
> - Owner: repo maintainers
> - Source of truth for decisions: [`plan.md` §0.1](plan.md#01-decisions-log)
>   and `decisions/ADR-0001…ADR-0010`.

---

## How to use this document

1. Work milestones roughly in order. Parallel work across milestones is fine when
   a task's **Depends on** field is satisfied.
2. When starting a task, change `[ ]` to `[~]` and add your handle + date in the
   **Notes** column.
3. When finishing a task, change `[~]` to `[x]` and update **Progress** counters
   at the top of the milestone.
4. If blocked, change to `[!]` and note the reason under the task.
5. When all tasks in a milestone are `[x]`, mark the milestone header with
   `✅ Complete (YYYY-MM-DD)` and move on. When all exit criteria are satisfied
   but a few tasks are deferred, mark `🟡 Shipped with deferrals` and list them.
6. Never delete a task — mark `[cancelled]` with a reason so the history is
   intact.

### Status legend

| Marker | Meaning |
|--------|---------|
| `[ ]`  | Not started |
| `[~]`  | In progress |
| `[x]`  | Done |
| `[!]`  | Blocked (add reason) |
| `[cancelled]` | Intentionally dropped (add reason) |

### Effort tags

`XS` ≤ 2h · `S` 2–4h · `M` 4–8h · `L` 1–2d · `XL` 3–5d

### Per-task quality gate (ADR-0012)

Before marking any task `[x]`:

1. `npm test --silent` returns **exit 0** and **≥ 19 / 19 suites** passing.
   (Baseline as of 2026-04-21: 19 / 19, 227 pass / 18 skip.)
2. Task ships new / updated tests that cover the change. Security fixes also
   add a row to `src/tests/security-regression.test.js`.
3. `npm run lint:backend` and `npm run typecheck` **do not grow** on files
   the task touched. Baseline 2026-04-21: 243 lint problems, 739 tsc errors;
   both jobs are report-only in CI per ADR-0012 until the M14 ratchet lands.
4. `.context/current_state.md` and this file are updated in the same PR.

See `.cursor/rules/test-first.mdc` for the full workflow.

---

## Global progress

| Milestone | Goal | Tasks | Done | Status |
|-----------|------|-------|------|--------|
| M0 | Project foundation (`.context/`, CI baseline, ESLint, TS scaffold) | 9 | 9 | 🟢 Code landed — pending `npm install` + CI verification |
| M1 | Delete dangerous endpoints / hardcoded secrets | 7 | 7 | 🟢 Code landed — T1.6 closed (scan clean, findings were test tokens per owner); T1.7 ledger pending (rolled into M14) |
| M2 | Consolidate crypto (re-scoped to deletion per ADR-0013) | 8 | 8 | ✅ Done 2026-04-21 — T2.0, T2.1, T2.4, T2.5, T2.7, T2.8, T2.9, T2.10; T2.2/T2.3/T2.6 cancelled per ADR-0013 |
| M3 | OAuth state + PKCE + callback hardening | 10 | 10 | ✅ **Complete 2026-04-24** — T3.0–T3.9 landed + wrap-up commit (provider_subject threading, legacy-export retirement, docs rebaseline, live Google OAuth smoke, F1/F2/F3 non-M3 follow-ups filed). C3 + C6 closed end-to-end; H1 remains closed. Session log: `sessions/2026-04-24-m3-smoke.md`. |
| M4 | Session + rate-limit dual-driver store | 9 | 0 | Not started (T4.9 data-integrity carry-over from ADR-0015) |
| M5 | SSRF surface unification via SafeHTTPClient | 7 | 0 | Not started |
| M6 | Monolith extraction (split `src/index.js`) | 10 | 0 | Not started |
| M7 | TypeScript migration for domain + infra | 7 | 0 | Not started |
| M8 | Remove MongoDB, legacy modules, dead code | 6 | 0 | Not started |
| M9 | Frontend & output hygiene | 9 | 0 | Not started |
| M10 | Database integrity & audit log | 7 | 0 | Not started |
| M11 | Observability (Pino, metrics, traces) | 8 | 0 | Not started |
| M12 | Testing uplift | 10 | 0 | Not started |
| M13 | CI/CD & supply chain | 8 | 0 | Not started |
| M14 | Docs & runbooks | 7 | 0 | Not started |
| **Total** |  | **120** | **16** |  |

---

## M0 — Project foundation

**Goal.** Put the scaffolding in place that makes every later milestone safer:
shared context folder, backend lint, TypeScript scaffold, and tightened CI.

**Exit criteria.**
- `.context/` exists with working templates.
- Backend ESLint runs locally and in CI.
- `tsconfig.json` compiles the current JS as-is under `checkJs`.
- CI blocks on backend lint and frontend lint.

**Depends on.** Nothing.
**Estimated duration.** ~1 day.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T0.1 | `[x]` Create `.context/` scaffolding: `current_state.md`, `roadmap.md`, `decisions/`, `tasks/{backlog,in_progress,completed}/`, `sessions/`, `TEMPLATE.md` for tasks + decisions + sessions | S | — | Done 2026-04-21. `current_state.md` seeded from `plan.md` §2. Templates under `tasks/`, `decisions/`, `sessions/`. |
| T0.2 | `[x]` Copy the Decisions log from `plan.md` §0.1 into `.context/decisions/` as one ADR per OQ (ADR-0001 … ADR-0010) | S | T0.1 | Done 2026-04-21. ADR-0001 through ADR-0010 filed, each ~1 page with context / options / consequences / follow-ups. |
| T0.3 | `[x]` Add `.cursor/rules/context-folder.mdc` rule that reminds the agent to update `.context/` on task transitions | XS | T0.1 | Done 2026-04-21. Extension is `.mdc` (Cursor's native format) not `.md`. |
| T0.4 | `[x]` Add backend ESLint config (`eslint.config.js`) with `eslint:recommended` + `plugin:security` + `plugin:n` + Prettier | M | — | Done 2026-04-21. Flat config at repo root. Legacy monolith files (`src/index.js`, `src/database.js`, etc.) have relaxed rules; new `src/domain/**` and `src/infra/crypto,http,session/**` are stricter. Needs `npm ci` to install the new devDeps locally. |
| T0.5 | `[x]` Add `tsconfig.json` at repo root with `checkJs: true`, `strict: true`, `noUncheckedIndexedAccess: true`, `allowJs: true`, `noEmit: true` | S | T0.4 | Done 2026-04-21. `exactOptionalPropertyTypes` left off at the repo level — enabled per-file in new `src/domain/**` TS files (see ADR-0003, OQ-15). |
| T0.6 | `[x]` Wire `npm run typecheck` → `tsc --noEmit` and `npm run lint:backend` → `eslint 'src/**/*.{js,ts}'` + format scripts | XS | T0.4, T0.5 | Done 2026-04-21. Scripts: `lint`, `lint:backend`, `lint:backend:fix`, `lint:frontend`, `typecheck`, `format`, `format:check`. |
| T0.7 | `[x]` Extend `.github/workflows/ci.yml` with `lint-backend`, `lint-frontend`, `typecheck` jobs; make security audit blocking | S | T0.6 | Done 2026-04-21. New jobs run on Node 22. Security audit now runs without `\|\| true` (ADR-0008). Docker build waits on `test + lint-backend + typecheck`. |
| T0.8 | `[x]` Add `.editorconfig` + Prettier config to unify whitespace across editors | XS | — | Done 2026-04-21. `.editorconfig`, `.prettierrc.json`, `.prettierignore` all at repo root. |
| T0.9 | `[x]` Add `CODEOWNERS` and a PR template with a security checklist | XS | — | Done 2026-04-21. `.github/CODEOWNERS` flags security-critical paths; `.github/pull_request_template.md` carries the checklist from `plan.md` §4.2. |

---

## M1 — Delete dangerous endpoints / hardcoded secrets

**Goal.** Remove the three "incident-class" findings from §6.3 before any other
refactor touches the code around them.

**Exit criteria.**
- `/turso-import`, `/api/v1/turso/export-sql`, `/api/v1/turso/execute` are gone.
- All hardcoded OAuth client/secret fallbacks are removed.
- Google OAuth client credentials rotated at the provider, documented.
- Regression tests prove the deleted routes now return 404.

**Depends on.** M0 (we want lint + CI green before deleting code).
**Estimated duration.** ~1 day.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T1.1 | `[x]` Delete route handlers for `/turso-import`, `/api/v1/turso/export-sql`, `/api/v1/turso/execute` in `src/index.js` | XS | T0.7 | Done 2026-04-21. Former lines 3957–4042 replaced with a tombstone comment. |
| T1.2 | `[x]` Delete `src/public/turso-import.html` and any links to it | XS | T1.1 | Done 2026-04-21. File removed; no inbound links in docs or code (confirmed by ripgrep). |
| T1.3 | `[x]` Add Jest regression tests asserting non-success on all three paths (unauth + authed) | S | T1.1 | Done 2026-04-21. `src/tests/security-regression.test.js` — `[M1] Removed Turso endpoints` + `[M1] No hardcoded Google OAuth credential fallbacks` suites. Contains `describe.skip` scaffolding for M3/M5/M9 regressions referenced in `plan.md` §5.4. |
| T1.4 | `[x]` Remove `REMOVED_CLIENT_ID` / `REMOVED_SECRET` string fallbacks in the `oauthConfig` block (`src/index.js` ~line 414–419) | XS | — | Done 2026-04-21. Both runtime fallbacks replaced with empty strings; any boot that expects Google OAuth will now fail closed via `google.enabled = false`. |
| T1.5 | `[x]` Change `google.enabled` to be computed: `Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)` | XS | T1.4 | Done 2026-04-21. Asserted by a test in `security-regression.test.js`. |
| T1.6 | `[x]` Run `gitleaks detect --log-opts="--all"` locally; confirm no real secrets in history. If any leaked creds are found, **rotate them at the provider** and document in `.context/decisions/` | M | — | **Done 2026-04-21.** `gitleaks 8.30.1`, 23 commits / 6.4 MB history + 5.2 MB worktree. 12 history + 14 worktree findings, 11 placeholders suppressed via `.gitleaksignore`, 3 token-shaped strings (agent token in docs, `MASTER_TOKEN` + `GUEST_TOKEN` in `qa-tests/phase1-security.js`) removed from HEAD and added to ignore under historical commits. Owner confirmed all 3 were dev-only test tokens against local instances — no provider rotation required. Final rescan **clean (exit 0)** in both modes. Full record: `.context/decisions/ADR-0011-gitleaks-scan-2026-04-21.md`. |
| T1.6b | `[ ]` Add `gitleaks protect --staged` job to `.github/workflows/ci.yml` so new leaks fail PRs (also add a `gitleaks detect` cron workflow at weekly cadence). | S | T0.6 | Tracked for M14 / CI hardening. |
| T1.7 | `[~]` Remove Turso from `docs/` and `README.md`; add a short note in `docs/SECURITY_AUDIT_OPERATIONS.md` recording the removal | XS | T1.1 | Ripgrep confirms **no existing docs reference Turso**, so the "remove" half of this task is a no-op. The ledger note in `docs/SECURITY_AUDIT_OPERATIONS.md` is still TODO — rolling up with the broader docs pass in M14. |

---

## M2 — Consolidate crypto (re-scoped to deletion per ADR-0013)

**Goal.** A single crypto module (AES-256-GCM + HKDF); weak `crypto-js` path
and its orphan callers deleted; vault-key fallbacks and secret-validation
gate hardened.

**Re-scoping note (2026-04-21).** M2 was originally written assuming
`src/vault/vault.js` was live and populated `identity_vault` / `connectors`
rows would need a one-shot migration (ADR-0005, Option C). Inventory work
in T2.0 proved the legacy path is orphan in the running server, so the
migration + rewrite tasks (T2.2, T2.3, T2.6) are **cancelled** and replaced
by a straight deletion (T2.9) and a nested-package cleanup (T2.10). See
**ADR-0013**. The non-vault hygiene half of M2 (T2.4, T2.5) is unaffected.

**Exit criteria.**
- `src/utils/encryption.js` is deleted.
- `src/vault/vault.js` is deleted (not rewritten — it had no live callers).
- The three orphan legacy modules (`src/routes/api.js`,
  `src/routes/management.js`, `src/brain/brain.js`) and the manual
  `src/scripts/init-db.js` seed script are deleted.
- `crypto-js` does not appear in any `package.json` in the repo and is not
  resolvable from the repo root.
- `default-vault-key-change-me` fallback exists in zero places.
- Secret validation runs regardless of `NODE_ENV`.
- `src/tests/legacy-vault-inventory.test.js` stays green, with its snapshot
  assertions flipped to "legacy files do not exist".

**Depends on.** M0, M1.
**Estimated duration.** ~1 day (down from ~2 after re-scoping).

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T2.0 | `[x]` Write inventory + weak-crypto regression test (`src/tests/legacy-vault-inventory.test.js`): BFS from `src/index.js` must not reach `crypto-js`, weak `Encryption`, or the `Vault` class; root `package.json` must not list `crypto-js`; `crypto-js` must not resolve from repo root; only sanctioned callers may import the legacy modules today. | S | T0.7 | **Done 2026-04-21.** 10 new assertions, all passing; full suite **20/20, 237/237 non-skipped, exit 0**. Locks today's orphan state and becomes the permanent regression gate after deletion. |
| T2.1 | `[x]` Add `deriveSubkey(root, purpose)` using HKDF-SHA-256 to `src/lib/encryption.js` + unit tests | S | T0.7 | **Done 2026-04-21** (commit `fce3074`). Implemented via `crypto.hkdfSync('sha256', …)`; purpose label fed into HKDF's `info` param for domain separation. Exports frozen `SUBKEY_PURPOSES = ['oauth:v1', 'session:v1', 'audit:v1']`. New `src/tests/encryption-deriveSubkey.test.js`: 22 assertions covering RFC 5869 Test Case 1 KAT, determinism, three-way domain separation, root-hex ↔ Buffer equivalence, full validation matrix, and AES-256-GCM round-trip proving oauth-encrypted ciphertext cannot be decrypted by the session subkey. Ran red-first. Purely additive — no behavior change for existing consumers; wiring is M3+. |
| T2.2 | `[~]` ~~Write migration script `src/scripts/migrate-vault-to-gcm.js`~~ | — | — | **Cancelled per ADR-0013.** No live ciphertext exists in the legacy format in the running-server path. If a self-hoster reports populated legacy rows, reopen and resurrect the script from `git log`. |
| T2.3 | `[~]` ~~Add `npm run db:migrate:vault-to-gcm` + runbook stub~~ | — | — | **Cancelled per ADR-0013.** |
| T2.4 | `[x]` Remove `default-vault-key-change-me` fallbacks in `src/database.js` (all four sites) + regression test | S | — | **Done 2026-04-21** (commit `fda13b8`). Deleted the `ALLOW_LEGACY_DEFAULT_VAULT_KEY`-gated legacy-CBC fallback in `decryptVaultToken`, the `LEGACY_DEFAULT_VAULT_KEY` constant, the `legacy-default` entry in `getOAuthKeyCandidates()`, and the two `process.env.VAULT_KEY \|\| 'default-vault-key-change-me'` sites in `createKeyVersion` and `rotateEncryptionKey`. Both of those functions now throw clear errors when the current `VAULT_KEY` is unset. `rotateEncryptionKey` also validates its `newVaultKey` argument. New test `src/tests/default-vault-key-removed.test.js` (7 tests, test-first red-first / green-after) provides a textual gate across `src/**/*.js` (with a small allow-list for the banned-defaults blocklist home and the test directory) plus behavioural gates against the rewritten functions. |
| T2.5 | `[x]` `validateRequiredSecrets()` runs on every `NODE_ENV`; expanded banned-defaults list; regression test | S | T2.4 | **Done 2026-04-21** (commit `380b9af`). Extracted into the pure helper `src/lib/validate-secrets.js` and rewired from `src/index.js`. Exports `validateRequiredSecrets({ env?, nodeEnv? }) -> { ok, missing, banned }`, frozen `REQUIRED_SECRETS` array, and a behaviourally-immutable `BANNED_DEFAULTS` Set. The blocklist union is `{change-me, changeme, secret, password, default-vault-key-change-me}` ∪ every verbatim `src/.env.example` placeholder for the four required secrets (`your-session-secret-key-here`, `your-secret-key-here-change-in-production`, `32-character-encryption-key-here!!`, `your-vault-key-here-change-in-production`). Boot is now fail-closed in every NODE_ENV (no more production-only carve-out). New test `src/tests/validate-required-secrets.test.js` (14 tests, test-first red-first / green-after) locks surface, blocklist contents, every-NODE_ENV behaviour, whitespace handling, multi-violation reporting, and `process.env` plumbing. The T2.4 regression gate was updated to track the blocklist's move into the new helper. |
| T2.6 | `[~]` ~~Rewrite `src/vault/vault.js` as `src/domain/vault/index.js`~~ | — | — | **Cancelled per ADR-0013.** The `Vault` class had no live callers; we delete it outright in T2.9 instead of rewriting it. |
| T2.7 | `[x]` Delete `src/utils/encryption.js`; flip the existence-snapshot assertion in `legacy-vault-inventory.test.js` from `toBe(true)` to `toBe(false)` | XS | T2.0 | **Done 2026-04-21.** Done as part of the same commit as T2.9. |
| T2.8 | `[x]` Update `CLAUDE.md`, `SECURITY.md`, and `README.md` to state "AES-256-GCM everywhere" truthfully, and call out that the legacy vault path was deleted in M2 | XS | T2.7, T2.9 | **Done 2026-04-21.** `CLAUDE.md`: Request-Flow no longer references deleted `brain/brain.js` + `vault/vault.js`; Key Source Files table rewritten with `src/database.js`, `src/lib/encryption.js` (HKDF `deriveSubkey` called out), `src/lib/validate-secrets.js`; new "Removed in M2 (ADR-0013)" paragraph; Environment section now documents the boot gate and includes `SESSION_SECRET`. `SECURITY.md`: §"Security Practices" reorganised into Cryptography / Boot-time validation / Operational, with the four M2 guarantees (AES-256-GCM everywhere, HKDF domain separation, no legacy weak-crypto, no default-key fallback) each naming its regression test. `README.md`: storage-table encryption column already matched, request-flow diagram updated to "database layer (src/database.js)", new bordered boot-validation admonition under the required-secrets table, `ENCRYPTION_KEY`/`VAULT_KEY` descriptions bumped "AES-256" → "AES-256-GCM". |
| T2.9 | `[x]` Delete the orphan modules in one commit: `src/vault/vault.js`, `src/routes/api.js`, `src/routes/management.js`, `src/brain/brain.js`, and `src/gateway/tokens.js` (also confirmed orphan — only importer was `init-db.js`, and it wrote to a dead `tokens` table the running server never reads). Rewrite `src/scripts/init-db.js` to target the live `access_tokens` table via `src/database.js` / `createAccessToken`; idempotent by default, `--force` opts in to creating an additional master token. Remove the stray `const createManagementRoutes = require('./routes/management');` line from `src/index.js` (was line ~2562). `"db:init"` npm script kept — it now actually produces a usable master token for headless installs. Inventory test tightened: snapshot assertions flipped to `toBe(false)`, `SANCTIONED_LEGACY_CALLERS` removed, new textual gate asserts zero `require('crypto-js'\|…/utils/encryption\|…/vault/vault)` anywhere under `src/`. New test `src/tests/init-db-seed.test.js` (8 tests, test-first: ran red against broken script then green after rewrite). | M | T2.0 | **Done 2026-04-21.** Deviation from the T2.9 plan: `src/gateway/tokens.js` was added to the deletion list after it turned out to be orphan too; `init-db.js` was rewritten rather than deleted (per user direction) so headless installs still have a CLI master-token seed path. |
| T2.10 | `[x]` Remove `crypto-js` from `src/package.json` `dependencies` + matching entries from `src/package-lock.json`. Extend `src/tests/legacy-vault-inventory.test.js`: new gate assertions on the nested manifest and its lockfile. | S | T2.9 | **Done 2026-04-21** (commit `1025d81`). Decision: trimmed, not deleted — the `Dockerfile` does `cd src && npm ci --only=production` and runs from `/app/src`, making `src/package.json` production-critical. crypto-js is a leaf in the lockfile (no transitive deps), so both entries were stripped by hand to avoid an unintended `npm install --package-lock-only` churn across all 524 packages. Full retirement of the nested manifest is a separate, post-M2 cleanup. |

---

## M3 — OAuth state, PKCE, and callback hardening

**Goal.** The OAuth callback is un-bypassable and stateless across browsers:
DB-backed state, random PKCE verifier stored server-side, no Discord carve-out.

**Exit criteria.**
- Every OAuth authorize writes a row to `state_tokens`.
- Every callback validates + marks the row `used_at`; second hit rejected.
- PKCE verifier is `crypto.randomBytes(32)`, stored in the state row.
- Discord bot-install flow follows the same rules (no `isDiscordBotInstall` bypass).
- `oauth_status=confirm_login` requires a user gesture in the dashboard.

**Depends on.** M0, M2 (uses the new crypto module).
**Estimated duration.** ~2 days.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T3.0 | `[x]` **M3 execution playbook + inventory regression gate.** File `ADR-0014-m3-oauth-state-hardening-plan.md` (8-step commit plan with per-step acceptance criteria + test-first contract), add `src/tests/oauth-state-inventory.test.js` (12 assertions: 5 schema-gap checks locking the missing `user_id` / `mode` / `return_to` / `code_verifier` / `used_at` columns, 4 textual gates on `src/index.js` for `buildPkcePairFromState` + the deterministic HMAC literal + `oauthStateMeta` + `isDiscordBotInstall`, plus a "domain/oauth/state.js does not exist" existence gate). Every assertion carries a `TODO(M3 Step N)` comment naming the exact step that will flip it, matching the M2 Step 2 `legacy-vault-inventory` pattern. | XS | ADR-0006 | **Done 2026-04-21.** Full `npm test` → 27/27 suites, 363 pass, 18 skip, exit 0 (+1 suite, +12 assertions vs M2 end-state). |
| T3.1 | `[x]` Additive migration on `oauth_state_tokens`: add `user_id TEXT NULL`, `mode TEXT NOT NULL DEFAULT 'login'`, `return_to TEXT NULL`, `code_verifier TEXT NOT NULL DEFAULT ''`, `used_at TEXT NULL`; add `idx_oauth_state_tokens_expires` + `idx_oauth_state_tokens_used`. Keeps legacy column names (`state_token`, `service_name`) — domain module (T3.2) maps to ADR-0006 field names at its API boundary. New `src/tests/oauth-state-schema.test.js` (8 assertions: all 10 columns present, correct types/nullability, UNIQUE preserved, three indexes present, full row round-trip). The 5 schema-gap assertions in `oauth-state-inventory.test.js` flipped `toBe(false)` → `toBe(true)`. | S | T0.7, T3.0 | **Done 2026-04-21.** Red-first: schema test filed at 6 fail / 2 pass vs HEAD; green at 8/8 after migration. Full `npm test` → 28/28 suites, 371 pass, 18 skip, exit 0 (+1 suite, +8 assertions vs Step 1). |
| T3.2 | `[x]` Pure `src/domain/oauth/state.js` module exports `createStateToken` / `consumeStateToken` / `pruneExpiredStateTokens` + `computeCodeChallenge` helper + `StateTokenError` with frozen CODES enum. DB-only, 10-min TTL (configurable via `ttlSec`), single-use via guarded UPDATE (`WHERE used_at IS NULL`) — portable around this repo's hybrid sync/async `SQLiteAdapter.transaction()`. Symbolic errors `STATE_NOT_FOUND` / `STATE_EXPIRED` / `STATE_REUSED` / `STATE_SERVICE_MISMATCH` / `STATE_INVALID_MODE` / `STATE_INVALID_SERVICE`. Service mismatch does NOT consume the row. New `src/tests/oauth-state-domain.test.js` (22 assertions) covers the full surface. | M | T3.1 | **Done 2026-04-21.** Red-first: filed at 22/22 FAIL (MODULE_NOT_FOUND vs HEAD); green at 22/22 after implementation. |
| T3.3 | `[x]` PKCE verifier is now random `crypto.randomBytes(32)` base64url (43 chars, 256 bits) generated inside `createStateToken()` and stored alongside the state row. `computeCodeChallenge(verifier)` implements `base64url(sha256(verifier))`, validated against **RFC 7636 Appendix B known-answer test** (`verifier=dBjftJe...` → `challenge=E9Melho...`) so a silent drift off PKCE S256 is caught by CI. The broken `buildPkcePairFromState` in `src/index.js` stays on disk until Step 5 / T3.5 deletes it; Step 4 / T3.4 removes every call-site in the authorize handler. | S | T3.2 | **Closes H1 at the primitive level.** Handler-level closure ships in Steps 4 + 5. |
| T3.4 | `[x]` Rewrite `/api/v1/oauth/authorize/:service` to write + return a state row; delete the `req.session.oauthStateMeta` map | M | T3.2, T3.3 | **Done 2026-04-23** (paired with T3.5 + T3.6 in one atomic commit — see change-log). Authorize now calls `createStateToken(...)` from `src/domain/oauth/state.js`, writes the DB row, and uses `stateRow.codeChallenge` for the provider auth URL. All `req.session.oauthStateMeta[...]` writes are gone. New `src/tests/oauth-authorize-handler.test.js` (supertest integration suite) locks the behaviour. |
| T3.5 | `[x]` Rewrite `/api/v1/oauth/callback/:service` to look up + mark `used_at` on the state row; reject expired / used / missing rows | M | T3.4 | **Done 2026-04-23** (paired with T3.4 + T3.6). Callback calls `consumeStateToken(...)` and returns discriminated 400s for `STATE_MISSING` / `STATE_NOT_FOUND` / `STATE_EXPIRED` / `STATE_REUSED` / `STATE_SERVICE_MISMATCH`. PKCE verifier for the token exchange now comes from `stateRow.code_verifier` (the random 43-char base64url value from T3.3), not the deterministic HMAC. Legacy `buildPkcePairFromState` + `base64UrlNoPad` helpers **deleted**. New `src/tests/oauth-callback-handler.test.js` (8 supertest scenarios) exercises every error code + the happy path + a cookies-dropped scenario proving session independence. |
| T3.6 | `[x]` Remove the Discord `isDiscordBotInstall` state bypass; ensure Discord's bot-install flow reuses the standard state | S | T3.5 | **Done 2026-04-23** (paired with T3.4 + T3.5). The `isDiscordBotInstall` variable + its `!state && guild_id` carve-out are gone from `src/index.js`. Discord now shares the mandatory-state-token path with every other provider; the callback test asserts a Discord call with `guild_id` but without `state` returns 400 (was 302 pre-Step-5). Verified Discord's authorize flow does persist `state` through its OAuth redirect, so no adapter change was needed. |
| T3.7 | `[x]` Add a confirm screen in `src/public/dashboard-app/src/pages/LogIn.jsx` so `confirm_login` requires a user-triggered button press showing the OAuth subject email | M | T3.5 | **Done 2026-04-24.** Schema: `oauth_pending_logins` +`used_at`/+`outcome`; `oauth_tokens` +`provider_subject`/+`first_confirmed_at`. New domain module `src/domain/oauth/pending-confirm.js` (SSOT). Three new endpoints: `GET /confirm/preview`, rewritten `POST /confirm`, new `POST /confirm/reject`. Callback first-seen gate keyed on `{service, user, provider_subject}` (ADR-0016). Frontend `App.jsx` auto-POST deleted; `LogIn.jsx` owns the gesture; duplicate `Login.jsx` removed. Full Docker regression **34 / 470 / 18 / 0**. |
| T3.8 | `[x]` Add integration tests: (a) replay of the same `state` → 400, (b) missing `state` + `guild_id` → 400, (c) expired `state` → 400, (d) valid flow end-to-end → 302 | M | T3.5 | **Done 2026-04-24.** Unskipped `[M3 / T3.8] OAuth state + PKCE + confirm regression matrix` in `src/tests/security-regression.test.js` (5 tests, all green). Covers §5.4 bullets 2 (replayed state → 400 `STATE_REUSED`), 5 (missing state + guild_id → 400, Discord bypass removed), 4 (expired state → 400 `STATE_EXPIRED` with `row.used_at` kept NULL), 7 (valid flow → 302 redirect to confirm-gesture screen with fresh `pending_confirm` token), and **6** (stale / replayed confirm-login token → 400 `pending_confirm_reused` + no session established for the replayer). Status-code deviation from plan wording (§5.4 says "→ 401" for the confirm-login replay; implementation returns the discriminated-400 taxonomy like the rest of the state-row family) documented inline. Full Docker regression: **34 suites / 475 pass / 14 skipped** (+5 tests vs T3.7 baseline). |
| T3.9 | `[x]` Background job to prune expired `state_tokens` rows; log count pruned | S | T3.2 | **Done 2026-04-24.** New module `src/domain/oauth/prune-scheduler.js` (thin composition over the two pure primitives shipped in T3.2 + T3.7). Exports `runPruneOnce({ db, now?, graceSec?, logger? })` → `{ prunedState, prunedPending, elapsedMs }`, `startPruneScheduler({ db, intervalMs?, graceSec?, logger?, timers? })` → `stop()`, and frozen `DEFAULTS = { intervalMs: 600_000, graceSec: 3600 }`. Injected `timers` seam lets the suite test interval wiring without real time. `handle.unref()` called when present so an idle scheduler never blocks `process.exit()`. A tick with non-zero prunes emits one structured `logger.info('pruned expired OAuth rows', { pruned_state, pruned_pending, elapsed_ms })`; silent at INFO on empty ticks. Both underlying prunes are try/catch-guarded independently — a failure in one does NOT skip the other, and both swallow-and-log rather than throw. `src/index.js` bootstrap now calls `startOAuthPruneScheduler({ db, intervalMs, graceSec })` with env-overridable `OAUTH_PRUNE_INTERVAL_MS` (≥ 1000) and `OAUTH_PRUNE_GRACE_SEC` (≥ 0). The legacy `cleanupExpiredStateTokens()` invocation from the old BUG-11 hourly tick is **removed** (primitive left on disk in `src/database.js` for now; retirement tracked for M3 wrap-up). New red-first suite `src/tests/oauth-prune-scheduler.test.js` (10 assertions: module surface, DEFAULTS shape, empty-DB silence, state-prune happy path + structured log, pending-confirm prune, graceSec override, fault isolation, interval wiring via injected timers, DEFAULTS fallback, `.unref()` behaviour). Red-first: filed at 10/10 FAIL (MODULE_NOT_FOUND); green at 10/10 after implementation. Full Docker regression **35 suites / 485 pass / 14 skip / 0 fail** (+1 suite, +10 tests vs T3.8 baseline). |

---

## M4 — Session + rate-limit dual-driver store

**Goal.** One `SessionStore` + one `RateLimitStore` interface, two drivers
(SQLite default, Redis via `REDIS_URL`), both tested in CI.

**Exit criteria.**
- `SessionStore` and `RateLimitStore` interfaces documented in
  `src/infra/session/README.md`.
- SQLite driver used by default; Redis driver enabled when `REDIS_URL` is set.
- Both drivers exercised in CI integration tests.
- `global.sessions` and the bespoke rate-limit `Map`s are gone.

**Depends on.** M0, M2 (HKDF subkey for session cookie signing).
**Estimated duration.** ~2 days.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T4.1 | `[ ]` Define `SessionStore` interface + tests in `src/infra/session/store.js`/`.ts` | S | T0.7 |  |
| T4.2 | `[ ]` Implement `SqliteSessionStore` using `better-sqlite3-session-store` | M | T4.1 |  |
| T4.3 | `[ ]` Implement `RedisSessionStore` using `connect-redis` + `ioredis` (add deps); TLS required if URL is `rediss://` | M | T4.1 | See OQ-11. |
| T4.4 | `[ ]` Wire `express-session` to pick a driver based on presence of `REDIS_URL` | S | T4.2, T4.3 |  |
| T4.5 | `[ ]` Define `RateLimitStore` interface with token-bucket / sliding-window semantics; add SQLite + Redis drivers | M | T4.1 |  |
| T4.6 | `[ ]` Replace `express-rate-limit` configuration to use the new store; delete bespoke in-memory `Map`s + `rateLimitCleanupInterval` | M | T4.5 |  |
| T4.7 | `[ ]` Add testcontainers-based integration test that runs a subset of auth + rate-limit tests against a real Redis | M | T4.3, T4.6 |  |
| T4.8 | `[ ]` Tighten `app.set('trust proxy', ...)` to a CIDR list via env (`TRUSTED_PROXIES`); default to loopback only | S | T4.6 | Closes H5. |
| T4.9 | `[ ]` **Option B from ADR-0015** — elevate `access_tokens.owner_id` to `FOREIGN KEY REFERENCES users(id) ON DELETE CASCADE` via an additive `access_tokens_v2` migration; back-populate missing `users` rows via `ensureOwnerUserRow` before the swap; audit every `createAccessToken` call site (~15) to confirm the `ownerId` is a real `users.id`; remove the now-redundant `ensureOwnerUserRow` call from `bootstrap()` + master-regen handler (keep the helper for the init-db CLI); add a migration test and a textual lint that forbids new `createAccessToken` callers that predate `ensureOwnerUserRow` / a users insert. | M | T0.7, ADR-0015 A | Closes the FK inconsistency representationally so the Option A guards become unnecessary. |

---

## M5 — SSRF surface unification

**Goal.** Zero outbound HTTP in the codebase uses raw `fetch` / `https.request`;
everything goes through `SafeHTTPClient`.

**Exit criteria.**
- `src/index.js:isPrivateHost` is deleted.
- ESLint rule forbids `fetch(` / `https.request(` outside `src/infra/http/`.
- The proxy route, `/api/v1/ask`, webhook senders, and discovery all use
  `SafeHTTPClient`.
- DNS-rebinding defeat: client dials the resolved IP, not the hostname.

**Depends on.** M0.
**Estimated duration.** ~1.5 days.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T5.1 | `[ ]` Move `src/lib/ssrf-prevention.js` → `src/infra/http/safe-client.js`; add DNS-pinned dial (resolve once, connect by IP) | M | T0.7 |  |
| T5.2 | `[ ]` Add unit tests for adversarial URL forms: `0177.0.0.1`, `::ffff:127.0.0.1`, `2130706433`, `metadata.google.internal`, DNS-rebind fixture | M | T5.1 |  |
| T5.3 | `[ ]` Rewrite `/api/v1/services/:serviceName/proxy` to use `SafeHTTPClient` and delete `isPrivateHost` from `src/index.js` | M | T5.1 |  |
| T5.4 | `[ ]` Rewrite `/api/v1/ask`'s internal fetch to call handlers in-process (no loopback HTTP); closes H3 | M | T5.3 |  |
| T5.5 | `[ ]` Audit every `fetch(`, `axios.*`, `https.request(` usage in `src/` and migrate to `SafeHTTPClient` | L | T5.1 | Grep-driven; expect ~15–30 sites. |
| T5.6 | `[ ]` Add ESLint rule: forbid raw outbound HTTP outside `src/infra/http/` | S | T5.5 |  |
| T5.7 | `[ ]` Add security regression tests for the SSRF surface (see §5.4 of `plan.md`) | M | T5.3 |  |

---

## M6 — Monolith extraction

**Goal.** `src/index.js` becomes a thin bootstrap (~500 LOC). Routes, middleware,
OAuth, discovery each live in their own module.

**Exit criteria.**
- `src/index.js` ≤ 600 lines.
- `createApp(config)` factory in `src/app/createApp.js` is the single app builder.
- Each route file handles ≤ 1 concern (auth, oauth, tokens, services, proxy,
  llm-gateway, discovery, admin, billing, audit, health).
- No tests deleted; all green.

**Depends on.** M0, M1, M3, M4.
**Estimated duration.** ~1 week.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T6.1 | `[ ]` Create `src/app/createApp.js` and move global middleware wiring into it; `src/index.js` calls `createApp(config).listen(PORT)` | M | T4.4 |  |
| T6.2 | `[ ]` Extract health + discovery routes (`/api/v1/health`, `/openapi.json`, `/.well-known/*`) into `src/app/routes/discovery.js` | M | T6.1 |  |
| T6.3 | `[ ]` Extract OAuth authorize + callback into `src/app/routes/oauth.js` (uses `src/domain/oauth/`) | L | T3.5, T6.1 |  |
| T6.4 | `[ ]` Extract auth + sessions + tokens endpoints into `src/app/routes/auth.js` and `src/app/routes/tokens.js` | L | T6.1 |  |
| T6.5 | `[ ]` Extract service proxy into `src/app/routes/proxy.js` (uses `SafeHTTPClient`) | M | T5.3, T6.1 |  |
| T6.6 | `[ ]` Extract LLM `/ask` endpoint into `src/app/routes/llm-gateway.js` | M | T5.4, T6.1 |  |
| T6.7 | `[ ]` Extract admin endpoints (user management, billing admin, audit read) into `src/app/routes/admin.js` | M | T6.1 |  |
| T6.8 | `[ ]` Migrate OAuth adapters from `src/services/*-adapter.js` to `src/domain/oauth/adapters/*` | L | T6.3 |  |
| T6.9 | `[ ]` Move remaining helpers in `src/lib/` into `src/infra/*` per §3.2 of `plan.md` (crypto, http, session, rate-limit, db, sentry, logger, email, stripe) | L | T6.1 |  |
| T6.10 | `[ ]` Replace regex-based HTML nonce injection (line 1330 today) with a `cheerio`-based transformer | S | T6.1 |  |

---

## M7 — TypeScript migration (domain + infra)

**Goal.** Security-critical modules become `.ts` with `strict: true`.

**Exit criteria.**
- `src/domain/**`, `src/infra/crypto/**`, `src/infra/http/**`,
  `src/infra/session/**` are `.ts`.
- `npm run typecheck` passes with zero errors.
- Build pipeline emits `.js` for runtime (or uses `tsx` / `ts-node` if preferred).

**Depends on.** M0, M2, M4, M5, M6 (convert after the files stop moving).
**Estimated duration.** ~1 week (incremental, can overlap).

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T7.1 | `[ ]` Decide build pipeline: `tsc --outDir dist/` vs `tsx` at runtime. Record as ADR | S | T0.5 | Default: `tsc` build step, node runs `dist/`. |
| T7.2 | `[ ]` Convert `src/infra/crypto/**` to `.ts` with strict types for inputs/outputs | M | T2.1, T7.1 |  |
| T7.3 | `[ ]` Convert `src/infra/http/**` (SafeHTTPClient) to `.ts` | M | T5.1, T7.1 |  |
| T7.4 | `[ ]` Convert `src/infra/session/**` and `src/infra/rate-limit/**` to `.ts` | M | T4.1, T7.1 |  |
| T7.5 | `[ ]` Convert `src/domain/oauth/**` to `.ts` (state, PKCE, adapters) | L | T3.2, T7.1 |  |
| T7.6 | `[ ]` Convert `src/domain/vault/**`, `src/domain/tokens/**`, `src/domain/audit/**` to `.ts` | L | T2.6, T7.1 |  |
| T7.7 | `[ ]` Add coverage thresholds per path per §5.1.1 of `plan.md` in `jest.config.js` (80% domain/infra; 70% app; 50% legacy) | S | T7.6 |  |

---

## M8 — Remove MongoDB, legacy modules, dead code

**Goal.** Delete everything the refactor made obsolete.

**Exit criteria.**
- `mongodb` is not a dependency.
- `src/database-mongodb.js`, `src/config/database.js`, `src/gateway/tokens.js`,
  `src/gateway/audit.js`, `src/scripts/init-db.js` are deleted or rewritten.
- No files under `src/` reference `crypto-js`.

**Depends on.** M2 (vault off crypto-js), M6 (routes moved), M7 (TS conversion done).
**Estimated duration.** ~2 days.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T8.1 | `[ ]` Delete `src/database-mongodb.js` and remove its branch from DB init in `src/index.js` / `createApp.js` | S | T6.1 |  |
| T8.2 | `[ ]` Remove `mongodb` from `package.json`; run `npm install` to prune the lockfile | XS | T8.1 |  |
| T8.3 | `[ ]` Delete `src/config/database.js`, `src/gateway/tokens.js`, `src/gateway/audit.js` and confirm no imports remain (`rg`) | S | T6.9 |  |
| T8.4 | `[ ]` Rewrite `src/scripts/init-db.js` on top of `src/database.js` (or delete if migrations suffice) | M | T8.3 |  |
| T8.5 | `[ ]` Remove `deasync` dep if unused after refactor | XS | T6.9 | Grep first. |
| T8.6 | `[ ]` Delete `verify_security_fixes.sh` once all its checks are Jest tests (see M12) | XS | T12.3 |  |

---

## M9 — Frontend & output hygiene

**Goal.** Tighten CSP, stop leaking error internals, make admin mutations CSRF-safe,
and right-size the bundle.

**Exit criteria.**
- CSP drops `'unsafe-inline'` from styles.
- Error responses carry `{ error: { code, message, correlationId } }`; no
  `err.message` leakage.
- CSRF tokens required for session-authed state-changing admin endpoints.
- Dashboard initial JS ≤ 300 KB gzipped.

**Depends on.** M6 (error handling lives in `src/app/errors/`).
**Estimated duration.** ~3 days.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T9.1 | `[ ]` Move all inline `style=` + `<style>` usage in React to CSS/Tailwind classes | M | — |  |
| T9.2 | `[ ]` Tighten Helmet CSP: drop `'unsafe-inline'` from `styleSrc`, keep nonce for `scriptSrc` | S | T9.1 |  |
| T9.3 | `[ ]` Central error envelope + handler in `src/app/errors/handler.ts`; replace ad-hoc `res.status(500).json({ error, details: err.message })` calls | L | T6.1 |  |
| T9.4 | `[ ]` Sentry `beforeSend` hook redacting `authorization`, `cookie`, `code`, `state`, `refresh_token`, `client_secret`, `password` | S | T9.3 |  |
| T9.5 | `[ ]` Add CSRF middleware (double-submit cookie or same-site token) for session-authed POST/PUT/DELETE under `/api/v1/admin/**` and `/api/v1/settings/**` | M | T6.1 |  |
| T9.6 | `[ ]` Add route-level code splitting and lazy loading for heavy pages (`Settings.jsx`, `AccessTokens.jsx`, `Marketplace.jsx`) | M | — |  |
| T9.7 | `[ ]` Asset size budget in CI: fail if initial JS > 300 KB gzipped or total > 1 MB gzipped | S | T9.6 |  |
| T9.8 | `[ ]` Add `eslint-plugin-jsx-a11y` for dashboard; fix onboarding + OAuthAuthorize + Login pages to pass | M | — |  |
| T9.9 | `[ ]` Tighten `.gitignore` to `/.env*` with an explicit allow-list for committed example files | XS | — |  |

---

## M10 — Database integrity & audit log

**Goal.** The audit log is append-only at the DB layer; dynamic SQL is allow-listed;
monthly Merkle root of the audit log is published.

**Exit criteria.**
- Triggers on `audit_log` reject `UPDATE` and `DELETE`.
- A helper `validateSqlIdentifier(name)` is used everywhere we interpolate
  column/table names.
- `/.well-known/audit-root.json` returns the last published Merkle root.

**Depends on.** M6, M8.
**Estimated duration.** ~3 days.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T10.1 | `[ ]` SQL migration adding BEFORE UPDATE / BEFORE DELETE triggers on `audit_log` that `RAISE(ABORT, ...)` | S | T6.1 |  |
| T10.2 | `[ ]` `validateSqlIdentifier()` helper in `src/infra/db/identifiers.ts` with allow-list regex + unit tests | S | T6.9 |  |
| T10.3 | `[ ]` Replace every `${tableName}` / `${columnName}` template site with the helper (see `plan.md` §6.3 Medium) | M | T10.2 |  |
| T10.4 | `[ ]` ESLint rule / custom check that flags template-literal SQL outside `src/infra/db/` | S | T10.2 |  |
| T10.5 | `[ ]` Add `strict JSON schema validation` for `config/oauth.json` at boot; fail loudly on invalid config | S | T6.1 |  |
| T10.6 | `[ ]` Nightly job computing Merkle root of new `audit_log` rows; expose via `/.well-known/audit-root.json` | M | T10.1 |  |
| T10.7 | `[ ]` Per-route byte budget for `express.json()` (replace global 100 KB with per-route limits) | S | T6.1 |  |

---

## M11 — Observability

**Goal.** Structured logs, metrics, traces with a consistent correlation ID.

**Exit criteria.**
- All `console.log` calls in `src/` replaced by `logger.info|warn|error`.
- `/metrics` endpoint emits Prometheus format.
- OTel traces export to an OTLP endpoint when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

**Depends on.** M6.
**Estimated duration.** ~3 days.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T11.1 | `[ ]` Add `pino` + `pino-http`; wrap in `src/infra/logger/index.ts` with a redactor for the sensitive-field allow-list | M | T6.1 |  |
| T11.2 | `[ ]` Replace `console.log/warn/error` in `src/` with the logger (grep-driven) | L | T11.1 |  |
| T11.3 | `[ ]` Ensure every log line and every `audit_log` row carries the request correlation ID | S | T11.1 |  |
| T11.4 | `[ ]` Add `/metrics` endpoint using `prom-client` with request count/latency, auth attempts, OAuth callbacks, rate-limit hits, audit writes | M | T11.1 |  |
| T11.5 | `[ ]` Add OpenTelemetry instrumentation (express + outbound HTTP + DB) behind `OTEL_EXPORTER_OTLP_ENDPOINT` | M | T11.1 |  |
| T11.6 | `[ ]` Define alert rules (5xx spike, auth failure spike, CSP report spike, audit write failure, backup failure, cert expiring ≤ 14d) in `docs/runbooks/alerts.md` | S | T11.4 |  |
| T11.7 | `[ ]` One-page Grafana dashboard JSON committed to `docs/ops/grafana/` | M | T11.4 |  |
| T11.8 | `[ ]` Verify secrets never appear in logs / traces: add a test that POSTs known secrets and greps the logger output | S | T11.1 |  |

---

## M12 — Testing uplift

**Goal.** Raise coverage where it matters, add frontend + E2E + contract + security
regression layers.

**Exit criteria.**
- Coverage: 80% on `src/domain/**`, `src/infra/crypto,http,session/**`.
- Frontend Vitest + RTL suite covers Login, OAuthAuthorize, Settings 2FA, TokenVault.
- Playwright E2E runs nightly for onboarding, OAuth confirm, token create/revoke.
- Contract tests exist for Google, GitHub, Slack, Discord adapters.
- Security regression suite covers all items in `plan.md` §5.4.

**Depends on.** M1–M6.
**Estimated duration.** ~1 week (rolling).

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T12.1 | `[ ]` Add `security-regression.test.js` covering §5.4 items (Turso 404, OAuth state reuse, SSRF forms, scope admin:*, oversize body, SQL injection via identifier) | L | T1.3, T3.8, T5.7 |  |
| T12.2 | `[ ]` Add Vitest + React Testing Library to `src/public/dashboard-app/`; write tests for `authStore`, `tokenStore`, `Login.jsx`, `OAuthAuthorize.jsx`, `Settings.jsx` (2FA), `TokenVault.jsx` | L | — |  |
| T12.3 | `[ ]` Port every check in `verify_security_fixes.sh` to Jest; delete the shell script | M | T12.1 |  |
| T12.4 | `[ ]` Playwright config + first scenarios (onboarding flow, OAuth confirm gesture, token create/revoke, device approval) | L | T9.5 |  |
| T12.5 | `[ ]` Contract tests per OAuth adapter using `nock` with provider-specific fixtures (Google, GitHub, Slack, Discord first) | L | T6.8 |  |
| T12.6 | `[ ]` Property-based tests (`fast-check`) for: URL validator, scope evaluator, SQL identifier validator | M | T5.2, T10.2 |  |
| T12.7 | `[ ]` Mutation tests (Stryker) on `src/infra/crypto/**` and `src/domain/tokens/**` | M | T7.2, T7.6 | Nightly only. |
| T12.8 | `[ ]` Deterministic clock + crypto seeds helper in `src/tests/test-harness.ts` for OAuth/audit/PKCE tests | S | T3.2 |  |
| T12.9 | `[ ]` Golden-file OpenAPI diff: generated spec compared to `docs/openapi.generated.json` snapshot | S | T6.2 |  |
| T12.10 | `[ ]` Test data factories with `@faker-js/faker` to replace hand-rolled fixtures in `src/tests/` | M | — |  |

---

## M13 — CI/CD & supply chain

**Goal.** The pipeline rejects broken, vulnerable, or unscanned code.

**Exit criteria.**
- `npm audit --audit-level=high` blocks (no `|| true`).
- `gitleaks` + Trivy image scan + SBOM all run and fail on findings at HIGH+.
- Dependabot + Renovate configured.

**Depends on.** M0.
**Estimated duration.** ~1.5 days.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T13.1 | `[ ]` Remove `|| true` from the `security` job in `.github/workflows/ci.yml`; block on HIGH+ | XS | T0.7 |  |
| T13.2 | `[ ]` Add `gitleaks` action in CI + a pre-commit hook via the `create-hook` skill | S | — |  |
| T13.3 | `[ ]` Generate SBOM with `cyclonedx-npm` and upload as a CI artifact | S | T13.1 |  |
| T13.4 | `[ ]` Add Trivy scan of the built Docker image; fail on HIGH/CRITICAL | S | T13.3 |  |
| T13.5 | `[ ]` Add Dependabot config (`.github/dependabot.yml`) for npm + GitHub Actions | XS | — |  |
| T13.6 | `[ ]` Add Renovate config as a secondary (Renovate handles groupings better) | XS | T13.5 |  |
| T13.7 | `[ ]` Enable signed Docker images via cosign (key management documented in `docs/runbooks/key-rotation.md`) | M | T13.4 | Can defer until managed cloud launch. |
| T13.8 | `[ ]` Generate SLSA provenance during Docker build | S | T13.7 |  |

---

## M14 — Documentation & runbooks

**Goal.** Every operational procedure has a runbook; every long-form doc matches
the code.

**Exit criteria.**
- `CLAUDE.md`, `README.md`, `SECURITY.md` are factually correct.
- `docs/runbooks/` covers incident response, key rotation, DB restore, Stripe
  webhook replay, OAuth provider outage, mass device revocation, backup
  verification.

**Depends on.** M2, M6, M10, M11.
**Estimated duration.** ~2 days.

| # | Task | Effort | Depends on | Notes |
|---|------|--------|------------|-------|
| T14.1 | `[ ]` Update `CLAUDE.md`: real `src/index.js` size, actual vault crypto, new src/ layout | XS | T6.9 |  |
| T14.2 | `[ ]` Rewrite `docs/` index (`docs/README.md`) with categories: architecture, operations, security, compliance, legal | S | — |  |
| T14.3 | `[ ]` Write `docs/runbooks/incident-response.md` (triage, containment, rotation, comms) | M | — |  |
| T14.4 | `[ ]` Write `docs/runbooks/key-rotation.md` (`ENCRYPTION_KEY`, `VAULT_KEY`, `SESSION_SECRET`, `JWT_SECRET`, OAuth client secrets) | M | T2.1 |  |
| T14.5 | `[ ]` Write `docs/runbooks/db-restore.md` (SQLite + PG restore from backup, integrity verification) | M | T10.1 |  |
| T14.6 | `[ ]` Write `docs/runbooks/oauth-provider-outage.md` and `docs/runbooks/device-revocation.md` | M | T3.5 |  |
| T14.7 | `[ ]` Consolidate overlapping security docs: `SECURITY_AUDIT_IMPLEMENTATION.md`, `SECURITY_AUDIT_OPERATIONS.md`, `SECURITY_AUDIT_PHASE3.md`, `PENTEST_BRIEFING.md` → single `docs/security/` area with an index | M | — |  |

---

## Change log

| Date | Who | Change |
|------|-----|--------|
| 2026-04-21 | initial | Created doc with 15 milestones, 120 tasks. |
| 2026-04-21 | implementation | Moved `plan.md` + `TASKS.md` into `.context/`. M0 foundations landed (T0.1–T0.9). M1 critical deletions landed (T1.1–T1.5, T1.7 partial). T1.6 (gitleaks + provider rotation) flagged blocked on a human. |
| 2026-04-21 | implementation | T1.6 gitleaks baseline scan executed with `gitleaks 8.30.1`: 12 history + 14 worktree findings triaged. Placeholders suppressed in `.gitleaksignore`; 3 real-looking `myapi_…` tokens removed from HEAD (docs/AGENT_README.md + qa-tests/phase1-security.js). Rescan clean. Findings + revocation SQL recorded in ADR-0011. New subtasks T1.6a (operator DB revocation) and T1.6b (CI gitleaks-protect) split out. |
| 2026-04-21 | implementation | T1.6 closed. Owner confirmed the 3 Bucket-C tokens were dev-only test tokens (local `localhost:4500` instances); no provider rotation required. ADR-0011 updated; T1.6a dropped. M1 now complete (7/7). Moving focus to M2 (crypto consolidation). |
| 2026-04-21 | implementation | Pre-M2 quality baseline locked (ADR-0012). `npm install` run; Windows `EBUSY` teardown flake fixed in `oauth-security-hardening.test.js`. Tests: 19/19 suites, 227 pass, exit 0. Lint: 243 problems. Typecheck: 739 `error TS*`. CI `lint-backend` and `typecheck` flipped to `continue-on-error`; Docker gate depends only on `test` + `security`. New rule `.cursor/rules/test-first.mdc` codifies test-first discipline. |
| 2026-04-21 | implementation | M2 Step 1 landed: `src/tests/legacy-vault-inventory.test.js` added with BFS-based reachability + resolvability gates; ADR-0013 filed documenting that the legacy vault subsystem is orphan. Commit `255f4f2`. Tests 20/20, 237 pass. |
| 2026-04-21 | implementation | M2 Step 2 landed: deleted `src/utils/encryption.js`, `src/vault/vault.js`, `src/routes/api.js`, `src/routes/management.js`, `src/brain/brain.js`, `src/gateway/tokens.js`; removed stray `createManagementRoutes` require from `src/index.js`; rewrote `src/scripts/init-db.js` onto `createAccessToken` in `src/database.js` (idempotent + `--force`). New test `src/tests/init-db-seed.test.js` (8 tests). Inventory test tightened (snapshot assertions flipped to `false`, textual `require` sweep added). Commit `4f2cd67`. Tests 21/21, 245 pass. Net -991 LOC. |
| 2026-04-21 | implementation | M2 Step 3 (T2.10) landed: removed `crypto-js` from nested `src/package.json` + matching entries from `src/package-lock.json` (leaf removal, no lockfile churn). Inventory test extended with nested-manifest + lockfile gates. Kept the nested manifest alive because the Dockerfile does `cd src && npm ci --only=production`. Commit `1025d81`. Tests 21/21, 247 pass. |
| 2026-04-21 | implementation | M2 Step 4 (T2.1) landed: `deriveSubkey(root, purpose)` HKDF-SHA-256 primitive added to `src/lib/encryption.js` via `crypto.hkdfSync`; frozen whitelist `SUBKEY_PURPOSES = ['oauth:v1', 'session:v1', 'audit:v1']`. New `src/tests/encryption-deriveSubkey.test.js` (22 tests, red-first) incl. RFC 5869 Test Case 1 KAT, domain separation, full input validation, and AES-256-GCM round-trip. Commit `fce3074`. Tests 22/22, 269 pass. |
| 2026-04-21 | implementation | M2 Step 5 (T2.4) landed: all four `default-vault-key-change-me` fallback sites in `src/database.js` removed — `decryptVaultToken` legacy-CBC path (dropped `ALLOW_LEGACY_DEFAULT_VAULT_KEY`), `LEGACY_DEFAULT_VAULT_KEY` constant deleted, `getOAuthKeyCandidates()` `legacy-default` entry removed, and both `createKeyVersion`/`rotateEncryptionKey` now throw clear errors when current/new `VAULT_KEY` is unset. New `src/tests/default-vault-key-removed.test.js` (7 tests, red-first) provides textual + behavioural gates. Commit `fda13b8`. Tests 23/23, 276 pass. |
| 2026-04-21 | implementation | M2 Step 6 (T2.5) landed: `validateRequiredSecrets()` extracted into `src/lib/validate-secrets.js` (pure, side-effect-free) and rewired from `src/index.js`. Runs fail-closed in every `NODE_ENV`; blocklist expanded to include every verbatim `src/.env.example` placeholder for the four required secrets. New `src/tests/validate-required-secrets.test.js` (14 tests, red-first). T2.4 regression gate updated to track the blocklist's new home. Commit `380b9af`. Tests 24/24, 290 pass. |
| 2026-04-21 | docs | M2 wrap-up (T2.8): `CLAUDE.md`, `SECURITY.md`, `README.md` aligned to the post-M2 reality — "AES-256-GCM everywhere" claim now backed by specifics (HKDF domain separation, deleted weak-crypto modules, removed default-key fallback, fail-closed secret validation in every NODE_ENV), and stale references to deleted modules (`brain/brain.js`, `vault/vault.js`, `src/config/database.js`, `src/routes/api.js`, `src/gateway/tokens.js`) removed. Tests unchanged (24/24, 290 pass). |
| 2026-04-21 | tooling | **Docker-first integration scaffolding (pre-Step 4).** New `Dockerfile.dev` (small dev/test image — installs root `package.json` incl. devDeps, skips dashboard build). Needed because `src/Dockerfile`'s from-scratch build is broken (runs `vite build` without installing vite — observed `sh: 1: vite: not found`) and the root `Dockerfile` uses `npm ci --only=production` so it can't run tests. Production Dockerfiles left untouched; their cleanup is tracked for M3 wrap-up. New `docker-compose.test.yml` (one-shot `npm test` container against `:memory:`, `internal: true` network, bind-mounts `./src/` so test edits don't need `--build`, `--exit-code-from` for CI). New `docker-compose.smoke.yml` (hot-reload via nodemon `--legacy-watch` for Docker Desktop / Windows bind-mount polling; bind-mounts `./src/`, `./data/`, `./connectors/`; persistent SQLite at `/app/data/myapi.db`; port 4500 exposed; `.env.smoke` required). New `.env.smoke.example` committed template with non-banned test-grade JWT / SESSION / ENCRYPTION / VAULT values — boots cleanly through `src/lib/validate-secrets.js` without further edits. 9 new `package.json` scripts: `test:integration` + `test:oauth` (local Jest subsets — integration = supertest-driven handler suites; oauth = the 5 M3 state + schema + inventory + security hardening + signup files), `docker:test` / `docker:test:integration` / `docker:test:oauth` (Docker wrappers for each), `docker:smoke` / `docker:smoke:down` / `docker:smoke:logs` / `docker:smoke:shell` / `docker:smoke:init`. New `.context/runbooks/manual-smoke.md` with the full Docker-first sequence (one-time setup, boot, master-token seeding, HTTP smoke curls, post-Step-4 OAuth state verification via `sqlite3` inside the container, tear-down, per-compose-file responsibility table, gotchas). `.gitignore` updated to ignore `.env.smoke` + `/data/`. **Zero-risk on source — no file under `src/` was touched — so `npm test` stays at 29/29 suites / 394 pass / 18 skip.** **Live-validated before commit:** `docker-compose.smoke.yml` build + boot clean (migrations applied incl. M3 Step 2 oauth_state_tokens columns + indexes confirmed in the running file-backed DB), `/health` 200, `/api/v1/health` correct 401, master-token seeding + `/api/v1/services` 200 auth round-trip OK. `docker-compose -f docker-compose.test.yml up` first run hit 9 failures in `critical-security-fixes.test.js` (`Cannot find module '../../connectors/afp-daemon/lib/daemon.js'`) — fixed by adding `./connectors:/app/connectors:ro` to the test compose; rerun **29/29 suites, 394 pass, 18 skip, identical to host**. What this unlocks: every subsequent M3 step (authorize rewire, callback rewire, full e2e round-trip) ships its supertest file picked up automatically by `npm run docker:test:oauth`; manual QA has a single documented sequence with no host Node install. One pre-existing bug surfaced (out of scope): `GET /api/v1/me` returns 403 `DEVICE_APPROVAL_FAILED` / `FOREIGN KEY constraint failed` — reproduces on host; documented in runbook's known-gotchas table, scheduled for separate fix post-M3. Deferred to M3 wrap-up: retiring `docker-compose.dev.yml` (still mentions MongoDB deleted in M1) and reconciling root `Dockerfile` vs `src/Dockerfile` (docker-compose.yml references the former, every other compose file references the latter). |
| 2026-04-21 | implementation | **M3 Step 3 / T3.2 + T3.3 landed: pure `src/domain/oauth/state.js` module.** The single entry point for the OAuth state lifecycle is on disk. Exported surface: `createStateToken` (writes a row with a random 32-byte PKCE verifier + PKCE S256 challenge), `consumeStateToken` (validated lookup + guarded single-use UPDATE + symbolic errors), `pruneExpiredStateTokens` (for the Step 8 scheduler), plus `computeCodeChallenge` / `StateTokenError.CODES` / `VALID_MODES`. Red-first: `src/tests/oauth-state-domain.test.js` (22 assertions covering module surface, PKCE S256 RFC 7636 Appendix B known-answer test, happy + replay + expired + service-mismatch + mode/service validation + TTL honoured via injected clock + grace-window honoured in prune) filed at 22/22 FAIL (MODULE_NOT_FOUND against HEAD), then the implementation landed in the same commit at 22/22 green. Notable engineering call: the module avoids `db.transaction(fn)` because this repo's `SQLiteAdapter.transaction()` is an async-Promise wrapper (see `src/lib/db-abstraction.js:132`) incompatible with the native better-sqlite3 sync semantics — instead, `consumeStateToken` uses a single-statement guarded UPDATE (`WHERE state_token = ? AND used_at IS NULL`) which gives the same "first wins, losers see REUSED" invariant without coupling to the adapter shape (documented in the module header). Service-mismatch intentionally does NOT consume the row so a benign retry with the correct service still works. The Step 3 inventory gate flipped from "module absent" to "module present + exports ADR-0006 surface" in the same commit. Full `npm test` → 29/29 suites, 394 pass, 18 skip, exit 0 (+1 suite / +23 assertions vs Step 2). H1 is closed at the primitive level; handler-level closure ships in Steps 4 + 5. |
| 2026-04-21 | implementation | **M3 Step 2 / T3.1 landed: additive schema migration on `oauth_state_tokens`.** Red-first `src/tests/oauth-state-schema.test.js` (8 assertions covering full column shape + nullability + UNIQUE + three indexes + row round-trip) filed in its red state (6 fail / 2 pass against HEAD); then `src/database.js` gained the additive migration — fresh DBs get the full 10-column `CREATE TABLE`, existing deployments pick up the new columns via `safeMigration()` ALTERs on next boot (idempotent, zero backfill, zero downtime — pre-migration rows are ephemeral 10-min state tokens). Column choices documented inline in `src/database.js` and in the test file header: `user_id TEXT NULL` (matches this repo's `users.id` convention rather than ADR-0006's INTEGER — deviation explicit in the test), `mode TEXT NOT NULL DEFAULT 'login'` (DEFAULT only there so the ALTER succeeds on non-empty tables), `return_to TEXT NULL`, `code_verifier TEXT NOT NULL DEFAULT ''` (DEFAULT only for ALTER safety; domain module never writes the empty string), `used_at TEXT NULL`. Two new indexes: `idx_oauth_state_tokens_expires` (for the Step 8 prune scan) and `idx_oauth_state_tokens_used` (for replay checks + prune grace). Schema-gap assertions in `oauth-state-inventory.test.js` flipped `toBe(false)` → `toBe(true)` in the same commit (same snapshot-inversion pattern used in M2 Step 2 on `legacy-vault-inventory`). Full `npm test` → 28/28 suites, 371 pass, 18 skip, exit 0 (+1 suite / +8 assertions vs Step 1). |
| 2026-04-21 | planning | **M3 Step 1 / T3.0 landed: execution playbook + inventory gate.** `ADR-0014-m3-oauth-state-hardening-plan.md` ratified — 8-step commit plan, test-first contract per step, commit cadence mirroring M2. Target design is frozen from ADR-0006 (DB-backed single-use state rows with random PKCE verifier in-row); ADR-0014 decides the execution *path* to get there. New `src/tests/oauth-state-inventory.test.js` (12 assertions) locks the four broken-today facts as TODO-labelled gates that each downstream step will flip: 5 schema-gap assertions on `oauth_state_tokens` (missing `user_id` / `mode` / `return_to` / `code_verifier` / `used_at` — flip in Step 2 / T3.1), a textual gate on `buildPkcePairFromState` + its deterministic HMAC literal (flip in Step 5 / T3.5), a textual gate on `oauthStateMeta` (flip in Step 4+5), a textual gate on `isDiscordBotInstall` (flip in Step 5 / T3.6), and an existence gate on `src/domain/oauth/state.js` (flip in Step 3 / T3.2). Ran **green against HEAD** today (12/12). Full `npm test` → 27/27 suites, 363 pass, 18 skip, exit 0 (was 26/351 at end of M2 wrap-up; +1 suite / +12 assertions). No production code touched in this commit — pure test-first pre-work per ADR-0012. |
| 2026-04-23 | implementation | **M3 Steps 4 + 5 paired in one atomic commit (T3.4 + T3.5 + T3.6).** Collapsed per user direction to preserve the end-to-end coverage of `oauth-signup-flow.test.js` (an authorize-only refactor would have left that suite temporarily red on an intermediate SHA). **`src/index.js`:** (a) authorize handler replaces the session-backed `oauthStateMeta[state] = {...}` write with `createOAuthStateRow({ db, serviceName, mode, returnTo, userId })` (domain `createStateToken` aliased to avoid colliding with the retired legacy same-named export from `./database`) and hands `stateRow.codeChallenge` to the provider auth URL instead of `buildPkcePairFromState(state).codeChallenge`; (b) callback handler replaces the session lookup + `buildPkcePairFromState` call with a single `consumeStateToken({ db, state, serviceName })` call, reconstructs the downstream-compatible `stateMeta` from the consumed row, surfaces the domain module's taxonomy as discriminated HTTP 400s (`STATE_MISSING` / `STATE_NOT_FOUND` / `STATE_EXPIRED` / `STATE_REUSED` / `STATE_SERVICE_MISMATCH`), and sources the PKCE verifier from `stateRow.code_verifier` for the token exchange; (c) the `isDiscordBotInstall` variable and its `!state && guild_id` 302-bypass branch are gone — Discord follows the same mandatory-state path as every other provider; (d) the `base64UrlNoPad` and `buildPkcePairFromState` function declarations are **deleted** (H1 closed at the handler level — C3 + C6 closed at the handler level). **Inventory regression gates flipped:** the four remaining `TODO(M3 Step 5)` / `(M3 Step 4+5)` assertions in `src/tests/oauth-state-inventory.test.js` now assert the **absence** of `buildPkcePairFromState`, the HMAC `pkce:${state}` literal, any `req.session.oauthStateMeta` write, and any `isDiscordBotInstall` reference. **New test files:** `src/tests/oauth-authorize-handler.test.js` (supertest-driven integration suite locking the authorize refactor — state-row persistence, PKCE-challenge passthrough, mode/returnTo/userId plumbing, and absence of any session-side state write) and `src/tests/oauth-callback-handler.test.js` (8 scenarios: happy-path 302 + `used_at` populated, replay → `STATE_REUSED`, unknown state → `STATE_NOT_FOUND`, service mismatch → `STATE_SERVICE_MISMATCH`, expired → `STATE_EXPIRED` with `used_at` kept NULL, Discord-without-state → 400, fresh-agent/cookies-dropped → 302 proving no session dependency, twitter row stores a 43-char random base64url verifier). **Test-first discipline preserved:** the inventory gate flip + both new supertest suites were written red-first before `src/index.js` was touched; the interim RED state was observable via `oauth-signup-flow.test.js` failing on the callback-only refactor — this confirmed the refactor actually changed behaviour rather than accidentally no-op'ing. **Full Docker regression green:** `docker-compose -f docker-compose.test.yml run --rm myapi-test npx jest --forceExit` → **32 suites / 422 pass / 18 skipped / 0 fail** in ~7.3 s (+2 suites / +28 assertions vs ADR-0015 baseline). Live smoke intentionally deferred to M3 wrap-up — the new handler tests drive the exact state-consumption path end-to-end, and batching a single real-Google smoke at the end of Steps 6–8 is cheaper than per-Step smoke runs. |
| 2026-04-24 | implementation | **M3 Step 8 / T3.9 landed: OAuth prune scheduler (state + pending-confirm, env-configurable).** Closes M3 at the implementation level — only the M3 wrap-up commit (docs + legacy-export retirement + one live Google smoke) remains. New module `src/domain/oauth/prune-scheduler.js` is a thin composition layer on top of the two pure primitives shipped earlier in M3: `pruneExpiredStateTokens` (T3.2) and `pruneExpiredPendingConfirms` (T3.7). Rationale for a separate module rather than inlining into `src/index.js`: (a) the primitives are timer-free and unit-tested against an injected clock; the scheduling glue + env-var config + structured log line is the only thing left, and it shouldn't contaminate those pure modules, (b) `src/index.js` is already ~12.7k LOC, and keeping the scheduler here means M6 (monolith extraction) doesn't have to fish it out. **Module surface:** `runPruneOnce({ db, now?, graceSec?, logger? })` → `{ prunedState, prunedPending, elapsedMs }` (synchronous, never throws — independent try/catch around each prune so a failure in one doesn't skip the other, and both swallow-and-log via `logger.error`); `startPruneScheduler({ db, intervalMs?, graceSec?, logger?, timers? })` → `stop()` (registers via `timers.setInterval`, calls `.unref()` when available so an idle scheduler doesn't block `process.exit()`); `DEFAULTS = Object.freeze({ intervalMs: 600_000, graceSec: 3600 })`. A tick with `prunedState + prunedPending > 0` emits ONE `logger.info('pruned expired OAuth rows', { pruned_state, pruned_pending, elapsed_ms })` line; empty ticks are silent at INFO (healthy steady state never spams the log). **`src/index.js` bootstrap wiring:** new block near the other `setInterval` sites reads `OAUTH_PRUNE_INTERVAL_MS` (integer ≥ 1000, default `DEFAULTS.intervalMs`) and `OAUTH_PRUNE_GRACE_SEC` (integer ≥ 0, default `DEFAULTS.graceSec`) from env and calls `startOAuthPruneScheduler({ db, intervalMs, graceSec })`. The legacy `cleanupExpiredStateTokens()` invocation from the old BUG-11 hourly tick (which did a naive `DELETE FROM oauth_state_tokens WHERE expires_at < now` with no grace window and no pending-confirm awareness) is **removed** from the scheduler block; the rate-limit half of that block (`cleanupOldRateLimits(24)` hourly) is kept. The `cleanupExpiredStateTokens` import is also dropped from the `./database` destructure in `src/index.js`; the primitive is left on disk in `src/database.js` for now so any stray caller keeps resolving — full retirement tracked for M3 wrap-up. **Red-first test:** `src/tests/oauth-prune-scheduler.test.js` (10 assertions) filed at 10/10 FAIL against HEAD (MODULE_NOT_FOUND), then the impl landed in the same commit at 10/10 green. Coverage: module surface, DEFAULTS shape + frozenness, empty-DB silence, state-side prune happy path + structured log payload shape, pending-confirm-side prune, `graceSec` override (zero-grace override prunes where default-grace keeps), fault isolation (`pruneExpiredPendingConfirms` throws → scheduler returns the state-side count + logs error + does not throw), interval wiring via injected `{ setInterval, clearInterval }` timers, DEFAULTS fallback when `intervalMs` is omitted, `handle.unref()` is called when present. **Full Docker regression:** `docker compose -f docker-compose.test.yml run --rm myapi-test npm test -- --forceExit` → **35 suites / 485 pass / 14 skip / 0 fail** (+1 suite / +10 tests vs T3.8 baseline of 34 / 475 / 14 / 0). M3 is now **10/10 at the implementation level**; wrap-up commit covers docs, signup/connect-mode `provider_subject` threading, legacy export retirement, and one live Google smoke. |
| 2026-04-24 | implementation | **M3 Step 7 / T3.8 landed: §5.4 OAuth state + PKCE + confirm regression matrix.** The `describe.skip('[M3] OAuth state + PKCE hardening (to be added in T3.8)')` placeholder in `src/tests/security-regression.test.js` is flipped to a live `describe` with 5 real-behaviour tests. Env-var bootstrap at file top now populates `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` before `require('../index')` so the Google adapter is available; a `jest.mock('../services/google-adapter')` stub mirrors the `oauth-callback-handler.test.js` mock (returns a deterministic token bundle + fixed `verifyToken` profile with `email: 'regression-user@example.com'`, `sub: 'google-regression-sub'`) so tests run with zero network contact. A `beforeAll` in the new describe seeds a `users` row with the matching email so tests 4 + 5 funnel through the T3.7 first-seen `confirm_login` branch rather than short-circuiting to `signup_required`. **Five §5.4-aligned assertions land:** (1) replayed state → 400 `STATE_REUSED` + row stays consumed; (2) Discord missing-state + `guild_id` → 400 (bypass gone); (3) expired state → 400 `STATE_EXPIRED` + `row.used_at` kept NULL (benign retry path stays intact); (4) valid happy-path → 302 whose Location carries `oauth_status=confirm_login` + a fresh `token=...`, row.used_at stamped; (5) replayed pending-confirm token → 400 `{error: 'pending_confirm_reused'}` + `/auth/me` from a fresh attacker agent does NOT leak the victim's email. Status-code deviation from plan wording ("→ 401" for the confirm-login replay) is documented inline in the describe header: the implemented contract is 400 + discriminated `error` string, same taxonomy family as the state-row 400s — we follow the contract here. **Intentionally NOT re-coverage:** domain-module happy paths (already in `oauth-state-domain.test.js`), authorize-side assertions (already in `oauth-authorize-handler.test.js`), full callback taxonomy incl. `STATE_SERVICE_MISMATCH` + PKCE-verifier-passthrough (already in `oauth-callback-handler.test.js`), confirm endpoint unit contracts (already in `oauth-confirm-handler.test.js`) — this suite's job is the §5.4 *regression lock* on five named threat-model bullets, not re-exercising surfaces that are already pinned. **Full Docker regression green:** `docker compose -f docker-compose.test.yml run --rm myapi-test npm test -- --forceExit` → **34 suites / 475 pass / 14 skip / 0 fail** (+5 tests vs T3.7 baseline of 34 / 470 / 18 / 0). Three previously-skipped M3 `test.todo` placeholders promoted into passing tests, hence `-4` in the skip bucket; the 5th test is new above that count. No production code touched — pure test-first regression lock-in per ADR-0012. |
| 2026-04-21 | implementation | Frontend open-redirect hardening in `src/public/dashboard-app/src/pages/LogIn.jsx` (folded into the M2 wrap-up commit). The upstream dashboard rewrite had dropped the `pendingReturnTo.startsWith('/dashboard/')` guard, leaving four post-authentication sites (`confirm_login`, `connected`, 2FA challenge, `redirectAfterLogin`) assigning `window.location.href = pending` where `pending` was derived from attacker-controllable `?returnTo=` and re-hydrated from `sessionStorage` — phishable via `/dashboard/login?returnTo=https://evil.example/...`. Fix ships a single-source-of-truth pure helper `isSafeInternalRedirect(target)` at `src/lib/redirect-safety.js` (CJS, Jest-testable) with a byte-parity ESM mirror at `src/public/dashboard-app/src/utils/redirectSafety.js` consumed by `LogIn.jsx`; all four sites now funnel through a hardened `redirectAfterLogin(serverPreferredTarget?)` sink. Behavioural test `src/tests/redirect-safety.test.js` (51 assertions: accept table, non-strings, URL schemes, protocol-relative, backslash smuggling, scheme-like-without-slash, control chars, determinism) + textual gate `src/tests/login-jsx-redirect-safety.test.js` (10 assertions: import presence, sink presence, no banned-symbol assignments, every remaining `window.location.href = X` either guarded `target` or hardcoded same-origin literal, CJS↔ESM source parity). Full `npm test` → **26/26 suites, 351 pass, 18 skip, exit 0** (was 24/290; +2 suites, +61 assertions). Lint + typecheck report zero new findings on changed files. |

| 2026-04-24 | implementation | **M3 wrap-up commit: M3 is now ✅ Complete.** Four deferred work items shipped in one atomic commit behind a live Google OAuth smoke. **Task A — `provider_subject` threading:** signup-complete handler in `src/index.js` now forwards `pending.providerUserId` into `storeOAuthToken(...)` **and** calls `recordFirstConfirmation(...)` so signup carries implicit consent (the very next login-mode callback skips the confirm gesture). Connect-mode + non-primary-login-mode branches of the callback handler also thread `providerUserId`. Net effect: `oauth_tokens.provider_subject` is NEVER null after a fresh signup or connect-mode link; closes the `COALESCE`-fallback window flagged in ADR-0016 §Follow-ups. **Task B — legacy state-token exports retired:** deleted `createStateToken` / `validateStateToken` / `cleanupExpiredStateTokens` functions + exports from `src/database.js`; verified zero live callers (authorize/callback go through `src/domain/oauth/state.js` since T3.4+T3.5; prune scheduler owns the tick since T3.9). **Task C — docs rebaseline:** `SECURITY.md` / `README.md` / `CLAUDE.md` / `.env.smoke.example` updated for M3 reality (DB-backed state, first-seen confirm gesture, `OAUTH_PRUNE_INTERVAL_MS` / `OAUTH_PRUNE_GRACE_SEC` knobs, Discord carve-out gone); stale `buildPkcePairFromState` / `oauthStateMeta` references purged. **Task D — live Google OAuth smoke (`docker:smoke`):** five scripted phases all passed their M3-relevant assertions: (1) token auto-refresh — aged `expires_at` into the past, proxy call succeeded + row refreshed (first attempt false-negatived on `TOKEN_CACHE_TTL=5min` cache; container restart flushed, retry green — cache TTL is a separate concern); (2) prune scheduler — aged all `oauth_state_tokens` rows, `runPruneOnce({ db })` deleted them, empty ticks silent as designed; (3) Gmail proxy end-to-end green; Calendar + Drive returned `403 PERMISSION_DENIED` from Google because those APIs weren't enabled in the operator's GCP project — MyApi proxied correctly, not an M3 defect; (4) SSRF guards — proxy calls to `127.0.0.1`, `169.254.169.254`, `localhost:4500`, `0177.0.0.1`, `2130706433` all rejected at `isPrivateHost` before the outbound request fired; (5) returning-user login skips the gesture — second authorize → callback cycle with stamped `first_confirmed_at` 302'd straight to `/dashboard/`, no `oauth_pending_logins` row created, confirming ADR-0016's first-seen key works under live conditions. **Task E — docs flip:** M3 row in this file flipped to ✅ Complete (2026-04-24); `current_state.md` §5 + §6 rebaselined. **Three non-M3 follow-ups filed** in `.context/tasks/backlog/`: `F1` (SPA post-OAuth routing race bounces user to `/` instead of `/dashboard/` — UX, bundles with M9), `F2` (onboarding wizard is half-wired; M3 wrap-up stubbed `onboardingUtils.js` exports as localStorage no-ops to unblock the SPA build — decide ship-vs-retire in M9), `F3` (Google `prompt=consent` forced every login — `LogIn.jsx` hard-codes `forcePrompt=1`; fix queued as the next work session per operator direction 2026-04-24). **Tests:** +5 vs T3.9 baseline (signup-mode E2E in `security-regression.test.js` + `storeOAuthToken` arity static gate + three legacy-export-absence gates in `oauth-state-inventory.test.js`, all red-first). Full Docker regression **35 suites / 490 pass / 14 skip / 0 fail**. Shipped as two commits: `fix(dashboard): stub missing onboarding utils to unblock build` (separate because the stubs are frontend-build hotfix unrelated to M3) and `feat(oauth): M3 complete — DB-backed state + first-seen gesture + prune scheduler` (the atomic M3 wrap-up). Session log: `sessions/2026-04-24-m3-smoke.md`. |

_End of TASKS.md — update the per-milestone **Progress** table at the top and the
**Change log** above whenever you mark tasks done._
