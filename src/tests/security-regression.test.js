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
