# Import: 9cd414a — fix(dashboard): show red security alert card when suspicious activity detected

- Upstream commit: `omribenami/MyApi-Open@9cd414ab` (omribenamidev on 2026-04-22)
- Files upstream touched: `src/public/dashboard-app/src/pages/Dashboard.jsx`
  (+17 / -2), `src/routes/dashboard.js` (+21 / -0)
- Status: deferred (dependency-blocked)
- Decided by: _(awaiting user verdict on parent dependency)_
- Linked ADR: ADR-0026 (token-anomaly-reintroduction; not yet ratified)
- Linked TASKS row: F12 / Group B.10 (verify-promoted)

## 1. What it actually does

Adds a red security-alert card to the dashboard that surfaces
unread `security_alert`-type notifications. Specifically:

- `/dashboard/metrics` endpoint now returns `securityAlerts`
  count + `securityAlertDetails` array (queried from unread
  notifications of type `security_alert`).
- Adds `'danger'` tone to `accentMap` (maps to `--red` CSS var).
- Card renders before the device approval card with a red border,
  full-width red top bar, and the alert title/message from the DB.

## 2. Do we want it?

**Conditional yes — but defer.** Cannot import without first
importing or building the upstream notification type
`security_alert`. That type is created by `e0707c5` (token
anomaly detection), which is in Group C as a deferred
architectural import requiring ADR-0026 first.

## 3. Why do we want it (eventually)?

- Closes risk: §6.3 — operator has no high-visibility surface
  for "an attacker is currently trying to use my tokens".
- Closes capability gap: none directly, but completes the
  operator-recoverability story started by F11 + the
  `99f864d` new-device email alert.
- Aligned with milestone: F12 / Group B (and downstream of
  Group C if ADR-0026 / e0707c5 accepts).
- Strategic fit: agent-gateway-thesis — the operator MUST have
  high-confidence signals when something goes wrong.

## 4. Risks it poses

- **Security risk.** Surface alone is benign; the *content*
  comes from the anomaly detector. Without that detector, the
  card always shows zero — useless but not harmful.
- **Architectural risk.** Medium — depends on a backend
  notification type that doesn't exist in the fork yet.
- **Maintenance risk.** Low.
- **Test-baseline risk.** Need to coordinate with the parent
  e0707c5 import.
- **UX risk.** Red-card alarm fatigue if anomaly classification
  is too aggressive — that's the e0707c5 / ADR-0026 concern,
  not this card's.

## 5. Conflict surface in our fork

- `src/public/dashboard-app/src/pages/Dashboard.jsx` — fork has
  no security-alert card today; clean add.
- `src/routes/dashboard.js` — exists in the fork; need to slot
  the metrics-endpoint additions cleanly.
- **HARD DEPENDENCY:** notifications table must support
  `type = 'security_alert'`. Today the fork's notifications
  surface allows arbitrary `type` strings, but no caller
  inserts `security_alert` rows; the card would always show
  zero.

## 6. Test plan for the import (when the dependency lands)

- New test file: `src/tests/dashboard-security-alert-card.test.js`
  - With zero unread `security_alert` notifications →
    `/dashboard/metrics` returns `securityAlerts: 0`,
    `securityAlertDetails: []`.
  - With 3 unread → `securityAlerts: 3`, details array length 3.
- New test file: `src/public/dashboard-app/src/pages/__tests__/Dashboard-security-card.test.jsx`
  - With `securityAlerts > 0` → red card renders before device
    approval card.
  - With `securityAlerts === 0` → card does NOT render.
- Source-pin tripwire: none.
- Snapshot churn: low.
- Estimated baseline delta: 71/77/898 → 73/79/903 (+2 suites,
  +5 tests).

## 7. Rollback plan

Two-file revert. No data loss.

## 8. Out of scope for this import

- Importing e0707c5 / drafting ADR-0026 — that's the parent
  dependency.
- The follow-on `bfd21ee` "escalate OAuth cross-device use +
  fix analyzeSuspiciousActivity" hunk — separate concern.
- The follow-on `f262e4e` "make new-device email informative"
  hunk — separate import (see 99f864d follow-up).

## Recommendation

**Defer until parent e0707c5 / ADR-0026 decision lands.** Do
not import in isolation — the card would be a permanently-blank
surface and signal a non-existent capability.
