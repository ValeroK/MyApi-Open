/**
 * M3 Step 2 / T3.1 — `oauth_state_tokens` schema gate.
 *
 * Locks the post-migration shape of the table so no future edit can
 * silently drop a column, weaken a constraint, or forget an index that
 * the domain module (Step 3) and the authorize / callback handlers
 * (Steps 4 + 5) depend on.
 *
 * Column naming deviates slightly from ADR-0006 §Schema to stay
 * consistent with the pre-existing columns in this table and the rest
 * of the repo:
 *
 *   ADR-0006 § Schema       |  This repo (column actually in SQLite)
 *   -----------------------  +  -----------------------------------
 *   `state`       TEXT PK    →  `state_token`   TEXT NOT NULL UNIQUE
 *                                (existing `id TEXT PRIMARY KEY`
 *                                 is retained as surrogate PK)
 *   `service`     TEXT       →  `service_name`  TEXT NOT NULL
 *   `user_id`     INTEGER    →  `user_id`       TEXT NULL
 *                                (`users.id` is TEXT in this repo —
 *                                 see src/database.js:213)
 *   `created_at`  INTEGER ms →  `created_at`    TEXT NOT NULL
 *                                (ISO-8601 strings, consistent with
 *                                 every other timestamp column)
 *   `expires_at`  INTEGER ms →  `expires_at`    TEXT NOT NULL
 *   `used_at`     INTEGER ms →  `used_at`       TEXT NULL
 *
 * The domain module `src/domain/oauth/state.js` (Step 3) maps between
 * these names and the ADR-0006 field names at its API boundary, so
 * callers see the ADR-0006 contract while the DB stays consistent with
 * the rest of the schema.
 *
 * Related:
 *   - ADR-0006 (target design)
 *   - ADR-0014 §Step 2 (execution plan)
 *   - TASKS.md T3.1
 */

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ci';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'test-encryption-key-32chars!!';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-ci';
process.env.VAULT_KEY = process.env.VAULT_KEY || 'test-vault-key-ci-32characters!';
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

describe('[M3 / T3.1] oauth_state_tokens schema', () => {
  let db;

  beforeAll(() => {
    const database = require('../database');
    database.initDatabase();
    db = database.db;
  });

  /** Map column-name → row from PRAGMA table_info. */
  function columnMap() {
    const rows = db.prepare("PRAGMA table_info('oauth_state_tokens')").all();
    const out = Object.create(null);
    for (const r of rows) out[r.name] = r;
    return out;
  }

  /** Return the row from `sqlite_master` for the given index name, or null. */
  function indexSql(name) {
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
      )
      .get(name);
    return row ? row.sql : null;
  }

  test('all ten columns exist with the expected names', () => {
    const cols = columnMap();
    const expected = [
      // Pre-existing columns (unchanged by M3 Step 2).
      'id',
      'state_token',
      'service_name',
      'created_at',
      'expires_at',
      // New in M3 Step 2 / T3.1.
      'user_id',
      'mode',
      'return_to',
      'code_verifier',
      'used_at',
    ];
    for (const name of expected) {
      expect(cols[name]).toBeDefined();
    }
  });

  test('pre-existing columns retain their original shape', () => {
    const cols = columnMap();
    expect(cols.id.type).toMatch(/^TEXT$/i);
    expect(cols.id.pk).toBe(1);
    expect(cols.state_token.type).toMatch(/^TEXT$/i);
    expect(cols.state_token.notnull).toBe(1);
    expect(cols.service_name.type).toMatch(/^TEXT$/i);
    expect(cols.service_name.notnull).toBe(1);
    expect(cols.created_at.type).toMatch(/^TEXT$/i);
    expect(cols.created_at.notnull).toBe(1);
    expect(cols.expires_at.type).toMatch(/^TEXT$/i);
    expect(cols.expires_at.notnull).toBe(1);
  });

  test('new columns have the correct type and nullability', () => {
    const cols = columnMap();
    // user_id: TEXT NULL — logged-in link flows populate this; login flows
    // leave it NULL (ADR-0006 §Schema note: "populated for logged-in link
    // flows"). TEXT because this repo's users.id is TEXT.
    expect(cols.user_id.type).toMatch(/^TEXT$/i);
    expect(cols.user_id.notnull).toBe(0);

    // mode: TEXT NOT NULL — one of "login" / "link" / "install"
    // (the domain module validates at write-time; SQLite keeps it loose).
    expect(cols.mode.type).toMatch(/^TEXT$/i);
    expect(cols.mode.notnull).toBe(1);

    // return_to: TEXT NULL — post-callback redirect target; the redirect-
    // safety guard in src/lib/redirect-safety.js is enforced at the edge,
    // not at the DB layer.
    expect(cols.return_to.type).toMatch(/^TEXT$/i);
    expect(cols.return_to.notnull).toBe(0);

    // code_verifier: TEXT NOT NULL — random crypto.randomBytes(32)
    // base64url; stored at issue time so the callback can perform the
    // PKCE S256 exchange without re-deriving from SESSION_SECRET.
    expect(cols.code_verifier.type).toMatch(/^TEXT$/i);
    expect(cols.code_verifier.notnull).toBe(1);

    // used_at: TEXT NULL — set inside the same transaction that consumes
    // the row; second-use yields STATE_REUSED.
    expect(cols.used_at.type).toMatch(/^TEXT$/i);
    expect(cols.used_at.notnull).toBe(0);
  });

  test('state_token preserves its UNIQUE constraint', () => {
    // A row is insertable once; inserting a second row with the same
    // state_token raises SQLITE_CONSTRAINT_UNIQUE.
    const now = new Date().toISOString();
    const soon = new Date(Date.now() + 600_000).toISOString();
    const insert = db.prepare(
      `INSERT INTO oauth_state_tokens
         (id, state_token, service_name, mode, code_verifier,
          created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const state = 'schema-test-uniqueness-' + Math.random().toString(36).slice(2);
    insert.run('id-1', state, 'google', 'login', 'verifier-1', now, soon);
    expect(() =>
      insert.run('id-2', state, 'google', 'login', 'verifier-2', now, soon)
    ).toThrow(/UNIQUE/i);
  });

  test('idx_oauth_state_tokens_state covers state_token lookups', () => {
    // Name is set when the index is created; the legacy code created it as
    // `idx_oauth_state_tokens_state` (note: suffix is `state`, not
    // `state_token`). We keep the legacy name to avoid rewriting it.
    const sql = indexSql('idx_oauth_state_tokens_state');
    expect(sql).not.toBeNull();
    expect(sql).toMatch(/state_token/);
  });

  test('idx_oauth_state_tokens_expires exists for the prune scan', () => {
    // The background pruner (M3 Step 8 / T3.9) scans by expires_at; this
    // index keeps the scan cheap even once the table grows.
    const sql = indexSql('idx_oauth_state_tokens_expires');
    expect(sql).not.toBeNull();
    expect(sql).toMatch(/expires_at/);
  });

  test('idx_oauth_state_tokens_used supports replay checks / prune', () => {
    // The callback handler (M3 Step 5) rejects rows where used_at IS NOT
    // NULL; the pruner (Step 8) ages used rows out after the grace
    // window. The partial index is a nice-to-have; the test accepts
    // either a full or partial index as long as it targets used_at.
    const sql = indexSql('idx_oauth_state_tokens_used');
    expect(sql).not.toBeNull();
    expect(sql).toMatch(/used_at/);
  });

  test('existing row insert + select round-trips through the new columns', () => {
    const now = new Date().toISOString();
    const soon = new Date(Date.now() + 600_000).toISOString();
    const state = 'roundtrip-' + Math.random().toString(36).slice(2);
    db.prepare(
      `INSERT INTO oauth_state_tokens
         (id, state_token, service_name, user_id, mode, return_to,
          code_verifier, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      'rt-id',
      state,
      'github',
      'user-abc',
      'link',
      '/dashboard/',
      'vfy-' + 'x'.repeat(39),
      now,
      soon
    );
    const row = db
      .prepare('SELECT * FROM oauth_state_tokens WHERE state_token = ?')
      .get(state);
    expect(row).toMatchObject({
      id: 'rt-id',
      state_token: state,
      service_name: 'github',
      user_id: 'user-abc',
      mode: 'link',
      return_to: '/dashboard/',
      created_at: now,
      expires_at: soon,
      used_at: null,
    });
    expect(row.code_verifier).toHaveLength(43);
    expect(row.code_verifier.startsWith('vfy-')).toBe(true);
  });
});
