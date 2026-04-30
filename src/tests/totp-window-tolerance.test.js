/**
 * TOTP verification window — tolerance pin.
 *
 * Background: 2026-04-30, mailer.kv@gmail.com hit "Invalid 2FA code" on
 * a freshly-wiped DB with a freshly-scanned QR. Live instrumentation
 * showed the user's authenticator was running consistently +120 s
 * (delta = +4 steps) ahead of the container's clock — within the realm
 * of normal Android phone NTP drift. The previous server tolerance of
 * `speakeasy.totp.verify({ window: 2 })` (= ±60 s) was tight enough
 * that the user could never enrol.
 *
 * Operator decision: bump tolerance to `window: 4` (= ±120 s) on every
 * TOTP verify call site so honest users with mildly drifted phones can
 * complete enrolment / login / step-up auth without first having to
 * manually run "Time correction for codes" on the device.
 *
 * Replay protection (`isTotpCodeUsed` in `src/lib/authHardening.js`)
 * tracks used codes per user with a TTL that MUST cover the verifier's
 * full validity span. With `window: 4` the validity span of a single
 * code is 240 s (a code generated at t_code is acceptable when
 * t_now ∈ [t_code - 120, t_code + 120]). The TTL must therefore be at
 * least 240 s, with a small buffer for clock skew between the verify
 * call and the replay-mark write.
 *
 * This suite source-pins both knobs so a future edit cannot silently
 * narrow the verify window or shrink the replay TTL below the verify
 * span.
 *
 * RED-FIRST: every assertion below MUST fail against the pre-fix tree
 * (`window: 2` + `TOTP_CODE_TTL_MS = 90_000`) and turn green once the
 * fix lands.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const speakeasy = require('speakeasy');
const { app } = require('../index');
const { db } = require('../database');
const { _internals } = require('../lib/authHardening');

const SRC_INDEX_PATH = path.join(__dirname, '..', 'index.js');
const SRC_INDEX_SRC = fs.readFileSync(SRC_INDEX_PATH, 'utf8');
const SRC_AUTH_PATH = path.join(__dirname, '..', 'routes', 'auth.js');
const SRC_AUTH_SRC = fs.readFileSync(SRC_AUTH_PATH, 'utf8');

function uniqueUser(tag = 'totp_win') {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    username: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}`,
    email: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}@example.com`,
    password: 'Strong!Pass123',
  };
}

async function registerAnd2FA(user) {
  const agent = request.agent(app);
  const reg = await agent.post('/api/v1/auth/register').send({
    username: user.username,
    email: user.email,
    password: user.password,
    display_name: user.username,
  });
  const userId = reg.body?.data?.user?.id || reg.body?.user?.id;
  expect(userId).toBeTruthy();
  const secret = speakeasy.generateSecret({ length: 20 });
  db.prepare('UPDATE users SET totp_secret = ?, two_factor_enabled = 1 WHERE id = ?').run(
    secret.base32,
    userId,
  );
  return { userId, secret: secret.base32 };
}

describe('TOTP verify window tolerance', () => {
  describe('behavioural: /api/v1/auth/login with totpCode', () => {
    it('ACCEPTS a TOTP code generated +90s in the future (within ±120s window)', async () => {
      const user = uniqueUser('totp_p90');
      const { secret } = await registerAnd2FA(user);

      const futureCode = speakeasy.totp({
        secret,
        encoding: 'base32',
        time: Math.floor(Date.now() / 1000) + 90,
      });

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, totpCode: futureCode });
      expect(res.status).toBe(200);
    });

    it('ACCEPTS a TOTP code generated -90s in the past (within ±120s window)', async () => {
      const user = uniqueUser('totp_m90');
      const { secret } = await registerAnd2FA(user);

      const pastCode = speakeasy.totp({
        secret,
        encoding: 'base32',
        time: Math.floor(Date.now() / 1000) - 90,
      });

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, totpCode: pastCode });
      expect(res.status).toBe(200);
    });

    it('REJECTS a TOTP code generated +150s in the future (outside ±120s window)', async () => {
      const user = uniqueUser('totp_p150');
      const { secret } = await registerAnd2FA(user);

      const tooFutureCode = speakeasy.totp({
        secret,
        encoding: 'base32',
        time: Math.floor(Date.now() / 1000) + 150,
      });

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, totpCode: tooFutureCode });
      expect(res.status).toBe(401);
    });
  });

  describe('source-pin: window:4 on every TOTP verify call site', () => {
    it('src/index.js has no surviving `window: 2` in any speakeasy.totp.verify block', () => {
      // Find every speakeasy.totp.verify({ ... }) block and ensure each
      // contains `window: 4` (or higher) and zero `window: 2`. The
      // regex is multiline-DOTALL aware via [\s\S]*? and bounded by the
      // closing brace.
      const verifyBlocks = SRC_INDEX_SRC.match(
        /speakeasy\.totp\.verify\s*\(\s*\{[\s\S]*?\}\s*\)/g,
      ) || [];
      expect(verifyBlocks.length).toBeGreaterThanOrEqual(4);
      for (const block of verifyBlocks) {
        expect(block).not.toMatch(/window:\s*2[^0-9]/);
        expect(block).toMatch(/window:\s*4[^0-9]/);
      }
    });

    it('src/routes/auth.js login route uses window:4', () => {
      const verifyBlock = (
        SRC_AUTH_SRC.match(/speakeasy\.totp\.verify\s*\(\s*\{[\s\S]*?\}\s*\)/) || []
      )[0];
      expect(verifyBlock).toBeTruthy();
      expect(verifyBlock).not.toMatch(/window:\s*2[^0-9]/);
      expect(verifyBlock).toMatch(/window:\s*4[^0-9]/);
    });
  });

  describe('source-pin: replay TTL covers the wider verify window', () => {
    it('TOTP_CODE_TTL_MS >= 240_000 (covers the ±120s validity span)', () => {
      expect(_internals.TOTP_CODE_TTL_MS).toBeGreaterThanOrEqual(240_000);
    });
  });
});
