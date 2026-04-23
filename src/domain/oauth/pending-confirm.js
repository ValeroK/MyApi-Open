'use strict';

/**
 * OAuth pending-login confirm domain module (M3 Step 6 / T3.7).
 *
 * Single entry point for the post-callback "did the user consent to log
 * in as X?" lifecycle. Routes (callback / confirm / confirm-preview /
 * confirm-reject) and scheduled jobs (prune) MUST go through this
 * module — they MUST NOT hand-roll SQL against `oauth_pending_logins`
 * and they MUST NOT persist pending-login metadata on `req.session`.
 * This mirrors the ADR-0006 / Step 5 invariant already enforced for
 * `oauth_state_tokens` in `src/domain/oauth/state.js`.
 *
 * Responsibilities closed here:
 *
 *   - C3 (session-fixation variant): the OAuth callback no longer
 *     silently logs the user in. Instead it issues a row in
 *     `oauth_pending_logins` and redirects to a gesture screen; the
 *     gesture screen drives this module to either accept (set
 *     `req.session.user`) or reject (burn the row with
 *     `outcome='rejected'`). The gesture is skipped only when the
 *     `{service, user, provider_subject}` tuple has a non-NULL
 *     `first_confirmed_at` on `oauth_tokens` — see ADR-0016 for why we
 *     key on `provider_subject` rather than just `(service, user)`.
 *
 *   - Audit trail: every pending-login ends in exactly one of
 *     `outcome IN ('accepted', 'rejected')`, or it expires untouched and
 *     is pruned. There is no "silently dropped" path.
 *
 * Schema coupling
 * ---------------
 * Adds the following columns (migration in `src/database.js`):
 *
 *   oauth_pending_logins
 *     + used_at    TEXT NULL     -- set inside the same guarded UPDATE
 *                                 -- that burns the row; first write wins.
 *     + outcome    TEXT NULL     -- 'accepted' | 'rejected', set alongside
 *                                 -- used_at. The prune job owns deletion.
 *
 *   oauth_tokens
 *     + provider_subject      TEXT NULL  -- the provider's stable
 *                                         -- subject/id (Google `sub`,
 *                                         -- GitHub `id`, etc). Used as
 *                                         -- the first-seen key.
 *     + first_confirmed_at    TEXT NULL  -- ISO-8601 timestamp of the
 *                                         -- FIRST successful accept for
 *                                         -- this `{service, user,
 *                                         -- provider_subject}` tuple.
 *                                         -- NULL ⇒ gesture required.
 *
 * Related:
 *   - ADR-0006  (target OAuth design — row is SSOT, no session)
 *   - ADR-0014  (M3 execution playbook)
 *   - ADR-0016  (first-seen keying on `{service, user, provider_subject}`)
 *   - TASKS.md  T3.7
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants + errors
// ---------------------------------------------------------------------------

/**
 * Valid values for `consumePendingConfirm({ outcome })`. Any other value
 * raises `INVALID_OUTCOME` *without* consuming the row — a benign retry
 * with a valid outcome still succeeds. Frozen so callers can't mutate
 * the array at runtime.
 */
const VALID_OUTCOMES = Object.freeze(['accepted', 'rejected']);

/** Symbolic error codes surfaced to HTTP handlers. */
const CODES = Object.freeze({
  NOT_FOUND: 'PENDING_CONFIRM_NOT_FOUND',
  EXPIRED: 'PENDING_CONFIRM_EXPIRED',
  REUSED: 'PENDING_CONFIRM_REUSED',
  INVALID_OUTCOME: 'PENDING_CONFIRM_INVALID_OUTCOME',
});

/**
 * Narrow error type so HTTP handlers can `switch (err.code)` without
 * pattern-matching on message strings. `.code` is always one of
 * {@link CODES}; anything else is a programming error and should
 * propagate.
 */
class PendingConfirmError extends Error {
  /**
   * @param {string} code  One of {@link CODES}.
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message || code);
    this.name = 'PendingConfirmError';
    this.code = code;
  }
}
PendingConfirmError.CODES = CODES;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Random URL-safe 32-byte value, base64url-encoded (length 43, no
 * padding). 256 bits of entropy — same envelope as the state token
 * issued by `state.js`. The pending-confirm token doubles as both
 * the `token` column in `oauth_pending_logins` AND the bearer secret
 * shown to the gesture page, so it must be unpredictable.
 * @returns {string}
 */
function randomBase64Url32() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * All timestamp columns are ISO-8601 UTC strings, consistent with the
 * rest of the schema.
 * @param {number} msEpoch
 * @returns {string}
 */
function iso(msEpoch) {
  return new Date(msEpoch).toISOString();
}

// ---------------------------------------------------------------------------
// createPendingConfirm
// ---------------------------------------------------------------------------

/**
 * Issue a pending-login confirm row. Called by the OAuth callback
 * handler *after* state/code exchange has succeeded but *before* the
 * user is logged in — the row is what the gesture page consumes.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.serviceName   OAuth provider id (`google`, `github`, …)
 * @param {string} opts.userId        The MyApi `users.id` resolved by the
 *                                    callback (may be a freshly-minted
 *                                    account for pure-login flows).
 * @param {string} opts.providerSubject  Stable provider-side id (Google
 *                                    `sub`, GitHub `id`, …). Persisted
 *                                    in `user_data` JSON AND consulted by
 *                                    `hasConfirmedBefore` on the next
 *                                    login.
 * @param {object} opts.userData      Identity payload the gesture page
 *                                    needs to render: `{ email,
 *                                    displayName, avatarUrl, accessToken?,
 *                                    ... }`. Stored as JSON verbatim —
 *                                    callers decide what's included.
 * @param {number} [opts.ttlSec=300]  TTL in seconds. Default 5 minutes:
 *                                    long enough for a human to click
 *                                    "Continue", short enough to not
 *                                    leave tokens lying around.
 * @param {number} [opts.now=Date.now()]  Injected clock for tests.
 * @returns {{ id: string, token: string, expiresAt: string, createdAt: string }}
 */
function createPendingConfirm({
  db,
  serviceName,
  userId,
  providerSubject,
  userData,
  ttlSec = 300,
  now = Date.now(),
} = {}) {
  const id = 'pending_' + crypto.randomBytes(16).toString('hex');
  const token = randomBase64Url32();
  const createdAt = iso(now);
  const expiresAt = iso(now + ttlSec * 1000);

  // Stamp provider_subject into the JSON payload so the row is a
  // self-contained record of "who were we about to log in" — the
  // callback handler sets `first_confirmed_at` using this value after
  // an accept, and an audit trail reading the row after the fact can
  // see the subject without a cross-table join.
  const payload = { ...(userData || {}), providerSubject };

  db.prepare(
    `INSERT INTO oauth_pending_logins
       (id, service_name, user_id, token, user_data, created_at,
        expires_at, used_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
  ).run(
    id,
    serviceName,
    userId,
    token,
    JSON.stringify(payload),
    createdAt,
    expiresAt
  );

  return { id, token, expiresAt, createdAt };
}

// ---------------------------------------------------------------------------
// previewPendingConfirm
// ---------------------------------------------------------------------------

/**
 * Read-only inspection of a pending-login row for the gesture page.
 * Returns the fields the UI needs to render "Continue as Alice
 * <alice@example.com>?" without revealing the encrypted access/refresh
 * tokens stored alongside them in `user_data`.
 *
 * Does NOT mark the row as used — the gesture page is expected to
 * preview and then POST to `/confirm` (accept) or `/confirm/reject`
 * (reject) with the same token. The preview endpoint is intentionally
 * GET-able because the whole point is to let the user *see* what
 * they're about to approve before committing.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.token
 * @param {number} [opts.now=Date.now()]
 * @returns {{
 *   serviceName: string,
 *   email: string|null,
 *   displayName: string|null,
 *   avatarUrl: string|null,
 *   providerSubject: string|null,
 *   expiresAt: string,
 * }}
 * @throws {PendingConfirmError}
 *   - `NOT_FOUND`  — no row with that token.
 *   - `REUSED`     — row has been consumed (accepted/rejected).
 *   - `EXPIRED`    — `now > expires_at`.
 */
function previewPendingConfirm({ db, token, now = Date.now() } = {}) {
  const row = db
    .prepare('SELECT * FROM oauth_pending_logins WHERE token = ?')
    .get(token);

  if (!row) {
    throw new PendingConfirmError(CODES.NOT_FOUND);
  }
  if (row.used_at !== null && row.used_at !== undefined) {
    throw new PendingConfirmError(CODES.REUSED);
  }
  if (new Date(row.expires_at).getTime() <= now) {
    throw new PendingConfirmError(CODES.EXPIRED);
  }

  let payload = {};
  try {
    payload = JSON.parse(row.user_data || '{}');
  } catch (_e) {
    payload = {};
  }

  return {
    serviceName: row.service_name,
    email: payload.email || null,
    displayName: payload.displayName || null,
    avatarUrl: payload.avatarUrl || null,
    providerSubject: payload.providerSubject || null,
    expiresAt: row.expires_at,
  };
}

// ---------------------------------------------------------------------------
// consumePendingConfirm
// ---------------------------------------------------------------------------

/**
 * Burn a pending-login row with a decisive outcome. Called by both the
 * accept-confirm endpoint (`outcome='accepted'`) and the reject-confirm
 * endpoint (`outcome='rejected'`). A guarded UPDATE (`WHERE used_at IS
 * NULL`) gives us the "first writer wins, all others see REUSED"
 * guarantee at the row level — SQLite serializes writes to the same
 * row so there is no race window between SELECT and UPDATE.
 *
 * Invariants:
 *   - An invalid `outcome` raises INVALID_OUTCOME *without* consuming
 *     the row (symmetric with state.js's SERVICE_MISMATCH behaviour).
 *   - Expired rows raise EXPIRED *without* setting used_at; the prune
 *     job is the sole owner of deletion.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.token
 * @param {'accepted'|'rejected'} opts.outcome
 * @param {number} [opts.now=Date.now()]
 * @returns {object} the consumed row, with `used_at` and `outcome` populated.
 * @throws {PendingConfirmError}
 *   - `INVALID_OUTCOME`
 *   - `NOT_FOUND`
 *   - `EXPIRED`
 *   - `REUSED`
 */
function consumePendingConfirm({
  db,
  token,
  outcome,
  now = Date.now(),
} = {}) {
  if (!VALID_OUTCOMES.includes(outcome)) {
    throw new PendingConfirmError(
      CODES.INVALID_OUTCOME,
      `outcome must be one of ${VALID_OUTCOMES.join(', ')}; received "${outcome}"`
    );
  }

  const row = db
    .prepare('SELECT * FROM oauth_pending_logins WHERE token = ?')
    .get(token);

  if (!row) {
    throw new PendingConfirmError(CODES.NOT_FOUND);
  }
  if (row.used_at !== null && row.used_at !== undefined) {
    throw new PendingConfirmError(CODES.REUSED);
  }
  if (new Date(row.expires_at).getTime() <= now) {
    throw new PendingConfirmError(CODES.EXPIRED);
  }

  const usedAt = iso(now);
  const result = db
    .prepare(
      `UPDATE oauth_pending_logins
         SET used_at = ?, outcome = ?
       WHERE token = ? AND used_at IS NULL`
    )
    .run(usedAt, outcome, token);

  // Race guard: if someone else won between SELECT and UPDATE we affect
  // 0 rows; surface that identically to "already used".
  if (result.changes === 0) {
    throw new PendingConfirmError(CODES.REUSED);
  }

  return { ...row, used_at: usedAt, outcome };
}

// ---------------------------------------------------------------------------
// hasConfirmedBefore / recordFirstConfirmation
// ---------------------------------------------------------------------------

/**
 * Is this `{service, user, provider_subject}` tuple already known to
 * have been confirmed? Callers (the OAuth callback) use this to decide
 * whether to short-circuit the gesture screen — if the user has
 * previously confirmed THIS provider subject for THIS local account,
 * show-again would be a pointless speed-bump.
 *
 * Keyed on provider_subject per ADR-0016: keying on just (service,
 * user_id) would let an attacker who temporarily gains callback-URL
 * control silently alias a SECOND provider account onto the pre-
 * confirmed row.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.userId
 * @param {string} opts.serviceName
 * @param {string} opts.providerSubject
 * @returns {boolean}
 */
function hasConfirmedBefore({
  db,
  userId,
  serviceName,
  providerSubject,
} = {}) {
  if (!userId || !serviceName || !providerSubject) {
    return false;
  }
  const row = db
    .prepare(
      `SELECT 1
         FROM oauth_tokens
        WHERE service_name = ?
          AND user_id = ?
          AND provider_subject = ?
          AND first_confirmed_at IS NOT NULL
        LIMIT 1`
    )
    .get(serviceName, userId, providerSubject);
  return !!row;
}

/**
 * Stamp the first-seen marker on the `oauth_tokens` row for this
 * `{service, user, provider_subject}` tuple. Idempotent: if the row
 * already has a `first_confirmed_at` for the same provider_subject we
 * leave it alone. If the row exists with a DIFFERENT
 * (or NULL) provider_subject, we OVERWRITE provider_subject *and*
 * (re)set first_confirmed_at to now — the previous subject is no
 * longer the identity on this row.
 *
 * If no `oauth_tokens` row exists for (service, user) this is a no-op
 * (the callback is expected to call `storeOAuthToken` before stamping
 * the marker; this module refuses to invent a token-less oauth_tokens
 * row because there's no access token to store).
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.userId
 * @param {string} opts.serviceName
 * @param {string} opts.providerSubject
 * @param {number} [opts.now=Date.now()]
 */
function recordFirstConfirmation({
  db,
  userId,
  serviceName,
  providerSubject,
  now = Date.now(),
} = {}) {
  if (!userId || !serviceName || !providerSubject) {
    return;
  }
  const confirmedAt = iso(now);
  db.prepare(
    `UPDATE oauth_tokens
        SET provider_subject = ?,
            first_confirmed_at = CASE
              WHEN provider_subject = ? AND first_confirmed_at IS NOT NULL
                THEN first_confirmed_at
              ELSE ?
            END
      WHERE service_name = ? AND user_id = ?`
  ).run(providerSubject, providerSubject, confirmedAt, serviceName, userId);
}

// ---------------------------------------------------------------------------
// pruneExpiredPendingConfirms
// ---------------------------------------------------------------------------

/**
 * Delete rows that are past the grace window — either because they
 * expired without being consumed, or because they were consumed more
 * than `graceSec` seconds ago. Called by the background scheduler
 * alongside `pruneExpiredStateTokens` in Step 8 / T3.9.
 *
 * The grace window exists so a late-but-valid confirm POST doesn't
 * race the pruner and end up with a misleading NOT_FOUND; the row
 * sticks around long enough to yield EXPIRED / REUSED instead.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {number} [opts.now=Date.now()]
 * @param {number} [opts.graceSec=3600]
 * @returns {{ removed: number }}
 */
function pruneExpiredPendingConfirms({
  db,
  now = Date.now(),
  graceSec = 3600,
} = {}) {
  const cutoff = iso(now - graceSec * 1000);
  const result = db
    .prepare(
      `DELETE FROM oauth_pending_logins
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
  createPendingConfirm,
  previewPendingConfirm,
  consumePendingConfirm,
  hasConfirmedBefore,
  recordFirstConfirmation,
  pruneExpiredPendingConfirms,
  PendingConfirmError,
  VALID_OUTCOMES,
};
