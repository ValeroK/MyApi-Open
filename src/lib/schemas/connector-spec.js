'use strict';

/**
 * F6.6 / ADR-0020 — `GenericOAuthAdapter`-shaped connector spec.
 *
 * This is the **read-only spike** schema. It pins the data
 * model an agent-defined connector would persist. It does NOT
 * (yet) wire anything into `oauthAdapters` at runtime — that is
 * F7 / M5 territory and requires SSRF unification first.
 *
 * Shape rationale (`src/services/generic-oauth-adapter.js:14-22`):
 *   - `tokenUrl` is the only field whose absence makes the adapter
 *     fundamentally unable to function.
 *   - `authUrl` + `apiRoot` are required for first-time link.
 *   - `identityScopes` / `serviceScopes` follow the F4 / ADR-0018
 *     identity-vs-service split. Both can be empty for a
 *     write-only / read-only adapter; at least one must be present.
 *   - `redirectUri` is optional (default falls back to the gateway
 *     callback path at runtime).
 *
 * The schema lives in plain JS rather than JSON to avoid a
 * `require('./*.json')` round-trip and to keep error-message
 * generation in one place. No external deps.
 *
 * Returns:
 *   { ok: true, normalized: <ConnectorSpec> }   on success
 *   { ok: false, error: <human-string>,
 *     code: 'INVALID_CONNECTOR_SPEC',
 *     fields: [<field>, …] }                    on failure
 */

const URL_FIELDS = new Set(['authUrl', 'tokenUrl', 'apiRoot', 'redirectUri', 'refreshUrl', 'revokeUrl']);

function isHttpsLikeUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function isStringArray(value, opts = {}) {
  if (!Array.isArray(value)) return false;
  if (opts.allowEmpty === false && value.length === 0) return false;
  return value.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 200);
}

function fail(error, fields) {
  return {
    ok: false,
    error,
    code: 'INVALID_CONNECTOR_SPEC',
    fields: Array.isArray(fields) ? fields : [fields],
  };
}

function validateConnectorSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return fail('connector spec must be an object', '_root');
  }

  const required = ['authUrl', 'tokenUrl', 'apiRoot'];
  const missing = required.filter((k) => spec[k] === undefined || spec[k] === null || spec[k] === '');
  if (missing.length > 0) {
    return fail(
      `missing required field(s): ${missing.join(', ')}`,
      missing
    );
  }

  for (const f of URL_FIELDS) {
    if (spec[f] !== undefined && spec[f] !== null && !isHttpsLikeUrl(spec[f])) {
      return fail(`${f} must be a valid http(s) URL`, f);
    }
  }

  // Scope split (F4 / ADR-0018).
  const hasIdentity = spec.identityScopes !== undefined && spec.identityScopes !== null;
  const hasService = spec.serviceScopes !== undefined && spec.serviceScopes !== null;
  if (!hasIdentity && !hasService) {
    return fail(
      'at least one of identityScopes / serviceScopes must be a non-empty string array',
      ['identityScopes', 'serviceScopes']
    );
  }
  if (hasIdentity && !isStringArray(spec.identityScopes, { allowEmpty: false })) {
    return fail('identityScopes must be a non-empty array of strings', 'identityScopes');
  }
  if (hasService && !isStringArray(spec.serviceScopes, { allowEmpty: false })) {
    return fail('serviceScopes must be a non-empty array of strings', 'serviceScopes');
  }
  // Belt-and-braces: identity scopes MUST NOT also appear in service
  // scopes (F4 / ADR-0018 — the row split is by purpose, and a scope
  // string in both is a signal of a misconfigured spec).
  if (hasIdentity && hasService) {
    const idSet = new Set(spec.identityScopes);
    const overlap = spec.serviceScopes.filter((s) => idSet.has(s));
    if (overlap.length > 0) {
      return fail(
        `scope strings appear in both identityScopes and serviceScopes: ${overlap.join(', ')}`,
        ['identityScopes', 'serviceScopes']
      );
    }
  }

  // Optional `name` / `label` strings.
  for (const opt of ['name', 'label', 'description']) {
    if (spec[opt] !== undefined && spec[opt] !== null) {
      if (typeof spec[opt] !== 'string' || spec[opt].length === 0 || spec[opt].length > 256) {
        return fail(`${opt} must be a non-empty string ≤256 chars`, opt);
      }
    }
  }

  return {
    ok: true,
    normalized: {
      authUrl: spec.authUrl,
      tokenUrl: spec.tokenUrl,
      apiRoot: spec.apiRoot,
      ...(spec.refreshUrl ? { refreshUrl: spec.refreshUrl } : {}),
      ...(spec.revokeUrl ? { revokeUrl: spec.revokeUrl } : {}),
      ...(spec.redirectUri ? { redirectUri: spec.redirectUri } : {}),
      ...(hasIdentity ? { identityScopes: [...spec.identityScopes] } : {}),
      ...(hasService ? { serviceScopes: [...spec.serviceScopes] } : {}),
      ...(spec.name ? { name: spec.name } : {}),
      ...(spec.label ? { label: spec.label } : {}),
      ...(spec.description ? { description: spec.description } : {}),
    },
  };
}

const CONNECTOR_TYPE_GENERIC_OAUTH = 'generic_oauth';

function isGenericOAuthType(type) {
  return type === CONNECTOR_TYPE_GENERIC_OAUTH;
}

module.exports = {
  validateConnectorSpec,
  isGenericOAuthType,
  CONNECTOR_TYPE_GENERIC_OAUTH,
};
