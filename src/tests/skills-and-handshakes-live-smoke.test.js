/**
 * F6.5 — Skills + handshake flow live smoke.
 *
 * Two unrelated agent-onboarding surfaces, both fully scriptable
 * (no browser interaction needed) — bundled here because they
 * share the same gating + run pattern.
 *
 *   1. Public handshake POST → public status poll → master approve
 *      → second poll. Confirms the runbook's Phase 7 against the
 *      shipped binary.
 *   2. `GET /api/v1/skills` (read-only metadata; today's surface
 *      doesn't run skills, just lists them).
 *
 * Gated on:
 *   - `SMOKE_URL`        base URL.
 *   - `SMOKE_BEARER`     scoped agent bearer.
 *   - `SMOKE_MASTER`     master token (REQUIRED; the script approves
 *                         the handshake end-to-end). Skipped if
 *                         missing.
 *
 * Run:
 *   SMOKE_URL=http://localhost:4500 \
 *   SMOKE_BEARER=myapi_… \
 *   SMOKE_MASTER=myapi_… \
 *   npm run smoke:agent
 */

const SMOKE_URL = process.env.SMOKE_URL;
const SMOKE_BEARER = process.env.SMOKE_BEARER;
const SMOKE_MASTER = process.env.SMOKE_MASTER;

const describeIf =
  SMOKE_URL && SMOKE_BEARER && SMOKE_MASTER ? describe : describe.skip;

describeIf(`F6.5 skills + handshake live smoke @ ${SMOKE_URL}`, () => {
  async function call(method, path, headers = {}, body) {
    const res = await fetch(`${SMOKE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, raw: text };
  }

  describe('handshake flow end-to-end', () => {
    let handshakeId;
    let issuedToken;

    test('public POST /handshakes → 201 with handshakeId', async () => {
      const r = await call('POST', '/api/v1/handshakes', {}, {
        agentId: 'f6-live-smoke-' + Date.now(),
        requestedScopes: ['read'],
        message: 'F6.5 live smoke',
      });
      expect(r.status).toBe(201);
      expect(typeof r.body?.data?.handshakeId).toBe('string');
      handshakeId = r.body.data.handshakeId;
    });

    test('public GET /handshakes/:id/status → 200 pending; no token leak', async () => {
      const r = await call('GET', `/api/v1/handshakes/${handshakeId}/status`);
      expect(r.status).toBe(200);
      expect(r.body?.data?.status).toBe('pending');
      expect(r.raw.toLowerCase()).not.toContain('"token"');
    });

    test('master POST /approve → 200 with data.token', async () => {
      const r = await call(
        'POST',
        `/api/v1/handshakes/${handshakeId}/approve`,
        { Authorization: `Bearer ${SMOKE_MASTER}` },
        {}
      );
      expect(r.status).toBe(200);
      expect(typeof r.body?.data?.token).toBe('string');
      issuedToken = r.body.data.token;
    });

    test('public GET /handshakes/:id/status (post-approve) → 200 approved; token NOT leaked', async () => {
      const r = await call('GET', `/api/v1/handshakes/${handshakeId}/status`);
      expect(r.status).toBe(200);
      expect(r.body?.data?.status).toBe('approved');
      expect(r.raw).not.toContain(issuedToken);
      expect(r.raw.toLowerCase()).not.toContain('"token"');
    });
  });

  describe('skills metadata', () => {
    test('GET /api/v1/skills with agent bearer → 200 with array (or skip if no scope)', async () => {
      const r = await call('GET', '/api/v1/skills', {
        Authorization: `Bearer ${SMOKE_BEARER}`,
      });
      if (r.status === 403) {
        // Agent token lacks `skills:read`. Pinning this as an
        // acceptable outcome — skills:read is OPTIONAL for the
        // F6 walkthrough; the runbook calls it out.
        return;
      }
      expect(r.status).toBe(200);
      const arr = Array.isArray(r.body) ? r.body : r.body?.data;
      expect(Array.isArray(arr)).toBe(true);
    });
  });
});
