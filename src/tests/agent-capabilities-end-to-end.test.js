/**
 * F6.1 — Agent capabilities end-to-end composite.
 *
 * The other 7 L1 suites (`google-mount-auth-posture`,
 * `agent-discovery-contract`, `services-proxy-behavioral`,
 * `services-execute-behavioral`, `ask-endpoint-behavioral`,
 * `handshake-flow-behavioral`, `connectors-master-only`) each
 * pin one slice of the agent surface in isolation. This composite
 * walks the **single trajectory** an external agent (OpenClaude /
 * Hermes / etc.) actually takes the first time it talks to MyApi:
 *
 *   1. Discover — `GET /openapi.json` (no auth).
 *   2. Mint — owner posts `POST /api/v1/tokens` with a narrow
 *      scope to produce an "agent token".
 *   3. Capabilities — agent calls `/capabilities` and
 *      `/tokens/me/capabilities` with the scoped bearer; the
 *      manifest narrows to the granted scope; introspection
 *      surfaces `tokenId` / `scope` but never the raw token.
 *   4. Use — agent calls `/services/google/proxy` and gets a
 *      clean 403 `not connected` (no OAuth row exists). This
 *      proves credential custody: the agent can ATTEMPT the
 *      surface but cannot get any third-party data without the
 *      owner connecting Google.
 *   5. Boundary — agent CANNOT call master-only endpoints
 *      (`gateway/context`, `connectors`, `audit`, token mint).
 *
 * Why a composite suite (vs. relying on the slice suites)
 * -------------------------------------------------------
 * Slice suites each seed their own access tokens directly via
 * the test helper `insertToken` + `grantScopes`. That bypasses
 * the public mint API. A future bug in `POST /api/v1/tokens`
 * (e.g. scope-narrowing regression, accidental owner_id leak,
 * raw-token-in-list-response) would be invisible to the slice
 * suites because they never call mint. This composite is the
 * one suite that actually exercises mint AND uses the minted
 * token end-to-end.
 *
 * Related
 * -------
 * - `.cursor/plans/capability_test_plan_b4523725.plan.md` §3.1.
 * - `src/index.js:5110-5219` (POST /api/v1/tokens).
 * - GAP-008 — pinned indirectly by step 4 (the test mints a
 *   BROAD `services:read` token because the narrow form is a
 *   no-op on the proxy today; see ledger).
 */

'use strict';

const request = require('supertest');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = require('../server');
const db = require('../database');
const DeviceFingerprint = require('../utils/deviceFingerprint');

const { createUser, createApprovedDevice } = db;

const TEST_UA = 'jest-agent-e2e/1.0';
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

function insertMasterToken(ownerId) {
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
    .run(id, hash, ownerId, 'full', 'F6 e2e Master', new Date().toISOString(), 'master');
  return { id, raw };
}

describe('[F6.1] Agent capabilities end-to-end composite', () => {
  let userId;
  let masterToken;
  let agentToken;        // raw value, returned from POST /tokens
  let agentTokenId;      // id, captured from the same response
  let fpHash;

  beforeAll(() => {
    userId = seedUser('e2e_owner');
    masterToken = insertMasterToken(userId);
    fpHash = expectedFingerprintHash();
    createApprovedDevice(
      masterToken.id,
      userId,
      fpHash,
      'F6 e2e master device',
      { os: 'Linux', browser: 'jest' },
      TEST_IP
    );
  });

  // -------------------------------------------------------------------------
  // 1. Discover (public)
  // -------------------------------------------------------------------------

  test('1. discover — GET /openapi.json (no auth) → 200 with paths', async () => {
    const res = await withTestHeaders(request(app).get('/openapi.json'));
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(typeof res.body.paths).toBe('object');
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(5);
  });

  // -------------------------------------------------------------------------
  // 2. Mint (master)
  // -------------------------------------------------------------------------

  test('2. mint — POST /api/v1/tokens with services:read produces a usable agent token', async () => {
    const res = await withTestHeaders(
      request(app)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${masterToken.raw}`)
        .send({
          label: 'F6 e2e Agent',
          // Broad `services:read` scope — see GAP-008 in the
          // ledger for why narrow `services:google:read` would
          // be a no-op today. The composite uses the broad form
          // because that's what actually works against the proxy.
          scopes: ['services:read'],
          description: 'F6 end-to-end composite agent',
        })
    );

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(typeof res.body.data.id).toBe('string');
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.token).toMatch(/^myapi_[a-f0-9]+$/);
    expect(Array.isArray(res.body.data.scopes)).toBe(true);
    expect(res.body.data.scopes).toContain('services:read');

    agentTokenId = res.body.data.id;
    agentToken = res.body.data.token;

    // Pre-approve the test device for the new token so device-
    // approval middleware doesn't block the next steps. Real
    // agents go through the full approval flow; the L1 composite
    // assumes it has already happened (the L3 runbook covers it
    // end-to-end against `docker:smoke`).
    createApprovedDevice(
      agentTokenId,
      userId,
      fpHash,
      'F6 e2e agent device',
      { os: 'Linux', browser: 'jest' },
      TEST_IP
    );
  });

  test('2.b. non-master cannot mint (token used as if scoped) — 403', async () => {
    // Re-use the agent token (services:read) to ATTEMPT another
    // mint. The handler must reject before issuance.
    expect(agentToken).toBeDefined();
    const res = await withTestHeaders(
      request(app)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ label: 'should-fail', scopes: ['services:read'] })
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('master');
  });

  test('2.c. mint with no scopes → 400', async () => {
    const res = await withTestHeaders(
      request(app)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${masterToken.raw}`)
        .send({ label: 'no-scope' })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('scopes');
  });

  // -------------------------------------------------------------------------
  // 3. Capabilities (agent)
  // -------------------------------------------------------------------------

  test('3.a capabilities — /capabilities is narrowed to the agent scope', async () => {
    expect(agentToken).toBeDefined();
    const res = await withTestHeaders(
      request(app)
        .get('/api/v1/capabilities')
        .set('Authorization', `Bearer ${agentToken}`)
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.endpoints)).toBe(true);

    const allUrls = res.body.endpoints.map((e) => e.url || '');
    // services:read does NOT carry knowledge / memory / admin,
    // so those manifest groups must not appear.
    for (const banned of [
      '/api/v1/memory',
      '/api/v1/brain/knowledge-base',
    ]) {
      const hit = allUrls.find((u) => u.startsWith(banned));
      expect(hit).toBeUndefined();
    }
  });

  test('3.b introspection — /tokens/me/capabilities echoes scope, never the raw token', async () => {
    expect(agentToken).toBeDefined();
    const res = await withTestHeaders(
      request(app)
        .get('/api/v1/tokens/me/capabilities')
        .set('Authorization', `Bearer ${agentToken}`)
    );

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(
      expect.objectContaining({
        tokenId: agentTokenId,
        authType: 'bearer',
      })
    );

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(agentToken);
    expect(serialized).not.toMatch(/\$2[aby]\$/); // no bcrypt hash
  });

  // -------------------------------------------------------------------------
  // 4. Use (agent reaches proxy past auth + scope; gets clean 403 no-conn)
  // -------------------------------------------------------------------------

  test('4. use — agent proxy GET reaches connection gate (clean 403 not connected)', async () => {
    expect(agentToken).toBeDefined();
    const res = await withTestHeaders(
      request(app)
        .post('/api/v1/services/google/proxy')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ path: '/gmail/v1/users/me/profile', method: 'GET' })
    );

    // The cardinal property: the agent's request is rejected
    // because Google is not connected — NOT because of auth or
    // scope. This proves the agent successfully traversed the
    // auth gate, the scope gate, and the input-validation gate
    // for a real outbound surface, and that credential custody
    // is intact (no token in body even at this gate).
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('not connected');
    expect(JSON.stringify(res.body)).not.toContain(agentToken);
  });

  // -------------------------------------------------------------------------
  // 5. Boundary (agent cannot reach master-only endpoints)
  // -------------------------------------------------------------------------

  describe('5. boundary — master-only endpoints reject the agent', () => {
    test('GET /api/v1/gateway/context → 403 master-only', async () => {
      expect(agentToken).toBeDefined();
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/gateway/context')
          .set('Authorization', `Bearer ${agentToken}`)
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('master');
    });

    test('GET /api/v1/connectors → 403', async () => {
      expect(agentToken).toBeDefined();
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/connectors')
          .set('Authorization', `Bearer ${agentToken}`)
      );
      expect(res.status).toBe(403);
    });

    test('GET /api/v1/audit → 403 master-only', async () => {
      expect(agentToken).toBeDefined();
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/audit')
          .set('Authorization', `Bearer ${agentToken}`)
      );
      expect(res.status).toBe(403);
    });

    test('POST /api/v1/handshakes/:id/approve → 403 master-only', async () => {
      // We don't have a handshake to point at; that's fine — the
      // master-only gate fires before the lookup, so any string
      // works.
      expect(agentToken).toBeDefined();
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/handshakes/hs_anything/approve')
          .set('Authorization', `Bearer ${agentToken}`)
          .send({})
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('master');
    });
  });
});
