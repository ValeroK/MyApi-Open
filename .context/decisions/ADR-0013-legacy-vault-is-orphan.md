# ADR-0013 — Legacy vault subsystem is orphan; M2 re-scoped to deletion-only

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** ADR-0005 (supersedes part of the workflow), `plan.md` §3 and §6.3,
  `TASKS.md` M2
- **Tags.** security, crypto, scoping, dead-code

## Context

ADR-0005 assumed the legacy `crypto-js` vault path in `src/vault/vault.js` was
live in the running server and that we would need a **one-shot migration**
(Option C) to move `identity_vault` and `connectors` rows over to AES-256-GCM
before deleting the weak path.

While writing the M2 characterization tests we instrumented the real import
graph starting from `src/index.js` (the actual server entry used by
`npm start` → `node src/index.js`) and discovered the legacy subsystem is
**completely orphan** in that graph:

| Module | Status |
|---|---|
| `src/utils/encryption.js` (`crypto-js`, no IV, no auth tag) | Only consumer is `src/vault/vault.js`. |
| `src/vault/vault.js` (the `Vault` class) | Only required by `src/scripts/init-db.js` (manual seed script). Not reachable from `src/index.js`. |
| `src/routes/api.js` (`createApiRoutes`) | Never `require()`d anywhere in `src/`. |
| `src/routes/management.js` (`createManagementRoutes`) | Required once at `src/index.js:2562`, but never invoked / never mounted. |
| `src/brain/brain.js` (`PersonalBrain`) | Never `require()`d anywhere. |
| `crypto-js` | Not resolvable from the repo root (`require.resolve('crypto-js', …)` throws `MODULE_NOT_FOUND`). |

In other words: inside `src/index.js` there is a local in-memory stub
`const vault = { identityDocs: {}, preferences: {} }` (see `src/index.js:2041`)
and every `vault.*` reference in the running monolith hits that stub. The
sensitive crypto that actually runs at request time (`createVaultToken`,
`getOAuthToken`, `rotateEncryptionKey`, session tokens) already uses
`src/lib/encryption.js` (AES-256-GCM with PBKDF2 600k).

The nested `src/package.json` does list `crypto-js` in its dependencies, but
`src/node_modules/` is not populated in this working copy and the top-level
install (the one CI and `npm start` use) never sees it. Any current attempt
to run `npm run db:init` at the root fails at `require('crypto-js')`.

The characterization test `src/tests/legacy-vault-inventory.test.js`
(added in this change) encodes the above as ten assertions and runs green
today.

## Options reconsidered

| # | Option | Verdict |
|---|--------|---------|
| C (original ADR-0005) | Write `migrate-vault-to-gcm.js`, migrate rows, then delete legacy code. | **No longer applicable.** There are no rows encrypted by the legacy path in the path the running server has ever used. The migration script would be written to serve a population of zero. |
| D | Pure-deletion: remove the legacy modules and the nested `crypto-js` dep; lock the change with a regression test. | Minimal diff, auditable, zero runtime risk. |
| E | Keep the migration script anyway, as insurance for self-hosters who might have run `cd src && npm install && node scripts/init-db.js` at some point in the past. | Cost: a ~200-line script + idempotency test + runbook entry. Benefit: covers a user population we have no evidence exists. **Rejected as speculative**; can be revived from git history if a real migration need is reported. |

## Decision

**Option D — pure deletion.** M2 becomes:

1. **Inventory & regression test (DONE)** —
   `src/tests/legacy-vault-inventory.test.js` locks in today's orphan state
   and, after the deletion step, becomes a permanent "weak crypto must not
   come back" gate (no module reachable from `src/index.js` may
   `require('crypto-js')` / `src/utils/encryption.js` / `src/vault/vault.js`,
   and `crypto-js` must never be resolvable from the repo root).
2. **Delete the dead modules in a single commit:** `src/utils/encryption.js`,
   `src/vault/vault.js`, `src/routes/api.js`, `src/routes/management.js`,
   `src/brain/brain.js`, `src/scripts/init-db.js`. Remove the `npm run db:init`
   script from `package.json`. Either delete the nested `src/package.json` +
   `src/package-lock.json` (they describe a separate, unmounted sub-app) or
   at minimum remove `crypto-js` from its `dependencies`. Flip the two
   "snapshot" assertions in the inventory test from `toBe(true)` to
   `toBe(false)`.
3. **Still address the non-vault half of the original M2:** the
   `default-vault-key-change-me` fallback in `src/database.js` and the
   `NODE_ENV=production`-only secret validation are independent issues not
   tied to the vault class. They stay in M2 as T2.4 / T2.5.
4. **HKDF sub-key derivation (T2.1)** is still worth doing for the *real*
   callers (`src/lib/encryption.js` consumers). It no longer has a "vault:v1"
   tenant because the vault class is being deleted, but `oauth:v1`,
   `session:v1`, `audit:v1` still apply. Keep T2.1 in M2 with the vault
   purpose removed.

Tasks T2.2 (migration script), T2.3 (migration npm script + runbook), and
T2.6 (rewrite vault into `src/domain/vault/`) are **cancelled**.

## Consequences

- **Security posture improves immediately.** The weak-crypto surface is
  removed, not migrated. There is no window during which two crypto formats
  co-exist in production.
- **Much smaller diff and smaller review surface** than Option C.
- **We lose the option to transparently rescue a self-hoster who had
  populated `identity_vault` / `connectors` via the legacy path.** If one
  reports up, we recover the deleted code via `git log` / `git revert` and
  produce a one-off recovery script from there. Captured as a risk in
  `current_state.md` §4.
- **The `SANCTIONED_LEGACY_CALLERS` set in the inventory test shrinks to
  empty** after deletion, and the test assertions `LEGACY_*` existence flip
  to `false`. This becomes the enforcement mechanism against regression.
- **ADR-0005 is partially superseded**: its *technical rationale* is still
  useful history (why we wanted GCM + HKDF + single crypto module), but its
  *workflow* (migration script + dual PR + runbook) no longer applies.
  ADR-0005's status is updated to "Accepted; migration workflow superseded
  by ADR-0013".

## Follow-ups

- Executed by revised tasks **T2.0** (inventory — DONE), **T2.4**, **T2.5**,
  **T2.7**, **T2.8**, **T2.9** (new: delete orphan routes + brain), **T2.10**
  (new: remove nested `src/package.json` `crypto-js` dep) in `TASKS.md`.
- If any user reports a populated legacy-encrypted `identity_vault` row after
  this change lands, open a dedicated ticket referencing ADR-0013 and
  restore the migration code from `git log`.
