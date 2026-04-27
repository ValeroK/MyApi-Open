// MemoryRateLimitStore — fixed-window rate-limit driver in-process.
//
// Replaces the bespoke `globalRateLimitMap` and `rateLimitMap` in
// `src/index.js`. Map-of-buckets, one entry per key. A single GC
// interval evicts buckets whose window expired more than `gcAfterMs`
// ago (default: one full window).
//
// The GC timer:
//   - is created with .unref() so it never blocks process exit,
//   - is captured by `close()` so tests can stop it deterministically.
// This is the contract every M4 driver follows — no orphan timers.

'use strict';

const DEFAULT_GC_INTERVAL_MS = 60 * 1000;

class MemoryRateLimitStore {
  /**
   * @param {object} [options]
   * @param {number} [options.gcIntervalMs=60000] sweep frequency
   * @param {() => number} [options.now=Date.now] injectable clock for tests
   */
  constructor({ gcIntervalMs = DEFAULT_GC_INTERVAL_MS, now = Date.now } = {}) {
    /** @type {Map<string, { count: number, windowStartedAt: number, windowMs: number }>} */
    this._buckets = new Map();
    this._now = now;

    this._gcInterval = setInterval(() => this._sweep(), gcIntervalMs);
    if (typeof this._gcInterval.unref === 'function') this._gcInterval.unref();
  }

  /**
   * @param {string} key
   * @param {number} max
   * @param {number} windowMs
   */
  consume(key, max, windowMs) {
    const now = this._now();
    let b = this._buckets.get(key);

    if (!b || now - b.windowStartedAt >= b.windowMs) {
      b = { count: 0, windowStartedAt: now, windowMs };
      this._buckets.set(key, b);
    }

    const resetAt = b.windowStartedAt + b.windowMs;
    const retryAfterSec = Math.max(0, Math.ceil((resetAt - now) / 1000));

    if (b.count >= max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, retryAfterSec),
        resetAt,
        limit: max,
      };
    }

    b.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, max - b.count),
      retryAfterSec,
      resetAt,
      limit: max,
    };
  }

  reset(key) {
    this._buckets.delete(key);
  }

  /**
   * Drop buckets whose window has fully elapsed. Cheap O(n) sweep —
   * acceptable for the workloads M4 targets (low-thousands of unique
   * keys per minute). Called by the GC interval.
   */
  _sweep() {
    const now = this._now();
    for (const [key, b] of this._buckets) {
      if (now - b.windowStartedAt >= b.windowMs) {
        this._buckets.delete(key);
      }
    }
  }

  close() {
    if (this._gcInterval) {
      clearInterval(this._gcInterval);
      this._gcInterval = null;
    }
  }
}

module.exports = { MemoryRateLimitStore };
