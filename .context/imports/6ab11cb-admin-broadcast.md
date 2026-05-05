# Import: 6ab11cb — feat(admin): broadcast notification to all users via bell + attention card

- Upstream commit: `omribenami/MyApi-Open@6ab11cb3` (Subagent on 2026-04-22)
- Files upstream touched: `src/index.js` (+39 / -0),
  `NotificationDropdown.jsx` (+1 / -0),
  `BetaAdmin.jsx` (+154 / -0),
  `Dashboard.jsx` (+34 / -1)
- Status: deferred (architectural; requires ADR-0027)
- Decided by: _(awaiting user verdict)_
- Linked ADR: ADR-0027 (`admin-broadcast-permission-scope`; not yet ratified)
- Linked TASKS row: F12 / Group D.2

## 1. What it actually does

Adds a master-only `POST /api/v1/admin/broadcast-notification`
endpoint that creates `admin_bell_broadcast` and/or
`admin_attention_broadcast` notifications for every active user.
Dashboard.jsx polls the attention-broadcast type every 30s and
renders them as ANNOUNCEMENT cards before priority cards;
NotificationDropdown.jsx adds a megaphone icon for the bell
type. New `BetaAdmin.jsx` page surfaces the broadcast UI with
title/message inputs, target toggle (`bell`/`attention`/`both`),
char counts, live side-by-side preview, and a confirmation
dialog.

## 2. Do we want it?

**Conditional yes — requires ADR-0027 first.**

The capability is useful (operator can announce maintenance
windows, security incidents, plan changes) but it conflicts
with the fork's "single-tenant operator-owned deployment"
mental model — there's exactly one user (the operator)
broadcasting to themselves makes no sense.

ADR-0027 needs to decide:
- Does the fork accept multi-tenancy semantics for broadcast?
- Or does broadcast become a no-op / hidden in single-tenant
  deployments?

## 3. Why we (might) want it (eventually)?

- Closes capability gap: none today.
- Aligned with milestone: F12 / Group D; tied to whether the
  fork ever moves beyond single-tenant.
- Strategic fit: depends on hosted-product axis (also
  driving f5297d5 / ADR-0029).

## 4. Risks it poses

- **Security risk.** Master-only gate is correct. The
  notification body is rendered as plain text in the SPA;
  XSS surface needs verification.
- **Architectural risk (HIGH).** Introduces "broadcast to
  all users" semantics. In a single-tenant fork, this is
  noise. In a multi-tenant deployment, this needs a
  workspace-scoping check.
- **Maintenance risk.** Medium.
- **Test-baseline risk.** Need standard CRUD test +
  multi-user fan-out verification.
- **UX risk.** None for the operator; for end-users, ANNOUNCEMENT
  card placement (before priority cards) might bury
  device-approval prompts. Verify card-stack ordering.
- **Migration risk.** None.

## 5. Conflict surface in our fork

- `src/index.js` — clean ADD.
- `src/public/dashboard-app/src/pages/BetaAdmin.jsx` — NEW
  in upstream; the fork doesn't have this page. Cleanly
  drop in (but rename if `BetaAdmin` framing is rejected).
- `src/public/dashboard-app/src/pages/Dashboard.jsx` —
  surface drift; need careful slot.
- `NotificationDropdown.jsx` — single icon addition.
- DEPENDENCY: `BetaAdmin.jsx` is shared between this commit
  and `f5297d5` (BETA mode). Importing 6ab11cb ALONE means
  BetaAdmin.jsx exists with only the broadcast section;
  importing both means it has both sections. Decide
  ordering.

## 6. Test plan for the import (when ADR-0027 lands)

- ADR-0027 written first.
- New test file: `src/tests/admin-broadcast-endpoint.test.js`
  - Master token + valid body → notification created for each
    active user.
  - Non-master → 403.
  - target=bell → only bell notifications created.
  - target=attention → only attention notifications.
  - target=both → both.
  - Body validation (missing title, oversized message).
- New test file: `src/public/dashboard-app/src/pages/__tests__/Dashboard-broadcast-card.test.jsx`
  - Active broadcast renders as accent-tone card.
  - Dismiss marks notification read.
- Source-pin tripwire: optional cardinal property "broadcast
  endpoint can ONLY be called by master tokens".
- Snapshot churn: low.
- Estimated baseline delta: 71/77/898 → 73/79/906 (+2 suites,
  +8 tests).

## 7. Rollback plan

Multi-file revert. Existing notifications unaffected.

## 8. Out of scope for this import

- Multi-workspace fan-out (e.g. broadcast to all members of
  one workspace only) — separate enhancement.
- Email-channel broadcast — separate ADR.
- Scheduling / recurring broadcasts — out of scope.
- Importing the follow-on `ba84dd8` "Broadcast page nav entry"
  — bundle if and only if the user accepts both.

## ADR-0027 outline (must land FIRST if accepted)

- Decision: do we accept admin broadcast in a single-tenant
  deployment context?
- Options:
  - A: Accept; broadcast is operator-to-self in single tenant
       and operator-to-all in multi-tenant.
  - B: Reject for single tenant; revisit when multi-tenant
       SaaS direction is decided (ties to ADR-0029).
  - C: Accept but rename `BetaAdmin.jsx` → `AdminBroadcast.jsx`
       to drop the BETA framing.
- Recommendation: probably C if user wants the capability;
  B if multi-tenant isn't on the roadmap.
