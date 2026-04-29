/**
 * F6.3 — Google service proxy live smoke.
 *
 * Cardinal F6 assertion: the agent makes a successful third-party
 * (Google Gmail) API call **without ever holding the OAuth
 * token**. Proves credential custody in the shipped binary.
 *
 * Gated on:
 *   - `SMOKE_URL`         base URL.
 *   - `SMOKE_BEARER`      scoped agent bearer.
 *   - `SMOKE_GOOGLE=1`    explicit opt-in (so a missing-Google
 *                          deployment doesn't false-fail every CI run).
 *   - The owner has connected Google through the dashboard
 *     (`/api/v1/oauth/status` shows `state: connected` for google).
 *
 * Run:
 *   SMOKE_URL=http://localhost:4500 \
 *   SMOKE_BEARER=myapi_… \
 *   SMOKE_GOOGLE=1 \
 *   npm run smoke:google
 */

const SMOKE_URL = process.env.SMOKE_URL;
const SMOKE_BEARER = process.env.SMOKE_BEARER;
const RUN_GOOGLE = process.env.SMOKE_GOOGLE === '1';

const describeIf =
  SMOKE_URL && SMOKE_BEARER && RUN_GOOGLE ? describe : describe.skip;

const CREDENTIAL_LEAK_MARKERS = [
  'access_token',
  'refresh_token',
  'client_secret',
  'authorization: bearer',
];

describeIf(`F6.3 Google proxy live smoke @ ${SMOKE_URL}`, () => {
  async function proxy(method, path, body) {
    const res = await fetch(`${SMOKE_URL}/api/v1/services/google/proxy`, {
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

  test('Gmail profile read returns the connected user', async () => {
    const r = await proxy('GET', '/gmail/v1/users/me/profile');
    if (r.status === 403 && /not connected/i.test(r.raw || '')) {
      throw new Error(
        'Google is not connected on this gateway. Complete the OAuth ' +
          'connect flow in the dashboard before running smoke:google.'
      );
    }
    expect(r.status).toBe(200);
    expect(typeof r.body?.emailAddress).toBe('string');
    expect(r.body.emailAddress).toMatch(/@/);
  });

  test('response body does NOT leak credential markers', async () => {
    const r = await proxy('GET', '/gmail/v1/users/me/profile');
    const lower = (r.raw || '').toLowerCase();
    for (const marker of CREDENTIAL_LEAK_MARKERS) {
      expect(lower).not.toContain(marker.toLowerCase());
    }
  });

  test('POST verb to a write path is rejected (read-scoped agent)', async () => {
    // Cardinal: the agent token must be services:read (broad)
    // for the §3.b read above to work. A POST attempt should
    // either be rejected at the scope gate (GAP-008 today —
    // narrow scopes broken) OR actually succeed if the agent
    // was minted with services:write. The cardinal property is:
    // **the gateway never proxies a write that the agent's
    // token does not authorize.**
    const r = await proxy('POST', '/gmail/v1/users/me/messages/send', {});
    expect([401, 403, 400]).toContain(r.status);
  });

  test('SSRF probe via private-host literal in path → 4xx (no upstream content)', async () => {
    const r = await proxy('GET', 'http://127.0.0.1/');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});
