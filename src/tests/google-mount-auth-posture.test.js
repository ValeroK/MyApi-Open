/**
 * F6.1 — `/api/v1/google/*` mount authentication posture.
 *
 * Closes GAP-002 from `.context/capability-gaps.md`.
 *
 * Why this exists
 * ---------------
 * Pre-fix, `src/index.js` mounted the Google service router with
 *   app.use('/api/v1/google', createGoogleRoutes());
 * — i.e. **without** the `authenticate` middleware that every sibling
 * /api/v1/* mount uses (devices, dashboard, skills, notifications,
 * activity, email, workspaces, invitations, export, import, vault,
 * afp, fal, agentic, tickets — every single other one). Inside the
 * router, `resolveUserId(req)` (`src/routes/google.js:16-24`) falls
 * back to the literal string `'owner'` when no session, no `req.user`,
 * and no `req.tokenMeta` are present. The handler then calls
 * `getOAuthToken('google', 'owner')`. On any deployment where the
 * operator has connected Google in the dashboard (the documented
 * happy path), an unauthenticated remote caller can list & read
 * Gmail messages by simply hitting the route — no token, no session,
 * nothing.
 *
 * The fix is the one-line addition of `authenticate` as the second
 * argument to the mount, matching every sibling.
 *
 * Test strategy
 * -------------
 * 1. **Auth-envelope assertion** — without any authentication, both
 *    Google routes must return the **global** `authenticate`
 *    rejection envelope (status 401, body
 *    `{ error: "Missing session, Authorization: Bearer token, ..." }`).
 *    The handler-level "Google not connected" / "Google token expired"
 *    messages are markers that the router ran past the auth gate;
 *    asserting against them catches the bypass even in a database
 *    state where no Google OAuth row exists for `'owner'`.
 *
 * 2. **Static gate** — the literal source line in `src/index.js` for
 *    the `/api/v1/google` mount must include the `authenticate`
 *    identifier as a middleware, mirroring every sibling. This is a
 *    permanent ratchet against silent regression by future refactors
 *    (the router-shape snapshot in
 *    `cleanup-pre-stage-api-surface-snapshot.test.js` would also
 *    surface a regression but as a snapshot mismatch, not a typed
 *    failure).
 *
 * Related
 * -------
 * - `.context/capability-gaps.md` GAP-002.
 * - `.cursor/plans/capability_test_plan_b4523725.plan.md` §3.1
 *   (F6.1 - L1 supertest behavioral suites).
 * - Sibling pattern at `src/index.js` ~lines 2329-2772 (every other
 *   pre-`/api/v1` mount uses `authenticate`).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const app = require('../server');

const SERVER_ENTRY = path.resolve(__dirname, '..', 'index.js');

// The global authenticate envelope when no session and no Bearer
// token are present. Pinned at `src/index.js:2526` (post-T4.6 line
// drift may shift the line; the body string is the contract).
const GLOBAL_AUTH_REJECTION_FRAGMENT =
  'Missing session, Authorization: Bearer token';

// Markers that the router ran past the auth gate. If any of these
// appear in a 401 body, the auth bypass is still live.
const HANDLER_LEAKAGE_MARKERS = [
  'Google not connected',
  'Google token expired',
  'Failed to refresh Google token',
];

describe('[F6.1 / GAP-002] /api/v1/google/* requires authentication', () => {
  describe('runtime: unauthenticated requests', () => {
    test('GET /api/v1/google/gmail/messages returns the global auth envelope', async () => {
      const res = await request(app).get('/api/v1/google/gmail/messages');

      expect(res.status).toBe(401);
      expect(typeof res.body).toBe('object');
      expect(typeof res.body.error).toBe('string');

      // The body must come from the global authenticate middleware,
      // NOT from the router's own getGoogleAccessToken throw path.
      expect(res.body.error).toContain(GLOBAL_AUTH_REJECTION_FRAGMENT);
      for (const marker of HANDLER_LEAKAGE_MARKERS) {
        expect(res.body.error).not.toContain(marker);
      }
    });

    test('GET /api/v1/google/gmail/messages/:id returns the global auth envelope', async () => {
      const res = await request(app).get(
        '/api/v1/google/gmail/messages/some-msg-id'
      );

      expect(res.status).toBe(401);
      expect(typeof res.body).toBe('object');
      expect(typeof res.body.error).toBe('string');

      expect(res.body.error).toContain(GLOBAL_AUTH_REJECTION_FRAGMENT);
      for (const marker of HANDLER_LEAKAGE_MARKERS) {
        expect(res.body.error).not.toContain(marker);
      }
    });

    test('an obviously bogus query string does not bypass the auth gate', async () => {
      // Belt-and-braces: query strings should never affect routing.
      // Pin it anyway so a future "if req.query.token then bypass"
      // helper cannot regress this surface silently.
      const res = await request(app).get(
        '/api/v1/google/gmail/messages?limit=1&q=is:unread'
      );
      expect(res.status).toBe(401);
      expect(res.body.error).toContain(GLOBAL_AUTH_REJECTION_FRAGMENT);
    });
  });

  describe('static: source-level gate', () => {
    test("the '/api/v1/google' mount in src/index.js wires authenticate", () => {
      const source = fs.readFileSync(SERVER_ENTRY, 'utf8');

      // Find the literal mount line. The match shape we lock is
      //   app.use('/api/v1/google', authenticate, createGoogleRoutes())
      // — i.e. authenticate must be the second positional arg, the
      // same shape every sibling mount uses (devices, dashboard,
      // skills, notifications, …, tickets). Tolerate single OR double
      // quotes around the path.
      const re =
        /app\.use\(\s*(['"])\/api\/v1\/google\1\s*,\s*authenticate\s*,/;
      expect(source).toMatch(re);
    });

    test('the mount appears exactly once (no duplicate / shadowed mount)', () => {
      const source = fs.readFileSync(SERVER_ENTRY, 'utf8');
      const matches = source.match(
        /app\.use\(\s*['"]\/api\/v1\/google['"]/g
      ) || [];
      expect(matches.length).toBe(1);
    });
  });
});
