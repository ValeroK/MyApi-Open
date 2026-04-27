// Session store factory — selects a driver based on environment.
//
// ADR-0002 mandates that the entire app depend on a single
// `SessionStore` interface, with the concrete driver chosen at boot
// from environment variables. This module is the single decision
// point.
//
// Selection rule (in order)
// -------------------------
//   1. NODE_ENV === 'test'  → memory driver
//      Tests use the in-process store so each test file starts
//      from a clean slate without touching a SQLite file.
//
//   2. REDIS_URL is set     → redis driver  (T4.6 — not yet
//      implemented; throws a clear error today so misconfiguration
//      is loud rather than silently dropping back to SQLite).
//
//   3. DATABASE_URL is set  → memory driver
//      Legacy MongoDB code path. ADR-0001 deletes it in M8; until
//      then we preserve today's behavior, which was to leave the
//      session store unset (express-session defaulted to its own
//      MemoryStore). Returning a memory driver here is observably
//      identical.
//
//   4. otherwise            → sqlite driver
//      The default for self-host and dev. Requires a `db` parameter.
//
// The factory keeps the same selection semantics as the inline code
// it replaces in `src/index.js` (lines 854-1177 before M4-T4.3),
// so swapping the call site is a pure refactor.

'use strict';

const { createMemorySessionStore } = require('./MemorySessionStore');
const { createSqliteSessionStore } = require('./SqliteSessionStore');

/**
 * @typedef {object} CreateSessionStoreOptions
 * @property {NodeJS.ProcessEnv} [env=process.env]
 *   Environment variables to read (overridable for tests).
 * @property {import('better-sqlite3').Database} [db]
 *   Required when the sqlite driver is selected.
 * @property {number} [expiredIntervalMs]
 *   Forwarded to the sqlite driver's cleanup timer.
 */

/**
 * @param {CreateSessionStoreOptions} [options]
 * @returns {{ store: import('express-session').Store, driver: 'memory'|'sqlite'|'redis' }}
 */
function createSessionStore(options = {}) {
  const env = options.env || process.env;

  if (env.NODE_ENV === 'test') {
    return { store: createMemorySessionStore(), driver: 'memory' };
  }

  if (env.REDIS_URL) {
    throw new Error(
      'Redis session store driver not yet implemented (M4-T4.6). ' +
        'Unset REDIS_URL to fall back to SQLite, or wait for T4.6.',
    );
  }

  if (env.DATABASE_URL) {
    return { store: createMemorySessionStore(), driver: 'memory' };
  }

  return {
    store: createSqliteSessionStore({
      db: options.db,
      expiredIntervalMs: options.expiredIntervalMs,
    }),
    driver: 'sqlite',
  };
}

module.exports = {
  createSessionStore,
  createMemorySessionStore,
  createSqliteSessionStore,
};
