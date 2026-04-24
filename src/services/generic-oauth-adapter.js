const https = require('https');
const querystring = require('querystring');

class GenericOAuthAdapter {
  constructor(config = {}) {
    this.serviceName = config.serviceName || 'oauth';
    this.clientId = config.clientId || '';
    this.clientSecret = config.clientSecret || '';
    this.redirectUri = config.redirectUri || '';
    this.authUrl = config.authUrl || '';
    this.tokenUrl = config.tokenUrl || '';
    this.revokeUrl = config.revokeUrl || '';
    this.verifyUrl = config.verifyUrl || '';
    // F4 (ADR-0018): scope can be split into identity vs service. If a
    // caller passes `identityScope` + `serviceScope`, the adapter honours
    // the F4 login/connect split per `{ mode }` in getAuthorizationUrl.
    // If only the legacy single `scope` is passed, it's used for every
    // mode — keeping service-only providers (Slack, Discord, Twitter,
    // Airtable, Canva, etc.) working without change.
    this.identityScope = config.identityScope || '';
    this.serviceScope = config.serviceScope || '';
    this.scope = config.scope || '';
    this.tokenAuthStyle = config.tokenAuthStyle || 'body'; // body | basic
    this.clientIdParam = config.clientIdParam || 'client_id';
    this.revokeMethod = config.revokeMethod || 'POST';
    this.revokeTokenParam = config.revokeTokenParam || 'token';
    this.extraAuthParams = config.extraAuthParams || {};
    this.extraTokenParams = config.extraTokenParams || {};

    // Warn if verifyUrl is missing (token validation won't work properly)
    if (this.clientId && this.clientSecret && this.redirectUri && this.authUrl && this.tokenUrl && !this.verifyUrl) {
      console.warn(`[OAuth] ${this.serviceName} adapter is configured but missing verifyUrl. Token validation will be skipped.`);
    }
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri && this.authUrl && this.tokenUrl);
  }

  /**
   * F4: `options.mode` picks between identityScope (login/signup) and
   * identityScope+serviceScope (connect). Adapters without split scope
   * config fall back to `this.scope` for all modes.
   */
  getAuthorizationUrl(state, runtimeAuthParams = {}, options = {}) {
    if (!this.isConfigured()) {
      throw new Error(`${this.serviceName} OAuth is not configured`);
    }
    const params = {
      [this.clientIdParam]: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state,
      ...this.extraAuthParams,
      ...(runtimeAuthParams || {}),
    };

    const resolvedScope = this._resolveScope(options && options.mode);
    if (resolvedScope) params.scope = resolvedScope;

    return `${this.authUrl}?${querystring.stringify(params)}`;
  }

  _resolveScope(mode) {
    const hasSplit = !!(this.identityScope || this.serviceScope);
    if (!hasSplit) {
      // Legacy single-scope config — service-only adapters (Slack,
      // Discord, etc.) use this path and don't care about mode.
      return this.scope || '';
    }
    const isIdentityOnly = mode === 'login' || mode === 'signup';
    if (isIdentityOnly) {
      return this.identityScope || '';
    }
    // Connect-mode:
    //   1. If serviceScope is configured, combine identityScope +
    //      serviceScope (the F4-native path).
    //   2. B1 (2026-04-24 F4 hardening): if serviceScope is EMPTY but
    //      a legacy combined `scope` is set, combine identityScope +
    //      legacy scope. Operators upgrading in-place who only set
    //      FACEBOOK_SCOPE (the pre-F4 env var) would otherwise lose
    //      their custom scopes silently — the F4 comment in
    //      src/index.js promised backwards-compat and this branch
    //      delivers it.
    //   3. Otherwise (nothing configured) fall back to identityScope
    //      alone or legacy scope if the operator set only that.
    const parts = [];
    if (this.identityScope) parts.push(this.identityScope);
    if (this.serviceScope) {
      parts.push(this.serviceScope);
    } else if (this.scope) {
      parts.push(this.scope);
    }
    return parts.length ? parts.join(' ') : (this.scope || '');
  }

  async exchangeCodeForToken(code, runtimeTokenParams = {}) {
    if (!this.isConfigured()) {
      throw new Error(`${this.serviceName} OAuth is not configured`);
    }
    const tokenEndpoint = new URL(this.tokenUrl);
    const postData = querystring.stringify({
      [this.clientIdParam]: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
      ...this.extraTokenParams,
      ...(runtimeTokenParams || {}),
    });

    return this._request({
      hostname: tokenEndpoint.hostname,
      path: `${tokenEndpoint.pathname}${tokenEndpoint.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        Accept: 'application/json',
        ...(this.tokenAuthStyle === 'basic' ? { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}` } : {}),
      },
    }, postData).then((result) => {
      if (result.error) {
        throw new Error(result.error_description || result.error.message || result.error);
      }

      return {
        accessToken: result.access_token,
        refreshToken: result.refresh_token || null,
        expiresIn: result.expires_in || null,
        tokenType: result.token_type || 'bearer',
        scope: result.scope || this.scope || null,
      };
    });
  }

  async revokeToken(token) {
    if (!this.revokeUrl) return { ok: true };
    const revokeEndpoint = new URL(this.revokeUrl);
    const payload = querystring.stringify({ [this.revokeTokenParam]: token });
    await this._request({
      hostname: revokeEndpoint.hostname,
      path: `${revokeEndpoint.pathname}${revokeEndpoint.search}`,
      method: this.revokeMethod,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/json',
      },
    }, payload);
    return { ok: true };
  }

  async verifyToken(token) {
    if (!this.verifyUrl) {
      console.warn(`[${this.serviceName}] Token verification skipped: verifyUrl not configured. This service will not validate tokens after exchange.`);
      return { valid: true, data: { skipped: true, warning: 'verifyUrl not configured' } };
    }
    const endpoint = new URL(this.verifyUrl);
    const path = `${endpoint.pathname}${endpoint.search}${endpoint.search ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    const result = await this._request({
      hostname: endpoint.hostname,
      path,
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return { valid: !result.error, error: result.error || null, data: result };
  }

  _request(options, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

module.exports = GenericOAuthAdapter;
