/**
 * Tests for the rewritten seed script `src/scripts/init-db.js`.
 *
 * The script provisions an initial master access token against the real
 * `access_tokens` table in `src/database.js` (not the orphan `tokens` table
 * that the old `TokenManager` wrote to). Refer to ADR-0013 for the M2
 * re-scoping that led to this rewrite.
 *
 * Contract exercised here:
 *   - On a fresh DB, `seedMasterToken()` creates a row in `access_tokens`
 *     with `scope='full'`, `token_type='master'`, `owner_id='owner'` (by
 *     default), `revoked_at=NULL`, and returns the raw token only once.
 *   - On a DB that already has an active master token for the same owner,
 *     re-running the script is a no-op (idempotent seed).
 *   - Passing `{ force: true }` creates an additional master token even if
 *     one exists, for rotation / multi-seat scenarios.
 *   - The raw token returned validates via `bcrypt.compare` against the
 *     stored `hash`, matching the server's authentication path.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

// Set DB_PATH to a dedicated tmp file BEFORE requiring anything that loads
// src/database.js. src/database.js connects at module-load time via the
// db-abstraction layer, so the env var has to be in place first.
const TMP_DB = path.join(__dirname, 'tmp-init-db-seed.sqlite');

function safeUnlink(p) {
  for (const target of [p, `${p}-wal`, `${p}-shm`]) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        break;
      } catch (err) {
        if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
          // Windows holds the SQLite file briefly after close; retry.
          const waitMs = 100;
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline) { /* spin */ }
          continue;
        }
        if (err && err.code === 'ENOENT') break;
        throw err;
      }
    }
  }
}

describe('init-db seed script', () => {
  let dbModule;
  let seedMasterToken;

  beforeAll(() => {
    safeUnlink(TMP_DB);
    process.env.DB_PATH = TMP_DB;
    process.env.DATABASE_TYPE = 'sqlite';
    // Needed because encryptRawToken falls back to ENCRYPTION_KEY when
    // VAULT_KEY isn't set (see master-token-persistence.test.js).
    process.env.ENCRYPTION_KEY =
      process.env.ENCRYPTION_KEY || 'test-encryption-key-must-be-32chars!';

    dbModule = require('../database');
    dbModule.initDatabase();
    ({ seedMasterToken } = require('../scripts/init-db'));
  });

  afterAll(() => {
    try {
      dbModule.db.close();
    } catch {
      // best-effort
    }
    safeUnlink(TMP_DB);
  });

  describe('fresh database', () => {
    it('creates a master access token and returns the raw token once', () => {
      const result = seedMasterToken();
      expect(result).toMatchObject({ created: true, reason: 'created' });
      expect(result.tokenId).toMatch(/^tok_[0-9a-f]{32}$/);
      expect(result.rawToken).toMatch(/^myapi_[0-9a-f]{64}$/);
    });

    it('writes the token to access_tokens with full scope and master type', () => {
      const rows = dbModule.db
        .prepare(
          "SELECT id, owner_id, scope, token_type, revoked_at FROM access_tokens WHERE token_type = 'master' AND scope = 'full' AND revoked_at IS NULL",
        )
        .all();
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const row = rows[0];
      expect(row.owner_id).toBe('owner');
      expect(row.scope).toBe('full');
      expect(row.token_type).toBe('master');
      expect(row.revoked_at).toBeNull();
    });
  });

  describe('idempotency', () => {
    it('refuses to re-seed when an active master token already exists', () => {
      const result = seedMasterToken();
      expect(result.created).toBe(false);
      expect(result.reason).toBe('existing_master_token');
      expect(typeof result.tokenId).toBe('string');
      expect(result.rawToken).toBeUndefined();
    });

    it('does not create a duplicate row on the no-op path', () => {
      const countBefore = dbModule.db
        .prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE token_type = 'master' AND revoked_at IS NULL")
        .get().n;
      seedMasterToken();
      const countAfter = dbModule.db
        .prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE token_type = 'master' AND revoked_at IS NULL")
        .get().n;
      expect(countAfter).toBe(countBefore);
    });
  });

  describe('--force', () => {
    it('creates an additional master token even when one already exists', () => {
      const countBefore = dbModule.db
        .prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE token_type = 'master' AND revoked_at IS NULL")
        .get().n;
      const result = seedMasterToken({ force: true });
      expect(result.created).toBe(true);
      expect(result.rawToken).toMatch(/^myapi_[0-9a-f]{64}$/);
      const countAfter = dbModule.db
        .prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE token_type = 'master' AND revoked_at IS NULL")
        .get().n;
      expect(countAfter).toBe(countBefore + 1);
    });
  });

  describe('authentication round-trip', () => {
    it('the raw token validates against the stored bcrypt hash', async () => {
      const result = seedMasterToken({ force: true });
      expect(result.created).toBe(true);
      const row = dbModule.db
        .prepare('SELECT hash FROM access_tokens WHERE id = ?')
        .get(result.tokenId);
      expect(row).toBeDefined();
      expect(typeof row.hash).toBe('string');
      expect(row.hash.startsWith('$2')).toBe(true); // bcrypt prefix ($2a/$2b)
      const ok = await bcrypt.compare(result.rawToken, row.hash);
      expect(ok).toBe(true);
    });

    it('a bogus token does not validate against the stored hash', async () => {
      const result = seedMasterToken({ force: true });
      expect(result.created).toBe(true);
      const row = dbModule.db
        .prepare('SELECT hash FROM access_tokens WHERE id = ?')
        .get(result.tokenId);
      const ok = await bcrypt.compare('myapi_wrong', row.hash);
      expect(ok).toBe(false);
    });
  });

  describe('custom ownerId via env', () => {
    it('honors INIT_DB_OWNER_ID when set', () => {
      const prev = process.env.INIT_DB_OWNER_ID;
      process.env.INIT_DB_OWNER_ID = 'custom-owner-uid';
      try {
        const result = seedMasterToken({ force: true });
        expect(result.created).toBe(true);
        const row = dbModule.db
          .prepare('SELECT owner_id FROM access_tokens WHERE id = ?')
          .get(result.tokenId);
        expect(row.owner_id).toBe('custom-owner-uid');
      } finally {
        if (prev === undefined) delete process.env.INIT_DB_OWNER_ID;
        else process.env.INIT_DB_OWNER_ID = prev;
      }
    });
  });
});
