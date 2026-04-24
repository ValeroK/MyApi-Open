'use strict';

/**
 * F4 — OAuth identity vs. service scope separation.
 *
 * Core invariants this suite locks in:
 *
 *   1. Each login-capable adapter (Google, GitHub, Facebook) exposes two
 *      distinct scope sets: IDENTITY (used for `mode='login'` and
 *      `mode='signup'`) and SERVICE (used for `mode='connect'`).
 *   2. Identity scopes are baked into adapter constants — they are NOT
 *      env-overridable. They are a security primitive, not a feature flag.
 *   3. `access_type=offline` (Google) is requested in connect-mode only.
 *      Login-mode is a lightweight sign-in; no refresh token is needed.
 *   4. Login-mode OAuth callback MUST NOT write `oauth_tokens`. Identity
 *      state lives in `user_identity_links` instead.
 *   5. `user_identity_links` enforces two invariants at the DB level:
 *        - PK (user_id, provider): one identity per provider per MyApi user.
 *        - UNIQUE (provider, provider_subject): one MyApi user per provider
 *          account (prevents account-takeover via provider-side collision).
 *   6. Login-provider account and service-provider account are fully
 *      decoupled: Alice can log in as `alice@personal.gmail.com` and
 *      separately connect `alice@work.company.com` as a Google service
 *      without either overwriting the other.
 *   7. The scope-env overrides (`GOOGLE_SCOPE`, `GITHUB_SCOPE`,
 *      `FACEBOOK_SERVICE_SCOPE`) only affect connect-mode. Login scope
 *      is never env-overridable.
 *
 * Red-first: this suite was written BEFORE the implementation. Every test
 * below is expected to fail pre-F4 and pass post-F4.
 *
 * See `.context/tasks/in-progress/F4-oauth-identity-vs-service-separation.md`
 * and ADR-0018 (to be written alongside implementation) for design rationale.
 */

const path = require('path');
const fs = require('fs');
const querystring = require('querystring');

async function safeUnlink(p) {
  if (!p) return;
  const targets = [p, `${p}-wal`, `${p}-shm`];
  for (const target of targets) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        break;
      } catch (err) {
        if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        if (err && err.code === 'ENOENT') break;
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter-level unit tests (no DB, no HTTP)
// ---------------------------------------------------------------------------

describe('F4 — adapter scope separation (unit, no DB)', () => {
  // These tests are DB-free: they construct adapters directly and inspect
  // the authorize URL they produce. They fail fast before we touch schema
  // or routing, so any regression here is clearly a scope bug, not a
  // migration or HTTP-layer bug.

  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ---- Google ------------------------------------------------------------

  describe('GoogleAdapter', () => {
    const GoogleAdapter = require('../services/google-adapter');

    const newAdapter = () =>
      new GoogleAdapter({
        clientId: 'test-google-client',
        clientSecret: 'test-google-secret',
        redirectUri: 'http://localhost:4500/api/v1/oauth/callback/google',
      });

    test('mode=login requests IDENTITY scopes only (openid email profile), no Gmail/Calendar/Drive', () => {
      const url = new URL(newAdapter().getAuthorizationUrl('s1', {}, { mode: 'login' }));
      const scopes = (url.searchParams.get('scope') || '').split(/[\s+]+/).filter(Boolean);

      // Identity scopes required.
      expect(scopes).toEqual(expect.arrayContaining(['openid', 'email', 'profile']));
      // Service scopes MUST NOT leak into login.
      expect(scopes).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/gmail/i),
        expect.stringMatching(/calendar/i),
        expect.stringMatching(/drive/i),
      ]));
    });

    test('mode=login does NOT request access_type=offline (sign-in, not long-lived grant)', () => {
      const url = new URL(newAdapter().getAuthorizationUrl('s2', {}, { mode: 'login' }));
      expect(url.searchParams.get('access_type')).toBeNull();
    });

    test('mode=connect requests IDENTITY + SERVICE scopes and access_type=offline', () => {
      const url = new URL(newAdapter().getAuthorizationUrl('s3', {}, { mode: 'connect' }));
      const scope = url.searchParams.get('scope') || '';

      expect(scope).toMatch(/openid/);
      expect(scope).toMatch(/email/);
      expect(scope).toMatch(/profile/);
      expect(scope).toMatch(/gmail\.modify/);
      expect(scope).toMatch(/calendar\.readonly/);
      expect(scope).toMatch(/drive\.file/);
      expect(url.searchParams.get('access_type')).toBe('offline');
    });

    test('mode=signup treated as identity-only (same as login, choice 3a)', () => {
      const url = new URL(newAdapter().getAuthorizationUrl('s4', {}, { mode: 'signup' }));
      const scope = url.searchParams.get('scope') || '';

      expect(scope).not.toMatch(/gmail/);
      expect(scope).not.toMatch(/calendar/);
      expect(scope).not.toMatch(/drive/);
      expect(url.searchParams.get('access_type')).toBeNull();
    });

    test('GOOGLE_SCOPE env override only affects connect-mode; login always gets identity', () => {
      process.env.GOOGLE_SCOPE = 'https://www.googleapis.com/auth/chat.messages';

      const adapter = newAdapter();
      const loginUrl = new URL(adapter.getAuthorizationUrl('s5', {}, { mode: 'login' }));
      const connectUrl = new URL(adapter.getAuthorizationUrl('s6', {}, { mode: 'connect' }));

      // Login still gets identity-only, ignoring the env override.
      const loginScope = loginUrl.searchParams.get('scope') || '';
      expect(loginScope).toMatch(/openid/);
      expect(loginScope).not.toMatch(/chat\.messages/);

      // Connect picks up the env override (plus identity).
      const connectScope = connectUrl.searchParams.get('scope') || '';
      expect(connectScope).toMatch(/chat\.messages/);
      expect(connectScope).toMatch(/openid/);
    });

    test('legacy call signature (no mode arg) defaults to connect-mode for backwards compat', () => {
      // Pre-F4 callers that don't pass a mode hint should still behave
      // like "connect" — full scopes + offline — so nothing breaks during
      // the atomic migration. The one production call site
      // (`src/index.js:8580`) always passes mode after F4; this test is
      // defense-in-depth for anything we missed.
      const url = new URL(newAdapter().getAuthorizationUrl('s7', {}));
      const scope = url.searchParams.get('scope') || '';

      expect(scope).toMatch(/gmail\.modify/);
      expect(url.searchParams.get('access_type')).toBe('offline');
    });

    test('include_granted_scopes=true ONLY for connect-mode, OMITTED for login/signup (F3 follow-up, revised)', () => {
      // For connect-mode, incremental authorization against existing
      // grants is the right default. For login/signup, the flag causes
      // Google to re-render any prior connect-mode grant (drive/calendar/
      // gmail) on the consent screen even though we're asking only for
      // identity — confusing UX and wrong security posture. Observed bug
      // 2026-04-24 with a pre-existing connect-mode grant; the fix is to
      // keep login/signup isolated from prior grant state.
      const adapter = newAdapter();

      const loginUrl = new URL(adapter.getAuthorizationUrl('s-login', {}, { mode: 'login' }));
      expect(loginUrl.searchParams.get('include_granted_scopes')).toBeNull();

      const signupUrl = new URL(adapter.getAuthorizationUrl('s-signup', {}, { mode: 'signup' }));
      expect(signupUrl.searchParams.get('include_granted_scopes')).toBeNull();

      const connectUrl = new URL(adapter.getAuthorizationUrl('s-connect', {}, { mode: 'connect' }));
      expect(connectUrl.searchParams.get('include_granted_scopes')).toBe('true');
    });
  });

  // ---- GitHub ------------------------------------------------------------

  describe('GitHubAdapter', () => {
    const GitHubAdapter = require('../services/github-adapter');

    const newAdapter = () =>
      new GitHubAdapter({
        clientId: 'test-github-client',
        clientSecret: 'test-github-secret',
        redirectUri: 'http://localhost:4500/api/v1/oauth/callback/github',
      });

    test('mode=login requests IDENTITY scopes only (read:user user:email), no repo/gist/workflow', () => {
      const url = new URL(newAdapter().getAuthorizationUrl('s1', {}, { mode: 'login' }));
      const scope = url.searchParams.get('scope') || '';
      const scopes = scope.split(/[\s+,]+/).filter(Boolean);

      expect(scopes).toEqual(expect.arrayContaining(['read:user', 'user:email']));
      // These MUST NOT be requested for login.
      expect(scope).not.toMatch(/\brepo\b/);
      expect(scope).not.toMatch(/\bgist\b/);
      expect(scope).not.toMatch(/\bworkflow\b/);
    });

    test('mode=connect requests SERVICE scopes (repo, gist, workflow)', () => {
      const url = new URL(newAdapter().getAuthorizationUrl('s2', {}, { mode: 'connect' }));
      const scope = url.searchParams.get('scope') || '';

      expect(scope).toMatch(/\brepo\b/);
      expect(scope).toMatch(/\bgist\b/);
    });

    test('mode=signup is identity-only (choice 3a)', () => {
      const url = new URL(newAdapter().getAuthorizationUrl('s3', {}, { mode: 'signup' }));
      const scope = url.searchParams.get('scope') || '';

      expect(scope).not.toMatch(/\brepo\b/);
      expect(scope).not.toMatch(/\bgist\b/);
    });

    test('GITHUB_SCOPE env override only affects connect-mode', () => {
      process.env.GITHUB_SCOPE = 'read:org admin:repo_hook';

      const adapter = newAdapter();
      const loginUrl = new URL(adapter.getAuthorizationUrl('s4', {}, { mode: 'login' }));
      const connectUrl = new URL(adapter.getAuthorizationUrl('s5', {}, { mode: 'connect' }));

      expect(loginUrl.searchParams.get('scope') || '').not.toMatch(/admin:repo_hook/);
      expect(connectUrl.searchParams.get('scope') || '').toMatch(/admin:repo_hook/);
    });
  });

  // ---- Facebook (GenericOAuthAdapter) -----------------------------------

  describe('Facebook (GenericOAuthAdapter)', () => {
    const GenericOAuthAdapter = require('../services/generic-oauth-adapter');

    const newAdapter = () =>
      new GenericOAuthAdapter({
        serviceName: 'facebook',
        clientId: 'test-facebook-client',
        clientSecret: 'test-facebook-secret',
        redirectUri: 'http://localhost:4500/api/v1/oauth/callback/facebook',
        authUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
        verifyUrl: 'https://graph.facebook.com/me',
        identityScope: 'email public_profile',
        serviceScope: 'user_posts pages_read_engagement',
      });

    test('mode=login requests identityScope only', () => {
      const url = new URL(newAdapter().getAuthorizationUrl('s1', {}, { mode: 'login' }));
      const scope = url.searchParams.get('scope') || '';

      expect(scope).toMatch(/email/);
      expect(scope).toMatch(/public_profile/);
      expect(scope).not.toMatch(/user_posts/);
      expect(scope).not.toMatch(/pages_read_engagement/);
    });

    test('mode=connect requests identity + service scopes', () => {
      const url = new URL(newAdapter().getAuthorizationUrl('s2', {}, { mode: 'connect' }));
      const scope = url.searchParams.get('scope') || '';

      expect(scope).toMatch(/email/);
      expect(scope).toMatch(/public_profile/);
      expect(scope).toMatch(/user_posts/);
    });

    test('adapter configured with only legacy `scope` (no identity/service split) falls back to sending it in all modes', () => {
      // Backwards compat: service-only adapters like Slack/Discord/Twitter
      // don't have a login mode and don't need identity-scope awareness.
      // If a caller uses the old single-`scope` config, it must keep
      // working for connect-mode without surprise.
      const adapter = new GenericOAuthAdapter({
        serviceName: 'slackish',
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'http://localhost/cb',
        authUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
        scope: 'chat:write users:read',
      });
      const url = new URL(adapter.getAuthorizationUrl('s3', {}, { mode: 'connect' }));
      expect(url.searchParams.get('scope')).toBe('chat:write users:read');
    });

    test('B1: identityScope + legacy `scope` (operator only set FACEBOOK_SCOPE) combines for connect-mode', () => {
      // Regression tripwire for B1 (2026-04-24 F4 hardening): an
      // operator upgrading in-place from pre-F4 would have only set
      // `FACEBOOK_SCOPE=...` in their env. After F4, generic-oauth-adapter
      // gained `identityScope` + `serviceScope` and — pre-fix — silently
      // dropped the legacy scope on the floor in connect-mode if no
      // `serviceScope` was supplied. Verify the combined result comes
      // out the other side.
      const adapter = new GenericOAuthAdapter({
        serviceName: 'facebook',
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'http://localhost/cb',
        authUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
        identityScope: 'email public_profile',
        // NO serviceScope. Legacy `scope` only.
        scope: 'user_posts pages_manage_posts',
      });
      const connectUrl = new URL(adapter.getAuthorizationUrl('sB1c', {}, { mode: 'connect' }));
      const connectScope = connectUrl.searchParams.get('scope') || '';
      expect(connectScope).toMatch(/email/);
      expect(connectScope).toMatch(/public_profile/);
      expect(connectScope).toMatch(/user_posts/);
      expect(connectScope).toMatch(/pages_manage_posts/);

      // And login-mode stays identity-only (legacy scope MUST NOT leak).
      const loginUrl = new URL(adapter.getAuthorizationUrl('sB1l', {}, { mode: 'login' }));
      const loginScope = loginUrl.searchParams.get('scope') || '';
      expect(loginScope).toMatch(/email/);
      expect(loginScope).not.toMatch(/user_posts/);
      expect(loginScope).not.toMatch(/pages_manage_posts/);
    });
  });

  // ---- Cross-adapter scope isolation (copy-paste bug guard) -------------

  describe('cross-adapter scope isolation', () => {
    test('Google adapter never emits GitHub or Facebook scope strings', () => {
      const GoogleAdapter = require('../services/google-adapter');
      const url = new URL(new GoogleAdapter({
        clientId: 'x', clientSecret: 'y', redirectUri: 'http://x/cb',
      }).getAuthorizationUrl('s', {}, { mode: 'connect' }));
      const scope = url.searchParams.get('scope') || '';
      expect(scope).not.toMatch(/\brepo\b/);
      expect(scope).not.toMatch(/user_posts/);
    });

    test('GitHub adapter never emits Google or Facebook scope strings', () => {
      const GitHubAdapter = require('../services/github-adapter');
      const url = new URL(new GitHubAdapter({
        clientId: 'x', clientSecret: 'y', redirectUri: 'http://x/cb',
      }).getAuthorizationUrl('s', {}, { mode: 'connect' }));
      const scope = url.searchParams.get('scope') || '';
      expect(scope).not.toMatch(/gmail/);
      expect(scope).not.toMatch(/calendar/);
      expect(scope).not.toMatch(/drive/);
      expect(scope).not.toMatch(/user_posts/);
    });
  });
});

// ---------------------------------------------------------------------------
// Identity-links module unit tests (DB, no HTTP)
// ---------------------------------------------------------------------------

describe('F4 — user_identity_links domain module', () => {
  // These tests exercise the domain module directly against a fresh test
  // DB. No server, no HTTP; just the schema + module contract.

  const dbPath = path.join(__dirname, 'tmp-oauth-identity-links.sqlite');
  const sessionDbPath = path.join(__dirname, 'tmp-oauth-identity-links-sessions.sqlite');

  let dbModule;
  let db;
  let identityLinks;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DB_PATH = dbPath;
    process.env.SESSION_DB_PATH = sessionDbPath;
    await safeUnlink(dbPath);
    await safeUnlink(sessionDbPath);

    dbModule = require('../database');
    dbModule.initDatabase();
    db = dbModule.getDatabase ? dbModule.getDatabase() : dbModule.db;

    identityLinks = require('../domain/oauth/identity-links');
  });

  afterAll(async () => {
    await safeUnlink(dbPath);
    await safeUnlink(sessionDbPath);
  });

  test('schema: user_identity_links table exists with expected columns', () => {
    const cols = db
      .prepare('PRAGMA table_info(user_identity_links)')
      .all()
      .map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'user_id',
        'provider',
        'provider_subject',
        'email',
        'first_confirmed_at',
        'created_at',
        'updated_at',
      ])
    );
  });

  test('schema: PK is (user_id, provider) — one identity per provider per user', () => {
    const userId = 'user_' + Date.now();
    // Seed user row so FK doesn't trip (if FK is enforced).
    try {
      db.prepare(
        `INSERT INTO users (id, username, password_hash, display_name, email, timezone, created_at, status, roles)
         VALUES (?, ?, 'x', ?, ?, 'UTC', ?, 'active', 'user')`
      ).run(userId, 'u' + Date.now(), 'User', 'u@x', new Date().toISOString());
    } catch (_e) {
      // users table shape may differ; ignore if this insert isn't applicable
      // — the PK invariant we actually care about is on user_identity_links.
    }

    identityLinks.upsertIdentityLink({
      db,
      userId,
      provider: 'google',
      providerSubject: 'sub-aaaa',
      email: 'a@x',
    });

    // Second call with same (user, provider) but different subject must
    // UPSERT the existing row (not create a duplicate). After the call,
    // there's exactly ONE row for (user_id, 'google').
    identityLinks.upsertIdentityLink({
      db,
      userId,
      provider: 'google',
      providerSubject: 'sub-bbbb',
      email: 'b@x',
    });

    const rows = db
      .prepare('SELECT * FROM user_identity_links WHERE user_id = ? AND provider = ?')
      .all(userId, 'google');
    expect(rows).toHaveLength(1);
    expect(rows[0].provider_subject).toBe('sub-bbbb');
  });

  test('schema: UNIQUE (provider, provider_subject) — one MyApi user per provider account', () => {
    const subject = 'shared-sub-' + Date.now();
    const u1 = 'u1_' + Date.now();
    const u2 = 'u2_' + Date.now();

    identityLinks.upsertIdentityLink({
      db,
      userId: u1,
      provider: 'github',
      providerSubject: subject,
      email: 'one@x',
    });

    // Second user trying to claim the same (github, subject) must fail.
    expect(() =>
      identityLinks.upsertIdentityLink({
        db,
        userId: u2,
        provider: 'github',
        providerSubject: subject,
        email: 'two@x',
      })
    ).toThrow();
  });

  test('hasConfirmedBefore returns false before recordFirstConfirmation, true after', () => {
    const userId = 'conf_' + Date.now();
    identityLinks.upsertIdentityLink({
      db,
      userId,
      provider: 'google',
      providerSubject: 'sub-conf',
      email: 'c@x',
    });

    expect(
      identityLinks.hasConfirmedBefore({
        db,
        userId,
        provider: 'google',
        providerSubject: 'sub-conf',
      })
    ).toBe(false);

    identityLinks.recordFirstConfirmation({
      db,
      userId,
      provider: 'google',
      providerSubject: 'sub-conf',
    });

    expect(
      identityLinks.hasConfirmedBefore({
        db,
        userId,
        provider: 'google',
        providerSubject: 'sub-conf',
      })
    ).toBe(true);
  });

  test('hasConfirmedBefore is keyed by provider_subject (subject change ⇒ re-gesture)', () => {
    // ADR-0016 invariant: if the provider_subject changes on a subsequent
    // login for the same (user, provider), the gesture screen re-fires.
    // This protects against an attacker who briefly controls the callback
    // URL silently aliasing their OAuth identity onto a pre-confirmed row.
    const userId = 'subjsw_' + Date.now();

    identityLinks.upsertIdentityLink({
      db, userId, provider: 'google', providerSubject: 'subA', email: 'a@x',
    });
    identityLinks.recordFirstConfirmation({
      db, userId, provider: 'google', providerSubject: 'subA',
    });

    // Same tuple confirmed before.
    expect(identityLinks.hasConfirmedBefore({
      db, userId, provider: 'google', providerSubject: 'subA',
    })).toBe(true);

    // Subject swap must NOT be pre-confirmed.
    expect(identityLinks.hasConfirmedBefore({
      db, userId, provider: 'google', providerSubject: 'subB',
    })).toBe(false);
  });

  test('findUserByProviderSubject returns user_id for a known (provider, subject)', () => {
    const userId = 'find_' + Date.now();
    const subject = 'sub-find-' + Date.now();

    identityLinks.upsertIdentityLink({
      db, userId, provider: 'google', providerSubject: subject, email: 'f@x',
    });

    const found = identityLinks.findUserByProviderSubject({
      db, provider: 'google', providerSubject: subject,
    });
    expect(found).toEqual(expect.objectContaining({ user_id: userId, provider: 'google' }));

    // Negative: unknown subject returns null.
    expect(
      identityLinks.findUserByProviderSubject({
        db, provider: 'google', providerSubject: 'nobody',
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Decoupling property (the headline F4 requirement): login Google ≠ service Google
// ---------------------------------------------------------------------------

describe('F4 — login-provider and service-provider accounts are independent', () => {
  const dbPath = path.join(__dirname, 'tmp-oauth-identity-decoupling.sqlite');
  const sessionDbPath = path.join(__dirname, 'tmp-oauth-identity-decoupling-sessions.sqlite');

  let dbModule;
  let db;
  let identityLinks;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DB_PATH = dbPath;
    process.env.SESSION_DB_PATH = sessionDbPath;
    await safeUnlink(dbPath);
    await safeUnlink(sessionDbPath);

    dbModule = require('../database');
    dbModule.initDatabase();
    db = dbModule.getDatabase ? dbModule.getDatabase() : dbModule.db;
    identityLinks = require('../domain/oauth/identity-links');
  });

  afterAll(async () => {
    await safeUnlink(dbPath);
    await safeUnlink(sessionDbPath);
  });

  test('user logs in as Google A, connects Google B as service, logs in as A again — no thrash', () => {
    const userId = 'alice_' + Date.now();
    const subA = 'google-personal-sub';
    const subB = 'google-work-sub';

    // Step 1: Alice logs in with personal Google (subA).
    identityLinks.upsertIdentityLink({
      db, userId, provider: 'google', providerSubject: subA, email: 'alice@personal.gmail.com',
    });
    identityLinks.recordFirstConfirmation({
      db, userId, provider: 'google', providerSubject: subA,
    });

    // Step 2: Alice connects work Google (subB) as a service. This writes
    // `oauth_tokens` keyed by (google, alice.id). It MUST NOT touch
    // `user_identity_links`, because the work Google is not her login
    // identity — she logged in with personal.
    const { storeOAuthToken } = require('../database');
    storeOAuthToken(
      'google',
      userId,
      'svc-access-token',
      'svc-refresh-token',
      new Date(Date.now() + 3600_000).toISOString(),
      'gmail.modify calendar.readonly',
      // NOTE: explicitly NOT passing subB as provider_subject here — that
      // column is login-identity, not service-identity. Post-F4,
      // storeOAuthToken SHOULD NOT treat its 7th arg as login identity.
      null
    );

    // Step 3: Alice logs in again with personal Google (subA).
    // `hasConfirmedBefore` MUST still return true — the identity link for
    // (alice, google, subA) is untouched by the service connect.
    expect(
      identityLinks.hasConfirmedBefore({
        db, userId, provider: 'google', providerSubject: subA,
      })
    ).toBe(true);

    // The identity-links table has exactly one row for (alice, google),
    // and it's still subA.
    const rows = db
      .prepare('SELECT provider_subject, email FROM user_identity_links WHERE user_id = ? AND provider = ?')
      .all(userId, 'google');
    expect(rows).toHaveLength(1);
    expect(rows[0].provider_subject).toBe(subA);
    expect(rows[0].email).toBe('alice@personal.gmail.com');

    // The service token for subB is untouched.
    const tokenRow = db
      .prepare('SELECT access_token FROM oauth_tokens WHERE service_name = ? AND user_id = ?')
      .get('google', userId);
    expect(tokenRow).toBeTruthy();
  });
});
