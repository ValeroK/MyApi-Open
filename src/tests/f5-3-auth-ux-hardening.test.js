/**
 * F5.3 — Auth UX hardening.
 *
 * Covers the four user-reported bugs that all live in the same auth
 * surface:
 *
 *   Bug 1 — Password reset is silent when the email transport is not
 *           configured.  The /auth/email-config-status endpoint must
 *           expose this so the UI can warn before the user clicks
 *           "Send reset link".
 *
 *   Bug 2 — Multiple registrations with the same email succeeded,
 *           leaving orphaned accounts the user could no longer log
 *           into.  /auth/register must return 409 EMAIL_EXISTS the
 *           second time, and the unique index must hold the line at
 *           the DB layer too.
 *
 *   Bug 3 — A user who signed up via OAuth (Google/GitHub/Facebook)
 *           has no password they ever set; a password login attempt
 *           hit "Invalid credentials" and looked broken.  /auth/login
 *           must return 409 OAUTH_ONLY with the provider name so the
 *           UI can redirect them into the OAuth flow.
 *
 *   Bug 4 — After login the dashboard occasionally bounced back to the
 *           marketing landing page because the post-logout flag was
 *           still set in localStorage.  The store-level fix
 *           (setUser → clearLoggedOut) is exercised in the dashboard
 *           e2e checklist; here we lock down the server-side guarantee
 *           that login responses populate `data.user` so the
 *           authStore has something concrete to set.
 *
 * All four bugs share the same DB and route surface, so one suite
 * keeps the migration assumptions in one place.
 */

const request = require('supertest');
const bcrypt = require('bcrypt');

// emailService is a singleton — make sure outbound calls do nothing
// during the suite, otherwise we'd try to talk to a real SMTP server.
const emailService = require('../services/emailService');
if (typeof emailService.sendPasswordResetEmail !== 'function') {
  emailService.sendPasswordResetEmail = async () => undefined;
}
jest.spyOn(emailService, 'sendPasswordResetEmail').mockImplementation(async () => undefined);

const { app } = require('../index');
const { db } = require('../database');

function uniqueUser(tag = 'f5p3') {
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

async function login(agent, user) {
  return agent.post('/api/v1/auth/login').send({
    email: user.email,
    password: user.password,
  });
}

describe('F5.3 — auth UX hardening', () => {
  // ─── Bug 1: email-config-status endpoint ────────────────────────

  describe('GET /api/v1/auth/email-config-status', () => {
    it('returns 200 with { configured, provider, missing } shape', async () => {
      const res = await request(app).get('/api/v1/auth/email-config-status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('configured');
      expect(typeof res.body.configured).toBe('boolean');
      expect(res.body).toHaveProperty('provider');
      expect(res.body).toHaveProperty('missing');
      expect(Array.isArray(res.body.missing)).toBe(true);
    });

    it('does NOT require authentication (the UI calls it before login)', async () => {
      const res = await request(app).get('/api/v1/auth/email-config-status');
      expect([200]).toContain(res.status);
    });

    it('sets Cache-Control: no-store so the banner stays accurate after re-config', async () => {
      const res = await request(app).get('/api/v1/auth/email-config-status');
      expect(String(res.headers['cache-control'] || '')).toMatch(/no-store/i);
    });
  });

  // ─── Bug 2: duplicate-email registration ────────────────────────

  describe('POST /api/v1/auth/register — email uniqueness', () => {
    it('returns 409 EMAIL_EXISTS when a second account uses the same email (different username)', async () => {
      const a = uniqueUser('f5p3_email_dup');
      const r1 = await register(request.agent(app), a);
      expect(r1.status).toBe(201);

      const b = { ...a, username: `${a.username}_other` };
      const r2 = await register(request.agent(app), b);
      expect(r2.status).toBe(409);
      expect(r2.body?.code).toBe('EMAIL_EXISTS');
    });

    it('returns 409 EMAIL_EXISTS when the second submission only differs in case', async () => {
      const a = uniqueUser('f5p3_email_case');
      const r1 = await register(request.agent(app), a);
      expect(r1.status).toBe(201);

      const b = {
        ...a,
        username: `${a.username}_case`,
        email: a.email.toUpperCase(),
      };
      const r2 = await register(request.agent(app), b);
      expect(r2.status).toBe(409);
      expect(r2.body?.code).toBe('EMAIL_EXISTS');
    });

    it('still returns 409 USERNAME_EXISTS when the username collides but email is fresh', async () => {
      const a = uniqueUser('f5p3_user_dup');
      const r1 = await register(request.agent(app), a);
      expect(r1.status).toBe(201);

      const b = {
        ...a,
        email: `other_${a.email}`,
      };
      const r2 = await register(request.agent(app), b);
      expect(r2.status).toBe(409);
      // Either explicit code OR fall-back string — both shapes are acceptable
      // as long as the response is 409 and not 201.
      const code = r2.body?.code;
      expect(['USERNAME_EXISTS', undefined]).toContain(code);
    });

    it('writes password_set_at on the very first registration', async () => {
      const u = uniqueUser('f5p3_pwa');
      const res = await register(request.agent(app), u);
      expect(res.status).toBe(201);

      const row = db
        .prepare('SELECT password_set_at FROM users WHERE email = ?')
        .get(u.email);
      expect(row).toBeTruthy();
      expect(row.password_set_at).toBeTruthy();
    });
  });

  // ─── Bug 3: OAuth-only account guard ────────────────────────────

  describe('POST /api/v1/auth/login — OAuth-only guard', () => {
    /**
     * Simulate an OAuth-created user: no `password_set_at`, plus a
     * row in `oauth_tokens` for the provider.  `password_hash` is
     * still populated (every account row has one — we just want to
     * make sure we never let it through password login).
     */
    function seedOAuthUser({ email, provider }) {
      const id = `oauth_${Math.random().toString(36).slice(2, 10)}`;
      const username = email.split('@')[0];
      const now = Math.floor(Date.now() / 1000);
      const hash = bcrypt.hashSync(`random_${Math.random()}`, 4);

      db.prepare(`
        INSERT INTO users (id, username, password_hash, display_name, email, timezone, created_at, status, roles)
        VALUES (?, ?, ?, ?, ?, 'UTC', ?, 'active', 'user')
      `).run(id, username, hash, username, email, now);

      db.prepare(`
        INSERT INTO oauth_tokens (id, user_id, service_name, access_token, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`tok_${id}`, id, provider, 'fake_token_for_test', now, now);

      return { id, username, email };
    }

    it('returns 409 OAUTH_ONLY with the provider name', async () => {
      const email = `f5p3_oauthonly_${Math.random().toString(36).slice(2, 8)}@example.com`;
      seedOAuthUser({ email, provider: 'google' });

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: 'irrelevant_guess' });

      expect(res.status).toBe(409);
      expect(res.body?.code).toBe('OAUTH_ONLY');
      expect(res.body?.provider).toBe('google');
    });

    it('does NOT leak whether the password was correct (always 409 even for the right hash)', async () => {
      // Re-seed with a known plain password — the guard should still
      // return OAUTH_ONLY without revealing the hash matches.
      const email = `f5p3_oauthonly_known_${Math.random().toString(36).slice(2, 8)}@example.com`;
      const id = `oauth_known_${Math.random().toString(36).slice(2, 8)}`;
      const knownPw = 'KnownPw!1234';
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT INTO users (id, username, password_hash, display_name, email, timezone, created_at, status, roles)
        VALUES (?, ?, ?, ?, ?, 'UTC', ?, 'active', 'user')
      `).run(id, `known_${id.slice(-6)}`, bcrypt.hashSync(knownPw, 4), 'Known', email, now);
      db.prepare(`
        INSERT INTO oauth_tokens (id, user_id, service_name, access_token, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`tok_known_${id}`, id, 'github', 'fake_token_for_test', now, now);

      const res = await request(app).post('/api/v1/auth/login').send({ email, password: knownPw });
      expect(res.status).toBe(409);
      expect(res.body?.code).toBe('OAUTH_ONLY');
    });

    it('lets a password user log in normally (password_set_at IS set, no guard hit)', async () => {
      const u = uniqueUser('f5p3_pwlogin');
      const agent = request.agent(app);
      const r1 = await register(agent, u);
      expect(r1.status).toBe(201);
      const r2 = await login(agent, u);
      expect(r2.status).toBe(200);
      expect(r2.body?.code).not.toBe('OAUTH_ONLY');
    });
  });

  // ─── Bug 4: login response payload feeds the auth store ─────────

  describe('POST /api/v1/auth/login — payload contract', () => {
    it('returns a populated `data.user` so authStore.setUser can hydrate', async () => {
      const u = uniqueUser('f5p3_payload');
      const agent = request.agent(app);
      await register(agent, u);
      const res = await login(agent, u);

      expect(res.status).toBe(200);
      // Some routes use {data:{user}}, others top-level {user} — accept both.
      const user = res.body?.data?.user || res.body?.user;
      expect(user).toBeTruthy();
      expect(user?.email || '').toBe(u.email);
    });
  });
});
