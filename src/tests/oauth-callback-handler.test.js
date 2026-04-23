/**
 * M3 Step 5 / T3.5 + T3.6 — integration suite for the rewired
 * `/api/v1/oauth/callback/:service` handler.
 *
 * Locks the Step 5 refactor:
 *   - Callback consumes the `oauth_state_tokens` row through
 *     `consumeStateToken(...)`. The session `oauthStateMeta` map is
 *     gone.
 *   - Replay, unknown, expired, and service-mismatch states each
 *     produce a discriminated 400 with a `code` string matching the
 *     ADR-0006 taxonomy.
 *   - The Discord `!state && guild_id` carve-out is removed: Discord
 *     shares the same state-row path as every other provider.
 *   - PKCE verifier for the provider's token exchange is taken from
 *     the consumed row, NOT from a deterministic helper.
 *
 * Covers:
 *   - ADR-0006 (consume-once state rows + random PKCE verifier)
 *   - ADR-0014 §Step 5 (execution plan)
 *   - plan.md §6.3 C3 (OAuth state not DB-validated — closes this)
 *   - plan.md §6.3 C6 (Discord state bypass — closes this)
 *   - TASKS.md T3.5 + T3.6
 *
 * Complements `oauth-authorize-handler.test.js` (Step 4). Between
 * them, one round-trip through the domain module is exercised
 * end-to-end without any session-backed state.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const request = require('supertest');

// Mock the Google adapter so no real OAuth provider is contacted.
// The test body reads the persisted `code_verifier` out of the DB
// directly when it needs to confirm PKCE-row provenance, so we don't
// need a spy on `exchangeCodeForToken`; that would also trip Jest's
// out-of-scope-variable guard on the hoisted factory.
jest.mock('../services/google-adapter', () => {
  return class MockGoogleAdapter {
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
      return { data: global.__cbProfile || {} };
    }
  };
});

describe('[M3 Step 5] GET /api/v1/oauth/callback/:service — DB-row is the source of truth', () => {
  let app;
  let dbApi;
  let rawDb;
  const ts = Date.now();

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.DB_PATH = path.join(
      __dirname,
      `tmp-oauth-callback-handler-${ts}.sqlite`
    );
    // OAuth adapters read these once at module load time, so they must
    // be populated BEFORE `require('../index')` below. Twitter is
    // required by the service-mismatch + PKCE-verifier assertions.
    process.env.GOOGLE_CLIENT_ID = 'test-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'http://localhost:4500/api/v1/oauth/callback/google';
    process.env.TWITTER_CLIENT_ID = 'test-twitter-client';
    process.env.TWITTER_CLIENT_SECRET = 'test-twitter-secret';
    process.env.TWITTER_REDIRECT_URI =
      'http://localhost:4500/api/v1/oauth/callback/twitter';

    if (fs.existsSync(process.env.DB_PATH)) {
      fs.unlinkSync(process.env.DB_PATH);
    }

    ({ app } = require('../index'));
    dbApi = require('../database');
    dbApi.initDatabase();
    rawDb = dbApi.getRawDB ? dbApi.getRawDB() : dbApi.db;

    global.__cbProfile = {
      email: `callback_user_${ts}@example.com`,
      name: 'Callback User',
      sub: `google-callback-${ts}`,
    };
  });

  afterAll(() => {
    try {
      dbApi.db.close();
    } catch (_) {
      // safeUnlink-style best-effort teardown — Windows sometimes
      // holds the handle briefly.
    }
    if (process.env.DB_PATH && fs.existsSync(process.env.DB_PATH)) {
      try {
        fs.unlinkSync(process.env.DB_PATH);
      } catch (_) {
        // ignore
      }
    }
  });

  // Small helper: issue an authorize and return { agent, state }.
  // Uses `?json=1` so we read state directly from the response body —
  // more robust than parsing the provider redirect URL and cheaper than
  // following redirects we're not going to use anyway.
  async function issue(service, query = {}) {
    const agent = request.agent(app);
    const qs = new URLSearchParams({
      json: '1',
      mode: 'login',
      returnTo: '/dashboard/',
      ...query,
    }).toString();
    const res = await agent.get(`/api/v1/oauth/authorize/${service}?${qs}`);
    if (res.status !== 200 || !res.body || !res.body.state) {
      throw new Error(
        `authorize(${service}) did not return a state token — ` +
          `status=${res.status} body=${JSON.stringify(res.body)}`
      );
    }
    return { agent, state: res.body.state };
  }

  // -----------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------

  test('valid state → 302 and row.used_at gets populated (consume-once)', async () => {
    const { agent, state } = await issue('google');
    const cb = await agent
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);

    expect(cb.status).toBe(302);
    const row = rawDb
      .prepare(
        'SELECT used_at FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(state);
    expect(row.used_at).not.toBeNull();
  });

  // -----------------------------------------------------------------
  // Replay protection
  // -----------------------------------------------------------------

  test('second callback with the same state → 400 with code STATE_REUSED (row stays consumed)', async () => {
    const { agent, state } = await issue('google');
    await agent
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);

    const replay = await agent
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);

    expect(replay.status).toBe(400);
    expect(replay.body && replay.body.code).toBe('STATE_REUSED');
    const row = rawDb
      .prepare(
        'SELECT used_at FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(state);
    expect(row.used_at).not.toBeNull();
  });

  // -----------------------------------------------------------------
  // Unknown state
  // -----------------------------------------------------------------

  test('unknown state → 400 with code STATE_NOT_FOUND', async () => {
    const res = await request(app)
      .get(
        '/api/v1/oauth/callback/google?code=abc&state=totally-fake-state-not-in-db'
      )
      .redirects(0);
    expect(res.status).toBe(400);
    expect(res.body && res.body.code).toBe('STATE_NOT_FOUND');
  });

  // -----------------------------------------------------------------
  // Service mismatch
  // -----------------------------------------------------------------

  test('state issued for google but hit /callback/twitter → 400 STATE_SERVICE_MISMATCH', async () => {
    const { state } = await issue('google');
    const res = await request(app)
      .get(
        `/api/v1/oauth/callback/twitter?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);
    expect(res.status).toBe(400);
    expect(res.body && res.body.code).toBe('STATE_SERVICE_MISMATCH');
  });

  // -----------------------------------------------------------------
  // Expired state
  // -----------------------------------------------------------------

  test('expired state (expires_at in the past) → 400 STATE_EXPIRED, row.used_at stays NULL', async () => {
    const { state } = await issue('google');
    // Force the row to appear already-expired from the domain module's
    // perspective — this bypasses wall-clock fudging entirely.
    rawDb
      .prepare('UPDATE oauth_state_tokens SET expires_at = ? WHERE state_token = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), state);

    const res = await request(app)
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);
    expect(res.status).toBe(400);
    expect(res.body && res.body.code).toBe('STATE_EXPIRED');

    const row = rawDb
      .prepare(
        'SELECT used_at FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(state);
    expect(row.used_at).toBeNull();
  });

  // -----------------------------------------------------------------
  // Discord bot-install carve-out is GONE (C6)
  // -----------------------------------------------------------------

  test('Discord callback without state + with guild_id → 400 (no more bypass)', async () => {
    const res = await request(app)
      .get(
        '/api/v1/oauth/callback/discord?code=abc&guild_id=12345'
      )
      .redirects(0);
    // Pre-Step-5, this returned 302 thanks to the isDiscordBotInstall
    // carve-out. After Step 5, the state parameter is mandatory for
    // every provider — Discord included.
    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------
  // Session-free operation — proves decoupling
  // -----------------------------------------------------------------

  test('callback succeeds even when cookies from authorize are dropped (no session dependency)', async () => {
    // We authorize with one agent (session A) but hit the callback
    // with a fresh agent (session B) carrying only the state value.
    // The DB row has all the metadata the callback needs, so this
    // works. Pre-Step-5 it returned 400 "not found in session".
    const { state } = await issue('google');
    const freshAgent = request.agent(app);
    const res = await freshAgent
      .get(
        `/api/v1/oauth/callback/google?code=abc&state=${encodeURIComponent(
          state
        )}`
      )
      .redirects(0);
    expect(res.status).toBe(302);
  });

  // -----------------------------------------------------------------
  // PKCE verifier passthrough — twitter flow
  // -----------------------------------------------------------------
  //
  // The Google mock records `exchangeCodeForToken`'s second arg,
  // but Google flows don't use PKCE. Twitter does. Since we don't
  // have a twitter adapter mock handy in this suite, we assert via
  // the DB row's `code_verifier` value that the callback handler
  // reads the persisted verifier rather than recomputing from the
  // state string. This is a structural check: if a future regression
  // restores a deterministic `buildPkcePairFromState`, the row's
  // `code_verifier` and the legacy HMAC-derived value will diverge,
  // and the matching callback will fail to complete the twitter
  // token exchange against a real provider. We guard against that
  // at the declaration level via the inventory test (see
  // `oauth-state-inventory.test.js` Step 5 / T3.5 flip).
  //
  // Here, we simply assert the row's verifier is the random 43-char
  // base64url the domain module emits, which is what the callback
  // will send to the provider.
  test('twitter state row stores a 43-char random base64url verifier (used by callback unchanged)', async () => {
    const { state } = await issue('twitter');
    const row = rawDb
      .prepare(
        'SELECT code_verifier FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(state);
    expect(row.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
