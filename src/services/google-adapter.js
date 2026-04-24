const https = require('https');
const querystring = require('querystring');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

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

  getAuthorizationUrl(state, runtimeAuthParams = {}) {
    if (!this.isConfigured()) {
      throw new Error('Google OAuth is not configured (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)');
    }

    // Allow override via GOOGLE_SCOPE env var
    const defaultScope = process.env.GOOGLE_SCOPE || 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.file';

    const params = {
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: defaultScope,
      state: state,
      access_type: 'offline',
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
      ...(runtimeAuthParams || {}),
    };
    // Filter out null/undefined values to allow runtime overrides to suppress defaults
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v != null)
    );
    return `${GOOGLE_AUTH_URL}?${querystring.stringify(cleanParams)}`;
  }

  async exchangeCodeForToken(code) {
    return new Promise((resolve, reject) => {
      const postData = querystring.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri
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
