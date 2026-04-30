/**
 * F3 Pass 4 (ADR-0022) — connected-account display contract.
 *
 * Pins the user-visible gap closed by Pass 4: when a MyApi user
 * connects a service grant from a *different* provider account than
 * their login account (e.g. logs in as alice@personal.gmail.com but
 * connects Drive using alice@work.gmail.com), the dashboard MUST
 * surface "Connected as alice@work.gmail.com" beneath the Google
 * service card. This is what makes multi-account behaviour visible
 * to the user instead of silent.
 *
 * This suite covers the data path end-to-end:
 *
 *   1. `storeOAuthToken(..., providerSubject, connectedEmail)` writes
 *      `oauth_tokens.connected_email` and `getOAuthToken(...)` returns
 *      it as `connectedEmail`.
 *
 *   2. `GET /api/v1/oauth/status` exposes `connectedEmail` per service
 *      so the SPA can render it without a separate API call.
 *
 *   3. Multi-account independence: a `user_identity_links` row written
 *      with the LOGIN email is NOT mutated when a service-grant store
 *      writes a DIFFERENT email to `oauth_tokens.connected_email`.
 *      This is the behaviour the user explicitly asked for —
 *      "enable connecting a service with a different user from the
 *      login user."
 *
 *   4. Email is normalised (trimmed + lower-cased) on write, so casing
 *      drift between id_token claims and userinfo responses doesn't
 *      produce two visually-different "Connected as ..." strings.
 *
 * The connect-callback's *capture* of email from `verifyToken` /
 * id_token is exercised via unit-level static checks in
 * `oauth-connect-no-email-graceful.test.js` (graceful degradation when
 * the provider response carries no email) and the static tripwire
 * added in `security-regression.test.js`. Together they pin the full
 * surface.
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
process.env.GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || 'test-google-client-secret';
process.env.GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  'http://localhost:4500/api/v1/oauth/callback/google';

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const request = require('supertest');

const ts = Date.now();
process.env.DB_PATH = path.join(
  __dirname,
  `tmp-oauth-connect-account-display-${ts}.sqlite`
);
if (fs.existsSync(process.env.DB_PATH)) {
  try { fs.unlinkSync(process.env.DB_PATH); } catch (_) { /* ignore */ }
}

const dbApi = require('../database');
dbApi.initDatabase();
const { db, storeOAuthToken, getOAuthToken, createUser } = dbApi;
const { upsertIdentityLink } = require('../domain/oauth/identity-links');

const { app } = require('../index');

// Bypass the device-approval gate by stamping an approved-device row
// for our master token. Mirrors the helper shape used by
// services-proxy-behavioral.test.js.
const DeviceFingerprint = require('../utils/deviceFingerprint');
const TEST_UA = 'jest-oauth-connect-display/1.0';
const TEST_IP = '127.0.0.1';

function expectedFingerprintHash() {
  return DeviceFingerprint.fromRequest({
    headers: {
      'user-agent': TEST_UA,
      'accept-language': 'en-US',
      'x-forwarded-for': TEST_IP,
    },
    hostname: '127.0.0.1',
    socket: { remoteAddress: TEST_IP },
  }).fingerprintHash;
}

function withTestHeaders(req) {
  return req
    .set('User-Agent', TEST_UA)
    .set('X-Forwarded-For', TEST_IP)
    .set('Accept-Language', 'en-US');
}

function seedUser(label) {
  const suffix = crypto.randomBytes(4).toString('hex');
  return createUser(
    `${label}_${suffix}`,
    `${label} test`,
    `${label}+${suffix}@example.com`,
    'UTC',
    'Password123!'
  ).id;
}

function insertMasterToken(ownerId) {
  const raw = 'myapi_test_' + crypto.randomBytes(32).toString('hex');
  const hash = bcrypt.hashSync(raw, 10);
  const id = 'tok_' + crypto.randomBytes(8).toString('hex');
  db
    .prepare(
      `
    INSERT INTO access_tokens (id, hash, owner_id, scope, label, created_at, token_type, requires_approval, allowed_resources)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
  `
    )
    .run(
      id,
      hash,
      ownerId,
      'full',
      'F3 Pass 4 connect-display test',
      new Date().toISOString(),
      'master'
    );
  return { id, raw };
}

describe('[F3 Pass 4 / ADR-0022] connected-account email is persisted and surfaced', () => {
  let userId;
  let master;

  beforeAll(() => {
    userId = seedUser('connect_display');
    master = insertMasterToken(userId);
    dbApi.createApprovedDevice(
      master.id,
      userId,
      expectedFingerprintHash(),
      'F3 Pass 4 connect-display test device',
      { os: 'Linux', browser: 'jest' },
      TEST_IP
    );
  });

  beforeEach(() => {
    db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(userId);
  });

  afterAll(() => {
    try { db.close(); } catch (_) { /* ignore */ }
    if (process.env.DB_PATH && fs.existsSync(process.env.DB_PATH)) {
      try { fs.unlinkSync(process.env.DB_PATH); } catch (_) { /* ignore */ }
    }
  });

  test('storeOAuthToken persists connected_email and getOAuthToken returns connectedEmail', () => {
    storeOAuthToken(
      'google',
      userId,
      'access-token-fixture',
      'refresh-token-fixture',
      new Date(Date.now() + 3600_000).toISOString(),
      'openid email profile https://www.googleapis.com/auth/drive.file',
      'google-sub-fixture-99999',
      'alice@work.gmail.com'
    );

    const persisted = getOAuthToken('google', userId);
    expect(persisted).toBeTruthy();
    expect(persisted.connectedEmail).toBe('alice@work.gmail.com');
    expect(persisted.providerSubject).toBe('google-sub-fixture-99999');

    const rawRow = db
      .prepare('SELECT connected_email FROM oauth_tokens WHERE service_name = ? AND user_id = ?')
      .get('google', userId);
    expect(rawRow.connected_email).toBe('alice@work.gmail.com');
  });

  test('storeOAuthToken normalises email casing (trim + lower-case) on write', () => {
    storeOAuthToken(
      'google',
      userId,
      'access-token-fixture',
      null,
      null,
      'gmail.modify',
      'sub-x',
      '  Alice@Work.Gmail.COM  '
    );

    const persisted = getOAuthToken('google', userId);
    expect(persisted.connectedEmail).toBe('alice@work.gmail.com');
  });

  test('storeOAuthToken on UPDATE preserves connected_email when called with null (COALESCE semantics)', () => {
    storeOAuthToken(
      'google',
      userId,
      'access-1',
      'refresh-1',
      null,
      'gmail.modify',
      'sub-1',
      'alice@work.gmail.com'
    );

    // Refresh-style call: same {service, user}, fresh tokens, but no
    // identity re-fetch → null email arg. The stored email must NOT
    // be wiped.
    storeOAuthToken(
      'google',
      userId,
      'access-2',
      'refresh-2',
      null,
      'gmail.modify',
      null,
      null
    );

    const after = getOAuthToken('google', userId);
    expect(after.connectedEmail).toBe('alice@work.gmail.com');
    expect(after.accessToken).toBe('access-2');
  });

  test('GET /api/v1/oauth/status surfaces connectedEmail per service', async () => {
    storeOAuthToken(
      'google',
      userId,
      'access-token-fixture',
      'refresh-token-fixture',
      new Date(Date.now() + 3600_000).toISOString(),
      'gmail.modify',
      'sub-google',
      'alice@work.gmail.com'
    );
    storeOAuthToken(
      'github',
      userId,
      'gh-access-token-fixture',
      'gh-refresh-token-fixture',
      new Date(Date.now() + 3600_000).toISOString(),
      'repo',
      '99001',
      'alice@personal.example'
    );

    const res = await withTestHeaders(
      request(app)
        .get('/api/v1/oauth/status')
        .set('Authorization', `Bearer ${master.raw}`)
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.services)).toBe(true);

    const google = res.body.services.find((s) => s.name === 'google');
    expect(google).toBeTruthy();
    expect(google.status).toBe('connected');
    expect(google.connectedEmail).toBe('alice@work.gmail.com');

    const github = res.body.services.find((s) => s.name === 'github');
    expect(github).toBeTruthy();
    expect(github.status).toBe('connected');
    expect(github.connectedEmail).toBe('alice@personal.example');

    // Disconnected services have connectedEmail = null (not undefined,
    // so the UI's `service.connectedEmail && ...` short-circuit is
    // safe in either case).
    const facebook = res.body.services.find((s) => s.name === 'facebook');
    if (facebook && facebook.status === 'disconnected') {
      expect(facebook.connectedEmail == null).toBe(true);
    }
  });

  test('multi-account: identity link (login email) and service grant (connected email) are independent', () => {
    // Seed an existing identity-link row for the LOGIN email — same
    // user_id, same provider, but a different provider_subject and
    // email than the service grant about to be written.
    upsertIdentityLink({
      db,
      userId,
      provider: 'google',
      providerSubject: 'google-sub-LOGIN-11111',
      email: 'alice@personal.gmail.com',
      now: new Date().toISOString(),
    });

    // Now run the service-connect store with a DIFFERENT provider
    // account (different sub, different email).
    storeOAuthToken(
      'google',
      userId,
      'service-access',
      'service-refresh',
      new Date(Date.now() + 3600_000).toISOString(),
      'openid email profile https://www.googleapis.com/auth/drive.file',
      'google-sub-WORK-99999',
      'alice@work.gmail.com'
    );

    // user_identity_links: LOGIN row UNCHANGED.
    const linkRow = db
      .prepare(
        'SELECT provider_subject, email FROM user_identity_links WHERE user_id = ? AND provider = ?'
      )
      .get(userId, 'google');
    expect(linkRow).toBeTruthy();
    expect(linkRow.provider_subject).toBe('google-sub-LOGIN-11111');
    expect(linkRow.email).toBe('alice@personal.gmail.com');

    // oauth_tokens: SERVICE row carries the WORK identity.
    const tokenRow = db
      .prepare(
        'SELECT provider_subject, connected_email FROM oauth_tokens WHERE user_id = ? AND service_name = ?'
      )
      .get(userId, 'google');
    expect(tokenRow).toBeTruthy();
    expect(tokenRow.provider_subject).toBe('google-sub-WORK-99999');
    expect(tokenRow.connected_email).toBe('alice@work.gmail.com');
  });
});
