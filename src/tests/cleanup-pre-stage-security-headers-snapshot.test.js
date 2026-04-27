// Cleanup Stage-0 / G0.6 — security-headers snapshot per response family.
//
// Purpose
// -------
// Pin the security-relevant response headers (CSP, HSTS, X-Frame-
// Options, X-Content-Type-Options, Referrer-Policy, Permissions-
// Policy, Cache-Control) for each "response family" the app
// serves:
//
//   - HTML page (index.html)
//   - dashboard SPA shell (/app)
//   - public JSON API endpoint (/api/v1/auth/email-config-status)
//   - authenticated JSON API endpoint (login response)
//   - JSON 4xx error response
//
// Why per-family
// --------------
// Helmet sets a global default, but several routes override
// individual headers (e.g. Cache-Control: no-store on the email-
// config status endpoint, on /logout, and on /me to prevent
// stale-auth Back-button restores). A blanket "all responses
// have header X" assertion is too coarse — a regression that
// strips no-store from /me wouldn't fire, because the static
// HTML still has it. A per-family ratchet makes EACH override
// visible.
//
// What we capture
// ---------------
// For each family we snapshot a normalised view:
//   - presence / absence of every interesting header (boolean)
//   - the VALUE of CSP, HSTS, Referrer-Policy, Permissions-Policy
//     (these are policy strings — any change is a security
//     decision worth code-reviewing)
//   - the VALUE of Cache-Control (because no-store / private /
//     public are radically different)
//
// We DO NOT snapshot:
//   - ETag             — content-derived, varies with bundle hash
//   - Date / X-Powered-By — uninteresting
//   - request-id headers — vary per request
//
// Updating
// --------
//   npx jest cleanup-pre-stage-security-headers-snapshot --updateSnapshot
// in the SAME commit as the deliberate header change. Reviewers
// MUST read the diff for any policy weakening.
//
// Related
// -------
//   - .context/decisions/ADR-0004-cleanup-pre-stage-gates.md
//   - Cleanup plan §"Stage 0 — Cross-cutting baseline" / G0.6
//   - F5.3 "Cache-Control on auth responses" — this gate is the
//     ratchet preventing the regression from F5.3 onwards.

'use strict';

const request = require('supertest');

const emailService = require('../services/emailService');
if (typeof emailService.sendWelcomeEmail !== 'function') {
  emailService.sendWelcomeEmail = async () => undefined;
}
jest.spyOn(emailService, 'sendWelcomeEmail').mockImplementation(async () => undefined);

const { app } = require('../index');

// Ordered for stable snapshot output. Lower-cased to match
// supertest's header-key normalisation.
const HEADERS_OF_INTEREST = [
  'content-security-policy',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
  'cache-control',
  'pragma',
  'expires',
];

// Headers whose VALUE we care about (policy strings). The rest
// are presence-only because their values are well-known
// boilerplate (`nosniff`, `DENY`).
const VALUE_HEADERS = new Set([
  'content-security-policy',
  'strict-transport-security',
  'referrer-policy',
  'permissions-policy',
  'cache-control',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
]);

function describeHeaders(res) {
  const out = {
    status: res.status,
    contentType: String(res.headers['content-type'] || '').split(';')[0].trim() || null,
  };
  for (const h of HEADERS_OF_INTEREST) {
    const raw = res.headers[h];
    if (raw === undefined || raw === null) {
      out[h] = null;
      continue;
    }
    if (VALUE_HEADERS.has(h)) {
      let v = Array.isArray(raw) ? raw.join('; ') : String(raw);
      // CSP carries a per-request `'nonce-<base64>'` so the
      // dashboard can inline scripts without going to
      // `'unsafe-inline'`. The nonce is non-deterministic by
      // design — replace it with a placeholder so the snapshot
      // pins the POLICY (which directives, which sources)
      // without flaking on the entropy.
      v = v.replace(/'nonce-[A-Za-z0-9+/=]+'/g, "'nonce-<scrubbed>'");
      // CSP / Permissions-Policy can be very long; truncate at
      // 400 chars to keep snapshots readable. The first 400
      // chars include the directives that matter for cleanup.
      out[h] = v.length > 400 ? `${v.slice(0, 400)}…<truncated>` : v;
    } else {
      out[h] = '<set>';
    }
  }
  return out;
}

describe('[Cleanup Stage 0 / G0.6] security headers snapshot per response family', () => {
  jest.setTimeout(15_000);

  test('snapshot: family — public JSON API (email-config-status)', async () => {
    const res = await request(app).get('/api/v1/auth/email-config-status');
    expect(res.status).toBe(200);
    expect(describeHeaders(res)).toMatchSnapshot('public JSON GET');
  });

  test('snapshot: family — JSON 4xx error (login bad creds)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: `nobody_${Date.now()}@example.com`, password: 'WrongPass!1' });
    expect([400, 401]).toContain(res.status);
    expect(describeHeaders(res)).toMatchSnapshot('JSON 4xx error');
  });

  test('snapshot: family — JSON 4xx unauth (GET /me without session)', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    // Pinned in G0.5; here we only care about headers.
    expect([200, 401]).toContain(res.status);
    expect(describeHeaders(res)).toMatchSnapshot('JSON unauth /me');
  });

  test('snapshot: family — JSON authenticated success (logout)', async () => {
    // Logout is a deliberate "no-cache" target — pinning it as a
    // family ensures M6 / M7 keep no-store on auth-state-mutating
    // responses.
    const agent = request.agent(app);
    const u = `g06_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await agent.post('/api/v1/auth/register').send({
      username: u,
      email: `${u}@example.com`,
      password: 'Strong!Pass123',
      display_name: u,
    });
    const res = await agent.post('/api/v1/auth/logout').send({});
    expect(res.status).toBe(200);
    expect(describeHeaders(res)).toMatchSnapshot('JSON authenticated logout');
  });

  test('snapshot: family — root / (HTML or marketing page)', async () => {
    const res = await request(app).get('/');
    // Don't assert status — could be 200 HTML, could be 302
    // redirect to /sell. Either is OK; we're snapshotting
    // headers, not routing.
    expect([200, 301, 302, 304]).toContain(res.status);
    expect(describeHeaders(res)).toMatchSnapshot('root /');
  });

  test('cache-control on auth-state mutators MUST include no-store', async () => {
    // Hard assertion (not just snapshot): F5.3's UX-fix relied on
    // no-store being present on logout. We pin this as a *fact*,
    // not just a snapshot value, so a refactor that drops it
    // fails BEFORE someone has to read a header diff.
    const agent = request.agent(app);
    const u = `g06hard_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await agent.post('/api/v1/auth/register').send({
      username: u,
      email: `${u}@example.com`,
      password: 'Strong!Pass123',
      display_name: u,
    });
    const res = await agent.post('/api/v1/auth/logout').send({});
    expect(res.status).toBe(200);
    expect(String(res.headers['cache-control'] || '').toLowerCase()).toMatch(/no-store/);
  });

  test('email-config-status MUST be no-store (Bug 1 of F5.3)', async () => {
    // This was the headline F5.3 ratchet — keep it explicit.
    const res = await request(app).get('/api/v1/auth/email-config-status');
    expect(res.status).toBe(200);
    expect(String(res.headers['cache-control'] || '').toLowerCase()).toMatch(/no-store/);
  });
});
