const https = require('https');
const querystring = require('querystring');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// F4 (ADR-0018): scope separation — identity vs service.
//
// IDENTITY_SCOPES is what "Sign in with Google" needs: just enough to
// verify who this person is (sub claim, email, display name). These
// scopes are non-sensitive; Google does NOT re-prompt for consent for
// returning users, does NOT require app verification, and does NOT
// trigger Testing-mode weekly re-consent. Deliberately NOT configurable
// via env var — identity scope is a security primitive, not a feature
// flag.
//
// SERVICE_SCOPES is what an agent needs to actually call Gmail / Calendar
// / Drive on the user's behalf. These are sensitive, require verification
// for production, and rightfully show the consent screen at first connect.
// Env-overridable via GOOGLE_SCOPE so operators can expand/contract the
// grant surface without a code change.
const IDENTITY_SCOPES = 'openid email profile';
const DEFAULT_SERVICE_SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.file';

class GoogleAdapter {
  constructor(config) {
    this.clientId = config.clientId || process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.GOOGLE_CLIENT_SECRET;
    this.redirectUri = config.redirectUri || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4500/api/v1/oauth/callback/google';
  }

  isConfigured() {
    return Boolean(
      (this.clientId || '').toString().trim() &&
      (this.clientSecret || '').toString().trim() &&
      (this.redirectUri || '').toString().trim()
    );
  }

  /**
   * @param {string} state
   * @param {object} [runtimeAuthParams]
   * @param {object} [options]
   * @param {'login'|'signup'|'connect'} [options.mode]  F4: scope hint.
   *   - 'login' / 'signup' → identity-only scope, no access_type=offline.
   *   - 'connect' → identity + service scopes + access_type=offline.
   *   - omitted → connect-mode defaults (backwards compatible with pre-F4
   *     callers; the one production call site in src/index.js always
   *     passes mode explicitly after F4).
   */
  getAuthorizationUrl(state, runtimeAuthParams = {}, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Google OAuth is not configured (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)');
    }

    const mode = options && options.mode;
    const isIdentityOnly = mode === 'login' || mode === 'signup';

    const serviceScope = process.env.GOOGLE_SCOPE || DEFAULT_SERVICE_SCOPES;
    const scope = isIdentityOnly
      ? IDENTITY_SCOPES
      : `${IDENTITY_SCOPES} ${serviceScope}`;

    const params = {
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope,
      state: state,
      // access_type=offline requests a refresh_token for long-lived API
      // access. Login-mode is a lightweight sign-in, not a long-lived
      // grant — omitting this avoids Google's "sensitive scope + offline
      // access" re-prompt path on every login.
      access_type: isIdentityOnly ? null : 'offline',
      // F3 Pass 2 (2026-04-24): adapter default flipped from `consent` to
      // `select_account`. The previous default forced the scope-approval
      // screen on every single authorize — even for returning users whose
      // grant was still valid — because it asked Google to re-prompt
      // regardless of state. `select_account` asks Google for an account
      // picker instead; Google itself will still escalate to a full consent
      // screen when there's no active grant for this client+user (fresh
      // grant, revoked grant, or new scopes), which is the correct threat
      // model.
      //
      // Callers that genuinely need forced consent (e.g. an admin tool that
      // wants to re-read the grant choices) can still pass
      // `runtimeAuthParams: { prompt: 'consent' }`; the spread below
      // overrides this default without us re-hardcoding it at the adapter.
      //
      // Dead refresh_tokens (Google returns `invalid_grant`) are handled
      // separately by `refreshOAuthToken` in src/database.js, which nulls
      // the dead column so the status endpoint can surface REAUTH_REQUIRED.
      // See ADR-0017 and .context/tasks/backlog/F3-oauth-consent-prompt-once-per-grant.md.
      prompt: 'select_account',
      // F3 follow-up (2026-04-24, revised): incremental-authorization hint.
      // Enabled ONLY for connect-mode. RATIONALE:
      //
      // For connect-mode (asking for gmail/calendar/drive on top of
      // identity), `include_granted_scopes=true` is textbook incremental
      // auth: if the user already granted a subset (e.g. gmail.readonly),
      // Google won't re-prompt for it, and the returned token covers the
      // full union.
      //
      // For login/signup-mode (identity-only), this flag is actively
      // HARMFUL. When a user has a prior SUPERSET grant (e.g. they went
      // through connect-mode first and approved Drive+Calendar+Gmail),
      // `include_granted_scopes=true` tells Google "treat this request
      // as extending that grant." Under Google's Testing-mode consent
      // re-prompt policy, Google then re-renders the ENTIRE existing
      // grant on the consent screen — Drive + Calendar + Gmail + identity
      // — instead of the three identity rows we actually asked for.
      // The user sees a confusing "why does login want Drive access?"
      // screen even though our wire request is identity-only. Observed
      // 2026-04-24 on mailer.kv@gmail.com after a prior connect-mode
      // grant.
      //
      // Omitting it for identity-only keeps login as an isolated request:
      // Google evaluates just `openid email profile` independent of any
      // existing grant state, so the consent screen (if Testing-mode
      // forces one) shows only identity rows.
      include_granted_scopes: isIdentityOnly ? null : 'true',
      ...(runtimeAuthParams || {}),
    };
    // Filter out null/undefined values to allow runtime overrides to suppress defaults
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v != null)
    );
    return `${GOOGLE_AUTH_URL}?${querystring.stringify(cleanParams)}`;
  }

  /**
   * B2 (2026-04-24 F4 hardening): accept `runtimeTokenParams` and spread
   * them into the POST body. The callback handler at src/index.js calls
   * `adapter.exchangeCodeForToken(code, runtimeTokenParams)` for every
   * adapter; previously Google's signature dropped the second arg,
   * which meant a future addition of Google to the PKCE list (see
   * `['twitter','airtable','canva']`) would silently lose the
   * code_verifier. Defense-in-depth for a latent footgun.
   */
  async exchangeCodeForToken(code, runtimeTokenParams = {}) {
    return new Promise((resolve, reject) => {
      const postData = querystring.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri,
        ...(runtimeTokenParams || {}),
      });

      const options = {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': postData.length
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.error) {
              reject(new Error(`Google OAuth error: ${result.error_description || result.error}`));
            } else {
              resolve({
                accessToken: result.access_token,
                refreshToken: result.refresh_token || null,
                idToken: result.id_token || null,
                expiresIn: result.expires_in,
                tokenType: result.token_type,
                scope: result.scope || 'email profile gmail.readonly calendar.readonly'
              });
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async revokeToken(token) {
    return new Promise((resolve, reject) => {
      const postData = querystring.stringify({ token });

      const options = {
        hostname: 'oauth2.googleapis.com',
        path: '/revoke',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': postData.length
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({ ok: true });
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async verifyToken(token) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'www.googleapis.com',
        path: `/oauth2/v3/userinfo?access_token=${token}`,
        method: 'GET'
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve({
              valid: !result.error,
              error: result.error || null,
              data: result
            });
          } catch (e) {
            resolve({ valid: false, error: e.message });
          }
        });
      });

      req.on('error', (e) => resolve({ valid: false, error: e.message }));
      req.end();
    });
  }
}

module.exports = GoogleAdapter;
