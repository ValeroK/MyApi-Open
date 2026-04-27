// Cleanup pre-stage / G4.3 — trust-proxy contract.
//
// Purpose
// -------
// Pin the baseline behavior of `app.set('trust proxy', 1)` ahead of
// M4-T4.8 (env-driven TRUSTED_PROXIES + secure-by-default loopback,
// closes H5 from plan.md §6.3). Three things must be locked before
// the implementation lands so the M4-T4.8 PR diff is the audit trail
// of what changed and why:
//
//   1. The exact source-line region in `src/index.js` where the
//      `trust proxy` setting lives today. Snapshotting this as TEXT
//      means M4-T4.8's PR is forced to update the snapshot, which
//      surfaces every line of the change in code review.
//
//   2. Today's codebase has NO `TRUSTED_PROXIES` env reference and
//      NO `parseTrustedProxies` helper. These are negative ratchets
//      that flip to positive in the same commit that lands T4.8 —
//      a reviewer can grep the snapshot diff and confirm the new
//      symbols appear in the right places.
//
//   3. Today's spoofability: with `trust proxy: 1`, an `X-Forwarded-
//      For` header from a non-loopback connection is HONORED — i.e.
//      `req.ip` ends up as the spoofed value. We pin this with a
//      tiny test app (NOT the full `src/index.js`) so the test is
//      fast and unaffected by other src/index.js changes. Post-T4.8
//      the same spoof against a `trust proxy: ['loopback']` app
//      will be IGNORED.
//
// Why a separate gate from G0.4 (middleware-chain snapshot)?
// ---------------------------------------------------------
// G0.4 already pins `'trust proxy': 1` as one of four app-level
// settings, but its scope is the WHOLE middleware chain — its diff
// surface is large and an M4-T4.8 reviewer cannot tell from the G0.4
// diff alone WHY trust-proxy changed. G4.3 is the dedicated gate
// that scopes the change to this single setting + provides the
// behavioral assertion (spoofability probe) that G0.4 deliberately
// avoids.
//
// Updating
// --------
//   npx jest cleanup-pre-stage-trust-proxy-contract --updateSnapshot
// IN THE SAME COMMIT as the deliberate change.
//
// Related
// -------
//   - plan.md §6.3 H5 (req.ip spoofability)
//   - .context/TASKS.md M4 T4.8
//   - ADR-0019 §"Per-milestone follow-ups"
//   - Stage 0 G0.4 (middleware-chain snapshot — pins the *value*
//     of `trust proxy`, this gate pins the *implementation* of how
//     that value is computed and the *behavior* it produces)

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const SERVER_ENTRY = path.resolve(__dirname, '..', 'index.js');

function readSource() {
  return fs.readFileSync(SERVER_ENTRY, 'utf8');
}

// Strip JS comments so the negative-ratchet assertions below ignore
// any explanatory comments that mention the future symbols.
function stripComments(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('[Cleanup Stage / G4.3] trust-proxy contract', () => {
  test('snapshot: app.set(\'trust proxy\', …) source-line region', () => {
    const lines = readSource().split('\n');
    const idx = lines.findIndex((line) => /app\.set\(['"]trust proxy['"]/.test(line));
    expect(idx).toBeGreaterThan(-1);

    // Capture 2 lines before + the line itself + 1 line after for context.
    const start = Math.max(0, idx - 2);
    const end = Math.min(lines.length, idx + 2);
    const region = lines.slice(start, end).join('\n');
    expect(region).toMatchSnapshot('trust-proxy source-line region');
  });

  test('today: src/index.js does NOT reference TRUSTED_PROXIES env var (flips post-T4.8)', () => {
    const code = stripComments(readSource());
    expect(code).not.toMatch(/\bTRUSTED_PROXIES\b/);
  });

  test('today: src/index.js does NOT import parseTrustedProxies (flips post-T4.8)', () => {
    const code = stripComments(readSource());
    expect(code).not.toMatch(/\bparseTrustedProxies\b/);
  });

  test('today: src/lib/trust-proxy.js does NOT exist (flips post-T4.8)', () => {
    const helperPath = path.resolve(__dirname, '..', 'lib', 'trust-proxy.js');
    expect(fs.existsSync(helperPath)).toBe(false);
  });

  // ─── Behavioral probe ──────────────────────────────────────────
  //
  // Build a minimal Express app that mirrors today's setting
  // (`trust proxy: 1`), bounce a request through it with a spoofed
  // X-Forwarded-For, and capture `req.ip`. This is decoupled from
  // src/index.js so the assertion stays valid regardless of M6
  // monolith extraction.
  test('today: trust proxy = 1 honors a single-hop X-Forwarded-For (spoofable from any client)', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/probe', (req, res) => {
      res.json({ ip: req.ip, ips: req.ips });
    });

    const res = await request(app)
      .get('/probe')
      .set('X-Forwarded-For', '203.0.113.42'); // RFC 5737 documentation IP

    expect(res.status).toBe(200);
    // With trust=1, Express trusts the LAST hop in X-Forwarded-For
    // and exposes it as req.ip. This is the H5 risk: the supertest
    // connection is from loopback, but the test app trusts the
    // header anyway because trust=1 means "trust the immediate
    // connection's claim about who's behind it".
    expect(res.body.ip).toBe('203.0.113.42');
  });

  test('today: an app with trust proxy = false IGNORES X-Forwarded-For (control case)', async () => {
    // Sanity-check the spoofability probe by inverting it: with
    // trust=false, Express must NOT honor X-Forwarded-For. If this
    // ever passes with the spoofed value, the probe above is
    // measuring the wrong thing.
    const app = express();
    app.set('trust proxy', false);
    app.get('/probe', (req, res) => {
      res.json({ ip: req.ip });
    });

    const res = await request(app)
      .get('/probe')
      .set('X-Forwarded-For', '203.0.113.42');

    expect(res.status).toBe(200);
    expect(res.body.ip).not.toBe('203.0.113.42');
    // supertest connects via loopback, so req.ip should be a loopback
    // address. We don't assert the exact form (`::ffff:127.0.0.1` vs
    // `127.0.0.1` vs `::1`) because it depends on the platform's
    // dual-stack settings.
    expect(res.body.ip).toMatch(/127\.0\.0\.1$|::1$/);
  });
});
