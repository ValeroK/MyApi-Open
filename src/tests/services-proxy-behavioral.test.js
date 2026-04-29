/**
 * F6.1 — Service proxy behavioral contract.
 *
 * Pins the most important agent-facing capability:
 *
 *     POST /api/v1/services/:serviceName/proxy
 *
 * This is the ONLY way an agent makes a real third-party API call
 * without ever holding the OAuth token. Pre-F6 it had no behavioral
 * tests at all (`vault-token-instructions.test.js` and
 * `integration.test.js` mention the path but only assert object
 * shapes — see `.cursor/plans/capability_test_plan_b4523725.plan.md`
 * §3.1). This suite locks the gates that protect credential custody.
 *
 * What this suite covers (L1)
 * ---------------------------
 * 1. **Auth gate.** No bearer / no session → 401 global envelope.
 * 2. **Scope gate.** `services:google:read` on a write verb → 403
 *    `Insufficient scope`. `services:google:read` on GET → reaches
 *    the next gate (i.e. NOT 403). Master can hit either verb.
 * 3. **Input validation.** Missing `path` in the body → 400
 *    `path is required`.
 * 4. **Connection gate.** Authenticated, scoped, valid input, but
 *    no `oauth_tokens` row for the service+user → 403
 *    `Service '<name>' not connected`. Critical: this means a
 *    malicious agent who has somehow obtained a scoped token for
 *    a service the OWNER has not connected gets a clean 403, NOT
 *    a network call. Pre-F6 this gate was not behaviorally
 *    asserted.
 * 5. **SSRF resilience by construction.** The proxy reads only
 *    `path`, `method`, `body`, `query` from `req.body` — there is
 *    NO `baseUrl` / `host` / `apiRoot` override surface. The
 *    target URL is `OAUTH_PROVIDER_DETAILS[serviceName].apiRoot +
 *    apiPath`; private-hostname text inside `apiPath` becomes URL
 *    path, not host. We assert this two ways:
 *      (a) **static** — the proxy handler in `src/index.js`
 *          does not destructure `baseUrl` / `host` / `apiRoot`
 *          from `req.body`. Any future refactor that adds such a
 *          surface would unlock SSRF and must be a deliberate
 *          decision (and would break this gate).
 *      (b) **runtime** — passing private-host text in `apiPath`
 *          when the service is not connected still yields the
 *          `not connected` 403 (i.e. never reaches outbound).
 *
 * What this suite does NOT cover (deferred to L2 live-smoke)
 * ----------------------------------------------------------
 * - Happy-path success against real Google / GitHub. That's
 *   `services-proxy-google-live-smoke.test.js` /
 *   `services-proxy-github-live-smoke.test.js` per plan §3.2.
 * - Auto-refresh on upstream 401. Already covered structurally
 *   by `oauth-refresh-invalid-grant.test.js` against a loopback
 *   token server.
 * - Live SSRF probes (real `127.0.0.1` traversal attempts).
 *   That's runbook Phase 6 + L2 follow-ups gated on M5 SSRF
 *   unification.
 *
 * Related
 * -------
 * - `.cursor/plans/capability_test_plan_b4523725.plan.md` §3.1.
 * - `src/index.js:9977-...` (proxy handler).
 * - `src/services/integration-layer.js:22-95` (apiRoot table).
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

const TEST_UA = 'jest-services-proxy/1.0';
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

function insertToken({ ownerId, scopeValue, tokenType = 'guest', label = 'proxy-test' }) {
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

describe('[F6.1] POST /api/v1/services/:serviceName/proxy behavioral contract', () => {
  let userId;
  let masterToken;
  let googleReadToken;   // services:google:read  (NARROW — surfaces GAP-008)
  let googleWriteToken;  // services:google:write (NARROW — surfaces GAP-008)
  let broadReadToken;    // services:read         (BROAD — what the proxy actually checks)
  let broadWriteToken;   // services:write        (BROAD — what the proxy actually checks)
  let fpHash;

  beforeAll(() => {
    userId = seedUser('proxy_test');

    masterToken = insertToken({
      ownerId: userId,
      scopeValue: 'full',
      tokenType: 'master',
      label: 'F6 Proxy Master',
    });
    // GAP-008 characterization tokens — narrow scopes are
    // intentionally NOT granted via `grantScopes` because the
    // narrow regex `services:<name>:<verb>` passes `validateScope`
    // but is NOT present in `scope_definitions`, so the FK insert
    // fails today. Without a granted row, `hasScope` returns false
    // — which is also the runtime outcome the gap describes
    // (the narrow scope is useless against the proxy's broad check).
    googleReadToken = insertToken({
      ownerId: userId,
      scopeValue: 'services:google:read',
      label: 'F6 Proxy Google Read',
    });
    googleWriteToken = insertToken({
      ownerId: userId,
      scopeValue: 'services:google:write',
      label: 'F6 Proxy Google Write',
    });

    // Broad scopes — these ARE in `scope_definitions` and DO get
    // granted, so they pass `hasScope`.
    broadReadToken = insertToken({
      ownerId: userId,
      scopeValue: 'services:read',
      label: 'F6 Proxy Broad Read',
    });
    grantScopes(broadReadToken.id, ['services:read']);

    broadWriteToken = insertToken({
      ownerId: userId,
      scopeValue: 'services:write',
      label: 'F6 Proxy Broad Write',
    });
    grantScopes(broadWriteToken.id, ['services:write']);

    fpHash = expectedFingerprintHash();
    for (const tok of [
      masterToken,
      googleReadToken,
      googleWriteToken,
      broadReadToken,
      broadWriteToken,
    ]) {
      createApprovedDevice(
        tok.id,
        userId,
        fpHash,
        'F6 proxy test device',
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
          .post('/api/v1/services/google/proxy')
          .send({ path: '/foo', method: 'GET' })
      );

      expect(res.status).toBe(401);
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error).toContain(
        'Missing session, Authorization: Bearer token'
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Scope gate
  // -------------------------------------------------------------------------

  describe('2. scope gate', () => {
    // CARDINAL FINDING (GAP-008, surfaced 2026-04-28): the proxy
    // asks `hasScope(req, 'services:read')` / `hasScope(req,
    // 'services:write')` and `hasScope` is strict equality
    // (`src/index.js:3263-3267`). There is NO scope hierarchy:
    // a token scoped to `services:google:read` does NOT satisfy
    // `services:read` and is rejected with 403. This contradicts
    // the hierarchy claim in `CLAUDE.md` ("`admin:*` >
    // `services:*` > `services:{name}:read`"). The runbook + L2
    // smokes will need to mint BROAD tokens (`services:read` /
    // `services:write`) until this is decided. Pinning the
    // current behavior here so the decision shows up as a visible
    // diff.
    test('services:google:read (NARROW) on GET verb → 403 (GAP-008)', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/proxy')
          .set('Authorization', `Bearer ${googleReadToken.raw}`)
          .send({
            path: '/gmail/v1/users/me/profile',
            method: 'GET',
          })
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient scope');
      expect(res.body.message).toContain("services:read");
    });

    test('services:google:write (NARROW) on POST verb → 403 (GAP-008)', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/proxy')
          .set('Authorization', `Bearer ${googleWriteToken.raw}`)
          .send({
            path: '/gmail/v1/users/me/messages/send',
            method: 'POST',
            body: {},
          })
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient scope');
      expect(res.body.message).toContain('services:write');
    });

    test('services:read (BROAD) on POST verb → 403 because verb is write', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/proxy')
          .set('Authorization', `Bearer ${broadReadToken.raw}`)
          .send({
            path: '/gmail/v1/users/me/messages/send',
            method: 'POST',
            body: {},
          })
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient scope');
      expect(res.body.message).toContain('services:write');
    });

    test('services:read (BROAD) on GET verb → past scope gate', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/proxy')
          .set('Authorization', `Bearer ${broadReadToken.raw}`)
          .send({
            path: '/gmail/v1/users/me/profile',
            method: 'GET',
          })
      );

      // Past scope; without OAuth row, next gate returns 403
      // "not connected". Either way, body MUST NOT be the scope
      // rejection envelope.
      expect(res.body.error).not.toBe('Insufficient scope');
    });

    test('services:write (BROAD) on POST verb → past scope gate', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/proxy')
          .set('Authorization', `Bearer ${broadWriteToken.raw}`)
          .send({
            path: '/gmail/v1/users/me/messages/send',
            method: 'POST',
            body: {},
          })
      );

      expect(res.body.error).not.toBe('Insufficient scope');
    });

    test('master on any verb → past scope gate', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/proxy')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({
            path: '/gmail/v1/users/me/profile',
            method: 'GET',
          })
      );

      expect(res.body.error).not.toBe('Insufficient scope');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Input validation
  // -------------------------------------------------------------------------

  describe('3. input validation', () => {
    test('missing `path` in body → 400 "path is required"', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/proxy')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ method: 'GET' })
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('path is required');
    });

    test('empty body → 400 "path is required" (not a 500)', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/proxy')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .set('Content-Type', 'application/json')
          .send({})
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('path is required');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Connection gate
  // -------------------------------------------------------------------------

  describe('4. connection gate', () => {
    test('valid auth + scope + path, but service not connected → 403 "not connected"', async () => {
      // No oauth_tokens row was seeded for google+userId in this
      // suite, so the proxy hits the "not connected" branch.
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/services/google/proxy')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({
            path: '/gmail/v1/users/me/profile',
            method: 'GET',
          })
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("not connected");
      expect(res.body.error).toContain('google');
    });
  });

  // -------------------------------------------------------------------------
  // 5. SSRF resilience by construction
  // -------------------------------------------------------------------------

  describe('5. SSRF resilience by construction', () => {
    test('runtime: private-host text in `path` does not bypass the not-connected gate', async () => {
      // If a future refactor accidentally introduced URL injection
      // via apiPath, this would manifest as a 502 / network error /
      // 200, NOT a clean 403 not-connected. Pinning the 403 here
      // means the apiPath never reached an outbound URL build.
      const adversarialPaths = [
        '//127.0.0.1/admin',
        '/@127.0.0.1/admin',
        '/@169.254.169.254/latest/meta-data/',
        '/../../localhost/internal',
        '/foo?redirect=http://0177.0.0.1/admin',
      ];

      for (const apiPath of adversarialPaths) {
        const res = await withTestHeaders(
          request(app)
            .post('/api/v1/services/google/proxy')
            .set('Authorization', `Bearer ${masterToken.raw}`)
            .send({ path: apiPath, method: 'GET' })
        );
        // The connection gate is the cardinal property — proves no
        // outbound call happened. Body MUST mention 'not connected'.
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('not connected');
      }
    });

    test('static: handler reads only path/method/body/query from req.body (no baseUrl/host/apiRoot override)', async () => {
      // Locks the cardinal SSRF property of this surface: the agent
      // cannot redirect the proxy to an arbitrary host. If a future
      // change adds `baseUrl` / `host` / `apiRoot` to the
      // destructure, an attacker could point the proxy at internal
      // services. This static gate makes that addition a deliberate,
      // visible diff.
      const source = fs.readFileSync(SERVER_ENTRY, 'utf8');

      // Find the proxy handler. Anchor on the registration line so
      // we don't mistakenly read the execute handler.
      const handlerStart = source.indexOf(
        "app.post('/api/v1/services/:serviceName/proxy'"
      );
      expect(handlerStart).toBeGreaterThan(-1);

      // Read up to ~30 lines after the registration; the
      // destructure sits in the first ~5 lines of the handler body.
      const handlerSlice = source.slice(handlerStart, handlerStart + 1500);

      // Locate the destructure of req.body in the handler slice.
      const destructure = handlerSlice.match(
        /const\s*\{\s*([^}]+)\}\s*=\s*req\.body/
      );
      expect(destructure).not.toBeNull();
      const fields = destructure[1]
        .split(',')
        .map((f) => f.split(':')[0].trim());

      // Cardinal allow-list. Adding ANY of the banned names below
      // would unlock SSRF. Do NOT silently expand this list.
      const allowed = new Set(['path', 'method', 'body', 'query']);
      const banned = new Set([
        'baseUrl',
        'base_url',
        'host',
        'apiRoot',
        'api_root',
        'origin',
        'targetUrl',
        'target_url',
        'url',
      ]);

      for (const field of fields) {
        expect(banned.has(field)).toBe(false);
      }
      // Allow-list is positively asserted: the four legal fields
      // must each appear (so a refactor that renames a field is
      // a visible diff).
      for (const required of allowed) {
        expect(fields).toContain(required);
      }
    });
  });
});
