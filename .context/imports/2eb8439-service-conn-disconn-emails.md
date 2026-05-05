# Import: 2eb8439 — feat(email): add service connected/disconnected emails; redesign security/device templates

- Upstream commit: `omribenami/MyApi-Open@2eb84396` (Subagent on 2026-04-22)
- Files upstream touched: `src/index.js` (+12 / -0),
  `src/services/emailService.js` (+729 LOC / -240, mostly
  template redesign)
- Status: proposed (NARROW — trigger-only hunks)
- Decided by: _(awaiting user verdict)_
- Linked ADR: none
- Linked TASKS row: F12 / Group D.5

## 1. What it actually does

Two independent additions:

1. **Service connect/disconnect emails (NEW capability).**
   - `sendServiceConnectedEmail` — fires after successful OAuth
     callback (token store).
   - `sendServiceDisconnectedEmail` — "sorry to see X go" template
     fires on disconnect.
   - `src/index.js` adds the trigger calls in the OAuth connect
     and disconnect handlers.
2. **Email template redesign (UX).**
   - `sendSecurityAlertEmail` rewritten to new dark design
     (replaces gradient header).
   - `sendNewDeviceApprovalEmail` rewritten — suspicious vs
     normal states now shown via chip color
     (amber/blue) instead of gradient background.

## 2. Do we want it?

**Conditional yes — NARROW import (trigger-only hunks).**

Recommendation: import the **trigger calls + the two NEW
template functions** (`sendServiceConnectedEmail`,
`sendServiceDisconnectedEmail`). **Skip** the redesign of
the existing `sendSecurityAlertEmail` and
`sendNewDeviceApprovalEmail` templates — those would force the
fork to adopt upstream's design system across all email
templates, which is a separate UX decision.

## 3. Why do we want it?

- Closes capability gap: operator currently has no email signal
  when a service is connected or disconnected (only in-app
  notifications). Helps detect unauthorized service connections
  same way `99f864d` helps detect new-device usage.
- Aligned with milestone: F12 / Group D; standalone capability.
- Strategic fit: completes the operator-recoverability email
  signal trio — new device (99f864d), service connected
  (2eb8439), service disconnected (2eb8439).

## 4. Risks it poses

- **Security risk.** None — emails are notify-only.
- **Architectural risk.** Low — additive.
- **Maintenance risk.** Low — two new template functions.
- **Test-baseline risk.** Need behavioural tests for both
  trigger calls.
- **UX risk.** Email volume — noisy if operator connects/
  disconnects many services in a session. Acceptable; can be
  rate-limited later.
- **Migration risk.** None.

## 5. Conflict surface in our fork

- `src/index.js` — OAuth connect handler — slot
  `sendServiceConnectedEmail(...)` after successful
  `storeOAuthToken(...)` call (M3 wrap-up location).
- `src/index.js` — OAuth disconnect handler — slot
  `sendServiceDisconnectedEmail(...)` after delete-token call.
- `src/services/emailService.js` — append two new template
  functions; do NOT touch existing
  `sendSecurityAlertEmail` /
  `sendNewDeviceApprovalEmail` (skipped per §2).

## 6. Test plan for the import

- New test file: `src/tests/service-connect-disconnect-emails.test.js`
  - OAuth connect for a new service → email fires once with
    correct service name.
  - OAuth disconnect → email fires once with correct service
    name.
  - Reconnect (already connected) → email may or may not fire;
    pin the upstream behaviour.
  - Email failure (mock thrown) → does NOT block the OAuth
    connect/disconnect flow (fire-and-forget).
- Source-pin tripwire: none.
- Snapshot churn: low.
- Estimated baseline delta: 71/77/898 → 72/78/904 (+1 suite,
  +6 tests).

## 7. Rollback plan

Surgical revert (only the trigger lines + the two new template
functions). Existing email templates unaffected.

## 8. Out of scope for this import

- Email-template redesign of existing templates (would force
  the fork to adopt upstream's design system).
- Email digest / batching (accept individual emails for now).
- HTML vs plain-text fallback (use upstream's HTML template
  shape).
- Localisation (out of scope for the fork today).
- Coupling with anomaly detection (different concern;
  e0707c5 / ADR-0026 territory).
