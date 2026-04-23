/**
 * M3 inventory / regression gate for OAuth state + PKCE hardening.
 *
 * Purpose
 * -------
 * Encode the four broken-today facts that M3 (ADR-0006, ADR-0014) is about
 * to fix, so that each subsequent step's refactor cannot silently skip one.
 * Each assertion is labelled with the **step in ADR-0014** that will flip
 * it; the companion "flip-side" assertion is added in that step's commit
 * in the same red-first style we used for M2 Step 2 (`legacy-vault-inventory`).
 *
 * Today's broken facts (will be flipped by M3 Steps 2, 4, 5):
 *   1. `oauth_state_tokens` has only 5 columns and is missing the 5 ADR-0006
 *      columns (`user_id`, `mode`, `return_to`, `code_verifier`, `used_at`).
 *      → Step 2 (T3.1) adds the columns; this test's `expect(...).toBe(false)`
 *      assertions flip to `toBe(true)`.
 *   2. `src/index.js` contains the literal `buildPkcePairFromState` — the
 *      deterministic PKCE-verifier function that defeats the PKCE threat
 *      model (H1).
 *      → Step 4 (T3.4) deletes the call-site; Step 5 (T3.5) deletes the
 *      function. Both textual gates flip to "not present".
 *   3. `src/index.js` contains the literal `oauthStateMeta` — the in-memory
 *      session map that replaces the DB row as the source of truth.
 *      → Steps 4 + 5 delete every read + write.
 *   4. `src/index.js` contains the literal `isDiscordBotInstall` — the
 *      Discord bot-install state-validation bypass (C6 in plan.md §6.3).
 *      → Step 5 (T3.6) deletes the carve-out.
 *
 * Why textual and not behavioural for (2)–(4)?
 * The broken primitives (`buildPkcePairFromState`, `oauthStateMeta`,
 * `isDiscordBotInstall`) are declared at module scope inside the monolith
 * `src/index.js` and are NOT exported. Booting the full server just to
 * reflect on private symbols is a poor cost / signal tradeoff. Textual
 * gates keyed on unique identifier names are precise (no false positives
 * in this codebase — grep-verified when this file was written) and survive
 * the deletion step naturally.
 *
 * Related:
 *   - ADR-0006 (target design: DB-backed single-use state rows + random PKCE)
 *   - ADR-0014 (M3 execution playbook)
 *   - plan.md §6.3 (critical findings C3 + C6, high finding H1)
 *   - TASKS.md M3 (T3.0..T3.9)
 */

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ci';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'test-encryption-key-32chars!!';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-ci';
process.env.VAULT_KEY = process.env.VAULT_KEY || 'test-vault-key-ci-32characters!';
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const fs = require('fs');
const path = require('path');

const srcDir = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(srcDir, 'index.js');

// -------------------------------------------------------------------------
// 1. Schema-shape gate (flips in Step 2 / T3.1)
// -------------------------------------------------------------------------

describe('[M3 / Step 2] oauth_state_tokens schema gap (T3.1)', () => {
  let db;

  beforeAll(() => {
    // Lazy require so DB_PATH=:memory: is honoured.
    const database = require('../database');
    database.initDatabase();
    db = database.db;
  });

  function columnNames() {
    const rows = db.prepare("PRAGMA table_info('oauth_state_tokens')").all();
    return rows.map((r) => r.name);
  }

  test('legacy columns are present today (baseline)', () => {
    const cols = columnNames();
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'state_token',
        'service_name',
        'created_at',
        'expires_at',
      ])
    );
  });

  // Each of the following assertions is written in the **today-form** (the
  // column is missing). Step 2 adds the column and the assertion flips from
  // `toBe(false)` to `toBe(true)`.
  test.each([
    ['user_id', 'populated for logged-in link flows (ADR-0006 §Schema)'],
    ['mode', '"login" / "link" / "install" (ADR-0006 §Schema)'],
    ['return_to', 'post-callback redirect target (ADR-0006 §Schema)'],
    [
      'code_verifier',
      'random crypto.randomBytes(32) base64url — closes H1 (ADR-0006 §Schema)',
    ],
    [
      'used_at',
      'set on first callback match; replay rejection (ADR-0006 §Schema)',
    ],
  ])(
    'column %p is MISSING today (flips to present in Step 2 / T3.1)  —  %s',
    (colName /* , rationale */) => {
      const cols = columnNames();
      // TODO(M3 Step 2 / T3.1): flip `toBe(false)` → `toBe(true)` once the
      // migration runs.
      expect(cols.includes(colName)).toBe(false);
    }
  );
});

// -------------------------------------------------------------------------
// 2. Textual gates on src/index.js (flip in Steps 4 + 5)
// -------------------------------------------------------------------------

describe('[M3 / Steps 4–5] legacy OAuth-state primitives still live in src/index.js', () => {
  let source;
  beforeAll(() => {
    source = fs.readFileSync(SERVER_ENTRY, 'utf8');
  });

  test('source file is present and non-trivial', () => {
    expect(source.length).toBeGreaterThan(10_000);
  });

  // Step 4 / T3.4 removes the call-site of `buildPkcePairFromState`; Step 5
  // / T3.5 deletes the function declaration itself. Both flip this
  // assertion to "not present".
  test('buildPkcePairFromState is defined today (flips to absent in Step 5 / T3.5)', () => {
    expect(source).toMatch(/\bfunction\s+buildPkcePairFromState\s*\(/);
    // TODO(M3 Step 5 / T3.5): flip to `expect(source).not.toMatch(...)` once
    // the function is deleted.
  });

  test('deterministic HMAC verifier literal is present today (flips in Step 5 / T3.5)', () => {
    // This is the line that makes the current PKCE non-compliant: the
    // verifier is derived from `HMAC(SESSION_SECRET, "pkce:" + state)`
    // rather than being a per-request random value. Closes H1 when removed.
    expect(source).toMatch(/createHmac\s*\(\s*['"]sha256['"]\s*,\s*secret\s*\)\s*\.update\s*\(\s*`pkce:\$\{state\}`\s*\)/);
    // TODO(M3 Step 5 / T3.5): flip to `.not.toMatch(...)`.
  });

  // Step 4 / T3.4 replaces the in-memory session map with the DB row.
  // Every `req.session.oauthStateMeta` read and write is deleted.
  test('req.session.oauthStateMeta is referenced today (flips to absent in Steps 4–5)', () => {
    const hits = source.match(/\boauthStateMeta\b/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(4);
    // TODO(M3 Step 5 / T3.5 — after authorize AND callback are rewritten):
    // flip to `expect(hits.length).toBe(0)`.
  });

  // Step 5 / T3.6 removes the Discord bot-install carve-out entirely;
  // Discord uses the same state-row path as every other provider.
  test('Discord state bypass is present today (flips to absent in Step 5 / T3.6)', () => {
    expect(source).toMatch(/\bisDiscordBotInstall\b/);
    // TODO(M3 Step 5 / T3.6): flip to `.not.toMatch(...)`.
  });
});

// -------------------------------------------------------------------------
// 3. Domain module is NOT yet present (flips in Step 3)
// -------------------------------------------------------------------------

describe('[M3 / Step 3] src/domain/oauth/state.js does not exist yet (T3.2 + T3.3)', () => {
  test('domain module is absent today (flips to present in Step 3)', () => {
    const target = path.join(srcDir, 'domain', 'oauth', 'state.js');
    // TODO(M3 Step 3 / T3.2): flip to `expect(fs.existsSync(target)).toBe(true)`.
    expect(fs.existsSync(target)).toBe(false);
  });
});
