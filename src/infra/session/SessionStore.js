// SessionStore — interface contract for express-session-compatible stores.
//
// This is the boundary referenced by ADR-0002 (dual-driver session +
// rate-limit store). Concrete drivers in this folder MUST satisfy the
// shape below so the rest of the app can depend on the interface, not
// any particular implementation (memory / sqlite / redis).
//
// The interface intentionally mirrors `express-session`'s built-in
// Store API exactly. Doing so means our drivers can be passed straight
// to `app.use(session({ store }))` without an adapter layer, and any
// third-party Store (e.g. better-sqlite3-session-store, connect-redis)
// already conforms.
//
// Required methods (callback-style, mirroring express-session):
//   set(sid, sessionData, callback)         persist a session
//   get(sid, callback)                      load a session by id
//   destroy(sid, callback)                  evict a session by id
//   touch(sid, sessionData, callback)       refresh the expiry of a session
//   length(callback)                        return current session count
//
// Optional methods (express-session calls them when present):
//   all(callback)                           list all sessions
//   clear(callback)                         drop every session
//
// Lifecycle helpers (NOT part of express-session, but useful for tests
// and clean shutdown — drivers may implement either or neither):
//   close()        // async, release any underlying handle
//
// Error contract
// --------------
// Every callback MUST be invoked exactly once with `(err, value)`.
// Drivers MUST NOT throw synchronously from any of the methods above —
// errors must be reported via the callback. This is what
// express-session itself relies on; violating it crashes the process.

'use strict';

/**
 * Runtime sanity check used by contract tests. Verifies that an object
 * looks like a SessionStore (has the required express-session methods).
 * Does NOT check `Function.prototype.length` — both express-session's
 * built-in MemoryStore and `better-sqlite3-session-store` use
 * default-parameter signatures (e.g. `set(sid, sess, cb = noop)`),
 * which yields `length === 2` not 3, even though the methods accept
 * the full callback contract. Behavioral correctness is asserted by
 * the contract test's round-trip cases instead.
 *
 * @param {unknown} store
 * @returns {{ ok: boolean, missing: string[] }}
 */
function describeSessionStoreShape(store) {
  const required = ['set', 'get', 'destroy', 'touch', 'length'];
  const missing = [];
  for (const name of required) {
    if (!store || typeof store[name] !== 'function') missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

module.exports = { describeSessionStoreShape };
