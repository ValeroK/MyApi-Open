// Cleanup pre-stage / G4.1 — rate-limit contract.
//
// Purpose
// -------
// Pin TWO things ahead of M4 (dual-driver session + rate-limit
// store, ADR-0002):
//
//   1. The IMPLEMENTATION shape of the in-memory rate-limit code
//      that M4 is going to delete — the bespoke `rateLimit()`
//      factory, the `globalRateLimitMap` IP-bucket, the per-
//      namespace `rateLimitMap`, the `rateLimitCleanupInterval`
//      sweeper, the `RATE_LIMIT_EXEMPT_PATHS` list, and every
//      `expressRateLimit({ ... })` configuration. Snapshotting
//      these as TEXT means M4's PR is forced to update the
//      snapshot, which surfaces every site of the deletion in
//      code review. A reviewer who knows nothing about M4 can
//      ratify the PR by reading the snapshot diff alone.
//
//   2. The 429 RESPONSE ENVELOPE the dashboard parses — status
//      code, body shape, `Retry-After` header, and the standard
//      `RateLimit-*` headers express-rate-limit emits. M4 may
//      legitimately swap the in-memory store for a SQLite or
//      Redis-backed store, but the OBSERVABLE behaviour at the
//      HTTP boundary MUST NOT change. We test this by mounting
//      `express-rate-limit` directly on a tiny test app with
//      max=1 — fast, deterministic, no need to hammer the real
//      app.
//
// Why not just hit the real app's bespoke rateLimit() and
// observe its 429?
// -----------------
// Two reasons. (a) In `NODE_ENV=test` the bespoke factory uses
// max=1000, which is slow to drive past. (b) M4 is going to
// DELETE the bespoke factory entirely — it's the wrong contract
// to pin. The contract worth pinning is the one that survives
// M4: `express-rate-limit`'s envelope, which the dashboard's
// retry-banner code already targets. The bespoke factory's
// envelope is just history, captured in the static snapshot.
//
// Updating
// --------
//   npx jest cleanup-pre-stage-rate-limit-contract --updateSnapshot
// IN THE SAME COMMIT as the deliberate change. The static
// snapshot is the audit trail of the M4 deletion; the runtime
// snapshot is the audit trail of any envelope-shape change.
//
// Related
// -------
//   - ADR-0002 (dual-driver session + rate-limit store)
//   - ADR-0019 §"Per-milestone follow-ups"
//   - .context/TASKS.md M4 (T4.5, T4.6, T4.8)
//   - Stage 0 G0.3 (orphan-timer ratchet) — `rateLimitCleanupInterval`
//     is one of the two timers M4 will delete.

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const expressRateLimit = require('express-rate-limit');
const request = require('supertest');

const SERVER_ENTRY = path.resolve(__dirname, '..', 'index.js');

// ─── Static-source helpers ─────────────────────────────────────
//
// We extract three blocks from `src/index.js` by line range. Line
// ranges are stable across normal edits because each block is
// preceded by a `function` / `const` declaration we anchor on.
function indexOfLineMatching(lines, regex) {
  for (let i = 0; i < lines.length; i += 1) {
    if (regex.test(lines[i])) return i;
  }
  return -1;
}

function readBlockBetween(lines, startRegex, endRegex, maxLines = 80) {
  const start = indexOfLineMatching(lines, startRegex);
  if (start === -1) return null;
  for (let i = start + 1; i < Math.min(start + maxLines, lines.length); i += 1) {
    if (endRegex.test(lines[i])) {
      return {
        startLine: start + 1,
        endLine: i + 1,
        body: lines.slice(start, i + 1).join('\n'),
      };
    }
  }
  // No closer found within window — return what we have so the
  // snapshot diff makes the truncation visible.
  return {
    startLine: start + 1,
    endLine: start + maxLines,
    body: lines.slice(start, start + maxLines).join('\n'),
    truncated: true,
  };
}

describe('[Cleanup pre-stage / G4.1] rate-limit contract', () => {
  let source;
  let lines;

  beforeAll(() => {
    source = fs.readFileSync(SERVER_ENTRY, 'utf8');
    lines = source.split('\n');
  });

  // ─── Static implementation snapshots ────────────────────────────

  test('snapshot: RATE_LIMIT_EXEMPT_PATHS list', () => {
    const block = readBlockBetween(
      lines,
      /^const RATE_LIMIT_EXEMPT_PATHS\s*=\s*\[/,
      /^\];/,
      40,
    );
    expect(block).toBeTruthy();
    expect(block.body).toMatchSnapshot('RATE_LIMIT_EXEMPT_PATHS source block');
  });

  test('snapshot: bespoke rateLimit() factory body', () => {
    const block = readBlockBetween(
      lines,
      /^function rateLimit\(/,
      /^\}\s*$/,
      80,
    );
    expect(block).toBeTruthy();
    expect(block.body).toMatchSnapshot('rateLimit() factory source');
  });

  test('snapshot: rateLimitCleanupInterval registration', () => {
    const block = readBlockBetween(
      lines,
      /^const rateLimitCleanupInterval = setInterval/,
      /^}, 60000\);/,
      60,
    );
    expect(block).toBeTruthy();
    expect(block.body).toMatchSnapshot('rateLimitCleanupInterval source');
  });

  test('snapshot: globalRateLimitMap registration & top-level enforcer', () => {
    // The global limiter is composed of:
    //   - `const globalRateLimitMap = {};`
    //   - the `app.use((req, res, next) => { ... global:${req.ip} ... })`
    //     middleware that reads / writes it.
    // We anchor on the comment-or-declaration above the map and
    // walk forward to the matching `});` of the `app.use`. To stay
    // robust against the comment style above the line, we anchor
    // on the literal `globalRateLimitMap = {}` line.
    const startIdx = indexOfLineMatching(lines, /^const globalRateLimitMap\s*=\s*\{\}/);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // The middleware lives within ~30 lines below. Capture them.
    const window = lines.slice(startIdx, startIdx + 30).join('\n');
    expect({ startLine: startIdx + 1, body: window }).toMatchSnapshot(
      'globalRateLimitMap + app.use enforcer',
    );
  });

  test('inventory: every expressRateLimit({ ... }) configuration in src/index.js', () => {
    // We list, in line order, every `= expressRateLimit({` site.
    // M4 may rewrite each into a `createStoreBackedLimiter(...)`
    // call — each rewrite must show in this snapshot.
    const sites = [];
    const re = /=\s*expressRateLimit\s*\(\s*\{/g;
    for (let i = 0; i < lines.length; i += 1) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      // Capture the binding name for context.
      const declMatch =
        /(?:const|let|var)\s+(\w+)\s*=\s*expressRateLimit/.exec(lines[i]) ||
        /(\w+)\s*=\s*expressRateLimit/.exec(lines[i]);
      sites.push({
        line: i + 1,
        binding: declMatch ? declMatch[1] : '<anonymous>',
        // Capture next 8 lines to lock the config object's shape
        // (windowMs, max, standardHeaders, message, skip, etc.)
        // without pinning specific numeric values that may be
        // env-driven.
        configHead: lines
          .slice(i, i + 9)
          .map((l) => l.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 9),
      });
    }
    expect(sites.length).toBeGreaterThan(0);
    expect(sites).toMatchSnapshot('expressRateLimit configurations');
  });

  // ─── Runtime envelope snapshot ──────────────────────────────────

  test('snapshot: 429 response envelope from express-rate-limit (the contract M4 must preserve)', async () => {
    // Build a tiny isolated app with a 1-request limit on /probe.
    // Hit it twice — second hit must 429. This is the envelope
    // shape the dashboard's retry banner is coded against; M4's
    // store rewrite MUST preserve it.
    const probe = express();
    probe.use(
      '/probe',
      expressRateLimit({
        windowMs: 60_000,
        max: 1,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Rate limit exceeded', retryAfterSeconds: 60 },
      }),
      (req, res) => res.status(200).json({ ok: true }),
    );

    const first = await request(probe).get('/probe');
    expect(first.status).toBe(200);

    const second = await request(probe).get('/probe');
    expect(second.status).toBe(429);

    // Build a stable view of the 429 — header presence (NOT the
    // numeric values, which depend on the limiter's clock) and
    // the body shape. We also pin which standard `RateLimit-*`
    // header family is in use ('draft-7' vs 'draft-6' matters
    // for some clients).
    const headers = Object.keys(second.headers).sort();
    const headerPresence = {
      'retry-after': headers.includes('retry-after'),
      'ratelimit-limit': headers.includes('ratelimit-limit'),
      'ratelimit-remaining': headers.includes('ratelimit-remaining'),
      'ratelimit-reset': headers.includes('ratelimit-reset'),
      'x-ratelimit-limit': headers.includes('x-ratelimit-limit'),
      'x-ratelimit-remaining': headers.includes('x-ratelimit-remaining'),
    };

    expect({
      status: second.status,
      bodyShape: {
        keys: Object.keys(second.body || {}).sort(),
        hasError: typeof second.body?.error === 'string',
        errorValue: typeof second.body?.error === 'string' ? second.body.error : null,
        hasRetryAfterSeconds: typeof second.body?.retryAfterSeconds === 'number',
      },
      headerPresence,
    }).toMatchSnapshot('429 envelope');
  });

  test('Retry-After header value is a positive integer (seconds)', async () => {
    // This is a hard assertion (not just snapshot): some legacy
    // dashboard code parses Retry-After as parseInt — anything
    // non-numeric (e.g. an HTTP-date) would silently break the
    // retry banner.
    const probe = express();
    probe.use(
      '/probe',
      expressRateLimit({
        windowMs: 60_000,
        max: 1,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Rate limit exceeded' },
      }),
      (req, res) => res.status(200).json({ ok: true }),
    );

    await request(probe).get('/probe');
    const blocked = await request(probe).get('/probe');
    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    // RFC 7231 allows HTTP-date OR delta-seconds. We pin
    // delta-seconds: the dashboard parses with parseInt.
    const n = parseInt(retryAfter, 10);
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
    expect(String(n)).toBe(String(retryAfter).trim());
  });
});
