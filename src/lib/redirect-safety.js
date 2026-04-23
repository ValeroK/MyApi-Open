'use strict';

/**
 * Pure, side-effect-free guard for post-authentication redirect targets.
 *
 * We accept ONLY absolute, single-origin (same-host) paths:
 *   OK:      "/",  "/dashboard/", "/dashboard/profile?tab=api"
 *   REJECT:  "",  "/dashboard/" as a non-string, null, undefined
 *   REJECT:  "https://evil.example/phish", "http://...", "ftp://..."
 *   REJECT:  "//evil.example/x"      (protocol-relative → cross-origin)
 *   REJECT:  "/\\evil.example/x"     (some parsers treat "\" as "/")
 *   REJECT:  "javascript:alert(1)"   (no leading "/")
 *   REJECT:  "data:text/html,..."    (no leading "/")
 *   REJECT:  control characters      (URL splitting / header injection vectors)
 *
 * This helper is the single source of truth; the ESM mirror at
 * `src/public/dashboard-app/src/utils/redirectSafety.js` MUST stay byte-for-byte
 * aligned on the accept/reject table (see the textual gate in
 * `src/tests/login-jsx-redirect-safety.test.js`).
 *
 * @param {unknown} target
 * @returns {boolean} true iff `target` is safe to assign to `window.location.href`
 */
function isSafeInternalRedirect(target) {
  if (typeof target !== 'string' || target.length === 0) return false;
  if (target[0] !== '/') return false;
  if (target[1] === '/' || target[1] === '\\') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(target)) return false;
  return true;
}

module.exports = { isSafeInternalRedirect };
