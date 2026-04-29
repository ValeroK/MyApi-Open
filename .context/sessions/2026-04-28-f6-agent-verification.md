# Session — 2026-04-28 — F6 — Agent capability verification

- **Date.** 2026-04-28
- **Participants.** Repo owner + AI pairing (Claude Opus 4.7).
- **Duration.** ~1 long pairing session (full-day-equivalent).
- **Related work.** `TASKS.md` F6 (closed) + new F8 / F9 / F10
  briefs, `ADR-0019` (snapshot diffs as evidence for security
  fixes), `ADR-0020` (agent-defined connectors feasibility),
  `.context/capability-gaps.md` (the running ledger), L3 runbook
  at `.context/runbooks/agent-real-life.md`.

## Goal

Map every agent-facing capability MyApi exposes (credential
add / get / save / use, scoped tokens, device approval, audit
trail, handshake bootstrap, capability discovery), verify each
one with a real test, and produce an honest "is MyApi ready for
OpenClaude / Hermes?" answer with every known limitation written
down.

## Summary

We worked through F6 in a single sitting: 8 L1 supertest suites
(in-process supertest, runs in `npm test`), 4 L2 live-smoke files
(gated on `SMOKE_URL`, run against `docker:smoke`), an L3 manual
runbook (markdown) that we then turned into a Node CLI
(`scripts/agent-walkthrough.mjs`), a JSON-Schema validator for the
`GenericOAuthAdapter` connector spike per ADR-0020, and a triage
pass on the gap ledger that bucketed every open row into a
milestone or follow-up brief.

The most consequential moment was the second test we wrote
(`google-mount-auth-posture.test.js`) — it surfaced GAP-002, a
**P0 authentication bypass**: `app.use('/api/v1/google',
createGoogleRoutes())` had no `authenticate` middleware, and
inside the router `resolveUserId(req)` falls back to the literal
`'owner'` userId when no token / session is present. On any
deployment where Google was connected (the documented happy
path), an unauthenticated remote caller could `GET /api/v1/google/
gmail/messages`. We red-tested the bypass, fixed it with one line
(`app.use('/api/v1/google', authenticate, createGoogleRoutes())`),
green-tested the fix, and regenerated three Stage-0 snapshots
(G0.1 API surface, G0.2 middleware chain, G0.3 boot-side-effects
line drift) per ADR-0019 — the diffs ARE the security-fix
evidence.

The other gaps surfaced in the same pass:

- **GAP-008 (P1)** — `hasScope` is strict equality. The hierarchy
  documented in `CLAUDE.md` (`services:google:read` ⊂ `services:
  read`) is not implemented. A token granted the narrow scope
  cannot use the proxy at all. Filed as F9 with two consistent
  options.
- **GAP-009 (P1)** — `validateScope` greenlights narrow scopes but
  `grantScopes` cannot persist them (FK constraint). Internal API
  self-contradicts. Same fix as GAP-008.
- **GAP-010 (P1)** — `seedServiceCategories(); seedServices();`
  calls in `src/database.js:743-744` are commented out with a
  `TODO: MongoDB version` note. The service catalog is empty on
  every clean boot. `services/google/execute` returns 404 even
  with a connected OAuth row. Filed as F10 (XS).
- **GAP-011 (P2)** — duplicate `GET /api/v1/handshakes/:id/status`
  handler at `src/index.js:7847` is unreachable (Express 5 routes
  to the earlier registration at `:7778`). Pure dead code; static
  count gate pins it at 2 so we don't grow the duplication.
  Bundles into M6.

We also fixed two non-trivial test-infrastructure papercuts mid-
session: the `services-execute-behavioral.test.js` 404 was the
GAP-010 boot seed (called the seeders in `beforeAll`); the
`services-proxy-behavioral.test.js` scope-gate failure was the
`grantScopes` ↔ `scope_definitions` FK constraint (skipped grant
for the narrow tokens since they were characterization rows
anyway).

For F6.6 (connector spike) we shipped a **0-dep** schema
validator (`src/lib/schemas/connector-spec.js`) that:
- Requires `authUrl`, `tokenUrl`, `apiRoot` (the three fields
  whose absence makes a `GenericOAuthAdapter` fundamentally
  unable to function).
- Validates every URL field as `http(s)`.
- Enforces the F4 / ADR-0018 identity-vs-service scope split:
  at least one of `identityScopes` / `serviceScopes` must be
  present, and they MUST be disjoint (a scope string in both
  bags means a misconfigured spec).
- Returns `{ ok, error, code: 'INVALID_CONNECTOR_SPEC',
  fields: [...] }` so the handler can surface the offending
  field to the operator.

The handler call site is intentionally narrow: only `type ===
'generic_oauth'` triggers the validator. Other connector types
pre-date the spike and have ad-hoc shapes; we pinned that
bypass with an explicit test so the eventual "validate every
type" change is a deliberate diff.

The walkthrough script (`scripts/agent-walkthrough.mjs`) is
worth highlighting: it walks every phase of the runbook with
**only** `SMOKE_URL` + `SMOKE_BEARER`, prints `OK §N.x` /
`FAIL §N.x` for each step with status + latency, and exits
non-zero on any FAIL. It's the artifact an operator hands to
the next person to validate the gateway after a deploy.

The ledger triage closes the loop: every gap is now a row with
a target milestone or a filed brief. Zero `triage` rows remain.

## Key decisions

- **GAP-002 — `fix-now`.** Auth-bypass on Google mount; fixed in
  the same change as the test that surfaced it. Snapshot
  regeneration in the same change is the audit trail per
  ADR-0019.
- **L2 smoke files are gated on env vars, not skipped via
  `SKIP_LIVE`.** Mirrors the existing
  `oauth-authorize-url-live-smoke.test.js` pattern — the suites
  show up as "skipped" in `npm test` output with a clear name,
  rather than disappearing. Lower friction for new contributors
  who run `npm test` without docker.
- **Connector schema validator is 0-dep, plain JS.** No `ajv`,
  no `zod`. The schema is small enough to express directly in JS
  with branchful error messages. Avoids dragging in a runtime
  dependency for one validator. ADR-0020's "Code changes
  required" §says the schema can be JSON Schema OR Zod OR
  hand-rolled; we picked hand-rolled.
- **The unreachable `/handshakes/:id/status` handler at
  `:7847` is NOT deleted in this session.** Decision: pin the
  count at 2 with a static gate, file the cleanup as part of M6
  monolith extraction (where the right home is anyway). Risk of
  deletion-with-no-pin: a future "split into router file" PR
  could move the wrong copy.
- **`oauth-connect-flow-live-smoke.test.js` (M3 connect flow
  with browser interaction, gated on `SMOKE_INTERACTIVE=1`)
  deferred.** The 2026-04-24 M3 wrap-up smoke
  (`sessions/2026-04-24-m3-smoke.md`) already covered the connect
  flow live; an L2 file would just duplicate that signal. F6.5's
  scope shrunk to `skills-and-handshakes-live-smoke.test.js` only.
- **Triage classifications.** GAP-001 / 006 → M14 (docs sweep);
  GAP-005 / 011 → M6 (monolith extraction); GAP-007 → accept-risk
  (already covered by ADR-0016 follow-up); GAP-004 → F7 (already
  deferred per ADR-0020); GAP-003 → new F8; GAP-008 + GAP-009 →
  new F9 cluster; GAP-010 → new F10. Every disposition is
  reproduced in the triage table at the top of `capability-gaps.md`.

## Action items

| Owner | Action | Target date | Task ID |
|-------|--------|-------------|---------|
| operator | Boot `npm run docker:smoke`, complete the runbook Phase 1 (Connect Google + GitHub through dashboard), then run `SMOKE_URL=http://localhost:4500 SMOKE_BEARER=… SMOKE_GOOGLE=1 SMOKE_GITHUB=1 SMOKE_MASTER=… npm run smoke:walkthrough` end-to-end. Capture any FAIL line as a new `GAP-NNN` row. | next session | — |
| operator | F10 — uncomment the two seed calls in `src/database.js:743-744`. Half a day. | — | F10 |
| operator | F8 — pick Option A / B / C; if B, rewrite `llms.txt` + `description_for_model` to point at `/api/v1/capabilities`. | — | F8 |
| operator + AI | F9 — scope-hierarchy engine. Bundle into M6 if possible. | — | F9 |
| AI (next session) | Walk the M5 (SSRF unification) milestone properly so F7 (agent-defined connector runtime loader) can land. | — | M5 |

## Open questions raised

- Which option for F8 (`gateway/context` vs `llms.txt`)? Brief
  recommends Option B; operator decides.
- Which option for F9 (drop narrow scopes vs implement
  hierarchy)? Brief recommends Option (b) — implement the
  hierarchy — but only as part of M6 to keep the scope-engine
  module split clean.
- Should F10 stay Option (a) (smallest diff, restore the calls)
  or jump straight to Option (b) (`oauth.json`-driven)? Brief
  recommends staged: (a) now, (b) at M14.

## Artifacts

- Plan: `.cursor/plans/capability_test_plan_b4523725.plan.md`.
- Ledger: `.context/capability-gaps.md` (now with triage table).
- Runbook: `.context/runbooks/agent-real-life.md`.
- Walkthrough script: `scripts/agent-walkthrough.mjs`.
- New test files (8 L1 + 4 L2 + 1 spike):
  `src/tests/google-mount-auth-posture.test.js`,
  `src/tests/agent-discovery-contract.test.js`,
  `src/tests/services-proxy-behavioral.test.js`,
  `src/tests/services-execute-behavioral.test.js`,
  `src/tests/ask-endpoint-behavioral.test.js`,
  `src/tests/handshake-flow-behavioral.test.js`,
  `src/tests/connectors-master-only.test.js`,
  `src/tests/agent-capabilities-end-to-end.test.js`,
  `src/tests/agent-discovery-live-smoke.test.js`,
  `src/tests/services-proxy-google-live-smoke.test.js`,
  `src/tests/services-proxy-github-live-smoke.test.js`,
  `src/tests/skills-and-handshakes-live-smoke.test.js`,
  `src/tests/connectors-spike.test.js`.
- New production code: `src/lib/schemas/connector-spec.js`;
  modifications to `src/index.js` (GAP-002 one-liner +
  connector validator wiring, both with cross-reference
  comments).
- New ADRs: `ADR-0020-agent-defined-connectors-feasibility.md`
  (filed in plan mode 2026-04-28).
- New task briefs: `F8-gateway-context-vs-llms-txt-mismatch.md`,
  `F9-scope-hierarchy-engine.md`, `F10-service-catalog-seed.md`.
- Updated `npm` scripts: `smoke:agent`, `smoke:google`,
  `smoke:github`, `smoke:walkthrough`.
- Test baseline: 55 / 56 / 767 → **64 / 69 / 855** (+9 suites,
  +88 passing tests, 5 L2 suites correctly skip when env vars
  unset, 28 / 28 snapshots stable, exit 0, full sweep ~64 s on
  Windows).
