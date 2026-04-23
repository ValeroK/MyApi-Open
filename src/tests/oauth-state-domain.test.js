/**
 * M3 Step 3 / T3.2 + T3.3 — behavioural suite for `src/domain/oauth/state.js`.
 *
 * The domain module is the single entry point for OAuth state lifecycle:
 *
 *   createStateToken({ db, serviceName, mode, returnTo?, userId?,
 *                      ttlSec?=600, now?=Date.now() })
 *     → { id, state, codeVerifier, codeChallenge, expiresAt, createdAt }
 *
 *   consumeStateToken({ db, state, serviceName, now?=Date.now() })
 *     → row   // or throws StateTokenError with one of the symbolic codes
 *
 *   pruneExpiredStateTokens({ db, now?=Date.now(), graceSec?=3600 })
 *     → { removed: number }
 *
 *   computeCodeChallenge(verifier)      // exposed for the KAT below
 *     → base64url(sha256(verifier))
 *
 *   StateTokenError.CODES              // frozen string-literal enum
 *     → { NOT_FOUND, EXPIRED, REUSED, SERVICE_MISMATCH,
 *         INVALID_MODE, INVALID_SERVICE }
 *
 * This suite is filed RED-first (module does not yet exist on disk —
 * `require(...)` will throw `MODULE_NOT_FOUND`). The implementation
 * lands in the same commit and flips the suite to green.
 *
 * Covers:
 *   - ADR-0006 (target design)
 *   - ADR-0014 §Step 3 (execution plan)
 *   - plan.md §6.3 H1 (deterministic PKCE verifier — closed here)
 *   - TASKS.md T3.2 + T3.3
 */

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ci';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'test-encryption-key-32chars!!';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-ci';
process.env.VAULT_KEY = process.env.VAULT_KEY || 'test-vault-key-ci-32characters!';
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const crypto = require('crypto');

describe('[M3 / T3.2 + T3.3] src/domain/oauth/state.js', () => {
  let db;
  let stateDomain;

  beforeAll(() => {
    const database = require('../database');
    database.initDatabase();
    db = database.db;
    stateDomain = require('../domain/oauth/state');
  });

  // --- module surface --------------------------------------------------

  test('exports createStateToken / consumeStateToken / pruneExpiredStateTokens', () => {
    expect(typeof stateDomain.createStateToken).toBe('function');
    expect(typeof stateDomain.consumeStateToken).toBe('function');
    expect(typeof stateDomain.pruneExpiredStateTokens).toBe('function');
  });

  test('exports computeCodeChallenge + StateTokenError.CODES enum', () => {
    expect(typeof stateDomain.computeCodeChallenge).toBe('function');
    expect(stateDomain.StateTokenError).toBeDefined();
    expect(stateDomain.StateTokenError.CODES).toEqual(
      expect.objectContaining({
        NOT_FOUND: 'STATE_NOT_FOUND',
        EXPIRED: 'STATE_EXPIRED',
        REUSED: 'STATE_REUSED',
        SERVICE_MISMATCH: 'STATE_SERVICE_MISMATCH',
        INVALID_MODE: 'STATE_INVALID_MODE',
        INVALID_SERVICE: 'STATE_INVALID_SERVICE',
      })
    );
  });

  // --- createStateToken ------------------------------------------------

  test('createStateToken returns the documented shape', () => {
    const out = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
    });
    expect(out).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        state: expect.any(String),
        codeVerifier: expect.any(String),
        codeChallenge: expect.any(String),
        expiresAt: expect.any(String),
        createdAt: expect.any(String),
      })
    );
  });

  test('state is base64url and length 43 (256 random bits, URL-safe)', () => {
    const { state } = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
    });
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('codeVerifier is base64url length 43, and different from state', () => {
    const { state, codeVerifier } = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
    });
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeVerifier).not.toBe(state);
  });

  test('codeChallenge equals base64url(sha256(codeVerifier))  (RFC 7636 S256)', () => {
    const { codeVerifier, codeChallenge } = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
    });
    const expected = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    expect(codeChallenge).toBe(expected);
  });

  test('computeCodeChallenge matches RFC 7636 Appendix B known-answer vector', () => {
    // RFC 7636 §Appendix B. If this ever fails we have silently drifted
    // off the PKCE S256 specification — a user-facing break.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(stateDomain.computeCodeChallenge(verifier)).toBe(challenge);
  });

  test('each createStateToken call produces a unique state + verifier', () => {
    const a = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
    });
    const b = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
    });
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  test('createStateToken writes a row to oauth_state_tokens', () => {
    const { state, codeVerifier, expiresAt } = stateDomain.createStateToken({
      db,
      serviceName: 'github',
      mode: 'link',
      userId: 'user-xyz',
      returnTo: '/dashboard/profile',
    });
    const row = db
      .prepare('SELECT * FROM oauth_state_tokens WHERE state_token = ?')
      .get(state);
    expect(row).toMatchObject({
      state_token: state,
      service_name: 'github',
      mode: 'link',
      user_id: 'user-xyz',
      return_to: '/dashboard/profile',
      code_verifier: codeVerifier,
      expires_at: expiresAt,
      used_at: null,
    });
  });

  test('createStateToken leaves user_id + return_to NULL when not provided', () => {
    const { state } = stateDomain.createStateToken({
      db,
      serviceName: 'github',
      mode: 'login',
    });
    const row = db
      .prepare(
        'SELECT user_id, return_to FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(state);
    expect(row.user_id).toBeNull();
    expect(row.return_to).toBeNull();
  });

  test('createStateToken rejects unknown mode as StateTokenError.INVALID_MODE', () => {
    expect(() =>
      stateDomain.createStateToken({
        db,
        serviceName: 'google',
        mode: 'not-a-mode',
      })
    ).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID_MODE' })
    );
  });

  test('createStateToken rejects missing/empty serviceName as INVALID_SERVICE', () => {
    expect(() =>
      stateDomain.createStateToken({ db, serviceName: '', mode: 'login' })
    ).toThrow(expect.objectContaining({ code: 'STATE_INVALID_SERVICE' }));
    expect(() =>
      stateDomain.createStateToken({ db, mode: 'login' })
    ).toThrow(expect.objectContaining({ code: 'STATE_INVALID_SERVICE' }));
  });

  test('createStateToken honours ttlSec', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01T12:00:00Z
    const { expiresAt } = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
      ttlSec: 120,
      now,
    });
    expect(new Date(expiresAt).getTime()).toBe(now + 120_000);
  });

  // --- consumeStateToken ----------------------------------------------

  test('consumeStateToken happy path returns the row and sets used_at', () => {
    const issued = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
    });
    const now = Date.now();
    const consumed = stateDomain.consumeStateToken({
      db,
      state: issued.state,
      serviceName: 'google',
      now,
    });
    expect(consumed.code_verifier).toBe(issued.codeVerifier);
    expect(consumed.service_name).toBe('google');
    expect(consumed.used_at).toBe(new Date(now).toISOString());
    // DB row is also updated.
    const row = db
      .prepare('SELECT used_at FROM oauth_state_tokens WHERE state_token = ?')
      .get(issued.state);
    expect(row.used_at).toBe(consumed.used_at);
  });

  test('consumeStateToken twice on the same row raises STATE_REUSED', () => {
    const { state } = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
    });
    stateDomain.consumeStateToken({ db, state, serviceName: 'google' });
    expect(() =>
      stateDomain.consumeStateToken({ db, state, serviceName: 'google' })
    ).toThrow(expect.objectContaining({ code: 'STATE_REUSED' }));
  });

  test('consumeStateToken raises STATE_NOT_FOUND for an unknown state', () => {
    expect(() =>
      stateDomain.consumeStateToken({
        db,
        state: 'definitely-not-a-real-state-token-value-xxxxxxx',
        serviceName: 'google',
      })
    ).toThrow(expect.objectContaining({ code: 'STATE_NOT_FOUND' }));
  });

  test('consumeStateToken raises STATE_EXPIRED when now > expires_at', () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { state } = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
      ttlSec: 600,
      now: t0,
    });
    expect(() =>
      stateDomain.consumeStateToken({
        db,
        state,
        serviceName: 'google',
        now: t0 + 600_001,
      })
    ).toThrow(expect.objectContaining({ code: 'STATE_EXPIRED' }));
  });

  test('consumeStateToken raises STATE_SERVICE_MISMATCH on wrong service', () => {
    const { state } = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
    });
    expect(() =>
      stateDomain.consumeStateToken({
        db,
        state,
        serviceName: 'github',
      })
    ).toThrow(
      expect.objectContaining({ code: 'STATE_SERVICE_MISMATCH' })
    );
    // Mismatch must NOT consume the row — a benign retry with the right
    // service still works.
    const ok = stateDomain.consumeStateToken({
      db,
      state,
      serviceName: 'google',
    });
    expect(ok.state_token).toBe(state);
  });

  // --- pruneExpiredStateTokens ----------------------------------------

  test('pruneExpiredStateTokens removes rows whose expires_at is past grace', () => {
    const t0 = Date.UTC(2026, 3, 1, 0, 0, 0);
    const { state: freshState } = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
      ttlSec: 600,
      now: t0,
    });
    // The default grace window is 1 hour, so to land past it the row's
    // `expires_at` must be more than 1h before `now`. With a 60s TTL and
    // `now - 4h` as the create time, expires_at ends up ~4h before t0.
    const { state: staleState } = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
      ttlSec: 60,
      now: t0 - 4 * 3_600_000,
    });

    const { removed } = stateDomain.pruneExpiredStateTokens({
      db,
      now: t0,
    });
    expect(removed).toBeGreaterThanOrEqual(1);

    const stale = db
      .prepare('SELECT 1 FROM oauth_state_tokens WHERE state_token = ?')
      .get(staleState);
    const fresh = db
      .prepare('SELECT 1 FROM oauth_state_tokens WHERE state_token = ?')
      .get(freshState);
    expect(stale).toBeUndefined();
    expect(fresh).toBeDefined();
  });

  test('pruneExpiredStateTokens removes used rows past grace', () => {
    const t0 = Date.UTC(2026, 3, 2, 0, 0, 0);
    const issued = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
      ttlSec: 600,
      now: t0,
    });
    stateDomain.consumeStateToken({
      db,
      state: issued.state,
      serviceName: 'google',
      now: t0,
    });

    // Row is used; advance >1h past used_at.
    const { removed } = stateDomain.pruneExpiredStateTokens({
      db,
      now: t0 + 3_600_000 + 1,
      graceSec: 3600,
    });
    expect(removed).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare('SELECT 1 FROM oauth_state_tokens WHERE state_token = ?')
      .get(issued.state);
    expect(row).toBeUndefined();
  });

  test('pruneExpiredStateTokens honours graceSec parameter', () => {
    const t0 = Date.UTC(2026, 3, 3, 0, 0, 0);
    const { state } = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
      ttlSec: 60,
      now: t0,
    });
    // 2 min past expiry; default grace (1h) should KEEP the row.
    const { removed: withDefault } = stateDomain.pruneExpiredStateTokens({
      db,
      now: t0 + 60_000 + 120_000,
    });
    expect(withDefault).toBe(0);
    const kept = db
      .prepare('SELECT 1 FROM oauth_state_tokens WHERE state_token = ?')
      .get(state);
    expect(kept).toBeDefined();

    // Same moment with graceSec=0 should remove it.
    const { removed: withZero } = stateDomain.pruneExpiredStateTokens({
      db,
      now: t0 + 60_000 + 120_000,
      graceSec: 0,
    });
    expect(withZero).toBeGreaterThanOrEqual(1);
  });

  test('pruneExpiredStateTokens returns { removed: 0 } on an empty-ish table', () => {
    // Clear everything first to make the assertion deterministic.
    db.exec('DELETE FROM oauth_state_tokens');
    stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
    });
    const { removed } = stateDomain.pruneExpiredStateTokens({ db });
    expect(removed).toBe(0);
  });
});
