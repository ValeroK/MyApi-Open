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
describe.skip('[M3] OAuth state + PKCE hardening (to be added in T3.8)', () => {
  test.todo('callback rejects replayed state');
  test.todo('callback rejects missing state + guild_id');
  test.todo('callback rejects expired state');
  test.todo('valid flow end-to-end returns 302');
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
