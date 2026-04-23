/**
 * Legacy vault inventory & weak-crypto regression gate.
 *
 * Context
 * -------
 * The repo contains a legacy vault subsystem that uses `crypto-js` without a
 * per-message IV or an authenticated mode. See `.context/plan.md` §3 and
 * ADR-0005. During M2 triage we confirmed the subsystem is ORPHAN in the
 * running server (`src/index.js`): the `Vault` class is only imported by the
 * manual seed script `src/scripts/init-db.js`, `createApiRoutes` is never
 * required, and `createManagementRoutes` is required but never mounted.
 *
 * What this test guards
 * ---------------------
 * 1. Snapshot (current state): document which legacy files still exist so the
 *    next change that deletes them is a clear, intentional diff.
 * 2. Hard regression gate (forever): no module reachable via `require` from
 *    the real server entry `src/index.js` is allowed to load `crypto-js`, the
 *    weak `src/utils/encryption.js` module, or the legacy `src/vault/vault.js`
 *    class. If anyone later wires the weak path back into the server, this
 *    test fails.
 * 3. Dependency gate: the root `package.json` must not declare `crypto-js`,
 *    and `crypto-js` must not be resolvable from the repo root.
 *
 * Deletion flip
 * -------------
 * After the dead modules are removed in M2, flip the two "snapshot" existence
 * assertions from `toBe(true)` to `toBe(false)`. Everything else stays.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const srcDir = path.resolve(__dirname, '..');

const LEGACY_WEAK_CRYPTO = path.join(srcDir, 'utils', 'encryption.js');
const LEGACY_VAULT = path.join(srcDir, 'vault', 'vault.js');
const SERVER_ENTRY = path.join(srcDir, 'index.js');

// Specifiers that indicate the weak-crypto path is being re-introduced.
const FORBIDDEN_BARE = new Set(['crypto-js']);
// Any require() whose resolved absolute path points at one of these files is
// forbidden in the reachable graph from src/index.js.
const FORBIDDEN_ABS_FILES = new Set([
  path.resolve(LEGACY_WEAK_CRYPTO),
  path.resolve(LEGACY_VAULT),
]);

/**
 * Parse static `require('...')` string-literal specifiers out of a JS source
 * file. Dynamic `require(variable)` calls are intentionally ignored.
 */
function extractRequireSpecifiers(source) {
  const specs = [];
  // Matches require('x') and require("x"). Does not match template literals
  // or variables, which is exactly the intent here.
  const re = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    specs.push(m[2]);
  }
  return specs;
}

/**
 * Best-effort resolution of a relative require specifier to an absolute file
 * path, mirroring the small subset of Node's resolver we need (no package
 * exports, no browser field). Returns null if the file can't be resolved
 * deterministically (e.g. bare specifiers, or missing file on disk).
 */
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // bare
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.json`,
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs'),
    path.join(base, 'index.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
  }
  return null;
}

/**
 * BFS over static require() edges, starting from SERVER_ENTRY, restricted to
 * files under src/. Returns:
 *   - visited: Set<absPath> of reachable app files
 *   - bareSpecifiers: Set<string> of node_modules-style deps observed anywhere
 *   - edges: Array<{from, spec, resolved}> for richer error messages
 */
function buildReachableGraph(entry) {
  const visited = new Set();
  const bareSpecifiers = new Set();
  const edges = [];
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    if (!current.startsWith(srcDir)) continue; // stay within src/
    if (!fs.existsSync(current)) continue;
    visited.add(current);
    let source;
    try {
      source = fs.readFileSync(current, 'utf8');
    } catch {
      continue;
    }
    for (const spec of extractRequireSpecifiers(source)) {
      const resolved = resolveRelative(current, spec);
      edges.push({ from: current, spec, resolved });
      if (resolved) {
        if (!visited.has(resolved)) queue.push(resolved);
      } else if (!spec.startsWith('.') && !spec.startsWith('/')) {
        // bare specifier => track its top-level package name
        const top = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0];
        bareSpecifiers.add(top);
      }
    }
  }
  return { visited, bareSpecifiers, edges };
}

describe('Legacy vault / weak-crypto inventory', () => {
  describe('current-state snapshot (flip these when the dead code is deleted)', () => {
    it('legacy weak-crypto module src/utils/encryption.js still exists (snapshot)', () => {
      expect(fs.existsSync(LEGACY_WEAK_CRYPTO)).toBe(true);
    });

    it('legacy Vault class src/vault/vault.js still exists (snapshot)', () => {
      expect(fs.existsSync(LEGACY_VAULT)).toBe(true);
    });
  });

  describe('hard regression gate: the running server must never load weak crypto', () => {
    let graph;
    beforeAll(() => {
      graph = buildReachableGraph(SERVER_ENTRY);
    });

    it('src/index.js is reachable and the graph is non-trivial', () => {
      expect(graph.visited.has(path.resolve(SERVER_ENTRY))).toBe(true);
      // Sanity: the real server pulls in dozens of local modules. If this
      // number collapses, the traversal is probably broken.
      expect(graph.visited.size).toBeGreaterThan(10);
    });

    it('no module reachable from src/index.js requires crypto-js', () => {
      const offenders = graph.edges.filter(
        (e) => e.resolved === null && FORBIDDEN_BARE.has(e.spec),
      );
      const msg = offenders
        .map((e) => `${path.relative(repoRoot, e.from)} -> require('${e.spec}')`)
        .join('\n');
      expect(offenders).toEqual([]);
      // The empty-array assertion above already fails the test on regression;
      // the extra string is there to make the failure message actionable.
      if (offenders.length > 0) throw new Error(`Forbidden require:\n${msg}`);
    });

    it('no module reachable from src/index.js requires the legacy weak Encryption module', () => {
      const offenders = graph.edges.filter(
        (e) => e.resolved && FORBIDDEN_ABS_FILES.has(e.resolved),
      );
      const msg = offenders
        .map(
          (e) =>
            `${path.relative(repoRoot, e.from)} -> require('${e.spec}')  =>  ${path.relative(repoRoot, e.resolved)}`,
        )
        .join('\n');
      expect(offenders).toEqual([]);
      if (offenders.length > 0) throw new Error(`Forbidden require:\n${msg}`);
    });

    it('the legacy vault files are not reachable from src/index.js', () => {
      for (const forbidden of FORBIDDEN_ABS_FILES) {
        expect(graph.visited.has(forbidden)).toBe(false);
      }
    });
  });

  describe('dependency gate', () => {
    it('root package.json does not declare crypto-js', () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
      );
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      expect(deps).not.toContain('crypto-js');
      expect(devDeps).not.toContain('crypto-js');
    });

    it('crypto-js is not resolvable from the repo root', () => {
      // If this ever starts resolving, someone added crypto-js back to the
      // root dependency tree (directly or transitively as a runtime dep),
      // which reintroduces the weak-crypto surface.
      expect(() => {
        // require.resolve throws when the module is not findable.
        require.resolve('crypto-js', { paths: [repoRoot] });
      }).toThrow();
    });
  });

  describe('only sanctioned callers import the legacy modules', () => {
    // Callers that are allowed to reference the legacy modules today. Empty
    // this set once the modules themselves are deleted.
    const SANCTIONED_LEGACY_CALLERS = new Set([
      path.resolve(srcDir, 'scripts', 'init-db.js'), // manual seed script
      path.resolve(srcDir, 'vault', 'vault.js'), // the Vault class itself
    ]);

    function findCallersOf(targetAbs) {
      const callers = [];
      function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'public') continue;
            walk(abs);
            continue;
          }
          if (!entry.isFile()) continue;
          if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
          // Don't let the inventory test itself count as a caller.
          if (abs === path.resolve(__filename)) continue;
          const src = fs.readFileSync(abs, 'utf8');
          for (const spec of extractRequireSpecifiers(src)) {
            const resolved = resolveRelative(abs, spec);
            if (resolved && resolved === targetAbs) {
              callers.push({ from: abs, spec });
            }
          }
        }
      }
      walk(srcDir);
      return callers;
    }

    it('src/utils/encryption.js is only imported by the legacy Vault class', () => {
      const callers = findCallersOf(path.resolve(LEGACY_WEAK_CRYPTO));
      const unexpected = callers.filter(
        (c) => !SANCTIONED_LEGACY_CALLERS.has(path.resolve(c.from)),
      );
      const msg = unexpected
        .map((c) => `${path.relative(repoRoot, c.from)} -> '${c.spec}'`)
        .join('\n');
      expect(unexpected).toEqual([]);
      if (unexpected.length > 0) {
        throw new Error(`Unexpected legacy crypto importer:\n${msg}`);
      }
    });

    it('src/vault/vault.js is only imported by the manual seed script', () => {
      const callers = findCallersOf(path.resolve(LEGACY_VAULT));
      const unexpected = callers.filter(
        (c) => !SANCTIONED_LEGACY_CALLERS.has(path.resolve(c.from)),
      );
      const msg = unexpected
        .map((c) => `${path.relative(repoRoot, c.from)} -> '${c.spec}'`)
        .join('\n');
      expect(unexpected).toEqual([]);
      if (unexpected.length > 0) {
        throw new Error(`Unexpected legacy Vault importer:\n${msg}`);
      }
    });
  });
});
