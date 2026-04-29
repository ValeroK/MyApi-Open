# Task brief — Agent capability verification (F6)

## Identity

- **ID.** `F6` (parked in `backlog/`; tasks below numbered `F6.0…F6.7`).
  Will roll into M-numbered tasks as findings dictate (e.g. P0 fixes
  jump into the active milestone).
- **Title.** Map every agent-facing capability and verify it end-to-end
  in three test layers (in-process supertest, gated live-smoke, manual
  agent-as-user runbook), recording every gap surfaced along the way.
- **Milestone.** Cross-cutting follow-up. Closes the
  "is MyApi ready for OpenClaude / Hermes / etc.?" question. Spans
  M3 (closed) + parts of M4 / M5 / M6 / M9 by way of the gap ledger.
- **Plan reference.** `.cursor/plans/capability_test_plan_b4523725.plan.md`
  (the in-progress plan ratified in the 2026-04-27 session).
- **Workstream.** WS-tests + WS-docs.

## Status

- **State.** in_progress
- **Assignee.** AI pairing (current owner)
- **Started.** 2026-04-28
- **Target done.** Opportunistic; the L1 suites are gating, the L2
  suites are nightly, the L3 runbook is one document.
- **Actually done.** —

## Why (1-paragraph context)

`.context/current_state.md` shows MyApi at 55 / 55 test suites, 767
passing — but the exploration pass for this task surfaced that almost
all of that coverage is on the **plumbing** (OAuth state, PKCE, secret
validation, scope isolation, session persistence, rate-limit drivers).
The **agent-facing surface** — the endpoints an OpenClaude or Hermes
instance would actually call (`/services/:svc/proxy`,
`/services/:svc/execute`, `/ask`, `/capabilities`,
`/tokens/me/capabilities`, `/gateway/context`, `/brain/chat`,
`/handshakes`, skill read paths) — has thin or no behavioral test
coverage. The user wants to "actually use it with agents", which means
two things that aren't true today: (1) every capability has a green
end-to-end test that proves it works without leaking creds, (2) every
gap surfaced during that work is captured so it can't be lost. F6 is
the work that produces both.

## What (scope + explicit non-goals)

### In scope

- **Capability inventory** captured in
  `.cursor/plans/capability_test_plan_b4523725.plan.md` §1a (already
  done as part of the planning pass).
- **L1 — supertest behavioral suites** (8 new files under `src/tests/`,
  see plan §3.1) running inside `npm test`. Every suite uses `nock` for
  upstream providers; every suite is test-first.
- **L2 — gated live-smoke suites** (5 new files, `*-live-smoke.test.js`,
  see plan §3.2) running against `docker:smoke` with real Google +
  GitHub creds. Gated on `SMOKE_URL` + per-suite env vars; never run in
  default `npm test`.
- **L3 — manual agent-as-user runbook**
  (`.context/runbooks/agent-real-life.md`) plus
  `scripts/agent-walkthrough.mjs` (a small Node script that uses
  **only** a bearer token, no DB/SDK access, so it walks the same path
  a real agent would).
- **Connector-creates-feasibility track** — `ADR-0020` write-up plus
  `src/tests/connectors-spike.test.js` proving the existing master-only
  connector storage round-trips a `GenericOAuthAdapter`-shaped spec.
- **Gap ledger** — `.context/capability-gaps.md` populated and
  maintained as the work happens.

### Out of scope

- Building real agent-creates-runtime-connector wiring (waits on M5
  SSRF unification + ADR-0020's recommendation).
- Skill-runner endpoints (skills are content today; making them
  executable is a separate feature).
- Frontend (React) test infrastructure (Vitest + RTL setup is M9 / M12
  scope; Jest currently ignores `src/public/`).
- Provider expansion beyond Google + GitHub (the user explicitly said
  default to those two; Slack / Discord / Notion are follow-ups).
- Production live-smoke against a hosted instance (waits on M14
  deploy work).

### Non-goals

- Replacing the existing test suites. F6 adds to them; nothing under
  `src/tests/` gets deleted.
- Closing the gaps F6 surfaces. F6's job is to **find** them and route
  them; the actual fixes happen in their own milestones.

## How (implementation plan)

Work order matches the plan §5. Each step keeps `npm test` green and
appends to `.context/capability-gaps.md` for any new finding.

1. **F6.0 — Bootstrap the gap ledger.** Create
   `.context/capability-gaps.md` with the schema, severity guide,
   pre-seeded findings (`GAP-001..GAP-007`). _Done 2026-04-28._
2. **F6.1 — L1 supertest suites.** Add 8 files under `src/tests/`:
   - `agent-discovery-contract.test.js`
   - `services-proxy-behavioral.test.js`
   - `services-execute-behavioral.test.js`
   - `ask-endpoint-behavioral.test.js`
   - `handshake-flow-behavioral.test.js`
   - `google-mount-auth-posture.test.js` (closes GAP-002 triage)
   - `connectors-master-only.test.js`
   - `agent-capabilities-end-to-end.test.js`
   Test-first. Each suite seeds its own users / tokens via the live
   helpers in `src/database.js`; mocks upstream HTTP with `nock`. Keep
   suite-total runtime under ~5s.
3. **F6.2 — L3 runbook + walkthrough script.** Write
   `.context/runbooks/agent-real-life.md` and
   `scripts/agent-walkthrough.mjs`. Runbook reuses `docker:smoke` from
   the M3 wrap-up groove. Script uses only `fetch` + a bearer string.
4. **F6.3 — L2 Google live-smoke.** Add
   `src/tests/agent-discovery-live-smoke.test.js` and
   `src/tests/services-proxy-google-live-smoke.test.js`, gated on
   `SMOKE_URL` + `SMOKE_BEARER` (+ `SMOKE_GOOGLE_USER`). Add
   `npm run smoke:agent` and `npm run smoke:google`.
5. **F6.4 — L2 GitHub live-smoke.** Add
   `src/tests/services-proxy-github-live-smoke.test.js` and
   `npm run smoke:github`. Verifies F4 identity/service scope split
   against a real GitHub OAuth app.
6. **F6.5 — L2 OAuth + handshake live-smoke.** Add
   `oauth-connect-flow-live-smoke.test.js` (gated on
   `SMOKE_INTERACTIVE=1` because the confirm gesture requires browser
   interaction) and `skills-and-handshakes-live-smoke.test.js`.
7. **F6.6 — Connector feasibility.** File ADR-0020, ship
   `src/tests/connectors-spike.test.js` (master-only round-trip,
   scoped 403, malformed 400).
8. **F6.7 — Triage pass.** Walk every `open` row in
   `.context/capability-gaps.md`; classify into M-numbered milestones
   if not already done; bump global progress in `.context/TASKS.md`.
   Update `.context/current_state.md` §5 + §6.

## Dependencies

- Depends on: M3 (closed; provides the OAuth groove F6 leans on),
  M4 (closed at the OSS critical path; provides session + rate-limit
  contract gates).
- Blocks: nothing in the existing roadmap. F6 is **insurance** before
  external agent integration.
- Related: M5 (SSRF unification — F6.6's connector spike intentionally
  stops short of runtime adapter loading because that's M5's domain),
  M6 (monolith extraction — once routes move, F6 tests should retarget
  the new module paths but their assertions stay valid),
  M9 / M14 (docs hygiene — the gap ledger feeds both).

## Testing

- **Unit tests to add.** None directly — F6 is itself a test push.
  Helpers exposed by F6 live under `src/tests/helpers/` if needed (e.g.
  `seedAgentToken(scope, ownerId)`).
- **Integration tests to add.** All 8 L1 suites listed in F6.1.
- **Live-smoke tests to add.** All 5 L2 suites listed in F6.3 / F6.4 /
  F6.5.
- **Security regression tests.** Any P0 finding from the gap ledger
  must add a row to `src/tests/security-regression.test.js` per the
  test-first rule. Pre-seeded GAP-002 will trigger this if the live
  triage confirms a real auth bypass.
- **Manual verification.** The L3 runbook + walkthrough script IS the
  manual verification step. Sign-off on F6 requires walking it once
  end-to-end.

## Risks & rollback

- **What breaks if this ships wrong?** F6 is additive; nothing existing
  changes behavior. The risk is a **false-green** L1 / L2 suite that
  pretends to test real-life flow but actually exercises a permissive
  mock. Mitigation: every L1 assertion has a paired L2 live-smoke
  assertion (or a documented reason it can't), so anything that passes
  L1 but fails L2 surfaces the mock-vs-reality drift loudly.
- **How do we roll back?** F6 lands in atomic commits per the
  test-first rule. Reverting any single F6 commit removes the
  corresponding test files and restores the prior baseline.
- **What should we watch in logs/metrics for 24h after?** Nothing —
  F6 doesn't ship runtime code. The exception is whatever fixes the
  gap ledger drives; those are tracked in their own milestones.

## Artifacts

- Plan: `.cursor/plans/capability_test_plan_b4523725.plan.md`
- Gap ledger: `.context/capability-gaps.md`
- ADR: `.context/decisions/ADR-0020-agent-defined-connectors-feasibility.md`
  (to be filed in F6.6)
- Runbook: `.context/runbooks/agent-real-life.md` (to be filed in F6.2)
- Related backlog: `F1` (post-OAuth SPA race), `F2` (onboarding
  wizard), `F5` (password auth) — none block F6.

## Outcome (fill in when completing)

- Summary of what actually landed: _…_
- Deviation from plan and why: _…_
- Follow-ups created (new task IDs / GAP IDs): _…_
- Lessons learned: _…_
