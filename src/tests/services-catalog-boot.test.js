/**
 * F10 — Service catalog boot seed.
 *
 * Closes GAP-010 from `.context/capability-gaps.md`.
 *
 * Pre-F10, `src/database.js:743-744` had two seed calls
 * commented out with a `TODO: MongoDB version` note dating to
 * the (since-cancelled) MongoDB experiment:
 *
 *   // seedServiceCategories(); // TODO: MongoDB version
 *   // seedServices();           // TODO: MongoDB version
 *
 * This left the `services` table empty on every clean boot. The
 * dashboard's service catalog was empty; `getServiceByName('google')`
 * returned `undefined`; `POST /api/v1/services/google/execute`
 * returned 404 `Service not found` even with master auth and a
 * connected OAuth row. The L1 suite
 * `services-execute-behavioral.test.js` worked around this in
 * `beforeAll` by calling the seeders directly — that workaround
 * is what this test removes.
 *
 * What this suite asserts
 * -----------------------
 * 1. **Runtime: catalog populated at boot.**
 *    `getServiceByName('google')` returns a row with the canonical
 *    `oauth2` auth-type and the documented `https://www.googleapis.com`
 *    apiEndpoint, *without* the test calling any seeder explicitly.
 *    Mirrors the documented happy path: `services` is a known-good
 *    catalog the moment the gateway boots.
 * 2. **Runtime: every advertised provider in `llms.txt`'s
 *    "Services & Vault" block is present.** Locks the smallest
 *    contract between the docs and the catalog so a future
 *    catalog-trim deletes services intentionally.
 * 3. **Static gate: the two seed calls are NOT commented out.**
 *    Permanent ratchet so a future "MongoDB switch-back" doesn't
 *    silently re-empty the catalog. Pattern mirrors
 *    `oauth-state-inventory.test.js` and the M2 / M3 inventory
 *    gates.
 *
 * Related
 * -------
 * - `.context/tasks/backlog/F10-service-catalog-seed.md`
 * - `.context/capability-gaps.md` GAP-010
 * - `src/database.js:743-744` (the post-fix call site)
 * - `src/tests/services-execute-behavioral.test.js`
 *   (`beforeAll` workaround removed in the same change)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Importing `../server` runs the gateway's boot path (db init +
// migrations + seeds). The whole point of this suite is to verify
// that the boot path — not a per-suite workaround — populates the
// catalog. Do NOT short-circuit by requiring only `../database`,
// which exposes the helpers but never runs them.
require('../server');
const db = require('../database');

const DATABASE_SOURCE = path.resolve(__dirname, '..', 'database.js');

const REQUIRED_SERVICES = [
  'google',
  'github',
  'slack',
  'discord',
  'notion',
  'stripe',
];

describe('[F10 / GAP-010] service catalog boot seed', () => {
  describe('runtime: catalog populated at boot', () => {
    test("getServiceByName('google') returns a row with canonical oauth2 fields", () => {
      const row = db.getServiceByName('google');
      expect(row).toBeDefined();
      expect(row).not.toBeNull();
      // The seed in src/database.js:4606 puts google with auth=
      // 'oauth2' and endpoint='https://www.googleapis.com'.
      expect(row.auth_type).toBe('oauth2');
      expect(row.api_endpoint).toBe('https://www.googleapis.com');
      expect(typeof row.id).toBe('number');
    });

    for (const name of REQUIRED_SERVICES) {
      test(`getServiceByName('${name}') returns a row at boot`, () => {
        const row = db.getServiceByName(name);
        expect(row).toBeDefined();
        expect(row).not.toBeNull();
        expect(row.name).toBe(name);
      });
    }

    test('the catalog has at least 30 rows (sanity)', () => {
      // The seed in src/database.js iterates a 40+ provider list.
      // Allow some headroom but reject the empty / near-empty
      // post-bug state.
      const count = db.db.prepare('SELECT count(*) AS c FROM services').get().c;
      expect(count).toBeGreaterThanOrEqual(30);
    });
  });

  describe('static: src/database.js boot path calls the seeders', () => {
    let source;

    beforeAll(() => {
      source = fs.readFileSync(DATABASE_SOURCE, 'utf8');
    });

    test("calls `seedServiceCategories();` (uncommented)", () => {
      // Negative-assertion ratchet: the literal commented form
      // MUST NOT reappear; the active form MUST appear at least
      // once in the boot path. Mirrors the M2 / M3 inventory
      // gates' approach to "this code must be present, this
      // exact comment must be absent".
      expect(source).not.toMatch(/^\s*\/\/\s*seedServiceCategories\(\)/m);
      expect(source).toMatch(/^\s*seedServiceCategories\(\);/m);
    });

    test("calls `seedServices();` (uncommented)", () => {
      expect(source).not.toMatch(/^\s*\/\/\s*seedServices\(\)/m);
      expect(source).toMatch(/^\s*seedServices\(\);/m);
    });

    test('no leftover `TODO: MongoDB version` markers next to the seed calls', () => {
      // The marker lived on the same line as the comments. Scrub
      // it from the seed-region to make sure the cleanup was
      // thorough.
      const seedRegion = source.match(/seedServiceCategories[\s\S]{0,300}/);
      expect(seedRegion).not.toBeNull();
      expect(seedRegion[0]).not.toContain('TODO: MongoDB version');
    });
  });
});
