/**
 * F3 Pass 2 — `refreshOAuthToken` invalid_grant recovery.
 *
 * When Google (or any OAuth provider) returns `error: 'invalid_grant'` on a
 * refresh-token exchange, the stored refresh_token is dead and no amount of
 * retrying will fix it — the grant has been revoked (user revoked on their
 * side), rotated (provider invalidated it), or it was never valid to begin
 * with. Leaving the dead token in place means:
 *
 *   1. Every subsequent proxy call retries the refresh and gets the same
 *      `invalid_grant` back. Cheap but pointless.
 *   2. The dashboard has no way to distinguish "token exists but is dead"
 *      from "token exists and is healthy", so it keeps showing the service
 *      as "connected" when it actually needs re-auth.
 *
 * The fix: on `invalid_grant`, null out the refresh_token column so the row
 * moves to a "connected-but-needs-reauth" state. Downstream endpoints
 * (`/api/v1/oauth/status`, `/proxy`, `/execute`) can then surface
 * `REAUTH_REQUIRED` to the dashboard with an actionable CTA.
 *
 * Critical negative assertions: transient errors (5xx, network errors,
 * `invalid_client`) MUST NOT clear the refresh_token. Those are retryable
 * — a flaky DNS hiccup shouldn't force the user to reauthorize.
 *
 * Architecture note: we stand up a small loopback HTTP server in the test
 * and point `tokenUrl` at it, rather than monkey-patching `https.request`.
 * This keeps the test close to what production actually does (the real code
 * path goes through `transport.request`) and avoids brittle module mocks.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

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

describe('refreshOAuthToken — invalid_grant recovery (F3 Pass 2)', () => {
  let db;
  let storeOAuthToken;
  let refreshOAuthToken;
  let getOAuthToken;

  let server;
  let tokenUrl;
  /** Controls what the mock token endpoint returns on the next request. */
  let nextResponse = { status: 200, body: {} };
  /** Counts how many refresh requests the mock served, for assertions. */
  let requestCount = 0;

  const SERVICE = 'google';
  const USER_ID = 'test-user-refresh-invalid-grant';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DB_PATH = path.join(__dirname, 'tmp-oauth-refresh-invalid-grant.sqlite');

    await safeUnlink(process.env.DB_PATH);

    // Fresh require so the DB picks up our DB_PATH env var, and initDatabase()
    // so the schema + migrations exist before we start touching rows.
    jest.resetModules();
    const dbModule = require('../database');
    dbModule.initDatabase();
    db = dbModule.db || dbModule;
    storeOAuthToken = dbModule.storeOAuthToken;
    refreshOAuthToken = dbModule.refreshOAuthToken;
    getOAuthToken = dbModule.getOAuthToken;

    // Ensure there's a user row so the FK on oauth_tokens doesn't fail.
    // (ADR-0015 documents this; storeOAuthToken relies on the row existing
    // because of the FK added mid-M3.)
    const now = new Date().toISOString();
    const userRow = db.prepare('SELECT id FROM users WHERE id = ?').get(USER_ID);
    if (!userRow) {
      db.prepare(`
        INSERT INTO users (id, username, display_name, email, password_hash,
                           two_factor_enabled, created_at, status, plan)
        VALUES (?, ?, ?, ?, '', 0, ?, 'active', 'free')
      `).run(
        USER_ID,
        'refresh_test_user',
        'Refresh Test User',
        `${USER_ID}@test.local`,
        now
      );
    }

    // Loopback HTTP server standing in for Google's /token endpoint.
    await new Promise((resolve) => {
      server = http.createServer((req, res) => {
        requestCount += 1;
        res.writeHead(nextResponse.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nextResponse.body));
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        tokenUrl = `http://127.0.0.1:${port}/token`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await safeUnlink(process.env.DB_PATH);
  });

  beforeEach(() => {
    requestCount = 0;
    nextResponse = { status: 200, body: {} };

    // Fresh token row per test — expired so the refresh path fires, with a
    // refresh_token so it doesn't short-circuit on "no refresh token".
    const expiredIso = new Date(Date.now() - 60 * 1000).toISOString();
    storeOAuthToken(
      SERVICE,
      USER_ID,
      'access-token-value',
      'refresh-token-value',
      expiredIso,
      'email profile',
      'google-subject-123'
    );
  });

  test('invalid_grant → refresh_token column is cleared to NULL', async () => {
    nextResponse = {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been revoked.' },
    };

    const result = await refreshOAuthToken(SERVICE, USER_ID, tokenUrl, 'test-cid', 'test-secret');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_grant');
    expect(result.reauthRequired).toBe(true);
    expect(requestCount).toBe(1);

    // Direct DB inspection — the encrypted refresh_token blob should be NULL.
    const row = db.prepare(
      'SELECT refresh_token FROM oauth_tokens WHERE service_name = ? AND user_id = ?'
    ).get(SERVICE, USER_ID);
    expect(row).toBeTruthy();
    expect(row.refresh_token).toBeNull();

    // And getOAuthToken() returns a row with refreshToken === null.
    const fresh = getOAuthToken(SERVICE, USER_ID);
    expect(fresh).toBeTruthy();
    expect(fresh.refreshToken).toBeNull();
  });

  test('subsequent refresh attempts return "No refresh token available" without hitting the network', async () => {
    // First: trigger invalid_grant to clear the token.
    nextResponse = { status: 400, body: { error: 'invalid_grant' } };
    await refreshOAuthToken(SERVICE, USER_ID, tokenUrl, 'test-cid', 'test-secret');
    requestCount = 0;

    // Second attempt: no refresh_token in DB, so it should short-circuit.
    const second = await refreshOAuthToken(SERVICE, USER_ID, tokenUrl, 'test-cid', 'test-secret');
    expect(second.ok).toBe(false);
    expect(second.error).toBe('No refresh token available');
    expect(requestCount).toBe(0);
  });

  test('invalid_client (our misconfig) does NOT clear refresh_token', async () => {
    nextResponse = {
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client auth failed.' },
    };

    const result = await refreshOAuthToken(SERVICE, USER_ID, tokenUrl, 'bad-cid', 'bad-secret');

    expect(result.ok).toBe(false);
    expect(result.reauthRequired).not.toBe(true);

    // refresh_token must still be present — this error is our fault, not
    // the user's. Clearing it would force an unnecessary reauth.
    const row = db.prepare(
      'SELECT refresh_token FROM oauth_tokens WHERE service_name = ? AND user_id = ?'
    ).get(SERVICE, USER_ID);
    expect(row.refresh_token).not.toBeNull();
  });

  test('transient 5xx does NOT clear refresh_token', async () => {
    nextResponse = {
      status: 503,
      body: { error: 'server_error', error_description: 'Google is having a bad day.' },
    };

    const result = await refreshOAuthToken(SERVICE, USER_ID, tokenUrl, 'test-cid', 'test-secret');

    expect(result.ok).toBe(false);
    expect(result.reauthRequired).not.toBe(true);

    const row = db.prepare(
      'SELECT refresh_token FROM oauth_tokens WHERE service_name = ? AND user_id = ?'
    ).get(SERVICE, USER_ID);
    expect(row.refresh_token).not.toBeNull();
  });

  test('network error does NOT clear refresh_token', async () => {
    // Point at an unreachable host to force a network error.
    const deadUrl = 'http://127.0.0.1:1/token';

    const result = await refreshOAuthToken(SERVICE, USER_ID, deadUrl, 'test-cid', 'test-secret');

    expect(result.ok).toBe(false);
    expect(result.reauthRequired).not.toBe(true);

    const row = db.prepare(
      'SELECT refresh_token FROM oauth_tokens WHERE service_name = ? AND user_id = ?'
    ).get(SERVICE, USER_ID);
    expect(row.refresh_token).not.toBeNull();
  });
});
