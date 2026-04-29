/**
 * F6.3 — Agent discovery live smoke.
 *
 * Mirrors `agent-discovery-contract.test.js` (L1) over the live HTTP
 * surface. Catches regressions the in-process supertest can't:
 * stale Docker images, missing routes in the shipped bundle, env
 * misconfig that hides a route at boot, etc.
 *
 * Gated on:
 *   - `SMOKE_URL`     base URL of running gateway.
 *   - `SMOKE_BEARER`  scoped agent bearer (services:read; mint via
 *                     the runbook §Phase 2). Optional — most checks
 *                     run without it; checks needing auth skip when
 *                     it's missing.
 *
 * Run:
 *   npm run smoke:agent
 *
 * Or explicitly:
 *   SMOKE_URL=http://localhost:4500 \
 *   SMOKE_BEARER=myapi_… \
 *   npx jest agent-discovery-live-smoke --forceExit
 */

const SMOKE_URL = process.env.SMOKE_URL;
const SMOKE_BEARER = process.env.SMOKE_BEARER;

const describeIf = SMOKE_URL ? describe : describe.skip;
const itIfBearer = SMOKE_BEARER ? test : test.skip;

describeIf(`F6.3 agent discovery live smoke @ ${SMOKE_URL}`, () => {
  async function get(path, headers = {}) {
    const res = await fetch(`${SMOKE_URL}${path}`, { headers });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, raw: text };
  }

  test('GET /health → 200', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
  });

  test('GET /openapi.json (public) → 200 with paths', async () => {
    const r = await get('/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body).toBeDefined();
    expect(r.body.openapi).toMatch(/^3\./);
    expect(typeof r.body.paths).toBe('object');
    expect(Object.keys(r.body.paths).length).toBeGreaterThan(5);
  });

  test('GET /llms.txt (public) → 200 text', async () => {
    const r = await get('/llms.txt');
    expect(r.status).toBe(200);
    expect(r.raw.length).toBeGreaterThan(50);
  });

  test('GET /api/v1/capabilities (no auth) → 401', async () => {
    const r = await get('/api/v1/capabilities');
    expect(r.status).toBe(401);
  });

  itIfBearer('GET /api/v1/capabilities (agent bearer) → 200 + endpoints[]', async () => {
    const r = await get('/api/v1/capabilities', {
      Authorization: `Bearer ${SMOKE_BEARER}`,
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body?.endpoints)).toBe(true);
  });

  itIfBearer('GET /api/v1/tokens/me/capabilities → 200 + does NOT leak raw bearer', async () => {
    const r = await get('/api/v1/tokens/me/capabilities', {
      Authorization: `Bearer ${SMOKE_BEARER}`,
    });
    expect(r.status).toBe(200);
    expect(r.raw).not.toContain(SMOKE_BEARER);
    // No bcrypt hash should appear either.
    expect(r.raw).not.toMatch(/\$2[aby]\$/);
  });

  itIfBearer('GET /api/v1/gateway/context (agent bearer) → 403 (master-only — GAP-003)', async () => {
    const r = await get('/api/v1/gateway/context', {
      Authorization: `Bearer ${SMOKE_BEARER}`,
    });
    expect(r.status).toBe(403);
    expect(r.body?.error).toContain('master');
  });
});
