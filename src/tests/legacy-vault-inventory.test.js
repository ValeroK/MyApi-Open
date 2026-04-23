/**
 * Weak-crypto regression gate (post-deletion).
 *
 * Context
 * -------
 * The repo used to contain a legacy vault subsystem that used `crypto-js`
 * without a per-message IV or an authenticated mode. See ADR-0005 and
 * ADR-0013. In M2 Step 2 the entire orphan subsystem was deleted:
 *
 *   - src/utils/encryption.js   (weak `Encryption` class)
 *   - src/vault/vault.js        (sole consumer of the weak module)
 *   - src/routes/api.js         (orphan; never mounted)
 *   - src/routes/management.js  (orphan; required but never mounted)
 *   - src/brain/brain.js        (orphan; never required)
 *   - src/gateway/tokens.js     (orphan TokenManager; wrote to a dead table)
 *
 * `src/scripts/init-db.js` was rewritten to target the live `access_tokens`
 * table via `src/database.js` / `createAccessToken`.
 *
 * What this test guards
 * ---------------------
 * 1. Existence gate: the deleted files must NOT come back. If anyone ever
 *    re-creates `src/utils/encryption.js` or `src/vault/vault.js`, this
 *    test fails.
 * 2. Reachability gate: no module reachable via static `require()` from the
 *    real server entry `src/index.js` is allowed to load `crypto-js`, a
 *    weak `Encryption` module at `src/utils/encryption.js`, or a legacy
 *    `Vault` class at `src/vault/vault.js`.
 * 3. Dependency gate: the root `package.json` must not declare `crypto-js`,
 *    and `crypto-js` must not be resolvable from the repo root.
 * 4. Textual gate: no source file anywhere under `src/` is permitted to
 *    contain a `require('crypto-js')` / `require('.../utils/encryption')` /
 *    `require('.../vault/vault')` literal, even if the target does not
 *    currently exist on disk.
 *
 * Covers ADR-0013.
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
// Relative specifiers are matched on their textual suffix so that the check
// works even when the target file doesn't exist on disk (post-deletion).
const FORBIDDEN_PATH_SUFFIXES = [
  'utils/encryption',
  'vault/vault',
];

/**
 * Parse static `require('...')` string-literal specifiers out of a JS source
 * file. Dynamic `require(variable)` calls are intentionally ignored.
 */
function extractRequireSpecifiers(source) {
  const specs = [];
  const re = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    specs.push(m[2]);
  }
  return specs;
}

/**
 * Best-effort resolution of a relative require specifier to an absolute file
 * path, mirroring the small subset of Node's resolver we need. Returns null
 * if the file can't be resolved deterministically.
 */
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
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
 * Normalize a relative require spec to a canonical "dir/name" suffix so we
 * can match it against FORBIDDEN_PATH_SUFFIXES regardless of how many '../'
 * segments the caller used.
 */
function suffixOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    // Trim leading ./ and ../ groups.
    return spec.replace(/^(\.\.\/|\.\/)+/, '').replace(/\.(js|cjs|mjs|json)$/, '');
  }
  return null;
}

/**
 * BFS over static require() edges, starting from SERVER_ENTRY, restricted to
 * files under src/.
 */
function buildReachableGraph(entry) {
  const visited = new Set();
  const edges = [];
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    if (!current.startsWith(srcDir)) continue;
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
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return { visited, edges };
}

/**
 * Walk src/ and collect all JS/CJS/MJS files except those under the
 * frontend's node_modules / build outputs and the public dashboard source
 * (which has its own bundler and its own review surface).
 */
function walkSrcJsFiles() {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        if (entry.name === 'public') continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
      // Don't let the inventory test itself count as a caller.
      if (abs === path.resolve(__filename)) continue;
      results.push(abs);
    }
  }
  walk(srcDir);
  return results;
}

describe('Legacy vault / weak-crypto regression gate (post-deletion, ADR-0013)', () => {
  describe('existence gate: deleted files must stay deleted', () => {
    it('src/utils/encryption.js does not exist', () => {
      expect(fs.existsSync(LEGACY_WEAK_CRYPTO)).toBe(false);
    });

    it('src/vault/vault.js does not exist', () => {
      expect(fs.existsSync(LEGACY_VAULT)).toBe(false);
    });
  });

  describe('reachability gate: the running server must never load weak crypto', () => {
    let graph;
    beforeAll(() => {
      graph = buildReachableGraph(SERVER_ENTRY);
    });

    it('src/index.js is reachable and the graph is non-trivial', () => {
      expect(graph.visited.has(path.resolve(SERVER_ENTRY))).toBe(true);
      expect(graph.visited.size).toBeGreaterThan(10);
    });

    it('no module reachable from src/index.js requires crypto-js', () => {
      const offenders = graph.edges.filter((e) => FORBIDDEN_BARE.has(e.spec));
      const msg = offenders
        .map((e) => `${path.relative(repoRoot, e.from)} -> require('${e.spec}')`)
        .join('\n');
      expect({ count: offenders.length, details: msg }).toEqual({ count: 0, details: '' });
    });

    it('no module reachable from src/index.js requires the legacy weak Encryption / Vault modules', () => {
      const offenders = graph.edges.filter((e) => {
        const suffix = suffixOf(e.spec);
        return suffix !== null && FORBIDDEN_PATH_SUFFIXES.some((bad) => suffix.endsWith(bad));
      });
      const msg = offenders
        .map((e) => `${path.relative(repoRoot, e.from)} -> require('${e.spec}')`)
        .join('\n');
      expect({ count: offenders.length, details: msg }).toEqual({ count: 0, details: '' });
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
      expect(() => {
        require.resolve('crypto-js', { paths: [repoRoot] });
      }).toThrow();
    });
  });

  describe('textual gate: no source file under src/ may require the forbidden specifiers', () => {
    let files;
    beforeAll(() => {
      files = walkSrcJsFiles();
    });

    it('sanity: walkSrcJsFiles found a non-trivial number of files', () => {
      expect(files.length).toBeGreaterThan(20);
    });

    it('no file under src/ contains require(\'crypto-js\')', () => {
      const offenders = [];
      for (const f of files) {
        const specs = extractRequireSpecifiers(fs.readFileSync(f, 'utf8'));
        for (const spec of specs) {
          if (FORBIDDEN_BARE.has(spec)) {
            offenders.push(`${path.relative(repoRoot, f)} -> require('${spec}')`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it('no file under src/ contains a require() pointing at utils/encryption or vault/vault', () => {
      const offenders = [];
      for (const f of files) {
        const specs = extractRequireSpecifiers(fs.readFileSync(f, 'utf8'));
        for (const spec of specs) {
          const suffix = suffixOf(spec);
          if (suffix !== null && FORBIDDEN_PATH_SUFFIXES.some((bad) => suffix.endsWith(bad))) {
            offenders.push(`${path.relative(repoRoot, f)} -> require('${spec}')`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
