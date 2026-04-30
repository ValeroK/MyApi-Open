/**
 * 2FA challenge rate-limit cap — source pin.
 *
 * The `/api/v1/auth/2fa/challenge` endpoint sits behind a stricter
 * per-IP brute-force gate than the generic `authRateLimit`. Pre-2026-04-29
 * that gate was set to **3 attempts / minute / IP** (BUG-15 in
 * `src/index.js`).  3/min was hostile to legitimate users — a single
 * dashboard double-submit, or two fat-fingered TOTP codes from a
 * 6-digit pad, was enough to lock the user out for ~60 s with no
 * actionable signal beyond "Rate limit exceeded".
 *
 * The brute-force math against a 6-digit TOTP space (1,000,000 codes,
 * speakeasy `window: 2` ≈ 5 codes per submission ≈ 200,000 distinct
 * submissions to exhaust 100% of the keyspace) tolerates a much higher
 * cap with no meaningful reduction in security:
 *   - at 10/min, 50% probability against the keyspace ≈ 14 days
 *   - at  3/min, 50% probability ≈ 47 days
 * The gating control here is the speakeasy code's 30s rotation, not
 * the per-minute cap; even at 60/min an attacker would still need
 * weeks to land on a code by chance, and any repeated 429 from the
 * same IP is itself a tripwire (audit log emits `2fa_failed_attempt`
 * inside the handler before the rate-limiter is hit again).
 *
 * This suite source-pins the cap to a sensible band [10, 30] so a
 * future edit:
 *   - cannot silently drop the cap back below 10 (re-creating the
 *     UX bug) without breaking this gate, and
 *   - cannot silently raise it above 30 (which would weaken the
 *     brute-force ratchet) without breaking this gate either.
 *
 * The `2fa-attempts` namespace string is also pinned so a refactor
 * that moves the limiter into a different keyspace cannot share a
 * bucket with the broader `authRateLimit` (which would re-create the
 * pre-BUG-15 problem).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_JS = path.resolve(__dirname, '..', 'index.js');

describe('2FA challenge rate-limit cap (BUG-15 follow-up, 2026-04-29)', () => {
  let source;
  beforeAll(() => {
    source = fs.readFileSync(INDEX_JS, 'utf8');
  });

  test('twoFactorRateLimit is declared with namespace "2fa-attempts"', () => {
    expect(source).toMatch(
      /const\s+twoFactorRateLimit\s*=\s*rateLimit\(\s*60000\s*,[^,]+,\s*['"]2fa-attempts['"]\s*\)/,
    );
  });

  test('production cap is in band [10, 30] — generous for legit users, tight enough for brute-force', () => {
    const m = source.match(
      /const\s+twoFactorRateLimit\s*=\s*rateLimit\(\s*60000\s*,\s*process\.env\.NODE_ENV\s*===\s*['"]test['"]\s*\?\s*1000\s*:\s*(\d+)\s*,\s*['"]2fa-attempts['"]\s*\)/,
    );
    expect(m).not.toBeNull();
    const productionCap = Number(m[1]);
    expect(Number.isInteger(productionCap)).toBe(true);
    expect(productionCap).toBeGreaterThanOrEqual(10);
    expect(productionCap).toBeLessThanOrEqual(30);
  });

  test('test-mode cap is still 1000 (so other test suites are not throttled)', () => {
    expect(source).toMatch(
      /rateLimit\(\s*60000\s*,\s*process\.env\.NODE_ENV\s*===\s*['"]test['"]\s*\?\s*1000\s*:\s*\d+\s*,\s*['"]2fa-attempts['"]\s*\)/,
    );
  });

  test('twoFactorRateLimit is still wired onto POST /api/v1/auth/2fa/challenge', () => {
    expect(source).toMatch(
      /app\.post\(\s*['"]\/api\/v1\/auth\/2fa\/challenge['"]\s*,\s*twoFactorRateLimit\s*,/,
    );
  });
});
