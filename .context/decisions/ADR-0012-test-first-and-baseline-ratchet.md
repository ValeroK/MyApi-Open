# ADR-0012 — Test-first discipline + lint/typecheck baseline ratchet

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** @kobi
- **Related.** `plan.md` §7 (Testing strategy), `TASKS.md` M0 / M2 / M14, ADR-0008 (`npm audit` blocking), ADR-0010 (single-codebase SOC2)
- **Tags.** testing / CI / quality

## Context

Owner requested, at the start of the M2 work, that "before each step we
verify all tests pass and add relevant tests". At the same time, once the
M0 CI scaffolding actually ran against HEAD we found:

- **Tests:** clean and fast — 19 / 19 suites, 227 passing, 18 skipped,
  ~13 s — once one Windows-specific `EBUSY` teardown flake in
  `oauth-security-hardening.test.js` was fixed on 2026-04-21.
- **Backend ESLint:** 243 problems (112 errors, 131 warnings), all on the
  pre-existing legacy monolith.
- **Typecheck (`tsc --noEmit` with `checkJs`):** 739 diagnostics, also all
  on legacy `.js` files.

If we leave both CI gates blocking, every M2 PR will fail on unrelated
legacy cruft and the pipeline stops helping us. We need a clear doctrine.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Clean up lint + tsc to zero right now, then flip both CI jobs to blocking | Cleanest state; CI immediately useful | Wipes out days of real work before M2 can start; churn on files we'd rewrite in M2–M7 anyway |
| B | Make lint + tsc non-blocking forever; rely on reviewer diligence | No CI friction | Guarantees the backlog never shrinks; defeats the gate |
| C | Hard gate: tests + security; report-only: lint + tsc; ratchet the reports down per PR; flip them to blocking in M14 | Real gate for correctness now; pressure to lower the numbers without blocking progress | Requires per-PR discipline; ratchet script is still TODO |

## Decision

We chose **Option C**.

**Hard gates (CI blocks PR merge):**
1. `npm test` passes on Node 20 and Node 22.
2. `npm audit --audit-level=high` passes (per ADR-0008).

**Soft gates (CI runs, surfaces output, never blocks yet):**
1. `npm run lint:backend` and `npm run format:check`.
2. `npm run typecheck`.

**Docker build** depends only on the hard gates (`test`, `security`).

**Test-first discipline.** The workflow encoded in
`.cursor/rules/test-first.mdc` is binding for every change:

1. Run `npm test` before editing. Confirm 19 / 19 green.
2. Write a failing test for the new behaviour (or a regression test for the
   bug), then implement until green.
3. Re-run `npm test`. A task only flips to `[x]` when the suite is green
   with the task's tests included.
4. Never increase lint / typecheck count on files touched by the PR.
5. Record changes (added tests, final counts) in `TASKS.md` and, for
   bigger cuts, in `.context/sessions/`.

## Consequences

### Positive
- M2 and subsequent milestones can start immediately with confidence —
  tests catch real regressions, lint/tsc noise doesn't block.
- Legacy debt is explicit and measurable: every PR's CI log shows the
  current lint + tsc numbers so drift is visible.
- Owner gets the test-first discipline they asked for.
- The Windows `better-sqlite3` flake pattern is now solved and documented
  (see the `safeUnlink` helper in `src/tests/oauth-security-hardening.test.js`).

### Negative / costs
- Relies on human diligence to keep lint / tsc counts from creeping up
  until the ratchet script exists. Mitigation: `.cursor/rules/test-first.mdc`
  and the PR-template checklist.
- Without the ratchet script, someone could mask regressions inside the
  legacy monolith. Mitigation: PR template already calls this out; M14
  (CI hardening) owns the script.

### Code changes landed in this ADR's commit
- `.github/workflows/ci.yml` — `lint-backend` and `typecheck` jobs marked
  `continue-on-error: true` with baseline comments. `docker` job now depends
  only on `test` + `security`.
- `src/tests/oauth-security-hardening.test.js` — Windows-tolerant
  `safeUnlink` helper replaces the naive `fs.unlinkSync` teardown.
- `tsconfig.json` — `src/docs/**` excluded (doc-as-object-literal files that
  aren't meant to be type-checked).
- `.cursor/rules/test-first.mdc` — binding test-first checklist.

## Follow-ups

- **M14 — Lint ratchet.** Add `scripts/ci-ratchet.js` that reads
  `.context/metrics/lint-baseline.json` and `typecheck-baseline.json`, runs
  the tool, and fails if the new number > baseline. Update the baseline on
  merges to `main`. Flip `continue-on-error` off once the script is in.
- **M7 — TypeScript conversion.** Each `.js → .ts` flip reduces the
  typecheck baseline; the new numbers update the stored baselines.
- **Quarterly.** Re-verify the baselines in this ADR and append a row to a
  small metrics table in `current_state.md`.

## Metrics recorded at this ADR's accept time

| Date | Tests (suites/tests) | ESLint problems (errors/warnings) | `tsc` diagnostics |
|------|----------------------|----------------------------------|-------------------|
| 2026-04-21 | 19 / 19 suites, 227 pass / 18 skip | 243 (112 / 131) | 739 |
