# ADR-0008 — `npm audit` blocks CI at HIGH+

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** `plan.md` §0.1 (OQ-8), §8.2, `TASKS.md` M13
- **Tags.** ci, supply-chain, security

## Context

`.github/workflows/ci.yml` runs `npm audit --audit-level=high || true`. The
`|| true` silently turns any HIGH or CRITICAL advisory into a no-op.

We're a secrets custodian. The cost of landing a PR that adds a dependency
with a known HIGH-severity advisory is an opportunity for that advisory to be
exploited on our users. The cost of a false positive — say, an advisory on a
transitive dep with no exploitable path — is the time to suppress it via
`.npmrc` / `package.json` `overrides` / `audit` resolutions, with a dated
review note.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Status quo (`\|\| true`) | No CI pain from transitive advisories | Any HIGH can ship; no accountability |
| B | Block at `critical` only | Fewer false positives | Misses HIGHs that CVSS 7–8.9 includes things like RCE in dev deps |
| C | **Block at `high`, track suppressions in `package.json` overrides + dated notes** | Clear bar; explicit suppressions; accountable | Occasional 30 min of "triage this advisory" when a transitive dep lands a bad one |

## Decision

**Option C.** The CI `security` job runs `npm audit --audit-level=high`
without `|| true`. Any HIGH or CRITICAL advisory fails the build. Suppressions
require:

1. A `package.json` `overrides` entry pinning to a fixed version, **or**
2. A dated `SECURITY_NOTES.md` entry (or entry in `.context/decisions/`)
   naming the CVE, why it doesn't apply to our usage, and when to revisit.

MEDIUM and lower advisories are surfaced but non-blocking (reviewed weekly).

## Consequences

- PR authors occasionally hit advisories on transitive deps and either update
  the parent dep or file a documented suppression.
- Dependabot + Renovate are scheduled in M13 so HIGHs rarely reach a PR.
- Supply-chain risk budget becomes explicit, not implicit.

## Follow-ups

- Executed by task **T13.1** in `TASKS.md`.
- Add `SECURITY_NOTES.md` at repo root for current suppressions (none yet).
- Revisit annually: does MODERATE belong in the blocking bar?
