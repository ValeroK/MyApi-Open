/**
 * Pure, side-effect-free guard for post-authentication redirect targets.
 *
 * We accept ONLY absolute, single-origin (same-host) paths:
 *   OK:      "/",  "/dashboard/", "/dashboard/profile?tab=api"
 *   REJECT:  "", non-strings, null, undefined
 *   REJECT:  "https://evil.example/phish", "http://...", "ftp://..."
 *   REJECT:  "//evil.example/x"      (protocol-relative → cross-origin)
 *   REJECT:  "/\\evil.example/x"     (some parsers treat "\" as "/")
 *   REJECT:  "javascript:alert(1)"   (no leading "/")
 *   REJECT:  control characters      (URL splitting / header injection vectors)
 *
 * This file MUST stay byte-for-byte aligned on the accept/reject table with the
 * authoritative CJS copy at `src/lib/redirect-safety.js`. A Jest gate
 * (`src/tests/redirect-safety.test.js` + `src/tests/login-jsx-redirect-safety.test.js`)
 * protects the accept/reject contract and the caller wiring in `LogIn.jsx`.
 */
export function isSafeInternalRedirect(target) {
  if (typeof target !== 'string' || target.length === 0) return false;
  if (target[0] !== '/') return false;
  if (target[1] === '/' || target[1] === '\\') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(target)) return false;
  return true;
}
