# ADR-0015 — Master-token owner must have a matching `users` row

**Status:** Accepted (Option A landed 2026-04-23; Option B scheduled for M4 T4.9)
**Date:** 2026-04-23
**Related:** ADR-0013 (legacy vault is orphan / M2 re-scoping), ADR-0014 (M3 OAuth state hardening), `.context/runbooks/manual-smoke.md`

---

## 1. Context

The Docker-first smoke harness introduced in M3 (commit `8d9a7d4`) was the
first path that exercises the freshly-bootstrapped server end-to-end
without pre-existing seed data. During live validation on 2026-04-21, an
authenticated `GET /api/v1/me` call with the bootstrap-issued master
token failed with:

```
HTTP/1.1 403 Forbidden
{ "error":"device_approval_error", "code":"DEVICE_APPROVAL_FAILED",
  "details":"FOREIGN KEY constraint failed" }
```

Root-cause trace:

1. `bootstrap()` in `src/index.js` creates an `access_tokens` row with
   `owner_id = "owner"` whenever none exists.
2. `src/database.js:164` defines `access_tokens` with `owner_id TEXT NOT NULL`
   and **no** foreign-key constraint to `users(id)`.
3. Consequently the seed path never required a `users` row to exist
   and never created one.
4. `device_approvals_pending` (`src/database.js:554`) **does** declare
   `FOREIGN KEY (user_id) REFERENCES users(id)`.
5. The first authenticated request from an unknown device enters
   `deviceApprovalMiddleware`, which calls
   `db.createPendingApproval(tokenId, userId='owner', …)`. With SQLite's
   `foreign_keys = ON` pragma active (set on multiple code paths in
   `src/index.js`), the INSERT aborts with
   `SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed`.
6. The middleware's `catch(error)` block is fail-closed and returns
   `403 DEVICE_APPROVAL_FAILED`, masking the true cause.

The bug was **pre-existing** (both `createAccessToken` sites and the
device-approval middleware predate M2) but only surfaced because the
Docker-first smoke harness became the first environment where a raw
bootstrap → `/api/v1/me` path was exercised without hand-crafted seed
data.

---

## 2. Decision

Ship the fix in two phases:

### 2.1 Option A — "Ensure users row at seed time" (landed 2026-04-23)

Introduce `ensureOwnerUserRow(ownerId, options?)` as a public helper in
`src/database.js`:

- Inserts a minimal `users` row keyed on `ownerId` using
  `INSERT OR IGNORE` on `(id)` and `UNIQUE(username)`, making the call
  idempotent across re-seeds and --force rotations.
- Sets `password_hash = '!seed-owner-nologin!'`, a deliberately
  non-bcrypt sentinel: `bcrypt.compare` will never return `true` against
  it, so the seed identity cannot be logged in to through the password
  path.
- Sets `status = 'active'`, `plan = 'free'`, and a human-readable
  `display_name = 'Master Token Owner'`.
- Swallows and logs any DB error rather than throwing — the caller
  continues and the FK will re-surface the original symptom if this
  ever silently fails, which is visible.

Call it immediately before every master-token `createAccessToken` site
whose `owner_id` is not already known to exist in `users`:

1. `src/scripts/init-db.js` `seedMasterToken()` — both the create-new
   path and the self-heal path on the no-op branch (heals DBs that were
   created by pre-fix seeds).
2. `src/index.js` `bootstrap()` — the primary server-boot seed path.
3. `src/index.js` `/api/v1/tokens/master/regenerate` — defense in depth
   for the `ownerId || 'admin'` fallback.

The two remaining master-token creation sites (dashboard "bootstrap"
handler at line ~5470 and OAuth signup completion at line ~7225) are
left untouched because their `ownerId` originates from a `users` row
that was just inserted in the same request — no FK gap possible.

### 2.2 Option B — "Elevate `owner_id` to a real FK" (scheduled: M4 T4.9)

Make the inconsistency representationally impossible by adding

```sql
FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
```

to `access_tokens`. This requires:

- An additive migration: create `access_tokens_v2` with the FK, copy
  rows whose `owner_id` exists in `users` (back-populating missing
  `users` rows via `ensureOwnerUserRow` first), swap, drop.
- Audit every `createAccessToken` call site (~15) to confirm the
  `ownerId` argument is always a real `users.id` by the time it's
  called (and fix any offenders).
- Update `src/database.js` helpers (`getAccessTokens`,
  `getExistingMasterToken`, `createAccessToken`) to assume the FK and
  return typed errors if it's violated.
- Remove `ensureOwnerUserRow` call from `bootstrap()` and
  master-regenerate handler (they become unnecessary once the FK
  forces the invariant), but keep the helper exported for the
  `init-db.js` CLI path (which may be run against a DB with no prior
  users).

Deferring B to M4 (session/rate-limit dual-driver store) keeps the
change window focused: M4 already touches `users`-adjacent middleware
(session storage) and is the natural place to add a small data-integrity
migration. Doing it as a standalone task now would require its own
commit sequence and ADR-0012 test-first treatment, which is churn we
don't need mid-M3.

---

## 3. Consequences

### Positive

- The "403 DEVICE_APPROVAL_FAILED on first `/api/v1/me` after fresh
  boot" smoke-harness bug is gone (verified live 2026-04-23 on a
  freshly-wiped `./data/`: `/api/v1/me` now returns the intended
  `403 DEVICE_APPROVAL_REQUIRED` gate with a persisted
  `device_approvals_pending` row).
- Every FK-dependent downstream table that joins on `user_id` now has
  a valid parent row for the master-token owner. This unblocks:
  notifications, activity log inserts, audit chains, and any future
  table that adds a `FOREIGN KEY (user_id) REFERENCES users(id)`.
- Self-healing: existing production databases that were seeded pre-fix
  get their missing `users` row added the next time `init-db` runs
  (see `seedMasterToken()` no-op branch).

### Negative

- Two DB writes instead of one at seed time. Trivial cost (<1 ms).
- The `password_hash` sentinel is not a true bcrypt string. Any future
  code path that assumes `users.password_hash` is always bcrypt-format
  must handle this (none do today — verified via `Grep`).
- Option B still needs to land. Until it does, an ill-behaved future
  `createAccessToken` call that bypasses `ensureOwnerUserRow` would
  re-introduce the bug. The new integration test
  `src/tests/device-approval-fk-integrity.test.js` would catch this in CI.

### Neutral

- `access_tokens.owner_id` remains a free-form `TEXT` column until M4.
- The `NOLOGIN_PASSWORD_HASH` sentinel is deliberately unobtrusive
  (not a constant like `"!"` alone) so grep / inspection of the DB
  quickly identifies seed-owner rows.

---

## 4. Test coverage

- `src/tests/init-db-seed.test.js` — 5 new assertions (FK-on-enabled):
  users row exists, non-bcrypt sentinel, `createPendingApproval`
  succeeds, re-seed idempotency, custom-ownerId path.
- `src/tests/device-approval-fk-integrity.test.js` — 3 new
  assertions: `bootstrap()` seeds users row, `GET /api/v1/me` does
  NOT return `DEVICE_APPROVAL_FAILED`, pending-approval row was
  written successfully (FK chain held).

Both suites are part of `npm run docker:test` and
`npm run docker:test:integration`.

---

## 5. Rollout

- Option A: committed with ADR-0015 (this document) and the two test
  suites. Live-smoke verified on the Windows Docker Desktop smoke
  harness. No migration needed — `ensureOwnerUserRow` back-fills on
  the first `init-db` run after upgrade.
- Option B: M4 T4.9. Will require a migration (`access_tokens_v2`
  swap) and a dedicated ADR-0015-addendum describing the cut-over.
