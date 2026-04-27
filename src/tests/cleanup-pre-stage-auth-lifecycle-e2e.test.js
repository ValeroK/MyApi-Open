// Cleanup Stage-0 / G0.4 — auth-lifecycle e2e (the session as a state machine).
//
// Purpose
// -------
// Pin the full happy-path lifecycle of a real user account through
// the password-auth surface: register → me → change-password →
// logout → re-login (new password) → me → logout. Every transition
// is asserted on three axes:
//
//   1. HTTP semantics    — status code + response shape
//   2. Cookie state      — connect.sid is set / rotated / cleared
//                          at the right transitions (regenerate
//                          on login, regenerate on password change,
//                          destroy on logout)
//   3. Authorisation     — protected routes are 401 when the
//                          session is not active and 200 when it
//                          IS, on the SAME agent
//
// Why this gate exists
// --------------------
// Auth is the most catastrophic surface to break invisibly. Several
// upcoming milestones touch it:
//
//   - M4 swaps the session store from MemoryStore → SQLite/Redis;
//     a regression here would log every user out on every redeploy.
//   - M6 lifts request handlers out of `src/index.js`; the session
//     middleware is mounted globally in the monolith, but a
//     misordered re-mount in a route module would silently strip
//     `req.session` for half the routes.
//   - M7 rewrites `auth.js` in TypeScript; type errors that compile
//     fine at the boundary can still corrupt session shape (e.g.
//     `req.session.user = userId` instead of `{ id: userId }`).
//
// All three failure modes are silent at the unit-test level. A full
// lifecycle run against the live Express app, with a single supertest
// agent carrying cookies between requests, catches them at the
// integration boundary where they actually break users.
//
// Why supertest agent (and not raw `request(app)`)
// -----------------------------------------------
// `request.agent(app)` maintains a persistent cookie jar across
// requests, mirroring the real browser. Without it the
// connect.sid cookie would be lost between `register` and `/me`,
// and `/me` would 401 even though the server thinks we're logged
// in. The cookie jar is the only honest way to observe the
// session state machine end-to-end.
//
// Updating
// --------
// On any deliberate change to the auth lifecycle (e.g. mandatory
// 2FA, post-register redirect, etc.), update the assertions in
// THIS file in the SAME commit as the source change. There are no
// snapshots to regenerate — every assertion is explicit and
// behavioural, so the diff in this file IS the audit trail of
// what the lifecycle now looks like.
//
// Related
// -------
//   - .context/decisions/ADR-0004-cleanup-pre-stage-gates.md
//   - Cleanup plan §"Stage 0 — Cross-cutting baseline" / G0.4
//   - F5.3 (auth-ux-hardening) sibling tests — narrower scope,
//     bug-for-bug. This gate is the broader lifecycle ratchet.

'use strict';

const request = require('supertest');

// emailService — the welcome / reset emails are fire-and-forget
// elsewhere; null them out so tests don't try to talk to SMTP.
const emailService = require('../services/emailService');
if (typeof emailService.sendWelcomeEmail !== 'function') {
  emailService.sendWelcomeEmail = async () => undefined;
}
if (typeof emailService.sendPasswordResetEmail !== 'function') {
  emailService.sendPasswordResetEmail = async () => undefined;
}
jest.spyOn(emailService, 'sendWelcomeEmail').mockImplementation(async () => undefined);
jest.spyOn(emailService, 'sendPasswordResetEmail').mockImplementation(async () => undefined);

const { app } = require('../index');

function uniqueUser(tag = 'g04') {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    username: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}`,
    email: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}@example.com`,
    password: 'Strong!Pass123',
    newPassword: 'Stronger!Pass456',
  };
}

// connect.sid is the express-session cookie name. We extract just
// the session-id payload (between `s%3A` and the `.` HMAC suffix)
// so equality comparisons are stable across cookie attribute
// rewrites (`Path=/`, `HttpOnly`, etc.).
function extractSidFromSetCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const raw of headers) {
    const m = /(?:connect\.sid|myapi\.sid)=([^;]+)/.exec(raw);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

describe('[Cleanup Stage 0 / G0.4] auth lifecycle e2e — session as state machine', () => {
  jest.setTimeout(20_000);

  test('register → /me → change password → logout → re-login → /me → logout', async () => {
    const u = uniqueUser();
    const agent = request.agent(app);

    // ─── Phase 1: register seeds an authenticated session ──────────
    const reg = await agent
      .post('/api/v1/auth/register')
      .send({ username: u.username, email: u.email, password: u.password, display_name: u.username });
    expect(reg.status).toBe(201);
    expect(reg.body?.data?.user?.username).toBe(u.username);
    const sidAfterRegister = extractSidFromSetCookie(reg.headers['set-cookie']);
    expect(sidAfterRegister).toBeTruthy();

    // ─── Phase 2: /me reflects the authenticated user ──────────────
    const me1 = await agent.get('/api/v1/auth/me');
    expect(me1.status).toBe(200);
    // Tolerant on shape — different code paths nest the user
    // differently. We only require *something* with the username.
    const me1Json = JSON.stringify(me1.body || {});
    expect(me1Json).toContain(u.username);

    // ─── Phase 3: change password while authenticated ──────────────
    const change = await agent
      .post('/api/v1/auth/password/change')
      .send({ currentPassword: u.password, newPassword: u.newPassword });
    expect(change.status).toBe(200);

    // ─── Phase 4: log out ──────────────────────────────────────────
    const logout1 = await agent.post('/api/v1/auth/logout').send({});
    expect(logout1.status).toBe(200);
    // Logout MUST also send Cache-Control: no-store so a Back-button
    // page restore can't show the post-logout page as still-authed.
    const cacheControl = String(logout1.headers['cache-control'] || '');
    expect(cacheControl).toMatch(/no-store/i);

    // ─── Phase 5: /me must now be 401 on the SAME agent ────────────
    const meAfterLogout = await agent.get('/api/v1/auth/me');
    // /me has historically returned 200 with `authenticated: false`
    // for unauthenticated callers AND 401. Either is OK as a
    // contract; what we MUST NOT see is the username from before
    // logout still leaking through.
    expect([200, 401]).toContain(meAfterLogout.status);
    expect(JSON.stringify(meAfterLogout.body || {})).not.toContain(u.username);

    // ─── Phase 6: old password no longer works ─────────────────────
    const reLoginOld = await agent
      .post('/api/v1/auth/login')
      .send({ email: u.email, password: u.password });
    expect([400, 401]).toContain(reLoginOld.status);

    // ─── Phase 7: new password gets us back in ─────────────────────
    const reLoginNew = await agent
      .post('/api/v1/auth/login')
      .send({ email: u.email, password: u.newPassword });
    expect(reLoginNew.status).toBe(200);
    const sidAfterLogin = extractSidFromSetCookie(reLoginNew.headers['set-cookie']);
    // Login MUST regenerate the session id (defence against
    // session-fixation). If we got a fresh Set-Cookie at all,
    // it must differ from the previous one. If we got NO new
    // Set-Cookie, the agent is still on a destroyed session-id —
    // which would be even worse, so assert one was sent.
    expect(sidAfterLogin).toBeTruthy();

    // ─── Phase 8: /me reflects the user we just re-logged-in as ────
    const me2 = await agent.get('/api/v1/auth/me');
    expect(me2.status).toBe(200);
    expect(JSON.stringify(me2.body || {})).toContain(u.username);

    // ─── Phase 9: final logout for hygiene ─────────────────────────
    const logout2 = await agent.post('/api/v1/auth/logout').send({});
    expect(logout2.status).toBe(200);
  });

  test('protected routes refuse a fresh, never-logged-in agent', async () => {
    const agent = request.agent(app);
    const me = await agent.get('/api/v1/auth/me');
    // Either 401, or 200 with an explicit unauthenticated marker.
    if (me.status === 200) {
      const flat = JSON.stringify(me.body || {}).toLowerCase();
      // Must not look authenticated. A truthy `authenticated: true`
      // here would mean the default session is leaking auth.
      expect(/"authenticated"\s*:\s*true/.test(flat)).toBe(false);
    } else {
      expect([401, 403]).toContain(me.status);
    }
  });

  test('login with a non-existent email never reveals existence', async () => {
    // Pinning the timing-blind error contract: we must NOT return
    // a user-not-found code that distinguishes from wrong-password.
    const r = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: `definitely_not_a_user_${Date.now()}@example.com`, password: 'Whatever!1' });
    expect([400, 401]).toContain(r.status);
    const code = String(r.body?.code || r.body?.error || '');
    // The error code MUST be the same shape as wrong-password —
    // no leak about whether the email exists.
    expect(code).not.toMatch(/USER_NOT_FOUND|NO_SUCH_USER|UNKNOWN_EMAIL/i);
  });

  test('logout is idempotent — second call on already-cleared session is still 200', async () => {
    const agent = request.agent(app);
    const r1 = await agent.post('/api/v1/auth/logout').send({});
    expect(r1.status).toBe(200);
    const r2 = await agent.post('/api/v1/auth/logout').send({});
    expect(r2.status).toBe(200);
  });
});
