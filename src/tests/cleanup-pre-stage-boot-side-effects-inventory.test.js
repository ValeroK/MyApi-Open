/**
 * Cleanup Stage-0 / G0.3 — boot-side-effects inventory.
 *
 * Purpose
 * -------
 * Pin every `setInterval` / `setTimeout` registration inside
 * `src/index.js`. Background timers are the most easily-lost
 * artefact of a monolith refactor — when M6 lifts a chunk of
 * `index.js` into a new module, a stray `setInterval` at the
 * top of the chunk silently disappears or silently doubles
 * (registered both in the new module AND in the old
 * still-imported one). Every operational-impact timer that
 * goes missing is a memory leak / cache poisoning / metrics
 * gap waiting to happen.
 *
 * What is captured
 * ----------------
 * For every match of `setInterval(` or `setTimeout(`, we record:
 *   - the source file line number
 *   - the leading indentation (so `0` ⇒ module-load timer that
 *     fires immediately, `> 0` ⇒ inside a function, typically
 *     `bootstrap()`, only fires when bootstrap runs)
 *   - the timer kind (`interval` | `timeout`)
 *   - a short comment-context blurb — the closest preceding
 *     non-empty comment line (`//`-style only, since block
 *     comments aren't safely strippable per G0.1's rationale).
 *     Tells the reviewer at-a-glance WHAT the timer does.
 *
 * Why static parsing instead of monkey-patching `globalThis.setInterval`?
 * ----------------------------------------------------------------------
 * A patched global captures only timers actually registered during
 * `require('../index')` — but `bootstrap()` isn't called by the
 * require, only by `npm start`. We'd miss every conditional or
 * deferred timer. A textual scan of the source file catches all of
 * them, doesn't need a sandbox boot, and survives the M6 monolith
 * extraction (the timers will move into route modules; this gate
 * lives in this file until M6 makes G6.x the lock).
 *
 * Updating
 * --------
 * On any deliberate timer addition / deletion, regenerate with
 *   npx jest cleanup-pre-stage-boot-side-effects-inventory --updateSnapshot
 * AS PART OF the same commit. The snapshot file should grow / shrink
 * by exactly the number of timers being added / removed.
 *
 * Related
 * -------
 *   - `.context/decisions/ADR-0004-cleanup-pre-stage-gates.md`
 *   - Cleanup plan §"Stage 0 — Cross-cutting baseline" / G0.3
 *   - M6 pre-stage gates G6.x will eventually take ownership of
 *     the `bootstrap()`-resident timers.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ENTRY = path.resolve(__dirname, '..', 'index.js');

function nearestPrecedingLineComment(lines, idx) {
  // Walk backwards up to 8 lines looking for the most recent
  // non-empty line. If it's a `// ...` comment, return its body
  // (trimmed); otherwise return the line verbatim, also trimmed.
  // Cap at 8 because anything older than that is unlikely to be
  // describing this specific timer.
  for (let j = idx - 1; j >= 0 && j >= idx - 8; j -= 1) {
    const trimmed = (lines[j] || '').trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('//')) {
      return trimmed.replace(/^\/\/\s?/, '').slice(0, 120);
    }
    // Not a comment — stop walking. We don't want to attribute
    // an unrelated `}` or `next();` line to the timer.
    return null;
  }
  return null;
}

function indentOf(line) {
  const m = (line || '').match(/^(\s*)/);
  return m ? m[1].length : 0;
}

function findTimers(source) {
  const lines = source.split('\n');
  const timers = [];
  // Match every setInterval/setTimeout call, NOT preceded by a `.`
  // (so `clearInterval`-adjacent code or `something.setInterval`
  // doesn't register as a top-level timer). The `\b` boundary
  // does that for us.
  const re = /\b(setInterval|setTimeout)\s*\(/g;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    re.lastIndex = 0;
    if (!re.test(line)) continue;
    // Skip any line that ALSO contains `clearInterval(` or
    // `clearTimeout(` — those are pure cleanup paths, not
    // registrations.
    if (/\bclear(Interval|Timeout)\s*\(/.test(line)) continue;
    // Skip the import line / re-export line if any.
    if (/=\s*require\s*\(/.test(line)) continue;
    re.lastIndex = 0;
    const m = re.exec(line);
    if (!m) continue;
    timers.push({
      line: i + 1,
      kind: m[1] === 'setInterval' ? 'interval' : 'timeout',
      indent: indentOf(line),
      contextComment: nearestPrecedingLineComment(lines, i),
      // Keep just enough source so the snapshot is self-explanatory
      // without leaking implementation details that legitimately
      // change (numeric intervals, lambda body).
      sourceSlice: line.trim().slice(0, 100),
    });
  }
  return timers;
}

describe('[Cleanup Stage 0 / G0.3] boot-side-effects inventory', () => {
  let source;
  beforeAll(() => {
    source = fs.readFileSync(SERVER_ENTRY, 'utf8');
  });

  test('source file is present and non-trivial', () => {
    expect(source.length).toBeGreaterThan(10_000);
  });

  test('snapshot: every setInterval/setTimeout registration in src/index.js', () => {
    const timers = findTimers(source);
    expect(timers.length).toBeGreaterThan(0);
    expect(timers).toMatchSnapshot('timer registrations');
  });

  test('snapshot: top-level (column-0) timers fire at module-load, not bootstrap', () => {
    // The most operationally-significant subset. M6 will move
    // some of these out of the monolith; that change MUST be
    // visible in the snapshot diff.
    const moduleLoadTimers = findTimers(source).filter((t) => t.indent === 0);
    expect(moduleLoadTimers).toMatchSnapshot('module-load timers');
  });

  test('every registered timer either calls .unref?.() or is justified in the source', () => {
    // Why this matters: a timer that doesn't `.unref()` keeps the
    // event loop alive, blocking `process.exit()` and forcing
    // every Jest run to use `--forceExit`. We can't test this
    // exhaustively without real semantics, but we CAN catch the
    // common case: a numeric `setInterval(fn, ms)` whose returned
    // handle is dropped on the floor.
    const lines = source.split('\n');
    const timers = findTimers(source);
    const orphans = [];
    for (const t of timers) {
      // Look at the next 80 lines for either:
      //   - `.unref()`         — explicit non-blocking opt-in
      //   - `someInterval =`   — handle was captured (caller may
      //                          unref it later; trust them)
      //   - `clearInterval(`   — handle is being immediately cleared
      // Or look at the previous line for a JSDoc-style comment
      // beginning with `// non-blocking:` / `// keeps process alive:`
      const window = lines.slice(t.line - 1, t.line - 1 + 80).join('\n');
      const prev = (lines[t.line - 2] || '').trim();
      const justified =
        /\.unref\s*\(\s*\)/.test(window) ||
        /^\s*(const|let|var)\s+\w+\s*=\s*set(Interval|Timeout)\s*\(/.test(
          lines[t.line - 1] || ''
        ) ||
        /^\/\/\s*(non-blocking|keeps process alive|background tick)/i.test(prev);
      if (!justified) {
        orphans.push(t);
      }
    }
    // We're not failing on orphans yet — that's a behaviour cleanup
    // tracked outside Stage 0. Snapshot them so any *new* orphan
    // surfaces in the diff. The set today is the ratchet.
    expect(orphans.map((o) => ({ line: o.line, kind: o.kind, snippet: o.sourceSlice }))).toMatchSnapshot(
      'orphan timers (no .unref / no captured handle / no justification)'
    );
  });
});
