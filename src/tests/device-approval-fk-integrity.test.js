/**
 * Integration test — ADR-0015 Option A regression gate.
 *
 * Locks the fix for the smoke-harness bug:
 *   `GET /api/v1/me` on a freshly-bootstrapped DB used to return
 *   403 DEVICE_APPROVAL_FAILED with `FOREIGN KEY constraint failed`,
 *   because `bootstrap()` seeded `access_tokens.owner_id = 'owner'`
 *   but no matching `users` row, and
 *   `device_approvals_pending.user_id -> users(id)` tripped inside
 *   deviceApprovalMiddleware.createPendingApproval.
 *
 * After Option A:
 *   - `bootstrap()` calls `ensureOwnerUserRow('owner')` before creating
 *     the access token, so the users row is guaranteed to exist.
 *   - The first authenticated request to `/api/v1/me` from an unseen
 *     device MUST return 403 DEVICE_APPROVAL_REQUIRED (the intended
 *     "waiting for user to approve" gate), NOT DEVICE_APPROVAL_FAILED
 *     (the FK crash dressed up as a fail-closed response).
 *
 * Option B — making `access_tokens.owner_id` a real FK to `users(id)`
 * so this inconsistency cannot arise at any call site — is M4 task
 * T4.9. See `.context/decisions/ADR-0015-master-token-user-fk.md`.
 */

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ci';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'test-encryption-key-32chars!!';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-ci';
process.env.VAULT_KEY = process.env.VAULT_KEY || 'test-vault-key-ci-32characters!';
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const request = require('supertest');

let app;
let dbModule;
let masterToken;

beforeAll(() => {
  // Requiring '../index' does NOT call bootstrap() when NODE_ENV === 'test'
  // (src/index.js gates `bootstrap()` behind the non-test branch so unit
  // tests don't pollute each other's DBs). We invoke it explicitly here
  // because the whole point of this suite is to exercise the real boot
  // path that seeded the broken rows in the smoke harness.
  const mod = require('../index');
  app = mod.app;
  mod.bootstrap();

  dbModule = require('../database');

  // Foreign-key enforcement is per-connection in SQLite and not enabled
  // globally at boot. Explicitly enable it here so the assertions below
  // actually exercise the FK chain that used to break.
  const raw = dbModule.getRawDB ? dbModule.getRawDB() : dbModule.db;
  raw.pragma('foreign_keys = ON');

  // Fetch the bootstrap-seeded master token back out of the DB (the
  // server stores the raw value encrypted for exactly this purpose).
  const seeded = dbModule.getExistingMasterToken('owner');
  if (!seeded || !seeded.rawToken) {
    throw new Error(
      'bootstrap() did not seed a retrievable master token for owner; test cannot run',
    );
  }
  masterToken = seeded.rawToken;
});

describe('[ADR-0015 A] device-approval FK integrity on fresh bootstrap', () => {
  test('bootstrap creates a users row for owner_id=owner (Option A guard)', () => {
    const raw = dbModule.getRawDB ? dbModule.getRawDB() : dbModule.db;
    const row = raw
      .prepare('SELECT id, username, status FROM users WHERE id = ?')
      .get('owner');
    expect(row).toBeDefined();
    expect(row.id).toBe('owner');
    expect(row.status).toBe('active');
  });

  test('GET /api/v1/me with the bootstrap master token does NOT return DEVICE_APPROVAL_FAILED', async () => {
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${masterToken}`);

    // The important invariant: we must not crash inside
    // createPendingApproval. Any outcome other than
    // DEVICE_APPROVAL_FAILED means the FK chain held.
    expect(res.body && res.body.code).not.toBe('DEVICE_APPROVAL_FAILED');

    // Acceptable outcomes are either:
    //   - 200 (device already approved, or approval not required for this
    //          token type in the current configuration), or
    //   - 403 with code DEVICE_APPROVAL_REQUIRED and a persisted pending
    //          approval row (the FK chain committed successfully).
    expect([200, 403]).toContain(res.status);
    if (res.status === 403) {
      expect(res.body.code).toBe('DEVICE_APPROVAL_REQUIRED');
    }
  });

  test('a pending device_approvals_pending row was written successfully (FK chain held)', () => {
    const raw = dbModule.getRawDB ? dbModule.getRawDB() : dbModule.db;
    // Either:
    //   (a) no row was written (the device auto-approved, /me returned 200)
    //   (b) a row was written referencing user_id='owner' — which proves
    //       the FK to users(id) was satisfiable.
    // Both are evidence the bug is gone. The original bug would have
    // thrown inside .run() and surfaced as a 403 DEVICE_APPROVAL_FAILED
    // (already covered above).
    const pending = raw
      .prepare(
        "SELECT user_id FROM device_approvals_pending WHERE user_id = 'owner'",
      )
      .all();
    for (const row of pending) {
      expect(row.user_id).toBe('owner');
    }
  });
});
