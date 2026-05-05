# Import: 52dd343 — feat(gmail): add send and trash endpoints, upgrade to gmail.modify scope

- Upstream commit: `omribenami/MyApi-Open@52dd3434` (Subagent on 2026-04-20)
- Files upstream touched: `src/index.js` (+47 / -3),
  `src/routes/services.js` (+111 / -0),
  `src/services/google-adapter.js` (+2 / -1)
- Status: deferred (architectural; requires ADR-0025)
- Decided by: _(awaiting user verdict; if accepted, ADR-0025 must land in same commit)_
- Linked ADR: ADR-0025 (`gmail-write-surface`; not yet ratified)
- Linked TASKS row: F12 / Group C.1

## 1. What it actually does

Adds two write endpoints to the Gmail proxy:
- `POST /api/v1/services/google/gmail/send`
- `DELETE /api/v1/services/google/gmail/messages/:id` (trash, not
  permanent delete)

Upgrades the OAuth scope from `gmail.readonly` to `gmail.modify`
to support write operations.

## 2. Do we want it?

**Conditional yes — requires ADR-0025 first.**

The feature is desired (agents need to actually send emails to
fulfil the agent-gateway thesis), but **upgrading from
`gmail.readonly` to `gmail.modify`** is a privilege escalation
on every existing operator's connected Google account. That
must be ADR-recorded, not just shipped.

## 3. Why do we want it?

- Closes capability gap: agents can READ Gmail today but cannot
  ACT — limits the value proposition.
- Aligned with milestone: F12 / Group C; agent capability surface.
- Strategic fit: agent-gateway-thesis — a read-only Gmail
  gateway is half a product.

## 4. Risks it poses

- **Security risk (PRIMARY).** `gmail.modify` is a powerful
  scope. A compromised agent can:
  - Send emails as the operator (phishing, password resets to
    other accounts).
  - Trash messages (data loss; harder to detect than send).
  - Modify labels (data integrity).
  Mitigations to spec in ADR-0025:
  - Per-call user confirmation gesture for `send`/`trash` until
    we have proper agent-side rate-limit/anomaly detection
    (which currently doesn't exist — see e0707c5 / ADR-0026).
  - Rate-limit `send` to (e.g.) 5/hour, 50/day per token.
  - Audit-log every send with full RFC 822 hash + recipient list.
  - Email the operator on every send (or daily digest) so they
    can spot abuse.
- **Architectural risk.** Medium. Adds a write surface to a
  service the fork has so far treated as read-only. M5 (SSRF
  unification) would be a better landing zone for this once
  the SafeHTTPClient is in place.
- **Maintenance risk.** Medium — Gmail's API for `send` requires
  RFC 822 message construction, which is fiddly.
- **Test-baseline risk.** Need behavioural tests for both
  endpoints + the rate-limit + the per-call confirmation
  gesture (if adopted).
- **UX risk.** Existing operators must re-authorize Google with
  the upgraded scope; there's no silent path. This is the
  upstream's documented behaviour and is correct.
- **Migration risk.** All existing OAuth tokens for Google have
  scope `gmail.readonly` only — they'll need to re-consent.
  That's a one-shot user-facing migration.

## 5. Conflict surface in our fork

- `src/index.js` — Gmail action examples at lines 6549-6551
  ALREADY reference Send/Trash (verified in audit pass), but
  the actual route handlers don't exist. Half-state — the
  documentation surface promises something the code doesn't
  deliver.
- `src/routes/services.js` — exists in the fork; clean add.
- `src/services/google-adapter.js` — verify the fork's adapter
  shape matches upstream's (it should — `verifyToken` is the
  pattern from M3).
- F6 capability tests — `src/tests/services-execute-behavioral.test.js`
  + the L2 live-smoke `services-proxy-google-live-smoke.test.js`
  may need extension.

## 6. Test plan for the import (when ADR-0025 lands)

- ADR-0025 is the gating artefact; written first.
- New test file: `src/tests/gmail-write-endpoints.test.js`
  - send happy path (mock outbound Gmail API).
  - send without `services:google:write` scope → 403.
  - send body validation (missing `to`, missing `subject`,
    missing `body` → 400).
  - trash happy path.
  - trash with non-owned message ID → upstream returns 404 →
    proxy passes through.
  - rate-limit: 6th send within 1h → 429.
- L2 live-smoke extension: `services-proxy-google-live-smoke.test.js`
  gains gated `SMOKE_GMAIL_WRITE=1` send/trash assertions.
- Source-pin tripwire: extend
  `src/tests/security-regression.test.js` with the cardinal
  property "every gmail.send call writes an audit_log row with
  recipient hashes".
- Snapshot churn: G0.x API surface snapshot will need regen.
- Estimated baseline delta: 71/77/898 → 73/79/906 (+2 suites,
  +8 tests).

## 7. Rollback plan

Three-file revert. Existing operators retain their `gmail.modify`
scope but the endpoints disappear; no data loss. The next OAuth
re-auth will downgrade scope back to `gmail.readonly` per the
config.

## 8. Out of scope for this import

- `gmail.full` scope (permanent delete, settings access) — too
  privileged; intentionally excluded.
- Calendar/Drive write surfaces — separate mini-plans if and
  when needed (each is its own ADR).
- Per-call user confirmation UI in the dashboard (this is
  one of the ADR-0025 design decisions; if adopted, separate
  follow-up SPA work).
- Send-via-aliases (specific Gmail feature) — not in upstream
  commit; deferred.

## ADR-0025 outline (must land FIRST if accepted)

- Decision: do we accept Gmail write surface, and under what
  guard rails?
- Options to consider:
  - A: per-call user confirmation gesture (tightest).
  - B: rate-limit + audit only.
  - C: ship as upstream did (no extra guardrails).
- Recommendation: B + the operator-notify-on-send email,
  accepting that A is too friction-heavy for agent UX.
- Out of scope for ADR-0025: anomaly detection on Gmail send
  (that's e0707c5 / ADR-0026 territory).
