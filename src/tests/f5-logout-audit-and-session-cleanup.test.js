/**
 * F5.1 P1c — `user_logout` audit + dead-`global.sessions` cleanup.
 *
 * Naming: P1a ported security controls onto the live router, P1b deleted
 * the shadows.  P1c is the post-shadow-deletion follow-up that closes
 * the two non-blocking findings surfaced by P1b's verification matrix.
 * The backlog's "F5.1 Phase 2 — Harden hashing primitive" (bcrypt cost
 * bump) is a different, larger work item.
 *
 * Two findings closed by this suite:
 *
 *   1. The live `/logout` handler in `src/routes/auth.js` clears the
 *      session and unregisters the SOC2 concurrent-session entry, but
 *      never emits a `user_logout` audit row.  Without this row the
 *      compliance trail has `user_login` events that "never end" — an
 *      auditor can't reconstruct session lifetimes from the audit log
 *      alone.  The legacy shadow at `src/index.js` did not emit one
 *      either, so this is technically a port from "nowhere" to "the
 *      live router", but it brings us to feature parity with
 *      `user_login` / `user_register` / `token_login`.
 *
 *   2. `/register` writes `global.sessions[sessionToken] = { userId,
 *      … }` and returns `data.token` to the client, but **nothing** in
 *      the codebase ever reads `global.sessions` (only writes & a
 *      time-based reaper in `src/index.js`).  The dashboard's real
 *      master token is minted lazily by `/auth/me` into the
 *      `access_tokens` table, so `data.token` from `/register` is dead
 *      bytes that don't authenticate anything.  This phase removes
 *      the orphaned write, the orphaned reaper, and stops returning
 *      the meaningless field so callers can't be misled into using
 *      it as a Bearer token.
 *
 * RED-FIRST.  All eight assertions below should fail on a tree that
 * still has the gaps and turn green only when both fixes land.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../index');
const { db } = require('../database');

const INDEX_JS_PATH = path.join(__dirname, '..', 'index.js');
const LIVE_ROUTES_PATH = path.join(__dirname, '..', 'routes', 'auth.js');

function readSrc(p) {
  return fs.readFileSync(p, 'utf8');
}

function uniqueUser(tag = 'f5p2') {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    username: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}`,
    email: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}@example.com`,
    password: 'Strong!Pass123',
  };
}

async function register(agent, user) {
  return agent.post('/api/v1/auth/register').send({
    username: user.username,
    email: user.email,
    password: user.password,
    display_name: user.username,
  });
}

describe('F5.1 P1c — user_logout audit + global.sessions cleanup', () => {
  // ─── Behavioural: /logout emits `user_logout` audit ─────────────────

  describe('/logout — `user_logout` audit emission', () => {
    it('emits exactly one `user_logout` audit row scoped to the session user after a password login', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5p2_lo_audit');
      const reg = await register(agent, user);
      const userId = reg.body?.data?.user?.id || reg.body?.user?.id;
      expect(userId).toBeTruthy();

      const fresh = request.agent(app);
      const loginRes = await fresh
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password });
      expect(loginRes.status).toBe(200);

      const before = db
        .prepare(
          "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'user_logout' AND requester_id = ?",
        )
        .get(userId).c;

      const logoutRes = await fresh.post('/api/v1/auth/logout').send({});
      expect([200, 204]).toContain(logoutRes.status);

      const rows = db
        .prepare(
          "SELECT requester_id, action, resource, scope, ip, details FROM audit_log WHERE action = 'user_logout' AND requester_id = ? ORDER BY id DESC",
        )
        .all(userId);
      expect(rows.length).toBe(before + 1);

      const row = rows[0];
      expect(row.action).toBe('user_logout');
      expect(row.requester_id).toBe(userId);
      expect(row.scope).toBe('session');
      expect(row.resource).toBe(`/users/${userId}`);
      expect(row.ip).toBeTruthy();

      // `details.sid` cross-correlates with the `user_login` row so
      // auditors can reconstruct session lifetimes.
      expect(row.details).toBeTruthy();
      const details = JSON.parse(row.details);
      expect(typeof details.sid).toBe('string');
      expect(details.sid.length).toBeGreaterThan(0);
    });

    it('does NOT emit a `user_logout` row for an anonymous logout (no actor → no audit)', async () => {
      const before = db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'user_logout'")
        .get().c;

      // Brand-new agent with no session cookie — server has no idea
      // who is logging out, so SOC2 has no actor to attribute.
      const fresh = request.agent(app);
      const res = await fresh.post('/api/v1/auth/logout').send({});
      expect([200, 204]).toContain(res.status);

      const after = db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'user_logout'")
        .get().c;
      expect(after).toBe(before);
    });
  });

  // ─── Behavioural: /register no longer hands out a meaningless token
  // and no longer mutates the orphaned `global.sessions` map.

  describe('/register — drop dead `global.sessions` token', () => {
    it('does NOT include a top-level `data.token` field in the 201 response', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5p2_reg_notoken');
      const res = await register(agent, user);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('data');
      // `data.user.id` etc must still be present.
      expect(res.body.data).toHaveProperty('user');
      // The dead `data.token` field must be gone.
      expect(res.body.data).not.toHaveProperty('token');
    });

    it('does NOT mutate `global.sessions` when a user registers', async () => {
      const agent = request.agent(app);
      const beforeKeys = Object.keys(global.sessions || {}).length;
      const user = uniqueUser('f5p2_reg_noglobal');
      const res = await register(agent, user);
      expect(res.status).toBe(201);
      const afterKeys = Object.keys(global.sessions || {}).length;
      expect(afterKeys).toBe(beforeKeys);
    });
  });

  // ─── Static tripwires for the source-level cleanups that no
  // behavioural test can observe (eviction-of-dead-code).

  describe('static tripwires — `global.sessions` is gone', () => {
    it('does NOT write to `global.sessions[…]` anywhere in src/routes/auth.js', () => {
      const src = readSrc(LIVE_ROUTES_PATH);
      // Both the `/register` write and the `/logout` sweep must be gone.
      expect(src).not.toMatch(/global\.sessions\s*\[/);
      expect(src).not.toMatch(/global\.sessions\s*=\s*\{/);
    });

    it('does NOT define or schedule `cleanupExpiredSessions` in src/index.js', () => {
      const src = readSrc(INDEX_JS_PATH);
      expect(src).not.toMatch(/function\s+cleanupExpiredSessions\b/);
      // Also catch lambda-style definitions and any setInterval hookup.
      expect(src).not.toMatch(/cleanupExpiredSessions\s*\(/);
      expect(src).not.toMatch(/cleanupExpiredSessions\s*=\s*function/);
    });
  });

  // ─── Static tripwire for the audit emit itself.  The behavioural
  // test above proves it works for password logins; the regex below
  // proves it lives inside the /logout block (so a refactor that
  // moves the call elsewhere doesn't silently drop SOC2 coverage).

  describe('static tripwire — `user_logout` audit emit lives inside /logout', () => {
    it('emits a `user_logout` audit log inside the /logout handler', () => {
      const liveSrc = readSrc(LIVE_ROUTES_PATH);
      const logoutBlock = liveSrc.match(
        /router\.post\(\s*['"]\/logout['"][\s\S]*?(?=\n\s*\/\*\*|router\.(?:post|get)\()/,
      );
      expect(logoutBlock).toBeTruthy();
      expect(logoutBlock[0]).toMatch(/createAuditLog\s*\(/);
      expect(logoutBlock[0]).toMatch(/action:\s*['"]user_logout['"]/);
    });
  });
});
