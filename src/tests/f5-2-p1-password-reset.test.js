/**
 * F5.2 P1 — Password reset flow.
 *
 * Forgot-password backend: token issuance, email delivery, token
 * validation, password update, session revocation.  Plan in
 * `.context/tasks/backlog/F5.2-working-password-auth-and-activity-log-cleanup.md`.
 *
 * Contract surface:
 *   POST /api/v1/auth/password/reset/request  → 202 always, never leaks
 *     whether the email exists.  Mints a 32-byte raw token, stores its
 *     bcrypt hash with `expires_at = now + 2h` (per D3), sends
 *     emailService.sendPasswordResetEmail with a link.  Per-IP rate
 *     limit via the existing authRateLimit; per-email rate limit 3/h.
 *
 *   POST /api/v1/auth/password/reset/confirm  → 200 on success;
 *     410 INVALID_OR_EXPIRED_TOKEN on bad/consumed/expired token;
 *     400 on weak newPassword.  On success: bcrypt-hashes the new
 *     password, marks token consumed, revokes all user sessions, and
 *     establishes a fresh session so the UI can land on /dashboard
 *     already logged in.
 *
 * RED-FIRST.  Every assertion below should fail on a tree without the
 * P1 endpoints and turn green only when the implementation lands.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const bcrypt = require('bcrypt');

// Spy on the singleton emailService BEFORE the app loads any module
// that captured a reference to it (it's mutated, not re-required).
// If the method doesn't exist yet (red-first phase), seed a stub so
// jest.spyOn can attach.  Once the implementation lands the real
// method replaces the stub on the next module load.
const emailService = require('../services/emailService');
if (typeof emailService.sendPasswordResetEmail !== 'function') {
  emailService.sendPasswordResetEmail = async () => undefined;
}
jest.spyOn(emailService, 'sendPasswordResetEmail').mockImplementation(async () => undefined);

const { app } = require('../index');
const { db } = require('../database');

const LIVE_ROUTES_PATH = path.join(__dirname, '..', 'routes', 'auth.js');
const DATABASE_PATH = path.join(__dirname, '..', 'database.js');

function uniqueUser(tag = 'f5p1') {
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

beforeEach(() => {
  emailService.sendPasswordResetEmail.mockClear();
});

describe('F5.2 P1 — password reset', () => {
  // ─── Schema migration tripwire ─────────────────────────────────────

  describe('schema migration', () => {
    it('creates the password_reset_tokens table with the expected columns', () => {
      const tableInfo = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'password_reset_tokens'")
        .all();
      expect(tableInfo.length).toBe(1);

      const cols = db.prepare('PRAGMA table_info(password_reset_tokens)').all().map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'user_id', 'token_hash', 'expires_at', 'consumed_at', 'request_ip', 'created_at',
      ]));
    });
  });

  // ─── /password/reset/request ───────────────────────────────────────

  describe('POST /password/reset/request', () => {
    it('returns 202 + sends an email when the email matches a real account', async () => {
      const user = uniqueUser('f5p1_req_known');
      const agent = request.agent(app);
      const reg = await register(agent, user);
      expect(reg.status).toBe(201);

      const res = await request(app)
        .post('/api/v1/auth/password/reset/request')
        .send({ email: user.email });

      expect(res.status).toBe(202);
      expect(emailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
      const [toEmail, link] = emailService.sendPasswordResetEmail.mock.calls[0];
      expect(toEmail.toLowerCase()).toBe(user.email.toLowerCase());
      expect(link).toMatch(/\/reset-password\?token=[A-Fa-f0-9]{64}/);

      const row = db
        .prepare('SELECT * FROM password_reset_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(reg.body.data.user.id);
      expect(row).toBeTruthy();
      expect(row.token_hash).toBeTruthy();
      expect(row.consumed_at).toBeFalsy();
      expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('returns 202 + does NOT send an email when the email is unknown (timing-safe — no leak)', async () => {
      const res = await request(app)
        .post('/api/v1/auth/password/reset/request')
        .send({ email: `nobody_${Date.now()}@example.com` });

      expect(res.status).toBe(202);
      expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('rate-limits per email: 4th request to the same email within an hour returns 429', async () => {
      const user = uniqueUser('f5p1_ratelimit');
      const agent = request.agent(app);
      const reg = await register(agent, user);
      expect(reg.status).toBe(201);

      // 3 successful requests
      for (let i = 0; i < 3; i += 1) {
        const r = await request(app)
          .post('/api/v1/auth/password/reset/request')
          .send({ email: user.email });
        expect(r.status).toBe(202);
      }

      // 4th — must be 429
      const r4 = await request(app)
        .post('/api/v1/auth/password/reset/request')
        .send({ email: user.email });
      expect(r4.status).toBe(429);
    });

    it('writes a `password_reset_requested` audit row with email_known boolean (no raw email in details)', async () => {
      const user = uniqueUser('f5p1_audit_req');
      const agent = request.agent(app);
      const reg = await register(agent, user);
      expect(reg.status).toBe(201);
      const userId = reg.body.data.user.id;

      const before = db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'password_reset_requested'")
        .get().c;

      await request(app)
        .post('/api/v1/auth/password/reset/request')
        .send({ email: user.email });

      const after = db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'password_reset_requested'")
        .get().c;
      expect(after).toBe(before + 1);

      const row = db
        .prepare("SELECT * FROM audit_log WHERE action = 'password_reset_requested' AND requester_id = ? ORDER BY id DESC LIMIT 1")
        .get(userId);
      expect(row).toBeTruthy();
      expect(row.action).toBe('password_reset_requested');
      const details = row.details ? JSON.parse(row.details) : {};
      expect(details.email_known).toBe(true);
      // Privacy: raw email must NEVER land in details.
      expect(JSON.stringify(details).toLowerCase()).not.toContain(user.email.toLowerCase());
    });
  });

  // ─── /password/reset/confirm ───────────────────────────────────────

  describe('POST /password/reset/confirm', () => {
    async function mintTokenForUser(user) {
      const agent = request.agent(app);
      const reg = await register(agent, user);
      expect(reg.status).toBe(201);
      const userId = reg.body.data.user.id;

      // Trigger the request endpoint and capture the raw token from
      // the email-link argument the spy received.
      emailService.sendPasswordResetEmail.mockClear();
      await request(app)
        .post('/api/v1/auth/password/reset/request')
        .send({ email: user.email });
      expect(emailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
      const link = emailService.sendPasswordResetEmail.mock.calls[0][1];
      const tokenMatch = link.match(/token=([A-Fa-f0-9]+)/);
      expect(tokenMatch).toBeTruthy();
      return { userId, rawToken: tokenMatch[1] };
    }

    it('200s on a fresh token, updates users.password_hash, marks the token consumed', async () => {
      const user = uniqueUser('f5p1_confirm_ok');
      const { userId, rawToken } = await mintTokenForUser(user);
      const newPassword = 'Brand!New!Pass1';

      const beforeHash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash;

      const res = await request(app)
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: rawToken, newPassword });

      expect(res.status).toBe(200);

      const afterHash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash;
      expect(afterHash).not.toBe(beforeHash);
      expect(await bcrypt.compare(newPassword, afterHash)).toBe(true);

      const row = db
        .prepare('SELECT consumed_at FROM password_reset_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(userId);
      expect(row.consumed_at).toBeTruthy();
    });

    it('410 INVALID_OR_EXPIRED_TOKEN on a token that has already been consumed', async () => {
      const user = uniqueUser('f5p1_confirm_consumed');
      const { rawToken } = await mintTokenForUser(user);

      // First confirm — consumes the token.
      const r1 = await request(app)
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: rawToken, newPassword: 'AnotherPass!42' });
      expect(r1.status).toBe(200);

      // Second confirm with the same token — must be 410.
      const r2 = await request(app)
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: rawToken, newPassword: 'YetAnotherPass!9' });
      expect(r2.status).toBe(410);
      expect(r2.body.error).toBe('INVALID_OR_EXPIRED_TOKEN');
    });

    it('410 INVALID_OR_EXPIRED_TOKEN when expires_at is in the past', async () => {
      const user = uniqueUser('f5p1_confirm_expired');
      const { userId, rawToken } = await mintTokenForUser(user);

      // Backdate the most recent token row.
      db.prepare(
        "UPDATE password_reset_tokens SET expires_at = '1970-01-01T00:00:00.000Z' WHERE user_id = ?",
      ).run(userId);

      const res = await request(app)
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: rawToken, newPassword: 'StillStrong!42' });
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('INVALID_OR_EXPIRED_TOKEN');
    });

    it('410 INVALID_OR_EXPIRED_TOKEN on a garbage token (no row matches)', async () => {
      const res = await request(app)
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: 'deadbeef'.repeat(8), newPassword: 'StillStrong!42' });
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('INVALID_OR_EXPIRED_TOKEN');
    });

    it('400 on weak newPassword + token NOT consumed (so user can retry without re-requesting)', async () => {
      const user = uniqueUser('f5p1_confirm_weak');
      const { userId, rawToken } = await mintTokenForUser(user);

      const res = await request(app)
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: rawToken, newPassword: 'short' });
      expect(res.status).toBe(400);

      const row = db
        .prepare('SELECT consumed_at FROM password_reset_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(userId);
      expect(row.consumed_at).toBeFalsy();
    });

    it('after a successful confirm, the SOC2 session registry no longer tracks the user (sessions revoked)', async () => {
      // In test mode, express-session falls back to its built-in
      // MemoryStore (the SQLite-backed store in src/index.js is only
      // wired when NODE_ENV !== 'test').  As a result the in-test
      // session store reference held by authHardening.js is
      // `undefined`, and `_sessionStore.destroy()` becomes a no-op.
      // We therefore assert against the registry — which IS in-process
      // and IS observable — to prove the revocation logic ran.  The
      // Docker smoke phase exercises the real cookie-killing path
      // against a wired SQLite store.
      const { _internals } = require('../lib/authHardening');
      const { userSessionRegistry } = _internals;

      const user = uniqueUser('f5p1_confirm_revoke');
      const { userId, rawToken } = await mintTokenForUser(user);

      // Establish a prior session via password login (this calls
      // registerUserSession internally on the /login success path).
      const priorAgent = request.agent(app);
      const loginRes = await priorAgent
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password });
      expect(loginRes.status).toBe(200);

      // Pre-reset: registry tracks at least one session for this user.
      const beforeSessions = (userSessionRegistry.get(userId) || []).slice();
      expect(beforeSessions.length).toBeGreaterThanOrEqual(1);

      // Reset the password.
      const r = await request(app)
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: rawToken, newPassword: 'PostReset!Pass99' });
      expect(r.status).toBe(200);

      // Post-reset: every previously tracked session for this user
      // is gone.  (revokeAllUserSessions calls .delete(userId); the
      // confirm endpoint then registers its own fresh session, but
      // its sessionId MUST be different from the prior set.)
      const afterSessions = userSessionRegistry.get(userId) || [];
      const beforeIds = new Set(beforeSessions.map((s) => s.sessionId));
      for (const s of afterSessions) {
        expect(beforeIds.has(s.sessionId)).toBe(false);
      }
    });

    it('writes a `password_reset_completed` audit row on success', async () => {
      const user = uniqueUser('f5p1_confirm_audit');
      const { userId, rawToken } = await mintTokenForUser(user);

      const before = db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'password_reset_completed' AND requester_id = ?")
        .get(userId).c;

      const r = await request(app)
        .post('/api/v1/auth/password/reset/confirm')
        .send({ token: rawToken, newPassword: 'WowSoStrong!42' });
      expect(r.status).toBe(200);

      const after = db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'password_reset_completed' AND requester_id = ?")
        .get(userId).c;
      expect(after).toBe(before + 1);
    });
  });

  // ─── Static tripwires ──────────────────────────────────────────────

  describe('static tripwires — implementation lives where the plan says', () => {
    it('src/database.js declares a CREATE TABLE for password_reset_tokens (idempotent)', () => {
      const src = fs.readFileSync(DATABASE_PATH, 'utf8');
      expect(src).toMatch(/CREATE TABLE IF NOT EXISTS password_reset_tokens/);
    });

    it('src/routes/auth.js mounts /password/reset/request and /password/reset/confirm', () => {
      const src = fs.readFileSync(LIVE_ROUTES_PATH, 'utf8');
      expect(src).toMatch(/router\.post\(\s*['"]\/password\/reset\/request['"]/);
      expect(src).toMatch(/router\.post\(\s*['"]\/password\/reset\/confirm['"]/);
    });
  });
});
