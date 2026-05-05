# Import: e0707c5 — feat(security): token anomaly detection, suspension, and re-approval flow

- Upstream commit: `omribenami/MyApi-Open@e0707c53` (Subagent on 2026-04-21)
- Files upstream touched: `src/config/database.js` (+40 / -1),
  `src/database.js` (+44 / -0),
  `src/lib/asnLookup.js` (+84 / -0, NEW),
  `src/lib/tokenSecurityMonitor.js` (+252 / -0, NEW),
  `src/middleware/auth.js` (+44 / -0),
  `src/services/emailService.js` (+136 / -0)
- Status: deferred (architectural; requires ADR-0026)
- Decided by: _(awaiting user verdict; if accepted, ADR-0026 must land in same commit)_
- Linked ADR: ADR-0026 (`token-anomaly-reintroduction`; not yet ratified)
- Linked TASKS row: F12 / Group C.2

## 1. What it actually does

Adds runtime anomaly detection across all token types:

- **ASN/org-type drift detection** — datacenter → residential/VPN/Tor
  IP changes flagged.
- **User-Agent baseline drift** for agent tokens.
- **Request velocity limiting** per token type
  (100-500 req/min).
- **Automatic token suspension** with one-row-per-token baselines.
- **Re-approval** via the existing `device_approvals_pending`
  mechanism.
- **Notifications**: in-app + HTML security alert email on
  detection.
- **Compliance audit log** entry per anomaly event.

New files: `src/lib/asnLookup.js` (queries `ip-api.com` + caches
in new `asn_cache` table), `src/lib/tokenSecurityMonitor.js`
(checks + suspension logic).

DB migrations: `suspended_at` / `suspension_reason` columns on
`tokens` and `access_tokens`; `approval_type` on
`device_approvals_pending`; new tables
`token_security_baselines` and `asn_cache`.

## 2. Do we want it?

**Conditional yes — requires ADR-0026 first.**

The capability is valuable (closes a real risk), but it has
multiple architectural concerns the fork has explicitly avoided
in M2/F4:
1. **External network dependency** (`ip-api.com`) — the fork
   prefers self-contained primitives. M5 SSRF unification
   should own this.
2. **Asynchronous side effects in the auth middleware** — adds
   latency and failure modes.
3. **Auto-suspension** is a footgun for the operator's own master
   token (lockout risk; same family as F11).

## 3. Why do we want it (eventually)?

- Closes risk: §6.3 — "no runtime signal when an attacker is
  exfiltrating data via a compromised token". Today the fork
  detects new-device first-use (M3 confirm gesture, F4
  device-approval gate) but does NOT detect anomalous
  *continued* use from a previously-approved device.
- Closes capability gap: combined with the upcoming `9cd414a`
  red-card import + `99f864d` new-device email, this completes
  the operator-recoverability story for token misuse.
- Aligned with milestone: F12 / Group C; security capability.
- Strategic fit: matches the fork's "verifiable agent gateway"
  thesis — agents are MORE likely to be compromised than
  human users, so runtime monitoring matters more here.

## 4. Risks it poses

- **Security risk (PRIMARY).** False positives can lock out the
  operator's master token. Mitigations to spec in ADR-0026:
  - Master token NEVER auto-suspends (alert only).
  - Per-token-type baseline thresholds (master ≠ agent ≠ guest).
  - Operator-side override via `POST /admin/tokens/:id/unsuspend`.
- **Architectural risk (HIGH).**
  - External network dependency (`ip-api.com`) is exactly the
    SSRF surface M5 was designed to eliminate. Need to either:
    (a) wait until M5 lands and route through SafeHTTPClient, or
    (b) implement an in-process MaxMind lookup, or
    (c) accept the dependency with a feature flag.
  - Adds latency to EVERY authenticated request (the middleware
    runs the anomaly check). Need to bench.
- **Maintenance risk.** Medium — ASN data drifts; needs
  refresh strategy.
- **Test-baseline risk.** Substantial. Need full behavioural
  test coverage for: baseline-write-on-first-use, drift-detection,
  suspension, re-approval, master-token-no-auto-suspend.
- **UX risk.** False-positive lockout is the worst outcome.
  ADR-0026 must specify thresholds conservatively.
- **Migration risk.** Two new DB tables + four new columns.
  All additive; no data backfill required (baselines populate
  on first auth post-deploy).
- **Privacy risk.** Sending operator IP addresses to `ip-api.com`
  is a third-party data flow that needs disclosure in
  privacy policy.

## 5. Conflict surface in our fork

- `src/middleware/auth.js` — fork's auth middleware was rewritten
  in F4 (identity-vs-service split); upstream's hunk is a clean
  ADD but needs to slot AFTER the F4 token-validation block, not
  in upstream's exact line offset.
- `src/database.js` — additive table create; fits the fork's
  `safeMigration()` pattern.
- `src/config/database.js` — fork's database config doesn't
  follow upstream's exact shape; cross-check before merging.
- `src/services/emailService.js` — fork's emailService has its
  own evolved templates; the new `sendAnomalyAlertEmail` should
  follow the fork's templating shape.
- `src/lib/asnLookup.js` (NEW) — clean add but the network
  dependency needs ADR-0026 sign-off.
- `src/lib/tokenSecurityMonitor.js` (NEW) — clean add.
- M2 source-pin: `src/tests/oauth-state-inventory.test.js` and
  `legacy-vault-inventory.test.js` won't fire on this commit (no
  banned symbols), but ADR-0024 §3 still requires verification.

## 6. Test plan for the import (when ADR-0026 lands)

- ADR-0026 is the gating artefact; written first.
- New test file: `src/tests/token-anomaly-detection.test.js`
  - First auth from a token: baseline row created.
  - Same-device replay: no alert, no suspension.
  - Same-device but ASN flip (residential → datacenter):
    alert + suspension on agent tokens; alert-only on master.
  - UA drift on agent token: alert + suspension.
  - Velocity exceeded: suspension.
  - Re-approval flow: operator approves via dashboard; baseline
    is reset.
  - Master-token-no-auto-suspend invariant.
- New test file: `src/tests/asn-lookup-cache.test.js`
  - Cache hit: no outbound `ip-api.com` call.
  - Cache miss: outbound call (mock) populates cache.
  - Cache TTL respected.
- Source-pin tripwire: extend
  `src/tests/security-regression.test.js` with the cardinal
  property "master token never auto-suspends".
- Snapshot churn: low.
- Estimated baseline delta: 71/77/898 → 73/79/918 (+2 suites,
  +20 tests).

## 7. Rollback plan

Six-file revert. New tables remain (additive — no harm). Auth
middleware reverts to pre-anomaly behaviour. Operators with
suspended tokens need a manual `UPDATE tokens SET suspended_at =
NULL` to restore (document in CHANGELOG).

## 8. Out of scope for this import

- The `9cd414a` red-card surface — separate import, but **must
  land within the same release** to avoid a half-built UX
  (notifications without surface).
- The follow-on `bfd21ee` "escalate OAuth cross-device use +
  fix analyzeSuspiciousActivity" hunk — separate import.
- The follow-on `f262e4e` "make new-device email informative
  with full context" hunk — separate import.
- Replacing `ip-api.com` with MaxMind GeoIP2 (separate
  architectural decision; if M5 SafeHTTPClient is the chosen
  path, document in ADR-0026).
- Per-tenant anomaly thresholds (multi-tenant SaaS shape;
  defer until M11+ tenancy work).

## ADR-0026 outline (must land FIRST if accepted)

- Decision: do we accept ASN-based anomaly detection, with a
  third-party IP-geolocation dependency?
- Options:
  - A: ip-api.com (upstream's pick).
  - B: MaxMind GeoIP2 in-process (no network dep; data file
       update required).
  - C: SafeHTTPClient routing (depends on M5).
  - D: Reject — accept-risk this gap until M11+.
- Recommendation: probably C (wait for M5) or B (MaxMind).
- Out of scope for ADR-0026: the dashboard surface (that's
  9cd414a + ADR follow-up).
- Out of scope for ADR-0026: master-token recovery from a
  legitimate-but-anomalous-looking trip — that's F11.
