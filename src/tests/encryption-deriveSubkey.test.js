/**
 * Unit tests for deriveSubkey (HKDF-SHA-256) in src/lib/encryption.js — T2.1.
 *
 * Written test-first (ADR-0012) against an API that does not yet exist;
 * this suite must be red before the implementation lands and green after.
 *
 * Goals:
 *   1. Prove HKDF-SHA-256 is implemented correctly via RFC 5869 known-
 *      answer vectors.
 *   2. Pin down the module's domain-separation guarantee: identical
 *      (root, purpose) -> identical output; different purpose or
 *      different root -> different output.
 *   3. Validate the input-hardening contract (purpose whitelist,
 *      length bounds, root-length floor, defensive error messages).
 *   4. Confirm an output subkey round-trips through the module's
 *      existing AES-256-GCM encrypt/decrypt, i.e. the primitive is
 *      directly usable by downstream consumers.
 */

const crypto = require('crypto');
const {
  deriveSubkey,
  SUBKEY_PURPOSES,
  encrypt,
  decrypt,
  KEY_LENGTH,
} = require('../lib/encryption');

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

// RFC 5869 Test Case 1 (HKDF with SHA-256, basic test case with short inputs)
// https://datatracker.ietf.org/doc/html/rfc5869#appendix-A.1
const RFC5869_TC1 = {
  ikm: Buffer.from('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', 'hex'), // 22 bytes
  salt: Buffer.from('000102030405060708090a0b0c', 'hex'), // 13 bytes
  info: Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'), // 10 bytes
  length: 42,
  okm: Buffer.from(
    '3cb25f25faacd57a90434f64d0362f2a' +
      '2d2d0a90cf1a5a4c5db02d56ecc4c5bf' +
      '34007208d5b887185865',
    'hex',
  ),
};

// Production-sized root key (32 bytes, high-entropy) used for everything
// except the RFC KAT above.
const ROOT_A = Buffer.from(
  'a1a2a3a4a5a6a7a8a9aaabacadaeaf' +
    'b0b1b2b3b4b5b6b7b8b9babbbcbdbebf' +
    '10',
  'hex',
);
const ROOT_B = Buffer.from(
  '11121314151617181920212223242526' +
    '2728292a2b2c2d2e2f30313233343536',
  'hex',
);

// -----------------------------------------------------------------------
// Smoke: the module surface we're about to introduce
// -----------------------------------------------------------------------

describe('deriveSubkey — module surface', () => {
  it('exports deriveSubkey as a function', () => {
    expect(typeof deriveSubkey).toBe('function');
  });

  it('exports SUBKEY_PURPOSES as a non-empty array of strings', () => {
    expect(Array.isArray(SUBKEY_PURPOSES)).toBe(true);
    expect(SUBKEY_PURPOSES.length).toBeGreaterThan(0);
    for (const p of SUBKEY_PURPOSES) {
      expect(typeof p).toBe('string');
    }
  });

  it('SUBKEY_PURPOSES includes the three M2 canonical labels', () => {
    // These are the labels T2.1 contracts with the rest of the codebase.
    // Adding new labels later is fine; removing these is a breaking change.
    expect(SUBKEY_PURPOSES).toEqual(
      expect.arrayContaining(['oauth:v1', 'session:v1', 'audit:v1']),
    );
  });

  it('SUBKEY_PURPOSES is frozen / immutable', () => {
    expect(Object.isFrozen(SUBKEY_PURPOSES)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Correctness: RFC 5869 Test Case 1
// -----------------------------------------------------------------------

describe('deriveSubkey — RFC 5869 correctness (HKDF-SHA-256 KAT)', () => {
  it('matches RFC 5869 Test Case 1 exactly (SHA-256, 42-byte OKM)', () => {
    // The KAT uses a 22-byte IKM and an arbitrary binary `info`, neither of
    // which fits the production input contract. The module exposes an
    // `allowUnregisteredPurpose` escape hatch explicitly so this vector
    // (and future KATs) can be exercised without weakening the production
    // whitelist. Parallel escape on root-length to accept the 22-byte IKM.
    const okm = deriveSubkey(RFC5869_TC1.ikm, RFC5869_TC1.info.toString('binary'), {
      length: RFC5869_TC1.length,
      salt: RFC5869_TC1.salt,
      allowUnregisteredPurpose: true,
      allowShortRoot: true,
    });

    expect(Buffer.isBuffer(okm)).toBe(true);
    expect(okm.length).toBe(RFC5869_TC1.length);
    expect(okm.equals(RFC5869_TC1.okm)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Behaviour: determinism + domain separation
// -----------------------------------------------------------------------

describe('deriveSubkey — determinism and domain separation', () => {
  it('returns byte-identical output for the same (root, purpose)', () => {
    const a = deriveSubkey(ROOT_A, 'oauth:v1');
    const b = deriveSubkey(ROOT_A, 'oauth:v1');
    expect(a.equals(b)).toBe(true);
  });

  it('returns a 32-byte Buffer by default', () => {
    const k = deriveSubkey(ROOT_A, 'oauth:v1');
    expect(Buffer.isBuffer(k)).toBe(true);
    expect(k.length).toBe(KEY_LENGTH);
    expect(KEY_LENGTH).toBe(32); // sanity: constant hasn't drifted
  });

  it('respects a custom length within 16..64', () => {
    const k16 = deriveSubkey(ROOT_A, 'oauth:v1', { length: 16 });
    const k64 = deriveSubkey(ROOT_A, 'oauth:v1', { length: 64 });
    expect(k16.length).toBe(16);
    expect(k64.length).toBe(64);
  });

  it('different purposes with the same root produce different subkeys', () => {
    const oauth = deriveSubkey(ROOT_A, 'oauth:v1');
    const session = deriveSubkey(ROOT_A, 'session:v1');
    const audit = deriveSubkey(ROOT_A, 'audit:v1');

    expect(oauth.equals(session)).toBe(false);
    expect(oauth.equals(audit)).toBe(false);
    expect(session.equals(audit)).toBe(false);
  });

  it('same purpose across different roots produces different subkeys', () => {
    const a = deriveSubkey(ROOT_A, 'oauth:v1');
    const b = deriveSubkey(ROOT_B, 'oauth:v1');
    expect(a.equals(b)).toBe(false);
  });

  it('accepts root as a hex string equivalent to its Buffer form', () => {
    const fromBuf = deriveSubkey(ROOT_A, 'oauth:v1');
    const fromHex = deriveSubkey(ROOT_A.toString('hex'), 'oauth:v1');
    expect(fromBuf.equals(fromHex)).toBe(true);
  });

  it('does not leak the root key into its derivatives (obvious-distance sanity)', () => {
    // Not a cryptographic proof, but a cheap regression check: a derived
    // subkey should not simply equal the first 32 bytes of the root or its
    // hash, which would indicate a broken derivation (e.g. identity or
    // plain SHA-256 of the root).
    const k = deriveSubkey(ROOT_A, 'oauth:v1');
    expect(k.equals(ROOT_A.subarray(0, 32))).toBe(false);
    const sha = crypto.createHash('sha256').update(ROOT_A).digest();
    expect(k.equals(sha)).toBe(false);
  });
});

// -----------------------------------------------------------------------
// Input validation
// -----------------------------------------------------------------------

describe('deriveSubkey — input validation', () => {
  const GENERIC_ERROR = /Subkey derivation failed/;

  it('rejects an unregistered purpose by default', () => {
    expect(() => deriveSubkey(ROOT_A, 'nope:v1')).toThrow(GENERIC_ERROR);
  });

  it('rejects empty purpose', () => {
    expect(() => deriveSubkey(ROOT_A, '')).toThrow(GENERIC_ERROR);
  });

  it('rejects non-string purpose', () => {
    expect(() => deriveSubkey(ROOT_A, 12345)).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey(ROOT_A, null)).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey(ROOT_A, undefined)).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey(ROOT_A, {})).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey(ROOT_A, Buffer.from('oauth:v1'))).toThrow(GENERIC_ERROR);
  });

  it('rejects short root (< 32 bytes) in production mode', () => {
    const short = Buffer.alloc(16, 0xaa);
    expect(() => deriveSubkey(short, 'oauth:v1')).toThrow(GENERIC_ERROR);
  });

  it('rejects non-Buffer / non-string root', () => {
    expect(() => deriveSubkey(null, 'oauth:v1')).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey(undefined, 'oauth:v1')).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey(42, 'oauth:v1')).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey({}, 'oauth:v1')).toThrow(GENERIC_ERROR);
  });

  it('rejects malformed hex-string root', () => {
    // 63 hex chars decodes to 31 bytes -> below the 32-byte floor.
    const malformed = '00'.repeat(31) + '0';
    expect(() => deriveSubkey(malformed, 'oauth:v1')).toThrow(GENERIC_ERROR);
  });

  it('rejects length outside 16..64', () => {
    expect(() => deriveSubkey(ROOT_A, 'oauth:v1', { length: 0 })).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey(ROOT_A, 'oauth:v1', { length: 8 })).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey(ROOT_A, 'oauth:v1', { length: 65 })).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey(ROOT_A, 'oauth:v1', { length: -1 })).toThrow(GENERIC_ERROR);
    expect(() => deriveSubkey(ROOT_A, 'oauth:v1', { length: 3.14 })).toThrow(GENERIC_ERROR);
  });

  it('throws a generic error that does not echo the root or purpose', () => {
    try {
      deriveSubkey(ROOT_A, 'nope:v1');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).toBe('Subkey derivation failed');
      expect(err.message).not.toContain(ROOT_A.toString('hex'));
      expect(err.message).not.toContain('nope');
    }
  });
});

// -----------------------------------------------------------------------
// Integration: derived subkey round-trips through AES-256-GCM
// -----------------------------------------------------------------------

describe('deriveSubkey — AES-256-GCM integration', () => {
  it('produces a 32-byte key that round-trips a plaintext via encrypt/decrypt', () => {
    const subkey = deriveSubkey(ROOT_A, 'oauth:v1');
    const plaintext = 'hello from a derived oauth subkey';

    const ct = encrypt(plaintext, subkey);
    expect(ct).toHaveProperty('ciphertext');
    expect(ct).toHaveProperty('nonce');
    expect(ct).toHaveProperty('authTag');

    const pt = decrypt(ct, subkey);
    expect(pt).toBe(plaintext);
  });

  it('a ciphertext from one subkey does NOT decrypt under a different-purpose subkey', () => {
    const oauthKey = deriveSubkey(ROOT_A, 'oauth:v1');
    const sessionKey = deriveSubkey(ROOT_A, 'session:v1');
    const ct = encrypt('domain-separated secret', oauthKey);

    expect(() => decrypt(ct, sessionKey)).toThrow(/Decryption failed/);
  });
});
