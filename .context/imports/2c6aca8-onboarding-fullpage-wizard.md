# Import: 2c6aca8 — feat(onboarding): replace modal with full-page wizard + OAuth signup flow

- Upstream commit: `omribenami/MyApi-Open@2c6aca89` (Subagent on 2026-04-21)
- Files upstream touched: 10 files, net +1560 / -432
  (notable: `Onboarding.jsx` +1336 / -X, App.jsx +46 / -X,
  Login.jsx +51 / -X, landing/index.html +65 / -X, NEW
  `trigger-security-alert.js` script, REMOVED `.env.dev.example`,
  `.env.prod.example`)
- Status: proposed
- Decided by: _(awaiting user verdict)_
- Linked ADR: none
- Linked TASKS row: F12 / Group D.1

## 1. What it actually does

Major UX rewrite:
- New standalone Onboarding page replaces the inline modal.
- App.jsx redirects new users to `/onboarding` route instead
  of opening a modal.
- Login.jsx auto-completes OAuth signup and routes to the
  onboarding wizard.
- New `POST /api/v1/onboarding/complete` endpoint to clear
  the onboarding flag.
- DB migration: backfill audit_log columns (`token_id`,
  `token_type`, `user_agent`) for older DBs.
- Landing page: service count 10→30+, sign-in button restyle,
  CTA wiring.
- Removes `.env.dev.example` and `.env.prod.example`
  (consolidated into one `.env.example`).
- Adds dev script `trigger-security-alert.js`.

## 2. Do we want it?

**Yes, with strong caveats.** Recommend a careful slot-by-slot
review, NOT a verbatim cherry-pick.

The fork's existing onboarding story is currently a half-wired
modal (per F2 brief filed during M3 wrap-up:
`F2-onboarding-wizard-completion.md`). 2c6aca8 effectively IS
the work F2 was created to track — importing it would close F2.

## 3. Why do we want it?

- Closes capability gap: F2 (onboarding wizard completion) —
  the fork's modal stubs are localStorage no-ops; 2c6aca8
  replaces them with a real wizard.
- Aligned with milestone: F12 / Group D; bundles into M9
  frontend hygiene.
- Strategic fit: agent-gateway-thesis — first-time setup
  experience determines whether agents get correctly-scoped
  tokens or end up with the master token.

## 4. Risks it poses

- **Security risk.** Login.jsx auto-completes OAuth signup —
  must verify against the M3 first-seen confirm-gesture flow.
  Auto-completion that bypasses the confirm gesture is a
  regression risk against ADR-0016.
- **Architectural risk (HIGH).** 1336 LOC of new SPA code in
  one Onboarding.jsx file. M9 frontend hygiene is supposed
  to *split* monoliths, not add them. May want to land in
  smaller pieces.
- **Maintenance risk.** Medium-high — onboarding flows are
  always under churn.
- **Test-baseline risk.** SPA tests for the existing modal
  must be updated.
- **UX risk.** Existing operators who already onboarded will
  see no change (the flag-check still works); brand-new
  operators get the new flow.
- **Migration risk.** The DB backfill of audit_log columns
  is additive and idempotent. Verify it doesn't conflict with
  the fork's existing audit_log schema (M10 territory).
- **Scope risk.** This commit also bundles landing-page
  redesign (`30+ services`, sign-in restyle) which has
  hosted-product-direction overtones. Need to surgically
  exclude the landing-page hunks if we want only the
  wizard.

## 5. Conflict surface in our fork

- `src/public/dashboard-app/src/pages/Onboarding.jsx` —
  fork has a stub file from M3 wrap-up; clean replace.
- `src/public/dashboard-app/src/App.jsx` — fork has its
  own routing; need to slot the `/onboarding` route in.
- `src/public/dashboard-app/src/pages/Login.jsx` — fork's
  Login.jsx was hardened in M2 (open-redirect helper) and
  F5 (password auth); CAREFUL slot, must preserve
  hardenings.
- `src/index.js` — `/api/v1/onboarding/complete` slot in.
- `src/public/landing/index.html` — likely SKIP these
  hunks (landing-page restyle; hosted-product framing).
- `src/scripts/trigger-security-alert.js` — useful dev
  script but has no caller in the fork without e0707c5;
  decide whether to skip.
- `.env.dev.example` / `.env.prod.example` — fork doesn't
  have these (uses `.env.smoke.example`); skip the DELETE
  hunks.

## 6. Test plan for the import

- New test file: `src/tests/onboarding-complete-endpoint.test.js`
  - Master token: POST clears onboarding flag.
  - Non-master: 403.
- New test file: `src/public/dashboard-app/src/pages/__tests__/Onboarding-wizard.test.jsx`
  - Wizard renders correct steps.
  - Step navigation works.
  - Final step calls `/api/v1/onboarding/complete`.
- Update existing F2 brief: close it as "implemented via
  2c6aca8 import".
- Source-pin tripwire: extend `oauth-state-inventory.test.js`
  (or a new SPA-side gate) asserting the OAuth signup auto-
  completion still goes through the confirm gesture
  (CRITICAL — guard against ADR-0016 regression).
- Snapshot churn: high (frontend snapshots).
- Estimated baseline delta: 71/77/898 → 73/79/910 (+2 suites,
  +12 tests).

## 7. Rollback plan

Multi-file revert. F2 stays open; existing operators
unaffected.

## 8. Out of scope for this import

- Landing-page restyle (`30+ services`, sign-in button,
  CTA wiring) — explicitly skip; that's hosted-product
  framing.
- `.env.dev.example` / `.env.prod.example` deletion —
  skip; fork doesn't have these files.
- `trigger-security-alert.js` script — skip until e0707c5
  / ADR-0026 lands; without anomaly detection, the script
  has no effect.
- `a511108` follow-on (lint fix) — separate trivial import,
  not blocking.
- `9db023b` follow-on (UI redesign + mobile sidebar) —
  separate import; only consider if user wants the new
  design system.
