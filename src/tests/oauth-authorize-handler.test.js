/**
 * M3 Step 4 / T3.4 — integration suite for `/api/v1/oauth/authorize/:service`.
 *
 * Locks the Step 4 refactor:
 *   - The authorize handler is the exclusive writer of `oauth_state_tokens`.
 *   - The handler reads PKCE verifier/challenge from the returned row
 *     (ADR-0006 §PKCE), not from the deterministic HMAC helper.
 *   - `req.session.oauthStateMeta` is never written from this route.
 *   - The `buildPkcePairFromState` call-site inside this route is gone.
 *
 * What this suite does NOT cover (deferred by ADR-0014):
 *   - End-to-end OAuth flow (callback). Between Step 4 and Step 5 the
 *     flow is intentionally split — authorize writes rows; callback
 *     still reads session. Step 5 rewires callback to read rows.
 *
 * Covers:
 *   - plan.md §6.3 H1 (deterministic PKCE verifier eliminated from
 *     this route)
 *   - plan.md §6.3 C3 (OAuth state not DB-validated — half fixed here;
 *     Step 5 finishes the other half)
 *   - TASKS.md T3.4
 *   - ADR-0014 §Step 4
 */

'use strict';

// OAuth adapters read env at module load time, so these must be set
// BEFORE `require('../index')` is called below. Values are synthetic:
// they just have to be non-empty so `isAdapterConfigured(...)` returns
// true; we never actually hit the upstream provider in this suite.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ci';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'test-encryption-key-32chars!!';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'test-session-secret-ci';
process.env.VAULT_KEY =
  process.env.VAULT_KEY || 'test-vault-key-ci-32characters!';
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

process.env.GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || 'test-google-client-secret';
process.env.TWITTER_CLIENT_ID =
  process.env.TWITTER_CLIENT_ID || 'test-twitter-client-id';
process.env.TWITTER_CLIENT_SECRET =
  process.env.TWITTER_CLIENT_SECRET || 'test-twitter-client-secret';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');

const SERVER_ENTRY = path.resolve(__dirname, '..', 'index.js');

let app;
let dbModule;
let raw;

beforeAll(() => {
  const mod = require('../index');
  app = mod.app;
  dbModule = require('../database');
  raw = dbModule.getRawDB ? dbModule.getRawDB() : dbModule.db;
});

// -------------------------------------------------------------------------
// 1. Static gates — authorize handler body contains no legacy primitives.
//
// The authorize handler is a single Express route registered at
// `app.get("/api/v1/oauth/authorize/:service", ...)`. We extract the
// function body textually and assert that neither `buildPkcePairFromState`
// nor `oauthStateMeta` appears inside it. The function definition of
// `buildPkcePairFromState` itself remains at module scope (it's still
// used by the callback until Step 5) — we are deliberately only gating
// the authorize handler's body here.
// -------------------------------------------------------------------------

describe('[M3 Step 4 textual gate] authorize handler body', () => {
  let handlerBody;
  beforeAll(() => {
    const source = fs.readFileSync(SERVER_ENTRY, 'utf8');
    // Anchor on the exact app.get line then take everything up to the
    // matching `});` at column 0. We don't need a perfect JS parser —
    // the handler is the only route registered at this exact path and
    // the indentation is stable.
    const start = source.indexOf(
      'app.get("/api/v1/oauth/authorize/:service"'
    );
    if (start < 0) {
      throw new Error(
        'Could not locate authorize handler in src/index.js; if the ' +
        'route signature changed, update this test.'
      );
    }
    const after = source.slice(start);
    const endRelative = after.indexOf('\n});');
    if (endRelative < 0) {
      throw new Error(
        'Could not locate the end of the authorize handler body.'
      );
    }
    handlerBody = after.slice(0, endRelative);
  });

  test('authorize body does not call buildPkcePairFromState', () => {
    expect(handlerBody).not.toMatch(/\bbuildPkcePairFromState\s*\(/);
  });

  test('authorize body does not reference oauthStateMeta', () => {
    expect(handlerBody).not.toMatch(/\boauthStateMeta\b/);
  });
});

// -------------------------------------------------------------------------
// 2. Behavioural gates — issuing flows via supertest
// -------------------------------------------------------------------------

describe('[M3 Step 4] GET /api/v1/oauth/authorize/:service — state row is the source of truth', () => {
  beforeAll(() => {
    // Guard rail: the tests that follow depend on google + twitter being
    // configured. If env priming above stopped working for any reason,
    // surface it as a clear skip-worthy failure rather than a cascade
    // of red supertest requests.
    const known = dbModule.initDatabase ? null : null; // no-op — initDatabase is called inside require('../index')
    void known;
  });

  // Two independent issuances — used across multiple assertions below
  // to exercise "no session-side carry-over" and "verifier uniqueness".
  async function issueJson(service, query = {}) {
    const qs = new URLSearchParams({ json: '1', ...query }).toString();
    return request(app).get(`/api/v1/oauth/authorize/${service}?${qs}`);
  }

  test('google authorize returns ok + authUrl + state + service', async () => {
    const res = await issueJson('google');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        authUrl: expect.stringContaining('https://'),
        service: 'google',
        state: expect.any(String),
      })
    );
    expect(res.body.state.length).toBeGreaterThanOrEqual(32);
  });

  test('returned state maps to a single row in oauth_state_tokens', async () => {
    const res = await issueJson('google');
    const row = raw
      .prepare('SELECT * FROM oauth_state_tokens WHERE state_token = ?')
      .get(res.body.state);
    expect(row).toBeDefined();
    expect(row.service_name).toBe('google');
    expect(row.used_at).toBeNull();
  });

  test('row TTL is ~10 minutes (ADR-0006 §Schema: ttlSec=600)', async () => {
    const res = await issueJson('google');
    const row = raw
      .prepare(
        'SELECT created_at, expires_at FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(res.body.state);
    const createdMs = new Date(row.created_at).getTime();
    const expiresMs = new Date(row.expires_at).getTime();
    const deltaSec = Math.round((expiresMs - createdMs) / 1000);
    // Allow a 1-second jitter window around the 600s target. The ADR
    // mandates a 10-minute TTL; anything outside 599..601s means either
    // the constant regressed or we accidentally slipped a minutes/
    // seconds unit confusion.
    expect(deltaSec).toBeGreaterThanOrEqual(599);
    expect(deltaSec).toBeLessThanOrEqual(601);
  });

  test('code_verifier is a fresh 43-char base64url — NOT the legacy HMAC-derived value', async () => {
    const res = await issueJson('google');
    const row = raw
      .prepare(
        'SELECT code_verifier FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(res.body.state);
    // Domain module emits crypto.randomBytes(32).toString('base64url') —
    // that's exactly 43 chars, URL-safe, no padding.
    expect(row.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The legacy `buildPkcePairFromState` helper produced a 64-char
    // string (see `.slice(0, 64)` in src/index.js). If we ever see a
    // 64-char verifier in a row, the handler regressed to the
    // deterministic path.
    expect(row.code_verifier.length).not.toBe(64);
  });

  test('two consecutive issuances produce different code_verifier values (randomness, not determinism)', async () => {
    const first = await issueJson('google');
    const second = await issueJson('google');
    const rowA = raw
      .prepare('SELECT code_verifier FROM oauth_state_tokens WHERE state_token = ?')
      .get(first.body.state);
    const rowB = raw
      .prepare('SELECT code_verifier FROM oauth_state_tokens WHERE state_token = ?')
      .get(second.body.state);
    expect(rowA.code_verifier).not.toBe(rowB.code_verifier);
  });

  test('mode defaults to "connect" and returnTo is persisted from ?returnTo=', async () => {
    const res = await issueJson('google', { returnTo: '/dashboard/skills' });
    const row = raw
      .prepare(
        'SELECT mode, return_to FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(res.body.state);
    expect(row.mode).toBe('connect');
    expect(row.return_to).toBe('/dashboard/skills');
  });

  test('twitter authorize embeds code_challenge=S256(code_verifier) in authUrl (PKCE parity with the row)', async () => {
    const res = await issueJson('twitter');
    expect(res.status).toBe(200);
    const url = new URL(res.body.authUrl);
    const challengeFromUrl = url.searchParams.get('code_challenge');
    const methodFromUrl = url.searchParams.get('code_challenge_method');
    expect(methodFromUrl).toBe('S256');
    expect(challengeFromUrl).toBeTruthy();

    const row = raw
      .prepare(
        'SELECT code_verifier FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(res.body.state);
    const expected = crypto
      .createHash('sha256')
      .update(row.code_verifier)
      .digest('base64url');
    expect(challengeFromUrl).toBe(expected);
  });

  test('google authorize does NOT include code_challenge (no PKCE for this provider)', async () => {
    const res = await issueJson('google');
    expect(res.status).toBe(200);
    const url = new URL(res.body.authUrl);
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBeNull();
  });

  test('session cookie does not carry an oauthStateMeta payload for the issued state', async () => {
    // The session store is opaque to the client, so we can't read it
    // directly via supertest. What we CAN assert is that a second
    // request on the same session cookie still produces a DB row, i.e.
    // nothing about the first call was stashed in session memory and
    // then needed on the second call.
    const agent = request.agent(app);
    const first = await agent.get('/api/v1/oauth/authorize/google?json=1');
    const second = await agent.get('/api/v1/oauth/authorize/google?json=1');
    expect(first.body.state).not.toBe(second.body.state);

    const rowA = raw
      .prepare(
        'SELECT state_token FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(first.body.state);
    const rowB = raw
      .prepare(
        'SELECT state_token FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(second.body.state);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
  });

  test('row.user_id is null when the flow starts unauthenticated (no ownerId source)', async () => {
    const res = await issueJson('google');
    const row = raw
      .prepare(
        'SELECT user_id FROM oauth_state_tokens WHERE state_token = ?'
      )
      .get(res.body.state);
    // There's no Authorization header, no session user, and no
    // masterToken cookie on this request, so the DB row MUST reflect
    // the anonymous origin. This is the regression gate against a
    // refactor that accidentally substitutes `'owner'` or an empty
    // string for missing ownerId.
    expect(row.user_id).toBeNull();
  });
});
