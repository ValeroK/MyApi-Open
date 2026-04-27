// MemorySessionStore — in-process driver for tests and zero-dep dev.
//
// Express-session ships a built-in MemoryStore. We re-export it via a
// named factory so the rest of the codebase depends on the named
// driver (memory / sqlite / redis) rather than reaching into
// `require('express-session').MemoryStore` ad-hoc.
//
// This driver is intentionally NOT used in production — it has no
// persistence, no eviction policy beyond express-session's own, and
// leaks across test files unless a fresh instance is created per test.
// That's why the factory always returns a fresh instance.

'use strict';

const session = require('express-session');

/**
 * Construct a fresh in-memory session store.
 * @returns {import('express-session').Store}
 */
function createMemorySessionStore() {
  return new session.MemoryStore();
}

module.exports = { createMemorySessionStore };
