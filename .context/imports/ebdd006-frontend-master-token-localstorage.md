# Import: ebdd006 — fix(security): remediate audit findings across auth, encryption, and frontend

- Upstream commit: `omribenami/MyApi-Open@ebdd0060` (Subagent on 2026-04-22)
- Files upstream touched (8): `package.json`, `package-lock.json`,
  `src/index.js`, `src/lib/encryption.js`, `src/middleware/auth.js`,
  `src/public/dashboard-app/src/pages/Login.jsx`,
  `src/public/dashboard-app/src/stores/authStore.js`,
  `src/public/landing/index.html` (+90 / -61)
- Status: proposed (NARROW import — single hunk)
- Decided by: _(awaiting user verdict)_
- Linked ADR: none
- Linked TASKS row: F12 / Group A.4

## 1. What it actually does

Six independent fixes bundled into one upstream commit:

1. Open-redirect `safeRedirect()` origin-check on Login.jsx.
2. Auth middleware fail-closed on suspension DB error +
   `req.tokenMeta` alias.
3. `encryption.rotateKey()` suppresses error details.
4. **`authStore.js` moves `masterToken` from `localStorage` to
   `sessionStorage` (tab-scoped, cleared on tab close).**
5. CORS restrict Cloudflare-tunnel origins to non-prod.
6. `npm audit fix` — 0 vulns, `uuid` bumped to v14.

## 2. Do we want it?

**Yes (NARROW — only hunk #4, the `authStore.js` migration).**

The fork already has functionally-equivalent versions of hunks
#1, #3, and parts of #2 from the M2 / F5 / F6 sweeps. Hunk #5
is a CORS surface change that needs separate review against the
fork's CORS config (which has evolved post-M3). Hunk #6 is a
mechanical `npm audit fix` we can run independently. Only hunk
#4 (`localStorage → sessionStorage` for `masterToken`) is a
**verified gap**: confirmed during the 2026-05-04 fork-vs-upstream
comparison session that the fork's `authStore.js` still calls
`localStorage.getItem('masterToken')`.

## 3. Why do we want it?

- Closes risk: §6.3 — "Master token persisted in `localStorage`
  survives browser-store theft (XSS, malicious extension,
  shared-machine session re-use)". Moving to `sessionStorage`
  scopes the token to the tab and clears it on tab close.
- Closes capability gap: none directly, but reduces blast radius
  of any future XSS find.
- Aligned with milestone: F12 / Group A; security-quality.
- Strategic fit: matches the fork's M2/M3/F4/F5 hardening
  trajectory.

## 4. Risks it poses

- **Security risk.** Net-positive; the change is the security fix.
- **Architectural risk.** Low — single store file.
- **Maintenance risk.** Low.
- **Test-baseline risk.** SPA tests may assert localStorage
  presence; need to confirm and update.
- **UX risk.** Users will be logged out when they close the tab
  (expected new behaviour); document in CHANGELOG.
- **Migration risk.** Existing logged-in operators with a
  `localStorage.masterToken` will see it ignored after the import
  and have to re-authenticate once. Acceptable.

## 5. Conflict surface in our fork

- `src/public/dashboard-app/src/stores/authStore.js` — needs
  audit; confirm no fork-only hooks read `localStorage` for
  `masterToken` outside the store. (`AccessTokens.jsx` checked
  during verify-pass — uses `useAuthStore().masterToken`, not
  raw localStorage.)
- `src/public/dashboard-app/src/__tests__/` — any test that
  primes `localStorage.masterToken` in setup must switch to
  `sessionStorage`.

## 6. Test plan for the import

- New test file: `src/public/dashboard-app/src/stores/__tests__/authStore-master-token-storage.test.js`
  - Asserts `useAuthStore().setMasterToken(t)` writes to
    `sessionStorage`, NOT `localStorage`.
  - Asserts re-hydration on `useAuthStore.getState()` reads from
    `sessionStorage`.
  - Asserts `localStorage.getItem('masterToken')` is never called
    in the new store.
- Source-pin tripwire: extend
  `src/tests/security-regression.test.js` with a textual gate on
  `authStore.js` to fail if `localStorage.*masterToken` reappears.
- Snapshot churn: none.
- Estimated baseline delta: 71/77/898 → 72/78/901 (+1 suite,
  +3 tests, +1 source-pin).

## 7. Rollback plan

Single-file revert; users see masterToken survive tab close
again. No data loss either direction.

## 8. Out of scope for this import

- Hunks #1, #2, #3, #5, #6 — file separate mini-plans if and
  when verify shows they're missing in the fork. Today's evidence
  is they're already covered by M2/F5/F6 (or are CORS-policy
  changes that need their own review).
- A blanket `localStorage` audit of the SPA — separate F-task if
  the broader pattern is a concern.
- Cookie-based session migration (different design entirely;
  belongs in M9 frontend hygiene).
