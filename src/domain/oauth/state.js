'use strict';

/**
 * OAuth state-token domain module.
 *
 * This is the single entry point for the OAuth state lifecycle. Routes
 * (authorize / callback) and scheduled jobs (prune) talk to this module
 * — they MUST NOT hand-roll SQL against the `oauth_state_tokens` table,
 * and they MUST NOT use `req.session` to remember state metadata.
 *
 * Closes H1 ("deterministic PKCE verifier") from plan.md §6.3 by
 * issuing a fresh random 32-byte verifier per flow, stored alongside
 * the state row. Contributes to the closure of C3 ("OAuth state not
 * DB-validated") by making every state lookup a transactional
 * read-then-mark on the DB (not the session).
 *
 * Column-name mapping to ADR-0006 §Schema:
 *
 *   ADR-0006 name    |  Column in oauth_state_tokens (this repo)
 *   ---------------- +  -------------------------------------------
 *   `state`          →  `state_token`
 *   `service`        →  `service_name`
 *   all others       →  same name
 *
 * The mapping is hidden behind this module's API so callers see the
 * ADR-0006 contract (`state`, `serviceName`) on the outside while the
 * DB stays consistent with pre-M3 columns on the inside.
 *
 * Related:
 *   - ADR-0006  (target design)
 *   - ADR-0014  (M3 execution playbook)
 *   - TASKS.md  T3.2 + T3.3
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants + errors
// ---------------------------------------------------------------------------

/**
 * Modes accepted by {@link createStateToken}.
 *
 * ADR-0006 §Schema canonicalises three values (`login`, `link`, `install`).
 * This codebase exposes `connect` in the public `?mode=` query string for
 * the "link an OAuth provider to an already-authenticated account" flow,
 * which is the same concept ADR-0006 calls `link`. Rather than rewrite
 * every caller, we accept the legacy label here and store it verbatim —
 * the callback handler (M3 Step 5) treats `connect` and `link` as
 * equivalent for its redirect-string decisions.
 */
const VALID_MODES = Object.freeze(['login', 'link', 'install', 'connect']);

/** Symbolic error codes surfaced to HTTP handlers. */
const CODES = Object.freeze({
  NOT_FOUND: 'STATE_NOT_FOUND',
  EXPIRED: 'STATE_EXPIRED',
  REUSED: 'STATE_REUSED',
  SERVICE_MISMATCH: 'STATE_SERVICE_MISMATCH',
  INVALID_MODE: 'STATE_INVALID_MODE',
  INVALID_SERVICE: 'STATE_INVALID_SERVICE',
});

/**
 * Narrow error type so HTTP handlers can `switch (err.code)` without
 * pattern-matching on message strings. `.code` is always one of
 * {@link CODES}; anything else is a programming error and should
 * propagate.
 */
class StateTokenError extends Error {
  /**
   * @param {string} code  One of {@link CODES}.
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message || code);
    this.name = 'StateTokenError';
    this.code = code;
  }
}
StateTokenError.CODES = CODES;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Random URL-safe 32-byte value, base64url-encoded (length 43, no
 * padding). Used for both `state` and `code_verifier` — 256 bits of
 * entropy each, drawn independently.
 * @returns {string}
 */
function randomBase64Url32() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * PKCE S256 challenge: `base64url(sha256(code_verifier))`. Exposed so
 * the behavioural suite can check RFC 7636 Appendix B vector.
 * @param {string} verifier
 * @returns {string}
 */
function computeCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * All timestamp columns in `oauth_state_tokens` are ISO-8601 strings,
 * consistent with every other timestamp column in the schema.
 * @param {number} msEpoch
 * @returns {string}
 */
function iso(msEpoch) {
  return new Date(msEpoch).toISOString();
}

// ---------------------------------------------------------------------------
// createStateToken
// ---------------------------------------------------------------------------

/**
 * Issue a new OAuth state row. Safe to call from any route handler; the
 * caller supplies the live DB handle.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.serviceName  OAuth provider id (e.g. `google`).
 * @param {'login'|'link'|'install'} opts.mode
 * @param {string} [opts.returnTo]   Post-callback redirect target.
 *                                   NOT validated here — call sites MUST
 *                                   pass it through `isSafeInternalRedirect`.
 * @param {string} [opts.userId]     Populated only for `link` flows.
 * @param {number} [opts.ttlSec=600] TTL in seconds (default 10 minutes,
 *                                   per ADR-0006).
 * @param {number} [opts.now]        Injected clock for deterministic
 *                                   tests; defaults to `Date.now()`.
 * @returns {{
 *   id: string,
 *   state: string,
 *   codeVerifier: string,
 *   codeChallenge: string,
 *   expiresAt: string,
 *   createdAt: string,
 * }}
 * @throws {StateTokenError} `INVALID_SERVICE` / `INVALID_MODE`.
 */
function createStateToken({
  db,
  serviceName,
  mode,
  returnTo = null,
  userId = null,
  ttlSec = 600,
  now = Date.now(),
} = {}) {
  if (typeof serviceName !== 'string' || serviceName.length === 0) {
    throw new StateTokenError(
      CODES.INVALID_SERVICE,
      'serviceName is required'
    );
  }
  if (!VALID_MODES.includes(mode)) {
    throw new StateTokenError(
      CODES.INVALID_MODE,
      `mode must be one of ${VALID_MODES.join(', ')}; received "${mode}"`
    );
  }

  const id = crypto.randomUUID();
  const state = randomBase64Url32();
  const codeVerifier = randomBase64Url32();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const createdAt = iso(now);
  const expiresAt = iso(now + ttlSec * 1000);

  db.prepare(
    `INSERT INTO oauth_state_tokens (
       id, state_token, service_name, user_id, mode, return_to,
       code_verifier, created_at, expires_at, used_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    id,
    state,
    serviceName,
    userId,
    mode,
    returnTo,
    codeVerifier,
    createdAt,
    expiresAt
  );

  return { id, state, codeVerifier, codeChallenge, expiresAt, createdAt };
}

// ---------------------------------------------------------------------------
// consumeStateToken
// ---------------------------------------------------------------------------

/**
 * Look up a state row, validate it, and mark it used. The guarded
 * UPDATE (`WHERE state_token = ? AND used_at IS NULL`) gives us the
 * "first wins, rest see STATE_REUSED" guarantee at the row level —
 * SQLite serializes writes to the same row in WAL mode, so two callers
 * racing to consume the same state will see `result.changes` go to 0
 * for the loser. We don't wrap in `db.transaction()` because this
 * repo's `SQLiteAdapter.transaction()` is an async-Promise wrapper
 * (see `src/lib/db-abstraction.js`), incompatible with the native
 * sync semantics; the single-statement UPDATE guard is portable and
 * gives the same invariant.
 *
 * A service mismatch intentionally does NOT consume the row: a benign
 * retry with the correct service still succeeds. Missing / expired /
 * reused cases never touch `used_at`.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.state
 * @param {string} opts.serviceName
 * @param {number} [opts.now] Injected clock.
 * @returns {object} the consumed row, with `used_at` populated.
 * @throws {StateTokenError}
 *   - `NOT_FOUND`        — no row with that state.
 *   - `EXPIRED`          — `now > expires_at`.
 *   - `REUSED`           — `used_at IS NOT NULL`, or a concurrent
 *                          consumer marked it between our SELECT and
 *                          UPDATE.
 *   - `SERVICE_MISMATCH` — row exists but belongs to a different provider.
 */
function consumeStateToken({
  db,
  state,
  serviceName,
  now = Date.now(),
} = {}) {
  const row = db
    .prepare('SELECT * FROM oauth_state_tokens WHERE state_token = ?')
    .get(state);

  if (!row) {
    throw new StateTokenError(CODES.NOT_FOUND);
  }
  if (row.service_name !== serviceName) {
    throw new StateTokenError(
      CODES.SERVICE_MISMATCH,
      `state was issued for "${row.service_name}", received "${serviceName}"`
    );
  }
  if (row.used_at !== null && row.used_at !== undefined) {
    throw new StateTokenError(CODES.REUSED);
  }
  if (new Date(row.expires_at).getTime() <= now) {
    throw new StateTokenError(CODES.EXPIRED);
  }

  const usedAt = iso(now);
  const result = db
    .prepare(
      'UPDATE oauth_state_tokens SET used_at = ? WHERE state_token = ? AND used_at IS NULL'
    )
    .run(usedAt, state);

  // Race guard: if someone else won between SELECT and UPDATE we affect
  // 0 rows; treat that identically to "already used".
  if (result.changes === 0) {
    throw new StateTokenError(CODES.REUSED);
  }

  return { ...row, used_at: usedAt };
}

// ---------------------------------------------------------------------------
// pruneExpiredStateTokens
// ---------------------------------------------------------------------------

/**
 * Delete rows that are past the grace window — either because they
 * expired without being used, or because they were consumed more than
 * `graceSec` seconds ago. Called by the background scheduler in
 * Step 8 / T3.9.
 *
 * The grace window exists so a late but well-formed callback doesn't
 * race the pruner and end up with a misleading STATE_NOT_FOUND; the
 * row sticks around long enough to yield STATE_EXPIRED instead.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {number} [opts.now]
 * @param {number} [opts.graceSec=3600]
 * @returns {{ removed: number }}
 */
function pruneExpiredStateTokens({
  db,
  now = Date.now(),
  graceSec = 3600,
} = {}) {
  const cutoff = iso(now - graceSec * 1000);
  const result = db
    .prepare(
      `DELETE FROM oauth_state_tokens
         WHERE expires_at < ?
            OR (used_at IS NOT NULL AND used_at < ?)`
    )
    .run(cutoff, cutoff);
  return { removed: result.changes };
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

module.exports = {
  createStateToken,
  consumeStateToken,
  pruneExpiredStateTokens,
  computeCodeChallenge,
  StateTokenError,
  VALID_MODES,
};
