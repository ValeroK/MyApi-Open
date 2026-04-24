/**
 * Security regression suite.
 *
 * Every case in this file corresponds to a security finding we have fixed.
 * If one of these tests breaks, we have either:
 *   1. Accidentally re-introduced a known vulnerability, or
 *   2. Refactored the code so the assertion no longer makes sense — in which
 *      case the test should be updated in the same PR that moved the code,
 *      with a comment pointing at the relevant ADR / TASKS.md row.
 *
 * See:
 *   - `.context/TASKS.md` (milestone tracker)
 *   - `.context/plan.md` §5.4 (enumerated regression targets)
 *   - `.context/decisions/ADR-0006-db-backed-oauth-state.md` (OAuth flow)
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ci';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'test-encryption-key-32chars!!';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-ci';
process.env.VAULT_KEY = process.env.VAULT_KEY || 'test-vault-key-ci-32characters!';
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

// M3 / T3.8 — the OAuth regression matrix below exercises
// /api/v1/oauth/authorize/google + /api/v1/oauth/callback/google against
// a state row in the live DB. The Google OAuth adapter reads these three
// env vars once at module load time (via `require('../index')`) so they
// MUST be set before supertest / app boot. Test-grade literals only — no
// real provider contact happens thanks to the jest.mock below.
process.env.GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || 'test-google-client';
process.env.GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';
process.env.GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  'http://localhost:4500/api/v1/oauth/callback/google';

// Mock the Google adapter so no real OAuth provider is contacted. Same
// shape as `src/tests/oauth-callback-handler.test.js` — deliberately a
// minimum-viable stub: returns a deterministic token bundle + a fixed
// verify-token profile so the first-seen gate (T3.7) always routes the
// callback to the confirm-gesture redirect branch.
jest.mock('../services/google-adapter', () => {
  return class MockGoogleAdapterForRegression {
    constructor() {
      this.clientId = 'test-google-client';
      this.clientSecret = 'test-google-secret';
      this.redirectUri =
        'http://localhost:4500/api/v1/oauth/callback/google';
    }
    getAuthorizationUrl(state) {
      return `https://mock-oauth.local/auth?state=${encodeURIComponent(
        state
      )}`;
    }
    async exchangeCodeForToken() {
      return {
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        scope: 'email profile',
        expiresIn: 3600,
      };
    }
    async verifyToken() {
      return {
        data: {
          email: 'regression-user@example.com',
          name: 'Regression User',
          sub: 'google-regression-sub',
        },
      };
    }
  };
});

const request = require('supertest');

// Lazily import the app so environment variables above are honored at boot.
let app;
beforeAll(() => {
  ({ app } = require('../index'));
});

/**
 * M1 / T1.1–T1.3 — Turso endpoints were an unauthenticated full-database
 * SQL export + an open SQL relay. They were deleted on 2026-04-21. These
 * tests ensure they stay deleted.
 *
 * If any of the paths below ever return 2xx again, something has gone very
 * wrong.
 */
describe('[M1] Removed Turso endpoints', () => {
  const removedRoutes = [
    { method: 'get', path: '/turso-import' },
    { method: 'get', path: '/api/v1/turso/export-sql' },
    { method: 'post', path: '/api/v1/turso/execute' },
  ];

  test.each(removedRoutes)(
    '$method $path is not served (no 2xx, no 3xx)',
    async ({ method, path }) => {
      const res =
        method === 'get'
          ? await request(app).get(path)
          : await request(app)
              .post(path)
              .send({ sql: 'SELECT 1', tursoUrl: 'https://example.invalid' })
              .set('Authorization', 'Bearer not-a-real-token');

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect([401, 403, 404, 405]).toContain(res.status);
    }
  );

  test('GET /turso-import cannot be authenticated into existence', async () => {
    const res = await request(app)
      .get('/turso-import')
      .set('Authorization', 'Bearer anything');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  test('POST /api/v1/turso/execute does not leak SQL error messages', async () => {
    const res = await request(app)
      .post('/api/v1/turso/execute')
      .send({ sql: "SELECT 'pwn' --", tursoUrl: 'https://example.invalid' });

    const body = JSON.stringify(res.body || {});
    expect(body.toLowerCase()).not.toContain('turso');
    expect(body).not.toContain('pwn');
  });
});

/**
 * M1 / T1.4–T1.5 — The OAuth Google config used to fall back to hardcoded
 * `REMOVED_CLIENT_ID` / `REMOVED_SECRET` strings. The module should no
 * longer reference those strings at runtime.
 *
 * We can't introspect `oauthConfig` directly (it's a local in `src/index.js`),
 * but we can assert the module's text doesn't contain those constants as
 * code paths any more — this is a cheap tripwire until `grep`-as-test lives
 * in a proper lint rule.
 */
describe('[M1] No hardcoded Google OAuth credential fallbacks', () => {
  const fs = require('fs');
  const path = require('path');
  const srcPath = path.join(__dirname, '..', 'index.js');
  const source = fs.readFileSync(srcPath, 'utf8');

  test('source does not fall back to REMOVED_CLIENT_ID at runtime', () => {
    // It's fine if this string appears inside a comment; it's not fine if it
    // appears as a fallback after `||`, which would recreate the vulnerable path.
    const runtimeFallbackPattern =
      /process\.env\.GOOGLE_CLIENT_ID\s*\|\|\s*['"]REMOVED_CLIENT_ID['"]/;
    expect(source).not.toMatch(runtimeFallbackPattern);
  });

  test('source does not fall back to REMOVED_SECRET at runtime', () => {
    const runtimeFallbackPattern =
      /process\.env\.GOOGLE_CLIENT_SECRET\s*\|\|\s*['"]REMOVED_SECRET['"]/;
    expect(source).not.toMatch(runtimeFallbackPattern);
  });

  test('google.enabled is computed from the presence of both env vars', () => {
    const enabledComputedPattern =
      /enabled:\s*Boolean\(\s*process\.env\.GOOGLE_CLIENT_ID\s*&&\s*process\.env\.GOOGLE_CLIENT_SECRET\s*\)/;
    expect(source).toMatch(enabledComputedPattern);
  });
});

/**
 * Placeholder suites — these are tracked in `.context/TASKS.md` and will be
 * filled in as their milestones land. Keeping the describes present (with
 * skipped bodies) makes the coverage expectations explicit and easy to scan
 * in CI output.
 */
/**
 * M3 / T3.8 — OAuth state + PKCE + confirm-gesture regression matrix.
 *
 * This suite is the §5.4-aligned locking layer for the full OAuth
 * hardening done across M3 Steps 1–6:
 *   - Steps 1–3 built the DB-backed single-use state row + domain
 *     module (ADR-0006, ADR-0014).
 *   - Steps 4–5 rewired the authorize + callback handlers onto the
 *     domain module and deleted `buildPkcePairFromState` + the
 *     Discord `!state && guild_id` carve-out (closes plan.md §6.3
 *     C3 + C6 + H1 at the handler level).
 *   - Step 6 / T3.7 added the user-facing confirm-gesture screen
 *     + `oauth_pending_logins` row-as-SSOT (closes the C3
 *     session-fixation variant, ADR-0016).
 *
 * Behavioural coverage for each of those invariants already exists in
 * dedicated suites (`oauth-state-domain.test.js`,
 * `oauth-authorize-handler.test.js`, `oauth-callback-handler.test.js`,
 * `oauth-confirm-handler.test.js`). This suite's job is different:
 * it pins the five explicit plan.md §5.4 regression bullets so any
 * future refactor that rolls back the invariant — even silently —
 * trips a named security test in the regression frame the project
 * uses for "this used to be broken and now it isn't".
 *
 * Status-code note.  plan.md §5.4 documents the confirm-token replay
 * bullet as "→ expect 401"; the T3.7 implementation actually returns
 * a discriminated 400 with `error: 'pending_confirm_reused'` (same
 * taxonomy family as the state-row 400s). We follow the implemented
 * contract here and document the deviation inline so a future reader
 * doesn't chase the 401/400 mismatch as a bug.
 */
describe('[M3 / T3.8] OAuth state + PKCE + confirm regression matrix', () => {
  const crypto = require('crypto');
  const request2 = require('supertest');
  let rawDb;

  // Must line up exactly with the mocked Google adapter's
  // verifyToken() response above. Tests 4 + 5 rely on the callback
  // finding an EXISTING user by this email so the flow funnels
  // through the T3.7 first-seen confirm-gesture path; otherwise it
  // short-circuits to oauth_status=signup_required (which is what
  // an un-seeded environment correctly does for a brand-new user).
  const REGRESSION_EMAIL = 'regression-user@example.com';

  beforeAll(() => {
    // The app boot in the top-level `beforeAll` has already run
    // `initDatabase()`, so grabbing the singleton is safe here.
    const dbApi = require('../database');
    rawDb = dbApi.getRawDB ? dbApi.getRawDB() : dbApi.db;

    // Seed a users row so the callback's email lookup hits. Schema
    // mirrors src/tests/oauth-confirm-handler.test.js#seedUser.
    // Idempotent — safe to run on a shared in-memory DB across
    // suites that reuse this file's mock.
    const existing = rawDb
      .prepare('SELECT id FROM users WHERE email = ?')
      .get(REGRESSION_EMAIL);
    if (!existing) {
      const now = new Date().toISOString();
      rawDb
        .prepare(
          `INSERT INTO users (id, username, display_name, email, password_hash,
                              two_factor_enabled, created_at, status, plan)
             VALUES (?, ?, ?, ?, '', 0, ?, 'active', 'free')`
        )
        .run(
          'user_' + crypto.randomBytes(6).toString('hex'),
          'regression_user',
          'Regression User',
          REGRESSION_EMAIL,
          now
        );
    }
  });

  /** Issue an authorize and return the DB-persisted state token.
   *  Uses `?json=1` so we don't need to parse the provider redirect. */
  async function issueGoogleState(query = {}) {
    const agent = request2.agent(app);
    const qs = new URLSearchParams({
      json: '1',
      mode: 'login',
      returnTo: '/dashboard/',
      ...query,
    }).toString();
    const res = await agent.get(`/api/v1/oauth/authorize/google?${qs}`);
    if (res.status !== 200 || !res.body?.state) {
      throw new Error(
        `authorize(google) did not return a state token — ` +
          `status=${res.status} body=${JSON.stringify(res.body)}`
      );
    }
    return { agent, state: res.body.state };
  }

  // -----------------------------------------------------------------
  // §5.4 bullet: "Attempt OAuth callback with reused `state` → 400"
  // -----------------------------------------------------------------
  test('callback rejects replayed state with 400 STATE_REUSED', async () => {
    const { agent, state } = await issueGoogleState();

    // First callback — consumes the row.
    const first = await agent
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);
    expect(first.status).toBe(302);

    // Second callback with the same state — must be rejected.
    const replay = await agent
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);
    expect(replay.status).toBe(400);
    expect(replay.body?.code).toBe('STATE_REUSED');

    // Row stays consumed (used_at persists).
    const row = rawDb
      .prepare('SELECT used_at FROM oauth_state_tokens WHERE state_token = ?')
      .get(state);
    expect(row.used_at).not.toBeNull();
  });

  // -----------------------------------------------------------------
  // §5.4 bullet: "Attempt OAuth callback with `state` missing +
  //               `guild_id` → 400"
  // Pre-Step-5 this was a 302 thanks to the `isDiscordBotInstall`
  // carve-out. Post-Step-5 (T3.6) state is mandatory for every
  // provider, Discord included.
  // -----------------------------------------------------------------
  test('callback rejects missing state + guild_id (Discord bypass removed) with 400', async () => {
    const res = await request2(app)
      .get('/api/v1/oauth/callback/discord?code=abc&guild_id=12345')
      .redirects(0);
    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------
  // §5.4 bullet: "Attempt OAuth callback with expired `state` → 400"
  // We forcibly age the row past its TTL — equivalent to waiting
  // 10+ minutes without the wall-clock fragility.
  // -----------------------------------------------------------------
  test('callback rejects expired state with 400 STATE_EXPIRED (row.used_at stays NULL)', async () => {
    const { agent, state } = await issueGoogleState();
    rawDb
      .prepare(
        'UPDATE oauth_state_tokens SET expires_at = ? WHERE state_token = ?'
      )
      .run(new Date(Date.now() - 60_000).toISOString(), state);

    const res = await agent
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe('STATE_EXPIRED');

    const row = rawDb
      .prepare('SELECT used_at FROM oauth_state_tokens WHERE state_token = ?')
      .get(state);
    // Critical: expired rows must NOT be consumed. Otherwise a benign
    // retry (user clicks the link again after the TTL) would trip a
    // REUSED on a row that was never successfully redeemed.
    expect(row.used_at).toBeNull();
  });

  // -----------------------------------------------------------------
  // §5.4 bullet: "valid flow end-to-end returns 302"
  // End-to-end check: authorize → callback → 302 to the confirm
  // gesture screen (T3.7 first-seen path). The response is a 302
  // whose Location carries `oauth_status=confirm_login` + a fresh
  // confirm token, and the state row is marked consumed.
  // -----------------------------------------------------------------
  test('valid state → 302 redirect to confirm-gesture screen with a fresh pending_confirm token', async () => {
    const { agent, state } = await issueGoogleState();

    const res = await agent
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);

    expect(res.status).toBe(302);
    const loc = res.headers.location || '';
    // M3 Step 6: first-seen logins funnel through the gesture screen
    // at /dashboard/?...&oauth_status=confirm_login&token=...
    expect(loc).toMatch(/oauth_status=confirm_login/);
    expect(loc).toMatch(/[?&]token=/);

    const row = rawDb
      .prepare(
        'SELECT used_at FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(state);
    expect(row.used_at).not.toBeNull();
  });

  // -----------------------------------------------------------------
  // §5.4 bullet: "Attempt to log in with stale / replayed
  //               `confirm_login` token → expect 401"
  //
  // Taxonomy note: implementation returns 400 with
  // `error: 'pending_confirm_reused'` (discriminated-400 family, same
  // shape as the state-row 400s). We assert the implemented contract.
  //
  // The flow: callback emits a confirm token → first POST /confirm
  // consumes it → replay of the SAME token must be rejected without
  // logging anyone in.
  // -----------------------------------------------------------------
  test('replayed pending-confirm token is rejected (400 pending_confirm_reused) and does NOT set a session', async () => {
    const { agent, state } = await issueGoogleState();

    // Callback → 302 to gesture screen
    const cb = await agent
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);
    expect(cb.status).toBe(302);
    const loc = cb.headers.location || '';
    const match = loc.match(/[?&]token=([^&]+)/);
    if (!match) {
      throw new Error(
        `callback did not emit a confirm token in Location — loc=${loc}`
      );
    }
    const confirmToken = decodeURIComponent(match[1]);

    // First consume — sanity-check the accept side works so the
    // "replay is what's rejected" assertion below is meaningful.
    const first = await agent
      .post('/api/v1/oauth/confirm')
      .set('Content-Type', 'application/json')
      .send({ token: confirmToken });
    expect(first.status).toBe(200);
    expect(first.body?.ok).toBe(true);

    // Replay with a FRESH agent so the success of the first call
    // doesn't mask a hypothetical "short-circuit on session" bug on
    // the second.
    const attacker = request2.agent(app);
    const replay = await attacker
      .post('/api/v1/oauth/confirm')
      .set('Content-Type', 'application/json')
      .send({ token: confirmToken });

    expect(replay.status).toBe(400);
    expect(replay.body?.error).toBe('pending_confirm_reused');

    // And critically: the attacker agent has NO authenticated session.
    // /auth/me should answer as for an anonymous caller (401 / 403 /
    // empty body — shape varies by deployment; what matters is "not
    // logged in as the victim"). We assert by the negative: the
    // replayer cannot read the confirmed user's identity.
    const whoami = await attacker.get('/api/v1/auth/me');
    // Status is 401 when no session exists; body (when a body is
    // served at all) does NOT carry the victim's email.
    expect([200, 401, 403]).toContain(whoami.status);
    if (whoami.status === 200) {
      // Defensive: if /auth/me returns 200 for anon (returns `{}` or
      // a guest object), it must NOT leak the victim's email.
      expect(whoami.body?.user?.email).not.toBe('regression-user@example.com');
    }
  });
});

// ---------------------------------------------------------------------
// M3 wrap-up — provider_subject threading end-to-end.
//
// The static gate in `oauth-state-inventory.test.js` asserts that every
// `storeOAuthToken(...)` call site in src/index.js passes a 7th arg.
// That catches drift at the source level. This describe block pins the
// RUNTIME invariant: after a full signup-mode walk-through, the row in
// `oauth_tokens` actually lands with `provider_subject` non-null.
//
// Why signup-mode specifically? The login-mode + connect-mode returning-
// user paths are already covered end-to-end by T3.7 / T3.8 (the
// confirm-gesture happy path in `oauth-confirm-handler.test.js` and the
// "valid state → 302 to confirm screen" test above). The signup branch
// (new user, oauth_status=signup_required, POST /auth/oauth-signup/complete)
// is the only production path that writes `oauth_tokens` WITHOUT going
// through the gesture screen — so it's the remaining hole and
// deservedly gets its own assertion here.
// ---------------------------------------------------------------------
describe('[M3 wrap-up] signup-mode stores provider_subject end-to-end', () => {
  const request3 = require('supertest');
  let rawDb;
  const SIGNUP_EMAIL = 'wrapup-signup@example.com';
  const SIGNUP_SUB = 'google-wrapup-sub';

  // We cannot reshape the top-of-file `jest.mock('../services/google-adapter')`
  // at a per-test level, but we CAN monkey-patch the mock class prototype
  // before each test runs. Jest hoists `jest.mock(...)` but does NOT
  // freeze the resulting constructor — so grabbing it via the module
  // registry here is the same object the OAuth callback will `new`.
  beforeAll(() => {
    const dbApi = require('../database');
    rawDb = dbApi.getRawDB ? dbApi.getRawDB() : dbApi.db;
  });

  beforeEach(() => {
    // Ensure NO user exists for SIGNUP_EMAIL — the callback's email
    // lookup must miss so it routes to `oauth_status=signup_required`.
    rawDb.prepare('DELETE FROM users WHERE email = ?').run(SIGNUP_EMAIL);

    // Rewire the mock google adapter for this test — return the signup
    // email + a deterministic `sub` so we can assert on it.
    const MockAdapter = require('../services/google-adapter');
    MockAdapter.prototype.verifyToken = async function () {
      return {
        data: {
          email: SIGNUP_EMAIL,
          name: 'Wrap-up Signup',
          sub: SIGNUP_SUB,
        },
      };
    };
  });

  afterAll(() => {
    // Restore the default verify-token profile so subsequent suites in
    // the same Jest worker aren't affected. In practice security-regression
    // is the last consumer of the mock, but being careful costs nothing.
    const MockAdapter = require('../services/google-adapter');
    MockAdapter.prototype.verifyToken = async function () {
      return {
        data: {
          email: 'regression-user@example.com',
          name: 'Regression User',
          sub: 'google-regression-sub',
        },
      };
    };
  });

  test('full authorize → callback → /oauth-signup/complete writes user_identity_links, NOT oauth_tokens (F4)', async () => {
    // F4 (ADR-0018) + choice 3a: signup is identity-only. Historically
    // signup-complete wrote both oauth_tokens (service grant) and
    // first_confirmed_at (identity first-seen). Post-F4, signup writes
    // ONLY the identity link — the user must explicitly connect Google
    // as a service afterwards if they want proxiable API access. This
    // test locks that contract.
    const agent = request3.agent(app);

    // 1. authorize — grab the state token via ?json=1.
    const authz = await agent.get(
      `/api/v1/oauth/authorize/google?json=1&mode=login&returnTo=/dashboard/`
    );
    expect(authz.status).toBe(200);
    const state = authz.body?.state;
    expect(typeof state).toBe('string');

    // 2. callback — unknown email → redirect to signup-required.
    const cb = await agent
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);
    expect(cb.status).toBe(302);
    expect(cb.headers.location || '').toMatch(/oauth_status=signup_required/);

    const pending = await agent.get('/api/v1/auth/oauth-signup/pending');
    expect(pending.status).toBe(200);
    expect(pending.body?.data?.nonce).toEqual(expect.any(String));
    expect(pending.body?.data?.email).toBe(SIGNUP_EMAIL);
    const nonce = pending.body.data.nonce;

    const complete = await agent
      .post('/api/v1/auth/oauth-signup/complete')
      .set('Content-Type', 'application/json')
      .send({
        oauthSignupConfirm: true,
        oauthSignupNonce: nonce,
        termsAccepted: true,
        username: 'wrapup_signup',
        displayName: 'Wrap-up Signup',
        email: SIGNUP_EMAIL,
        timezone: 'UTC',
      });

    expect([200, 201]).toContain(complete.status);
    expect(complete.body?.ok).toBe(true);

    const newUser = rawDb
      .prepare('SELECT id FROM users WHERE email = ?')
      .get(SIGNUP_EMAIL);
    expect(newUser?.id).toBeTruthy();

    // F4 invariant A: identity link exists, provider_subject set,
    // first_confirmed_at non-null (implicit consent at signup).
    const linkRow = rawDb
      .prepare(
        `SELECT provider, provider_subject, first_confirmed_at
           FROM user_identity_links
          WHERE user_id = ? AND provider = ?`
      )
      .get(newUser.id, 'google');

    expect(linkRow).toBeTruthy();
    expect(linkRow.provider_subject).toBe(SIGNUP_SUB);
    expect(linkRow.first_confirmed_at).toBeTruthy();

    // F4 invariant B: no service-grant row written at signup — the user
    // must explicitly connect Google from Services for proxyable access.
    const tokenRow = rawDb
      .prepare(
        `SELECT id FROM oauth_tokens WHERE user_id = ? AND service_name = ?`
      )
      .get(newUser.id, 'google');
    expect(tokenRow).toBeUndefined();
  });
});

/**
 * F3 Pass 2 — `REAUTH_REQUIRED` recovery path tripwires.
 *
 * Behavioural coverage for `refreshOAuthToken` on `invalid_grant` lives in
 * `src/tests/oauth-refresh-invalid-grant.test.js` — that suite stands up a
 * real DB + a loopback HTTP server and proves the column is cleared.
 *
 * This suite is the complementary static-analysis lock: if someone
 * refactors `src/index.js` and removes the REAUTH_REQUIRED branches from
 * the proxy + execute handlers (or the `reauth_required` status emission
 * from /oauth/status), the behavioural tests would still pass on a
 * non-expired token but silently regress the UX contract we documented
 * in ADR-0017. These tripwires force any such removal to be deliberate.
 */
describe('[F3 Pass 2] REAUTH_REQUIRED envelope + status surface tripwires', () => {
  const fs = require('fs');
  const path = require('path');
  const indexSrc = fs.readFileSync(
    path.join(__dirname, '..', 'index.js'),
    'utf8'
  );

  test('source contains a REAUTH_REQUIRED response envelope', () => {
    // The proxy + execute handlers both emit this exact code on a dead
    // grant. Two occurrences is the minimum (one per handler); we allow
    // more in case the cache-invalidation helper is reused elsewhere.
    const matches = indexSrc.match(/error:\s*['"]REAUTH_REQUIRED['"]/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test('source invalidates the token cache when emitting REAUTH_REQUIRED', () => {
    // Without this, a cached dead token would keep proxy/execute returning
    // stale "connected" responses until the 5-minute TTL expired. See
    // src/index.js cache helpers.
    expect(indexSrc).toMatch(/invalidateCachedOAuthToken\(/);
  });

  test('/oauth/status emits the `reauth_required` state', () => {
    expect(indexSrc).toMatch(/connectionStatus\s*=\s*['"]reauth_required['"]/);
  });

  test('refreshOAuthToken detects invalid_grant and nulls refresh_token', () => {
    // Locking the contract `refreshOAuthToken` → `{reauthRequired: true}`
    // surfaces on invalid_grant. The behavioural suite proves the full
    // round-trip; this test just stops someone from silently removing
    // the branch.
    const dbSrc = fs.readFileSync(
      path.join(__dirname, '..', 'database.js'),
      'utf8'
    );
    expect(dbSrc).toMatch(/providerError\s*===\s*['"]invalid_grant['"]/);
    expect(dbSrc).toMatch(/reauthRequired:\s*true/);
    expect(dbSrc).toMatch(/SET\s+refresh_token\s*=\s*NULL/);
  });

  test('google-adapter default prompt is `select_account` (F3 Pass 2 adapter flip)', () => {
    // Pairs with the behavioural unit test in oauth-security-hardening.test.js
    // ("GoogleAdapter default getAuthorizationUrl emits prompt=select_account").
    // The static check here is a tripwire in case someone edits the adapter
    // and the unit suite is silently skipped.
    const adapterSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'google-adapter.js'),
      'utf8'
    );
    expect(adapterSrc).toMatch(/prompt:\s*['"]select_account['"]/);
    // Strip JS comments before checking that `prompt: 'consent'` isn't a
    // real object property any more. The Pass 2 adapter file intentionally
    // mentions the old `'consent'` default in a comment explaining the
    // flip — we don't want that mention to satisfy the tripwire.
    const stripped = adapterSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*\n/g, '\n');
    expect(stripped).not.toMatch(/prompt:\s*['"]consent['"]/);
  });
});

/**
 * F4 — identity-vs-service scope separation tripwires.
 *
 * The behavioural matrix lives in
 * `src/tests/oauth-identity-service-separation.test.js`. This suite is
 * the static-analysis lock: if someone refactors an adapter and removes
 * the IDENTITY_SCOPES / SERVICE_SCOPES split, or refactors the callback
 * handler back into writing `oauth_tokens` on login, the behavioural
 * tests might still pass against a stale jest cache while the deployed
 * code quietly regresses. These tripwires scan the actual source files
 * on disk and force any such removal to be deliberate.
 *
 * See ADR-0018 for the full design rationale.
 */
describe('[F4] identity-vs-service scope separation tripwires', () => {
  const fs = require('fs');
  const path = require('path');

  const googleSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'google-adapter.js'),
    'utf8'
  );
  const githubSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'github-adapter.js'),
    'utf8'
  );
  const genericSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'generic-oauth-adapter.js'),
    'utf8'
  );
  const indexSrc = fs.readFileSync(
    path.join(__dirname, '..', 'index.js'),
    'utf8'
  );

  test('Google adapter declares IDENTITY_SCOPES and SERVICE_SCOPES', () => {
    expect(googleSrc).toMatch(/IDENTITY_SCOPES\s*=/);
    expect(googleSrc).toMatch(/SERVICE_SCOPES\s*=/);
    // The identity set is hard-coded and not env-driven; the service
    // set IS env-driven via GOOGLE_SCOPE. Flipping these by accident
    // would be a big regression, so we pin both sides.
    expect(googleSrc).toMatch(/IDENTITY_SCOPES\s*=\s*['"]openid email profile['"]/);
    expect(googleSrc).toMatch(/process\.env\.GOOGLE_SCOPE/);
  });

  test('GitHub adapter declares IDENTITY_SCOPES and SERVICE_SCOPES', () => {
    expect(githubSrc).toMatch(/IDENTITY_SCOPES\s*=/);
    expect(githubSrc).toMatch(/SERVICE_SCOPES\s*=/);
    expect(githubSrc).toMatch(/IDENTITY_SCOPES\s*=\s*['"]read:user user:email['"]/);
  });

  test('Generic OAuth adapter honours mode-based scope resolution', () => {
    // The generic adapter MUST accept identityScope + serviceScope in
    // addition to the legacy single-scope config, and MUST have a
    // _resolveScope-style branch that picks based on mode.
    expect(genericSrc).toMatch(/identityScope/);
    expect(genericSrc).toMatch(/serviceScope/);
    // Either an explicit helper, or the mode === 'login' check inline.
    expect(genericSrc).toMatch(/mode\s*===\s*['"]login['"]/);
  });

  test('authorize handler threads `{ mode }` into adapter.getAuthorizationUrl', () => {
    // src/index.js:~8580
    expect(indexSrc).toMatch(
      /getAuthorizationUrl\(\s*state,\s*runtimeAuthParams,\s*\{\s*mode\s*\}/
    );
  });

  test('login-mode callback does NOT call storeOAuthToken (identity-only)', () => {
    // The post-F4 returning-user fast-path writes user_identity_links,
    // not oauth_tokens. Strip comments so the BEFORE/AFTER context in
    // code comments doesn't trip this tripwire.
    const stripped = indexSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*\n/g, '\n');

    // Find the fast-path branch body and assert it calls
    // upsertIdentityLink, not storeOAuthToken, for the identity refresh.
    const fastPathMatch = stripped.match(
      /if\s*\(\s*!firstSeen\s*\)\s*\{[\s\S]*?return\s+req\.session\.save/
    );
    expect(fastPathMatch).toBeTruthy();
    const fastPathBody = fastPathMatch[0];
    expect(fastPathBody).toMatch(/upsertIdentityLink\(/);
    expect(fastPathBody).not.toMatch(/storeOAuthToken\(/);
  });

  test('user_identity_links schema + PK/UNIQUE invariants are declared', () => {
    const dbSrc = fs.readFileSync(
      path.join(__dirname, '..', 'database.js'),
      'utf8'
    );
    expect(dbSrc).toMatch(/CREATE TABLE IF NOT EXISTS user_identity_links/);
    expect(dbSrc).toMatch(/PRIMARY KEY\s*\(\s*user_id,\s*provider\s*\)/);
    expect(dbSrc).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identity_links_provider_subject/
    );
  });

  test('connect-mode callback declares providerUserId at outer-try scope (F4 regression tripwire)', () => {
    // 2026-04-24 regression: connect-mode callback silently threw
    // `ReferenceError: providerUserId is not defined` because the
    // variable was declared `const` inside the login-only branch and
    // the connect branch blindly referenced it when building the
    // storeOAuthToken call. The catch-all swallowed the error (no
    // console log) and redirected to /dashboard/?oauth_status=error,
    // which the SPA bounced to the landing page — symptom: user
    // completes the full consent flow but "Google is not connected."
    //
    // This tripwire pins the fix: the declaration MUST live at the
    // outer try-scope with a `let` so BOTH branches can read/assign
    // it safely.
    const stripped = indexSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*\n/g, '\n');
    // Outer-scope declaration (with initializer) must exist somewhere
    // in the callback handler body before any `storeOAuthToken` call.
    expect(stripped).toMatch(/let\s+providerUserId\s*=\s*null/);
    // And the login-branch reassignment must use plain assignment,
    // NOT `const`/`let` redeclaration (which would shadow the outer
    // binding and leak the old bug).
    expect(stripped).not.toMatch(/(const|let)\s+providerUserId\s*=\s*String\(/);
  });

  test('connect-mode callback surfaces unhandled errors to console (F4 observability tripwire)', () => {
    // Companion to the providerUserId tripwire above: even if a new
    // silent rejection lands here in the future, the console.error
    // branch in the catch must stay so operators can diagnose from
    // the container log without needing to `git blame` to find which
    // variable went missing.
    expect(indexSrc).toMatch(
      /console\.error\(\s*`\[OAuth Callback\] ❌ caught error for service=/
    );
  });

  test('signup-complete does NOT call storeOAuthToken (choice 3a: identity-only signup)', () => {
    // Locate the post-F4 signup-complete `if (pending.providerUserId)`
    // block and assert it calls recordFirstConfirmation but NOT
    // storeOAuthToken.
    const stripped = indexSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*\n/g, '\n');

    // The whole "pending has a providerUserId → stamp identity" block
    // is small and self-contained.
    const blockMatch = stripped.match(
      /if\s*\(\s*pending\.providerUserId\s*\)\s*\{[\s\S]{0,800}?\}\s*\}/
    );
    expect(blockMatch).toBeTruthy();
    const block = blockMatch[0];
    expect(block).toMatch(/recordFirstConfirmation\(/);
    expect(block).not.toMatch(/storeOAuthToken\(/);
  });
});

/**
 * M3 / T3.7 — SPA "no auto-confirm" invariant.
 *
 * ADR-0014 Step 6 + T3.7 established the rule that /api/v1/oauth/confirm
 * is ONLY POSTed in response to an explicit user gesture ("Continue" on
 * the confirm screen). The gesture screen lives in
 * `src/public/dashboard-app/src/pages/LogIn.jsx` and it is the ONLY
 * call site in the SPA. Auto-POSTing from any other page silently
 * re-opens the C3 session-fixation variant.
 *
 * SignUp.jsx had a stray `fetch('/api/v1/oauth/confirm', { method: 'POST' })`
 * (removed 2026-04-xx) that was dead in the happy path but live if a
 * tampered `returnTo` ever pointed at /dashboard/signup. These static
 * tripwires pin the invariant so it can't quietly come back.
 */
describe('[M3 / T3.7] SPA no-auto-confirm invariant tripwires', () => {
  const fs = require('fs');
  const path = require('path');

  const signupSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'dashboard-app', 'src', 'pages', 'SignUp.jsx'),
    'utf8'
  );
  const loginSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'dashboard-app', 'src', 'pages', 'LogIn.jsx'),
    'utf8'
  );

  // Strip comments so a BEFORE/AFTER-style code comment that quotes the
  // deleted call doesn't trip the tripwire.
  const stripComments = (src) =>
    src
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*\n/g, '\n');

  test('SignUp.jsx does NOT POST /api/v1/oauth/confirm (T3.7 invariant)', () => {
    const stripped = stripComments(signupSrc);
    // The full POST call site — method: 'POST' on the confirm endpoint.
    // Matching on the URL alone would false-positive on /confirm/preview
    // and /confirm/reject, which are both safe read-only / reject paths.
    expect(stripped).not.toMatch(/fetch\(\s*['"]\/api\/v1\/oauth\/confirm['"][\s\S]{0,200}?method:\s*['"]POST['"]/);
    // Defence in depth: no literal confirm endpoint body call at all in
    // SignUp.jsx. If a future refactor ever needs to hit the endpoint
    // from the signup page, it MUST be gated behind a user gesture and
    // this tripwire MUST be updated in the same PR.
    expect(stripped).not.toMatch(/['"]\/api\/v1\/oauth\/confirm['"]\s*,/);
  });

  test('LogIn.jsx still owns the confirm gesture (positive guard)', () => {
    const stripped = stripComments(loginSrc);
    // Continue button wiring — the ONE sanctioned POST to /oauth/confirm
    // in the SPA. If this ever disappears, the gesture screen is broken.
    expect(stripped).toMatch(/fetch\(\s*['"]\/api\/v1\/oauth\/confirm['"][\s\S]{0,300}?method:\s*['"]POST['"]/);
    // And the preview endpoint is called read-only from the loading
    // state (separate from the accept POST).
    expect(stripped).toMatch(/\/api\/v1\/oauth\/confirm\/preview/);
  });

  test('SignUp.jsx hands off OAuth callbacks to LogIn.jsx (UX contract)', () => {
    // After the T3.7 fix, every non-error oauth_status that lands on
    // /dashboard/signup is bounced to /dashboard/ (or /dashboard/login
    // for pending_2fa) while preserving the query string so LogIn.jsx
    // can render the correct screen. Pin the redirect helper + at least
    // one call site so the handoff contract can't silently disappear.
    const stripped = stripComments(signupSrc);
    expect(stripped).toMatch(/redirectToLoginPreservingQuery\s*\(/);
    expect(stripped).toMatch(/case\s+['"]confirm_login['"]/);
  });
});

/**
 * F4 hardening (2026-04-24) — bugs identified in post-F4 code review.
 *
 * Every tripwire below pins one of the B1–B7 fixes. If one breaks, the
 * corresponding footgun has returned and MUST NOT ship. Each case has
 * inline commentary pointing at the original failure mode.
 */
describe('[F4 hardening] B1–B7 post-review tripwires', () => {
  const fs = require('fs');
  const path = require('path');

  const stripJsComments = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*\n/g, '\n');
  const stripJsxComments = (src) =>
    src
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*\n/g, '\n');

  const indexSource = fs.readFileSync(
    path.join(__dirname, '..', 'index.js'),
    'utf8'
  );
  const strippedIndex = stripJsComments(indexSource);

  const googleAdapterSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'google-adapter.js'),
    'utf8'
  );
  const githubAdapterSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'github-adapter.js'),
    'utf8'
  );
  const genericAdapterSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'generic-oauth-adapter.js'),
    'utf8'
  );
  const signupSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'dashboard-app', 'src', 'pages', 'SignUp.jsx'),
    'utf8'
  );
  const loginSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'dashboard-app', 'src', 'pages', 'LogIn.jsx'),
    'utf8'
  );
  const oauthUtilSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'dashboard-app', 'src', 'utils', 'oauth.js'),
    'utf8'
  );

  // ------------------------------------------------------------------
  // B5/B6: LogIn.jsx + SignUp.jsx go through startOAuthFlow, never
  // hand-roll `/api/v1/oauth/authorize/...` URLs.
  // ------------------------------------------------------------------

  test('B5/B6: LogIn.jsx calls startOAuthFlow, not window.location.href with authorize URL', () => {
    const stripped = stripJsxComments(loginSrc);
    expect(stripped).toMatch(/startOAuthFlow\(/);
    // No hand-rolled `window.location.href = ..."/api/v1/oauth/authorize/"`
    expect(stripped).not.toMatch(/window\.location\.href\s*=\s*[`'"]\/api\/v1\/oauth\/authorize/);
  });

  test('B5/B6: SignUp.jsx calls startOAuthFlow, not window.location.href with authorize URL', () => {
    const stripped = stripJsxComments(signupSrc);
    expect(stripped).toMatch(/startOAuthFlow\(/);
    expect(stripped).not.toMatch(/window\.location\.href\s*=\s*[`'"]\/api\/v1\/oauth\/authorize/);
  });

  test('B5/B6: startOAuthFlow gates masterToken injection by mode', () => {
    // Identity flows MUST NOT attach a stale masterToken to the authorize
    // URL. The helper branches on !isIdentityMode before appending it.
    const stripped = stripJsComments(oauthUtilSrc);
    expect(stripped).toMatch(/if\s*\(\s*!\s*isIdentityMode\s*\)\s*\{[\s\S]{0,400}?params\.append\(\s*['"]token['"]/);
  });

  // ------------------------------------------------------------------
  // B4: SignUp→LogIn handoff uses an allow-list, not the raw
  // window.location.search.
  // ------------------------------------------------------------------

  test('B4: redirectToLoginPreservingQuery uses a callback-key allow list', () => {
    const stripped = stripJsxComments(signupSrc);
    expect(stripped).toMatch(/CALLBACK_PARAM_ALLOW_LIST/);
    // The function builds a new URLSearchParams from the allow-list,
    // not from the raw window.location.search.
    expect(stripped).toMatch(
      /function\s+redirectToLoginPreservingQuery[\s\S]{0,600}?for\s*\(\s*const\s+key\s+of\s+CALLBACK_PARAM_ALLOW_LIST/
    );
  });

  // ------------------------------------------------------------------
  // B2: Google + GitHub exchangeCodeForToken spread runtimeTokenParams.
  // ------------------------------------------------------------------

  test('B2: Google adapter exchangeCodeForToken accepts and spreads runtimeTokenParams', () => {
    // Signature MUST accept a second arg with a default.
    expect(googleAdapterSrc).toMatch(
      /async\s+exchangeCodeForToken\s*\(\s*code\s*,\s*runtimeTokenParams\s*=\s*\{\}\s*\)/
    );
    // And the params MUST be spread into the postData body.
    expect(googleAdapterSrc).toMatch(/\.\.\.\(\s*runtimeTokenParams\s*\|\|\s*\{\}\s*\)/);
  });

  test('B2: GitHub adapter exchangeCodeForToken accepts and spreads runtimeTokenParams', () => {
    expect(githubAdapterSrc).toMatch(
      /async\s+exchangeCodeForToken\s*\(\s*code\s*,\s*runtimeTokenParams\s*=\s*\{\}\s*\)/
    );
    expect(githubAdapterSrc).toMatch(/\.\.\.\(\s*runtimeTokenParams\s*\|\|\s*\{\}\s*\)/);
  });

  // ------------------------------------------------------------------
  // B7: updateOAuthStatus("connected") fires ONLY after storeOAuthToken
  // returns — no longer immediately after exchangeCodeForToken.
  // ------------------------------------------------------------------

  test('B7: updateOAuthStatus("connected") lives after storeOAuthToken, not before', () => {
    // Locate the connect-mode storeOAuthToken call (the one inside the
    // `if (oauthOwnerId && !tokenStoredForUser)` branch) and assert the
    // `updateOAuthStatus("connected")` call immediately follows the
    // `tokenStoredForUser = true` flag flip.
    const match = strippedIndex.match(
      /const\s+storeResult\s*=\s*storeOAuthToken\(\s*service[\s\S]{0,500}?tokenStoredForUser\s*=\s*true[\s\S]{0,400}?updateOAuthStatus\(\s*service\s*,\s*["']connected["']\s*\)/
    );
    expect(match).toBeTruthy();
    // The pre-fix call-site used to fire immediately after
    // `adapter.exchangeCodeForToken(...)` — pin the current comment
    // block (check against the raw source, not the stripped one) so
    // dropping the fix without updating the guardrail trips this test.
    expect(indexSource).toMatch(/B7 \(2026-04-24 F4 hardening\)/);
  });

  // ------------------------------------------------------------------
  // B3: verifyToken failures in login-mode are logged + audited, never
  // silently swallowed.
  // ------------------------------------------------------------------

  test('B3: verifyToken failure logs console.warn AND emits oauth_verify_token_failed audit', () => {
    // The old silent `.catch(() => ({ valid:false, data:{} }))` is gone.
    expect(strippedIndex).not.toMatch(
      /verifyToken\([^)]*\)\.catch\(\s*\(\)\s*=>\s*\(\s*\{\s*valid:\s*false/
    );
    // New code path emits a warn + createAuditLog with the specific action.
    expect(strippedIndex).toMatch(/verifyToken failed for \$\{service\} login/);
    expect(strippedIndex).toMatch(/action:\s*["']oauth_verify_token_failed["']/);
  });

  // ------------------------------------------------------------------
  // B1: generic adapter honours legacy FACEBOOK_SCOPE / `scope` env var
  // in connect-mode when serviceScope is empty.
  // ------------------------------------------------------------------

  test('B1: generic adapter combines identityScope + legacy scope as connect fallback', () => {
    // The fallback branch MUST exist and prefer serviceScope, then
    // legacy `this.scope`, then identity-only.
    expect(genericAdapterSrc).toMatch(
      /if\s*\(\s*this\.serviceScope\s*\)\s*\{[\s\S]{0,120}?parts\.push\(\s*this\.serviceScope\s*\)[\s\S]{0,120}?\}\s*else\s+if\s*\(\s*this\.scope\s*\)\s*\{[\s\S]{0,120}?parts\.push\(\s*this\.scope\s*\)/
    );
  });

  // ------------------------------------------------------------------
  // Observability: callback timeline + audit coverage.
  // ------------------------------------------------------------------

  test('Obs: OAuth callback emits the four routing decision log labels', () => {
    // A future refactor that removes one of these silently regresses
    // our incident-diagnosis story. Pin all four.
    const required = [
      'routing=signup_required',
      'routing=pending_2fa',
      'routing=fast_path_returning',
      'routing=first_seen_gesture',
      'routing=connect_mode_store',
    ];
    for (const label of required) {
      expect(strippedIndex.includes(label)).toBe(true);
    }
  });

  test('Obs: OAuth callback entry point log line is present', () => {
    expect(strippedIndex).toMatch(/\[OAuth Callback\] entry/);
  });

  test('Obs: identity_link_error audit is emitted on the returning-user fast path', () => {
    // If upsertIdentityLink throws on the fast path we still have an
    // audit trail of the failure (pre-fix this was a lone
    // console.error with no structured trace).
    expect(strippedIndex).toMatch(/action:\s*["']identity_link_error["']/);
  });

  test('Obs: connect_plan_limit_blocked audit is emitted when plan cap fires', () => {
    expect(strippedIndex).toMatch(/action:\s*["']connect_plan_limit_blocked["']/);
  });

  // ------------------------------------------------------------------
  // B5/B6 follow-on: `mode=signup` is a supported VALID_MODES entry.
  //
  // Discovered during browser testing: dropping `signup` from the
  // whitelist in src/domain/oauth/state.js caused /authorize?mode=signup
  // to 500 with STATE_INVALID_MODE, even though the UI code path was
  // fully wired up. The dual-check (state.js + tripwire here) means a
  // revert cannot land silently again.
  // ------------------------------------------------------------------

  test('B5/B6: VALID_MODES in state.js includes "signup" alongside "login"', () => {
    const stateSrc = fs.readFileSync(
      path.join(__dirname, '..', 'domain', 'oauth', 'state.js'),
      'utf8'
    );
    // Parse the frozen-array definition and make sure both identity
    // labels (login, signup) are present. Using a loose regex to allow
    // whitespace / ordering changes.
    const match = stateSrc.match(/const\s+VALID_MODES\s*=\s*Object\.freeze\(\[([^\]]+)\]/);
    expect(match).toBeTruthy();
    const modes = match[1]
      .split(',')
      .map((m) => m.replace(/['"\s]/g, ''))
      .filter(Boolean);
    expect(modes).toContain('login');
    expect(modes).toContain('signup');
    expect(modes).toContain('connect');
  });

  // ------------------------------------------------------------------
  // B9: disconnect handler invalidates the in-memory token cache.
  //
  // Reported as "pressed Disconnect, looks stuck": the DELETE landed
  // but the 5-minute in-process tokenCache kept serving the old
  // token, so /oauth/status continued to report `connected`. The
  // tripwire pins the invalidateCachedOAuthToken(...,'disconnect')
  // call to the handler body so reverts can't land silently.
  // ------------------------------------------------------------------

  test('B9: disconnect handler calls invalidateCachedOAuthToken after revokeOAuthToken', () => {
    // Locate the disconnect handler and require the sequence:
    //   revokeOAuthToken(service, userId)
    //   ... some lines (comments etc) ...
    //   invalidateCachedOAuthToken(service, userId, 'disconnect')
    const match = strippedIndex.match(
      /app\.post\(\s*["']\/api\/v1\/oauth\/disconnect\/:service["'][\s\S]{0,3000}?revokeOAuthToken\(\s*service\s*,\s*userId\s*\)[\s\S]{0,400}?invalidateCachedOAuthToken\(\s*service\s*,\s*userId\s*,\s*["']disconnect["']\s*\)/
    );
    expect(match).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // B10: storeOAuthToken call-sites invalidate the cache so a
  // disconnect→reconnect cycle within the TTL shows the new grant.
  // ------------------------------------------------------------------

  test('B10: OAuth callback invalidates token cache after storeOAuthToken', () => {
    // The connect-mode storeOAuthToken(...) is immediately followed by
    // an invalidateCachedOAuthToken(..., 'store_after_callback') call.
    const match = strippedIndex.match(
      /const\s+storeResult\s*=\s*storeOAuthToken\([\s\S]{0,500}?tokenStoredForUser\s*=\s*true[\s\S]{0,400}?invalidateCachedOAuthToken\(\s*service\s*,\s*oauthOwnerId\s*,\s*["']store_after_callback["']\s*\)/
    );
    expect(match).toBeTruthy();
  });

  test('B10: /oauth/confirm consume path invalidates token cache after storeOAuthToken', () => {
    // After the confirm-row's storeOAuthToken, cache for {serviceName,
    // userId} is dropped with the 'store_after_confirm' tag.
    const match = strippedIndex.match(
      /storeOAuthToken\(\s*serviceName\s*,\s*userId[\s\S]{0,500}?invalidateCachedOAuthToken\(\s*serviceName\s*,\s*userId\s*,\s*["']store_after_confirm["']\s*\)/
    );
    expect(match).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // B11: dead `token.revoked_at` branch is gone from /oauth/status.
  //
  // `oauth_tokens` has no revoked_at column — disconnect physically
  // DELETEs the row. The stale check misled anyone auditing the
  // endpoint; drop-checking here keeps it from quietly reappearing
  // during a future "defensive" refactor.
  // ------------------------------------------------------------------

  test('B11: /oauth/status does not reference oauth_tokens.revoked_at', () => {
    // Search only inside the /oauth/status handler body to avoid
    // false positives from other tables that legitimately carry the
    // column (access_tokens, approved_devices, …).
    const statusHandler = strippedIndex.match(
      /app\.get\(\s*["']\/api\/v1\/oauth\/status["'][\s\S]*?\}\s*\)\s*;/
    );
    expect(statusHandler).toBeTruthy();
    expect(statusHandler[0]).not.toMatch(/token\.revoked_at/);
  });

  // ------------------------------------------------------------------
  // Obs: invalidateCachedOAuthToken emits an info log with a reason
  // tag so "is the cache behaving?" incidents are grep-able.
  // ------------------------------------------------------------------

  test('Obs: invalidateCachedOAuthToken logs at info with reason tag', () => {
    // Grab the function body up through the logger.info call instead of
    // trying to balance braces with a regex (template literals include
    // stray `}` characters that trip naive lazy-match patterns).
    const helper = strippedIndex.match(
      /function\s+invalidateCachedOAuthToken\(\s*serviceName\s*,\s*userId\s*,\s*reason\s*\)[\s\S]{0,1200}?logger\.info\([^)]{0,400}\)/
    );
    expect(helper).toBeTruthy();
    // The info call names the event and surfaces the reason + service + user.
    expect(helper[0]).toMatch(/logger\.info\(\s*["']tokenCache invalidated["']/);
    expect(helper[0]).toMatch(/reason:\s*reason/);
    // And the actual cache deletion lives above the log in the same body.
    expect(helper[0]).toMatch(/tokenCache\.delete\(\s*cacheKey\s*\)/);
  });
});

describe.skip('[M5] SSRF surface (to be added in T5.7)', () => {
  test.todo('proxy rejects http://169.254.169.254/');
  test.todo('proxy rejects http://[::ffff:127.0.0.1]/');
  test.todo('proxy rejects http://0177.0.0.1/');
  test.todo('proxy rejects http://2130706433/');
  test.todo('proxy rejects DNS-rebind host on second resolve');
});

describe.skip('[M3/M9] Scope + body-size (to be added in T12.1)', () => {
  test.todo('scope admin:* is rejected with 403');
  test.todo('scope *:* is rejected with 403');
  test.todo('request body > per-route limit returns 413');
});
