/**
 * Cleanup Stage-0 / G0.1 — API surface snapshot.
 *
 * Purpose
 * -------
 * Pin the mounted-route surface of the live Express app so any
 * subsequent cleanup milestone (M4 store swap, M6 monolith
 * extraction, M7 TS migration, M8 dead-code removal) cannot silently
 * delete, rename, re-method, or re-mount a route. This is the most
 * important regression net for the cleanup plan: every stage assumes
 * "the public HTTP surface is byte-stable across the refactor", and
 * this test makes that assumption verifiable.
 *
 * Design
 * ------
 * Two complementary snapshots:
 *
 *   (A) IN-MEMORY SHAPE.
 *       Boot the app via `require('../index')`, walk
 *       `app.router.stack` (Express 5; the deprecated `app._router`
 *       alias is gone), and produce a flat ordered list of layers.
 *       For each top-level layer:
 *         - leaf route       → `${methods}: ${route.path}`
 *         - sub-router       → recurse one level into
 *                               `layer.handle.stack` and emit
 *                               `<router idx=N> ${methods}: ${path}`
 *                               lines for every inner leaf.
 *         - middleware       → `<middleware: ${name||'anonymous'}>`
 *
 *       Express 5 does NOT expose a sub-router's mount prefix at
 *       runtime (the regexp is closure-captured by `layer.matchers`
 *       and the public API has no accessor — verified empirically
 *       on Express 5.2.x). So this view captures *shape* — order,
 *       methods, inner paths — without the mount prefix. Mount
 *       prefixes are pinned separately by snapshot (B).
 *
 *   (B) STATIC MOUNT TABLE.
 *       Lex `src/index.js` and emit:
 *         - every `app.{get|post|put|patch|delete|head|options|all}('/path', ...)`
 *           direct route mount (verb + path)
 *         - every `app.use('/prefix', ...)` mount-point declaration
 *       Sorted alphabetically per kind for stability across
 *       refactors that re-order calls without changing semantics.
 *
 * Together (A) + (B) catch:
 *   - accidental route deletions / renames                (A + B)
 *   - method-only changes (GET → POST)                    (A + B)
 *   - mount-point relocations                              (B)
 *   - sub-router internal route additions / deletions      (A)
 *   - middleware-vs-route layer reordering                 (A)
 *
 * Updating
 * --------
 * The snapshot files are kept under `__snapshots__/`. When a
 * cleanup commit *intentionally* changes the surface (e.g. M6
 * extracts a route into a new module), regenerate with
 * `npx jest cleanup-pre-stage-api-surface-snapshot --updateSnapshot`
 * AS PART OF THAT COMMIT — the diff in the snapshot file is the
 * code-review evidence that the change is deliberate.
 *
 * Why static parse instead of just runtime walking?
 * ------------------------------------------------
 * Runtime walking can't see the mount prefix in Express 5. We could
 * monkey-patch `app.use` before `require('../index')` to capture
 * prefixes, but that adds boot-order coupling that breaks if
 * `index.js` ever changes its `require('express')` chain. Static
 * lexing of the source file is invariant under runtime changes and
 * gives a separate view that catches prefix-only refactors.
 *
 * Related
 * -------
 *   - `.context/decisions/ADR-0004-cleanup-pre-stage-gates.md`
 *   - Cleanup plan §"Stage 0 — Cross-cutting baseline" / G0.1
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ENTRY = path.resolve(__dirname, '..', 'index.js');

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Format the methods on a route layer in stable order. Express stores
 * `route.methods` as `{ get: true, post: true }`; we sort + uppercase
 * so the snapshot is deterministic regardless of insertion order.
 */
function formatMethods(methods) {
  if (!methods || typeof methods !== 'object') return '';
  return Object.keys(methods)
    .filter((k) => methods[k] === true)
    .sort()
    .map((m) => m.toUpperCase())
    .join(',');
}

/**
 * Walk a single Express layer (top-level on `app.router.stack` or
 * inner on a sub-router's `handle.stack`) and emit zero-or-more
 * snapshot lines.
 */
function describeLayer(layer, idx) {
  const out = [];
  if (layer.route) {
    const m = formatMethods(layer.route.methods);
    out.push(`[${idx}] ${m} ${layer.route.path}`);
    return out;
  }
  if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
    out.push(`[${idx}] <router with ${layer.handle.stack.length} layers>`);
    layer.handle.stack.forEach((inner, j) => {
      if (inner.route) {
        const m = formatMethods(inner.route.methods);
        out.push(`  [${idx}.${j}] ${m} ${inner.route.path}`);
      } else {
        out.push(
          `  [${idx}.${j}] <middleware: ${inner.name || 'anonymous'}>`
        );
      }
    });
    return out;
  }
  out.push(`[${idx}] <middleware: ${layer.name || 'anonymous'}>`);
  return out;
}

// Strip ONLY line comments from JS source. We deliberately do NOT
// strip block comments because regex literals in src/index.js
// can contain the same byte sequences that delimit a block comment,
// and a naive non-tokenising stripper greedily-matches across them
// — eating thousands of lines of real code, including real route
// mounts. Empirical reproduction in this repo: a block-comment
// stripper deleted the app.use('/api/v1/skills', ...) mount because
// of a regex literal upstream.
//
// Line comments are safe to strip with a per-line regex because
// they cannot span a newline.
//
// Trade-off: a route mount nested inside a block comment will be
// picked up as a false positive. Acceptable — false positives
// surface as visible snapshot diff lines, while false negatives
// silently let real route deletions slip through.
function stripLineComments(source) {
  return source.replace(/^\s*\/\/.*$/gm, '');
}

const VERB_RE = /\bapp\.(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const USE_RE = /\bapp\.use\s*\(\s*['"`]([^'"`]+)['"`]/g;

/**
 * Lex `src/index.js` for direct route mounts and sub-router mount
 * points. Returns two sorted arrays so re-orderings of equivalent
 * mounts don't churn the snapshot.
 */
function staticMountTable(source) {
  const stripped = stripLineComments(source);
  const direct = new Set();
  const mounts = new Set();
  let m;
  while ((m = VERB_RE.exec(stripped)) !== null) {
    direct.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  while ((m = USE_RE.exec(stripped)) !== null) {
    mounts.add(m[1]);
  }
  return {
    directRoutes: Array.from(direct).sort(),
    mountPoints: Array.from(mounts).sort(),
  };
}

// -------------------------------------------------------------------------
// Suite
// -------------------------------------------------------------------------

describe('[Cleanup Stage 0 / G0.1] API surface snapshot', () => {
  let app;
  let routerStack;

  beforeAll(() => {
    // Lazy require so DB_PATH=:memory: in setup-env.js takes effect.
    const mod = require('../index');
    app = mod.app;
    expect(app).toBeDefined();
    expect(app.router).toBeDefined();
    routerStack = app.router.stack;
  });

  test('app exposes a router stack with layers', () => {
    expect(Array.isArray(routerStack)).toBe(true);
    expect(routerStack.length).toBeGreaterThan(10);
  });

  test('snapshot: in-memory router shape (top-level layers + sub-router routes)', () => {
    const lines = [];
    routerStack.forEach((layer, idx) => {
      for (const line of describeLayer(layer, idx)) {
        lines.push(line);
      }
    });
    // The snapshot file is the source of truth for "what routes /
    // middleware are mounted today, in what order". Any cleanup
    // commit that changes this shape MUST regenerate the snapshot
    // in the same commit.
    expect(lines.join('\n')).toMatchSnapshot('in-memory router shape');
  });

  test('snapshot: static mount table from src/index.js', () => {
    const source = fs.readFileSync(SERVER_ENTRY, 'utf8');
    const { directRoutes, mountPoints } = staticMountTable(source);
    expect(directRoutes.length).toBeGreaterThan(20);
    expect(mountPoints.length).toBeGreaterThan(5);
    expect({ directRoutes, mountPoints }).toMatchSnapshot(
      'static mount table'
    );
  });

  test('every direct app.{verb}() call from src/index.js shows up at runtime', () => {
    // Cross-check the two views against each other: every static
    // direct-route mount must have a corresponding leaf in the
    // runtime stack. Catches the case where someone refactors a
    // route into a function that's defined-but-never-mounted.
    const source = fs.readFileSync(SERVER_ENTRY, 'utf8');
    const { directRoutes } = staticMountTable(source);
    const runtimeRoutes = new Set();
    for (const layer of routerStack) {
      if (layer.route) {
        const m = formatMethods(layer.route.methods);
        for (const verb of m.split(',')) {
          runtimeRoutes.add(`${verb} ${layer.route.path}`);
        }
      }
    }
    const missing = directRoutes.filter((r) => !runtimeRoutes.has(r));
    if (missing.length > 0) {
      throw new Error(
        `These direct app.{verb}() calls in src/index.js are NOT mounted at runtime: ${missing.join(', ')}`
      );
    }
  });
});
