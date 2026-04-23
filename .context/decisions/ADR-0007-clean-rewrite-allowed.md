# ADR-0007 — Clean-rewrite latitude while pre-production

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** `plan.md` §0.1 (OQ-7), ADR-0005, ADR-0006
- **Tags.** process, architecture

## Context

Several upcoming changes (one-shot vault migration, DB-backed OAuth state,
monolith extraction, crypto consolidation) would normally require multi-phase
rollouts — dual-read/dual-write windows, JSON schema versioning, deprecation
notices — to protect live users.

MyApi is not in production yet. There are no external users whose data needs a
compatibility bridge.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Design every refactor as if we already had users (dual-read, schema versioning everywhere) | Good hygiene; future-proof | Multiplies effort; keeps legacy paths alive; slows down the exact refactors that make the product safer |
| B | **Clean-rewrite allowed while pre-production; enforce compatibility from the first public release onwards** | Fastest path to a correct architecture; cheapest audit story | Any external pre-release testers must accept HTTP/JSON breaking changes on upgrades |

## Decision

**Option B.** Until the first public release:

- PRs may break HTTP/JSON contracts in a single commit.
- PRs may delete legacy endpoints, tables, or formats without a deprecation
  window, provided migrations + tests cover data continuity.
- PRs may change error codes, response envelopes, and feature flag names
  without ceremony.

From the first public release onward, this ADR is **superseded** by a future
ADR-XXXX ("API compatibility policy") — currently TBD — which will impose
standard deprecation and versioning discipline.

## Consequences

- The PRs implementing ADR-0002, ADR-0005, ADR-0006, and the M6 monolith
  extraction all lean on this latitude.
- `CHANGELOG.md` is started during the pre-production phase with a
  `## Unreleased — BREAKING` section; the first public release collapses that
  into v0.1.0 release notes.
- Pre-release testers (internal dogfood, AFP connector devs) are explicitly
  told to pull main and expect breakage.

## Follow-ups

- Write ADR-XXXX "API compatibility policy" before v0.1.0 ships.
- Add a one-line banner to `README.md` noting pre-production status during
  this window.
