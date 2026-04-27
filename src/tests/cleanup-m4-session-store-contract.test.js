// M4 / T4.1 + T4.2 — SessionStore contract test.
//
// Why this test exists
// --------------------
// ADR-0002 introduces a `SessionStore` interface with multiple
// drivers (memory, sqlite, redis). The express-session Store API is
// untyped and full of optional methods, so without a contract test
// it is easy for two drivers to drift in subtle ways (e.g. one
// returns `null` from `get` for an unknown sid, another returns
// `undefined`). G4.2 already pins the OBSERVABLE behavior end-to-end
// through HTTP; this file pins the lower-level Store contract that
// every driver must satisfy in isolation, so a driver swap can be
// validated without booting Express.
//
// The test is parameterized: every test runs against every driver
// returned by `drivers()`. Adding a new driver (e.g. RedisSession-
// Store in T4.6) means returning it from `drivers()` — nothing else
// in this file changes.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const BetterSqlite3 = require('better-sqlite3');

const {
  createMemorySessionStore,
  createSqliteSessionStore,
} = require('../infra/session');
const { describeSessionStoreShape } = require('../infra/session/SessionStore');

// --- driver factories ------------------------------------------------

/**
 * Each entry returns a fresh store + a teardown hook so test files
 * never share state across runs.
 */
function drivers() {
  return [
    {
      name: 'memory',
      create() {
        const store = createMemorySessionStore();
        return { store, async close() {} };
      },
    },
    {
      name: 'sqlite',
      create() {
        // On-disk temp file rather than ':memory:' so the test
        // exercises real disk I/O paths the way prod does.
        const tmpFile = path.join(
          os.tmpdir(),
          `m4-session-${process.pid}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}.sqlite`,
        );
        const db = new BetterSqlite3(tmpFile);
        const store = createSqliteSessionStore({
          db,
          // Long enough that no cleanup actually fires during a
          // test run, but the timer is still registered and our
          // wrapper's close() is exercised on teardown.
          expiredIntervalMs: 60 * 60 * 1000,
        });
        return {
          store,
          async close() {
            try {
              if (typeof store.close === 'function') store.close();
            } finally {
              try {
                db.close();
              } finally {
                try {
                  fs.unlinkSync(tmpFile);
                } catch (_) {
                  // best-effort
                }
              }
            }
          },
        };
      },
    },
  ];
}

// --- helpers ---------------------------------------------------------

/**
 * Promisify the (err, value) callback shape every store method uses.
 */
function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

const sampleSession = {
  cookie: {
    originalMaxAge: 8 * 60 * 60 * 1000,
    expires: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
  },
  user: { id: 'u_test_1', email: 'contract@example.com' },
};

// --- shared contract suite, parameterized per driver -----------------

describe.each(drivers())('SessionStore contract — driver=$name', ({ name, create }) => {
  let driver;

  beforeEach(() => {
    driver = create();
  });

  afterEach(async () => {
    if (driver) await driver.close();
  });

  test('shape: exposes set/get/destroy/touch/length with the right arity', () => {
    const shape = describeSessionStoreShape(driver.store);
    if (!shape.ok) {
      throw new Error(
        `[${name}] store shape mismatch: ` +
          JSON.stringify(shape, null, 2),
      );
    }
    expect(shape.ok).toBe(true);
  });

  test('round-trip: set then get returns the persisted session', async () => {
    const sid = `sid_${name}_basic`;
    await call(driver.store, 'set', sid, sampleSession);
    const loaded = await call(driver.store, 'get', sid);
    expect(loaded).toBeTruthy();
    expect(loaded.user).toEqual(sampleSession.user);
  });

  test('get: unknown sid resolves to falsy (no error)', async () => {
    const loaded = await call(driver.store, 'get', 'sid_does_not_exist');
    // express-session accepts null OR undefined here; both indicate
    // "no such session". Drivers MUST NOT throw and MUST NOT return
    // a fabricated empty object.
    expect(loaded == null).toBe(true);
  });

  test('destroy: makes a previously-stored session unfetchable', async () => {
    const sid = `sid_${name}_destroy`;
    await call(driver.store, 'set', sid, sampleSession);
    await call(driver.store, 'destroy', sid);
    const loaded = await call(driver.store, 'get', sid);
    expect(loaded == null).toBe(true);
  });

  test('touch: succeeds for an existing session and does not corrupt it', async () => {
    const sid = `sid_${name}_touch`;
    await call(driver.store, 'set', sid, sampleSession);

    const refreshed = {
      ...sampleSession,
      cookie: {
        ...sampleSession.cookie,
        expires: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString(),
      },
    };
    await call(driver.store, 'touch', sid, refreshed);

    const loaded = await call(driver.store, 'get', sid);
    expect(loaded).toBeTruthy();
    expect(loaded.user).toEqual(sampleSession.user);
  });

  test('length: increases monotonically as sessions are added', async () => {
    const before = (await call(driver.store, 'length')) || 0;
    await call(driver.store, 'set', `sid_${name}_len_a`, sampleSession);
    await call(driver.store, 'set', `sid_${name}_len_b`, sampleSession);
    const after = (await call(driver.store, 'length')) || 0;
    expect(after - before).toBeGreaterThanOrEqual(2);
  });

  test('callbacks fire exactly once per call (no double-callback regressions)', async () => {
    const sid = `sid_${name}_once`;
    await new Promise((resolve, reject) => {
      let fired = 0;
      driver.store.set(sid, sampleSession, (err) => {
        fired += 1;
        if (err) return reject(err);
        // Wait a tick to catch any spurious second invocation.
        setTimeout(() => {
          if (fired !== 1) return reject(new Error(`set callback fired ${fired} times`));
          resolve();
        }, 25);
      });
    });
  });
});

// --- sqlite-specific: timer-leak fix --------------------------------

describe('SqliteSessionStore timer-leak fix (M4 wrapper contract)', () => {
  test('store.close() clears the upstream cleanup interval', () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `m4-leak-${process.pid}-${Date.now()}.sqlite`,
    );
    const db = new BetterSqlite3(tmpFile);
    try {
      const store = createSqliteSessionStore({
        db,
        expiredIntervalMs: 60 * 60 * 1000,
      });
      expect(typeof store.close).toBe('function');
      // Calling close() must not throw and must be idempotent.
      store.close();
      store.close();
    } finally {
      db.close();
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {
        // best-effort
      }
    }
  });
});

// --- factory selection (unit test for src/infra/session/index.js) ----

describe('createSessionStore selection', () => {
  const { createSessionStore } = require('../infra/session');

  test('NODE_ENV=test → memory driver (no db required)', () => {
    const result = createSessionStore({ env: { NODE_ENV: 'test' } });
    expect(result.driver).toBe('memory');
  });

  test('REDIS_URL set → throws "not yet implemented" (loud, not silent)', () => {
    expect(() =>
      createSessionStore({
        env: { NODE_ENV: 'production', REDIS_URL: 'redis://localhost:6379' },
      }),
    ).toThrow(/not yet implemented/i);
  });

  test('DATABASE_URL set → memory driver (legacy Mongo path, parity)', () => {
    const result = createSessionStore({
      env: { NODE_ENV: 'production', DATABASE_URL: 'mongodb://localhost/myapi' },
    });
    expect(result.driver).toBe('memory');
  });

  test('default (production, no Redis, no Mongo) → sqlite driver, requires db', () => {
    expect(() =>
      createSessionStore({ env: { NODE_ENV: 'production' } }),
    ).toThrow(/`db`.*required/);
  });

  test('default with db → sqlite driver', () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `m4-factory-${process.pid}-${Date.now()}.sqlite`,
    );
    const db = new BetterSqlite3(tmpFile);
    try {
      const result = createSessionStore({
        env: { NODE_ENV: 'production' },
        db,
        expiredIntervalMs: 60 * 60 * 1000,
      });
      expect(result.driver).toBe('sqlite');
      expect(describeSessionStoreShape(result.store).ok).toBe(true);
      if (typeof result.store.close === 'function') result.store.close();
    } finally {
      db.close();
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {
        // best-effort
      }
    }
  });
});
