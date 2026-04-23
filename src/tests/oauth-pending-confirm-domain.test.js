/**
 * M3 Step 6 / T3.7 — behavioural suite for
 * `src/domain/oauth/pending-confirm.js`.
 *
 * The pending-confirm module is the single entry point for the
 * post-callback "did the user consent to log in as X?" lifecycle.
 * Routes (callback / confirm / confirm-preview / confirm-reject)
 * and scheduled jobs (prune) talk to this module — they MUST NOT
 * hand-roll SQL against `oauth_pending_logins` and they MUST NOT
 * use `req.session` to remember pending-login metadata. This
 * mirrors the ADR-0006 / Step 5 "DB row is source of truth"
 * invariant we already enforced for `oauth_state_tokens`.
 *
 * Exported surface (documented in the implementation header):
 *
 *   createPendingConfirm({ db, serviceName, userId, providerSubject,
 *                          userData, ttlSec?=300, now?=Date.now() })
 *     → { id, token, expiresAt, createdAt }
 *
 *   previewPendingConfirm({ db, token, now?=Date.now() })
 *     → { serviceName, email, displayName, avatarUrl, providerSubject,
 *         expiresAt }
 *     or throws PendingConfirmError
 *
 *   consumePendingConfirm({ db, token, outcome, now?=Date.now() })
 *     → consumed row
 *     or throws PendingConfirmError
 *     `outcome` ∈ VALID_OUTCOMES = ['accepted', 'rejected']
 *
 *   hasConfirmedBefore({ db, userId, serviceName, providerSubject })
 *     → boolean
 *
 *   recordFirstConfirmation({ db, userId, serviceName, providerSubject,
 *                             now?=Date.now() })
 *     → void (idempotent)
 *
 *   pruneExpiredPendingConfirms({ db, now?=Date.now(), graceSec?=3600 })
 *     → { removed: number }
 *
 *   PendingConfirmError.CODES = {
 *     NOT_FOUND:        'PENDING_CONFIRM_NOT_FOUND',
 *     EXPIRED:          'PENDING_CONFIRM_EXPIRED',
 *     REUSED:           'PENDING_CONFIRM_REUSED',
 *     INVALID_OUTCOME:  'PENDING_CONFIRM_INVALID_OUTCOME',
 *   }
 *
 * This suite is filed RED-first (module does not exist on disk yet —
 * `require(...)` will throw `MODULE_NOT_FOUND`). The implementation
 * lands in the same commit and flips the suite to green.
 *
 * Covers:
 *   - ADR-0006 (target design — row is SSOT, no session)
 *   - ADR-0014 §Step 6 (execution plan)
 *   - ADR-0016 (first-seen keying on {service, user, provider_subject})
 *   - plan.md §6.3 C3 session-fixation variant (closed at handler layer
 *     in T3.7b once this module ships)
 *   - TASKS.md T3.7
 */

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ci';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'test-encryption-key-32chars!!';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'test-session-secret-ci';
process.env.VAULT_KEY =
  process.env.VAULT_KEY || 'test-vault-key-ci-32characters!';
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

describe('[M3 / T3.7] src/domain/oauth/pending-confirm.js', () => {
  let db;
  let pendingConfirm;

  beforeAll(() => {
    const database = require('../database');
    database.initDatabase();
    db = database.db;
    pendingConfirm = require('../domain/oauth/pending-confirm');
  });

  beforeEach(() => {
    // Each test starts with a clean pending-confirms table so assertions
    // on row counts / uniqueness stay deterministic.
    db.exec('DELETE FROM oauth_pending_logins');
    db.exec('DELETE FROM oauth_tokens');
  });

  // ------------------------------------------------------------------
  // Module surface
  // ------------------------------------------------------------------

  test('exports the documented function surface', () => {
    expect(typeof pendingConfirm.createPendingConfirm).toBe('function');
    expect(typeof pendingConfirm.previewPendingConfirm).toBe('function');
    expect(typeof pendingConfirm.consumePendingConfirm).toBe('function');
    expect(typeof pendingConfirm.hasConfirmedBefore).toBe('function');
    expect(typeof pendingConfirm.recordFirstConfirmation).toBe('function');
    expect(typeof pendingConfirm.pruneExpiredPendingConfirms).toBe(
      'function'
    );
  });

  test('exports PendingConfirmError.CODES enum and VALID_OUTCOMES', () => {
    expect(pendingConfirm.PendingConfirmError).toBeDefined();
    expect(pendingConfirm.PendingConfirmError.CODES).toEqual(
      expect.objectContaining({
        NOT_FOUND: 'PENDING_CONFIRM_NOT_FOUND',
        EXPIRED: 'PENDING_CONFIRM_EXPIRED',
        REUSED: 'PENDING_CONFIRM_REUSED',
        INVALID_OUTCOME: 'PENDING_CONFIRM_INVALID_OUTCOME',
      })
    );
    expect(pendingConfirm.VALID_OUTCOMES).toEqual(['accepted', 'rejected']);
  });

  // ------------------------------------------------------------------
  // createPendingConfirm
  // ------------------------------------------------------------------

  test('createPendingConfirm returns the documented shape', () => {
    const out = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: {
        email: 'alice@example.com',
        displayName: 'Alice',
        avatarUrl: null,
      },
    });
    expect(out).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        token: expect.any(String),
        expiresAt: expect.any(String),
        createdAt: expect.any(String),
      })
    );
  });

  test('token is base64url length 43 (256 random bits, URL-safe)', () => {
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('each createPendingConfirm produces a unique token + id', () => {
    const a = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
    });
    const b = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
    });
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
  });

  test('createPendingConfirm writes a row with used_at NULL and outcome NULL', () => {
    const { token, expiresAt } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'github',
      userId: 'user-xyz',
      providerSubject: 'github-sub-999',
      userData: {
        email: 'carol@example.com',
        displayName: 'Carol',
        avatarUrl: 'https://example.com/carol.png',
      },
    });
    const row = db
      .prepare('SELECT * FROM oauth_pending_logins WHERE token = ?')
      .get(token);
    expect(row).toMatchObject({
      token,
      service_name: 'github',
      user_id: 'user-xyz',
      expires_at: expiresAt,
      used_at: null,
      outcome: null,
    });
    const payload = JSON.parse(row.user_data);
    expect(payload).toEqual(
      expect.objectContaining({
        email: 'carol@example.com',
        displayName: 'Carol',
        avatarUrl: 'https://example.com/carol.png',
        providerSubject: 'github-sub-999',
      })
    );
  });

  test('createPendingConfirm honours ttlSec with an injected clock', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01T12:00:00Z
    const { expiresAt } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
      ttlSec: 120,
      now,
    });
    expect(new Date(expiresAt).getTime()).toBe(now + 120_000);
  });

  test('createPendingConfirm defaults ttlSec to 5 minutes', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { expiresAt } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
      now,
    });
    // 5 minutes = 300_000 ms
    expect(new Date(expiresAt).getTime()).toBe(now + 300_000);
  });

  // ------------------------------------------------------------------
  // previewPendingConfirm
  // ------------------------------------------------------------------

  test('previewPendingConfirm returns identity fields without consuming the row', () => {
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: {
        email: 'alice@example.com',
        displayName: 'Alice',
        avatarUrl: 'https://example.com/alice.png',
      },
    });
    const preview = pendingConfirm.previewPendingConfirm({ db, token });
    expect(preview).toEqual(
      expect.objectContaining({
        serviceName: 'google',
        email: 'alice@example.com',
        displayName: 'Alice',
        avatarUrl: 'https://example.com/alice.png',
        providerSubject: 'google-subject-1',
        expiresAt: expect.any(String),
      })
    );
    // Row must NOT be marked used by a preview.
    const row = db
      .prepare('SELECT used_at, outcome FROM oauth_pending_logins WHERE token = ?')
      .get(token);
    expect(row.used_at).toBeNull();
    expect(row.outcome).toBeNull();
  });

  test('previewPendingConfirm raises NOT_FOUND for an unknown token', () => {
    expect(() =>
      pendingConfirm.previewPendingConfirm({
        db,
        token: 'totally-fake-token-not-in-db-xxxxxxxxxxxxxx',
      })
    ).toThrow(
      expect.objectContaining({ code: 'PENDING_CONFIRM_NOT_FOUND' })
    );
  });

  test('previewPendingConfirm raises EXPIRED when now > expires_at', () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
      ttlSec: 300,
      now: t0,
    });
    expect(() =>
      pendingConfirm.previewPendingConfirm({
        db,
        token,
        now: t0 + 300_001,
      })
    ).toThrow(expect.objectContaining({ code: 'PENDING_CONFIRM_EXPIRED' }));
  });

  test('previewPendingConfirm raises REUSED after the row has been consumed', () => {
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
    });
    pendingConfirm.consumePendingConfirm({
      db,
      token,
      outcome: 'accepted',
    });
    expect(() =>
      pendingConfirm.previewPendingConfirm({ db, token })
    ).toThrow(expect.objectContaining({ code: 'PENDING_CONFIRM_REUSED' }));
  });

  // ------------------------------------------------------------------
  // consumePendingConfirm
  // ------------------------------------------------------------------

  test('consumePendingConfirm (accepted) returns the row and sets used_at + outcome', () => {
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com', accessToken: 'at-123' },
    });
    const now = Date.now();
    const consumed = pendingConfirm.consumePendingConfirm({
      db,
      token,
      outcome: 'accepted',
      now,
    });
    expect(consumed.service_name).toBe('google');
    expect(consumed.user_id).toBe('user-abc');
    expect(consumed.outcome).toBe('accepted');
    expect(consumed.used_at).toBe(new Date(now).toISOString());
    const payload = JSON.parse(consumed.user_data);
    expect(payload.email).toBe('alice@example.com');
    expect(payload.accessToken).toBe('at-123');
  });

  test('consumePendingConfirm (rejected) burns the row with outcome=rejected', () => {
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
    });
    const consumed = pendingConfirm.consumePendingConfirm({
      db,
      token,
      outcome: 'rejected',
    });
    expect(consumed.outcome).toBe('rejected');
    const row = db
      .prepare('SELECT used_at, outcome FROM oauth_pending_logins WHERE token = ?')
      .get(token);
    expect(row.used_at).not.toBeNull();
    expect(row.outcome).toBe('rejected');
  });

  test('consumePendingConfirm twice on the same row raises REUSED', () => {
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
    });
    pendingConfirm.consumePendingConfirm({ db, token, outcome: 'accepted' });
    expect(() =>
      pendingConfirm.consumePendingConfirm({
        db,
        token,
        outcome: 'accepted',
      })
    ).toThrow(expect.objectContaining({ code: 'PENDING_CONFIRM_REUSED' }));
  });

  test('consumePendingConfirm rejects invalid outcome as INVALID_OUTCOME', () => {
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
    });
    expect(() =>
      pendingConfirm.consumePendingConfirm({
        db,
        token,
        outcome: 'maybe',
      })
    ).toThrow(
      expect.objectContaining({ code: 'PENDING_CONFIRM_INVALID_OUTCOME' })
    );
    // Row must NOT be consumed — a benign retry with a valid outcome still works.
    const ok = pendingConfirm.consumePendingConfirm({
      db,
      token,
      outcome: 'accepted',
    });
    expect(ok.outcome).toBe('accepted');
  });

  test('consumePendingConfirm raises NOT_FOUND for an unknown token', () => {
    expect(() =>
      pendingConfirm.consumePendingConfirm({
        db,
        token: 'not-a-real-token-xxxxxxxxxxxxxxxxxxxxxxxxx',
        outcome: 'accepted',
      })
    ).toThrow(
      expect.objectContaining({ code: 'PENDING_CONFIRM_NOT_FOUND' })
    );
  });

  test('consumePendingConfirm raises EXPIRED when now > expires_at (and leaves used_at NULL)', () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-abc',
      providerSubject: 'google-subject-1',
      userData: { email: 'alice@example.com' },
      ttlSec: 300,
      now: t0,
    });
    expect(() =>
      pendingConfirm.consumePendingConfirm({
        db,
        token,
        outcome: 'accepted',
        now: t0 + 300_001,
      })
    ).toThrow(expect.objectContaining({ code: 'PENDING_CONFIRM_EXPIRED' }));
    // Expired rows must NOT be marked consumed — the prune job owns deletion.
    const row = db
      .prepare('SELECT used_at FROM oauth_pending_logins WHERE token = ?')
      .get(token);
    expect(row.used_at).toBeNull();
  });

  // ------------------------------------------------------------------
  // hasConfirmedBefore / recordFirstConfirmation
  // ------------------------------------------------------------------

  test('hasConfirmedBefore returns false when no oauth_tokens row exists', () => {
    expect(
      pendingConfirm.hasConfirmedBefore({
        db,
        userId: 'user-brand-new',
        serviceName: 'google',
        providerSubject: 'google-sub-brand-new',
      })
    ).toBe(false);
  });

  test('recordFirstConfirmation + hasConfirmedBefore round-trip on the same tuple', () => {
    // Seed the oauth_tokens row the way storeOAuthToken would have; the
    // domain module only cares about (service, user_id) as the upsert
    // key + provider_subject + first_confirmed_at as the gate columns.
    db.prepare(
      `INSERT INTO oauth_tokens
         (id, service_name, user_id, access_token, provider_subject,
          first_confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).run(
      'oauth_seed_1',
      'google',
      'user-abc',
      'enc-access-token',
      new Date().toISOString(),
      new Date().toISOString()
    );

    // Before recording, hasConfirmedBefore must be false (first_confirmed_at is NULL).
    expect(
      pendingConfirm.hasConfirmedBefore({
        db,
        userId: 'user-abc',
        serviceName: 'google',
        providerSubject: 'google-sub-A',
      })
    ).toBe(false);

    pendingConfirm.recordFirstConfirmation({
      db,
      userId: 'user-abc',
      serviceName: 'google',
      providerSubject: 'google-sub-A',
    });

    expect(
      pendingConfirm.hasConfirmedBefore({
        db,
        userId: 'user-abc',
        serviceName: 'google',
        providerSubject: 'google-sub-A',
      })
    ).toBe(true);

    // ADR-0016 gate: a DIFFERENT provider_subject for the same (service, user)
    // must read as NOT confirmed — protects against the Case B attack where
    // an attacker's second provider account is silently aliased onto a
    // pre-existing row.
    expect(
      pendingConfirm.hasConfirmedBefore({
        db,
        userId: 'user-abc',
        serviceName: 'google',
        providerSubject: 'google-sub-DIFFERENT',
      })
    ).toBe(false);
  });

  test('recordFirstConfirmation is idempotent (calling twice does not error)', () => {
    db.prepare(
      `INSERT INTO oauth_tokens
         (id, service_name, user_id, access_token, provider_subject,
          first_confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).run(
      'oauth_idem_1',
      'google',
      'user-idem',
      'enc',
      new Date().toISOString(),
      new Date().toISOString()
    );
    expect(() => {
      pendingConfirm.recordFirstConfirmation({
        db,
        userId: 'user-idem',
        serviceName: 'google',
        providerSubject: 'google-sub-idem',
      });
      pendingConfirm.recordFirstConfirmation({
        db,
        userId: 'user-idem',
        serviceName: 'google',
        providerSubject: 'google-sub-idem',
      });
    }).not.toThrow();
    // Still confirmed.
    expect(
      pendingConfirm.hasConfirmedBefore({
        db,
        userId: 'user-idem',
        serviceName: 'google',
        providerSubject: 'google-sub-idem',
      })
    ).toBe(true);
  });

  // ------------------------------------------------------------------
  // pruneExpiredPendingConfirms
  // ------------------------------------------------------------------

  test('pruneExpiredPendingConfirms removes rows whose expires_at is past grace', () => {
    const t0 = Date.UTC(2026, 3, 1, 0, 0, 0);
    const { token: freshToken } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-fresh',
      providerSubject: 'google-fresh',
      userData: { email: 'fresh@example.com' },
      ttlSec: 300,
      now: t0,
    });
    // Row past default grace (1h): TTL 60s, created 4h before t0,
    // so expires_at = t0 - 4h + 60s ≈ t0 - 239min, well past the
    // 1h grace window.
    const { token: staleToken } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-stale',
      providerSubject: 'google-stale',
      userData: { email: 'stale@example.com' },
      ttlSec: 60,
      now: t0 - 4 * 3_600_000,
    });

    const { removed } = pendingConfirm.pruneExpiredPendingConfirms({
      db,
      now: t0,
    });
    expect(removed).toBeGreaterThanOrEqual(1);

    expect(
      db
        .prepare('SELECT 1 FROM oauth_pending_logins WHERE token = ?')
        .get(staleToken)
    ).toBeUndefined();
    expect(
      db
        .prepare('SELECT 1 FROM oauth_pending_logins WHERE token = ?')
        .get(freshToken)
    ).toBeDefined();
  });

  test('pruneExpiredPendingConfirms removes used rows past grace', () => {
    const t0 = Date.UTC(2026, 3, 2, 0, 0, 0);
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-used',
      providerSubject: 'google-used',
      userData: { email: 'used@example.com' },
      ttlSec: 300,
      now: t0,
    });
    pendingConfirm.consumePendingConfirm({
      db,
      token,
      outcome: 'accepted',
      now: t0,
    });
    const { removed } = pendingConfirm.pruneExpiredPendingConfirms({
      db,
      now: t0 + 3_600_000 + 1,
      graceSec: 3600,
    });
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      db
        .prepare('SELECT 1 FROM oauth_pending_logins WHERE token = ?')
        .get(token)
    ).toBeUndefined();
  });

  test('pruneExpiredPendingConfirms returns { removed: 0 } when nothing qualifies', () => {
    db.exec('DELETE FROM oauth_pending_logins');
    pendingConfirm.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user-fresh',
      providerSubject: 'google-fresh',
      userData: { email: 'fresh@example.com' },
    });
    const { removed } = pendingConfirm.pruneExpiredPendingConfirms({ db });
    expect(removed).toBe(0);
  });
});
