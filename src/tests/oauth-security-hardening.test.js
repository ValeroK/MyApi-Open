const path = require('path');
const fs = require('fs');
const request = require('supertest');

// Windows holds the SQLite file open long after `better-sqlite3` closes the
// JS handle (the WAL/SHM files in particular). `fs.unlinkSync` throws EBUSY
// in that window. Retry a few times and also clean `-wal` / `-shm` siblings.
async function safeUnlink(p) {
  if (!p) return;
  const targets = [p, `${p}-wal`, `${p}-shm`];
  for (const target of targets) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        break;
      } catch (err) {
        if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        if (err && err.code === 'ENOENT') break;
        throw err;
      }
    }
  }
}

describe('OAuth security hardening', () => {
  let app;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DB_PATH = path.join(__dirname, 'tmp-oauth-security-hardening.sqlite');
    process.env.SESSION_DB_PATH = path.join(__dirname, 'tmp-oauth-security-hardening-sessions.sqlite');

    process.env.GOOGLE_CLIENT_ID = 'test-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4500/api/v1/oauth/callback/google';

    process.env.GITHUB_CLIENT_ID = 'test-github-client';
    process.env.GITHUB_CLIENT_SECRET = 'test-github-secret';
    process.env.GITHUB_REDIRECT_URI = 'http://localhost:4500/api/v1/oauth/callback/github';

    process.env.FACEBOOK_CLIENT_ID = 'test-facebook-client';
    process.env.FACEBOOK_CLIENT_SECRET = 'test-facebook-secret';
    process.env.FACEBOOK_REDIRECT_URI = 'http://localhost:4500/api/v1/oauth/callback/facebook';

    await safeUnlink(process.env.DB_PATH);
    await safeUnlink(process.env.SESSION_DB_PATH);

    ({ app } = require('../index'));
  });

  afterAll(async () => {
    await safeUnlink(process.env.DB_PATH);
    await safeUnlink(process.env.SESSION_DB_PATH);
  });

  test('google login defaults to select_account WITHOUT max_age=0 (F3)', async () => {
    // F3: dropping `max_age=0` stops Google forcing a full re-auth (which
    // cascades into the consent screen) on every returning-user login. We
    // keep `prompt=select_account` so users with multiple Google accounts
    // still see an account-picker — that's useful UX, not friction. With
    // only `prompt=select_account` Google silently passes through a
    // returning user with a valid grant + a single account; with multiple
    // accounts it shows the picker; it only shows the consent screen on
    // fresh grants or revoked grants — which is the correct threat model.
    const res = await request(app)
      .get('/api/v1/oauth/authorize/google?mode=login&json=1');

    expect(res.status).toBe(200);
    const authUrl = new URL(res.body.authUrl);

    expect(authUrl.searchParams.get('prompt')).toBe('select_account');
    expect(authUrl.searchParams.get('max_age')).toBeNull();
  });

  test('google login can disable forcePrompt explicitly', async () => {
    const res = await request(app)
      .get('/api/v1/oauth/authorize/google?mode=login&forcePrompt=0&json=1');

    expect(res.status).toBe(200);
    const authUrl = new URL(res.body.authUrl);

    expect(authUrl.searchParams.get('prompt')).toBeNull();
    expect(authUrl.searchParams.get('max_age')).toBeNull();
  });

  test('google login via landing modal (snake_case force_prompt=1) still produces select_account (F3 regression guard)', async () => {
    // `src/public/landing/landing.js` and the landing modal at `landing/index.html`
    // historically use snake_case `force_prompt=1` in the query string, while
    // the React app (`LogIn.jsx`, `SignUp.jsx`) uses camelCase `forcePrompt=1`.
    // The server only parses camelCase — so the snake_case call lands on the
    // default-for-login-mode branch (`explicitForcePrompt === null && mode === 'login'`
    // ⇒ `forcePrompt = true`). That currently produces the right outcome, but
    // it's load-bearing: if anyone ever changes the default, the landing page
    // silently breaks and we'd be back to showing consent on every login. This
    // test pins the behavior.
    const res = await request(app)
      .get('/api/v1/oauth/authorize/google?mode=login&force_prompt=1&json=1');

    expect(res.status).toBe(200);
    const authUrl = new URL(res.body.authUrl);
    expect(authUrl.hostname).toBe('accounts.google.com');
    expect(authUrl.searchParams.get('prompt')).toBe('select_account');
    expect(authUrl.searchParams.get('max_age')).toBeNull();
  });

  test('google connect mode emits prompt=select_account via adapter default (F3 Pass 2)', async () => {
    // F3 Pass 2 flipped `google-adapter.js` default from `prompt: 'consent'`
    // to `prompt: 'select_account'`. Connect mode (user clicks "Connect
    // Google" from the Services page) doesn't set any runtime prompt
    // override, so it falls through to the adapter default. Before Pass 2
    // this was `consent` on every single connect click; after Pass 2 it's
    // `select_account`, which gives the user an account picker instead of
    // a full scope-approval screen. The consent screen still appears
    // naturally when Google has no existing grant for this client+user
    // (the correct threat model — fresh grant or revoked grant needs
    // explicit scope approval).
    //
    // The `invalid_grant` recovery path (F3 Pass 2 Item B, `refreshOAuthToken`
    // nulling the dead refresh_token) is the OTHER way consent legitimately
    // re-surfaces: after a grant revocation on Google's side, the next
    // re-authorize attempt will see `prompt=select_account` from us but
    // Google itself will escalate to consent because it has no active grant.
    const res = await request(app)
      .get('/api/v1/oauth/authorize/google?mode=connect&json=1');

    expect(res.status).toBe(200);
    const authUrl = new URL(res.body.authUrl);
    expect(authUrl.hostname).toBe('accounts.google.com');
    expect(authUrl.searchParams.get('prompt')).toBe('select_account');
    expect(authUrl.searchParams.get('max_age')).toBeNull();
  });

  test('GoogleAdapter default getAuthorizationUrl emits prompt=select_account (F3 Pass 2, defence-in-depth)', () => {
    // Direct unit test against the adapter (not via HTTP). The server-side
    // override in `src/index.js` translates login-mode `forcePrompt=1` to
    // `prompt=select_account` today, so a stray code path that calls the
    // adapter without going through the authorize handler would previously
    // have silently forced `prompt=consent`. Making `select_account` the
    // adapter default closes that trap — the adapter is now safe-by-default
    // and the server override is policy, not rescue.
    const GoogleAdapter = require('../services/google-adapter');
    const adapter = new GoogleAdapter({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      redirectUri: 'http://localhost:4500/cb',
    });
    const url = new URL(adapter.getAuthorizationUrl('some-state', {}));
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('max_age')).toBeNull();
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  test('facebook login forcePrompt adds reauthenticate hint', async () => {
    const res = await request(app)
      .get('/api/v1/oauth/authorize/facebook?mode=login&forcePrompt=1&json=1');

    expect(res.status).toBe(200);
    const authUrl = new URL(res.body.authUrl);

    expect(authUrl.searchParams.get('auth_type')).toBe('reauthenticate');
  });

  test('github login forcePrompt adds deterministic flag-compatible auth param', async () => {
    const res = await request(app)
      .get('/api/v1/oauth/authorize/github?mode=login&forcePrompt=1&json=1');

    expect(res.status).toBe(200);
    const authUrl = new URL(res.body.authUrl);

    expect(authUrl.searchParams.get('allow_signup')).toBe('true');
  });

  test('logout clears auth cookies aggressively', async () => {
    const agent = request.agent(app);

    await agent.get('/api/v1/oauth/authorize/google?mode=login&json=1');
    const res = await agent.post('/api/v1/auth/logout');

    expect(res.status).toBe(200);
    const setCookies = res.headers['set-cookie'] || [];

    expect(setCookies.some((c) => c.startsWith('myapi.sid='))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('myapi_user='))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('myapi_master_token='))).toBe(true);
  });
});
