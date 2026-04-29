/**
 * F6.4 — GitHub service proxy live smoke.
 *
 * Verifies the F4 identity-vs-service-scope split (ADR-0018) holds
 * against a real GitHub OAuth app, end-to-end through the shipped
 * binary. Identity scopes (`read:user`, `user:email`) live in
 * `user_identity_links`; service scopes (`repo`, `gist`, …) live
 * in `oauth_tokens`. The proxy uses the service-scope row.
 *
 * Gated on:
 *   - `SMOKE_URL`        base URL.
 *   - `SMOKE_BEARER`     scoped agent bearer.
 *   - `SMOKE_GITHUB=1`   explicit opt-in.
 *   - The owner has connected GitHub through the dashboard
 *     (`/api/v1/oauth/status` shows `github` connected).
 *
 * Run:
 *   SMOKE_URL=http://localhost:4500 \
 *   SMOKE_BEARER=myapi_… \
 *   SMOKE_GITHUB=1 \
 *   npm run smoke:github
 */

const SMOKE_URL = process.env.SMOKE_URL;
const SMOKE_BEARER = process.env.SMOKE_BEARER;
const RUN_GITHUB = process.env.SMOKE_GITHUB === '1';

const describeIf =
  SMOKE_URL && SMOKE_BEARER && RUN_GITHUB ? describe : describe.skip;

const CREDENTIAL_LEAK_MARKERS = [
  'access_token',
  'refresh_token',
  'client_secret',
  'authorization: bearer',
];

describeIf(`F6.4 GitHub proxy live smoke @ ${SMOKE_URL}`, () => {
  async function proxy(method, path, body) {
    const res = await fetch(`${SMOKE_URL}/api/v1/services/github/proxy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SMOKE_BEARER}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ method, path, body }),
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

  test('GET /user returns the connected GitHub identity', async () => {
    const r = await proxy('GET', '/user');
    if (r.status === 403 && /not connected/i.test(r.raw || '')) {
      throw new Error(
        'GitHub is not connected on this gateway. Complete the OAuth ' +
          'connect flow in the dashboard before running smoke:github.'
      );
    }
    expect(r.status).toBe(200);
    expect(typeof r.body?.login).toBe('string');
    expect(r.body.login.length).toBeGreaterThan(0);
    expect(typeof r.body?.id).toBe('number');
  });

  test('response body does NOT leak credential markers', async () => {
    const r = await proxy('GET', '/user');
    const lower = (r.raw || '').toLowerCase();
    for (const marker of CREDENTIAL_LEAK_MARKERS) {
      expect(lower).not.toContain(marker.toLowerCase());
    }
  });

  test('GET /user/emails returns 200 if `user:email` is in the service scope, else 403/404', async () => {
    // F4 / ADR-0018: identity-only OAuth grants (the app's
    // first-pass connect) lack `user:email`. With service-grant
    // (second connect), `user:email` is present and the call
    // succeeds. We accept both outcomes; assertion is "no
    // credential leak in the response either way".
    const r = await proxy('GET', '/user/emails');
    expect([200, 403, 404]).toContain(r.status);
    const lower = (r.raw || '').toLowerCase();
    for (const marker of CREDENTIAL_LEAK_MARKERS) {
      expect(lower).not.toContain(marker.toLowerCase());
    }
  });

  test('SSRF probe via private-host literal in path → 4xx', async () => {
    const r = await proxy('GET', 'http://127.0.0.1/');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});
