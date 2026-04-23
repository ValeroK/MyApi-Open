# ADR-0001 — Drop MongoDB support entirely

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** `plan.md` §0.1 (OQ-1), §3.3 (AD-1), `TASKS.md` M8
- **Tags.** architecture, database, cleanup

## Context

The repo ships two database backends: `src/database.js` (SQLite via
`better-sqlite3`; PostgreSQL as an alternate driver) and a largely abandoned
`src/database-mongodb.js`. The Mongo path:

- Is not covered by any tests in `src/tests/`.
- Is not referenced by `docker-compose.dev.yml` or `docker-compose.prod.yml`.
- Does not implement every table used by the live code (no audit log schema,
  no `state_tokens` migration path, no vault-key rotation).
- Forces every DB call site to branch on driver — a recurring source of drift
  between the real (SQLite/PG) path and the paper (Mongo) path.

Keeping it adds cognitive load, CI time, and an under-tested attack surface
around identity storage.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Keep Mongo, finish implementing parity | Widest DB choice for self-hosters | Doubles test/CI cost; duplicates every migration; nobody is actually using it |
| B | Mark Mongo experimental and stop maintaining it | Cheap in the short term | Drift continues; users may still stumble onto a half-working path |
| C | **Delete Mongo entirely** | Single code path; clearer tests; smaller image; removes dead attack surface | Users who want a document store must run SQLite or PG (both trivially self-hostable) |

## Decision

**Option C — delete MongoDB support.**

Rationale:

- SQLite covers every self-host use case without a separate process.
- PostgreSQL covers every managed-cloud use case (ADR-0004 keeps OSS/cloud
  parity on the same code path).
- The saved effort goes into making one abstraction solid in `src/infra/db/`
  rather than two abstractions brittle.

## Consequences

- `src/database-mongodb.js` is deleted.
- `mongodb` is removed from `package.json`.
- Mongo-specific branches in `src/index.js` DB init are stripped out.
- `.context/current_state.md`, `CLAUDE.md`, `README.md`, and any `docs/`
  references to MongoDB are deleted or corrected.

## Follow-ups

- Executed by tasks **T8.1–T8.2** in `TASKS.md`.
- No metric/alert change.
- Revisit only if a concrete user with a real MongoDB-only constraint
  appears — and even then, the answer is likely "run PostgreSQL instead".
