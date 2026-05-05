# Import: f5297d5 — feat(beta): BETA mode toggle with user cap, waitlist, and launch flow

- Upstream commit: `omribenami/MyApi-Open@f5297d5a` (Subagent on 2026-04-18)
- Files upstream touched: substantial; landing page + admin page +
  middleware + multiple endpoints
- Status: deferred (architectural; requires ADR-0029; gates other
  hosted-product imports)
- Decided by: _(awaiting user verdict)_
- Linked ADR: ADR-0029 (`hosted-product-direction`; mandatory;
  gates all SaaS-direction imports)
- Linked TASKS row: F12 / Group D.4

## 1. What it actually does

`BETA=true|false` env flag gates the product between closed
beta and public launch:
- In beta: signups capped at `BETA_MAX_USERS` (default 50);
  only Free plan purchasable; Pro/Enterprise show "Soon".
- 51st+ signup is swapped for inline email-capture waitlist
  on landing page and dashboard signup.
- In public-launch mode: no cap; full Stripe checkout on all
  plans; beta chrome hidden.

New Admin > Beta page lists waitlist entries with one-click
"Announce launch" button (sends branded email via Resend).

Backend additions:
- `GET /api/v1/config/public` — runtime config for FE.
- `POST /api/v1/waitlist` — public email capture (idempotent).
- `GET /api/v1/waitlist` — admin list.
- `POST /api/v1/waitlist/:id/invite` — admin.
- `POST /api/v1/waitlist/notify-launch` — admin bulk launch
  email.
- `requireBetaSlot` middleware on `/auth/register` + OAuth
  callback.

## 2. Do we want it?

**Strongly recommend defer.** This is the single biggest
hosted-product-direction import in the matrix. The fork's
stated direction is "verifiable agent gateway" — a single-
tenant operator-owned deployment. BETA mode is a multi-tenant
SaaS feature. Importing it commits the fork to the hosted-
product axis.

ADR-0029 must decide whether the fork accepts that axis at
all.

## 3. Why we (might) want it (eventually)?

- Closes capability gap: only relevant if the fork moves
  toward hosted-product.
- Aligned with milestone: F12 / Group D — but only if
  ADR-0029 says yes.
- Strategic fit: directly orthogonal to the fork's current
  agent-gateway thesis. Acceptance would be a strategy
  pivot.

## 4. Risks it poses

- **Architectural risk (CRITICAL).** Forces multi-tenant
  semantics into a single-tenant codebase. Cascades into
  every other capability import (broadcast, tickets,
  notifications) needing per-tenant scoping.
- **Security risk.** Public `POST /api/v1/waitlist`
  endpoint adds a new public surface; needs rate-limit +
  validation. CSRF concerns on the email-capture form.
- **Maintenance risk.** High — Resend dependency,
  Stripe pricing-tier coupling, beta-vs-launch dual
  code paths everywhere.
- **Test-baseline risk.** Substantial; need behavioural
  tests for both `BETA=true` and `BETA=false` modes.
- **UX risk.** Operators who don't want to run a SaaS
  product would see useless UI surfaces.
- **Migration risk.** Adds a `waitlist` table and a
  `BETA` env var; both additive.

## 5. Conflict surface in our fork

- `src/index.js` — substantial: 5 new endpoints + middleware.
- `src/public/landing/index.html` — significant rewrites.
- `src/public/dashboard-app/src/pages/BetaAdmin.jsx` — new
  page; shared with 6ab11cb (broadcast).
- `src/middleware/...` — new `requireBetaSlot` middleware.
- DEPENDENCY: Resend email integration (verify presence in
  fork; if absent, add it as a separate import first).

## 6. Test plan for the import (when ADR-0029 lands)

- ADR-0029 is the gating artefact; written first.
- New test file: `src/tests/beta-mode-cap.test.js`
  - With `BETA=true` + `BETA_MAX_USERS=2` + 2 users
    registered: 3rd signup → 200 with `waitlist_added: true`
    instead of registration.
  - With `BETA=false`: 3rd signup → normal registration.
- New test file: `src/tests/waitlist-endpoints.test.js` —
  CRUD coverage.
- New test file: `src/tests/config-public-endpoint.test.js`
  — runtime config exposes BETA flag correctly.
- Source-pin tripwire: optional.
- Snapshot churn: substantial.
- Estimated baseline delta: 71/77/898 → 74/80/925 (+3 suites,
  +27 tests).

## 7. Rollback plan

Multi-file revert. `waitlist` table remains additive.

## 8. Out of scope for this import

- Stripe pricing-tier surfaces (Pro/Enterprise) — separate
  hosted-product imports.
- Branded email templates beyond the launch email — separate
  if needed.
- Multi-tenant workspace scoping for beta — handled in M10/M11
  if/when hosted-product axis activates.

## ADR-0029 outline (must land FIRST if accepted; mandatory)

- Decision: does the fork accept the hosted-product /
  multi-tenant SaaS axis?
- Options:
  - A: Accept; the fork becomes a viable SaaS deployment
       (closest to upstream).
  - B: Reject; the fork stays single-tenant operator-owned;
       no further hosted-product imports.
  - C: Defer for 6 months; revisit after F8/F9/F10/F11
       capability work lands.
- Recommendation: probably B unless the user is actively
  considering running this as a service. ADR-0029
  acceptance also unblocks 6ab11cb / 9bfed29 / b918ec0
  / b8daa15 / 9f6083e and the other Group "saas-direction"
  audit candidates.
- The decision in ADR-0029 retroactively affects:
  - 6ab11cb (admin broadcast)
  - All audit `saas-direction` bucket commits
  - Scope of M10/M11 multi-tenant work
  - Whether BetaAdmin.jsx is built at all.

## Recommendation

**Defer until user explicitly decides hosted-product axis.**
Do NOT import in isolation — the cascading dependencies
make a piecemeal acceptance worse than a clean defer.
