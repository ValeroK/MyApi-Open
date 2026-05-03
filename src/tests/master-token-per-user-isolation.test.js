/**
 * Per-user master-token isolation.
 *
 * Surfaces and pins a real-world bug discovered 2026-05-02 while
 * trying to run the F6.3 Gmail-week live smoke against a gateway
 * where a real user (`mailer.kv@gmail.com` / `usr_…`) signed up
 * via Google OAuth AFTER the install-time `init-db` seed had
 * already written a master token owned by the legacy `'owner'`
 * identity.
 *
 * The bug
 * -------
 * `getExistingMasterToken(ownerId)` in `src/database.js` had a
 * silent legacy fallback:
 *
 *     const ownerIds = [String(ownerId)];
 *     if (ownerId !== 'owner') ownerIds.push('owner');   // ← bug
 *     for (const oid of ownerIds) { ...return first hit... }
 *
 * When `mailer.kv` (`usr_…`) called
 * `POST /api/v1/tokens/master/bootstrap` from the dashboard, the
 * lookup went:
 *   pass 1: owner_id = 'usr_…'  → 0 rows
 *   pass 2: owner_id = 'owner'  → 1 row (legacy seed)
 *   → returned the legacy `'owner'`-owned token to mailer.kv,
 *     cached it in mailer.kv's session, and exposed it to the
 *     dashboard as if it were the user's own master token.
 *
 * Downstream blast radius
 * -----------------------
 * Every Bearer-token request mailer.kv made (including from the
 * dashboard's auto-bootstrap on login) carried
 * `req.tokenMeta.ownerId = 'owner'`, NOT `'usr_…'`. As a result:
 *   - Audit log `requester_id` was always `'owner'`.
 *   - Pending device-approval rows were created with
 *     `user_id = 'owner'`.
 *   - The dashboard's `GET /api/v1/devices/approvals/pending`
 *     filters by the SESSION user id (`'usr_…'`), so 4 queued
 *     approval requests were invisible in the UI even though
 *     they were sitting in the DB — making it look like the
 *     approval flow was broken.
 *   - Bearer calls to `/services/google/proxy` resolved
 *     `getOAuthToken('google', 'owner')` → null (the OAuth row
 *     was correctly stored under `'usr_…'`), surfacing as a
 *     spurious 403 `not connected`.
 *
 * The fix
 * -------
 * Drop the `if (ownerId !== 'owner') ownerIds.push('owner');`
 * line. Each user's bootstrap call only looks for THEIR master
 * token; if none exists, the bootstrap handler in `src/index.js`
 * (5601-5605) creates a fresh one owned by their `usr_…` id.
 *
 * What this suite locks
 * ---------------------
 * 1. `getExistingMasterToken('usr_x')` returns null when only an
 *    `'owner'`-owned master token exists (no cross-user leak).
 * 2. `getExistingMasterToken('usr_x')` returns the `usr_x`
 *    token when both an `'owner'` token AND a `usr_x` token
 *    exist (correct ownership, not "first match wins").
 * 3. `getExistingMasterToken('owner')` still works for the
 *    legacy seed identity — we don't want to break headless
 *    installs.
 * 4. Two distinct users who both call `seedMasterToken` end up
 *    with two distinct token rows owned by the right identity
 *    (proves the seed is per-user-safe and that the legacy
 *    fallback isn't being smuggled in via some other path).
 *
 * Static gate
 * -----------
 * 5. The literal string `if (ownerId !== 'owner') ownerIds.push`
 *    must NOT exist in `src/database.js`. Permanent ratchet so a
 *    well-meaning future "smooth-migration" PR doesn't silently
 *    re-add the cross-user fallback.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Set DB_PATH to a dedicated tmp file BEFORE requiring anything that loads
// src/database.js. src/database.js connects at module-load time via the
// db-abstraction layer, so the env var has to be in place first.
const TMP_DB = path.join(__dirname, 'tmp-master-token-per-user-isolation.sqlite');
const SOURCE_FILE = path.resolve(__dirname, '..', 'database.js');

function safeUnlink(p) {
  for (const target of [p, `${p}-wal`, `${p}-shm`]) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        break;
      } catch (err) {
        if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
          const deadline = Date.now() + 100;
          while (Date.now() < deadline) { /* spin */ }
          continue;
        }
        if (err && err.code === 'ENOENT') break;
        throw err;
      }
    }
  }
}

describe('master-token per-user isolation (regression for legacy "owner" fallback)', () => {
  let dbModule;
  let seedMasterToken;

  const REAL_USER_ID = 'usr_test_' + crypto.randomBytes(8).toString('hex');
  const OTHER_USER_ID = 'usr_other_' + crypto.randomBytes(8).toString('hex');

  beforeAll(() => {
    safeUnlink(TMP_DB);
    process.env.DB_PATH = TMP_DB;
    process.env.DATABASE_TYPE = 'sqlite';
    process.env.ENCRYPTION_KEY =
      process.env.ENCRYPTION_KEY || 'test-encryption-key-must-be-32chars!';
    process.env.VAULT_KEY =
      process.env.VAULT_KEY || 'test-vault-key-must-be-32-chars!';

    dbModule = require('../database');
    dbModule.initDatabase();
    ({ seedMasterToken } = require('../scripts/init-db'));

    // Step 1: install-time seed creates the legacy 'owner' master token.
    const seed = seedMasterToken();
    expect(seed.created).toBe(true);
    expect(seed.tokenId).toMatch(/^tok_[0-9a-f]{32}$/);

    // Step 2: a real user signs up later. We just need a users row;
    // ensureOwnerUserRow handles the "DB-only identity" pattern that the
    // master-token owner uses, but a real user signs up via OAuth and the
    // FK target needs to exist for our isolation queries downstream.
    const now = new Date().toISOString();
    const insertUser = dbModule.db.prepare(`
      INSERT INTO users (id, username, display_name, email, password_hash,
                         two_factor_enabled, created_at, status, plan)
      VALUES (?, ?, ?, ?, '', 0, ?, 'active', 'free')
    `);
    insertUser.run(
      REAL_USER_ID,
      'real_user_' + REAL_USER_ID.slice(-6),
      'Real User',
      `${REAL_USER_ID}@test.local`,
      now
    );
    insertUser.run(
      OTHER_USER_ID,
      'other_user_' + OTHER_USER_ID.slice(-6),
      'Other User',
      `${OTHER_USER_ID}@test.local`,
      now
    );
  });

  afterAll(() => {
    try { dbModule.db.close(); } catch { /* best-effort */ }
    safeUnlink(TMP_DB);
  });

  // -------------------------------------------------------------------------
  // 1. The cardinal property — no cross-user leak.
  // -------------------------------------------------------------------------

  test('getExistingMasterToken(usr_x) returns NULL when only an owner-owned master token exists', () => {
    const result = dbModule.getExistingMasterToken(REAL_USER_ID);
    expect(result).toBeNull();
  });

  test('getExistingMasterToken(usr_x) NEVER returns a token owned by a different user', () => {
    // Create a master token explicitly owned by OTHER_USER_ID and a
    // (separate) one for REAL_USER_ID. Looking up REAL_USER_ID must
    // return REAL's token, and looking up OTHER_USER_ID must return
    // OTHER's — never the legacy 'owner' token, never each other's.
    const prev = process.env.INIT_DB_OWNER_ID;
    process.env.INIT_DB_OWNER_ID = REAL_USER_ID;
    try {
      const r = seedMasterToken({ force: true });
      expect(r.created).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.INIT_DB_OWNER_ID;
      else process.env.INIT_DB_OWNER_ID = prev;
    }

    process.env.INIT_DB_OWNER_ID = OTHER_USER_ID;
    try {
      const r = seedMasterToken({ force: true });
      expect(r.created).toBe(true);
    } finally {
      delete process.env.INIT_DB_OWNER_ID;
    }

    const realLookup = dbModule.getExistingMasterToken(REAL_USER_ID);
    const otherLookup = dbModule.getExistingMasterToken(OTHER_USER_ID);

    expect(realLookup).not.toBeNull();
    expect(otherLookup).not.toBeNull();

    // The DB row each lookup returned must be owned by the user we
    // asked about — NOT the legacy 'owner', NOT the other user.
    const realRow = dbModule.db
      .prepare('SELECT owner_id FROM access_tokens WHERE id = ?')
      .get(realLookup.tokenId);
    const otherRow = dbModule.db
      .prepare('SELECT owner_id FROM access_tokens WHERE id = ?')
      .get(otherLookup.tokenId);

    expect(realRow.owner_id).toBe(REAL_USER_ID);
    expect(otherRow.owner_id).toBe(OTHER_USER_ID);
    expect(realLookup.tokenId).not.toBe(otherLookup.tokenId);
  });

  // -------------------------------------------------------------------------
  // 2. Headless-install path (legacy 'owner') still works.
  // -------------------------------------------------------------------------

  test("getExistingMasterToken('owner') still resolves the seeded headless-install token", () => {
    const result = dbModule.getExistingMasterToken('owner');
    expect(result).not.toBeNull();
    const row = dbModule.db
      .prepare('SELECT owner_id FROM access_tokens WHERE id = ?')
      .get(result.tokenId);
    expect(row.owner_id).toBe('owner');
  });

  // -------------------------------------------------------------------------
  // 3. Static ratchet — the legacy fallback line MUST NOT come back.
  // -------------------------------------------------------------------------

  test('STATIC GATE: src/database.js does not contain the legacy "owner" fallback in getExistingMasterToken', () => {
    const source = fs.readFileSync(SOURCE_FILE, 'utf8');

    // Locate the function so the assertion is scoped (a helper function
    // that legitimately handles 'owner' elsewhere shouldn't trip us up).
    const fnStart = source.indexOf('function getExistingMasterToken');
    expect(fnStart).toBeGreaterThan(-1);
    // Read enough of the function body to cover the lookup loop.
    const fnSlice = source.slice(fnStart, fnStart + 1500);

    // The cardinal banned pattern: silently appending the legacy 'owner'
    // identity to the lookup list when the caller asked about a different
    // user. ANY reintroduction of this fallback would re-open the
    // cross-user-leak bug above.
    expect(fnSlice).not.toMatch(/ownerIds\.push\(\s*['"]owner['"]\s*\)/);
    expect(fnSlice).not.toMatch(/if\s*\(\s*ownerId\s*!==\s*['"]owner['"]\s*\)/);
  });
});
