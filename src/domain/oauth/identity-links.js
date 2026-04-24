'use strict';

/**
 * OAuth identity-links domain module (F4 / ADR-0018).
 *
 * Single entry point for the "who is this person on Google/GitHub/Facebook"
 * lifecycle. Login-mode OAuth callbacks write here; service-mode does NOT.
 * This is the clean separation between:
 *
 *   - IDENTITY (this module): "MyApi user U authenticates as provider
 *     account P on service S". Minimal scope. One row per (user, provider).
 *     First-seen gesture state (ADR-0016) lives here.
 *
 *   - SERVICE (oauth_tokens): "MyApi user U has delegated service S with
 *     permissions X for proxied API calls". Full scope. Access + refresh
 *     tokens stored encrypted. Per-row `provider_subject` identifies WHICH
 *     provider account holds the grant — may differ from the identity
 *     account.
 *
 * Responsibilities closed here:
 *
 *   - ADR-0016 (first-seen gesture keying) — moved from `oauth_tokens` so
 *     a user who logs in with one Google account and connects a different
 *     Google account as a service doesn't trigger gesture thrash.
 *   - Cross-user hijack prevention — the UNIQUE index on
 *     (provider, provider_subject) stops a second MyApi user from
 *     claiming an already-linked provider identity.
 *
 * Routes (authorize / callback / confirm) MUST go through this module —
 * they MUST NOT hand-roll SQL against `user_identity_links` and they MUST
 * NOT store login-identity state on `oauth_tokens`. This mirrors the
 * ADR-0006 invariant already enforced for `oauth_state_tokens` in
 * `src/domain/oauth/state.js` and `oauth_pending_logins` in
 * `src/domain/oauth/pending-confirm.js`.
 *
 * Related:
 *   - ADR-0006  (OAuth design — row is SSOT, no session)
 *   - ADR-0014  (M3 execution playbook)
 *   - ADR-0016  (first-seen keying on {service, user, provider_subject})
 *   - ADR-0018  (F4 — identity vs service separation)
 *   - .context/tasks/in-progress/F4-oauth-identity-vs-service-separation.md
 */

// ---------------------------------------------------------------------------
// upsertIdentityLink
// ---------------------------------------------------------------------------

/**
 * Insert-or-update the identity link for (userId, provider). A subject
 * change on an existing row is treated as a NEW identity event (per
 * ADR-0016 Case B): `provider_subject` is rewritten AND `first_confirmed_at`
 * is reset to NULL so the next callback re-gates on the confirm-gesture
 * screen. Callers MUST NOT assume idempotency across subject changes.
 *
 * Throws on UNIQUE (provider, provider_subject) collision — that means a
 * different MyApi user already claims this provider account, which is an
 * account-takeover signal, not a benign duplicate. Handle or surface the
 * error at the callback; do not catch-and-swallow here.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.userId
 * @param {string} opts.provider           'google' | 'github' | 'facebook'
 * @param {string} opts.providerSubject    Stable provider-side id.
 * @param {string} [opts.email]
 * @param {number} [opts.now=Date.now()]
 * @returns {{ userId: string, provider: string, providerSubject: string,
 *            email: string|null, firstConfirmedAt: string|null,
 *            created: boolean, subjectChanged: boolean }}
 */
function upsertIdentityLink({
  db,
  userId,
  provider,
  providerSubject,
  email = null,
  now = Date.now(),
} = {}) {
  if (!userId || !provider || !providerSubject) {
    throw new Error('upsertIdentityLink requires userId, provider, providerSubject');
  }
  const ts = new Date(now).toISOString();

  const existing = db
    .prepare(
      'SELECT user_id, provider, provider_subject, email, first_confirmed_at, created_at FROM user_identity_links WHERE user_id = ? AND provider = ?'
    )
    .get(userId, provider);

  if (!existing) {
    // INSERT path. UNIQUE (provider, provider_subject) enforces the
    // "one MyApi user per provider account" invariant — on collision,
    // better-sqlite3 throws SqliteError: UNIQUE constraint failed, which
    // we let propagate.
    db.prepare(
      `INSERT INTO user_identity_links
         (user_id, provider, provider_subject, email,
          first_confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`
    ).run(userId, provider, providerSubject, email || null, ts, ts);

    return {
      userId,
      provider,
      providerSubject,
      email: email || null,
      firstConfirmedAt: null,
      created: true,
      subjectChanged: false,
    };
  }

  const subjectChanged = existing.provider_subject !== providerSubject;

  if (subjectChanged) {
    // Subject rotation: treat as a new first-seen event per ADR-0016.
    // The gesture screen will re-fire on the next callback, giving the
    // user explicit consent for the new provider identity.
    db.prepare(
      `UPDATE user_identity_links
          SET provider_subject = ?,
              email = ?,
              first_confirmed_at = NULL,
              updated_at = ?
        WHERE user_id = ? AND provider = ?`
    ).run(providerSubject, email || null, ts, userId, provider);

    return {
      userId,
      provider,
      providerSubject,
      email: email || null,
      firstConfirmedAt: null,
      created: false,
      subjectChanged: true,
    };
  }

  // Same subject: refresh email + updated_at. Keep first_confirmed_at.
  db.prepare(
    `UPDATE user_identity_links
        SET email = COALESCE(?, email),
            updated_at = ?
      WHERE user_id = ? AND provider = ?`
  ).run(email || null, ts, userId, provider);

  return {
    userId,
    provider,
    providerSubject,
    email: email || existing.email || null,
    firstConfirmedAt: existing.first_confirmed_at || null,
    created: false,
    subjectChanged: false,
  };
}

// ---------------------------------------------------------------------------
// hasConfirmedBefore
// ---------------------------------------------------------------------------

/**
 * Is this `{user, provider, provider_subject}` tuple already marked as
 * first-confirmed? The OAuth callback uses this to decide whether to
 * short-circuit the gesture screen for a returning user. See ADR-0016
 * for why we key on provider_subject and not just (user, provider).
 *
 * Callers MAY pass `serviceName` as an alias for `provider` — the OAuth
 * subsystem uses both names interchangeably depending on where in the
 * pipeline we are.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.userId
 * @param {string} [opts.provider]
 * @param {string} [opts.serviceName]      Alias for provider.
 * @param {string} opts.providerSubject
 * @returns {boolean}
 */
function hasConfirmedBefore({
  db,
  userId,
  provider,
  serviceName,
  providerSubject,
} = {}) {
  const p = provider || serviceName;
  if (!userId || !p || !providerSubject) {
    return false;
  }
  const row = db
    .prepare(
      `SELECT 1
         FROM user_identity_links
        WHERE user_id = ?
          AND provider = ?
          AND provider_subject = ?
          AND first_confirmed_at IS NOT NULL
        LIMIT 1`
    )
    .get(userId, p, providerSubject);
  return !!row;
}

// ---------------------------------------------------------------------------
// recordFirstConfirmation
// ---------------------------------------------------------------------------

/**
 * Stamp the first-seen marker on the identity link for this
 * `{user, provider, provider_subject}` tuple. Idempotent: if the marker
 * is already set for the same subject, leave it alone. If the stored
 * subject differs, OVERWRITE subject AND set a fresh timestamp — the
 * previous subject is no longer the identity on this link (ADR-0016
 * Case B). If no link row exists, upsert one and stamp.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.userId
 * @param {string} [opts.provider]
 * @param {string} [opts.serviceName]  Alias for provider.
 * @param {string} opts.providerSubject
 * @param {string} [opts.email]
 * @param {number} [opts.now=Date.now()]
 */
function recordFirstConfirmation({
  db,
  userId,
  provider,
  serviceName,
  providerSubject,
  email = null,
  now = Date.now(),
} = {}) {
  const p = provider || serviceName;
  if (!userId || !p || !providerSubject) {
    return;
  }
  const ts = new Date(now).toISOString();

  // First make sure a link row exists for this tuple — upsert with the
  // requested subject. If the subject was different, upsertIdentityLink
  // already reset first_confirmed_at to NULL; we then stamp it below.
  upsertIdentityLink({ db, userId, provider: p, providerSubject, email, now });

  db.prepare(
    `UPDATE user_identity_links
        SET first_confirmed_at = CASE
              WHEN provider_subject = ? AND first_confirmed_at IS NOT NULL
                THEN first_confirmed_at
              ELSE ?
            END,
            updated_at = ?
      WHERE user_id = ? AND provider = ?`
  ).run(providerSubject, ts, ts, userId, p);
}

// ---------------------------------------------------------------------------
// findUserByProviderSubject
// ---------------------------------------------------------------------------

/**
 * Reverse lookup: "which MyApi user is linked to this provider identity?"
 * Used by signup-complete and cross-device login flows to avoid creating
 * a second user account when one already exists for this provider subject.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} [opts.provider]
 * @param {string} [opts.serviceName]
 * @param {string} opts.providerSubject
 * @returns {{ user_id: string, provider: string, email: string|null,
 *             first_confirmed_at: string|null } | null}
 */
function findUserByProviderSubject({
  db,
  provider,
  serviceName,
  providerSubject,
} = {}) {
  const p = provider || serviceName;
  if (!p || !providerSubject) return null;
  const row = db
    .prepare(
      `SELECT user_id, provider, email, first_confirmed_at
         FROM user_identity_links
        WHERE provider = ? AND provider_subject = ?
        LIMIT 1`
    )
    .get(p, providerSubject);
  return row || null;
}

// ---------------------------------------------------------------------------
// removeIdentityLink (admin / GDPR tooling)
// ---------------------------------------------------------------------------

/**
 * Delete the identity link for (user, provider). Used when a user
 * "disconnects" their login provider (rare; most commonly via account
 * deletion). Does NOT touch `oauth_tokens` — the service grant lifecycle
 * is independent.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.userId
 * @param {string} [opts.provider]
 * @param {string} [opts.serviceName]
 * @returns {{ removed: number }}
 */
function removeIdentityLink({
  db,
  userId,
  provider,
  serviceName,
} = {}) {
  const p = provider || serviceName;
  if (!userId || !p) return { removed: 0 };
  const result = db
    .prepare('DELETE FROM user_identity_links WHERE user_id = ? AND provider = ?')
    .run(userId, p);
  return { removed: result.changes };
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

module.exports = {
  upsertIdentityLink,
  hasConfirmedBefore,
  recordFirstConfirmation,
  findUserByProviderSubject,
  removeIdentityLink,
};
