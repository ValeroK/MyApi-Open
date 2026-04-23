# ADR-0009 — Tiered test coverage thresholds

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** `plan.md` §0.1 (OQ-9), §5.1.1, `TASKS.md` M7, M12
- **Tags.** testing, process, security

## Context

The current `jest.config.js` enforces a single 50% coverage floor across
everything. Two problems:

- **Too low for the code that matters most.** Bugs in crypto, OAuth state, and
  SafeHTTPClient can leak tokens or pivot SSRF. 50% is not enough there.
- **Too high for the monolith.** `src/index.js` is being actively dismantled.
  Writing tests that pin down its 11k LOC before the refactor is wasteful — 
  those tests would be deleted with the code.

A flat threshold either blocks the refactor or pretends our crypto is as safe
as our onboarding flow. Neither is acceptable.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Raise global floor to 80% | Simple message | Blocks the monolith refactor; incentivizes throwaway tests |
| B | Keep global floor at 50% | No friction | Under-protects the security-critical paths |
| C | **Per-path thresholds: 80% on `src/domain/**`, `src/infra/crypto/**`, `src/infra/http/**`, `src/infra/session/**`; 70% on `src/app/**`; 50% on legacy/`src/index.js`** | Matches effort to risk; unblocks refactor; raises the bar on what matters | Slightly more complex config |

## Decision

**Option C.** `jest.config.js` is updated with a `coverageThreshold` map:

```
coverageThreshold: {
  global: { lines: 50, branches: 50, functions: 50, statements: 50 },
  'src/domain/**/*.{js,ts}':         { lines: 80, branches: 80, functions: 80, statements: 80 },
  'src/infra/crypto/**/*.{js,ts}':   { lines: 80, branches: 80, functions: 80, statements: 80 },
  'src/infra/http/**/*.{js,ts}':     { lines: 80, branches: 80, functions: 80, statements: 80 },
  'src/infra/session/**/*.{js,ts}':  { lines: 80, branches: 80, functions: 80, statements: 80 },
  'src/app/**/*.{js,ts}':            { lines: 70, branches: 70, functions: 70, statements: 70 }
}
```

When the monolith is fully extracted (end of Workstream 2 / M6), the global
floor is raised to 70% in a follow-up ADR.

## Consequences

- Security-critical code must have proportionate tests before it lands.
- The M6 refactor doesn't fight coverage: modules get their tests as they
  move into `src/domain/**` and `src/infra/**`.
- Task T7.7 is the single point where this configuration change lands in code.

## Follow-ups

- Executed by task **T7.7** in `TASKS.md`.
- Follow-up ADR planned: raise global floor to 70% once `src/index.js`
  is < 600 LOC.
