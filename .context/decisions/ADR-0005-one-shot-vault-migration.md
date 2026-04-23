# ADR-0005 — One-shot offline vault migration to AES-256-GCM

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** `plan.md` §0.1 (OQ-5, OQ-7), §6.3 (critical item "weak
  `crypto-js` AES path"), `TASKS.md` M2
- **Tags.** security, crypto, migration

## Context

`src/vault/vault.js` encrypts `identity_vault` and `connectors` rows with
`src/utils/encryption.js`, which uses `crypto-js` AES **without an explicit IV
or authentication tag**. This is broken on two counts:

1. Confidentiality: CBC-without-per-record IV leaks equal-plaintext-prefix.
2. Integrity: no authentication tag → ciphertext is malleable.

Meanwhile `src/lib/encryption.js` provides AES-256-GCM with PBKDF2 (600k) and
unique nonces. We need to move every row over and retire the broken path.

Normally such migrations are done with a **dual-read window**: the reader
tries the new format first, falls back to the legacy format, and lazily
re-encrypts on next write. That pattern is valuable in production systems
where some ciphertext might live untouched for months and downtime is
unacceptable.

MyApi is **not in production yet** (OQ-7 explicitly grants clean-rewrite
latitude). The dual-read pattern costs complexity we don't need.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Dual-read + lazy re-encrypt | No migration script; zero downtime | Legacy decryption code lives on indefinitely; migration "finishes" silently and unverifiably |
| B | Dual-read for N days, then delete legacy path | Clear end date | Still requires both paths in production for a window |
| C | **Offline one-shot migration script, same PR deletes legacy code** | Auditable (row count + HMAC check in the script); legacy code gone in the same change; no production-only edge cases | Requires a short maintenance window when real users exist (currently: zero) |

## Decision

**Option C — one-shot migration.**

Workflow:

1. Stop the service (not applicable pre-production; documented for later).
2. Run `npm run db:migrate:vault-to-gcm`:
   - Opens a transaction.
   - For each row in `identity_vault` and `connectors`:
     - Decrypts with legacy `crypto-js` code.
     - Re-encrypts with `src/lib/encryption.js` (AES-256-GCM) using the
       per-purpose subkey `vault:v1` (HKDF-derived in ADR-0003-adjacent work).
     - Writes back under a version-prefixed ciphertext (`v1:…`) so the script
       is idempotent — already-migrated rows are skipped.
   - Verifies final row count matches input; verifies HMAC-SHA-256 over a
     spot-check sample before commit.
   - Commits.
3. The same PR that ships the migration **deletes** `src/utils/encryption.js`,
   rewrites `src/vault/vault.js` into `src/domain/vault/index.js`, and removes
   `crypto-js` from `package.json`.
4. Restart the service.

## Consequences

- The vulnerable path disappears from the codebase in one change, which is
  much easier to prove and audit than a multi-week dual-read rollout.
- No rollback via the codebase: if the migration fails, restore from backup
  and re-run. A backup verification step is called out in the runbook.
- Self-hosters who upgrade across this PR must read the upgrade note in
  `docs/runbooks/key-rotation.md` (stubbed in T2.3).

## Follow-ups

- Executed by tasks **T2.1–T2.8** in `TASKS.md`.
- Runbook: `docs/runbooks/key-rotation.md` gets a "first migration" section.
- Related: ADR-0006 covers OAuth token storage (unaffected — they already use
  `src/lib/encryption.js`).
