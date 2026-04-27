// Rate-limit store factory — selects a driver based on environment.
//
// Mirrors `src/infra/session/index.js`. Selection rule (in order):
//
//   1. NODE_ENV === 'test'  → memory driver
//   2. REDIS_URL is set     → throw "redis driver not yet implemented"
//                             (loud, not silent)
//   3. DATABASE_URL is set  → memory driver  (legacy Mongo path,
//                             scheduled for deletion in M8)
//   4. otherwise            → sqlite driver
//
// The selection is intentionally identical to the session-store
// factory's so a deployment that picks the SQLite driver for sessions
// gets it for rate-limits too. Pairing the two drivers simplifies
// observability (one persistence story) and makes the eventual Redis
// adoption an all-or-nothing flip.

'use strict';

const { MemoryRateLimitStore } = require('./MemoryRateLimitStore');
const { SqliteRateLimitStore } = require('./SqliteRateLimitStore');

/**
 * @typedef {object} CreateRateLimitStoreOptions
 * @property {NodeJS.ProcessEnv} [env=process.env]
 * @property {import('better-sqlite3').Database} [db]
 *   Required when the sqlite driver is selected.
 * @property {number} [gcIntervalMs]
 * @property {() => number} [now]
 *   Injectable clock (tests).
 */

/**
 * @param {CreateRateLimitStoreOptions} [options]
 * @returns {{
 *   store: import('./MemoryRateLimitStore').MemoryRateLimitStore
 *        | import('./SqliteRateLimitStore').SqliteRateLimitStore,
 *   driver: 'memory' | 'sqlite' | 'redis'
 * }}
 */
function createRateLimitStore(options = {}) {
  const env = options.env || process.env;

  if (env.NODE_ENV === 'test') {
    return {
      store: new MemoryRateLimitStore({
        gcIntervalMs: options.gcIntervalMs,
        now: options.now,
      }),
      driver: 'memory',
    };
  }

  if (env.REDIS_URL) {
    throw new Error(
      'Redis rate-limit store driver not yet implemented (M4 follow-up). ' +
        'Unset REDIS_URL to fall back to SQLite, or wait for the Redis driver task.',
    );
  }

  if (env.DATABASE_URL) {
    return {
      store: new MemoryRateLimitStore({
        gcIntervalMs: options.gcIntervalMs,
        now: options.now,
      }),
      driver: 'memory',
    };
  }

  return {
    store: new SqliteRateLimitStore({
      db: options.db,
      gcIntervalMs: options.gcIntervalMs,
      now: options.now,
    }),
    driver: 'sqlite',
  };
}

module.exports = {
  createRateLimitStore,
  MemoryRateLimitStore,
  SqliteRateLimitStore,
};
