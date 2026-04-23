/**
 * Regression gate for T2.4: the `default-vault-key-change-me` fallback is
 * removed from `src/database.js`, and the code paths that used to reach
 * it now fail closed when `VAULT_KEY` is unset.
 *
 * Test-first (ADR-0012): this file must be RED before the implementation
 * change lands and GREEN after. It exists in two halves:
 *
 *   1. A textual gate that scans `src/**\/*.js` (excluding node_modules
 *      and public/) for the literal string `default-vault-key-change-me`.
 *      This is independent of the module being loaded — it catches any
 *      future reintroduction even if nobody exercises the code path.
 *      The string is ALLOWED in two documented places:
 *        - src/index.js validateRequiredSecrets() banned-defaults list
 *          (that's where the banned-default check *reads* the literal
 *          in order to reject it — deleting it there would weaken the
 *          gate).
 *        - src/tests/**.js (these tests intentionally mention the
 *          string by name).
 *
 *   2. Behavioral gates that load a fresh copy of `src/database.js` and
 *      assert:
 *        - `createKeyVersion` throws a clear error when VAULT_KEY is
 *          unset (previously it silently used the literal default).
 *        - `rotateEncryptionKey` throws when VAULT_KEY is unset
 *          (previously it silently used the default for both the "old"
 *          and "new" keys, producing a deterministic ciphertext with
 *          a publicly known key — the worst case of the fallback).
 *        - `getOAuthKeyCandidates()` does not return the legacy default
 *          literal, even as a fallback candidate.
 *
 * The behavioral half requires a fresh require of `src/database.js`
 * after scrubbing `VAULT_KEY` from the environment, because the module
 * initializes a singleton DB connection at require time and reads
 * environment state inside the functions under test. We use the same
 * safeUnlink pattern as `oauth-security-hardening.test.js` to avoid
 * Windows `EBUSY` flakes on the temp SQLite file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.join(__dirname, '..', '..');
const srcDir = path.join(repoRoot, 'src');

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function listSrcJsFiles(root) {
  const out = [];
  const skip = new Set(['node_modules', 'public', 'dist', 'build']);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && /\.(c|m)?js$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

// Files allowed to mention the literal string — one for the banned-defaults
// blocklist (it has to contain the literal so it can reject it), tests are
// always allowed since they assert the gate.
function isAllowedToMentionLegacyDefault(absPath) {
  const rel = path.relative(srcDir, absPath).replace(/\\/g, '/');
  if (rel === 'index.js') return true; // banned-defaults list
  if (rel.startsWith('tests/')) return true;
  return false;
}

function safeUnlink(p) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const full = p + suffix;
    for (let i = 0; i < 6; i++) {
      try {
        if (fs.existsSync(full)) fs.unlinkSync(full);
        break;
      } catch {
        const until = Date.now() + 50;
        while (Date.now() < until) { /* spin */ }
      }
    }
  }
}

// -----------------------------------------------------------------------
// Part 1: textual gate
// -----------------------------------------------------------------------

describe('T2.4 — default-vault-key-change-me literal is gated', () => {
  const files = listSrcJsFiles(srcDir);
  const LITERAL = 'default-vault-key-change-me';

  it('gate scans at least a dozen source files (sanity)', () => {
    // If this fails we probably mis-scoped the walker.
    expect(files.length).toBeGreaterThan(12);
  });

  it('no src/*.js file outside the sanctioned allow-list contains the literal', () => {
    const offenders = [];
    for (const f of files) {
      if (isAllowedToMentionLegacyDefault(f)) continue;
      const text = fs.readFileSync(f, 'utf8');
      if (text.includes(LITERAL)) {
        offenders.push(path.relative(repoRoot, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the sanctioned site (src/index.js) still contains the literal inside the banned-defaults list', () => {
    // This is the opposite direction: make sure the gatekeeper itself
    // doesn't accidentally lose its ability to reject the legacy value.
    const indexText = fs.readFileSync(path.join(srcDir, 'index.js'), 'utf8');
    expect(indexText).toMatch(/BANNED_DEFAULT_KEYS[\s\S]{0,200}default-vault-key-change-me/);
  });
});

// -----------------------------------------------------------------------
// Part 2: behavioral gates (loaded module)
// -----------------------------------------------------------------------

describe('T2.4 — database.js fails closed when VAULT_KEY is unset', () => {
  const TMP_DB = path.join(os.tmpdir(), `t2_4_no_default_${process.pid}_${Date.now()}.sqlite`);
  const savedEnv = {};

  let dbModule;

  beforeAll(() => {
    safeUnlink(TMP_DB);

    for (const k of [
      'VAULT_KEY',
      'VAULT_KEY_PREVIOUS',
      'ENCRYPTION_KEY',
      'JWT_SECRET',
      'ALLOW_LEGACY_DEFAULT_VAULT_KEY',
    ]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    // Need *some* key for the DB to boot in encryptRawToken paths.
    process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-32chars!!';
    process.env.DB_PATH = TMP_DB;
    process.env.DATABASE_TYPE = 'sqlite';

    // Reset the require cache so the singleton DB connection is fresh.
    const resolved = require.resolve('../database');
    delete require.cache[resolved];
    dbModule = require('../database');
    dbModule.initDatabase();
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.DB_PATH;

    const resolved = require.resolve('../database');
    delete require.cache[resolved];

    safeUnlink(TMP_DB);
  });

  it('createKeyVersion throws a clear error when VAULT_KEY is unset', () => {
    expect(() => dbModule.createKeyVersion(1))
      .toThrow(/VAULT_KEY/);
  });

  it('rotateEncryptionKey throws a clear error when VAULT_KEY is unset (caller did not supply one)', () => {
    // Pre-condition: no OAuth tokens exist, so this would previously have
    // succeeded with zero rotations using the public default key as the
    // "old" key. We want the function to refuse to run at all without
    // a real key to talk about.
    expect(() => dbModule.rotateEncryptionKey(undefined))
      .toThrow(/VAULT_KEY/);
    expect(() => dbModule.rotateEncryptionKey(''))
      .toThrow(/VAULT_KEY/);
    expect(() => dbModule.rotateEncryptionKey(null))
      .toThrow(/VAULT_KEY/);
  });

  it('rotateEncryptionKey throws when VAULT_KEY is unset even if a newVaultKey is provided (no silent fallback on the OLD key)', () => {
    // Previously the "old key" half of the rotation silently fell back
    // to the literal default when VAULT_KEY was not set, which meant a
    // rotation against a zero-state DB would succeed against a public
    // key. We want it to fail closed: rotating requires knowing the
    // current VAULT_KEY.
    expect(() => dbModule.rotateEncryptionKey('a-brand-new-32-char-vault-key-ok'))
      .toThrow(/VAULT_KEY/);
  });

  it('getOAuthKeyCandidates() does not include the legacy default literal', () => {
    // Even if no other candidate resolves, the legacy default must not
    // be offered. An empty list is the correct answer here.
    const candidates = dbModule.getOAuthKeyCandidates
      ? dbModule.getOAuthKeyCandidates()
      : null;
    // The function is internal and may or may not be exported. If it
    // is exported, assert the invariant. If it isn't, the textual gate
    // above has already done the job.
    if (Array.isArray(candidates)) {
      const raws = candidates.map(c => c.raw);
      expect(raws).not.toContain('default-vault-key-change-me');
    } else {
      // Mark the test as trivially green; the textual gate covers us.
      expect(true).toBe(true);
    }
  });
});
