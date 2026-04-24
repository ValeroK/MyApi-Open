/**
 * M3 Step 8 / T3.9 — background prune scheduler for the OAuth
 * state-row + pending-login tables.
 *
 * This suite pins the behaviour of `src/domain/oauth/prune-scheduler.js`
 * — a thin composition layer over the two domain primitives shipped
 * earlier in M3:
 *
 *   - `pruneExpiredStateTokens`   (src/domain/oauth/state.js, T3.2)
 *   - `pruneExpiredPendingConfirms` (src/domain/oauth/pending-confirm.js, T3.7)
 *
 * Contract pinned here:
 *
 *   - Module exports `runPruneOnce(...)`, `startPruneScheduler(...)`,
 *     and `DEFAULTS` (a frozen `{ intervalMs, graceSec }` constants
 *     object so the tests and `src/index.js` share one truth).
 *   - `runPruneOnce` is a pure composition: accepts `{ db, now?,
 *     graceSec?, logger? }`, returns a promise-free
 *     `{ prunedState, prunedPending, elapsedMs }`, and never
 *     throws — a failure in EITHER underlying prune is swallowed
 *     and logged via `logger.error`; the other prune still runs.
 *   - A successful tick with non-zero prunes MUST emit a single
 *     structured log line via `logger.info` carrying
 *     `{ pruned_state, pruned_pending, elapsed_ms }`.
 *   - A successful tick with zero prunes MUST be silent at INFO
 *     level (DEBUG is fine but not asserted).
 *   - `startPruneScheduler({ db, intervalMs?, graceSec?, logger?,
 *     timers? })` returns a `stop()` function that clears the
 *     interval. The `timers` injection lets this suite exercise
 *     the interval wiring without real time passing.
 *
 * Red-first: the module does not exist on HEAD, so this file files
 * at MODULE_NOT_FOUND. The implementation lands in the same commit
 * and flips all tests green.
 */

'use strict';

process.env.NODE_ENV = 'test';
// The app is not booted in this suite; these env vars only exist so
// a downstream `require('../database')` doesn't trip validate-secrets
// in modules that import it indirectly.
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-ci';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'test-encryption-key-32chars!!';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'test-session-secret-ci';
process.env.VAULT_KEY =
  process.env.VAULT_KEY || 'test-vault-key-ci-32characters!';
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

describe('[M3 / T3.9] OAuth prune scheduler', () => {
  let scheduler;
  let db;
  let stateDomain;
  let pendingConfirmDomain;

  beforeAll(() => {
    const database = require('../database');
    database.initDatabase();
    db = database.db;

    stateDomain = require('../domain/oauth/state');
    pendingConfirmDomain = require('../domain/oauth/pending-confirm');
    scheduler = require('../domain/oauth/prune-scheduler');
  });

  beforeEach(() => {
    db.exec('DELETE FROM oauth_state_tokens');
    db.exec('DELETE FROM oauth_pending_logins');
  });

  // ------------------------------------------------------------------
  // Module surface
  // ------------------------------------------------------------------

  test('exports runPruneOnce / startPruneScheduler / DEFAULTS', () => {
    expect(typeof scheduler.runPruneOnce).toBe('function');
    expect(typeof scheduler.startPruneScheduler).toBe('function');
    expect(typeof scheduler.DEFAULTS).toBe('object');
    expect(scheduler.DEFAULTS).not.toBeNull();
  });

  test('DEFAULTS is frozen and carries intervalMs + graceSec', () => {
    const d = scheduler.DEFAULTS;
    expect(Object.isFrozen(d)).toBe(true);
    expect(typeof d.intervalMs).toBe('number');
    expect(d.intervalMs).toBeGreaterThan(0);
    expect(typeof d.graceSec).toBe('number');
    expect(d.graceSec).toBeGreaterThanOrEqual(0);
  });

  // ------------------------------------------------------------------
  // runPruneOnce — happy paths
  // ------------------------------------------------------------------

  test('runPruneOnce with an empty DB returns zero counts and is silent at INFO', () => {
    const info = jest.fn();
    const error = jest.fn();
    const result = scheduler.runPruneOnce({
      db,
      logger: { info, error },
    });

    expect(result).toEqual({
      prunedState: 0,
      prunedPending: 0,
      elapsedMs: expect.any(Number),
    });
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test('runPruneOnce prunes expired state rows and logs structured info', () => {
    // Two state rows: one fresh, one well past its TTL + grace.
    const t0 = Date.UTC(2026, 3, 1, 0, 0, 0);
    const fresh = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
      now: t0,
    });
    const stale = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
      now: t0,
    });
    // Backdate the stale row's expires_at so it's 2 hours past now,
    // well outside the default 1h grace window.
    db.prepare(
      'UPDATE oauth_state_tokens SET expires_at = ? WHERE state_token = ?'
    ).run(new Date(t0 - 2 * 3600_000).toISOString(), stale.state);

    const info = jest.fn();
    const error = jest.fn();
    const result = scheduler.runPruneOnce({
      db,
      now: t0,
      logger: { info, error },
    });

    expect(result.prunedState).toBe(1);
    expect(result.prunedPending).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const [msg, payload] = info.mock.calls[0];
    expect(typeof msg).toBe('string');
    expect(msg).toMatch(/prune/i);
    expect(payload).toMatchObject({
      pruned_state: 1,
      pruned_pending: 0,
      elapsed_ms: expect.any(Number),
    });

    // Fresh row survives, stale row is gone.
    const survivors = db
      .prepare('SELECT state_token FROM oauth_state_tokens')
      .all()
      .map((r) => r.state_token);
    expect(survivors).toEqual([fresh.state]);
  });

  test('runPruneOnce prunes expired pending-confirm rows via the domain primitive', () => {
    const t0 = Date.UTC(2026, 3, 2, 0, 0, 0);
    pendingConfirmDomain.createPendingConfirm({
      db,
      serviceName: 'google',
      userId: 'user_x',
      providerSubject: 'sub_x',
      userData: { email: 'x@example.com' },
      now: t0,
    });
    // Backdate so expires_at is past grace.
    db.prepare(
      'UPDATE oauth_pending_logins SET expires_at = ?'
    ).run(new Date(t0 - 2 * 3600_000).toISOString());

    const info = jest.fn();
    const result = scheduler.runPruneOnce({
      db,
      now: t0,
      logger: { info, error: jest.fn() },
    });
    expect(result.prunedPending).toBe(1);
    expect(result.prunedState).toBe(0);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][1]).toMatchObject({
      pruned_state: 0,
      pruned_pending: 1,
    });
  });

  test('runPruneOnce propagates a custom graceSec override', () => {
    const t0 = Date.UTC(2026, 3, 3, 0, 0, 0);
    // Create a state row and expire it 10s in the past. With default
    // grace (3600s) it should NOT be pruned. With grace=0 it should.
    const issued = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
      now: t0,
    });
    db.prepare(
      'UPDATE oauth_state_tokens SET expires_at = ? WHERE state_token = ?'
    ).run(new Date(t0 - 10_000).toISOString(), issued.state);

    const withGrace = scheduler.runPruneOnce({
      db,
      now: t0,
      logger: { info: jest.fn(), error: jest.fn() },
    });
    expect(withGrace.prunedState).toBe(0);

    const zeroGrace = scheduler.runPruneOnce({
      db,
      now: t0,
      graceSec: 0,
      logger: { info: jest.fn(), error: jest.fn() },
    });
    expect(zeroGrace.prunedState).toBe(1);
  });

  // ------------------------------------------------------------------
  // runPruneOnce — fault isolation
  // ------------------------------------------------------------------

  test('runPruneOnce does NOT throw if one of the underlying prunes fails; error is logged, other prune still runs', () => {
    // Force a failure inside pruneExpiredPendingConfirms by passing a
    // broken db-like object that satisfies state.js but throws for
    // pending-confirm. Simplest: monkey-patch the pending-confirm
    // module's pruneExpiredPendingConfirms on the required instance.
    const realPrune = pendingConfirmDomain.pruneExpiredPendingConfirms;
    const spy = jest
      .spyOn(pendingConfirmDomain, 'pruneExpiredPendingConfirms')
      .mockImplementation(() => {
        throw new Error('boom');
      });

    // Seed a stale state row so the state-side prune has something to do.
    const t0 = Date.UTC(2026, 3, 4, 0, 0, 0);
    const stale = stateDomain.createStateToken({
      db,
      serviceName: 'google',
      mode: 'login',
      now: t0,
    });
    db.prepare(
      'UPDATE oauth_state_tokens SET expires_at = ? WHERE state_token = ?'
    ).run(new Date(t0 - 2 * 3600_000).toISOString(), stale.state);

    const info = jest.fn();
    const error = jest.fn();
    let result;
    expect(() => {
      result = scheduler.runPruneOnce({
        db,
        now: t0,
        logger: { info, error },
      });
    }).not.toThrow();

    expect(result.prunedState).toBe(1);
    expect(result.prunedPending).toBe(0);
    expect(error).toHaveBeenCalled();
    const [errMsg] = error.mock.calls[0];
    expect(String(errMsg)).toMatch(/pending/i);

    spy.mockRestore();
    // Sanity: restored binding still resolves to the real primitive.
    expect(pendingConfirmDomain.pruneExpiredPendingConfirms).toBe(realPrune);
  });

  // ------------------------------------------------------------------
  // startPruneScheduler — interval wiring via injected timers
  // ------------------------------------------------------------------

  test('startPruneScheduler drives runPruneOnce on the configured cadence and returns a stop() fn', () => {
    const setIntervalCalls = [];
    const clearIntervalCalls = [];
    const fakeHandle = Symbol('fake-timer');
    const timers = {
      setInterval: (fn, ms) => {
        setIntervalCalls.push({ fn, ms });
        return fakeHandle;
      },
      clearInterval: (h) => {
        clearIntervalCalls.push(h);
      },
    };

    const info = jest.fn();
    const stop = scheduler.startPruneScheduler({
      db,
      intervalMs: 42_000,
      graceSec: 3600,
      logger: { info, error: jest.fn() },
      timers,
    });

    expect(typeof stop).toBe('function');
    expect(setIntervalCalls.length).toBe(1);
    expect(setIntervalCalls[0].ms).toBe(42_000);
    expect(typeof setIntervalCalls[0].fn).toBe('function');

    // Invoking the registered tick manually runs a real prune.
    expect(() => setIntervalCalls[0].fn()).not.toThrow();

    stop();
    expect(clearIntervalCalls).toEqual([fakeHandle]);
  });

  test('startPruneScheduler falls back to DEFAULTS.intervalMs when intervalMs is omitted', () => {
    const timers = {
      setInterval: jest.fn(() => Symbol('h')),
      clearInterval: jest.fn(),
    };
    const stop = scheduler.startPruneScheduler({
      db,
      logger: { info: jest.fn(), error: jest.fn() },
      timers,
    });
    expect(timers.setInterval).toHaveBeenCalledTimes(1);
    const ms = timers.setInterval.mock.calls[0][1];
    expect(ms).toBe(scheduler.DEFAULTS.intervalMs);
    stop();
  });

  test('startPruneScheduler unrefs the interval when possible (does not block process exit)', () => {
    const unref = jest.fn();
    const handle = { unref };
    const timers = {
      setInterval: () => handle,
      clearInterval: () => {},
    };
    const stop = scheduler.startPruneScheduler({
      db,
      logger: { info: jest.fn(), error: jest.fn() },
      timers,
    });
    expect(unref).toHaveBeenCalledTimes(1);
    stop();
  });
});
