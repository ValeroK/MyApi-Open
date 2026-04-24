/**
 * OAuth prune scheduler — M3 Step 8 / T3.9.
 *
 * Thin composition layer on top of the two domain primitives that
 * burn down "used to matter, no longer matters" OAuth rows:
 *
 *   - `pruneExpiredStateTokens`   (./state.js,           shipped in T3.2)
 *   - `pruneExpiredPendingConfirms` (./pending-confirm.js, shipped in T3.7)
 *
 * Why a separate module? Two reasons:
 *
 *   1. The primitives are pure and timer-free by design (they're unit-
 *      tested against an injected clock). The scheduling glue — the
 *      `setInterval`, the env-var-driven configuration, and the
 *      structured log line — is the only thing left that has to live
 *      somewhere, and it shouldn't contaminate those pure modules.
 *   2. `src/index.js` is already ~12.7k LOC and the existing
 *      `setInterval` blocks in there are a grab bag of unrelated
 *      cleanup jobs (rate-limit GC, session GC, retention, AFP
 *      heartbeat). Keeping the OAuth scheduler here means M6 (the
 *      monolith extraction) doesn't have to fish it out later.
 *
 * Contract:
 *
 *   runPruneOnce({ db, now?, graceSec?, logger? })
 *     → { prunedState: number, prunedPending: number, elapsedMs: number }
 *
 *     Synchronous. NEVER throws — a failure in either underlying
 *     prune is swallowed, reported via `logger.error`, and the other
 *     prune still runs. The return value reflects whatever did land.
 *     Emits exactly one `logger.info` line PER TICK ("prune tick
 *     completed" + counts) so operators can verify the scheduler is
 *     actually firing. The prior "silent when nothing got pruned"
 *     design traded observability for noise budget; at default
 *     intervalMs=600_000 that's ~144 lines/day which is fine.
 *
 *   startPruneScheduler({ db, intervalMs?, graceSec?, logger?, timers? })
 *     → stop(): void
 *
 *     Registers a recurring tick via `timers.setInterval`
 *     (defaults to the Node builtins). Calls `.unref()` on the handle
 *     when available so an idle scheduler never blocks process exit
 *     — important for tests and for `process.exit()`-style shutdowns.
 *     The returned `stop()` calls `timers.clearInterval(handle)`.
 *
 *     `intervalMs` defaults to `DEFAULTS.intervalMs` (10 min).
 *     `graceSec`   defaults to `DEFAULTS.graceSec`   (1 hour).
 *     `timers`     defaults to `{ setInterval, clearInterval }`.
 *     `logger`     defaults to a console-backed shim.
 *
 * Env var overrides (consumed at the caller — `src/index.js` — so the
 * module stays deterministic for unit tests):
 *
 *   OAUTH_PRUNE_INTERVAL_MS   integer ≥ 1000, overrides DEFAULTS.intervalMs
 *   OAUTH_PRUNE_GRACE_SEC     integer ≥ 0,    overrides DEFAULTS.graceSec
 */

'use strict';

const { pruneExpiredStateTokens } = require('./state');
const pendingConfirm = require('./pending-confirm');

/**
 * Frozen defaults so the tests and the bootstrap share one truth.
 *
 * - `intervalMs = 600_000` (10 min). Short enough that a burst of
 *   expired rows clears promptly; long enough that a failing prune
 *   doesn't flood the logs.
 * - `graceSec  = 3600` (1 h).       Honours the same grace window
 *   the domain primitives already default to, so "I can still see
 *   what happened" stays true for an hour after expiry.
 */
const DEFAULTS = Object.freeze({
  intervalMs: 10 * 60 * 1000,
  graceSec: 3600,
});

/** Default logger shim used when the caller didn't pass one. */
const DEFAULT_LOGGER = Object.freeze({
  info: (msg, payload) => {
    try {
      console.log(
        `[OAuth Prune] ${msg}`,
        payload ? JSON.stringify(payload) : ''
      );
    } catch (_) {
      // Logger failures are never fatal.
    }
  },
  error: (msg, err) => {
    try {
      console.error(`[OAuth Prune] ${msg}`, err || '');
    } catch (_) {
      // ditto
    }
  },
});

function now() {
  return Date.now();
}

/**
 * Run one prune tick.
 *
 * @param {object} opts
 * @param {object} opts.db         better-sqlite3 handle.
 * @param {number} [opts.now]      Millis since epoch. Defaults to
 *                                 `Date.now()`. Injectable for tests.
 * @param {number} [opts.graceSec] Passed to both underlying prunes.
 *                                 Defaults to `DEFAULTS.graceSec`.
 * @param {{info, error}} [opts.logger]
 * @returns {{ prunedState: number, prunedPending: number, elapsedMs: number }}
 */
function runPruneOnce({
  db,
  now: nowMs = now(),
  graceSec = DEFAULTS.graceSec,
  logger = DEFAULT_LOGGER,
} = {}) {
  const t0 = Date.now();
  let prunedState = 0;
  let prunedPending = 0;

  try {
    const result = pruneExpiredStateTokens({ db, now: nowMs, graceSec });
    prunedState = (result && result.removed) || 0;
  } catch (err) {
    // Swallow + log — we still want the pending-confirm side to run.
    try {
      logger.error('state-token prune failed', err);
    } catch (_) {
      // Ignore logger failures.
    }
  }

  try {
    const result = pendingConfirm.pruneExpiredPendingConfirms({
      db,
      now: nowMs,
      graceSec,
    });
    prunedPending = (result && result.removed) || 0;
  } catch (err) {
    try {
      logger.error('pending-confirm prune failed', err);
    } catch (_) {
      // ignore
    }
  }

  const elapsedMs = Date.now() - t0;

  // Observability (2026-04-24 F4 hardening): emit a heartbeat line on
  // EVERY tick, not only when something got pruned. Previously the
  // scheduler was silent at info level during healthy steady state —
  // fine for noise budget, dangerous for "is the scheduler even
  // running?" incidents. 1 line / 10 min (default interval) = ~144
  // lines per day, well within sane logging budgets, and during an
  // outage you can immediately confirm the tick is firing.
  try {
    logger.info('prune tick completed', {
      pruned_state: prunedState,
      pruned_pending: prunedPending,
      elapsed_ms: elapsedMs,
    });
  } catch (_) {
    // Logger is best-effort.
  }

  return { prunedState, prunedPending, elapsedMs };
}

/**
 * Start the recurring scheduler.
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.graceSec]
 * @param {{info, error}} [opts.logger]
 * @param {{setInterval, clearInterval}} [opts.timers]
 * @returns {() => void} stop() — clears the scheduled interval.
 */
function startPruneScheduler({
  db,
  intervalMs = DEFAULTS.intervalMs,
  graceSec = DEFAULTS.graceSec,
  logger = DEFAULT_LOGGER,
  timers,
} = {}) {
  const t = timers || { setInterval, clearInterval };

  const handle = t.setInterval(() => {
    runPruneOnce({ db, graceSec, logger });
  }, intervalMs);

  // Don't block process exit on the scheduler. In Node this is a
  // method on the returned Timeout; in our injected test timers
  // `handle` may not carry `unref`, so guard both branches.
  if (handle && typeof handle.unref === 'function') {
    try {
      handle.unref();
    } catch (_) {
      // unref failures are never fatal.
    }
  }

  return function stop() {
    t.clearInterval(handle);
  };
}

module.exports = {
  runPruneOnce,
  startPruneScheduler,
  DEFAULTS,
};
