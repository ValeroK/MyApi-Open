// Cleanup pre-stage / G4.3 — trust-proxy contract.
//
// Purpose
// -------
// Pin the trust-proxy semantics across the M4-T4.8 boundary
// (env-driven TRUSTED_PROXIES + secure-by-default loopback, closes
// H5 from plan.md §6.3). After T4.8 this gate locks four things:
//
//   1. The exact source-line region in `src/index.js` where the
//      `trust proxy` setting lives. Snapshotting this as TEXT means
//      any future change to the wiring is forced to update the
//      snapshot, surfacing the change in code review.
//
//   2. POSITIVE assertions that the new symbols are present:
//      `TRUSTED_PROXIES` referenced, `parseTrustedProxies` imported,
//      `src/lib/trust-proxy.js` exists. These were negative ratchets
//      pre-T4.8 and flipped in the same commit that landed T4.8.
//
//   3. Unit-level coverage of `parseTrustedProxies(envValue)` —
//      every documented input shape (default, empty, escape hatch,
//      symbolic names, IPv4/IPv6, CIDR, mixed list, whitespace) +
//      every fail-loud case (bogus name, octet overflow, prefix
//      overflow, partially-bad list).
//
//   4. Behavioral assertions on the resulting Express
//      `trust proxy` setting:
//        (a) Pre-T4.8 axiom: `trust=1` honors single-hop XFF (the
//            H5 risk we just closed — kept as a regression anchor).
//        (b) Pre-T4.8 control: `trust=false` ignores XFF.
//        (c) Post-T4.8 default: `trust = parseTrustedProxies(undefined)`
//            yields `['loopback']`, and the resulting Express trust
//            function says YES to loopback addresses + NO to
//            arbitrary public IPs (the H5 closure).
//
// Why a separate gate from G0.4 (middleware-chain snapshot)?
// ---------------------------------------------------------
// G0.4 pins `'trust proxy'` as one of four app-level settings, but
// its scope is the WHOLE middleware chain — its diff surface is
// large and a reviewer cannot tell from the G0.4 diff alone WHY
// trust-proxy changed. G4.3 scopes the change to this single
// setting + the helper that drives it + the behavior it produces.
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
const HELPER_PATH = path.resolve(__dirname, '..', 'lib', 'trust-proxy.js');

const { parseTrustedProxies, isValidEntry } = require('../lib/trust-proxy');

function readSource() {
  return fs.readFileSync(SERVER_ENTRY, 'utf8');
}

// Strip JS comments so the symbol-presence assertions below
// don't false-positive on explanatory prose that mentions the
// names. (For positive assertions the stripping is unnecessary,
// but we keep it so the test reads consistently across the
// pre-T4.8 negative form and post-T4.8 positive form.)
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

  test('post-T4.8: src/index.js references TRUSTED_PROXIES env var', () => {
    const code = stripComments(readSource());
    expect(code).toMatch(/\bTRUSTED_PROXIES\b/);
  });

  test('post-T4.8: src/index.js imports parseTrustedProxies from ./lib/trust-proxy', () => {
    const code = stripComments(readSource());
    expect(code).toMatch(/\bparseTrustedProxies\b/);
    expect(code).toMatch(/require\(['"]\.\/lib\/trust-proxy['"]\)/);
  });

  test('post-T4.8: src/lib/trust-proxy.js exists and exports parseTrustedProxies', () => {
    expect(fs.existsSync(HELPER_PATH)).toBe(true);
    const mod = require('../lib/trust-proxy');
    expect(typeof mod.parseTrustedProxies).toBe('function');
  });

  // ─── parseTrustedProxies unit tests ────────────────────────────
  describe('parseTrustedProxies(envValue)', () => {
    test.each([
      ['undefined  →  default loopback', undefined, ['loopback']],
      ['null       →  default loopback', null, ['loopback']],
      ['empty str  →  default loopback', '', ['loopback']],
      ['whitespace →  default loopback', '   ', ['loopback']],
      ['"none"     →  false (paranoid)', 'none', false],
      ['"false"    →  false (paranoid)', 'false', false],
      ['symbolic loopback', 'loopback', ['loopback']],
      ['symbolic linklocal', 'linklocal', ['linklocal']],
      ['symbolic uniquelocal', 'uniquelocal', ['uniquelocal']],
      ['symbolic list', 'loopback,uniquelocal', ['loopback', 'uniquelocal']],
      ['ipv4 bare', '127.0.0.1', ['127.0.0.1']],
      ['ipv4 cidr', '10.0.0.0/8', ['10.0.0.0/8']],
      ['ipv4 mix', '127.0.0.1,10.0.0.0/8', ['127.0.0.1', '10.0.0.0/8']],
      ['ipv6 bare', '::1', ['::1']],
      ['ipv6 cidr', '2001:db8::/32', ['2001:db8::/32']],
      ['mixed v4+v6+symbolic', 'loopback,10.0.0.0/8,::1', ['loopback', '10.0.0.0/8', '::1']],
      ['trims surrounding whitespace', '  loopback , uniquelocal ', ['loopback', 'uniquelocal']],
      ['drops empty entries', 'loopback,,uniquelocal,', ['loopback', 'uniquelocal']],
    ])('parses: %s', (_label, input, expected) => {
      expect(parseTrustedProxies(input)).toEqual(expected);
    });

    test.each([
      ['unknown symbolic', 'wikipedia'],
      ['ipv4 octet > 255', '999.0.0.1'],
      ['ipv4 too few octets', '10.0.0'],
      ['ipv4 prefix > 32', '10.0.0.0/33'],
      ['ipv6 prefix > 128', '2001:db8::/129'],
      ['cidr without addr', '/8'],
      ['mixed bad with good (any-bad fails the whole list)', 'loopback,wikipedia'],
      ['negative prefix', '10.0.0.0/-1'],
      ['non-numeric prefix', '10.0.0.0/abc'],
    ])('throws for invalid: %s', (_label, input) => {
      expect(() => parseTrustedProxies(input)).toThrow(/Invalid TRUSTED_PROXIES/);
    });

    test('throw message echoes the input verbatim and the bad entries', () => {
      try {
        parseTrustedProxies('loopback,wikipedia,999.0.0.1');
      } catch (err) {
        expect(err.message).toContain('"wikipedia"');
        expect(err.message).toContain('"999.0.0.1"');
        expect(err.message).toContain('loopback,wikipedia,999.0.0.1');
        return;
      }
      throw new Error('expected parseTrustedProxies to throw');
    });

    test('isValidEntry: spot-check the predicate directly', () => {
      expect(isValidEntry('loopback')).toBe(true);
      expect(isValidEntry('127.0.0.1')).toBe(true);
      expect(isValidEntry('10.0.0.0/8')).toBe(true);
      expect(isValidEntry('::1')).toBe(true);
      expect(isValidEntry('2001:db8::/32')).toBe(true);
      expect(isValidEntry('wikipedia')).toBe(false);
      expect(isValidEntry('999.0.0.1')).toBe(false);
      expect(isValidEntry('10.0.0.0/33')).toBe(false);
      expect(isValidEntry(undefined)).toBe(false);
      expect(isValidEntry(null)).toBe(false);
      expect(isValidEntry(123)).toBe(false);
    });
  });

  // ─── Behavioral probe (pre-T4.8 axioms preserved) ──────────────
  //
  // These two cases are FACTS-OF-EXPRESS, not properties of our
  // code — they're kept so the diff between trust=1 and the new
  // default is auditable from the test file alone. If you change
  // these, you've changed Express, not us, and that needs its own
  // discussion.
  test('axiom: a tiny app with trust proxy = 1 honors single-hop X-Forwarded-For (the H5 risk we closed)', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/probe', (req, res) => {
      res.json({ ip: req.ip, ips: req.ips });
    });

    const res = await request(app)
      .get('/probe')
      .set('X-Forwarded-For', '203.0.113.42'); // RFC 5737 documentation IP

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('203.0.113.42');
  });

  test('axiom: a tiny app with trust proxy = false IGNORES X-Forwarded-For (control case)', async () => {
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
    expect(res.body.ip).toMatch(/127\.0\.0\.1$|::1$/);
  });

  // ─── Post-T4.8 integration ─────────────────────────────────────
  //
  // Probe the Express `trust proxy fn` directly — that's the
  // compiled function proxy-addr produces from whatever you passed
  // to `app.set('trust proxy', …)`. Calling it with various IPs
  // tells us EXACTLY which sources Express considers a trusted
  // proxy. This is the cleanest way to assert the H5 closure
  // without spinning up a non-loopback supertest connection
  // (which is a hard problem on most CI runners).
  describe('integration: app.set(trust proxy, parseTrustedProxies(...)) compiled trust function', () => {
    function buildApp(envValue) {
      const app = express();
      app.set('trust proxy', parseTrustedProxies(envValue));
      return app;
    }

    test('default (unset) trusts ONLY loopback addresses', () => {
      const app = buildApp(undefined);
      const trust = app.get('trust proxy fn');
      expect(typeof trust).toBe('function');

      expect(trust('127.0.0.1', 0)).toBe(true);
      expect(trust('::1', 0)).toBe(true);

      // The H5 closure: arbitrary public IPs are NOT trusted.
      expect(trust('203.0.113.42', 0)).toBe(false);
      expect(trust('8.8.8.8', 0)).toBe(false);
      expect(trust('10.0.0.1', 0)).toBe(false); // RFC 1918, but NOT in default list
      expect(trust('192.168.1.1', 0)).toBe(false);
      expect(trust('172.17.0.1', 0)).toBe(false); // common docker bridge
    });

    test('TRUSTED_PROXIES=uniquelocal trusts RFC 1918 + ULA + loopback (combined with default? no — replaces)', () => {
      // `uniquelocal` alone does NOT include loopback. Operators
      // who want both must say so explicitly. This locks the
      // intended semantics: each entry is independently considered.
      const app = buildApp('uniquelocal');
      const trust = app.get('trust proxy fn');

      expect(trust('10.0.0.1', 0)).toBe(true);
      expect(trust('172.17.0.1', 0)).toBe(true);
      expect(trust('192.168.1.1', 0)).toBe(true);

      expect(trust('203.0.113.42', 0)).toBe(false);
      expect(trust('127.0.0.1', 0)).toBe(false); // explicitly NOT covered
    });

    test('TRUSTED_PROXIES=loopback,uniquelocal trusts both (composition is union)', () => {
      const app = buildApp('loopback,uniquelocal');
      const trust = app.get('trust proxy fn');

      expect(trust('127.0.0.1', 0)).toBe(true);
      expect(trust('::1', 0)).toBe(true);
      expect(trust('10.0.0.1', 0)).toBe(true);
      expect(trust('172.17.0.1', 0)).toBe(true);

      expect(trust('203.0.113.42', 0)).toBe(false);
    });

    test('TRUSTED_PROXIES=10.0.0.0/8 trusts that exact CIDR only', () => {
      const app = buildApp('10.0.0.0/8');
      const trust = app.get('trust proxy fn');

      expect(trust('10.0.0.1', 0)).toBe(true);
      expect(trust('10.255.255.254', 0)).toBe(true);

      expect(trust('11.0.0.1', 0)).toBe(false);
      expect(trust('127.0.0.1', 0)).toBe(false); // loopback NOT auto-included
    });

    test('TRUSTED_PROXIES=none trusts NOBODY (paranoid mode)', () => {
      const app = buildApp('none');
      const trust = app.get('trust proxy fn');

      expect(trust('127.0.0.1', 0)).toBe(false);
      expect(trust('::1', 0)).toBe(false);
      expect(trust('10.0.0.1', 0)).toBe(false);
      expect(trust('203.0.113.42', 0)).toBe(false);
    });

    // End-to-end: the helper output drives Express, Express drives
    // req.ip, req.ip drives ratelimit + audit. With default
    // ['loopback'] and a supertest connection (which IS from
    // loopback), an X-Forwarded-For IS honored — that's by design;
    // the fix is closing spoofs from PUBLIC clients, not from the
    // host itself.
    test('default + supertest (loopback connection): X-Forwarded-For IS honored — by design', async () => {
      const app = buildApp(undefined);
      app.get('/probe', (req, res) => res.json({ ip: req.ip }));

      const res = await request(app)
        .get('/probe')
        .set('X-Forwarded-For', '203.0.113.42');

      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('203.0.113.42');
    });
  });
});
