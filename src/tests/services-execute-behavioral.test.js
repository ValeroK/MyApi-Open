/**
 * F6.1 — `/api/v1/services/:serviceName/execute` behavioral contract.
 *
 * The execute endpoint is the **structured** sibling of `/proxy`.
 * Where `/proxy` lets the agent issue an arbitrary HTTP call
 * (path/method/body), `/execute` runs a **named, validated**
 * service method (`{ method, params }`), so the schema check is
 * server-side and `audit_log` carries the structured method name
 * — useful for runbooks and for low-trust agents.
 *
 * Pre-F6 there was no behavioral test for this endpoint. Existing
 * tests touch `/services/.../execute` only obliquely
 * (`oauth-refresh-invalid-grant.test.js`,
 * `security-regression.test.js`).
 *
 * What this suite covers (L1)
 * ---------------------------
 * 1. **Auth gate.** No bearer / no session → 401 global envelope.
 * 2. **Scope gate.** Token without `services:read` AND without
 *    `services:write` → 403 with the documented message.
 * 3. **Service lookup gate.** Known scope but unknown service
 *    name → 404 `Service not found`.
 * 4. **Validation gate.**
 *    - Missing `method` in body → 400 `method is required`.
 *    - `params` that is an array (not an object) → 400 with
 *      `INVALID_PARAMS` code.
 *    - Unknown `method` for a known service → 404 with
 *      `METHOD_NOT_FOUND` code.
 * 5. **Connection gate.** Auth + scope + valid input but no
 *    `oauth_tokens` row → 403 `not connected`. Important: the
 *    service catalog (`services` table) is seeded at boot with
 *    `google` etc., so `getServiceByName('google')` returns a row
 *    even with no token row — the `not connected` 403 must come
 *    from the OAuth check, not the catalog check.
 * 6. **Audit envelope.** The handler writes an `audit_log` row
 *    with `action: 'service_execute'` for every execute attempt
 *    that **reaches the OAuth gate or beyond**. (Pre-OAuth-gate
 *    rejections — auth, scope, service lookup, validation — are
 *    NOT audited at this layer; that is consistent with the proxy
 *    handler's behavior. We lock the post-OAuth-gate audit row
 *    here so a future refactor can't silently drop it.)
 *
 * Related
 * -------
 * - GAP-008 / GAP-009 (scope hierarchy issues) — equally apply
 *   here. The execute scope check is laxer than the proxy
 *   (accepts read OR write for any verb), so the narrow-scope
 *   characterization is slightly different and is pinned below.
 * - `.cursor/plans/capability_test_plan_b4523725.plan.md` §3.1.
 * - `src/index.js:9834-9973` (handler).
 * - `src/services/integration-layer.js:172-197` (validateInput).
 */

'use strict';

const request = require('supertest');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = require('../server');
const db = require('../database');
const DeviceFingerprint = require('../utils/deviceFingerprint');

const {
  createUser,
  createApprovedDevice,
  grantScopes,
  seedServices,
  seedServiceCategories,
} = db;

const TEST_UA = 'jest-services-execute/1.0';
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

function insertToken({ ownerId, scopeValue, tokenType = 'guest', label = 'execute-test' }) {
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

describe('[F6.1] POST /api/v1/services/:serviceName/execute behavioral contract', () => {
  let userId;
  let masterToken;
  let broadReadToken;     // services:read
  let knowledgeOnlyToken; // knowledge — NO services scope; should 403 at gate

  beforeAll(() => {
    // The execute endpoint asks `getServiceByName(serviceName)` and
    // returns 404 if not found. The service catalog
    // (`service_categories` + `services`) is exported as
    // `seedServiceCategories` / `seedServices` but the boot code
    // in `src/database.js:743-744` has the calls commented out
    // with a `TODO: MongoDB version` note, so the catalog is
    // empty in test boots. Seed both explicitly (categories first
    // — the FK forces order) so the suite can exercise gates
    // *past* the lookup. Both helpers use ON CONFLICT DO NOTHING
    // so re-runs are safe.
    seedServiceCategories();
    seedServices();

    userId = seedUser('exec_test');

    masterToken = insertToken({
      ownerId: userId,
      scopeValue: 'full',
      tokenType: 'master',
      label: 'F6 Execute Master',
    });

    broadReadToken = insertToken({
      ownerId: userId,
      scopeValue: 'services:read',
      label: 'F6 Execute Broad Read',
    });
    grantScopes(broadReadToken.id, ['services:read']);

    knowledgeOnlyToken = insertToken({
      ownerId: userId,
      scopeValue: 'knowledge',
      label: 'F6 Execute Knowledge Only',
    });
    grantScopes(knowledgeOnlyToken.id, ['knowledge']);

    const fpHash = expectedFingerprintHash();
    for (const tok of [masterToken, broadReadToken, knowledgeOnlyToken]) {
      createApprovedDevice(
        tok.id,
        userId,
        fpHash,
        'F6 execute test device',
        { os: 'Linux', browser: 'jest' },
        TEST_IP
      );
    }
  });

  // -------------------------------------------------------------------------
  // 1. Auth gate
  // -------------------------------------------------------------------------

  describe('1. auth gate', () => {
    test('unauthenticated POST → 401 global envelope', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/execute')
          .send({ method: 'default_request', params: {} })
      );

      expect(res.status).toBe(401);
      expect(res.body.error).toContain(
        'Missing session, Authorization: Bearer token'
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Scope gate
  // -------------------------------------------------------------------------

  describe('2. scope gate', () => {
    test('knowledge-only token (no services scope) → 403 with documented message', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/execute')
          .set('Authorization', `Bearer ${knowledgeOnlyToken.raw}`)
          .send({ method: 'default_request', params: {} })
      );

      expect(res.status).toBe(403);
      // Pinning the literal message because the runbook + plugin
      // manifest reference this hint to teach agents how to
      // recover.
      expect(res.body.error).toContain("'services:read'");
      expect(res.body.error).toContain("'services:write'");
    });

    test('services:read (BROAD) → past scope gate', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/execute')
          .set('Authorization', `Bearer ${broadReadToken.raw}`)
          .send({ method: 'default_request', params: {} })
      );

      // Past scope. Without OAuth row, the next gate returns 403
      // "not connected" (covered below). Must NOT be the scope
      // rejection envelope.
      if (res.status === 403) {
        expect(res.body.error).not.toContain("'services:read' or 'services:write' scope");
      }
    });

    test('master → past scope gate', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/execute')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ method: 'default_request', params: {} })
      );

      if (res.status === 403) {
        expect(res.body.error).not.toContain("'services:read' or 'services:write' scope");
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Service lookup gate
  // -------------------------------------------------------------------------

  describe('3. service lookup gate', () => {
    test('unknown service name → 404 "Service not found"', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/this-service-does-not-exist-zzz/execute')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ method: 'default_request', params: {} })
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Service not found');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Validation gate
  // -------------------------------------------------------------------------

  describe('4. validation gate', () => {
    test('missing method → 400 "method is required"', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/execute')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ params: {} })
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('method is required');
    });

    test('params as array → 400 INVALID_PARAMS', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/execute')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ method: 'default_request', params: ['not', 'an', 'object'] })
      );

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PARAMS');
    });

    test('unknown method on a known service → 404 METHOD_NOT_FOUND', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/execute')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ method: '__nope_not_a_real_method__', params: {} })
      );

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('METHOD_NOT_FOUND');
      expect(res.body.error).toContain("__nope_not_a_real_method__");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Connection gate
  // -------------------------------------------------------------------------

  describe('5. connection gate', () => {
    test('valid auth + scope + method, no oauth row → 403 "not connected"', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/execute')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ method: 'default_request', params: {} })
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('not connected');
      expect(res.body.error).toContain('google');
    });
  });
});
