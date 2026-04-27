// RateLimitStore — interface contract for rate-limiting backends.
//
// ADR-0002 introduces a `RateLimitStore` interface alongside
// `SessionStore` so the rate-limit logic in `src/index.js` can stop
// using bespoke in-memory `Map`s. The interface is driver-agnostic:
// memory and sqlite are implemented in this folder; redis (T4.6 in
// the cleanup plan) plugs in later.
//
// Semantic choice: fixed-window
// -----------------------------
// The bespoke implementation in `src/index.js` uses sliding-log
// (an array of timestamps per key, count those within `windowMs`).
// That is precise but it allocates per request and stores a row per
// timestamp, which is O(req) for SQLite — orders of magnitude worse
// than fixed-window. We deliberately switch to fixed-window so the
// SQLite driver is O(1) per request.
//
// Trade-off: a burst landing at the window boundary can allow up to
// 2× the limit in the worst case. G4.1 (rate-limit contract) pins the
// 429 envelope shape, NOT the burst-precision behavior, so this
// trade-off is within the M4 contract. If a stricter window is ever
// needed we can add a `SlidingWindowStore` driver alongside.
//
// Contract
// --------
// consume(key, max, windowMs) → { allowed, remaining, retryAfterSec,
//                                 resetAt, limit }
//   - allowed:        true if the request fits in the current window
//   - remaining:      requests remaining in the current window after
//                     this consume; >= 0
//   - retryAfterSec:  whole seconds until the window resets;
//                     populated even when allowed=true so the caller
//                     can emit RateLimit-Reset headers
//   - resetAt:        millisecond epoch the window resets at
//   - limit:          echo of the `max` parameter
//
// reset(key) → void
//   - clears the bucket for `key`. Used on logout / admin override.
//
// close() → void
//   - graceful shutdown — clears any GC timer the driver scheduled.
//   - MUST be idempotent.
//
// All methods MUST be synchronous in the memory and sqlite drivers.
// The redis driver will return Promises — at that point we'll widen
// the contract to "synchronous OR thenable" and require callers to
// await; until then, callers can rely on synchronous return values.

'use strict';

/**
 * Runtime sanity check used by contract tests. Verifies the shape
 * of a rate-limit-store-like object without exercising it.
 *
 * @param {unknown} store
 * @returns {{ ok: boolean, missing: string[] }}
 */
function describeRateLimitStoreShape(store) {
  const required = ['consume', 'reset', 'close'];
  const missing = [];
  for (const name of required) {
    if (!store || typeof store[name] !== 'function') missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

module.exports = { describeRateLimitStoreShape };
