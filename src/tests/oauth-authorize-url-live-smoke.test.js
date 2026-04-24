/**
 * Live smoke test for OAuth authorize-URL generation.
 *
 * Runs against a live MyApi server (Docker smoke, staging, production — anywhere
 * that answers HTTP). Skipped unless `SMOKE_URL` is set.
 *
 * Purpose: catch regressions in the *running* system that unit tests don't — e.g.
 * stale Docker image, wrong env vars, bind-mount vs. COPY'd source mismatch,
 * adapter client_id/redirect_uri misconfig, silent prompt-policy drift.
 *
 * Run against local smoke container:
 *
 *   npm run smoke:oauth
 *
 * Or explicitly:
 *
 *   SMOKE_URL=http://localhost:4500 npx jest oauth-authorize-url-live-smoke --forceExit
 *
 * Assertions mirror `oauth-security-hardening.test.js` but over HTTP to prove
 * the shipped binary + config behaves the same as the unit-tested code.
 *
 * History: added 2026-04-24 as part of F3 Pass 1 verification (dropping
 * `max_age=0` on Google login). See .context/tasks/backlog/F3-oauth-consent-...md.
 */

const SMOKE_URL = process.env.SMOKE_URL;

const describeIf = SMOKE_URL ? describe : describe.skip;

describeIf(`OAuth authorize-URL live smoke @ ${SMOKE_URL}`, () => {
  async function fetchAuthUrl(path) {
    const res = await fetch(`${SMOKE_URL}${path}`);
    if (!res.ok) {
      throw new Error(`GET ${path} → HTTP ${res.status}`);
    }
    const body = await res.json();
    if (!body || !body.authUrl) {
      throw new Error(`GET ${path} → missing authUrl in body: ${JSON.stringify(body)}`);
    }
    return new URL(body.authUrl);
  }

  test('landing modal (snake_case force_prompt=1) → select_account, no max_age', async () => {
    const u = await fetchAuthUrl(
      '/api/v1/oauth/authorize/google?mode=login&force_prompt=1&json=1'
    );
    expect(u.hostname).toBe('accounts.google.com');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    expect(u.searchParams.get('max_age')).toBeNull();
  });

  test('React LogIn/SignUp (camelCase forcePrompt=1) → select_account, no max_age', async () => {
    const u = await fetchAuthUrl(
      '/api/v1/oauth/authorize/google?mode=login&forcePrompt=1&returnTo=%2Fdashboard%2F&json=1'
    );
    expect(u.hostname).toBe('accounts.google.com');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    expect(u.searchParams.get('max_age')).toBeNull();
  });

  test('agent silent flow (forcePrompt=0) → no prompt, no max_age', async () => {
    const u = await fetchAuthUrl(
      '/api/v1/oauth/authorize/google?mode=login&forcePrompt=0&json=1'
    );
    expect(u.hostname).toBe('accounts.google.com');
    expect(u.searchParams.get('prompt')).toBeNull();
    expect(u.searchParams.get('max_age')).toBeNull();
  });

  test('connect mode (no override) emits prompt=select_account via adapter default (F3 Pass 2)', async () => {
    // Adapter default is `select_account` post-F3-Pass-2. Google itself still
    // escalates to a consent screen when there is no active grant for this
    // client+user (fresh grant or post-revocation), which is the correct
    // threat model. What we're asserting here is MyApi's URL, not Google's
    // downstream behavior.
    const u = await fetchAuthUrl('/api/v1/oauth/authorize/google?mode=connect&json=1');
    expect(u.hostname).toBe('accounts.google.com');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    expect(u.searchParams.get('max_age')).toBeNull();
  });

  test('offline access_type is requested for Google (refresh_token guarantee)', async () => {
    const u = await fetchAuthUrl('/api/v1/oauth/authorize/google?mode=login&forcePrompt=1&json=1');
    expect(u.searchParams.get('access_type')).toBe('offline');
  });

  test('state token is present and of expected length', async () => {
    const u = await fetchAuthUrl('/api/v1/oauth/authorize/google?mode=login&forcePrompt=1&json=1');
    const state = u.searchParams.get('state');
    expect(state).toBeTruthy();
    // State tokens are 32-byte base64url (no padding, ~43 chars). See ADR-0006 / M3.
    expect(state.length).toBeGreaterThan(30);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
