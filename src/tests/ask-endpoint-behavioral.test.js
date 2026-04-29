/**
 * F6.1 — `/api/v1/ask` behavioral contract.
 *
 * `/ask` is the natural-language router: the agent gives a string
 * intent ("send a Slack message to my team") and the gateway uses
 * an LLM to map it onto a connected-service `/proxy` call. It is
 * the most "magic" surface MyApi exposes to agents and the only
 * one that requires an LLM key on the **gateway side** — i.e. a
 * surface that can return 503 even when everything else is
 * healthy.
 *
 * Pre-F6 there was no behavioral test for this endpoint.
 *
 * What this suite covers (L1)
 * ---------------------------
 * 1. **Auth gate.** Unauth → 401 global envelope.
 * 2. **Validation gate.** Missing / empty / non-string `intent`
 *    in the body → 400 `intent is required`.
 * 3. **Scope gate.** Token without `services:read` → 403 with
 *    documented hint.
 * 4. **LLM availability gate.** `OPENAI_API_KEY` unset → 503
 *    `AI routing unavailable`. This proves a clean degradation
 *    path: the gateway tells the agent the LLM is the missing
 *    piece, rather than silently 5xx-ing.
 * 5. **Connection precondition.** With `OPENAI_API_KEY` set but
 *    NO `oauth_tokens` row for the user, the handler must reject
 *    BEFORE any LLM call (`No services connected. Connect at
 *    least one service first.`). This is the cardinal property
 *    for cost: the gateway never burns OpenAI credits resolving
 *    intent against an empty service set.
 *
 * What this suite does NOT cover (deferred to L2 / runbook)
 * ---------------------------------------------------------
 * - Real LLM resolution. Live-smoke runs against
 *   `docker:smoke` with a real `OPENAI_API_KEY`.
 * - Internal proxy loopback (`fetch http://127.0.0.1:${PORT}/...`).
 *   The handler hard-codes loopback dial; the in-process supertest
 *   app is bound to a different port via supertest, so the loopback
 *   would not reach the same app instance. L2 covers this.
 *
 * Related
 * -------
 * - `.cursor/plans/capability_test_plan_b4523725.plan.md` §3.1.
 * - `src/index.js:1661-1786` (handler).
 */

'use strict';

const request = require('supertest');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = require('../server');
const db = require('../database');
const DeviceFingerprint = require('../utils/deviceFingerprint');

const { createUser, createApprovedDevice, grantScopes } = db;

const TEST_UA = 'jest-ask/1.0';
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

function insertToken({ ownerId, scopeValue, tokenType = 'guest', label = 'ask-test' }) {
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

describe('[F6.1] POST /api/v1/ask behavioral contract', () => {
  let userId;
  let masterToken;
  let knowledgeOnlyToken;
  let originalOpenAIKey;

  beforeAll(() => {
    userId = seedUser('ask_test');

    masterToken = insertToken({
      ownerId: userId,
      scopeValue: 'full',
      tokenType: 'master',
      label: 'F6 Ask Master',
    });
    knowledgeOnlyToken = insertToken({
      ownerId: userId,
      scopeValue: 'knowledge',
      label: 'F6 Ask Knowledge Only',
    });
    grantScopes(knowledgeOnlyToken.id, ['knowledge']);

    const fpHash = expectedFingerprintHash();
    for (const tok of [masterToken, knowledgeOnlyToken]) {
      createApprovedDevice(
        tok.id,
        userId,
        fpHash,
        'F6 ask test device',
        { os: 'Linux', browser: 'jest' },
        TEST_IP
      );
    }
  });

  beforeEach(() => {
    originalOpenAIKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
  });

  // -------------------------------------------------------------------------
  // 1. Auth gate
  // -------------------------------------------------------------------------

  describe('1. auth gate', () => {
    test('unauthenticated POST → 401 global envelope', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/ask')
          .send({ intent: 'list my repos' })
      );

      expect(res.status).toBe(401);
      expect(res.body.error).toContain(
        'Missing session, Authorization: Bearer token'
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Validation gate
  // -------------------------------------------------------------------------

  describe('2. validation gate', () => {
    test('missing intent → 400 "intent is required"', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/ask')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({})
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('intent is required');
    });

    test('empty intent → 400 "intent is required"', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/ask')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ intent: '' })
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('intent is required');
    });

    test('whitespace-only intent → 400 "intent is required"', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/ask')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ intent: '   \t\n  ' })
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('intent is required');
    });

    test('non-string intent → 400 "intent is required"', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/ask')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ intent: { not: 'a string' } })
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('intent is required');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Scope gate
  // -------------------------------------------------------------------------

  describe('3. scope gate', () => {
    test('knowledge-only token → 403 "Requires services:read scope"', async () => {
      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/ask')
          .set('Authorization', `Bearer ${knowledgeOnlyToken.raw}`)
          .send({ intent: 'list my repos' })
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("services:read");
    });
  });

  // -------------------------------------------------------------------------
  // 4. LLM availability gate
  // -------------------------------------------------------------------------

  describe('4. LLM availability gate', () => {
    test('OPENAI_API_KEY unset → 503 "AI routing unavailable"', async () => {
      delete process.env.OPENAI_API_KEY;

      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/ask')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ intent: 'list my repos' })
      );

      expect(res.status).toBe(503);
      expect(res.body.error).toContain('AI routing unavailable');
      expect(res.body.error).toContain('OPENAI_API_KEY');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Connection precondition
  // -------------------------------------------------------------------------

  describe('5. connection precondition (no LLM burn)', () => {
    test('no services connected → 400 BEFORE any LLM call', async () => {
      // Cardinal cost / privacy property: with NO oauth_tokens
      // rows for the user, the handler must reject before contacting
      // OpenAI. Pinning this means a future refactor that reorders
      // the gates and starts burning credits on empty intents
      // becomes a visible, reviewable diff.
      process.env.OPENAI_API_KEY = 'sk-test-FAKE_DO_NOT_CALL';

      const res = await withTestHeaders(
        request(app)
          .post('/api/v1/ask')
          .set('Authorization', `Bearer ${masterToken.raw}`)
          .send({ intent: 'list my repos' })
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('No services connected');
    });
  });
});
