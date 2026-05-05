# F12 — Rolling upstream-backport batch (2026-05)

> **Status.** Bootstrap landed 2026-05-04 (Phase B.1). Per-candidate
> mini-plans live under `.context/imports/`. No code imports landed yet.

## Identity

- **ID.** F12
- **Title.** Rolling upstream-backport batch from
  `omribenami/MyApi-Open` since fork-point `725060bb` (2026-04-13).
- **Milestone.** Free-standing F-task that drives the new
  **`M-import`** milestone in `TASKS.md`. Imports approved here
  add a row to both `M-import` (the merged-only counter) AND
  appear here at status `merged`.
- **Plan reference.** `plan.md` §3 ("the fork's strategic axis is
  the verifiable agent gateway, not a hosted SaaS"); ADR-0024
  (`upstream-import-policy`); ADR-0023 (release pipeline + rollback
  target); the v0.6.0 test baseline (71/77 / 898 / 28 / exit 0).
- **Source matrix.** `scripts/upstream-audit.mjs --json` regenerates
  the candidate list at any time. The frozen 2026-05-04 matrix is
  the seed for this brief.

## Status

- **State.** `[~]` in progress (bootstrap done; per-mini-plan triage
  pending user accept/defer/reject decisions)
- **Started.** 2026-05-04
- **Target done.** When every mini-plan in `.context/imports/` is at
  status `merged | deferred | rejected` AND the v0.7.0 release tag
  has been cut.

## Why

Upstream has shipped 113 commits since the fork point on 2026-04-13.
A direct merge would touch 364 files (+55,677 / -15,491 LOC) and
drown the test gate; we already declined that path
(`.context/sessions/2026-05-04-fork-vs-upstream-comparison.md`,
ADR-0024 §"Options considered" — Option B rejected). The fork has
made deliberate divergent calls (deletion of `crypto-js`, removal
of weak vault, source-pin tripwires for M2/M3, `.context/`
governance, F6 capability verification) that we will not regress.

But upstream has also shipped real product capabilities (new-device
email alerts, gateway connected-services AI instructions, Gmail
write surface, admin broadcast, tickets, BETA mode) and bug fixes
(frontend masterToken localStorage cleanup, CSP tightening,
notifications surface) that **fit the fork's stated direction**
("verifiable agent gateway") and would close real
`.context/capability-gaps.md` items if backported.

The backport process must:
1. Be **selective** (filter out SaaS-direction work like Stripe
   Starter $10 pricing, Texas-LLC ToS pages, landing-page redesign
   — none of which advance the agent-gateway thesis).
2. Be **auditable** (mini-plan paper trail per import per ADR-0024).
3. Be **reversible** (direct-to-main commits with `cherry-pick -x`
   provenance + v0.6.0 immutable rollback target).
4. Be **gated** (test baseline is a ratchet — never lower; M2/M3
   source-pin tripwires can never be reintroduced).

## What

### In scope (this brief)

The 22 candidates surfaced by the 2026-05-04 audit. Each has a
mini-plan under `.context/imports/<hash>-<slug>.md` per ADR-0024 §2.
Each gets a verdict (`accept | defer | reject`) before any code
moves. Accepted imports become a row in the `M-import` milestone
and ship via single-conventional-commit cherry-picks direct to
`main` (per ADR-0024 §3 default delivery mode).

### Out of scope

- **Anything not on the audit matrix.** New upstream commits land
  after 2026-05-04 will be triaged in a future F13 batch.
- **Architectural rewrites of upstream code to fit the fork's
  layout.** If a cherry-pick needs >30% rewrite, file a deferred
  mini-plan and revisit per ADR-0024 §5 stop conditions.
- **Backporting upstream's SaaS-direction work** (Stripe Starter
  $10, Texas-LLC ToS, landing redesign, GitHub-dark dashboard
  theme, BETA waitlist marketing). These are explicitly filtered
  out at the matrix level — most are not even on the candidate
  list. The one exception is `f5297d5` (BETA mode), which is on
  the matrix at `Status: deferred` pending ADR-0029
  (hosted-product-direction).
- **Re-aligning the fork to upstream's HEAD.** ADR-0024 § Options
  considered explicitly rejected this (Option B).
- **CI mirroring upstream's release pipeline.** Our release
  pipeline is owned by ADR-0023 and is not changed by F12.

## Candidate matrix (2026-05-04 audit)

Status legend: `proposed` (mini-plan written, awaiting user verdict),
`accepted` (verdict received, queued for cherry-pick), `merged`
(landed; row exists in `M-import`), `deferred` (waiting on a follow-up
ADR or external decision), `rejected` (explicitly out of scope),
`verify-fail` (post-verify pass: hunk already present in fork; no
work needed; treat as merged-equivalent).

### Group A — Strong candidates (8)

| # | Hash | Subject (one-liner) | Mini-plan | Status | Notes |
|---|------|---------------------|-----------|--------|-------|
| A.1 | b8a074b | (per mini-plan) | `imports/b8a074b-*.md` | proposed | — |
| A.2 | 1d8cadd | (per mini-plan) | `imports/1d8cadd-*.md` | proposed | — |
| A.3 | c9cc8cb | (per mini-plan) | `imports/c9cc8cb-*.md` | proposed | — |
| A.4 | ebdd006 | frontend masterToken localStorage cleanup | `imports/ebdd006-*.md` | proposed | Direct fix to a known fork bug — `authStore.js` still uses `localStorage.getItem('masterToken')`; verified during fork-vs-upstream comparison session. |
| A.5 | 99f864d | new-device email alert | `imports/99f864d-*.md` | proposed | Closes a `.context/capability-gaps.md` item; no architectural impact. |
| A.6 | d84fd51 | gateway connected_services AI instructions | `imports/d84fd51-*.md` | proposed | Strong agent-gateway-thesis fit. |
| A.7 | 3b517de | (per mini-plan) | `imports/3b517de-*.md` | proposed | — |
| A.8 | 5921232 | (per mini-plan) | `imports/5921232-*.md` | proposed | — |

### Group B — Verify-pass candidates (10)

These rows were "looks already-present in the fork" at audit time;
the verify pass run on 2026-05-04 produced one of three verdicts
each (`already-present` → row drops out; `partial` → mini-plan
gets written; `not-present` → mini-plan gets written). Per-row
verdicts are recorded in `.context/imports/.verify-pass-2026-05-04.md`.

| # | Hash | Topic | Verify verdict | Mini-plan | Status |
|---|------|-------|----------------|-----------|--------|
| B.1 | a070466 | CSP tightening | _verify_ | _conditional_ | _verify-pending_ |
| B.2 | b5c2359 | OpenAPI surface | _verify_ | _conditional_ | _verify-pending_ |
| B.3 | 780c05d | notifications | _verify_ | _conditional_ | _verify-pending_ |
| B.4 | 134def1 | `/users/me` identity scope | _verify_ | _conditional_ | _verify-pending_ |
| B.5 | 244624b | `.env` docs | _verify_ | _conditional_ | _verify-pending_ |
| B.6 | 669d30f | per-bullet (single hunk) | _verify_ | _conditional_ | _verify-pending_ |
| B.7 | 735ae9a | per-bullet (single hunk) | _verify_ | _conditional_ | _verify-pending_ |
| B.8 | e500414 | `setInterval` `.unref()` | _verify_ | _conditional_ | _verify-pending_ |
| B.9 | d302595 | dashboard token-eye reveal | _verify_ | _conditional_ | _verify-pending_ |
| B.10 | 9cd414a | dashboard red-card warning | _verify_ | _conditional_ | _verify-pending_ |

### Group C — Architectural imports (2, deferred)

These require a follow-up ADR before any code moves. Both
mini-plans land at `Status: deferred` in this batch.

| # | Hash | Topic | Required ADR | Mini-plan | Status |
|---|------|-------|--------------|-----------|--------|
| C.1 | 52dd343 | Gmail send/trash (`gmail.modify` scope) | ADR-0025 | `imports/52dd343-*.md` | deferred |
| C.2 | e0707c5 | token anomaly detection (ASN/UA drift) | ADR-0026 | `imports/e0707c5-*.md` | deferred |

### Group D — Capability imports (5)

Each is its own product surface; user makes the accept/defer/reject
call per row.

| # | Hash | Topic | Required ADR (if any) | Mini-plan | Status |
|---|------|-------|----------------------|-----------|--------|
| D.1 | 2c6aca8 | onboarding full-page wizard + OAuth signup flow | none (UX) | `imports/2c6aca8-*.md` | proposed |
| D.2 | 6ab11cb | admin broadcast page | ADR-0027 | `imports/6ab11cb-*.md` | deferred |
| D.3 | a6da498 | tickets capability surface (+ 91dd869 / 9220522 / 22b0d45 / bc19dfe / ef02c3c sub-rows) | ADR-0028 (mandatory) | `imports/a6da498-*.md` | deferred |
| D.4 | f5297d5 | BETA mode + waitlist | ADR-0029 (mandatory; gated on hosted-product axis) | `imports/f5297d5-*.md` | deferred |
| D.5 | 2eb8439 | service connected/disconnected emails (trigger-only hunks) | none | `imports/2eb8439-*.md` | proposed |

## How

### Phase B.1 — Bootstrap (this brief; landed 2026-05-04)

1. ADR-0024 ratifies workflow + 8-section mini-plan template +
   ADR-0023..0029 reservations + stop conditions.
2. This brief (F12) and the new `M-import` milestone in TASKS.md.
3. `scripts/upstream-audit.mjs` (read-only; regenerates the matrix
   on demand; supports `--json` for tooling).
4. Verify-pass run for the 10 Group B rows; per-row verdicts at
   `.context/imports/.verify-pass-2026-05-04.md`.
5. `.context/imports/README.md` index + ~18 per-candidate mini-plans
   (8 strong + 0-7 verify-promoted + 2 architectural-deferred + 5
   capability-proposed-or-deferred).
6. Single direct-to-main commit `chore(import-bootstrap): F12
   phase B.1 …` per ADR-0024 §3.

### Phase B.2 — Per-import execution (rolling, post-bootstrap)

For each accepted mini-plan, in any order:

1. (Architectural only) Land the ADR draft FIRST in
   `.context/decisions/ADR-NNNN-…md`.
2. Add a row to the `M-import` milestone table in TASKS.md.
3. `git fetch upstream && git cherry-pick -x <hash>` on `main`
   (default) or on `import/<slug>` opt-in.
4. Resolve conflicts per ADR-0024 §3 hard rules (extend, don't
   replace; never remove fork-only files; never silence a test;
   never reintroduce a M2/M3 inventory-banned symbol).
5. Add or extend a behavioural test (supertest preferred); add a
   source-pin to `src/tests/security-regression.test.js` if the
   import closes a `plan.md` §6.3 risk.
6. Run `npm test --silent` — must keep 71/77 / 898+ / 28 / exit 0.
7. Update `CHANGELOG.md` `[Unreleased]` and
   `.context/current_state.md` §5.
8. Flip the row in F12 + the row in `M-import` to `[x]` / `merged`.
9. Commit with conventional-commit format
   `feat(import): cherry-pick upstream/<hash> — <subject>` (or
   `fix(import)`, `chore(import)`).
10. (Optional) Push to `origin/main`.

### Phase B.3 — Release rollover (when ~10 imports merged or 2 weeks pass)

Per ADR-0023, cut `v0.7.0` once the `[Unreleased]` section in
`CHANGELOG.md` reaches ~10 entries or 2 weeks have passed,
whichever first. The release pipeline (`release.yml`) takes over
from there.

## Risks (per F12; per-import risks live in mini-plans)

- **Triage starvation.** Mini-plans pile up at `Status: proposed`
  and never get a verdict, leaving F12 perpetually in progress.
  *Mitigation:* `M-import` row in `TASKS.md` is empty until first
  accept; F12 row stays at the top of the global progress table
  as a visible reminder.
- **Drift from the v0.6.0 baseline.** A merged import inadvertently
  reintroduces a deleted upstream pattern (e.g. `crypto-js`,
  default vault key). *Mitigation:* the four M2/M3 source-pin
  tripwires (`oauth-state-inventory`, `legacy-vault-inventory`,
  `default-vault-key-removed`, `validate-required-secrets`) are
  the ratchet; ADR-0024 §3 makes them non-negotiable.
- **SaaS-direction creep.** A capability import from Group D
  pulls in upstream's hosted-product framing (BETA gate, waitlist,
  Texas-LLC footer). *Mitigation:* Group D rows requiring SaaS
  framing are deferred behind ADR-0029
  (`hosted-product-direction`); architectural imports require
  the ADR in the same commit.
- **Test-baseline ratchet erosion.** A capability import has a
  legitimately flaky upstream test that we re-enable.
  *Mitigation:* ADR-0024 §3 forbids `.skip` on existing tests
  to make a cherry-pick pass.
- **Stop-condition fires.** Three consecutive imports need >30%
  rewrite. *Mitigation:* ADR-0024 §5 stop condition triggers a
  summary ADR forcing a re-baseline decision.

## Test plan

- **Phase B.1 (this commit):** no runtime code touched. Sanity
  check: `npm test --silent` must remain 71/77 / 898 / 28 /
  exit 0.
- **Phase B.2 (per import):** every merged import either adds a
  new test file (preferred) OR extends an existing behavioural
  suite. The full sweep stays green at the v0.6.0 baseline +
  whatever the new tests add. Source-pin tripwires per import as
  required by ADR-0024 §3.
- **Phase B.3 (v0.7.0 cut):** release pipeline (ADR-0023) gates
  the tag.

## Acceptance criteria

- ADR-0024 accepted ✅ (2026-05-04).
- F12 row exists in `TASKS.md` global progress table ✅
  (2026-05-04, +22 sub-rows).
- `M-import` milestone row exists in `TASKS.md` global progress
  table ✅ (2026-05-04, empty until first accept).
- `.context/imports/README.md` + 18 mini-plans on disk ✅
  (Phase B.1).
- `scripts/upstream-audit.mjs` runs clean from a fresh clone with
  `git fetch upstream` already done ✅ (Phase B.1).
- Verify-pass for the 10 Group B rows recorded at
  `.context/imports/.verify-pass-2026-05-04.md` ✅ (Phase B.1).
- F12 closes when every mini-plan reaches a terminal status
  (`merged | deferred | rejected`) AND v0.7.0 has been cut.

## Links

- ADR-0024 — `.context/decisions/ADR-0024-upstream-import-policy.md`
- ADR-0023 — `.context/decisions/ADR-0023-release-versioning-and-publishing.md`
- Mini-plan index — `.context/imports/README.md`
- Audit script — `scripts/upstream-audit.mjs`
- Verify-pass record — `.context/imports/.verify-pass-2026-05-04.md`
- v0.6.0 release — `CHANGELOG.md`
- Upstream repo — `https://github.com/omribenami/MyApi-Open`
