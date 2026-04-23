'use strict';

/**
 * Textual gate: `src/public/dashboard-app/src/pages/LogIn.jsx` MUST route every
 * post-authentication redirect through the same-origin guard
 * (`isSafeInternalRedirect`).
 *
 * Why textual and not behavioural?  The main Jest config ignores
 * `/src/public/` (see jest.config.js), and the dashboard-app has no standalone
 * test harness.  The *algorithm* of the guard itself is exercised
 * behaviourally in `src/tests/redirect-safety.test.js`.  This gate protects
 * the *wiring* in the JSX so a future edit can't silently re-introduce the
 * open-redirect regression this test was written to plug.
 *
 * Pair: `src/lib/redirect-safety.js` (authoritative CJS) ↔
 *       `src/public/dashboard-app/src/utils/redirectSafety.js` (ESM mirror).
 */

const fs = require('fs');
const path = require('path');

const LOGIN_JSX = path.join(
  __dirname,
  '..',
  'public',
  'dashboard-app',
  'src',
  'pages',
  'LogIn.jsx'
);
const ESM_HELPER = path.join(
  __dirname,
  '..',
  'public',
  'dashboard-app',
  'src',
  'utils',
  'redirectSafety.js'
);
const CJS_HELPER = path.join(__dirname, '..', 'lib', 'redirect-safety.js');

describe('LogIn.jsx :: redirect-safety wiring', () => {
  let source;
  beforeAll(() => {
    source = fs.readFileSync(LOGIN_JSX, 'utf8');
  });

  test('source file is present and non-empty', () => {
    expect(source.length).toBeGreaterThan(1000);
  });

  test('imports isSafeInternalRedirect from the local util', () => {
    expect(source).toMatch(
      /import\s*\{\s*isSafeInternalRedirect\s*\}\s*from\s*['"]\.\.\/utils\/redirectSafety['"]\s*;?/
    );
  });

  test('calls isSafeInternalRedirect at least once (inside redirectAfterLogin sink)', () => {
    const callCount = (source.match(/isSafeInternalRedirect\s*\(/g) || []).length;
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  test('declares a central redirectAfterLogin sink', () => {
    expect(source).toMatch(
      /function\s+redirectAfterLogin\s*\(([^)]*)\)\s*\{/
    );
  });

  test('does NOT assign user-controlled values directly to window.location.href', () => {
    // The attack surface is: any unguarded `window.location.href = X` where X
    // is derived from `pending`, `pendingReturnTo`, `returnTo`, or the raw
    // storage key.  All such sinks were folded into redirectAfterLogin().
    // Guard: no assignment of the symbolic names `pending`, `pendingReturnTo`,
    // `serverReturnTo`, or `clientReturnTo` to `window.location.href`.
    const bannedPatterns = [
      /window\.location\.href\s*=\s*pending\b/,
      /window\.location\.href\s*=\s*pendingReturnTo\b/,
      /window\.location\.href\s*=\s*serverReturnTo\b/,
      /window\.location\.href\s*=\s*clientReturnTo\b/,
    ];
    for (const re of bannedPatterns) {
      expect(source).not.toMatch(re);
    }
  });

  test('every remaining window.location.href assignment is either guarded or a hardcoded same-origin path', () => {
    // Scan all `window.location.href = ...` right-hand sides and require each
    // to be either (a) the `target` local from redirectAfterLogin (which is
    // gated by isSafeInternalRedirect on the line immediately prior), or
    // (b) a string/template literal whose first meaningful character is a
    // forward-slash ("/dashboard/...", "/api/v1/...", "/?beta=full...").
    const lines = source.split(/\r?\n/);
    const offenders = [];
    lines.forEach((line, idx) => {
      const m = line.match(/window\.location\.href\s*=\s*(.+?);?\s*$/);
      if (!m) return;
      const rhs = m[1].trim();
      if (rhs === 'target') {
        // must be preceded (within 2 lines) by an isSafeInternalRedirect call
        const ctx = lines.slice(Math.max(0, idx - 3), idx).join('\n');
        if (!/isSafeInternalRedirect\s*\(/.test(ctx)) {
          offenders.push(`line ${idx + 1}: "${line.trim()}" (target without nearby guard)`);
        }
        return;
      }
      // hardcoded same-origin: RHS must begin with a quote/backtick whose
      // first literal character is a single forward slash (NOT "//", NOT
      // "/\" — both would escape to cross-origin).
      const firstTwo = rhs.slice(0, 2);
      const firstThree = rhs.slice(0, 3);
      const startsWithSlashLiteral =
        (firstTwo === "'/" || firstTwo === '"/' || firstTwo === '`/');
      const escapesToCrossOrigin =
        firstThree === "'//" || firstThree === '"//' || firstThree === '`//' ||
        firstThree === "'/\\" || firstThree === '"/\\' || firstThree === '`/\\';
      if (!startsWithSlashLiteral || escapesToCrossOrigin) {
        offenders.push(`line ${idx + 1}: "${line.trim()}" (unrecognised redirect shape)`);
      }
    });
    expect(offenders).toEqual([]);
  });
});

describe('redirect-safety :: source parity between CJS and ESM mirrors', () => {
  // The algorithm is tiny.  We assert that the four defensive checks appear in
  // both files and in the same order; this stops a future edit to one copy
  // from silently drifting from the other.
  const CHECKS = [
    /typeof\s+target\s*!==\s*['"]string['"]\s*\|\|\s*target\.length\s*===\s*0/,
    /target\[0\]\s*!==\s*['"]\/['"]/,
    /target\[1\]\s*===\s*['"]\/['"]\s*\|\|\s*target\[1\]\s*===\s*['"]\\\\['"]/,
    /\/\[\\u0000-\\u001f\\u007f\]\/\.test\(target\)/,
  ];

  test('authoritative CJS copy contains all four checks in order', () => {
    const src = fs.readFileSync(CJS_HELPER, 'utf8');
    let cursor = 0;
    for (const re of CHECKS) {
      const m = src.slice(cursor).match(re);
      expect(m).not.toBeNull();
      cursor += m.index + m[0].length;
    }
  });

  test('frontend ESM mirror contains all four checks in order', () => {
    const src = fs.readFileSync(ESM_HELPER, 'utf8');
    let cursor = 0;
    for (const re of CHECKS) {
      const m = src.slice(cursor).match(re);
      expect(m).not.toBeNull();
      cursor += m.index + m[0].length;
    }
  });

  test('ESM mirror exports isSafeInternalRedirect', () => {
    const src = fs.readFileSync(ESM_HELPER, 'utf8');
    expect(src).toMatch(/export\s+function\s+isSafeInternalRedirect\s*\(/);
  });

  test('CJS copy exports isSafeInternalRedirect on module.exports', () => {
    const src = fs.readFileSync(CJS_HELPER, 'utf8');
    expect(src).toMatch(/module\.exports\s*=\s*\{\s*isSafeInternalRedirect\s*\}/);
  });
});
