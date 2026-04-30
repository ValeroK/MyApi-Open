/**
 * F3 Pass 4 (ADR-0022) — graceful degradation when the provider does
 * NOT return an email for the connect-grant account.
 *
 * Real-world cases this guards against:
 *
 *   - Facebook connect-mode where the operator only granted
 *     `public_profile` (no `email` scope) — `verifyToken` returns
 *     `{ id }` without `email`. The dashboard MUST still render the
 *     service card without throwing, just without the
 *     "Connected as ..." label (the column stays NULL, the SPA
 *     short-circuits on the falsy check).
 *
 *   - GitHub `read:user` without `user:email` — `/user` may return
 *     `email: null` for users who hid their primary email.
 *
 *   - A transient `verifyToken` HTTP failure during connect — the
 *     callback already swallows the error and stores the row anyway
 *     so the user isn't blocked; this suite locks that the swallowed
 *     path produces a NULL email rather than a string `"null"` /
 *     `"undefined"` / etc.
 *
 * Static check: also asserts the connect-mode email-extraction block
 * we landed in `src/index.js` is still in place (regex tripwire on
 * `connectedEmail = String(...)` after the `verifyToken` call).
 * Without this, a future refactor could silently regress us back to
 * "Connected" with no per-account label.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ci';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'test-encryption-key-32chars!!';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'test-session-secret-ci';
process.env.VAULT_KEY =
  process.env.VAULT_KEY || 'test-vault-key-ci-32characters!';

const path = require('path');
const fs = require('fs');

const ts = Date.now();
process.env.DB_PATH = path.join(
  __dirname,
  `tmp-oauth-connect-no-email-graceful-${ts}.sqlite`
);
if (fs.existsSync(process.env.DB_PATH)) {
  try { fs.unlinkSync(process.env.DB_PATH); } catch (_) { /* ignore */ }
}

const dbApi = require('../database');
dbApi.initDatabase();
const { db, storeOAuthToken, getOAuthToken, createUser } = dbApi;

const SERVER_ENTRY = path.resolve(__dirname, '..', 'index.js');

describe('[F3 Pass 4 / ADR-0022] connected-account email — graceful when missing', () => {
  let userId;

  beforeAll(() => {
    const u = createUser(
      'no_email_grace_user',
      'No-email graceful',
      'no_email_grace@example.com',
      'UTC',
      'Password123!'
    );
    userId = u.id;
  });

  beforeEach(() => {
    db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(userId);
  });

  afterAll(() => {
    try { db.close(); } catch (_) { /* ignore */ }
    if (process.env.DB_PATH && fs.existsSync(process.env.DB_PATH)) {
      try { fs.unlinkSync(process.env.DB_PATH); } catch (_) { /* ignore */ }
    }
  });

  test('storeOAuthToken with null email writes NULL connected_email and does not throw', () => {
    expect(() => {
      storeOAuthToken(
        'facebook',
        userId,
        'fb-access',
        'fb-refresh',
        null,
        'public_profile',
        'fb-id-8821',
        null
      );
    }).not.toThrow();

    const row = db
      .prepare('SELECT connected_email FROM oauth_tokens WHERE service_name = ? AND user_id = ?')
      .get('facebook', userId);
    expect(row.connected_email).toBeNull();

    const persisted = getOAuthToken('facebook', userId);
    expect(persisted.connectedEmail).toBeNull();
  });

  test('storeOAuthToken with empty-string email is normalised to NULL (not "")', () => {
    storeOAuthToken(
      'facebook',
      userId,
      'fb-access',
      null,
      null,
      'public_profile',
      'fb-id-empty',
      ''
    );
    const row = db
      .prepare('SELECT connected_email FROM oauth_tokens WHERE service_name = ? AND user_id = ?')
      .get('facebook', userId);
    expect(row.connected_email).toBeNull();
  });

  test('storeOAuthToken with whitespace-only email is normalised to NULL', () => {
    storeOAuthToken(
      'facebook',
      userId,
      'fb-access',
      null,
      null,
      'public_profile',
      'fb-id-whitespace',
      '   '
    );
    const row = db
      .prepare('SELECT connected_email FROM oauth_tokens WHERE service_name = ? AND user_id = ?')
      .get('facebook', userId);
    expect(row.connected_email).toBeNull();
  });

  test('connect-mode callback in src/index.js still extracts connectedEmail (static tripwire)', () => {
    // Strip JS comments so the rationale block in the callback can't
    // satisfy the regex on its own.
    const stripped = fs
      .readFileSync(SERVER_ENTRY, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*\n/g, '\n');

    // Connect-mode block declares `let connectedEmail = null;` and
    // assigns from either the id_token payload or the verifyToken
    // userinfo response (we accept either path; the suite only
    // requires that SOME assignment from a String(...) trim chain
    // exists in the connect-mode branch).
    expect(stripped).toMatch(/let\s+connectedEmail\s*=\s*null\s*;/);
    expect(stripped).toMatch(
      /connectedEmail\s*=\s*String\(\s*[^)]*\.email[^)]*\)\s*\.trim\(\)\s*\.toLowerCase\(\)\s*\|\|\s*null/
    );

    // And the connect-mode storeOAuthToken call site passes
    // connectedEmail as the 8th positional arg.
    const storeMatch = stripped.match(
      /storeOAuthToken\s*\(\s*service\s*,\s*oauthOwnerId[\s\S]{0,500}?providerUserId\s*\|\|\s*null\s*,\s*connectedEmail\s*\|\|\s*null\s*\)/
    );
    expect(storeMatch).toBeTruthy();
  });
});
