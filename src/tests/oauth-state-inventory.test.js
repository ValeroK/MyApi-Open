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

  // Each of the following assertions was filed in its "today / missing"
  // form in M3 Step 1 and FLIPPED in Step 2 / T3.1 once the additive
  // migration landed. If any of these columns ever goes missing again
  // (someone drops them via a bad migration), this test catches it at
  // the next `npm test`.
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
    'column %p is PRESENT (flipped from missing in Step 2 / T3.1)  —  %s',
    (colName /* , rationale */) => {
      const cols = columnNames();
      expect(cols.includes(colName)).toBe(true);
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

  // Flipped in Step 5 / T3.5: the deterministic PKCE verifier helper
  // is deleted outright. Its only remaining call-site (the callback)
  // is rewired to read `code_verifier` from the consumed state row,
  // so neither the declaration nor any invocation may remain.
  test('buildPkcePairFromState is NOT defined (flipped in Step 5 / T3.5)', () => {
    expect(source).not.toMatch(/\bbuildPkcePairFromState\b/);
  });

  // Flipped in Step 5 / T3.5: removing the helper also removes its
  // deterministic `HMAC(SESSION_SECRET, "pkce:" + state)` body — the
  // exact line that made PKCE non-compliant (plan.md §6.3 H1).
  test('deterministic HMAC verifier literal is NOT present (flipped in Step 5 / T3.5)', () => {
    expect(source).not.toMatch(/createHmac\s*\(\s*['"]sha256['"]\s*,\s*secret\s*\)\s*\.update\s*\(\s*`pkce:\$\{state\}`\s*\)/);
  });

  // Flipped in Step 5 / T3.5 (together with Step 4 / T3.4): every
  // authorize-write, callback-read, callback-delete, and logout-wipe
  // of `req.session.oauthStateMeta` is gone. The DB row in
  // `oauth_state_tokens` is the sole source of truth.
  test('req.session.oauthStateMeta is NO LONGER referenced anywhere (flipped in Step 5 / T3.5)', () => {
    const hits = source.match(/\boauthStateMeta\b/g) || [];
    expect(hits.length).toBe(0);
  });

  // Flipped in Step 5 / T3.6: the Discord bot-install carve-out
  // (`service === 'discord' && !state && req.query.guild_id`) is
  // deleted. Discord now goes through the same state-row path as
  // every other provider. Closes C6.
  test('Discord state bypass is NOT present (flipped in Step 5 / T3.6)', () => {
    expect(source).not.toMatch(/\bisDiscordBotInstall\b/);
  });
});

// -------------------------------------------------------------------------
// 3. Domain module is NOT yet present (flips in Step 3)
// -------------------------------------------------------------------------

describe('[M3 / Step 3] src/domain/oauth/state.js is the single entry point (T3.2 + T3.3)', () => {
  test('domain module exists (flipped from absent in Step 3 / T3.2)', () => {
    const target = path.join(srcDir, 'domain', 'oauth', 'state.js');
    expect(fs.existsSync(target)).toBe(true);
  });

  test('domain module exports the ADR-0006 surface', () => {
    const mod = require('../domain/oauth/state');
    expect(typeof mod.createStateToken).toBe('function');
    expect(typeof mod.consumeStateToken).toBe('function');
    expect(typeof mod.pruneExpiredStateTokens).toBe('function');
  });
});

// -------------------------------------------------------------------------
// 4. M3 Step 6 / T3.7 gates — confirm-screen gesture + row-as-SSOT
// -------------------------------------------------------------------------
//
// These gates encode the invariants established by the M3 Step 6 refactor:
//
//   a. The server no longer stashes pending-login metadata on
//      `req.session.oauth_confirm` or `req.session.oauth_login_pending`.
//      The `oauth_pending_logins` DB row is the single source of truth
//      (closes the C3 session-fixation variant — see ADR-0014 §Step 6).
//
//   b. A dedicated domain module (`src/domain/oauth/pending-confirm.js`)
//      owns the lifecycle. Handlers MUST NOT hand-roll SQL against the
//      `oauth_pending_logins` table.
//
//   c. The SPA landing page (`App.jsx`) does NOT auto-POST the confirm
//      token — the user-facing gesture screen in `pages/LogIn.jsx` is
//      the only path that can set `req.session.user` post-OAuth.
//
//   d. Schema carries the two audit columns (`used_at`, `outcome`) on
//      `oauth_pending_logins` and the first-seen keying columns
//      (`provider_subject`, `first_confirmed_at`) on `oauth_tokens`.

describe('[M3 / Step 6] confirm-screen gesture + row-as-SSOT (T3.7)', () => {
  let source;
  beforeAll(() => {
    source = fs.readFileSync(SERVER_ENTRY, 'utf8');
  });

  test('req.session.oauth_confirm is NO LONGER referenced (flipped in Step 6 / T3.7)', () => {
    // We permit the literal string inside comments only. The filter
    // below strips /* ... */ and // ... lines before grepping.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/\bsession\.oauth_confirm\b/);
  });

  test('req.session.oauth_login_pending is NO LONGER referenced (flipped in Step 6 / T3.7)', () => {
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/\bsession\.oauth_login_pending\b/);
  });

  test('pending-confirm domain module exists and exports the T3.7 surface', () => {
    const target = path.join(srcDir, 'domain', 'oauth', 'pending-confirm.js');
    expect(fs.existsSync(target)).toBe(true);
    const mod = require('../domain/oauth/pending-confirm');
    expect(typeof mod.createPendingConfirm).toBe('function');
    expect(typeof mod.previewPendingConfirm).toBe('function');
    expect(typeof mod.consumePendingConfirm).toBe('function');
    expect(typeof mod.hasConfirmedBefore).toBe('function');
    expect(typeof mod.recordFirstConfirmation).toBe('function');
    expect(typeof mod.pruneExpiredPendingConfirms).toBe('function');
  });

  test('App.jsx does NOT auto-POST /api/v1/oauth/confirm (flipped in Step 6 / T3.7)', () => {
    const appJsx = path.resolve(
      srcDir,
      'public',
      'dashboard-app',
      'src',
      'App.jsx'
    );
    expect(fs.existsSync(appJsx)).toBe(true);
    const src = fs.readFileSync(appJsx, 'utf8');
    // Strip comments so the prose explaining the deletion doesn't
    // re-trigger the gate.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // Any executable `fetch('/api/v1/oauth/confirm'`  (with or without
    // /preview or /reject) would fail — only LogIn.jsx is allowed to
    // call the accept endpoint, and only after a user gesture.
    expect(stripped).not.toMatch(/fetch\s*\(\s*['"`]\/api\/v1\/oauth\/confirm['"`]/);
  });

  test('duplicate src/public/dashboard-app/src/pages/Login.jsx is REMOVED (flipped in Step 6 / T3.7)', () => {
    // NOTE: `fs.existsSync` cannot be trusted here — on Windows hosts the
    // NTFS filesystem is case-insensitive and a Docker bind-mount faithfully
    // inherits that behaviour, so `existsSync('Login.jsx')` returns `true`
    // even when only `LogIn.jsx` is on disk. We instead list the directory
    // and compare names byte-exactly, which matches how git + the build
    // pipeline see the repo.
    const pagesDir = path.resolve(
      srcDir,
      'public',
      'dashboard-app',
      'src',
      'pages'
    );
    const names = fs.readdirSync(pagesDir);
    expect(names).toContain('LogIn.jsx');
    expect(names).not.toContain('Login.jsx');
  });
});

describe('[M3 / Step 6] oauth_pending_logins + oauth_tokens schema (T3.7)', () => {
  let db;
  beforeAll(() => {
    const database = require('../database');
    database.initDatabase();
    db = database.db;
  });

  function columnNames(table) {
    const rows = db.prepare(`PRAGMA table_info('${table}')`).all();
    return rows.map((r) => r.name);
  }

  test.each([
    ['oauth_pending_logins', 'used_at'],
    ['oauth_pending_logins', 'outcome'],
    ['oauth_tokens', 'provider_subject'],
    ['oauth_tokens', 'first_confirmed_at'],
  ])('%s.%s column exists (Step 6 / T3.7)', (table, col) => {
    expect(columnNames(table).includes(col)).toBe(true);
  });
});
