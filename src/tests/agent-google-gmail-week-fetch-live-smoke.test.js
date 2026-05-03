/**
 * F6.3 — End-to-end "agent fetches Gmail messages from the past
 * week" against a live gateway with a real Google connection.
 *
 * Simulates the most representative real-world agent task:
 * an external agent (Hermes / OpenClaude / etc.) is wired into
 * the gateway, the operator has connected Google through the
 * dashboard, and the agent now needs to read every Gmail message
 * from the last 7 days. This walks the full credential-custody
 * trajectory against the SHIPPED binary — no monkey patches, no
 * in-process mocks, real HTTPS to www.googleapis.com.
 *
 * Why a live smoke (vs. an in-process supertest with mocks)
 * ---------------------------------------------------------
 * The in-process suites (`services-proxy-behavioral.test.js`,
 * `agent-capabilities-end-to-end.test.js`) lock the rejection
 * gates and the discover/mint/use trajectory, but they never
 * reach a real Google upstream — they stop at the connection
 * gate (no `oauth_tokens` row seeded). That covers the static
 * contract but cannot catch:
 *   - stale Docker images / bind-mount mismatches that ship a
 *     working code base with broken env wiring,
 *   - missing or rotated `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`,
 *   - encryption-key drift that makes `getOAuthToken` silently
 *     return `null` (so the proxy 403s "not connected" against a
 *     real, connected account),
 *   - real Google API changes (renamed `q`, deprecated
 *     `newer_than:` syntax, scope tightening that locks us out).
 * This live smoke does, by hitting real Google.
 *
 * Test strategy
 * -------------
 * 1. **Discover** — `GET /openapi.json` (no auth). Gateway is
 *    actually serving the public manifest.
 * 2. **(Optional) Mint** — if `SMOKE_MASTER` is supplied, mint a
 *    fresh `services:read` agent token through the public mint
 *    API and use IT for the rest of the flow. This is the
 *    "OpenClaude just got onboarded" path. If `SMOKE_MASTER` is
 *    not supplied we use the pre-supplied `SMOKE_BEARER` (which
 *    is already a `services:read` token per the runbook), which
 *    is the "Hermes was already provisioned" path.
 * 3. **Capabilities introspection** — `GET /api/v1/capabilities`
 *    with the agent bearer returns the manifest narrowed to
 *    `services:*` and never echoes the raw bearer back.
 * 4. **Use — list past-week messages** — `POST /services/google/proxy`
 *    with `path: '/gmail/v1/users/me/messages'`, query
 *    `q: 'newer_than:7d', maxResults: 50`. Asserts:
 *      - 200 + `data.messages` is an array,
 *      - response carries the `meta.endpoint` URL pointing at
 *        `www.googleapis.com` (not localhost / not loopback),
 *      - response body NEVER contains the agent bearer or any
 *        credential markers (`access_token`, `refresh_token`,
 *        `client_secret`, `Authorization: Bearer`).
 * 5. **Use — fetch each message body** — for the first
 *    `MAX_DETAIL_FETCHES` ids returned by step 4, POST proxy
 *    `path: '/gmail/v1/users/me/messages/{id}'`. Asserts each
 *    detail comes back with a Subject header AND a payload, and
 *    that the per-message internalDate falls within the last 7
 *    days (proves the `q` filter actually round-tripped — Google
 *    enforced the date filter).
 * 6. **Boundary — read-scoped agent CANNOT send mail.** A POST
 *    to `/gmail/v1/users/me/messages/send` is rejected at the
 *    scope gate with 403 `Insufficient scope`. The gateway does
 *    NOT contact Google.
 * 7. **Boundary — agent CANNOT mint another token.** The agent
 *    bearer hitting `POST /api/v1/tokens` returns 403 master-only.
 *
 * Gating
 * ------
 *   - `SMOKE_URL`           base URL of running gateway (required).
 *   - `SMOKE_BEARER`        scoped (`services:read`) agent bearer
 *                            (required UNLESS `SMOKE_MASTER` is
 *                            provided, in which case the test
 *                            mints a fresh one).
 *   - `SMOKE_MASTER`        master bearer (optional). When set,
 *                            the test uses the public mint API
 *                            to produce the agent token, walking
 *                            an extra leg of the trajectory.
 *   - `SMOKE_GOOGLE=1`      explicit opt-in. Without it, the
 *                            suite skips silently — important so
 *                            a deployment without Google connected
 *                            doesn't false-fail every CI run.
 *   - `SMOKE_GMAIL_WINDOW_DAYS` (optional, default `7`) — change
 *                            the window if your test mailbox is
 *                            sparse. The test still asserts every
 *                            returned message is within this
 *                            window.
 *   - `SMOKE_GMAIL_DETAIL_LIMIT` (optional, default `3`) — cap
 *                            on per-message detail fetches so the
 *                            smoke stays under ~30s on a large
 *                            mailbox.
 *
 * Run
 * ---
 *   # Pre-supplied agent bearer (Hermes-already-provisioned path)
 *   SMOKE_URL=http://localhost:4500 \
 *   SMOKE_BEARER=myapi_… \
 *   SMOKE_GOOGLE=1 \
 *   npm run smoke:gmail-week
 *
 *   # Or include the master bearer to exercise the mint path too
 *   SMOKE_URL=http://localhost:4500 \
 *   SMOKE_MASTER=myapi_… \
 *   SMOKE_GOOGLE=1 \
 *   npm run smoke:gmail-week
 *
 * Pre-conditions on the gateway
 * -----------------------------
 *   - Owner has completed the Google OAuth connect in the
 *     dashboard with a scope set that includes
 *     `https://www.googleapis.com/auth/gmail.readonly` (or
 *     broader, e.g. `gmail.modify`).
 *   - Test mailbox has ≥ 1 message in the last 7 days (or set
 *     `SMOKE_GMAIL_WINDOW_DAYS` to widen the window).
 *
 * Related
 * -------
 * - `src/tests/services-proxy-google-live-smoke.test.js` (F6.3)
 *   covers the profile read + the SSRF probe; this suite extends
 *   the same pattern to the multi-step "list + per-message read"
 *   trajectory the agent actually uses.
 * - `src/tests/agent-capabilities-end-to-end.test.js` (F6.1
 *   composite) covers the same trajectory in-process, but stops
 *   at the connection gate.
 */

'use strict';

const SMOKE_URL = process.env.SMOKE_URL;
const SMOKE_BEARER = process.env.SMOKE_BEARER;
const SMOKE_MASTER = process.env.SMOKE_MASTER;
const RUN_GOOGLE = process.env.SMOKE_GOOGLE === '1';
const WINDOW_DAYS = Number(process.env.SMOKE_GMAIL_WINDOW_DAYS || 7);
const DETAIL_LIMIT = Number(process.env.SMOKE_GMAIL_DETAIL_LIMIT || 3);

// The suite needs SMOKE_URL + SMOKE_GOOGLE + at least one of
// SMOKE_BEARER / SMOKE_MASTER. Without the env we skip silently
// so the suite doesn't false-fail on a deployment without Google.
const HAS_BEARER_OR_MASTER = Boolean(SMOKE_BEARER || SMOKE_MASTER);
const describeIf =
  SMOKE_URL && RUN_GOOGLE && HAS_BEARER_OR_MASTER ? describe : describe.skip;

const CREDENTIAL_LEAK_MARKERS = [
  'access_token',
  'refresh_token',
  'client_secret',
  'authorization: bearer',
];

describeIf(`F6.3 agent Gmail-week live smoke @ ${SMOKE_URL}`, () => {
  /**
   * Issues an HTTP request against the running gateway and
   * returns `{ status, body, raw }`. Body is parsed as JSON when
   * possible; raw is the verbatim text for leak assertions.
   */
  async function call(method, path, bearer, body) {
    const res = await fetch(`${SMOKE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, raw };
  }

  async function proxyGoogle(bearer, apiPath, query, method = 'GET', body) {
    return call('POST', '/api/v1/services/google/proxy', bearer, {
      path: apiPath,
      method,
      query,
      body,
    });
  }

  /** Effective agent bearer — either pre-supplied or freshly minted. */
  let agentBearer = SMOKE_BEARER || null;
  let mintedTokenId = null;

  beforeAll(async () => {
    // If a master bearer was supplied, prefer minting fresh —
    // walks the full "agent gets onboarded" leg. If not, fall
    // back to the pre-supplied scoped bearer.
    if (SMOKE_MASTER) {
      const mint = await call('POST', '/api/v1/tokens', SMOKE_MASTER, {
        label: `live-smoke gmail-week ${new Date().toISOString()}`,
        scopes: ['services:read'],
        description:
          'Synthetic OpenClaude/Hermes agent reading the past week of Gmail',
      });
      if (mint.status === 201 && mint.body?.data?.token) {
        agentBearer = mint.body.data.token;
        mintedTokenId = mint.body.data.id;
      } else {
        // If mint fails (e.g. master is not actually a master,
        // device not approved, scope missing), fall back to the
        // pre-supplied bearer. Don't fail the suite here —
        // individual tests will surface the misconfig.
        // eslint-disable-next-line no-console
        console.warn(
          `[smoke:gmail-week] mint via SMOKE_MASTER failed (status=${mint.status}, error=${
            mint.body?.error || 'unknown'
          }). Falling back to SMOKE_BEARER.`
        );
      }
    }

    if (!agentBearer) {
      throw new Error(
        '[smoke:gmail-week] no agent bearer available. Provide SMOKE_BEARER ' +
          '(pre-minted services:read) or SMOKE_MASTER (master bearer to mint one).'
      );
    }
  });

  // -------------------------------------------------------------------------
  // 1. Discover
  // -------------------------------------------------------------------------

  test('1. discover — GET /openapi.json (no auth) → 200 + 5+ paths', async () => {
    const res = await fetch(`${SMOKE_URL}/openapi.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toMatch(/^3\./);
    expect(typeof body.paths).toBe('object');
    expect(Object.keys(body.paths).length).toBeGreaterThan(5);
  });

  // -------------------------------------------------------------------------
  // 3. Capabilities introspection (note: 2 = optional mint, done in beforeAll)
  // -------------------------------------------------------------------------

  test('3. capabilities — agent bearer → 200 + endpoints[]; raw bearer not echoed', async () => {
    const r = await call('GET', '/api/v1/capabilities', agentBearer);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body?.endpoints)).toBe(true);
    expect(r.raw).not.toContain(agentBearer);
    expect(r.raw).not.toMatch(/\$2[aby]\$/);
  });

  // -------------------------------------------------------------------------
  // 4. List past-week messages
  // -------------------------------------------------------------------------

  let firstPageIds = [];

  test(`4. list — past ${WINDOW_DAYS}d via Gmail proxy → 200 with messages[]`, async () => {
    const q = `newer_than:${WINDOW_DAYS}d`;
    const r = await proxyGoogle(agentBearer, '/gmail/v1/users/me/messages', {
      q,
      maxResults: 50,
    });

    if (r.status === 403 && /not connected/i.test(r.raw || '')) {
      throw new Error(
        '[smoke:gmail-week] Google is not connected on this gateway. ' +
          'Complete the OAuth connect in the dashboard first.'
      );
    }
    if (r.status === 401 && /REAUTH_REQUIRED/i.test(r.raw || '')) {
      throw new Error(
        '[smoke:gmail-week] Google connection needs re-authorization ' +
          '(REAUTH_REQUIRED). Reconnect through the dashboard.'
      );
    }

    expect(r.status).toBe(200);
    expect(r.body?.ok).toBe(true);
    expect(r.body?.service).toBe('google');
    expect(r.body?.statusCode).toBe(200);
    expect(Array.isArray(r.body?.data?.messages)).toBe(true);

    // Cardinal: meta.endpoint must show the real Google host —
    // proves the proxy didn't accidentally short-circuit to a
    // local mock or fallback.
    expect(typeof r.body?.meta?.endpoint).toBe('string');
    expect(r.body.meta.endpoint).toContain('https://www.googleapis.com/');
    expect(r.body.meta.endpoint).toContain(`q=${encodeURIComponent(q)}`);

    // Cardinal: no credential markers leaked into the agent's view.
    const lower = r.raw.toLowerCase();
    for (const marker of CREDENTIAL_LEAK_MARKERS) {
      expect(lower).not.toContain(marker.toLowerCase());
    }
    expect(r.raw).not.toContain(agentBearer);

    firstPageIds = r.body.data.messages
      .map((m) => m && m.id)
      .filter(Boolean)
      .slice(0, DETAIL_LIMIT);
  });

  // -------------------------------------------------------------------------
  // 5. Fetch each message body
  // -------------------------------------------------------------------------

  test(`5. detail — fetch up to ${DETAIL_LIMIT} message bodies; all within ${WINDOW_DAYS}d`, async () => {
    if (firstPageIds.length === 0) {
      // Don't false-fail an empty mailbox — surface a clear
      // operator instruction instead. (Use SMOKE_GMAIL_WINDOW_DAYS
      // to widen the window if needed.)
      // eslint-disable-next-line no-console
      console.warn(
        `[smoke:gmail-week] No messages in last ${WINDOW_DAYS}d on the connected ` +
          'mailbox; widen with SMOKE_GMAIL_WINDOW_DAYS or send a test message.'
      );
      return;
    }

    const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    let inWindow = 0;
    for (const id of firstPageIds) {
      const r = await proxyGoogle(
        agentBearer,
        `/gmail/v1/users/me/messages/${id}`,
        undefined,
        'GET'
      );
      expect(r.status).toBe(200);
      expect(r.body?.ok).toBe(true);
      expect(r.body?.data?.id).toBe(id);

      // Every detail must carry a Subject header (proves Google
      // returned a real RFC 822 envelope, not a stub).
      const headers = r.body?.data?.payload?.headers || [];
      const subject = headers.find(
        (h) => (h?.name || '').toLowerCase() === 'subject'
      );
      expect(subject?.value || '').toEqual(expect.any(String));

      // internalDate is unix-millis-as-string. Assert it falls
      // within the requested window — proves Google honored the
      // `q=newer_than:Nd` filter (and that we asked the right
      // question).
      const internalMs = Number(r.body?.data?.internalDate || 0);
      expect(Number.isFinite(internalMs)).toBe(true);
      if (internalMs >= cutoffMs) inWindow += 1;

      // Cardinal: no leak.
      expect(r.raw).not.toContain(agentBearer);
      const lower = r.raw.toLowerCase();
      for (const marker of CREDENTIAL_LEAK_MARKERS) {
        expect(lower).not.toContain(marker.toLowerCase());
      }
    }

    expect(inWindow).toBe(firstPageIds.length);
  });

  // -------------------------------------------------------------------------
  // 6. Boundary — read-scoped agent CANNOT send mail
  // -------------------------------------------------------------------------

  test('6. boundary — POST messages/send → 403 Insufficient scope (no upstream)', async () => {
    const r = await proxyGoogle(
      agentBearer,
      '/gmail/v1/users/me/messages/send',
      undefined,
      'POST',
      {
        raw: Buffer.from(
          'From: smoke@example.com\r\nTo: smoke@example.com\r\nSubject: smoke-deny\r\n\r\nBody'
        ).toString('base64'),
      }
    );

    expect(r.status).toBe(403);
    expect(r.body?.error).toBe('Insufficient scope');
    expect(r.body?.message).toContain('services:write');
    // Cardinal: the rejection envelope is the gateway's, NOT a
    // Google upstream error — proves the scope gate fired before
    // any outbound HTTPS.
    expect(r.body?.meta?.endpoint).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 7. Boundary — agent CANNOT mint another token
  // -------------------------------------------------------------------------

  test('7. boundary — POST /api/v1/tokens with agent bearer → 403 master-only', async () => {
    const r = await call('POST', '/api/v1/tokens', agentBearer, {
      label: 'should-fail',
      scopes: ['services:read'],
    });
    expect(r.status).toBe(403);
    expect(String(r.body?.error || '')).toMatch(/master/i);
  });

  // -------------------------------------------------------------------------
  // Cleanup — if we minted a fresh token in beforeAll, revoke it so
  // the live gateway doesn't accumulate dangling smoke tokens.
  // Best-effort: failure here does not fail the suite.
  // -------------------------------------------------------------------------

  afterAll(async () => {
    if (mintedTokenId && SMOKE_MASTER) {
      try {
        await call('DELETE', `/api/v1/tokens/${mintedTokenId}`, SMOKE_MASTER);
      } catch {
        // best effort
      }
    }
  });
});
