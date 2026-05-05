# Import: 99f864d — feat(security): email alert when new device attempts OAuth token use

- Upstream commit: `omribenami/MyApi-Open@99f864dd` (omribenamidev on 2026-04-22)
- Files upstream touched: `src/middleware/deviceApproval.js` (+27 / -1),
  `src/services/emailService.js` (+121 / -0)
- Status: proposed
- Decided by: _(awaiting user verdict)_
- Linked ADR: none
- Linked TASKS row: F12 / Group A.5

## 1. What it actually does

Adds `sendNewDeviceApprovalEmail()` to `EmailService` (amber/warn
branding by risk-tier) and fires it from
`deviceApprovalMiddleware` when a new device hits the gate. Uses
risk signals from `DeviceFingerprint.analyzeSuspiciousActivity()`
to colour the email severity (orange = suspicious, amber = normal
new device).

## 2. Do we want it?

**Yes.**

## 3. Why do we want it?

- Closes risk: §6.3 — "Operator has no out-of-band signal that
  someone tried to use their token from a new device". Today
  the device approval gate caught it but the operator only saw
  the in-app pending row; if they didn't open the dashboard they
  wouldn't know. Email closes the loop.
- Closes capability gap: matches the fork's existing email
  scaffolding (`src/services/emailService.js` is in the fork
  with M5-era templates).
- Aligned with milestone: F12 / Group A; standalone capability,
  no architectural impact.
- Strategic fit: agent-gateway-thesis — agents WILL run on new
  devices over time; the operator needs a signal.

## 4. Risks it poses

- **Security risk.** The risk signals are already computed in the
  fork; this just surfaces them. Email-template injection is a
  concern — verify upstream's template uses proper escaping.
- **Architectural risk.** Low. The fork's email service may have
  drifted from upstream's surface (different methods exposed),
  so `sendNewDeviceApprovalEmail` may need to be slotted into the
  fork's existing class shape rather than appended verbatim.
- **Maintenance risk.** Low; email templates are isolated.
- **Test-baseline risk.** Need a new behavioural test that the
  middleware fires the email (mock the email service, assert call
  count + template args).
- **UX risk.** Email volume — if a power-user has many agents on
  many devices, this could be noisy. Acceptable: each new device
  is exactly one email; subsequent reuse from the same device
  doesn't re-fire.
- **Migration risk.** None — additive.

## 5. Conflict surface in our fork

- `src/middleware/deviceApproval.js` — the fork's middleware was
  rewritten in F4 (identity-vs-service) and may have a different
  call signature. Need to slot the email-fire call after the
  `analyzeSuspiciousActivity()` invocation, not at upstream's
  exact line offset.
- `src/services/emailService.js` — the fork has its own evolved
  email service (with the M5 cleanup). The new method needs to
  follow the fork's templating conventions, not necessarily
  upstream's.
- The downstream dependency `DeviceFingerprint.analyzeSuspiciousActivity`
  needs to exist in the fork; if it was refactored or moved,
  cross-check before merging.

## 6. Test plan for the import

- New test file: `src/tests/device-approval-email-alert.test.js`
  - Mock `emailService.sendNewDeviceApprovalEmail`.
  - Hit a master-only endpoint with a token from an unrecognised
    device; assert email is sent once with the new device's
    fingerprint.
  - Hit it again from the SAME device after approval; assert
    email is NOT sent.
  - Force `analyzeSuspiciousActivity()` to return high-risk;
    assert the email payload's severity-tier is `suspicious`.
- Source-pin tripwire: extend
  `src/tests/security-regression.test.js` with the cardinal-property
  assertion ("first device-approval gate hit always triggers
  exactly one email").
- Snapshot churn: low.
- Estimated baseline delta: 71/77/898 → 72/78/902 (+1 suite,
  +4 tests).

## 7. Rollback plan

Two-file revert; in-app device-approval flow unchanged. No DB
migration to undo.

## 8. Out of scope for this import

- SMS / push-notification escalation paths (separate channel
  surface, separate ADR if needed).
- Email rate-limiting / digest-mode (start with one-per-event;
  add throttling only if real volume problems surface).
- The follow-on `f262e4e` "make new-device email informative
  with full context" hunk from upstream — that's a separate
  mini-plan if 99f864d accepts.
