// SqliteSessionStore — SQLite-backed driver for self-host and dev.
//
// Wraps `better-sqlite3-session-store` (already a dep) so the
// construction details (cleanup interval, table schema, the
// double-call factory pattern) live in one place. The store this
// returns is a real express-session Store instance and is suitable
// for direct use in `app.use(session({ store }))`.
//
// Notes on the upstream library
// -----------------------------
// `better-sqlite3-session-store` is a factory: you call it once with
// the `express-session` module to get a *Store class*, then `new`
// that class with a config object. Doing this twice in the same
// process is wasteful but harmless; we cache the class on the module
// to avoid that.
//
// The `expired.intervalMs` option is the upstream library's own
// cleanup timer — it's a `setInterval` registered inside the library.
// G0.3 (boot side-effects inventory) does NOT see it because it
// scans `src/index.js` only; M4 documents this here so the timer is
// not orphaned in the next inventory pass.
//
// Upstream bug fix
// ----------------
// `better-sqlite3-session-store@0.1.0` calls `setInterval(...)` in
// its constructor and *discards the returned handle* (see
// `node_modules/better-sqlite3-session-store/src/index.js:43`).
// That means there is no way to stop the cleanup loop after
// construction — every Store instance leaks a timer for the lifetime
// of the process. Tests with `--detectOpenHandles` flag this; in
// production it's the timer source G0.3 wanted gone in M4.
//
// Our wrapper fixes this without forking upstream by intercepting
// `setInterval` for the brief synchronous window of construction,
// capturing the handle, calling `.unref()` so it does not block
// process exit, and exposing a `.close()` method on the returned
// store so tests (and any future graceful-shutdown path) can stop
// the timer deterministically.

'use strict';

const session = require('express-session');

let CachedStoreCtor = null;

function getStoreCtor() {
  if (CachedStoreCtor) return CachedStoreCtor;
  // Loaded lazily so test runs that never touch the SQLite driver
  // don't pay the cost of opening the native module.
  CachedStoreCtor = require('better-sqlite3-session-store')(session);
  return CachedStoreCtor;
}

/**
 * Construct a SQLite-backed express-session Store.
 *
 * @param {{ db: import('better-sqlite3').Database, expiredIntervalMs?: number }} options
 *   - db: an already-opened better-sqlite3 Database handle. The store
 *     creates its own `sessions` table on first use; no migration is
 *     required.
 *   - expiredIntervalMs: how often the upstream library scans for
 *     expired rows. Default 15 minutes — matches the value that
 *     `src/index.js` used inline before M4.
 * @returns {import('express-session').Store}
 */
function createSqliteSessionStore({ db, expiredIntervalMs = 15 * 60 * 1000 } = {}) {
  if (!db) {
    throw new Error('createSqliteSessionStore: `db` (better-sqlite3 Database) is required');
  }
  const StoreCtor = getStoreCtor();

  // Capture the cleanup-timer handle the upstream constructor will
  // create. Construction is synchronous and registers exactly one
  // interval, so this monkey-patch window is safe — but we keep it
  // as narrow as possible (single try/finally block).
  let intervalHandle = null;
  const realSetInterval = global.setInterval;
  global.setInterval = function patchedSetInterval(...args) {
    intervalHandle = realSetInterval(...args);
    return intervalHandle;
  };

  let store;
  try {
    store = new StoreCtor({
      client: db,
      expired: {
        clear: true,
        intervalMs: expiredIntervalMs,
      },
    });
  } finally {
    global.setInterval = realSetInterval;
  }

  if (intervalHandle && typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }

  // Augment the store with a graceful shutdown hook. Express-session's
  // Store interface does not require this, but having it lets test
  // teardown stop the timer deterministically and lets the future
  // M6 graceful-shutdown path call it on SIGTERM.
  store.close = function close() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  };

  return store;
}

module.exports = { createSqliteSessionStore };
