const logger = require('../utils/logger');
/**
 * Authentication Routes
 * Handles user login/registration and persistent user management
 */

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const {
  getAccessTokens,
  getExistingMasterToken,
  createAccessToken,
  db,
  getUserByEmail,
  getUserByUsername,
  getOrEnsureUserWorkspace,
  createAuditLog,
} = require('../database');
const emailService = require('../services/emailService');
const alerting = require('../lib/alerting');

const { generateCSRFToken, validateCSRFToken } = require('../lib/csrf-protection');
const { requireBetaSlot } = require('../middleware/betaCap');
const { invalidateBetaFullCache } = require('../lib/betaMode');
// F5.1 Phase 1a — single source of truth for SOC2 session registry,
// TOTP replay protection, and the per-IP auth rate limit.  See
// `src/lib/authHardening.js` for ownership + lifecycle rationale.
const {
  authRateLimit,
  registerUserSession,
  unregisterUserSession,
  revokeAllUserSessions,
  isTotpCodeUsed,
  markTotpCodeUsed,
} = require('../lib/authHardening');

const router = express.Router();

/**
 * GET /api/v1/auth/csrf-token
 * Returns a CSRF token for the current session.
 * Frontend must call this before submitting any state-changing form with a session cookie.
 */
router.get('/csrf-token', (req, res) => {
  if (!req.session) return res.status(400).json({ error: 'Session not available' });
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCSRFToken();
  }
  res.json({ csrfToken: req.session.csrfToken });
});

/**
 * GET /api/v1/auth/email-config-status — F5.3
 *
 * Public read-only probe so the dashboard's password-recovery and
 * change-password screens can warn the user upfront when the server
 * has no usable email transport (e.g. self-hosted dev install with
 * EMAIL_FROM unset).  Without this banner, /password/reset/request
 * just silently swallows the send (it returns 202 by design to
 * prevent email enumeration), leaving the user wondering why no
 * email arrived.
 *
 * Response shape mirrors emailService.getConfigStatus() — no PII,
 * no secrets, only which env vars are missing so the operator
 * knows what to fix.
 */
router.get('/email-config-status', (req, res) => {
  try {
    const status = emailService.getConfigStatus();
    res.set('Cache-Control', 'no-store');
    return res.json({
      configured: !!status.configured,
      provider: status.provider,
      missing: Array.isArray(status.missing) ? status.missing : [],
    });
  } catch (err) {
    logger.warn('[Auth/EmailConfigStatus] probe error', { err: err?.message });
    return res.status(500).json({ configured: false, provider: 'unknown', missing: [] });
  }
});

/**
 * Middleware: validate CSRF token for cookie-session-based POST requests.
 * Bearer-token authenticated requests skip CSRF (inherently CSRF-safe).
 */
function requireCsrfForSession(req, res, next) {
  // Skip CSRF check if using Bearer token auth (not cookie-based)
  if (req.headers.authorization?.startsWith('Bearer ')) return next();
  // Skip if no session is established yet (GET csrf-token first)
  if (!req.session?.csrfToken) return next();

  const provided = req.body?._csrf || req.headers['x-csrf-token'];
  if (!provided) {
    return res.status(403).json({ error: 'CSRF token required', code: 'CSRF_MISSING' });
  }
  try {
    if (!validateCSRFToken(provided, req.session.csrfToken)) {
      return res.status(403).json({ error: 'Invalid CSRF token', code: 'CSRF_INVALID' });
    }
  } catch {
    return res.status(403).json({ error: 'CSRF validation error', code: 'CSRF_ERROR' });
  }
  // Rotate token after successful validation (defense in depth)
  req.session.csrfToken = generateCSRFToken();
  next();
}

function buildCookieDomainCandidates(req) {
  const candidates = new Set();
  const configuredDomain = String(process.env.SESSION_COOKIE_DOMAIN || '').trim();
  const hostname = String(req?.hostname || '').trim();

  const add = (value) => {
    const v = String(value || '').trim();
    if (!v) return;
    candidates.add(v);
    if (!v.startsWith('.')) candidates.add(`.${v}`);
  };

  if (configuredDomain) add(configuredDomain);
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  if (hostname && hostname !== 'localhost' && !isIp) {
    add(hostname);
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length >= 2) add(parts.slice(-2).join('.'));
  }

  return [undefined, ...Array.from(candidates)];
}

function clearAuthCookies(req, res) {
  const cookieNames = ['connect.sid', 'myapi.sid', 'myapi_master_token', 'myapi_user', 'session', 'auth', 'token'];
  const sameSiteVariants = [undefined, 'lax', 'none', 'strict'];
  const secureVariants = [true, false];
  const domains = buildCookieDomainCandidates(req);

  for (const name of cookieNames) {
    for (const domain of domains) {
      for (const sameSite of sameSiteVariants) {
        for (const secure of secureVariants) {
          const opts = { path: '/', secure };
          if (domain) opts.domain = domain;
          if (sameSite) opts.sameSite = sameSite;
          res.clearCookie(name, opts);
        }
      }
    }
  }
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.regenerate !== 'function') return resolve();
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

// F5.3 — cached lookup of the `password_set_at` column.  Re-querying
// PRAGMA on every password write would be silly; the schema doesn't
// change at runtime.  We probe lazily and memoise.
let _hasPasswordSetAtColumnCache = null;
function hasPasswordSetAtColumn() {
  if (_hasPasswordSetAtColumnCache !== null) return _hasPasswordSetAtColumnCache;
  try {
    const cols = db.prepare('PRAGMA table_info(users)').all();
    _hasPasswordSetAtColumnCache = cols.some((c) => c.name === 'password_set_at');
  } catch (_) {
    _hasPasswordSetAtColumnCache = false;
  }
  return _hasPasswordSetAtColumnCache;
}

/**
 * F5.3 — write a new password_hash AND stamp `password_set_at` so the
 * OAUTH_ONLY guard in /auth/login lets the user back in once they've
 * deliberately set a password (via /register, /password/reset/confirm,
 * or /password/change).  Falls back to the old single-column UPDATE on
 * stale deployments that haven't run the F5.3 migration yet.
 */
function writeUserPasswordHash(userId, newHash) {
  const now = new Date().toISOString();
  if (hasPasswordSetAtColumn()) {
    db.prepare('UPDATE users SET password_hash = ?, password_set_at = ? WHERE id = ?')
      .run(newHash, now, userId);
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, userId);
  }
}

/**
 * POST /api/v1/auth/token-login
 * Login with master token (for cross-device access)
 */
router.post('/token-login', authRateLimit, requireCsrfForSession, async (req, res) => {
  try {
    const token = req.body?.token;
    if (!token || typeof token !== 'string' || token.length < 16) {
      return res.status(400).json({ error: 'Valid token required' });
    }

    // Validate token exists and is active in the database
    const { getAccessTokens } = require('../database');
    const bcryptLib = require('bcrypt');
    const tokens = getAccessTokens() || [];
    let validToken = null;
    for (const tokenRecord of tokens) {
      if (tokenRecord.revokedAt) continue;
      if (tokenRecord.expiresAt && new Date(tokenRecord.expiresAt) <= new Date()) continue;
      if (tokenRecord.hash && await bcryptLib.compare(token, tokenRecord.hash).catch(() => false)) {
        validToken = tokenRecord;
        break;
      }
    }

    if (!validToken) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.session.masterToken = token;
    req.session.authMethod = 'token';
    req.session.user = { id: validToken.ownerId };

    // SOC2 CC7 — emit a `token_login` audit event so master-token logins
    // produce the same compliance trail as password logins.  The legacy
    // inline shadow in `src/index.js` used to own this; restoring it here
    // before P1b deletes the shadow.  We use the token-id as the requester
    // (mirrors the legacy contract — the token, not the human owner, is
    // what authenticated this request) and stash the owner under details
    // so cross-correlation queries still work.
    try {
      createAuditLog({
        requesterId: validToken.tokenId || validToken.id || null,
        action: 'token_login',
        resource: '/auth/token-login',
        scope: validToken.scope || 'session',
        ip: req.ip,
        details: { ownerId: validToken.ownerId || null },
      });
    } catch (auditErr) {
      logger.warn('[Auth/TokenLogin] token_login audit emit error', {
        err: auditErr?.message,
      });
    }

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      res.json({ success: true, message: 'Logged in with token' });
    });
  } catch (error) {
    logger.error('Token login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/v1/auth/login
 *
 * Password login with optional TOTP second factor.  Accepts EITHER
 * `username` OR `email` in the request body — historically the inline
 * shadow route in `src/index.js:6887` supported both and the dashboard
 * (plus CLI tools) relied on either form.  If `user.twoFactorEnabled`
 * is set, a valid `totpCode` is required and the code is marked as
 * used to close the replay window.  Emits `user_login` on success,
 * `failed_login` on bad password, `2fa_failed_attempt` on bad TOTP,
 * and registers the new session with the SOC2 concurrent-session cap.
 */
router.post('/login', authRateLimit, requireCsrfForSession, async (req, res) => {
  try {
    const { email, username, password, totpCode } = req.body || {};
    if ((!email && !username) || !password) {
      return res.status(400).json({ error: 'Email (or username) and password required' });
    }

    let user = null;
    try {
      if (email) {
        user = getUserByEmail(email);
      } else if (username) {
        user = getUserByUsername(username);
      }
    } catch (e) {
      logger.error('Error fetching user:', e);
      return res
        .status(500)
        .json({ error: 'Internal server error', message: 'Service temporarily unavailable' });
    }

    // Use a generic error string so we do not leak whether the account exists.
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // F5.3 — OAuth-only account guard.  Users created via OAuth signup get
    // a random throwaway `password_hash` they don't know; without this
    // branch their password-login attempts just hit bcrypt-compare and
    // bounce off as "invalid credentials" with zero hint that the account
    // exists under a different sign-in method.  We detect by:
    //   (a) `password_set_at` is NULL (no real password ever stamped)
    //   (b) at least one `oauth_tokens` row links the account to a provider
    // and respond with OAUTH_ONLY so the dashboard can surface "continue
    // with Google instead".  Lookup is wrapped in try/catch because the
    // column / table may legitimately be absent on older deployments —
    // in that case we fall through to the original bcrypt path.
    try {
      const fullUserRow = db
        .prepare('SELECT password_set_at FROM users WHERE id = ?')
        .get(user.id);
      const passwordSetAt = fullUserRow?.password_set_at || null;
      if (!passwordSetAt) {
        const linkedProvider = db
          .prepare(
            'SELECT service_name FROM oauth_tokens WHERE user_id = ? ORDER BY created_at ASC LIMIT 1',
          )
          .get(user.id);
        if (linkedProvider?.service_name) {
          // Capitalise for display ("google" -> "Google"); preserves
          // the lowercase machine-readable code in the JSON shape.
          const providerLabel = linkedProvider.service_name
            .charAt(0)
            .toUpperCase() + linkedProvider.service_name.slice(1);
          try {
            createAuditLog({
              requesterId: user.id,
              action: 'login_blocked_oauth_only',
              resource: '/auth/login',
              scope: 'session',
              ip: req.ip,
              details: { provider: linkedProvider.service_name },
            });
          } catch (auditErr) {
            logger.warn('[Auth/Login] login_blocked_oauth_only audit emit error', {
              err: auditErr?.message,
            });
          }
          return res.status(409).json({
            error: `This account is registered with ${providerLabel}. Please continue with ${providerLabel}.`,
            code: 'OAUTH_ONLY',
            provider: linkedProvider.service_name,
          });
        }
      }
    } catch (oauthCheckErr) {
      // Schema not migrated yet — fall through to bcrypt path so we
      // don't lock anyone out on a stale deployment.  Logged at warn
      // so an operator running with a stale DB sees it but it doesn't
      // spam in the steady state.
      logger.warn('[Auth/Login] oauth-only detection skipped', {
        err: oauthCheckErr?.message,
      });
    }

    const passwordMatch = await bcrypt
      .compare(password, user.password_hash || '')
      .catch(() => false);
    if (!passwordMatch) {
      try {
        createAuditLog({
          requesterId: 'unknown',
          action: 'failed_login',
          resource: '/auth/login',
          scope: 'session',
          ip: req.ip,
          details: { username: user.username, reason: 'invalid_credentials' },
        });
      } catch (auditErr) {
        logger.warn('[Auth/Login] failed_login audit emit error', { err: auditErr?.message });
      }
      alerting.trackFailedLogin(req.ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // 2FA gate — the shadow route in `src/index.js:6915` used to own this
    // contract but was unreachable once `newAuthRoutes` shadowed the
    // inline mount.  Restoring it here closes a latent auth-bypass where
    // a 2FA-enabled account could be signed into with only a password.
    if (user.twoFactorEnabled) {
      if (!totpCode) {
        return res.status(401).json({ error: '2FA code required', requires2FA: true });
      }
      const totpKey = String(totpCode).replace(/\s+/g, '');
      const verified = speakeasy.totp.verify({
        secret: user.totpSecret,
        encoding: 'base32',
        token: totpKey,
        window: 4,
      });
      if (!verified) {
        try {
          createAuditLog({
            requesterId: user.id,
            action: '2fa_failed_attempt',
            resource: '/auth/login',
            scope: 'session',
            ip: req.ip,
            details: { reason: 'invalid_code' },
          });
        } catch (auditErr) {
          logger.warn('[Auth/Login] 2fa_failed_attempt audit emit error', {
            err: auditErr?.message,
          });
        }
        alerting.trackFailedLogin(req.ip);
        return res.status(401).json({ error: 'Invalid 2FA code', requires2FA: true });
      }
      // Replay protection: reject same code twice within its validity window.
      if (isTotpCodeUsed(user.id, totpKey)) {
        return res
          .status(401)
          .json({ error: '2FA code already used. Wait for the next code.', requires2FA: true });
      }
      markTotpCodeUsed(user.id, totpKey);
    }

    // Retrieve existing master token — login must NEVER create or revoke master tokens.
    // The master token is an API key given to AI agents; changing it on login would
    // break all integrations.  Only the explicit /tokens/master/regenerate endpoint
    // may replace it.  If none exists yet the frontend will bootstrap one via
    // POST /tokens/master/bootstrap on first dashboard load.
    let masterTokenRaw = null;
    let masterTokenId = null;
    const existing = getExistingMasterToken(user.id);
    if (existing) {
      masterTokenRaw = existing.rawToken;
      masterTokenId = existing.tokenId;
    }

    await regenerateSession(req);

    let workspaceId = null;
    try {
      const workspace = getOrEnsureUserWorkspace(user.id);
      workspaceId = workspace?.id || null;
    } catch (wsErr) {
      // Non-fatal — the dashboard will re-ensure on first write.  Log so
      // we notice if this starts regressing.
      logger.warn('[Auth/Login] getOrEnsureUserWorkspace failed', {
        userId: user.id,
        err: wsErr?.message,
      });
    }

    req.session.user = {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
    };
    req.session.masterTokenRaw = masterTokenRaw;
    req.session.masterTokenId = masterTokenId;
    if (workspaceId) req.session.currentWorkspace = workspaceId;

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });

      // SOC2 CC6 — track the new session and evict the oldest if the
      // per-user concurrent-session cap (3) is exceeded.
      try {
        registerUserSession(user.id, req.sessionID);
      } catch (regErr) {
        logger.warn('[Auth/Login] registerUserSession failed', {
          userId: user.id,
          err: regErr?.message,
        });
      }

      try {
        createAuditLog({
          requesterId: user.id,
          action: 'user_login',
          resource: `/users/${user.id}`,
          scope: 'session',
          ip: req.ip,
        });
      } catch (auditErr) {
        logger.warn('[Auth/Login] user_login audit emit error', { err: auditErr?.message });
      }

      res.json({
        success: true,
        userId: user.id,
        masterToken: masterTokenRaw,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          displayName: user.displayName,
          twoFactorEnabled: Boolean(user.twoFactorEnabled),
        },
      });
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/v1/auth/register
 * Create a new user account
 * 
 * Body: { username, password, email, timezone, display_name }
 * Response: { success: true, data: { token, user: {...}, needsOnboarding: true } }
 */
router.post(
  '/register',
  authRateLimit,
  requireCsrfForSession,
  requireBetaSlot,
  async (req, res) => {
  const {
    username,
    password,
    display_name,
    email,
    timezone,
    accepted_terms_at,
    accepted_privacy_policy_at,
  } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const { isStrongPassword } = require('../utils/passwordUtils');
  if (!isStrongPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters and contain 3 of: uppercase, lowercase, number, symbol' });
  if (username.length < 3 || username.length > 50) return res.status(400).json({ error: 'username must be between 3 and 50 characters' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return res.status(400).json({ error: 'username can only contain letters, numbers, underscores, hyphens, and dots' });
  if (password.length > 128) return res.status(400).json({ error: 'password must not exceed 128 characters' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email format' });
  if (display_name && display_name.length > 100) return res.status(400).json({ error: 'display name must not exceed 100 characters' });
  if (timezone && timezone.length > 50) return res.status(400).json({ error: 'invalid timezone' });

  try {
    const { db } = require('../database');

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: 'Username already exists', code: 'USERNAME_EXISTS' });

    // F5.3 — close the duplicate-email hole.  /auth/oauth-signup/complete
    // already gates on this; /auth/register was the lone offender, which
    // let the same email anchor multiple accounts and silently broke
    // password login afterwards (whichever row getUserByEmail returned
    // first won the bcrypt match).  The unique index added in the same
    // commit's migration is the belt-and-braces guarantee against races.
    if (email) {
      const emailMatch = getUserByEmail(email);
      if (emailMatch) {
        return res.status(409).json({
          error: 'An account with this email already exists. Please sign in instead.',
          code: 'EMAIL_EXISTS',
        });
      }
    }

    const id = 'usr_' + crypto.randomBytes(16).toString('hex');
    const hash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();

    // Detect whether the users table has the GDPR consent columns so we
    // insert with the richer shape when available and quietly degrade on
    // pre-migration deployments.  This mirrors `createUser()` in
    // `src/database.js` so operators on either migration state land in a
    // consistent audit posture.
    let hasConsentCols = false;
    let hasPasswordSetAt = false;
    try {
      const cols = db.prepare('PRAGMA table_info(users)').all();
      hasConsentCols =
        cols.some((c) => c.name === 'accepted_terms_at') &&
        cols.some((c) => c.name === 'accepted_privacy_policy_at');
      // F5.3 — only stamp password_set_at if the migration has run.
      // Pre-migration deployments degrade silently (still register
      // successfully; just won't get the OAUTH_ONLY signal).
      hasPasswordSetAt = cols.some((c) => c.name === 'password_set_at');
    } catch (_) {
      hasConsentCols = false;
      hasPasswordSetAt = false;
    }

    const termsAt = accepted_terms_at || now;
    const privacyAt = accepted_privacy_policy_at || now;

    // F5.3 — `password_set_at` marks accounts where the user actually
    // chose a password (vs OAuth signup which mints a random throwaway
    // hash).  /auth/login uses NULL here + a linked oauth_tokens row
    // to drive the OAUTH_ONLY error code, so the dashboard can tell the
    // user "use Google instead" instead of the generic "invalid creds".
    try {
      if (hasConsentCols && hasPasswordSetAt) {
        db.prepare(
          `INSERT INTO users (id, username, password_hash, display_name, email, timezone, created_at, status, roles, accepted_terms_at, accepted_privacy_policy_at, password_set_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'user', ?, ?, ?)`,
        ).run(
          id, username, hash, display_name || username, email || '', timezone || 'UTC', now,
          termsAt, privacyAt, now,
        );
      } else if (hasConsentCols) {
        db.prepare(
          `INSERT INTO users (id, username, password_hash, display_name, email, timezone, created_at, status, roles, accepted_terms_at, accepted_privacy_policy_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'user', ?, ?)`,
        ).run(
          id, username, hash, display_name || username, email || '', timezone || 'UTC', now,
          termsAt, privacyAt,
        );
      } else if (hasPasswordSetAt) {
        db.prepare(
          `INSERT INTO users (id, username, password_hash, display_name, email, timezone, created_at, status, roles, password_set_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'user', ?)`,
        ).run(id, username, hash, display_name || username, email || '', timezone || 'UTC', now, now);
      } else {
        db.prepare(
          `INSERT INTO users (id, username, password_hash, display_name, email, timezone, created_at, status, roles)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'user')`,
        ).run(id, username, hash, display_name || username, email || '', timezone || 'UTC', now);
      }
    } catch (insertErr) {
      // F5.3 — the unique index on LOWER(email) is the last line of
      // defence against duplicate-email races.  Surface it as the same
      // 409 + EMAIL_EXISTS code the explicit check returns so the UI has
      // one branch to handle.
      const msg = String(insertErr?.message || '');
      if (/UNIQUE constraint failed.*email/i.test(msg) || /idx_users_email_unique/i.test(msg)) {
        return res.status(409).json({
          error: 'An account with this email already exists. Please sign in instead.',
          code: 'EMAIL_EXISTS',
        });
      }
      throw insertErr;
    }
    invalidateBetaFullCache();

    // Compliance audit — the shadow route in `src/index.js:6876` used to
    // emit this.  Restoring it here keeps SOC2/GDPR register-event
    // logging intact after P1b deletes the shadow.
    try {
      createAuditLog({
        requesterId: id,
        action: 'user_register',
        resource: `/users/${id}`,
        scope: 'public',
        ip: req.ip,
      });
    } catch (auditErr) {
      logger.warn('[Auth/Register] user_register audit emit error', { err: auditErr?.message });
    }

    // Fire-and-forget welcome email (does not block the 201 response)
    if (email) {
      emailService.sendWelcomeEmail(email, display_name || username).catch(() => {});
    }

    // Auto-login after registration — the session cookie carries
    // authentication; clients should rely on it (or the master token
    // returned by `/auth/me`'s bootstrap payload) rather than a token
    // field on this response.  F5.1 P1c removed the legacy
    // `data.token` field because nothing in the codebase ever read
    // back the in-memory map it was paired with — the field was dead
    // bytes that could be mistaken for a Bearer credential.
    req.session.user = { id, username, display_name: display_name || username, roles: 'user', needsOnboarding: true };

    logger.info('[Auth/Register] user registered', { userId: id, username });

    return res.status(201).json({
      data: {
        user: {
          id,
          username,
          displayName: display_name || username,
          email: email || '',
          timezone: timezone || 'UTC',
        },
        needsOnboarding: true,
      },
    });
  } catch (err) {
    logger.error('Registration error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/v1/auth/logout
 * Logout and destroy all authentication state
 * - Clears Express session
 * - Removes token from global store
 * - Clears session cookies
 * - Returns no-cache headers to prevent auto-login on refresh
 */
router.post('/logout', requireCsrfForSession, (req, res) => {
  try {
    const userId = req.session?.user?.id;

    // **STEP 1: Session-only logout — never touch master tokens or service OAuth tokens**
    // - Master tokens are permanent API keys; revoking them on logout breaks all integrations.
    //   They are only replaced via POST /api/v1/tokens/master/regenerate.
    // - oauth_tokens (Google, GitHub, Slack…) are persistent service connections,
    //   not session credentials — deleting them on logout would disconnect all services.
    // - Guest tokens belong to external callers; they must not be revoked silently.
    // Nothing to revoke here — the session destruction below is the entire logout action.
    if (userId) {
      try {
        logger.info(`[Logout] User ${userId}: session destroyed (master token and service connections preserved)`);
      } catch (err) {
        logger.error('[Logout] Error during logout:', err);
      }
    }

    // **STEP 2: (deprecated)** The legacy `global.sessions` map was a
    // write-only artefact of the original auth design — `/register` set
    // it, `/logout` swept it, and a 15-minute reaper in `src/index.js`
    // expired it, but nothing ever READ from it.  F5.1 P1c removed
    // both the writes and the reaper.  Real session auth lives in the
    // express-session store; the master Bearer token lives in the
    // `access_tokens` table and is minted by `/auth/me`.

    // **STEP 3: Prevent browser caching**
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    // **STEP 4: Clear all auth-related cookies**
    clearAuthCookies(req, res);
    
    // **STEP 5: Clear cookies with EXACT same options as when they were set**
    const cookieClearOpts = { path: '/', httpOnly: false, sameSite: 'lax' };
    const cookieClearOptsHttpOnly = { path: '/', httpOnly: true, sameSite: 'lax' };
    
    res.clearCookie('myapi_master_token', cookieClearOpts);
    res.clearCookie('myapi_master_token', cookieClearOptsHttpOnly);
    res.clearCookie('myapi_user', cookieClearOpts);
    res.clearCookie('masterToken', cookieClearOpts);
    res.clearCookie('masterToken', cookieClearOptsHttpOnly);
    res.clearCookie('myapi_master_token', { path: '/', httpOnly: false });
    res.clearCookie('myapi_master_token', { path: '/', httpOnly: true });
    res.clearCookie('myapi_user', { path: '/' });

    if (!req.session) {
      return res.json({ success: true, message: 'No active session', cleared: true });
    }

    // **STEP 6: Invalidate session BEFORE destroying it**
    // Mark session as invalid so if it's recreated from cookie, it won't have user data
    const sid = req.sessionID;

    // SOC2 CC6 — drop this session from the per-user concurrent-session
    // registry so the limit (max 3) tracks reality after logout.  Done
    // synchronously here (before destroy) so the userId+sid are still in
    // scope.
    if (userId && sid) {
      try {
        unregisterUserSession(userId, sid);
      } catch (regErr) {
        logger.error('[Logout] unregisterUserSession failed:', regErr);
      }

      // SOC2 CC7 — emit a `user_logout` audit row so session lifetimes
      // can be reconstructed from the audit trail alone.  Skipped for
      // anonymous logouts (no actor → no audit), and emitted BEFORE
      // session destroy so the userId/sid are still in scope.  We
      // stash the sid under details so auditors can cross-correlate
      // with the matching `user_login` row.
      try {
        createAuditLog({
          requesterId: userId,
          action: 'user_logout',
          resource: `/users/${userId}`,
          scope: 'session',
          ip: req.ip,
          details: { sid },
        });
        logger.info('[Auth/Logout] user_logout audited', { userId, sid });
      } catch (auditErr) {
        logger.warn('[Auth/Logout] user_logout audit emit error', {
          err: auditErr?.message,
        });
      }
    }

    // First, immediately clear user from session (synchronously)
    if (req.session) {
      delete req.session.user;
      delete req.session.masterToken;
      delete req.session.masterTokenRaw;
      delete req.session.masterTokenId;
      delete req.session.pending_2fa_user;
      delete req.session.currentWorkspace;
      // F5.1 P1b — clear OAuth-signup hand-off and first-login flags so a
      // re-login on the same browser cookie cannot resurrect a stale signup
      // funnel or onboarding banner.  Mirrors the legacy inline /logout
      // handler that this route replaces.
      delete req.session.oauth_signup;
      delete req.session.isFirstLogin;

      // Save the cleared session first
      req.session.save((saveErr) => {
        if (saveErr) {
          logger.error('Error saving cleared session:', saveErr);
        }
        
        // THEN destroy the session entirely
        req.session.destroy((err) => {
          if (typeof req.sessionStore?.destroy === 'function' && sid) {
            try { req.sessionStore.destroy(sid, () => {}); } catch (_) {}
          }

          if (err) {
            logger.error('Session destruction error:', err);
            return res.status(500).json({ success: false, error: 'Failed to logout' });
          }

          logger.info(`[Auth] User ${userId} logged out successfully (all tokens revoked/deleted)`);
          return res.json({ success: true, message: 'Successfully logged out', cleared: true });
        });
      });
    } else {
      logger.info(`[Auth] No session to destroy`);
      return res.json({ success: true, message: 'Successfully logged out', cleared: true });
    }
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ success: false, error: 'Logout failed' });
  }
});

/**
 * GET /api/v1/auth/me
 * Get current authenticated user info
 * IMPORTANT: This endpoint is NOT wrapped in authenticate() middleware,
 * so it must check req.session.user directly (for OAuth session auth)
 * and validate Bearer tokens manually.
 */
router.get('/me', async (req, res) => {
  try {
    const { getAccessTokens } = require('../database');
    const bcrypt = require('bcrypt');
    
    // Check session auth FIRST (OAuth login via browser)
    // Track auth method so we know whether bootstrap is safe to return.
    let userId = null;
    let authViaSession = false;
    if (req.session && req.session.user && req.session.user.id) {
      userId = String(req.session.user.id);
      authViaSession = true;
      logger.info(`[Auth/Me] Authenticated via session: ${userId}`);
    }

    // Fallback to tokenMeta (set by authenticate middleware if this route is wrapped)
    if (!userId && req.tokenMeta?.ownerId) {
      userId = String(req.tokenMeta.ownerId);
      logger.info(`[Auth/Me] Authenticated via req.tokenMeta: ${userId}`);
    }

    // Fallback to req.user (in case this route is later wrapped in authenticate())
    if (!userId && req.user?.id) {
      userId = String(req.user.id);
      logger.info(`[Auth/Me] Authenticated via req.user: ${userId}`);
    }

    // Fallback: directly validate Bearer token from Authorization header.
    // This route is excluded from the global authenticate() middleware so we must
    // validate Bearer tokens here to support master-token re-authentication.
    if (!userId) {
      const authHeader = req.headers.authorization || '';
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        const rawToken = parts[1];
        const tokens = getAccessTokens() || [];
        let matchedToken = null;
        for (const tokenRecord of tokens) {
          if (
            !tokenRecord.revokedAt &&
            tokenRecord.hash &&
            await bcrypt.compare(rawToken, tokenRecord.hash).catch(() => false)
          ) {
            if (tokenRecord.expiresAt && new Date(tokenRecord.expiresAt) <= new Date()) {
              continue; // skip expired tokens
            }
            userId = String(tokenRecord.ownerId);
            matchedToken = tokenRecord;
            break;
          }
        }
        // Bearer tokens reaching /auth/me MUST honor requires_approval and per-token
        // device approval. Do NOT trust caller-controlled Referer/Origin — those are spoofable.
        // Session-authed dashboard hits the session branch above; this path only runs for
        // external Bearer callers (agents, AI), which must be gated.
        if (matchedToken) {
          try {
            const { db: dbInstance, getPendingApprovals, createPendingApproval } = require('../database');
            const DeviceFingerprint = require('../utils/deviceFingerprint');
            const tokenRow = dbInstance.prepare(
              'SELECT label, requires_approval, token_type, scope FROM access_tokens WHERE id = ?'
            ).get(matchedToken.tokenId);
            const isMasterToken = tokenRow?.token_type === 'master' || tokenRow?.scope === 'full';
            const isOAuthToken = tokenRow?.label && tokenRow.label.endsWith('(OAuth)');
            // Gate if: master token, OAuth-labeled token, OR guest token with requires_approval=1.
            // Guest token without approval requirement still passes (existing policy).
            const gateEnabled = isMasterToken || isOAuthToken || !!tokenRow?.requires_approval;

            if (gateEnabled) {
              const fingerprint = DeviceFingerprint.fromRequest(req);
              // Per-token lookup: master approval must NOT auto-authorize guest tokens.
              const approvedForToken = dbInstance.prepare(
                'SELECT id FROM approved_devices WHERE token_id = ? AND user_id = ? AND device_fingerprint_hash = ? AND revoked_at IS NULL LIMIT 1'
              ).get(matchedToken.tokenId, userId, fingerprint.fingerprintHash);

              if (!approvedForToken) {
                const pendingApprovals = getPendingApprovals(userId, matchedToken.tokenId);
                const existingPending = pendingApprovals.find(p => p.device_fingerprint_hash === fingerprint.fingerprintHash);
                if (!existingPending) {
                  createPendingApproval(matchedToken.tokenId, userId, fingerprint.fingerprintHash, fingerprint.summary, fingerprint.fingerprint.ipAddress);
                }
                return res.status(403).json({
                  error: 'device_not_approved',
                  code: 'DEVICE_APPROVAL_REQUIRED',
                  message: 'Access denied — waiting for the user to approve you in the dashboard.',
                });
              }
            }
          } catch (err) {
            logger.error('[Auth/Me] Device approval check failed, failing closed', { err: err.message });
            return res.status(403).json({
              error: 'device_approval_error',
              code: 'DEVICE_APPROVAL_FAILED',
              message: 'Access denied — device check temporarily unavailable.',
            });
          }
        }
      }
    }

    if (!userId) {
      logger.info(`[Auth/Me] No authentication found (no session, no valid Bearer token)`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { getUserById } = require('../database');
    let user = getUserById(userId);

    // In MongoDB mode, getUserById uses a SQLite stub and returns null.
    // Fall back to the session user object populated during OAuth login.
    if (!user && req.session?.user) {
      const s = req.session.user;
      user = {
        id: userId,
        email: s.email || null,
        username: s.username || s.displayName || null,
        displayName: s.displayName || s.display_name || null,
        avatarUrl: s.avatarUrl || s.avatar_url || null,
        timezone: s.timezone || null,
        plan: s.plan || 'free',
      };
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if this is the user's first login based on session state
    const isFirstLogin = req.session?.isFirstLogin || false;

    // Look up the persistent master token from DB so every device gets the same one.
    // Prefer a token already cached in the session; fall back to the DB lookup.
    let masterTokenRaw = req.session?.masterTokenRaw || null;
    let masterTokenId  = req.session?.masterTokenId  || null;

    // Verify the session's cached token is still active in the DB (not revoked).
    // If it was revoked (e.g. by a regenerate call), clear it from the session
    // so we don't hand out a dead token as the bootstrap value.
    if (masterTokenId && !process.env.DATABASE_URL) {
      const { db } = require('../database');
      const tokenRow = db.prepare('SELECT revoked_at FROM access_tokens WHERE id = ?').get(masterTokenId);
      if (!tokenRow || tokenRow.revoked_at) {
        masterTokenRaw = null;
        masterTokenId  = null;
        if (req.session) {
          delete req.session.masterTokenRaw;
          delete req.session.masterTokenId;
          req.session.save?.((err) => { if (err) logger.error('[Auth/Me] Session clear error:', err); });
        }
      }
    }

    if (!masterTokenRaw) {
      const existing = getExistingMasterToken(userId);
      if (existing) {
        masterTokenRaw = existing.rawToken;
        masterTokenId  = existing.tokenId;
      } else {
        // No master token exists yet — create the canonical one for this user.
        // Platform-generated, not linked to any OAuth service. Persists until
        // the user explicitly rotates it via /tokens/master/regenerate.
        try {
          const rawToken = 'myapi_' + crypto.randomBytes(32).toString('hex');
          const hash = await bcrypt.hash(rawToken, 10);
          const tokenId = createAccessToken(hash, userId, 'full', 'Master Token', null, null, null, rawToken, 'master');
          masterTokenRaw = rawToken;
          masterTokenId  = tokenId;
          logger.info('[Auth/Me] Created initial master token', { userId, tokenId });
        } catch (mintErr) {
          logger.error('[Auth/Me] Failed to create master token', { error: mintErr.message });
        }
      }

      if (masterTokenRaw && req.session) {
        req.session.masterTokenRaw = masterTokenRaw;
        req.session.masterTokenId  = masterTokenId;
        req.session.save?.((err) => { if (err) logger.error('[Auth/Me] Session save error:', err); });
      }
    }

    const _pwrEmail = String(process.env.POWER_USER_EMAIL || process.env.OWNER_EMAIL || '').trim().toLowerCase();
    const userPayload = {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      timezone: user.timezone,
      plan: user.plan,
      isPowerUser: !!(_pwrEmail && String(user.email || '').toLowerCase() === _pwrEmail),
      needsOnboarding: Boolean(user?.needsOnboarding),
    };

    // SECURITY: only return the master token bootstrap to session-authenticated
    // requests (browser dashboard). Bearer-token callers (including scoped guest
    // tokens) must NOT receive the master token — doing so would allow any guest
    // token holder to escalate to full account control.
    const bootstrapPayload = (authViaSession && masterTokenRaw)
      ? { masterToken: masterTokenRaw, tokenId: masterTokenId }
      : null;

    res.json({
      success: true,
      user: userPayload,
      isFirstLogin,
      bootstrap: bootstrapPayload,
    });
  } catch (error) {
    logger.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ──────────────────────────────────────────────────────────────────────
// F5.2 P1 — Password reset flow
// ──────────────────────────────────────────────────────────────────────

// Per-email rate limit for /password/reset/request: at most 3 successful
// issuances per email address per rolling hour.  Per-IP throttling is
// already enforced by `authRateLimit` on the route.  Keyed by
// sha256(email).slice(0, 16) so we never log raw addresses in memory.
const PASSWORD_RESET_PER_EMAIL_LIMIT = 3;
const PASSWORD_RESET_PER_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const passwordResetEmailHits = new Map(); // emailKey → number[] timestamps

function emailKey(email) {
  return crypto
    .createHash('sha256')
    .update(String(email || '').toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

function checkPerEmailRateLimit(email) {
  const key = emailKey(email);
  const now = Date.now();
  const cutoff = now - PASSWORD_RESET_PER_EMAIL_WINDOW_MS;
  const hits = (passwordResetEmailHits.get(key) || []).filter((t) => t > cutoff);
  if (hits.length >= PASSWORD_RESET_PER_EMAIL_LIMIT) {
    passwordResetEmailHits.set(key, hits);
    return { allowed: false, count: hits.length };
  }
  hits.push(now);
  passwordResetEmailHits.set(key, hits);
  return { allowed: true, count: hits.length };
}

const PASSWORD_RESET_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2h per F5.2 D3

/**
 * POST /api/v1/auth/password/reset/request
 *
 * Always responds 202 to avoid leaking whether the email maps to a
 * real account.  If the email IS known, a 32-byte raw token is minted,
 * its bcrypt hash is persisted alongside `expires_at = now + 2h`, and
 * a reset link is emailed via `emailService.sendPasswordResetEmail`.
 *
 * Per-IP throttling: existing `authRateLimit` on the router (1000/min
 * in test mode, lower in prod via env).  Per-email throttling: 3 hits
 * per rolling hour.  When the per-email cap is hit we still return
 * 429 to slow down attackers spraying one address — the timing
 * difference is acceptable because the cap only triggers AFTER the
 * email has been successfully issued 3 times, so it can't be used
 * as an oracle for "does this email exist?" without the attacker
 * already knowing.
 */
router.post('/password/reset/request', authRateLimit, async (req, res) => {
  const { email } = req.body || {};
  const ip = req.ip;

  // Validate shape early.  Don't 400 on a missing email — that would
  // also be an oracle.  Just treat it as "unknown email".
  const safeEmail = typeof email === 'string' ? email.trim() : '';

  // Per-email rate limit BEFORE the user lookup so attackers can't
  // bypass it by spraying unknown addresses.
  if (safeEmail) {
    const { allowed } = checkPerEmailRateLimit(safeEmail);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many reset requests for this email. Try again later.' });
    }
  }

  let userKnown = false;
  let userId = null;

  try {
    const user = safeEmail ? getUserByEmail(safeEmail) : null;
    if (user && user.id) {
      userKnown = true;
      userId = user.id;
    }
  } catch (e) {
    logger.error('[Auth/PasswordReset] user lookup error', { err: e?.message });
  }

  if (userKnown) {
    try {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = await bcrypt.hash(rawToken, 10);
      const tokenId = `prt_${crypto.randomBytes(16).toString('hex')}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

      db.prepare(
        `INSERT INTO password_reset_tokens
         (id, user_id, token_hash, expires_at, consumed_at, request_ip, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run(tokenId, userId, tokenHash, expiresAt.toISOString(), ip || null, now.toISOString());

      const base = (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://www.myapiai.com').replace(/\/$/, '');
      const resetLink = `${base}/reset-password?token=${rawToken}`;

      // Debug-only — surfaces the raw link in the smoke container
      // (LOG_LEVEL=debug) so the F5.2 P1 e2e harness can pluck it
      // from `docker logs` without a real SMTP transport.  In prod
      // LOG_LEVEL=info silences this so we don't leak tokens.
      logger.debug('[Auth/PasswordReset] dev link', { resetLink });

      // Fire-and-forget; failures are logged inside the email service.
      emailService.sendPasswordResetEmail(safeEmail, resetLink).catch((err) => {
        logger.warn('[Auth/PasswordReset] email send failed', { err: err && err.message });
      });

      logger.info('[Auth/PasswordReset] request received', {
        ip,
        email_known: true,
        userId,
        tokenId,
      });
    } catch (err) {
      logger.error('[Auth/PasswordReset] mint/insert error', { err: err?.message });
    }
  } else {
    // Spend bcrypt work even on the unknown-email path so response
    // time doesn't differentiate user-found from user-missing.  The
    // spy-mocked email service path stays silent in tests.
    try {
      await bcrypt.hash('throwaway-equalize-timing', 10);
    } catch (_) {
      /* ignore */
    }
    logger.info('[Auth/PasswordReset] request received', { ip, email_known: false });
  }

  try {
    createAuditLog({
      requesterId: userId || 'unknown',
      action: 'password_reset_requested',
      resource: '/auth/password/reset/request',
      scope: 'public',
      ip,
      details: { email_known: userKnown },
    });
  } catch (auditErr) {
    logger.warn('[Auth/PasswordReset] audit emit error', { err: auditErr?.message });
  }

  return res.status(202).json({ message: 'If that email is registered, a reset link has been sent.' });
});

/**
 * POST /api/v1/auth/password/reset/confirm
 *
 * Body: { token, newPassword }.  We never store raw tokens, so we
 * iterate over unconsumed/unexpired rows and bcrypt-compare each.
 * On match: hash the new password (bcrypt cost 12 — cost 14 deferred
 * to F5.3), mark the token consumed, revoke ALL active sessions for
 * the user, then establish a brand-new session so the UI can land
 * already logged in.
 */
router.post('/password/reset/confirm', authRateLimit, async (req, res) => {
  const { token, newPassword } = req.body || {};
  const ip = req.ip;

  if (typeof token !== 'string' || token.length < 32) {
    return res.status(410).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
  }

  // Strength check BEFORE token lookup so a successful match isn't
  // wasted on a weak password (the token stays unconsumed and the
  // user can retry without re-requesting).
  const { isStrongPassword } = require('../utils/passwordUtils');
  if (typeof newPassword !== 'string' || !isStrongPassword(newPassword)) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters and contain 3 of: uppercase, lowercase, number, symbol',
    });
  }

  // Candidate rows: unconsumed and unexpired.  Iterate and
  // bcrypt-compare.  In practice this is small (most users have at
  // most one or two pending reset tokens at a time).
  let candidates = [];
  try {
    const nowIso = new Date().toISOString();
    candidates = db
      .prepare(
        `SELECT id, user_id, token_hash, expires_at, consumed_at
         FROM password_reset_tokens
         WHERE consumed_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 200`,
      )
      .all(nowIso);
  } catch (e) {
    logger.error('[Auth/PasswordReset] candidate query error', { err: e?.message });
    return res.status(500).json({ error: 'Internal server error' });
  }

  let matched = null;
  for (const row of candidates) {
    try {
      const ok = await bcrypt.compare(token, row.token_hash);
      if (ok) {
        matched = row;
        break;
      }
    } catch (_) {
      /* keep iterating */
    }
  }

  if (!matched) {
    return res.status(410).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
  }

  let newHash;
  try {
    newHash = await bcrypt.hash(newPassword, 12);
  } catch (e) {
    logger.error('[Auth/PasswordReset] hash error', { err: e?.message });
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    // Two-statement sequential update.  Password write first so that
    // if `consumed_at` fails the user can still log in with the new
    // password (the token will still expire on its own TTL).  This
    // keeps the failure mode strictly less bad than the alternative.
    writeUserPasswordHash(matched.user_id, newHash);
    db.prepare('UPDATE password_reset_tokens SET consumed_at = ? WHERE id = ?')
      .run(new Date().toISOString(), matched.id);
  } catch (e) {
    logger.error('[Auth/PasswordReset] commit error', { err: e && e.message });
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Revoke all prior sessions BEFORE establishing a new one, otherwise
  // we'd kill the session we're about to mint.
  try {
    revokeAllUserSessions(matched.user_id);
  } catch (e) {
    logger.warn('[Auth/PasswordReset] revoke sessions failed', { err: e?.message });
  }

  // Mint a fresh session so the UI lands already authenticated.
  try {
    await regenerateSession(req);

    let user = null;
    try {
      const { getUserById } = require('../database');
      user = getUserById(matched.user_id);
    } catch (_) {
      /* fall back to minimal payload below */
    }

    let workspaceId = null;
    try {
      const ws = getOrEnsureUserWorkspace(matched.user_id);
      workspaceId = ws?.id || null;
    } catch (_) {
      /* non-fatal */
    }

    let masterTokenRaw = null;
    let masterTokenId = null;
    try {
      const existing = getExistingMasterToken(matched.user_id);
      if (existing) {
        masterTokenRaw = existing.rawToken;
        masterTokenId = existing.tokenId;
      }
    } catch (_) {
      /* non-fatal */
    }

    if (req.session) {
      req.session.user = {
        id: matched.user_id,
        email: user?.email || null,
        username: user?.username || null,
        displayName: user?.displayName || null,
        twoFactorEnabled: Boolean(user?.twoFactorEnabled),
      };
      req.session.masterTokenRaw = masterTokenRaw;
      req.session.masterTokenId = masterTokenId;
      if (workspaceId) req.session.currentWorkspace = workspaceId;
    }

    await new Promise((resolve) => {
      if (!req.session?.save) return resolve();
      req.session.save(() => resolve());
    });

    try {
      registerUserSession(matched.user_id, req.sessionID);
    } catch (regErr) {
      logger.warn('[Auth/PasswordReset] registerUserSession failed', { err: regErr?.message });
    }
  } catch (sessErr) {
    logger.warn('[Auth/PasswordReset] session establish error', { err: sessErr?.message });
    // Non-fatal: the password change still committed.  The user can
    // log in fresh on the next page load.
  }

  try {
    createAuditLog({
      requesterId: matched.user_id,
      action: 'password_reset_completed',
      resource: `/users/${matched.user_id}`,
      scope: 'session',
      ip,
      details: { sid: req.sessionID || null, tokenRowId: matched.id },
    });
  } catch (auditErr) {
    logger.warn('[Auth/PasswordReset] completed audit emit error', { err: auditErr?.message });
  }

  logger.info('[Auth/PasswordReset] confirmed', { userId: matched.user_id });

  return res.json({
    success: true,
    message: 'Password updated. You are now signed in.',
  });
});

// ──────────────────────────────────────────────────────────────────────
// F5.2 P2 — Change password (authenticated rotation)
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the authenticated caller for `/password/change` without
 * relying on the global `authenticate()` middleware (which is mounted
 * elsewhere with stricter contracts).  Returns:
 *   { userId, via: 'session' | 'bearer', sid: string|null }
 * or `null` if no valid auth was presented.
 *
 * This matches the dual-auth pattern used by `/auth/me` so a CLI agent
 * holding the master Bearer token can rotate the password too — when
 * Bearer-authed there is no current session to preserve, so EVERY
 * existing session gets revoked.
 */
async function resolveChangePasswordCaller(req) {
  if (req.session?.user?.id) {
    return {
      userId: String(req.session.user.id),
      via: 'session',
      sid: req.sessionID || null,
    };
  }

  const authHeader = req.headers.authorization || '';
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    const rawToken = parts[1];
    const tokens = getAccessTokens() || [];
    for (const tokenRecord of tokens) {
      if (tokenRecord.revokedAt) continue;
      if (tokenRecord.expiresAt && new Date(tokenRecord.expiresAt) <= new Date()) continue;
      if (!tokenRecord.hash) continue;
      const ok = await bcrypt.compare(rawToken, tokenRecord.hash).catch(() => false);
      if (ok) {
        return {
          userId: String(tokenRecord.ownerId),
          via: 'bearer',
          sid: null,
        };
      }
    }
  }

  return null;
}

/**
 * POST /api/v1/auth/password/change
 *
 * Body: { currentPassword, newPassword }.
 *
 * Contract (per F5.2 P2 plan):
 *   - 401 INVALID_CREDENTIALS if `currentPassword` doesn't match.
 *   - 400 PASSWORD_REUSED if `newPassword === currentPassword`.
 *   - 400 if `newPassword` fails `isStrongPassword`.
 *   - 200 on success.  Session-authed callers keep THEIR session;
 *     every other session for the user is dropped.  Bearer-authed
 *     callers have ALL sessions dropped (there's no caller-side
 *     session to preserve).
 *   - Sends a "your password was changed" notification email.
 *   - Emits `password_changed` audit row with `details.sessions_revoked`
 *     and `details.via` so SOC2 reviewers can correlate the rotation
 *     with active-session activity.
 *
 * Owner-row guard: the boot-time `owner` user is the FK anchor for the
 * platform's master token (ADR-0015) and the AI-agent / CLI auth chain.
 * We refuse to change its password through this endpoint regardless of
 * who is calling — operators rotate it via the seed/secret pipeline.
 */
router.post('/password/change', authRateLimit, requireCsrfForSession, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }

  const caller = await resolveChangePasswordCaller(req);
  if (!caller) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Out-of-scope guard: the platform owner row is reserved (ADR-0015).
  if (caller.userId === 'owner') {
    return res.status(403).json({
      error: 'OWNER_ROW_PROTECTED',
      message: 'The platform owner password is rotated via the operator pipeline, not the dashboard.',
    });
  }

  // Cheap pre-check before bcrypt comparisons — same string is a
  // policy violation regardless of whether it matches the DB hash.
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'PASSWORD_REUSED' });
  }

  const { isStrongPassword } = require('../utils/passwordUtils');
  if (!isStrongPassword(newPassword)) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters and contain 3 of: uppercase, lowercase, number, symbol',
    });
  }

  let user = null;
  try {
    user = db
      .prepare('SELECT id, email, username, display_name, password_hash FROM users WHERE id = ?')
      .get(caller.userId);
  } catch (e) {
    logger.error('[Auth/PasswordChange] user lookup error', { err: e?.message });
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!user || !user.password_hash) {
    // No password hash means this account was provisioned via OAuth and
    // has never set a local password.  Direct the user to the reset
    // flow so they go through the email-verified path.
    return res.status(400).json({
      error: 'PASSWORD_NOT_SET',
      message: 'This account has no password yet. Use "Forgot password" to set one.',
    });
  }

  const currentMatches = await bcrypt
    .compare(currentPassword, user.password_hash)
    .catch(() => false);
  if (!currentMatches) {
    try {
      createAuditLog({
        requesterId: caller.userId,
        action: 'failed_login',
        resource: '/auth/password/change',
        scope: 'session',
        ip: req.ip,
        details: { reason: 'invalid_current_password', via: caller.via },
      });
    } catch (auditErr) {
      logger.warn('[Auth/PasswordChange] failed_login audit emit error', { err: auditErr?.message });
    }
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }

  // Defense in depth — `newPassword !== currentPassword` was a string
  // compare; some users may also try variants of the SAME password
  // that bcrypt-compare against the existing hash (extremely unlikely
  // but cheap to check).
  const newSameAsOld = await bcrypt.compare(newPassword, user.password_hash).catch(() => false);
  if (newSameAsOld) {
    return res.status(400).json({ error: 'PASSWORD_REUSED' });
  }

  let newHash;
  try {
    newHash = await bcrypt.hash(newPassword, 12);
  } catch (e) {
    logger.error('[Auth/PasswordChange] hash error', { err: e?.message });
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    writeUserPasswordHash(caller.userId, newHash);
  } catch (e) {
    logger.error('[Auth/PasswordChange] commit error', { err: e?.message });
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Session revocation: keep THIS session alive for the cookie path so
  // the user's current tab doesn't blink out; for Bearer callers there
  // is no current session to preserve.
  let sessionsRevoked = 0;
  try {
    const opts = caller.via === 'session' && caller.sid ? { except: caller.sid } : {};
    sessionsRevoked = revokeAllUserSessions(caller.userId, opts) || 0;
  } catch (e) {
    logger.warn('[Auth/PasswordChange] revoke sessions failed', { err: e?.message });
  }

  // Notification email (D2 in the plan) — fire-and-forget; failures
  // never block the 200 because the password update already committed.
  if (user.email) {
    emailService
      .sendPasswordChangedNotification(user.email, user.display_name || user.username, {
        when: new Date().toISOString(),
        ip: req.ip || 'unknown',
        sessionsRevoked,
      })
      .catch((err) => {
        logger.warn('[Auth/PasswordChange] notification email failed', { err: err && err.message });
      });
  }

  try {
    createAuditLog({
      requesterId: caller.userId,
      action: 'password_changed',
      resource: `/users/${caller.userId}`,
      scope: 'session',
      ip: req.ip,
      details: {
        via: caller.via,
        sessions_revoked: sessionsRevoked,
        sid: caller.sid || null,
      },
    });
  } catch (auditErr) {
    logger.warn('[Auth/PasswordChange] audit emit error', { err: auditErr?.message });
  }

  logger.info('[Auth/PasswordChange] success', {
    userId: caller.userId,
    via: caller.via,
    sessionsRevoked,
  });

  return res.json({
    success: true,
    message:
      sessionsRevoked > 0
        ? `Password updated. ${sessionsRevoked} other session${sessionsRevoked === 1 ? '' : 's'} signed out.`
        : 'Password updated.',
    sessionsRevoked,
  });
});

module.exports = router;
