/**
 * Regression gate for T2.5: `validateRequiredSecrets` runs on every
 * NODE_ENV, and its banned-defaults check does too.
 *
 * Test-first (ADR-0012): this suite must be red before the extraction
 * + hardening lands and green after.
 *
 * Why an extracted helper:
 *   `src/index.js` boots a full Express server at require time, so we
 *   can't pull its inline function into a unit test. T2.5 therefore
 *   extracts the check into `src/lib/validate-secrets.js`, which is
 *   pure and side-effect-free. The server file keeps the bootstrap
 *   `process.exit(1)` behaviour by reading the result object; this
 *   test file exercises the pure function directly.
 *
 * Contract the test pins:
 *   - signature: validateRequiredSecrets({ env, nodeEnv }?) -> { ok, missing, banned, bannedDefaults }
 *   - `missing` is the list of REQUIRED secrets whose values are empty or whitespace
 *   - `banned`  is the list of secret-name → value pairs whose (trimmed, lower-cased) value
 *                is in the BANNED_DEFAULTS set, computed REGARDLESS of NODE_ENV
 *   - `ok` is true iff `missing` and `banned` are both empty
 *   - the module also exports `BANNED_DEFAULTS` and `REQUIRED_SECRETS` for introspection
 *   - `BANNED_DEFAULTS` is a frozen Set that INCLUDES the known weak literals
 *     (change-me / changeme / secret / password / default-vault-key-change-me)
 *     plus every value that appears in `src/.env.example` placeholders
 *     (your-…-here, your-…-change-in-production) — see §"banned-defaults
 *     blocklist" below.
 *   - `REQUIRED_SECRETS` is a frozen array that includes SESSION_SECRET,
 *     JWT_SECRET, ENCRYPTION_KEY, VAULT_KEY (same set the inline
 *     function used to check).
 */

const path = require('path');

const MODULE_UNDER_TEST = path.join(__dirname, '..', 'lib', 'validate-secrets.js');

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function freshRequire(relOrAbs) {
  const resolved = require.resolve(relOrAbs);
  delete require.cache[resolved];
  return require(relOrAbs);
}

// Good high-entropy values we'll use wherever we need "a legit secret"
// so the missing / banned checks don't fire on our test fixtures.
const GOOD_SECRETS = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef0123',
  JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789',
  ENCRYPTION_KEY: 'test-encryption-key-0123456789abcdef01234',
  VAULT_KEY: 'test-vault-key-0123456789abcdef012345678901',
};

// -----------------------------------------------------------------------
// Module surface
// -----------------------------------------------------------------------

describe('validate-secrets — module surface', () => {
  it('exports validateRequiredSecrets as a function', () => {
    const mod = freshRequire(MODULE_UNDER_TEST);
    expect(typeof mod.validateRequiredSecrets).toBe('function');
  });

  it('exports REQUIRED_SECRETS frozen array including the four historical names', () => {
    const { REQUIRED_SECRETS } = freshRequire(MODULE_UNDER_TEST);
    expect(Array.isArray(REQUIRED_SECRETS)).toBe(true);
    expect(Object.isFrozen(REQUIRED_SECRETS)).toBe(true);
    expect(REQUIRED_SECRETS).toEqual(
      expect.arrayContaining([
        'SESSION_SECRET',
        'JWT_SECRET',
        'ENCRYPTION_KEY',
        'VAULT_KEY',
      ]),
    );
  });

  it('exports BANNED_DEFAULTS as a non-empty frozen Set', () => {
    const { BANNED_DEFAULTS } = freshRequire(MODULE_UNDER_TEST);
    expect(BANNED_DEFAULTS).toBeInstanceOf(Set);
    expect(BANNED_DEFAULTS.size).toBeGreaterThan(5);
    // A frozen wrapper Set still allows .add() in V8, so we assert
    // by behaviour: attempting to add does not extend the set (we
    // expect the helper to either Object.freeze the instance or
    // return an immutable wrapper).
    const before = BANNED_DEFAULTS.size;
    try { BANNED_DEFAULTS.add('newly-banned-value'); } catch { /* ok */ }
    expect(BANNED_DEFAULTS.size).toBe(before);
  });
});

// -----------------------------------------------------------------------
// Banned-defaults blocklist contents (doc-as-test)
// -----------------------------------------------------------------------

describe('validate-secrets — BANNED_DEFAULTS contents', () => {
  it('includes the historical weak-literal set', () => {
    const { BANNED_DEFAULTS } = freshRequire(MODULE_UNDER_TEST);
    for (const v of [
      'default-vault-key-change-me',
      'change-me',
      'changeme',
      'secret',
      'password',
    ]) {
      expect(BANNED_DEFAULTS.has(v)).toBe(true);
    }
  });

  it('includes the placeholder values shipped in src/.env.example', () => {
    const { BANNED_DEFAULTS } = freshRequire(MODULE_UNDER_TEST);
    // These literals appear verbatim in src/.env.example and are the
    // values an operator gets if they cp the example and never edit it.
    // All must be rejected no matter the NODE_ENV.
    for (const v of [
      'your-session-secret-key-here',
      'your-secret-key-here-change-in-production',
      '32-character-encryption-key-here!!',
      'your-vault-key-here-change-in-production',
    ]) {
      expect(BANNED_DEFAULTS.has(v)).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------
// Behaviour: the check runs regardless of NODE_ENV
// -----------------------------------------------------------------------

describe('validate-secrets — runs on every NODE_ENV', () => {
  it('returns ok=true with all four good secrets, under any NODE_ENV', () => {
    const { validateRequiredSecrets } = freshRequire(MODULE_UNDER_TEST);
    for (const nodeEnv of ['production', 'development', 'test', 'staging', undefined]) {
      const result = validateRequiredSecrets({ env: { ...GOOD_SECRETS }, nodeEnv });
      expect(result).toMatchObject({ ok: true, missing: [], banned: [] });
    }
  });

  it('reports MISSING secrets regardless of NODE_ENV', () => {
    const { validateRequiredSecrets } = freshRequire(MODULE_UNDER_TEST);
    const env = { ...GOOD_SECRETS };
    delete env.VAULT_KEY;
    for (const nodeEnv of ['production', 'development', 'test']) {
      const result = validateRequiredSecrets({ env, nodeEnv });
      expect(result.ok).toBe(false);
      expect(result.missing).toContain('VAULT_KEY');
      expect(result.banned).toEqual([]);
    }
  });

  it('treats whitespace-only values as missing', () => {
    const { validateRequiredSecrets } = freshRequire(MODULE_UNDER_TEST);
    const result = validateRequiredSecrets({
      env: { ...GOOD_SECRETS, JWT_SECRET: '   \t\n  ' },
      nodeEnv: 'development',
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('JWT_SECRET');
  });

  it('reports BANNED defaults regardless of NODE_ENV (this is the T2.5 change)', () => {
    const { validateRequiredSecrets } = freshRequire(MODULE_UNDER_TEST);
    const env = { ...GOOD_SECRETS, VAULT_KEY: 'change-me' };
    for (const nodeEnv of ['production', 'development', 'test']) {
      const result = validateRequiredSecrets({ env, nodeEnv });
      expect(result.ok).toBe(false);
      expect(result.banned).toHaveLength(1);
      expect(result.banned[0]).toMatchObject({
        name: 'VAULT_KEY',
        value: 'change-me',
      });
      expect(result.missing).toEqual([]);
    }
  });

  it('banned check is case-insensitive and whitespace-tolerant', () => {
    const { validateRequiredSecrets } = freshRequire(MODULE_UNDER_TEST);
    const result = validateRequiredSecrets({
      env: { ...GOOD_SECRETS, ENCRYPTION_KEY: '  CHANGEME  ' },
      nodeEnv: 'development',
    });
    expect(result.ok).toBe(false);
    expect(result.banned[0]).toMatchObject({ name: 'ENCRYPTION_KEY' });
  });

  it('rejects the .env.example placeholder values under every NODE_ENV', () => {
    const { validateRequiredSecrets } = freshRequire(MODULE_UNDER_TEST);
    const env = {
      ...GOOD_SECRETS,
      VAULT_KEY: 'your-vault-key-here-change-in-production',
    };
    const result = validateRequiredSecrets({ env, nodeEnv: 'test' });
    expect(result.ok).toBe(false);
    expect(result.banned.map(b => b.name)).toContain('VAULT_KEY');
  });

  it('flags multiple problems in a single invocation', () => {
    const { validateRequiredSecrets } = freshRequire(MODULE_UNDER_TEST);
    const env = {
      ...GOOD_SECRETS,
      SESSION_SECRET: '',          // missing
      JWT_SECRET: 'secret',        // banned
      ENCRYPTION_KEY: 'changeme',  // banned
    };
    const result = validateRequiredSecrets({ env, nodeEnv: 'development' });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('SESSION_SECRET');
    expect(result.banned.map(b => b.name).sort()).toEqual(['ENCRYPTION_KEY', 'JWT_SECRET']);
  });
});

// -----------------------------------------------------------------------
// Defaults + env plumbing
// -----------------------------------------------------------------------

describe('validate-secrets — env plumbing', () => {
  it('reads from process.env by default when no env is injected', () => {
    const { validateRequiredSecrets } = freshRequire(MODULE_UNDER_TEST);
    const saved = {};
    try {
      for (const k of Object.keys(GOOD_SECRETS)) {
        saved[k] = process.env[k];
        process.env[k] = GOOD_SECRETS[k];
      }
      const result = validateRequiredSecrets(); // no options at all
      expect(result.ok).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('reads from process.env.NODE_ENV by default', () => {
    const { validateRequiredSecrets } = freshRequire(MODULE_UNDER_TEST);
    const savedEnv = process.env.NODE_ENV;
    const savedSecrets = {};
    try {
      for (const k of Object.keys(GOOD_SECRETS)) {
        savedSecrets[k] = process.env[k];
        process.env[k] = GOOD_SECRETS[k];
      }
      process.env.NODE_ENV = 'production';
      process.env.VAULT_KEY = 'password'; // banned literal
      const result = validateRequiredSecrets(); // no options at all
      expect(result.ok).toBe(false);
      expect(result.banned.map(b => b.name)).toContain('VAULT_KEY');
    } finally {
      process.env.NODE_ENV = savedEnv;
      for (const [k, v] of Object.entries(savedSecrets)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
