/**
 * F6.1 — Agent discovery contract.
 *
 * Pins the JSON shapes the agent (OpenClaude / Hermes / etc.) sees
 * the **first time** it talks to MyApi — these are the endpoints an
 * agent calls before it knows what else to call:
 *
 *   - `GET /openapi.json`                   (public; full spec)
 *   - `GET /api/v1/capabilities`            (auth required; per-token narrowed manifest)
 *   - `GET /api/v1/tokens/me/capabilities`  (auth required; token introspection + manifest)
 *   - `GET /api/v1/gateway/context`         (auth required; **master-only today** — see GAP-003)
 *
 * Why a contract test (vs. just snapshots)
 * ----------------------------------------
 * The pre-stage G0.1 snapshot already locks the *route surface*. This
 * suite locks the **per-scope semantic shape** — i.e. that a master
 * token sees vault-related entries while a `services:google:read`
 * token does not, and that the introspection endpoint never returns
 * raw token material. Snapshots can't express "for this scope, this
 * field must NOT contain X".
 *
 * Surfaces / characterizes
 * ------------------------
 * - GAP-003 in `.context/capability-gaps.md`:
 *   `GET /api/v1/gateway/context` returns 403 for a scoped agent
 *   token even though `llms.txt` (the AI plugin manifest) advertises
 *   it as the agent's first call. This suite **pins the current
 *   master-only behavior**; the product call to either loosen the
 *   gate or rewrite `llms.txt` happens outside F6.
 * - Token-material leak guard: `/tokens/me/capabilities` must
 *   surface `tokenId`, `scope`, `authType` — but never the raw token
 *   string, never the bcrypt hash, never the cached refresh token of
 *   any service.
 *
 * Related
 * -------
 * - `.context/capability-gaps.md` (GAP-003 characterization).
 * - `.cursor/plans/capability_test_plan_b4523725.plan.md` §3.1.
 * - `src/tests/scope-isolation.test.js` (token-seed pattern reused
 *   here inline; hoist if a third L1 suite needs it).
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
} = db;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_UA = 'jest-agent-discovery/1.0';
const TEST_IP = '127.0.0.1';

function withTestHeaders(req) {
  return req
    .set('User-Agent', TEST_UA)
    .set('X-Forwarded-For', TEST_IP)
    .set('Accept-Language', 'en-US');
}

function expectedFingerprintHash() {
  // Mirror the shape the deviceApproval middleware will derive at
  // request time. Pin to a single fingerprint for the whole suite so
  // we can pre-approve once.
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
  const user = createUser(
    `${label}_${suffix}`,
    `${label} test`,
    `${label}+${suffix}@example.com`,
    'UTC',
    'Password123!'
  );
  return user.id;
}

function insertToken({
  ownerId,
  scopeValue,
  tokenType = 'guest',
  label = 'agent-discovery-test',
}) {
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
    .run(
      id,
      hash,
      ownerId,
      scopeValue,
      label,
      new Date().toISOString(),
      tokenType
    );
  return { id, raw };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('[F6.1] Agent discovery contract', () => {
  let userId;
  let masterToken;   // scope: 'full', tokenType: 'master'
  let scopedToken;   // scope: 'services:google:read', tokenType: 'guest'
  let fpHash;

  beforeAll(() => {
    userId = seedUser('disc_master');

    masterToken = insertToken({
      ownerId: userId,
      scopeValue: 'full',
      tokenType: 'master',
      label: 'F6.1 Master',
    });

    scopedToken = insertToken({
      ownerId: userId,
      scopeValue: 'services:google:read',
      tokenType: 'guest',
      label: 'F6.1 Scoped Google read',
    });

    // Pre-approve the device fingerprint for both tokens so
    // deviceApprovalMiddleware does not gate the test surface.
    fpHash = expectedFingerprintHash();
    createApprovedDevice(
      masterToken.id,
      userId,
      fpHash,
      'F6 master test device',
      { os: 'Linux', browser: 'jest' },
      TEST_IP
    );
    createApprovedDevice(
      scopedToken.id,
      userId,
      fpHash,
      'F6 scoped test device',
      { os: 'Linux', browser: 'jest' },
      TEST_IP
    );
  });

  // -------------------------------------------------------------------------
  // /openapi.json — public discovery starting point
  // -------------------------------------------------------------------------

  describe('GET /openapi.json (public)', () => {
    test('returns 200 + a populated OpenAPI 3 document', async () => {
      const res = await withTestHeaders(request(app).get('/openapi.json'));

      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(typeof res.body.openapi).toBe('string');
      expect(res.body.openapi).toMatch(/^3\./);
      expect(res.body.info).toBeDefined();
      expect(typeof res.body.info.title).toBe('string');
      expect(res.body.paths).toBeDefined();
      expect(typeof res.body.paths).toBe('object');
      // The agent's main execution surface MUST be advertised.
      expect(Object.keys(res.body.paths).length).toBeGreaterThan(5);
    });

    test('does not require authentication', async () => {
      // Belt-and-braces: the spec is intentionally public per
      // src/index.js comment near 3884. Pin it.
      const res = await withTestHeaders(request(app).get('/openapi.json'));
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // /api/v1/capabilities — per-token narrowed manifest
  // -------------------------------------------------------------------------

  describe('GET /api/v1/capabilities', () => {
    test('without auth → 401 global envelope', async () => {
      const res = await withTestHeaders(
        request(app).get('/api/v1/capabilities')
      );
      expect(res.status).toBe(401);
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error).toContain(
        'Missing session, Authorization: Bearer token'
      );
    });

    test('master → returns auth + endpoints + scopes; includes vault entries', async () => {
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/capabilities')
          .set('Authorization', `Bearer ${masterToken.raw}`)
      );

      expect(res.status).toBe(200);
      expect(res.body.auth).toEqual({
        style: 'bearer-token',
        requiredHeaders: ['Authorization: Bearer <token>'],
      });
      expect(Array.isArray(res.body.endpoints)).toBe(true);
      expect(res.body.endpoints.length).toBeGreaterThan(3);

      // The capabilities builder gates vault-related entries on
      // `isMaster(req)` / `admin:*` (`buildCapabilitiesForRequest` at
      // src/index.js:3442+). The master must see them; the scoped
      // test below asserts the inverse.
      const allUrls = res.body.endpoints.map((e) => e.url);
      const seesMemoryOrKb = allUrls.some(
        (u) =>
          u && (u.startsWith('/api/v1/memory') ||
                u.startsWith('/api/v1/brain/knowledge-base'))
      );
      expect(seesMemoryOrKb).toBe(true);
    });

    test('scoped token (services:google:read) → narrowed manifest, no memory/KB/vault entries', async () => {
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/capabilities')
          .set('Authorization', `Bearer ${scopedToken.raw}`)
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.endpoints)).toBe(true);

      const allUrls = res.body.endpoints.map((e) => e.url || '');
      // Scoped Google-read does NOT carry `memory` / `knowledge` /
      // `admin:*`, so those endpoint groups must not appear.
      for (const banned of [
        '/api/v1/memory',
        '/api/v1/brain/knowledge-base',
      ]) {
        const offending = allUrls.filter((u) => u.startsWith(banned));
        expect(offending).toEqual([]);
      }
    });

    test('response never echoes the raw token string in any field', async () => {
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/capabilities')
          .set('Authorization', `Bearer ${masterToken.raw}`)
      );
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(masterToken.raw);
    });
  });

  // -------------------------------------------------------------------------
  // /api/v1/tokens/me/capabilities — token introspection
  // -------------------------------------------------------------------------

  describe('GET /api/v1/tokens/me/capabilities', () => {
    test('without auth → 401', async () => {
      const res = await withTestHeaders(
        request(app).get('/api/v1/tokens/me/capabilities')
      );
      expect(res.status).toBe(401);
    });

    test('master → exposes tokenId/scope/authType, NOT the raw token, NOT the hash', async () => {
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/tokens/me/capabilities')
          .set('Authorization', `Bearer ${masterToken.raw}`)
      );

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(
        expect.objectContaining({
          tokenId: masterToken.id,
          scope: 'full',
          authType: 'bearer',
        })
      );

      // Critical leak guards.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(masterToken.raw);
      // bcrypt hashes start with $2 and are 60 chars; a leak would
      // most likely surface as a $2a$... / $2b$... fragment.
      expect(serialized).not.toMatch(/\$2[aby]\$/);
    });

    test('scoped token → echoes the narrow scope verbatim', async () => {
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/tokens/me/capabilities')
          .set('Authorization', `Bearer ${scopedToken.raw}`)
      );

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(
        expect.objectContaining({
          tokenId: scopedToken.id,
          scope: 'services:google:read',
          authType: 'bearer',
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // /api/v1/gateway/context — characterizes GAP-003
  // -------------------------------------------------------------------------

  describe('GET /api/v1/gateway/context — GAP-003 characterization', () => {
    test('without auth → 401', async () => {
      const res = await withTestHeaders(
        request(app).get('/api/v1/gateway/context')
      );
      expect(res.status).toBe(401);
    });

    test('scoped agent token → 403 "Only master token can access gateway context"', async () => {
      // GAP-003: this is the master-only gate. `llms.txt` advertises
      // gateway/context as the agent's first call, but a scoped
      // agent token cannot reach it. We pin the **current** behavior
      // here so a future "loosen the gate" or "rewrite llms.txt"
      // commit makes a deliberate, visible diff.
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/gateway/context')
          .set('Authorization', `Bearer ${scopedToken.raw}`)
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Only master token');
    });

    test('master → 200 + data envelope with persona/user/endpoints; vault tokens metadata only (no values)', async () => {
      const res = await withTestHeaders(
        request(app)
          .get('/api/v1/gateway/context')
          .set('Authorization', `Bearer ${masterToken.raw}`)
      );

      expect(res.status).toBe(200);
      // Real response shape per src/index.js:6636 is `{ data: {...} }`
      // where `data` carries `persona`, `user`, `memory`,
      // `connected_services`, `vault: { tokens }`, `personas`,
      // `endpoints`, etc. We do NOT pin the full body via snapshot
      // here — that's G0.1's job. We DO assert on the cred-leak
      // guards: vault must be metadata-only.
      const ctx = res.body && res.body.data;
      expect(ctx).toBeDefined();
      expect(ctx).toHaveProperty('persona');
      expect(ctx).toHaveProperty('user');
      expect(ctx).toHaveProperty('endpoints');
      expect(Array.isArray(ctx.endpoints)).toBe(true);

      // Vault tokens — present as `vault.tokens`, ONLY metadata
      // (id, label, description, createdAt). Value / encrypted
      // value MUST NOT appear (`src/index.js:6437-6442` builder).
      expect(ctx).toHaveProperty('vault');
      const vaultTokens = ctx.vault && ctx.vault.tokens;
      if (Array.isArray(vaultTokens)) {
        for (const v of vaultTokens) {
          expect(v).not.toHaveProperty('value');
          expect(v).not.toHaveProperty('encryptedValue');
          expect(v).not.toHaveProperty('encrypted_value');
          expect(v).not.toHaveProperty('iv');
          expect(v).not.toHaveProperty('authTag');
        }
      }
    });
  });
});
