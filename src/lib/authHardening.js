/**
 * Auth hardening primitives — single source of truth for state that must
 * be shared across every handler that authenticates a user.
 *
 * Why this module exists
 * ──────────────────────
 * Prior to F5.1 Phase 1a these helpers lived inline in `src/index.js`,
 * but the winning password-auth router (`src/routes/auth.js`) had NO
 * access to them — it could not call `registerUserSession`, could not
 * check TOTP-code replay, and had to re-invent its own rate-limit map
 * (which would double the effective per-IP budget).  Giving every caller
 * a single `require` path here guarantees:
 *
 *   - ONE `Map` backing the SOC2-CC6 concurrent-session cap (max 3 live
 *     sessions per user; oldest evicted on new login).  If password
 *     login and OAuth login seeded two separate Maps, the effective cap
 *     would become 6 and the control would silently fail compliance.
 *
 *   - ONE `Map` backing the TOTP replay-protection window.  A code used
 *     for a password login must NOT be reusable for a 2FA challenge
 *     (and vice versa).  Separate Maps would re-open the replay door.
 *
 *   - ONE per-IP auth rate-limit map so the 5-attempts-per-minute rule
 *     is enforced globally across `/auth/login`, `/auth/register`,
 *     `/auth/token-login`, and every other auth-sensitive path — not
 *     per-handler.
 *
 * Ownership + lifecycle
 * ──────────────────────
 * `setSessionStore(store)` is invoked ONCE by `src/index.js` after the
 * Express session store has been constructed.  Until it is called,
 * session-eviction is a no-op (which is the correct behaviour under
 * `NODE_ENV === 'test'` where no SQLite-backed store exists).  The
 * Maps themselves live for the lifetime of the Node process, just as
 * they did when they were inlined in `src/index.js`.
 */

const logger = require('../utils/logger');

// ────────────────────────────────────────────────────────────────────
// Per-IP auth rate limit
//
// We intentionally do NOT reuse the generic `rateLimit()` factory from
// `src/index.js` here.  That factory is private to that file, and
// constructing a second instance in this module would mean TWO Maps
// tracking the same IPs (doubling the effective budget during any
// transitional phase where both index.js and routes/auth.js mount the
// same endpoint pattern).  The tiny self-contained implementation below
// is the single source of truth.
// ────────────────────────────────────────────────────────────────────
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX = process.env.NODE_ENV === 'test' ? 1000 : 5;

// Exempt paths must never trip the limiter.  Kept in sync with the
// equivalent list in `src/index.js`'s generic limiter so behaviour does
// not diverge across cookies/bearer auth.
const AUTH_EXEMPT_PATHS = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/csrf-token',
  '/api/v1/auth/debug',
]);

const authRateLimitMap = new Map();

function authRateLimit(req, res, next) {
  const fullPath = (req.baseUrl || '') + (req.path || '');
  if (AUTH_EXEMPT_PATHS.has(fullPath)) return next();

  const key = req.ip || 'unknown';
  const now = Date.now();
  const bucket = (authRateLimitMap.get(key) || []).filter((t) => now - t < AUTH_WINDOW_MS);

  if (bucket.length >= AUTH_MAX) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((AUTH_WINDOW_MS - (now - bucket[0])) / 1000),
    );
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Rate limit exceeded', retryAfterSeconds });
  }

  bucket.push(now);
  authRateLimitMap.set(key, bucket);
  res.set('X-RateLimit-Limit', String(AUTH_MAX));
  res.set('X-RateLimit-Remaining', String(AUTH_MAX - bucket.length));
  next();
}

// ────────────────────────────────────────────────────────────────────
// SOC2 CC6 — concurrent session registry
// ────────────────────────────────────────────────────────────────────
const MAX_SESSIONS_PER_USER = 3;
// userId → [{ sessionId, createdAt }]
const userSessionRegistry = new Map();

let _sessionStore = null;

/**
 * Wire the Express session store in from the owner module (src/index.js)
 * after it has been constructed.  Called exactly once at startup.
 */
function setSessionStore(store) {
  _sessionStore = store || null;
}

function registerUserSession(userId, sessionId) {
  if (!userSessionRegistry.has(userId)) userSessionRegistry.set(userId, []);
  const sessions = userSessionRegistry.get(userId);
  sessions.push({ sessionId, createdAt: Date.now() });

  while (sessions.length > MAX_SESSIONS_PER_USER) {
    const { sessionId: oldSid } = sessions.shift();
    if (_sessionStore && typeof _sessionStore.destroy === 'function') {
      try {
        _sessionStore.destroy(oldSid, () => {});
      } catch (_) {
        /* best-effort eviction */
      }
    }
    logger.warn('Session evicted due to concurrent session limit', {
      userId,
      evictedSessionId: oldSid,
    });
  }
}

function unregisterUserSession(userId, sessionId) {
  const sessions = userSessionRegistry.get(userId);
  if (!sessions) return;
  const idx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx !== -1) sessions.splice(idx, 1);
}

/**
 * Drop every active session for `userId`.  Optional second argument
 * `{ except }` lets the caller preserve ONE specific session id —
 * F5.2 P2 (`/auth/password/change`) uses this so the user who just
 * rotated their password is NOT immediately logged out of the tab
 * they pressed Save in, while every OTHER device they were signed
 * into is killed.
 *
 * Returns the number of sessions that were actually evicted (excludes
 * the preserved one).  P2's audit row carries this as
 * `details.sessions_revoked` so a SOC2 reviewer can see "the user
 * rotated and kicked N other devices" at a glance.
 */
function revokeAllUserSessions(userId, options = {}) {
  const exceptSid = options && typeof options === 'object' ? options.except : null;
  const sessions = userSessionRegistry.get(userId) || [];
  let evicted = 0;
  const kept = [];

  for (const entry of sessions) {
    if (exceptSid && entry.sessionId === exceptSid) {
      kept.push(entry);
      continue;
    }
    if (_sessionStore && typeof _sessionStore.destroy === 'function') {
      try {
        _sessionStore.destroy(entry.sessionId, () => {});
      } catch (_) {
        /* best-effort eviction */
      }
    }
    evicted += 1;
  }

  if (kept.length > 0) {
    userSessionRegistry.set(userId, kept);
  } else {
    userSessionRegistry.delete(userId);
  }

  return evicted;
}

// ────────────────────────────────────────────────────────────────────
// TOTP replay protection (issue #17)
//
// TTL = 90s covers speakeasy window:2 (±60s) with a small buffer so
// codes cannot be replayed within their validity window across parallel
// login + step-up-auth flows.
// ────────────────────────────────────────────────────────────────────
const usedTotpCodes = new Map(); // `${userId}:${code}` → expiresAt
const TOTP_CODE_TTL_MS = 90_000;

function isTotpCodeUsed(userId, code) {
  const key = `${userId}:${code}`;
  const exp = usedTotpCodes.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    usedTotpCodes.delete(key);
    return false;
  }
  return true;
}

function markTotpCodeUsed(userId, code) {
  const now = Date.now();
  // Opportunistic GC of expired keys so the Map doesn't grow unbounded
  // under attacker churn.
  for (const [k, exp] of usedTotpCodes) {
    if (now > exp) usedTotpCodes.delete(k);
  }
  usedTotpCodes.set(`${userId}:${code}`, now + TOTP_CODE_TTL_MS);
}

module.exports = {
  authRateLimit,
  setSessionStore,
  registerUserSession,
  unregisterUserSession,
  revokeAllUserSessions,
  isTotpCodeUsed,
  markTotpCodeUsed,
  // Exposed for tests / diagnostics — do not mutate from application code.
  _internals: Object.freeze({
    userSessionRegistry,
    usedTotpCodes,
    authRateLimitMap,
    MAX_SESSIONS_PER_USER,
    TOTP_CODE_TTL_MS,
    AUTH_MAX,
    AUTH_WINDOW_MS,
  }),
};
