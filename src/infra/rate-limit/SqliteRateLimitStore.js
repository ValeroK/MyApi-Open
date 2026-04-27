// SqliteRateLimitStore — fixed-window rate-limit driver on SQLite.
//
// Schema (created on first construction, IF NOT EXISTS):
//   CREATE TABLE rate_limit_counters (
//     key                TEXT PRIMARY KEY,
//     count              INTEGER NOT NULL,
//     window_started_at  INTEGER NOT NULL,
//     window_ms          INTEGER NOT NULL
//   );
//   CREATE INDEX idx_rate_limit_counters_window
//     ON rate_limit_counters(window_started_at);
//
// Following the pattern set by `better-sqlite3-session-store`, the
// table is created in-place rather than via a migration file. This
// keeps T4.5 self-contained — T4.6 will not need a migration commit.
//
// `consume()` is a single atomic UPSERT (INSERT … ON CONFLICT DO
// UPDATE) so two parallel requests for the same key cannot both pass
// while the bucket is at the limit. We rely on better-sqlite3's
// synchronous transaction semantics.
//
// A periodic GC clears expired rows. The interval handle is captured
// + .unref()'d, and `close()` is idempotent — same orphan-timer
// discipline as `MemoryRateLimitStore` and `SqliteSessionStore`.

'use strict';

const DEFAULT_GC_INTERVAL_MS = 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rate_limit_counters (
    key                TEXT PRIMARY KEY,
    count              INTEGER NOT NULL,
    window_started_at  INTEGER NOT NULL,
    window_ms          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window
    ON rate_limit_counters(window_started_at);
`;

class SqliteRateLimitStore {
  /**
   * @param {object} options
   * @param {import('better-sqlite3').Database} options.db
   * @param {number} [options.gcIntervalMs=60000]
   * @param {() => number} [options.now=Date.now]
   */
  constructor({ db, gcIntervalMs = DEFAULT_GC_INTERVAL_MS, now = Date.now } = {}) {
    if (!db) {
      throw new Error('SqliteRateLimitStore: `db` (better-sqlite3 Database) is required');
    }
    this._db = db;
    this._now = now;

    this._db.exec(SCHEMA);

    this._stmtSelect = this._db.prepare(
      'SELECT count, window_started_at, window_ms FROM rate_limit_counters WHERE key = ?',
    );
    this._stmtUpsertNew = this._db.prepare(
      `INSERT INTO rate_limit_counters (key, count, window_started_at, window_ms)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = rate_limit_counters.count + 1`,
    );
    this._stmtResetWindow = this._db.prepare(
      `UPDATE rate_limit_counters
       SET count = 1, window_started_at = ?, window_ms = ?
       WHERE key = ?`,
    );
    this._stmtDelete = this._db.prepare('DELETE FROM rate_limit_counters WHERE key = ?');
    this._stmtSweep = this._db.prepare(
      'DELETE FROM rate_limit_counters WHERE window_started_at + window_ms < ?',
    );

    // Single-statement consume executed in a SQLite transaction so the
    // read-decide-write happens atomically per key.
    this._consumeTxn = this._db.transaction((key, max, windowMs, now) => {
      const row = this._stmtSelect.get(key);
      const inWindow = row && now - row.window_started_at < row.window_ms;

      if (!inWindow) {
        this._stmtResetWindow.run(now, windowMs, key);
        if (!row) {
          // first-ever key — UPDATE matched 0 rows; insert it
          this._stmtUpsertNew.run(key, now, windowMs);
        }
        const resetAt = now + windowMs;
        return {
          allowed: true,
          remaining: Math.max(0, max - 1),
          retryAfterSec: Math.max(0, Math.ceil((resetAt - now) / 1000)),
          resetAt,
          limit: max,
        };
      }

      const resetAt = row.window_started_at + row.window_ms;
      const retryAfterSec = Math.max(0, Math.ceil((resetAt - now) / 1000));

      if (row.count >= max) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSec: Math.max(1, retryAfterSec),
          resetAt,
          limit: max,
        };
      }

      this._stmtUpsertNew.run(key, now, windowMs);
      return {
        allowed: true,
        remaining: Math.max(0, max - (row.count + 1)),
        retryAfterSec,
        resetAt,
        limit: max,
      };
    });

    this._gcInterval = setInterval(() => this._sweep(), gcIntervalMs);
    if (typeof this._gcInterval.unref === 'function') this._gcInterval.unref();
  }

  consume(key, max, windowMs) {
    return this._consumeTxn(key, max, windowMs, this._now());
  }

  reset(key) {
    this._stmtDelete.run(key);
  }

  _sweep() {
    try {
      this._stmtSweep.run(this._now());
    } catch (_err) {
      // Sweep failures are non-fatal — the next consume() handles a
      // stale row by overwriting it.
    }
  }

  close() {
    if (this._gcInterval) {
      clearInterval(this._gcInterval);
      this._gcInterval = null;
    }
  }
}

module.exports = { SqliteRateLimitStore };
