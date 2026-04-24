/**
 * F5.1 Phase 1a — Password auth parity between live handler
 * (`src/routes/auth.js`) and the features previously only present in the
 * shadow inline handlers in `src/index.js:6860/6887`.
 *
 * Phase 0 (`.context/sessions/2026-04-24-f5-phase0-audit.md`) proved that
 * `src/routes/auth.js` wins every `/api/v1/auth/*` request because it is
 * mounted BEFORE the inline routes and `src/auth.js`.  The winning file
 * was objectively weaker than the shadows it was eclipsing: no 2FA check
 * on password login, no audit-log events, no per-IP rate limit, no
 * username-or-email accept, no SOC2 session registry registration.
 *
 * This suite pins the behaviours that Phase 1a MUST bring onto the
 * winner before Phase 1b deletes the shadows.  It is deliberately written
 * RED-FIRST — every `it(...)` below SHOULD fail on a pre-P1a tree and
 * turn green once the port lands.  A failure of any of these after P1a
 * means we've regressed one of the security or compliance contracts the
 * shadow used to guarantee.
 *
 * Two flavours of assertion are used:
 *   1. Behavioural (supertest against the live Express app) — proves the
 *      user-visible contract: 2FA enforcement, audit-log emission,
 *      username-OR-email lookup, consent-timestamp persistence.
 *   2. Static tripwire (source grep on `src/routes/auth.js`) — proves
 *      the plumbing we cannot reach from a test-mode supertest run:
 *      `authRateLimit` wiring (test mode raises the cap to 1000/min so a
 *      behavioural 429 assertion is infeasible), `alerting.trackFailedLogin`
 *      wiring, and `registerUserSession` wiring (the in-memory SOC2 map
 *      lives in a sibling module and is not observable via HTTP).
 *
 * When Phase 2 of F5 (bcrypt cost 14 + upgrade-on-login) or Phase 1b
 * (shadow deletion) lands, only the implementation file moves — this
 * contract must remain stable.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const speakeasy = require('speakeasy');
const { app } = require('../index');
const { db } = require('../database');

const LIVE_ROUTES_PATH = path.join(__dirname, '..', 'routes', 'auth.js');
const LIVE_ROUTES_SRC = fs.readFileSync(LIVE_ROUTES_PATH, 'utf8');

function uniqueUser(tag = 'f5p1a') {
  // Keep it short enough to satisfy the 50-char username limit in src/routes/auth.js:234.
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    username: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}`,
    email: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}@example.com`,
    password: 'Strong!Pass123',
  };
}

async function register(agent, user, extras = {}) {
  return agent.post('/api/v1/auth/register').send({
    username: user.username,
    email: user.email,
    password: user.password,
    display_name: user.username,
    ...extras,
  });
}

function enable2FAForUser(userId) {
  // Seed the TOTP secret and flip the flag directly — we are not testing
  // the /2fa/setup UX here, only the login-time enforcement.
  const secret = speakeasy.generateSecret({ length: 20 });
  db.prepare('UPDATE users SET totp_secret = ?, two_factor_enabled = 1 WHERE id = ?').run(
    secret.base32,
    userId,
  );
  return secret.base32;
}

function latestAuditFor(action, requesterId) {
  // Match by action (and optionally requesterId) ordered by id DESC so
  // parallel tests don't false-match prior rows.
  const row = requesterId
    ? db
        .prepare(
          'SELECT * FROM audit_log WHERE action = ? AND requester_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(action, requesterId)
    : db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
  return row || null;
}

describe('F5.1 Phase 1a — password auth parity on src/routes/auth.js', () => {
  // ─── Behavioural: LOGIN ─────────────────────────────────────────────

  describe('login', () => {
    it('accepts `username` (not only `email`) as the identifier', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5_login_usern');
      const reg = await register(agent, user);
      expect([200, 201]).toContain(reg.status);

      // Fresh agent so the register auto-login does not mask the login path.
      const fresh = request.agent(app);
      const res = await fresh
        .post('/api/v1/auth/login')
        .send({ username: user.username, password: user.password });
      expect(res.status).toBe(200);
      expect(res.body?.userId || res.body?.user?.id).toBeTruthy();
    });

    it('emits a `failed_login` audit log on bad password', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5_login_fail');
      await register(agent, user);

      const fresh = request.agent(app);
      const res = await fresh
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'Nope!Wrong000' });
      expect(res.status).toBe(401);

      const row = db
        .prepare(
          "SELECT * FROM audit_log WHERE action = 'failed_login' AND details LIKE ? ORDER BY id DESC LIMIT 1",
        )
        .get(`%${user.username}%`);
      expect(row).toBeTruthy();
      expect(row.action).toBe('failed_login');
    });

    it('emits a `user_login` audit log on successful password login', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5_login_ok');
      const reg = await register(agent, user);
      const userId = reg.body?.data?.user?.id || reg.body?.user?.id;
      expect(userId).toBeTruthy();

      const fresh = request.agent(app);
      const res = await fresh
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password });
      expect(res.status).toBe(200);

      const row = latestAuditFor('user_login', userId);
      expect(row).toBeTruthy();
      expect(row.action).toBe('user_login');
    });

    // ── 2FA: the critical security regression the shadow was silently covering ──

    it('rejects password login with HTTP 401 + `requires2FA` when user has 2FA enabled and no code provided', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5_2fa_need');
      const reg = await register(agent, user);
      const userId = reg.body?.data?.user?.id || reg.body?.user?.id;
      expect(userId).toBeTruthy();
      enable2FAForUser(userId);

      const fresh = request.agent(app);
      const res = await fresh
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password });
      expect(res.status).toBe(401);
      expect(res.body?.requires2FA).toBe(true);
    });

    it('accepts password login with HTTP 200 when user has 2FA enabled and a valid TOTP code is provided', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5_2fa_ok');
      const reg = await register(agent, user);
      const userId = reg.body?.data?.user?.id || reg.body?.user?.id;
      expect(userId).toBeTruthy();
      const secret = enable2FAForUser(userId);

      const code = speakeasy.totp({ secret, encoding: 'base32' });
      const fresh = request.agent(app);
      const res = await fresh
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, totpCode: code });
      expect(res.status).toBe(200);
    });

    it('rejects a replayed TOTP code within its validity window', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5_2fa_rpl');
      const reg = await register(agent, user);
      const userId = reg.body?.data?.user?.id || reg.body?.user?.id;
      expect(userId).toBeTruthy();
      const secret = enable2FAForUser(userId);

      const code = speakeasy.totp({ secret, encoding: 'base32' });

      const first = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, totpCode: code });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, totpCode: code });
      expect(second.status).toBe(401);
      expect(String(second.body?.error || '').toLowerCase()).toMatch(/already used|replay/);
    });
  });

  // ─── Behavioural: REGISTER ──────────────────────────────────────────

  describe('register', () => {
    it('emits a `user_register` audit log on successful signup', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5_reg_ok');
      const res = await register(agent, user);
      expect([200, 201]).toContain(res.status);
      const userId = res.body?.data?.user?.id || res.body?.user?.id;
      expect(userId).toBeTruthy();

      const row = latestAuditFor('user_register', userId);
      expect(row).toBeTruthy();
      expect(row.action).toBe('user_register');
    });

    it('persists `accepted_terms_at` and `accepted_privacy_policy_at` when provided', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5_reg_cnsnt');
      const termsAt = '2026-01-02T03:04:05.000Z';
      const privacyAt = '2026-01-02T03:04:06.000Z';
      const res = await register(agent, user, {
        accepted_terms_at: termsAt,
        accepted_privacy_policy_at: privacyAt,
      });
      expect([200, 201]).toContain(res.status);

      const row = db
        .prepare(
          'SELECT accepted_terms_at, accepted_privacy_policy_at FROM users WHERE username = ?',
        )
        .get(user.username);
      expect(row).toBeTruthy();
      expect(row.accepted_terms_at).toBe(termsAt);
      expect(row.accepted_privacy_policy_at).toBe(privacyAt);
    });
  });

  // ─── Static tripwires (plumbing not reachable via HTTP in test mode) ──

  describe('static tripwires in src/routes/auth.js', () => {
    it('wires `authRateLimit` onto the /login route', () => {
      // Accept any order of the rate-limiter + CSRF middlewares so long as
      // authRateLimit participates in /login's middleware chain.
      expect(LIVE_ROUTES_SRC).toMatch(
        /router\.post\(\s*['"]\/login['"][\s\S]{0,200}?authRateLimit/,
      );
    });

    it('wires `authRateLimit` onto the /register route', () => {
      expect(LIVE_ROUTES_SRC).toMatch(
        /router\.post\(\s*['"]\/register['"][\s\S]{0,200}?authRateLimit/,
      );
    });

    it('wires `authRateLimit` onto the /token-login route', () => {
      expect(LIVE_ROUTES_SRC).toMatch(
        /router\.post\(\s*['"]\/token-login['"][\s\S]{0,200}?authRateLimit/,
      );
    });

    it('calls `alerting.trackFailedLogin` on bad-password and 2FA-fail paths', () => {
      // At least two call sites: failed password AND failed 2FA code.
      const matches = LIVE_ROUTES_SRC.match(/alerting\.trackFailedLogin\s*\(/g) || [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('registers the session in the SOC2 registry after a successful password login', () => {
      expect(LIVE_ROUTES_SRC).toMatch(/registerUserSession\s*\(\s*[^)]*,\s*req\.sessionID\s*\)/);
    });
  });
});
