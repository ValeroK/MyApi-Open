// M4 / T4.5 — RateLimitStore contract test.
//
// Driver-agnostic (memory + sqlite). Every test runs against every
// driver via describe.each(drivers()). Adding a new driver (e.g. the
// Redis driver in T4.6's follow-up) means returning it from drivers()
// — nothing else here changes.
//
// Determinism
// -----------
// Time is injected through `now()` so the window-refill, retryAfter,
// and exhaustion-then-reset cases do not race the wall clock. Each
// driver gets its own Clock instance per test.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const BetterSqlite3 = require('better-sqlite3');

const {
  MemoryRateLimitStore,
  SqliteRateLimitStore,
  createRateLimitStore,
} = require('../infra/rate-limit');
const { describeRateLimitStoreShape } = require('../infra/rate-limit/RateLimitStore');

// --- helpers ---------------------------------------------------------

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    set(ms) {
      t = ms;
    },
  };
}

// --- driver factories ------------------------------------------------

function drivers() {
  return [
    {
      name: 'memory',
      create({ clock }) {
        const store = new MemoryRateLimitStore({
          gcIntervalMs: 60 * 60 * 1000, // long enough that tests never trigger sweep
          now: clock.now,
        });
        return {
          store,
          async close() {
            store.close();
          },
        };
      },
    },
    {
      name: 'sqlite',
      create({ clock }) {
        const tmpFile = path.join(
          os.tmpdir(),
          `m4-ratelimit-${process.pid}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}.sqlite`,
        );
        const db = new BetterSqlite3(tmpFile);
        const store = new SqliteRateLimitStore({
          db,
          gcIntervalMs: 60 * 60 * 1000,
          now: clock.now,
        });
        return {
          store,
          async close() {
            try {
              store.close();
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

// --- shared contract suite, parameterized per driver -----------------

describe.each(drivers())('RateLimitStore contract — driver=$name', ({ name, create }) => {
  let clock;
  let driver;

  beforeEach(() => {
    clock = makeClock();
    driver = create({ clock });
  });

  afterEach(async () => {
    if (driver) await driver.close();
  });

  test('shape: exposes consume / reset / close', () => {
    const shape = describeRateLimitStoreShape(driver.store);
    if (!shape.ok) {
      throw new Error(`[${name}] missing methods: ${shape.missing.join(', ')}`);
    }
    expect(shape.ok).toBe(true);
  });

  test('first request in a fresh window is allowed with remaining = max - 1', () => {
    const out = driver.store.consume('k1', 5, 60_000);
    expect(out.allowed).toBe(true);
    expect(out.remaining).toBe(4);
    expect(out.limit).toBe(5);
    expect(out.resetAt).toBe(clock.now() + 60_000);
  });

  test('exhausting the bucket: max requests allowed then 429s with retryAfter >= 1', () => {
    const max = 3;
    const windowMs = 60_000;
    for (let i = 0; i < max; i++) {
      const out = driver.store.consume('k_exhaust', max, windowMs);
      expect(out.allowed).toBe(true);
      expect(out.remaining).toBe(max - (i + 1));
    }
    const denied = driver.store.consume('k_exhaust', max, windowMs);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  test('after windowMs elapses, the bucket refills', () => {
    const max = 2;
    const windowMs = 30_000;
    driver.store.consume('k_refill', max, windowMs);
    driver.store.consume('k_refill', max, windowMs);
    expect(driver.store.consume('k_refill', max, windowMs).allowed).toBe(false);

    clock.advance(windowMs + 1);
    const out = driver.store.consume('k_refill', max, windowMs);
    expect(out.allowed).toBe(true);
    expect(out.remaining).toBe(max - 1);
  });

  test('retryAfterSec shrinks as time within the window passes', () => {
    const max = 1;
    const windowMs = 10_000;
    driver.store.consume('k_retry', max, windowMs);
    const denied1 = driver.store.consume('k_retry', max, windowMs);
    expect(denied1.allowed).toBe(false);
    const r1 = denied1.retryAfterSec;

    clock.advance(5_000);
    const denied2 = driver.store.consume('k_retry', max, windowMs);
    expect(denied2.allowed).toBe(false);
    const r2 = denied2.retryAfterSec;

    expect(r2).toBeLessThan(r1);
    expect(r2).toBeGreaterThanOrEqual(1);
  });

  test('keys are isolated: filling one does not affect another', () => {
    const max = 1;
    const windowMs = 60_000;
    driver.store.consume('k_a', max, windowMs);
    expect(driver.store.consume('k_a', max, windowMs).allowed).toBe(false);
    expect(driver.store.consume('k_b', max, windowMs).allowed).toBe(true);
  });

  test('reset() clears the bucket so the next consume passes', () => {
    const max = 1;
    const windowMs = 60_000;
    driver.store.consume('k_reset', max, windowMs);
    expect(driver.store.consume('k_reset', max, windowMs).allowed).toBe(false);
    driver.store.reset('k_reset');
    expect(driver.store.consume('k_reset', max, windowMs).allowed).toBe(true);
  });

  test('close() is idempotent', () => {
    expect(() => {
      driver.store.close();
      driver.store.close();
    }).not.toThrow();
  });

  test('resetAt and retryAfterSec are consistent', () => {
    const max = 1;
    const windowMs = 30_000;
    const t0 = clock.now();
    driver.store.consume('k_reset_at', max, windowMs);
    const denied = driver.store.consume('k_reset_at', max, windowMs);
    expect(denied.resetAt).toBe(t0 + windowMs);
    expect(denied.retryAfterSec).toBe(Math.ceil(windowMs / 1000));
  });
});

// --- factory selection ----------------------------------------------

describe('createRateLimitStore selection', () => {
  test('NODE_ENV=test → memory driver', () => {
    const result = createRateLimitStore({ env: { NODE_ENV: 'test' } });
    expect(result.driver).toBe('memory');
    result.store.close();
  });

  test('REDIS_URL set → throws (loud, not silent)', () => {
    expect(() =>
      createRateLimitStore({
        env: { NODE_ENV: 'production', REDIS_URL: 'redis://localhost:6379' },
      }),
    ).toThrow(/not yet implemented/i);
  });

  test('DATABASE_URL set → memory driver (legacy Mongo parity)', () => {
    const result = createRateLimitStore({
      env: { NODE_ENV: 'production', DATABASE_URL: 'mongodb://localhost/myapi' },
    });
    expect(result.driver).toBe('memory');
    result.store.close();
  });

  test('default (production, no Redis, no Mongo) → sqlite driver, requires db', () => {
    expect(() =>
      createRateLimitStore({ env: { NODE_ENV: 'production' } }),
    ).toThrow(/`db`.*required/);
  });

  test('default with db → sqlite driver', () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `m4-ratelimit-factory-${process.pid}-${Date.now()}.sqlite`,
    );
    const db = new BetterSqlite3(tmpFile);
    try {
      const result = createRateLimitStore({
        env: { NODE_ENV: 'production' },
        db,
        gcIntervalMs: 60 * 60 * 1000,
      });
      expect(result.driver).toBe('sqlite');
      expect(describeRateLimitStoreShape(result.store).ok).toBe(true);
      result.store.close();
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
