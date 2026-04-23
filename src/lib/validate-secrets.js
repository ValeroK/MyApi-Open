/**
 * validate-secrets.js — T2.5 (M2 Step 6).
 *
 * Pure, side-effect-free validator for the four "required secrets" that
 * gate MyApi's crypto paths (SESSION_SECRET, JWT_SECRET, ENCRYPTION_KEY,
 * VAULT_KEY). Called from `src/index.js`'s bootstrap and from the test
 * suite.
 *
 * Contract:
 *
 *   validateRequiredSecrets({ env?, nodeEnv? })
 *     -> { ok: boolean, missing: string[], banned: Array<{name, value}> }
 *
 *   - `env` defaults to `process.env`.
 *   - `nodeEnv` defaults to `env.NODE_ENV`.
 *   - A secret is "missing" if its value is empty or whitespace-only.
 *   - A secret is "banned" if its (trimmed, lower-cased) value appears
 *     in BANNED_DEFAULTS. This check runs on every NODE_ENV — the whole
 *     point of T2.5 is that dev / test / staging deployments get the
 *     same ban-list enforcement as production.
 *   - The function NEVER calls `process.exit()` or logs. The caller
 *     (src/index.js bootstrap) is responsible for turning a non-ok
 *     result into the appropriate fatal / warn / whatever side effect.
 *
 * Exports:
 *   - validateRequiredSecrets
 *   - REQUIRED_SECRETS   (frozen string[])
 *   - BANNED_DEFAULTS    (frozen Set<string>, all lower-case)
 */

'use strict';

const REQUIRED_SECRETS = Object.freeze([
  'SESSION_SECRET',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'VAULT_KEY',
]);

// Blocklist of lower-cased, trimmed values that must never be accepted
// for any required secret, regardless of NODE_ENV.
//
// The list has two parts:
//   1. Historical weak-literals that used to live inline in the
//      src/index.js banned-defaults check (default-vault-key-change-me,
//      change-me, changeme, secret, password).
//   2. Every verbatim placeholder shipped in src/.env.example for the
//      four REQUIRED_SECRETS. If an operator does a naive
//      `cp src/.env.example src/.env`, those placeholders are what they
//      end up running with, and we want to fail closed on boot.
//
// Values are stored lower-case; the check lower-cases the env value
// before looking it up.
const _bannedDefaultsArr = [
  'default-vault-key-change-me',
  'change-me',
  'changeme',
  'secret',
  'password',
  // src/.env.example current placeholders (as of 2026-04-21):
  'your-session-secret-key-here',
  'your-secret-key-here-change-in-production',
  '32-character-encryption-key-here!!',
  'your-vault-key-here-change-in-production',
];

// Build a Set and then freeze it *behaviourally*. `Object.freeze` on a
// Set instance does not block `.add()` / `.delete()` in V8, so we also
// override those methods to no-op / throw. The resulting object still
// passes `instanceof Set` and keeps `.has()` / `.size` working.
const _bannedDefaultsSet = new Set(_bannedDefaultsArr.map(v => v.toLowerCase()));
const _mutableReject = () => {
  throw new Error('BANNED_DEFAULTS is immutable');
};
Object.defineProperty(_bannedDefaultsSet, 'add', {
  value: _mutableReject,
  writable: false,
  configurable: false,
});
Object.defineProperty(_bannedDefaultsSet, 'delete', {
  value: _mutableReject,
  writable: false,
  configurable: false,
});
Object.defineProperty(_bannedDefaultsSet, 'clear', {
  value: _mutableReject,
  writable: false,
  configurable: false,
});
Object.freeze(_bannedDefaultsSet);
const BANNED_DEFAULTS = _bannedDefaultsSet;

/**
 * @param {{ env?: Record<string,string|undefined>, nodeEnv?: string }} [opts]
 * @returns {{ ok: boolean, missing: string[], banned: Array<{name:string, value:string}> }}
 */
function validateRequiredSecrets(opts) {
  const env = (opts && opts.env) || process.env;
  // nodeEnv is accepted purely for telemetry / symmetry with the old
  // inline function; T2.5 deliberately does NOT branch on it any more.
  // eslint-disable-next-line no-unused-vars
  const nodeEnv = (opts && opts.nodeEnv) || env.NODE_ENV;

  const missing = [];
  const banned = [];

  for (const name of REQUIRED_SECRETS) {
    const raw = env[name];
    const trimmed = typeof raw === 'string' ? raw.trim() : '';

    if (trimmed.length === 0) {
      missing.push(name);
      continue;
    }

    const normalized = trimmed.toLowerCase();
    if (BANNED_DEFAULTS.has(normalized)) {
      // Preserve the raw value (trimmed but case-preserved) so the
      // caller can surface it in its error output verbatim if needed.
      banned.push({ name, value: trimmed });
    }
  }

  return {
    ok: missing.length === 0 && banned.length === 0,
    missing,
    banned,
  };
}

module.exports = {
  validateRequiredSecrets,
  REQUIRED_SECRETS,
  BANNED_DEFAULTS,
};
