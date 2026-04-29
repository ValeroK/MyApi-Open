/**
 * F6.6 — Connector spike (read-only).
 *
 * Per ADR-0020 §"Decision (Option C)": the connector storage
 * round-trips a `GenericOAuthAdapter`-shaped spec **today**, with
 * schema validation gating malformed input. Runtime adapter loading,
 * authorize-URL build, and token storage for these connectors are
 * deferred until M5 (SSRF unification) closes — that work belongs
 * to F7.
 *
 * What this suite covers
 * ----------------------
 * 1. **Master + valid spike spec** → 201; the spec round-trips
 *    intact through `GET /api/v1/connectors`; the schema's
 *    normalization preserves every supplied field.
 * 2. **Master + missing `tokenUrl`** → 400 with
 *    `code: INVALID_CONNECTOR_SPEC`, `fields: ['tokenUrl', …]`.
 * 3. **Master + bogus URL (not http(s))** → 400 with the same
 *    code and the offending field flagged.
 * 4. **Master + identityScopes ∩ serviceScopes** → 400
 *    (F4 / ADR-0018 split is enforced by the schema, not just
 *    by docs).
 * 5. **Scoped token (services:read) + valid spec** → 403
 *    `Insufficient scope`. The schema gate is AFTER the
 *    master gate, so a non-master never even reaches the
 *    validator.
 * 6. **Master + non-spike connector type** → schema gate is
 *    SKIPPED for backward compatibility; arbitrary `config` blobs
 *    still round-trip (today's behavior). Pin so a future
 *    "validate ALL connector types" change is a deliberate diff.
 *
 * Related
 * -------
 * - `.context/decisions/ADR-0020-agent-defined-connectors-feasibility.md`
 * - `src/lib/schemas/connector-spec.js`
 * - `src/index.js:6389-6411` (POST handler with validator wiring).
 * - F7 backlog: runtime loader + workflow + marketplace
 *   `connector` type (gated on M5).
 */

'use strict';

const request = require('supertest');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = require('../server');
const db = require('../database');
const DeviceFingerprint = require('../utils/deviceFingerprint');

const { createUser, createApprovedDevice, grantScopes } = db;

const TEST_UA = 'jest-conn-spike/1.0';
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

function insertToken({ ownerId, scopeValue, tokenType = 'guest', label = 'spike-test' }) {
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

function validSpec(overrides = {}) {
  return {
    authUrl: 'https://provider.example.com/oauth/authorize',
    tokenUrl: 'https://provider.example.com/oauth/token',
    apiRoot: 'https://api.provider.example.com',
    identityScopes: ['profile'],
    serviceScopes: ['read:items', 'write:items'],
    name: 'F6 Spike Provider',
    description: 'F6.6 spike connector spec',
    ...overrides,
  };
}

describe('[F6.6 / ADR-0020] /api/v1/connectors GenericOAuth spike', () => {
  let userId;
  let masterToken;
  let scopedToken;

  beforeAll(() => {
    userId = seedUser('spike_test');

    masterToken = insertToken({
      ownerId: userId,
      scopeValue: 'full',
      tokenType: 'master',
      label: 'F6 Spike Master',
    });
    scopedToken = insertToken({
      ownerId: userId,
      scopeValue: 'services:read',
      label: 'F6 Spike Scoped',
    });
    grantScopes(scopedToken.id, ['services:read']);

    const fpHash = expectedFingerprintHash();
    for (const tok of [masterToken, scopedToken]) {
      createApprovedDevice(
        tok.id,
        userId,
        fpHash,
        'F6 spike test device',
        { os: 'Linux', browser: 'jest' },
        TEST_IP
      );
    }
  });

  // -------------------------------------------------------------------------
  // 1. Round-trip
  // -------------------------------------------------------------------------

  test('1. master + valid spike spec → 201; round-trips intact via GET', async () => {
    const spec = validSpec();
    const create = await withTestHeaders(
      request(app)
        .post('/api/v1/connectors')
        .set('Authorization', `Bearer ${masterToken.raw}`)
        .send({
          type: 'generic_oauth',
          label: 'F6 Spike Connector ' + crypto.randomBytes(2).toString('hex'),
          config: spec,
        })
    );

    expect(create.status).toBe(201);
    expect(create.body.data).toBeDefined();
    expect(create.body.data.type).toBe('generic_oauth');
    // Schema normalizes the config (drops `null`s, dedupes); core
    // fields must round-trip identically.
    expect(create.body.data.config.authUrl).toBe(spec.authUrl);
    expect(create.body.data.config.tokenUrl).toBe(spec.tokenUrl);
    expect(create.body.data.config.apiRoot).toBe(spec.apiRoot);
    expect(create.body.data.config.identityScopes).toEqual(spec.identityScopes);
    expect(create.body.data.config.serviceScopes).toEqual(spec.serviceScopes);

    const id = create.body.data.id;

    const list = await withTestHeaders(
      request(app)
        .get('/api/v1/connectors')
        .set('Authorization', `Bearer ${masterToken.raw}`)
    );
    expect(list.status).toBe(200);
    const echoed = list.body.data.find((row) => row.id === id);
    expect(echoed).toBeDefined();
    expect(echoed.config.tokenUrl).toBe(spec.tokenUrl);
  });

  // -------------------------------------------------------------------------
  // 2-4. Schema rejections
  // -------------------------------------------------------------------------

  describe('2-4. schema rejections', () => {
    test('missing tokenUrl → 400 INVALID_CONNECTOR_SPEC', async () => {
      const broken = validSpec();
      delete broken.tokenUrl;

      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/connectors')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ type: 'generic_oauth', label: 'no-token-url', config: broken })
      );

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CONNECTOR_SPEC');
      expect(res.body.fields).toContain('tokenUrl');
    });

    test('non-http(s) authUrl → 400 INVALID_CONNECTOR_SPEC', async () => {
      const broken = validSpec({ authUrl: 'javascript:alert(1)' });
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/connectors')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ type: 'generic_oauth', label: 'bad-auth-url', config: broken })
      );

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CONNECTOR_SPEC');
      expect(res.body.fields).toContain('authUrl');
    });

    test('identityScopes ∩ serviceScopes → 400 (F4 split enforced)', async () => {
      const broken = validSpec({
        identityScopes: ['profile', 'overlap'],
        serviceScopes: ['read:items', 'overlap'],
      });
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/connectors')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ type: 'generic_oauth', label: 'overlap', config: broken })
      );

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CONNECTOR_SPEC');
      expect(res.body.error).toContain('overlap');
    });

    test('neither identityScopes nor serviceScopes → 400', async () => {
      const broken = validSpec();
      delete broken.identityScopes;
      delete broken.serviceScopes;

      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/connectors')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ type: 'generic_oauth', label: 'no-scopes', config: broken })
      );

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CONNECTOR_SPEC');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Scope gate fires BEFORE schema gate
  // -------------------------------------------------------------------------

  test('5. scoped token + valid spec → 403 (master gate runs first)', async () => {
    const res = await withTestHeaders(
      request(app)
        .post('/api/v1/connectors')
        .set('Authorization', `Bearer ${scopedToken.raw}`)
        .send({ type: 'generic_oauth', label: 'should-403', config: validSpec() })
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient scope');
    // Importantly, the body MUST NOT carry an INVALID_CONNECTOR_SPEC
    // code — that would mean the validator ran for a non-master.
    expect(res.body.code).not.toBe('INVALID_CONNECTOR_SPEC');
  });

  // -------------------------------------------------------------------------
  // 6. Non-spike type passes through unchanged
  // -------------------------------------------------------------------------

  test('6. non-spike connector type bypasses schema (today\'s behavior, pinned)', async () => {
    // For `type !== 'generic_oauth'` the validator is intentionally
    // skipped — those types pre-date the spike and have their own
    // ad-hoc shapes. A future "validate every connector type" change
    // should fail this test deliberately.
    const res = await withTestHeaders(
      request(app)
        .post('/api/v1/connectors')
        .set('Authorization', `Bearer ${masterToken.raw}`)
        .send({
          type: 'webhook',
          label: 'F6 Legacy Connector',
          config: { unstructured: 'blob', anything: ['goes', 'here'] },
        })
    );

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('webhook');
    expect(res.body.data.config.unstructured).toBe('blob');
  });
});
