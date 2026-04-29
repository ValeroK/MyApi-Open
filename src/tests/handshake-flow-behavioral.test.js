/**
 * F6.1 — Handshake flow behavioral contract.
 *
 * The handshake endpoints are how an agent **with no credentials**
 * onboards itself: the agent posts an access request to a public
 * endpoint, the owner approves out-of-band, the owner shares the
 * resulting scoped token with the agent. This is the only
 * agent-facing surface that handles a "pre-token" identity.
 *
 * Pre-F6 the handshake endpoints had no behavioral coverage.
 *
 * What this suite covers (L1)
 * ---------------------------
 * 1. **Public POST.** `POST /api/v1/handshakes` requires no auth
 *    (it is the bootstrap for an agent with no token). Validates
 *    `agentId`, `requestedScopes`, `message`, and rejects
 *    out-of-bound input.
 * 2. **Public status poll.** `GET /api/v1/handshakes/:id/status`
 *    requires no auth and **must not** leak the issued token in
 *    any state.
 * 3. **Master-only listing / approval / denial / revocation.**
 *    Each non-public handshake endpoint returns 403 to a non-
 *    master token (covers `services:read` since that's the most
 *    common agent token).
 * 4. **End-to-end happy path.** Agent posts → polls (pending) →
 *    master approves → master receives the new token in the
 *    approve response → agent re-polls and sees status=approved
 *    BUT no token in the body.
 * 5. **GAP-005 characterization.** The created handshake row
 *    carries `user_id = 'owner'` literal (not the master's
 *    actual userId). Pinned with an explicit comment so the M6
 *    multi-tenancy fix produces a visible diff.
 * 6. **GAP-011 surfacing.** Two `GET /handshakes/:id/status`
 *    handlers are registered (`src/index.js:7778` and `:7847`).
 *    Express 5 routing reaches only the first. The second is
 *    unreachable. Logged below; static gate locks the count at
 *    today's two so we don't accidentally add a third without a
 *    deliberate fix.
 *
 * Related
 * -------
 * - `.context/capability-gaps.md` (GAP-005, GAP-011 added by
 *   this suite).
 * - `.cursor/plans/capability_test_plan_b4523725.plan.md` §3.1.
 * - `src/index.js:7750-7853` (handler block).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = require('../server');
const db = require('../database');
const DeviceFingerprint = require('../utils/deviceFingerprint');

const { createUser, createApprovedDevice, grantScopes } = db;

const SERVER_ENTRY = path.resolve(__dirname, '..', 'index.js');

const TEST_UA = 'jest-handshake/1.0';
const TEST_IP = '127.0.0.1';

function withTestHeaders(req) {
  return req
    .set('User-Agent', TEST_UA)
    .set('X-Forwarded-For', TEST_IP)
    .set('Accept-Language', 'en-US');
}

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

function insertToken({ ownerId, scopeValue, tokenType = 'guest', label = 'handshake-test' }) {
  const raw = 'myapi_test_' + crypto.randomBytes(32).toString('hex');
  const hash = bcrypt.hashSync(raw, 10);
  const id = 'tok_' + crypto.randomBytes(8).toString('hex');
  db.db
    .prepare(
      `
    INSERT INTO access_tokens (id, hash, owner_id, scope, label, created_at, token_type, requires_approval, allowed_resources)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
  `
    )
    .run(id, hash, ownerId, scopeValue, label, new Date().toISOString(), tokenType);
  return { id, raw };
}

describe('[F6.1] /api/v1/handshakes flow behavioral contract', () => {
  let userId;
  let masterToken;
  let scopedToken; // services:read; non-master, used as "agent" token

  beforeAll(() => {
    userId = seedUser('hs_test');

    masterToken = insertToken({
      ownerId: userId,
      scopeValue: 'full',
      tokenType: 'master',
      label: 'F6 Handshake Master',
    });
    scopedToken = insertToken({
      ownerId: userId,
      scopeValue: 'services:read',
      label: 'F6 Handshake Scoped',
    });
    grantScopes(scopedToken.id, ['services:read']);

    const fpHash = expectedFingerprintHash();
    for (const tok of [masterToken, scopedToken]) {
      createApprovedDevice(
        tok.id,
        userId,
        fpHash,
        'F6 handshake test device',
        { os: 'Linux', browser: 'jest' },
        TEST_IP
      );
    }
  });

  // -------------------------------------------------------------------------
  // 1. Public POST validation
  // -------------------------------------------------------------------------

  describe('1. POST /api/v1/handshakes (public)', () => {
    test('no auth + valid body → 201 with handshakeId + status pending', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({
            agentId: 'f6-agent-' + crypto.randomBytes(4).toString('hex'),
            requestedScopes: ['read'],
            message: 'F6 L1 walkthrough',
          })
      );

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(typeof res.body.data.handshakeId).toBe('string');
      expect(res.body.data.status).toBe('pending');
      // The 201 envelope MUST NOT carry a token.
      const serialized = JSON.stringify(res.body);
      expect(serialized.toLowerCase()).not.toContain('"token"');
    });

    test('missing agentId → 400', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({ requestedScopes: ['read'] })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('agentId');
    });

    test('missing requestedScopes → 400', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({ agentId: 'f6-bad' })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('requestedScopes');
    });

    test('requestedScopes not an array → 400', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({ agentId: 'f6-bad', requestedScopes: 'read' })
      );
      expect(res.status).toBe(400);
    });

    test('out-of-allowlist scope → 400 with documented allow-list', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({
            agentId: 'f6-bad-scope',
            requestedScopes: ['admin:*'],
          })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid scopes');
      expect(res.body.error).toContain('admin:*');
      expect(res.body.error).toContain('read');
    });

    test('agentId too long → 400', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({
            agentId: 'a'.repeat(257),
            requestedScopes: ['read'],
          })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('256 chars');
    });

    test('too many scopes → 400', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({
            agentId: 'f6-spam',
            requestedScopes: Array(11).fill('read'),
          })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Too many');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Public status poll
  // -------------------------------------------------------------------------

  describe('2. GET /api/v1/handshakes/:id/status (public)', () => {
    let handshakeId;

    beforeAll(async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({
            agentId: 'f6-poll-' + crypto.randomBytes(4).toString('hex'),
            requestedScopes: ['read'],
            message: 'poll test',
          })
      );
      handshakeId = res.body.data.handshakeId;
    });

    test('no auth → 200 with status only, NEVER the token', async () => {
      const res = await withTestHeaders(
        request(app).get(`/api/v1/handshakes/${handshakeId}/status`)
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.handshakeId).toBe(handshakeId);
      expect(['pending', 'approved', 'denied']).toContain(res.body.data.status);

      const serialized = JSON.stringify(res.body);
      // Cardinal property: the public poll endpoint MUST NOT
      // carry the issued bearer token in any field, regardless
      // of state. The owner shares the token out-of-band; the
      // poll surface only carries status.
      expect(serialized.toLowerCase()).not.toContain('"token"');
      expect(serialized.toLowerCase()).not.toContain('"raw');
      expect(serialized).not.toMatch(/myapi_[a-z0-9_]+_[a-f0-9]{32,}/);
    });

    test('unknown handshake id → 404', async () => {
      const res = await withTestHeaders(
        request(app).get('/api/v1/handshakes/hs_does_not_exist/status')
      );
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Master-only mutations
  // -------------------------------------------------------------------------

  describe('3. master-only mutations', () => {
    let pendingId;

    beforeEach(async () => {
      // Fresh handshake per mutation test so each can act on a
      // pending row without cross-contamination.
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({
            agentId: 'f6-mut-' + crypto.randomBytes(4).toString('hex'),
            requestedScopes: ['read'],
          })
      );
      pendingId = res.body.data.handshakeId;
    });

    test('GET /handshakes (list) requires master', async () => {
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/handshakes')
          .set('Authorization', `Bearer ${scopedToken.raw}`)
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('master');
    });

    test('POST /handshakes/:id/approve requires master', async () => {
      const res = await withTestHeaders(
        request(app)
          .post(`/api/v1/handshakes/${pendingId}/approve`)
          .set('Authorization', `Bearer ${scopedToken.raw}`)
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('master');
    });

    test('POST /handshakes/:id/deny requires master', async () => {
      const res = await withTestHeaders(
        request(app)
          .post(`/api/v1/handshakes/${pendingId}/deny`)
          .set('Authorization', `Bearer ${scopedToken.raw}`)
      );
      expect(res.status).toBe(403);
    });

    test('POST /handshakes/:id/revoke requires master', async () => {
      const res = await withTestHeaders(
        request(app)
          .post(`/api/v1/handshakes/${pendingId}/revoke`)
          .set('Authorization', `Bearer ${scopedToken.raw}`)
      );
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // 4. End-to-end happy path
  // -------------------------------------------------------------------------

  describe('4. end-to-end happy path', () => {
    test('post → poll(pending) → master approve → master gets token; poll still token-free', async () => {
      const agentId = 'f6-e2e-' + crypto.randomBytes(4).toString('hex');

      // Agent posts (no auth)
      const create = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({
            agentId,
            requestedScopes: ['read'],
            message: 'F6 E2E walkthrough',
          })
      );
      expect(create.status).toBe(201);
      const handshakeId = create.body.data.handshakeId;

      // Agent polls (no auth) — pending
      const poll1 = await withTestHeaders(
        request(app).get(`/api/v1/handshakes/${handshakeId}/status`)
      );
      expect(poll1.status).toBe(200);
      expect(poll1.body.data.status).toBe('pending');

      // Master approves (auth required)
      const approve = await withTestHeaders(
        request(app)
          .post(`/api/v1/handshakes/${handshakeId}/approve`)
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({})
      );
      expect(approve.status).toBe(200);
      // The approve response IS allowed to carry the token —
      // that's how the owner shares it with the agent.
      expect(approve.body.data).toBeDefined();
      expect(typeof approve.body.data.token).toBe('string');
      expect(approve.body.data.token.length).toBeGreaterThan(20);
      expect(typeof approve.body.data.tokenId).toBe('string');
      expect(Array.isArray(approve.body.data.scopes)).toBe(true);

      const issuedToken = approve.body.data.token;

      // Agent re-polls (no auth) — approved BUT no token in body.
      const poll2 = await withTestHeaders(
        request(app).get(`/api/v1/handshakes/${handshakeId}/status`)
      );
      expect(poll2.status).toBe(200);
      expect(poll2.body.data.status).toBe('approved');
      const serialized2 = JSON.stringify(poll2.body);
      expect(serialized2).not.toContain(issuedToken);
      expect(serialized2.toLowerCase()).not.toContain('"token"');
    });
  });

  // -------------------------------------------------------------------------
  // 5. GAP-005 characterization
  // -------------------------------------------------------------------------

  describe('5. GAP-005 — handshake row carries literal "owner" for user_id', () => {
    test('every newly created handshake row has user_id = "owner"', async () => {
      // Pin GAP-005's current behavior. Once M6 multi-tenancy
      // lands and the handler threads the master's actual
      // userId, this test will fail and be the surface that
      // forces the fix to be deliberate.
      const created = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes')
          .send({
            agentId: 'f6-gap005-' + crypto.randomBytes(4).toString('hex'),
            requestedScopes: ['read'],
          })
      );
      const handshakeId = created.body.data.handshakeId;

      const row = db.db
        .prepare('SELECT user_id FROM handshakes WHERE id = ?')
        .get(handshakeId);
      expect(row).toBeDefined();
      expect(row.user_id).toBe('owner');
    });
  });

  // -------------------------------------------------------------------------
  // 6. GAP-011 surfacing
  // -------------------------------------------------------------------------

  describe('6. GAP-011 — duplicate /status handler surfacing', () => {
    test('exactly TWO `/handshakes/:id/status` handlers are registered (the second is unreachable)', async () => {
      // The first handler at src/index.js:7778 is the one Express
      // matches. The second at :7847 is dead code. We pin the
      // count at TWO so we don't *grow* the duplication, but we
      // also document the gap so a future cleanup deletes the
      // unreachable copy as a deliberate change. See GAP-011.
      const source = fs.readFileSync(SERVER_ENTRY, 'utf8');
      const matches =
        source.match(
          /app\.get\(\s*['"]\/api\/v1\/handshakes\/:id\/status['"]/g
        ) || [];
      expect(matches.length).toBe(2);
    });
  });
});
