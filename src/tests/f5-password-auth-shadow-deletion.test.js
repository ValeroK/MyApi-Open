/**
 * F5.1 Phase 1b — Shadow deletion gates + last-mile feature ports.
 *
 * Phase 1a (`f5-password-auth-parity.test.js`) brought every missing
 * security control from the shadow inline routes in `src/index.js` and
 * the legacy `src/auth.js` onto the live router (`src/routes/auth.js`),
 * but two compliance gaps remained that we need to close BEFORE deleting
 * the shadows so we don't ship a regression:
 *
 *   1. `/logout` on the live router never calls `unregisterUserSession`.
 *      The shadow at `src/index.js:7688` did. Without the port, every
 *      successful login adds an entry to the SOC2 CC6 concurrent-session
 *      registry that is never released — the per-user list grows for the
 *      account's lifetime and silently triggers eviction-of-the-oldest on
 *      the 4th legitimate login.
 *
 *   2. `/logout` on the live router does not strip `oauth_signup` or
 *      `isFirstLogin` from the session before destruction.  The shadow
 *      did.  These keys carry first-login bootstrap state — leaking them
 *      across a logout means the next session for the same browser tab
 *      can be auto-routed into onboarding even though it's a returning
 *      user.
 *
 *   3. `/token-login` on the live router never emits a `token_login`
 *      audit log.  The shadow at `src/index.js:7004` did.  Audit-log
 *      coverage for token-based authentications is a SOC2 CC7
 *      requirement.
 *
 * This suite is RED-FIRST.  It fails on a tree that still has the
 * shadows + the gaps, and turns green when the ports land AND the
 * shadows are deleted.  The static tripwires at the bottom are the
 * deletion gate: they fail if `src/auth.js` ever comes back, if any
 * inline `app.{post,get}('/api/v1/auth/...'` shadow is reintroduced in
 * `src/index.js`, or if a `require('./auth')` slips in.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../index');
const { db, getExistingMasterToken, createAccessToken } = require('../database');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const authHardening = require('../lib/authHardening');

const INDEX_JS_PATH = path.join(__dirname, '..', 'index.js');
const LIVE_ROUTES_PATH = path.join(__dirname, '..', 'routes', 'auth.js');
const SRC_AUTH_LEGACY_PATH = path.join(__dirname, '..', 'auth.js');

function readSrc(p) {
  return fs.readFileSync(p, 'utf8');
}

function uniqueUser(tag = 'f5p1b') {
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

describe('F5.1 Phase 1b — shadow deletion gates + last-mile ports', () => {
  // ─── Behavioural: /logout SOC2 cleanup ────────────────────────────────

  describe('/logout — SOC2 CC6 unregister', () => {
    it('removes the session from `userSessionRegistry` after a successful logout', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5p1b_logout_soc2');
      const reg = await register(agent, user);
      const userId = reg.body?.data?.user?.id || reg.body?.user?.id;
      expect(userId).toBeTruthy();

      const fresh = request.agent(app);
      const loginRes = await fresh
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password });
      expect(loginRes.status).toBe(200);

      // After login, the SOC2 registry should contain exactly one entry
      // for this user.  The actual sessionId is opaque to the test, but
      // the COUNT is the contract that matters for the eviction policy.
      const beforeLogout = authHardening._internals.userSessionRegistry.get(userId) || [];
      expect(beforeLogout.length).toBe(1);

      const logoutRes = await fresh.post('/api/v1/auth/logout').send({});
      expect([200, 204]).toContain(logoutRes.status);

      // After logout, the entry MUST be removed so the per-user
      // concurrent-session cap (3) doesn't silently fill up over the
      // account's lifetime.  Either the array is empty OR the user key
      // is gone entirely — both are acceptable cleanup shapes.
      const afterLogout = authHardening._internals.userSessionRegistry.get(userId) || [];
      expect(afterLogout.length).toBe(0);
    });
  });

  // ─── Static tripwires for the small port that the behavioural test
  // above can't observe (session-key deletion happens BEFORE the
  // session is destroyed and is not visible from outside the request).

  describe('/logout — session-key cleanup tripwires', () => {
    let liveSrc;
    beforeAll(() => {
      liveSrc = readSrc(LIVE_ROUTES_PATH);
    });

    it('deletes `req.session.oauth_signup` inside the /logout handler', () => {
      // Anchor the regex inside the /logout block by requiring the match
      // to occur after `router.post('/logout'` and before the next
      // `router.{post,get}(` declaration.
      const logoutBlock = liveSrc.match(
        /router\.post\(\s*['"]\/logout['"][\s\S]*?(?=\n\s*\/\*\*|router\.(?:post|get)\()/,
      );
      expect(logoutBlock).toBeTruthy();
      expect(logoutBlock[0]).toMatch(/delete\s+req\.session\.oauth_signup/);
    });

    it('deletes `req.session.isFirstLogin` inside the /logout handler', () => {
      const logoutBlock = liveSrc.match(
        /router\.post\(\s*['"]\/logout['"][\s\S]*?(?=\n\s*\/\*\*|router\.(?:post|get)\()/,
      );
      expect(logoutBlock).toBeTruthy();
      expect(logoutBlock[0]).toMatch(/delete\s+req\.session\.isFirstLogin/);
    });

    it('calls `unregisterUserSession` inside the /logout handler', () => {
      const logoutBlock = liveSrc.match(
        /router\.post\(\s*['"]\/logout['"][\s\S]*?(?=\n\s*\/\*\*|router\.(?:post|get)\()/,
      );
      expect(logoutBlock).toBeTruthy();
      expect(logoutBlock[0]).toMatch(/unregisterUserSession\s*\(/);
    });
  });

  // ─── Behavioural: /token-login audit log ──────────────────────────────

  describe('/token-login — audit log', () => {
    it('emits a `token_login` audit log on successful master-token login', async () => {
      // Seed: create a user, then mint a master token in the DB so we
      // can drive /token-login deterministically without going through
      // the dashboard bootstrap path.
      const agent = request.agent(app);
      const user = uniqueUser('f5p1b_tlog_audit');
      const reg = await register(agent, user);
      const userId = reg.body?.data?.user?.id || reg.body?.user?.id;
      expect(userId).toBeTruthy();

      // Avoid stepping on an existing master token (some test setups
      // pre-mint one); reuse it if present so token-login finds a row.
      let rawToken;
      let tokenId;
      const existing = getExistingMasterToken(userId);
      if (existing) {
        rawToken = existing.rawToken;
        tokenId = existing.tokenId;
      } else {
        rawToken = 'myapi_' + crypto.randomBytes(32).toString('hex');
        const hash = await bcrypt.hash(rawToken, 4); // low cost — test only
        tokenId = createAccessToken(
          hash,
          userId,
          'full',
          'Master Token',
          null,
          null,
          null,
          rawToken,
          'master',
        );
      }
      expect(rawToken).toBeTruthy();
      expect(tokenId).toBeTruthy();

      const before = db
        .prepare(
          "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'token_login' AND requester_id = ?",
        )
        .get(tokenId).c;

      const fresh = request.agent(app);
      const res = await fresh.post('/api/v1/auth/token-login').send({ token: rawToken });
      expect(res.status).toBe(200);

      const after = db
        .prepare(
          "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'token_login' AND requester_id = ?",
        )
        .get(tokenId).c;
      expect(after).toBeGreaterThan(before);
    });
  });

  // ─── Static deletion-gate tripwires ───────────────────────────────────
  //
  // These are the contract that defines "Phase 1b is done":
  //   - the legacy file `src/auth.js` no longer exists,
  //   - no `require('./auth')` (the legacy import) is left in
  //     `src/index.js`,
  //   - no inline `app.post('/api/v1/auth/{login,register,logout,
  //     token-login}'` or `app.get('/api/v1/auth/me'` shadow is left in
  //     `src/index.js`.

  describe('shadow deletion gates', () => {
    it('does NOT have a legacy `src/auth.js` file', () => {
      expect(fs.existsSync(SRC_AUTH_LEGACY_PATH)).toBe(false);
    });

    it('does NOT `require(\'./auth\')` anywhere in src/index.js (legacy import)', () => {
      const src = readSrc(INDEX_JS_PATH);
      // Permit `require('./routes/auth')` (the LIVE router) — the regex
      // only matches the legacy single-segment path.
      expect(src).not.toMatch(/require\(\s*['"]\.\/auth['"]\s*\)/);
      expect(src).not.toMatch(/require\(\s*['"]\.\/auth\.js['"]\s*\)/);
    });

    it('does NOT register inline `/api/v1/auth/{login,register,logout,token-login}` or `/auth/me` shadows in src/index.js', () => {
      const src = readSrc(INDEX_JS_PATH);
      const offenders = [
        /app\.post\(\s*['"]\/api\/v1\/auth\/login['"]/,
        /app\.post\(\s*['"]\/api\/v1\/auth\/register['"]/,
        /app\.post\(\s*['"]\/api\/v1\/auth\/logout['"]/,
        /app\.post\(\s*['"]\/api\/v1\/auth\/token-login['"]/,
        /app\.get\(\s*['"]\/api\/v1\/auth\/me['"]/,
      ];
      for (const rx of offenders) {
        expect(src).not.toMatch(rx);
      }
    });

    it('does NOT mount `authRoutes` (legacy router) on /api/v1 in src/index.js', () => {
      const src = readSrc(INDEX_JS_PATH);
      // The live router is mounted as `app.use('/api/v1/auth', newAuthRoutes)`
      // — that line is allowed.  The legacy mount was
      // `app.use('/api/v1', authRoutes)`, anchored on the bare
      // `authRoutes` identifier.
      expect(src).not.toMatch(/app\.use\(\s*['"]\/api\/v1['"]\s*,\s*authRoutes\s*\)/);
    });
  });
});
