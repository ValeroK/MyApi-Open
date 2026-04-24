/**
 * M3 Step 6 / T3.7 — supertest coverage for the rewired
 *   GET  /api/v1/oauth/confirm/preview
 *   POST /api/v1/oauth/confirm
 *   POST /api/v1/oauth/confirm/reject
 * endpoints.
 *
 * This suite seeds rows directly via
 * `src/domain/oauth/pending-confirm.js` (bypassing the OAuth callback
 * entirely) so the handler contract can be pinned without any live
 * network exchange. The callback's responsibility for *producing* the
 * pending-confirm row is exercised separately by
 * `oauth-callback-handler.test.js` and the end-to-end
 * `oauth-signup-flow.test.js`.
 *
 * Contract pinned by this file:
 *
 *   - Preview is idempotent, read-only, and bearer-gated by the token
 *     itself (no `req.session` touched).
 *   - Accept/reject both drive `consumePendingConfirm` and surface the
 *     domain error taxonomy as discriminated HTTP responses:
 *        NOT_FOUND        → 400 { error: 'pending_confirm_not_found' }
 *        EXPIRED          → 400 { error: 'pending_confirm_expired' }
 *        REUSED           → 400 { error: 'pending_confirm_reused' }
 *        INVALID_OUTCOME  → never surfaced (server never passes
 *                           user-supplied outcomes)
 *   - Accept sets `req.session.user` and stamps `first_confirmed_at`
 *     on the `oauth_tokens` row (via `recordFirstConfirmation`).
 *   - Reject does NOT set `req.session.user`.
 *   - Neither endpoint reads or writes the legacy session keys
 *     `oauth_confirm` / `oauth_login_pending` — the row is SSOT.
 *
 * Red-first: the preview + reject endpoints don't exist yet and the
 * accept endpoint still short-circuits on `req.session.oauth_confirm`.
 * This file lands red and the handler refactor in the same commit
 * flips it green.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ci';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'test-encryption-key-32chars!!';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'test-session-secret-ci';
process.env.VAULT_KEY =
  process.env.VAULT_KEY || 'test-vault-key-ci-32characters!';
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
// Suppress the "GOOGLE_CLIENT_ID not set" etc. warnings from index.js
// bootstrap. These are unrelated to the confirm endpoints under test.
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4500/api/v1/oauth/callback/google';

const crypto = require('crypto');
const request = require('supertest');

describe('[M3 / T3.7] OAuth confirm handlers', () => {
  let app;
  let db;
  let pendingConfirm;

  beforeAll(() => {
    const database = require('../database');
    database.initDatabase();
    db = database.db;
    pendingConfirm = require('../domain/oauth/pending-confirm');
    // Require the Express app AFTER the DB is ready. The module exports
    // an object of which `.app` is the bound Express handler.
    app = require('../index').app;
  });

  beforeEach(() => {
    db.exec('DELETE FROM oauth_pending_logins');
    db.exec('DELETE FROM oauth_tokens');
    db.exec('DELETE FROM users');
  });

  /** Create a users row so the accept path's session.user has a valid
   *  FK target (the accept path looks up workspaces, master-token, etc.
   *  — easier to seed than to mock). Schema per src/database.js L213-224. */
  function seedUser({
    id = 'user_' + crypto.randomBytes(6).toString('hex'),
    email = 'alice@example.com',
    username = 'alice',
  } = {}) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, display_name, email, password_hash,
                          two_factor_enabled, created_at, status, plan)
         VALUES (?, ?, ?, ?, '', 0, ?, 'active', 'free')`
    ).run(id, username, username, email, now);
    return { id, email, username };
  }

  /** Create a pending-confirm row via the domain module and return
   *  {token, userId, providerSubject} for the handler call. */
  function seedPendingConfirm({
    serviceName = 'google',
    providerSubject = 'google-sub-' + crypto.randomBytes(4).toString('hex'),
    user,
    ttlSec = 300,
    now,
  } = {}) {
    const u = user || seedUser();
    const { token } = pendingConfirm.createPendingConfirm({
      db,
      serviceName,
      userId: u.id,
      providerSubject,
      userData: {
        userId: u.id,
        email: u.email,
        username: u.username,
        displayName: u.username,
        avatarUrl: null,
        hasTwoFa: false,
      },
      ttlSec,
      now,
    });
    return { token, userId: u.id, providerSubject, serviceName };
  }

  // ------------------------------------------------------------------
  // GET /api/v1/oauth/confirm/preview
  // ------------------------------------------------------------------

  test('GET /oauth/confirm/preview returns identity fields for a valid token', async () => {
    const { token, providerSubject } = seedPendingConfirm();
    const res = await request(app)
      .get(`/api/v1/oauth/confirm/preview?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        serviceName: 'google',
        email: 'alice@example.com',
        displayName: 'alice',
        providerSubject,
        expiresAt: expect.any(String),
      })
    );
    // Row still consumable after a preview.
    const row = db
      .prepare('SELECT used_at, outcome FROM oauth_pending_logins WHERE token = ?')
      .get(token);
    expect(row.used_at).toBeNull();
    expect(row.outcome).toBeNull();
  });

  test('GET /oauth/confirm/preview rejects missing token with 400', async () => {
    const res = await request(app).get('/api/v1/oauth/confirm/preview');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
  });

  test('GET /oauth/confirm/preview surfaces NOT_FOUND as HTTP 400', async () => {
    const res = await request(app)
      .get('/api/v1/oauth/confirm/preview?token=totally-fake-token-xxxxxxxxxxxxxxxxxxxxxx');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('pending_confirm_not_found');
  });

  test('GET /oauth/confirm/preview surfaces REUSED as HTTP 400 once the row has been consumed', async () => {
    const { token } = seedPendingConfirm();
    // Consume via the domain module directly (same effect as POST /confirm).
    pendingConfirm.consumePendingConfirm({
      db,
      token,
      outcome: 'accepted',
    });
    const res = await request(app)
      .get(`/api/v1/oauth/confirm/preview?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('pending_confirm_reused');
  });

  // ------------------------------------------------------------------
  // POST /api/v1/oauth/confirm  (accept)
  // ------------------------------------------------------------------

  test('POST /oauth/confirm (accept) sets session.user and marks the row accepted', async () => {
    const { token, userId } = seedPendingConfirm();
    const res = await request(app)
      .post('/api/v1/oauth/confirm')
      .send({ token })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user).toEqual(
      expect.objectContaining({
        id: userId,
        email: 'alice@example.com',
      })
    );

    const row = db
      .prepare('SELECT used_at, outcome FROM oauth_pending_logins WHERE token = ?')
      .get(token);
    expect(row.used_at).not.toBeNull();
    expect(row.outcome).toBe('accepted');
  });

  test('POST /oauth/confirm (accept) does NOT read req.session.oauth_confirm — session-free', async () => {
    // The legacy handler required a matching `req.session.oauth_confirm`
    // to be written by a previous request on the same cookie jar. Under
    // T3.7 the DB row is SSOT, so a first-time request with ONLY the
    // token in the body must succeed.
    const agent = request.agent(app); // fresh cookie jar, no prior writes
    const { token } = seedPendingConfirm();
    const res = await agent
      .post('/api/v1/oauth/confirm')
      .send({ token })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('POST /oauth/confirm (accept) stamps first_confirmed_at on user_identity_links', async () => {
    // F4 (ADR-0018): first-seen identity state moved from oauth_tokens to
    // user_identity_links. The confirm-accept endpoint now writes the
    // identity-link row (creating if absent) and stamps
    // first_confirmed_at, without touching oauth_tokens at all for
    // login-mode confirms.
    const { token, userId, providerSubject, serviceName } =
      seedPendingConfirm();

    const res = await request(app)
      .post('/api/v1/oauth/confirm')
      .send({ token })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);

    const row = db
      .prepare(
        `SELECT provider, provider_subject, first_confirmed_at
           FROM user_identity_links WHERE provider = ? AND user_id = ?`
      )
      .get(serviceName, userId);
    expect(row).toBeTruthy();
    expect(row.provider_subject).toBe(providerSubject);
    expect(row.first_confirmed_at).not.toBeNull();
  });

  test('POST /oauth/confirm replay is rejected as REUSED', async () => {
    const { token } = seedPendingConfirm();
    const first = await request(app)
      .post('/api/v1/oauth/confirm')
      .send({ token })
      .set('Content-Type', 'application/json');
    expect(first.status).toBe(200);
    const second = await request(app)
      .post('/api/v1/oauth/confirm')
      .send({ token })
      .set('Content-Type', 'application/json');
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('pending_confirm_reused');
  });

  test('POST /oauth/confirm unknown token surfaces NOT_FOUND as HTTP 400', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/confirm')
      .send({ token: 'not-a-real-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxx' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('pending_confirm_not_found');
  });

  test('POST /oauth/confirm expired token surfaces EXPIRED as HTTP 400', async () => {
    // Create a row that expires at t0 + 1s, then fake-expire it by
    // back-dating in the DB. (We can't inject `now` into the HTTP
    // handler, so we mutate the row directly.)
    const { token } = seedPendingConfirm();
    db.prepare(
      'UPDATE oauth_pending_logins SET expires_at = ? WHERE token = ?'
    ).run(new Date(Date.now() - 60_000).toISOString(), token);

    const res = await request(app)
      .post('/api/v1/oauth/confirm')
      .send({ token })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('pending_confirm_expired');
  });

  test('POST /oauth/confirm missing body.token returns 400', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/confirm')
      .send({})
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
  });

  // ------------------------------------------------------------------
  // POST /api/v1/oauth/confirm/reject
  // ------------------------------------------------------------------

  test('POST /oauth/confirm/reject burns the row with outcome=rejected and does NOT set session.user', async () => {
    const agent = request.agent(app);
    const { token } = seedPendingConfirm();
    const res = await agent
      .post('/api/v1/oauth/confirm/reject')
      .send({ token })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = db
      .prepare('SELECT used_at, outcome FROM oauth_pending_logins WHERE token = ?')
      .get(token);
    expect(row.used_at).not.toBeNull();
    expect(row.outcome).toBe('rejected');

    // A subsequent /auth/me on the same cookie jar must still be
    // unauthenticated (rejecting the confirm MUST NOT log anyone in).
    const me = await agent.get('/api/v1/auth/me');
    // /auth/me returns 401 when no session.user is present.
    expect([401, 403]).toContain(me.status);
  });

  test('POST /oauth/confirm/reject replay is rejected as REUSED', async () => {
    const { token } = seedPendingConfirm();
    const first = await request(app)
      .post('/api/v1/oauth/confirm/reject')
      .send({ token })
      .set('Content-Type', 'application/json');
    expect(first.status).toBe(200);
    const second = await request(app)
      .post('/api/v1/oauth/confirm/reject')
      .send({ token })
      .set('Content-Type', 'application/json');
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('pending_confirm_reused');
  });

  test('POST /oauth/confirm/reject unknown token surfaces NOT_FOUND as HTTP 400', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/confirm/reject')
      .send({ token: 'not-a-real-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxx' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('pending_confirm_not_found');
  });

  test('POST /oauth/confirm/reject missing body.token returns 400', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/confirm/reject')
      .send({})
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
  });
});
