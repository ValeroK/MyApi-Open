# Import: e500414 — fix(tests): unref module-level setIntervals to prevent Jest open-handle leaks

- Upstream commit: `omribenami/MyApi-Open@e500414c` (Subagent on 2026-04-22)
- Files upstream touched: `src/index.js` (+2 / -2),
  `src/middleware/policyEngine.js` (+1 / -1) — net +3 / -3
- Status: proposed
- Decided by: _(awaiting user verdict — recommend accept)_
- Linked ADR: none
- Linked TASKS row: F12 / Group B.8 (verify-promoted)

## 1. What it actually does

Calls `.unref()` on module-level `setInterval` handles so the
Node event loop can exit cleanly when Jest finishes — fixes
"open handle" warnings that have plagued the test suite.

Upstream applied to:
- tokenCache cleanup interval (`src/index.js`)
- AFP heartbeat interval (`src/index.js`)
- policyEngine periodic interval (`src/middleware/policyEngine.js`)

## 2. Do we want it?

**Yes.**

## 3. Why do we want it?

- Closes risk: none directly, but improves test reliability.
- Closes capability gap: ratchet on Jest open-handle hygiene
  (the fork's M3 wrap-up already paid attention to this with
  the `unref` story for the prune scheduler — same pattern).
- Aligned with milestone: F12 / Group B; quality fix.
- Strategic fit: matches ADR-0012's test-baseline ratchet
  philosophy — clean test teardown matters because flaky
  teardown hides real failures.

## 4. Risks it poses

- **Security risk.** None.
- **Architectural risk.** None.
- **Maintenance risk.** None.
- **Test-baseline risk.** Net-positive — should reduce the
  `--detectOpenHandles` warnings that show on `npx jest`.
- **UX risk.** None.
- **Migration risk.** None.
- **Production behaviour risk.** Zero. `.unref()` only affects
  whether the event loop can exit; in a long-running production
  process the loop is held open by the HTTP server, the DB
  connection, and the session store anyway, so the intervals
  still fire as before.

## 5. Conflict surface in our fork

- `src/index.js` — fork has 5 `setInterval` sites at lines
  136 (state-prune), 1108 (email processor), 12530 (AFP
  heartbeat), 12789 (rate-limit cleanup), 12816 (retention
  cleanup) — none currently call `.unref()`. Upstream's hunk
  patches just the tokenCache + AFP sites; the FORK should
  extend the pattern to all 5 sites in the same import for
  consistency.
- `src/middleware/policyEngine.js` — DELETED in the fork's
  M1/M2 sweep. That hunk is N/A.
- The fork's `src/domain/oauth/prune-scheduler.js` already
  calls `.unref()` per the M3 wrap-up — confirms this pattern
  is fork-aligned.

## 6. Test plan for the import

- New test file: `src/tests/setinterval-unref-hygiene.test.js`
  - Source-pin: every `setInterval(...)` at module-level in
    `src/index.js` is followed by `.unref()` (textual gate).
  - Behavioural: spawn a child process with `node src/index.js`,
    POST to `/health`, then send `SIGINT`; assert the process
    exits within 2s (proving no rogue interval is keeping the
    loop alive).
- Source-pin tripwire: yes (per above).
- Snapshot churn: none.
- Estimated baseline delta: 71/77/898 → 72/78/900 (+1 suite,
  +2 tests, +1 source-pin).

## 7. Rollback plan

Single-file revert. Open-handle warnings return; no functional
regression.

## 8. Out of scope for this import

- Replacing `setInterval` with `unref-friendly` alternatives
  (e.g. moving to a single scheduler tick — separate
  architectural improvement, M11 observability work).
- The N/A `policyEngine.js` hunk (file deleted in fork).
- Deciding whether to surface "graceful shutdown" handlers
  for SIGTERM (separate ops concern; M11/M14).
