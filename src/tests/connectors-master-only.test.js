/**
 * F6.1 — `/api/v1/connectors` master-only access contract.
 *
 * The connectors table is the storage substrate the F6.6 spike
 * (ADR-0020) builds on. This suite covers the **L1 access
 * boundary** — auth + scope gates, basic input validation, and
 * round-trip — without touching the schema-validation work that
 * F6.6 will land in `connectors-spike.test.js`.
 *
 * Today's surface (`src/index.js:6382-6401`):
 *   - `GET /api/v1/connectors`   master-only → 403 otherwise
 *   - `POST /api/v1/connectors`  master-only → 403 otherwise
 *
 * What this suite covers (L1)
 * ---------------------------
 * 1. **Auth gate.** Unauth on either method → 401 global envelope.
 * 2. **Scope gate.** Non-master token (e.g. `services:read`) → 403
 *    `Insufficient scope`.
 * 3. **Input validation (today).** Missing `type` or `label` →
 *    400 `type and label are required`.
 * 4. **Round-trip.** Master POST returns 201 with the new row;
 *    Master GET sees it back; the row's `config` JSON is
 *    persisted intact.
 *
 * What this suite does NOT cover (deferred to F6.6)
 * -------------------------------------------------
 * - `GenericOAuthAdapter`-shaped spec validation (no schema gate
 *   exists today; arbitrary `config` blobs are accepted).
 * - Malformed-spec → 400 (depends on schema gate; tracked in
 *   ADR-0020 §"Code changes required").
 * - Marketplace `connector` listing type — `GAP-004`.
 *
 * Related
 * -------
 * - `.context/decisions/ADR-0020-agent-defined-connectors-feasibility.md`
 * - `.context/capability-gaps.md` (GAP-004 cross-link).
 * - `.cursor/plans/capability_test_plan_b4523725.plan.md` §3.1, §4.
 */

'use strict';

const request = require('supertest');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = require('../server');
const db = require('../database');
const DeviceFingerprint = require('../utils/deviceFingerprint');

const { createUser, createApprovedDevice, grantScopes } = db;

const TEST_UA = 'jest-connectors/1.0';
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

function insertToken({ ownerId, scopeValue, tokenType = 'guest', label = 'connectors-test' }) {
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

describe('[F6.1] /api/v1/connectors master-only access contract', () => {
  let userId;
  let masterToken;
  let scopedToken;

  beforeAll(() => {
    userId = seedUser('conn_test');

    masterToken = insertToken({
      ownerId: userId,
      scopeValue: 'full',
      tokenType: 'master',
      label: 'F6 Connectors Master',
    });
    scopedToken = insertToken({
      ownerId: userId,
      scopeValue: 'services:read',
      label: 'F6 Connectors Scoped',
    });
    grantScopes(scopedToken.id, ['services:read']);

    const fpHash = expectedFingerprintHash();
    for (const tok of [masterToken, scopedToken]) {
      createApprovedDevice(
        tok.id,
        userId,
        fpHash,
        'F6 connectors test device',
        { os: 'Linux', browser: 'jest' },
        TEST_IP
      );
    }
  });

  // -------------------------------------------------------------------------
  // 1. Auth gate
  // -------------------------------------------------------------------------

  describe('1. auth gate', () => {
    test('unauthenticated GET → 401 global envelope', async () => {
      const res = await withTestHeaders(request(app).get('/api/v1/connectors'));
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Missing session, Authorization');
    });

    test('unauthenticated POST → 401 global envelope', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/connectors')
          .send({ type: 'oauth2', label: 'Test' })
      );
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Scope gate
  // -------------------------------------------------------------------------

  describe('2. scope gate', () => {
    test('scoped token GET → 403 Insufficient scope', async () => {
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/connectors')
          .set('Authorization', `Bearer ${scopedToken.raw}`)
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient scope');
    });

    test('scoped token POST → 403 Insufficient scope', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/connectors')
          .set('Authorization', `Bearer ${scopedToken.raw}`)
          .send({ type: 'oauth2', label: 'Test', config: {} })
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient scope');
    });

    test('scoped POST does NOT reach the database', async () => {
      // Defense in depth: a 403 must not leave a row behind. Pin
      // it so a future refactor that moves the scope check after
      // the insert is a visible failure.
      const beforeCount = db.db
        .prepare('SELECT count(*) as c FROM connectors')
        .get().c;

      await withTestHeaders(
        request(app)
          .post('/api/v1/connectors')
          .set('Authorization', `Bearer ${scopedToken.raw}`)
          .send({ type: 'oauth2', label: 'Should-Not-Persist' })
      );

      const afterCount = db.db
        .prepare('SELECT count(*) as c FROM connectors')
        .get().c;
      expect(afterCount).toBe(beforeCount);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Input validation (today's surface)
  // -------------------------------------------------------------------------

  describe('3. input validation', () => {
    test('master + missing type → 400', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/connectors')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ label: 'No-Type' })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('type and label are required');
    });

    test('master + missing label → 400', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/connectors')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ type: 'oauth2' })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('type and label are required');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Round-trip (master)
  // -------------------------------------------------------------------------

  describe('4. round-trip (master)', () => {
    test('POST creates the row; GET returns it; config persists intact', async () => {
      const uniqueLabel = 'F6 Round-Trip ' + crypto.randomBytes(4).toString('hex');
      const config = {
        // Shape is intentionally arbitrary today (no schema
        // gate). F6.6 / connectors-spike.test.js will exercise
        // the schema-validated path once it lands.
        authUrl: 'https://example.com/oauth/authorize',
        tokenUrl: 'https://example.com/oauth/token',
        apiRoot: 'https://api.example.com',
        scopes: ['read'],
      };

      const create = await withTestHeaders(
        request(app)
          .post('/api/v1/connectors')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ type: 'oauth2', label: uniqueLabel, config })
      );

      expect(create.status).toBe(201);
      expect(create.body.data).toBeDefined();
      expect(create.body.data.type).toBe('oauth2');
      expect(create.body.data.label).toBe(uniqueLabel);
      expect(create.body.data.config).toEqual(config);
      const id = create.body.data.id;
      expect(typeof id).toBe('string');

      const list = await withTestHeaders(
        request(app)
          .get('/api/v1/connectors')
          .set('Authorization', `Bearer ${masterToken.raw}`)
      );

      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.data)).toBe(true);
      const echoed = list.body.data.find((row) => row.id === id);
      expect(echoed).toBeDefined();
      expect(echoed.type).toBe('oauth2');
      expect(echoed.label).toBe(uniqueLabel);
      expect(echoed.config).toEqual(config);
      expect(echoed.active).toBe(true);
      expect(typeof echoed.createdAt).toBe('string');
    });
  });
});
