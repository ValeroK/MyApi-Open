# Import: d302595 — fix(tokens): remove eye/reveal button, enforce show-once guarantee

- Upstream commit: `omribenami/MyApi-Open@d302595f` (Subagent on 2026-04-21)
- Files upstream touched: `src/public/dashboard-app/src/pages/AccessTokens.jsx`
  (+12 / -51)
- Status: proposed
- Decided by: _(awaiting user verdict — recommend accept)_
- Linked ADR: none
- Linked TASKS row: F12 / Group B.9 (verify-promoted)

## 1. What it actually does

Removes the eye/reveal button from the AccessTokens UI in the
dashboard. Per upstream commit body: the eye icon was silently
*rotating* the token (creating a new key) instead of revealing
the original — this broke the "you'll only see this once"
contract. After this fix, post-rotation the new key surfaces in
the existing one-time banner same as post-creation.

Specifically removed:
- `EyeIcon` component def + render sites.
- `revealedTokens` state + setter.
- The rotate-on-copy shortcut at line 790.

## 2. Do we want it?

**Yes.**

## 3. Why do we want it?

- Closes risk: §6.3 — silently rotating tokens when the user
  thinks they're just revealing them creates a "the token
  works for the agent right now but won't tomorrow" footgun
  with no operator-visible signal. Real F11-class incident
  pattern (silent secret rotation during setup).
- Closes capability gap: none directly.
- Aligned with milestone: F12 / Group B; UX + security quality.
- Strategic fit: matches the fork's "operator-recoverability"
  principle in F11.

## 4. Risks it poses

- **Security risk.** Net-positive (this IS the security fix).
- **Architectural risk.** Low — single SPA file.
- **Maintenance risk.** Low.
- **Test-baseline risk.** Need a frontend test (or static gate)
  asserting the eye button is gone.
- **UX risk.** Operators who have learned to "click the eye to
  see the token" will need to learn the new flow — they'll see
  the token in the post-creation/rotation banner only. CHANGELOG
  should call this out.
- **Migration risk.** None.

## 5. Conflict surface in our fork

- `src/public/dashboard-app/src/pages/AccessTokens.jsx` — verified
  during verify-pass that all targeted symbols still exist:
  - `EyeIcon` def at line 22
  - `revealedTokens` state at line 177
  - `EyeIcon` render at line 628 + 793
  - `rotate-on-copy` shortcut at line 790
- The fork's AccessTokens.jsx may have drifted from upstream's
  shape (fork has different ScopeRow structure, BundleToken
  helper) — patch should NOT remove those, only the eye button
  surface.

## 6. Test plan for the import

- New test file: `src/public/dashboard-app/src/pages/__tests__/AccessTokens-no-eye-button.test.jsx`
  - Render the page; assert no element with `EyeIcon` or
    `aria-label="Reveal"`.
  - Assert `revealedTokens` state is not in the component
    (via React DevTools or by exporting it for test).
- Source-pin tripwire: extend
  `src/tests/security-regression.test.js` with a textual gate
  on `AccessTokens.jsx` that fails if `EyeIcon` or
  `revealedTokens` reappear.
- Snapshot churn: low.
- Estimated baseline delta: 71/77/898 → 72/78/900 (+1 suite,
  +2 tests, +1 source-pin).

## 7. Rollback plan

Single-file revert. Eye button returns. No data loss.

## 8. Out of scope for this import

- Any change to the token-rotation API contract (the SPA fix
  is purely a UX surface change; the API still does what it
  always did).
- A "show me again" admin-side flow (separate UX task; would
  intentionally break show-once and is not desired).
- The post-creation banner copy itself (already exists in the
  fork).
