# ADR-0004 — OSS ↔ managed-cloud feature parity on a single codebase

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** `plan.md` §0.1 (OQ-4), §3.3 (AD-9), ADR-0002, ADR-0010
- **Tags.** product, architecture, licensing

## Context

MyApi will eventually have a managed-cloud offering. We don't want two
repositories, two release trains, or two audit stories.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Separate cloud fork with closed-source additions | Keeps IP differentiation | Drift; every security fix lands twice; compliance evidence doubles |
| B | Same repo, cloud-only modules behind `if (isCloud)` branches | Simple | Code smell + dead branches for self-host users; easy to forget a branch |
| C | **Same repo, single codepath, runtime behavior gated by env flags** (`REDIS_URL`, `BILLING_ENABLED`, `AUDIT_EXPORT_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, …) | One binary; one audit trail; SOC2 evidence applies everywhere | Cloud-specific features must be opt-in flags, not forks |

## Decision

**Option C — single codebase, env-flag parity.**

- No cloud-only files. No closed-source additions.
- Cloud-specific behavior is toggled by environment variables only.
- The OSS build contains the same SOC2 / compliance instrumentation as the
  cloud build (see ADR-0010). Self-hosters can toggle it on.
- Licensing remains whatever the repo ships with today (tracked separately);
  this ADR is only about code organization.

## Consequences

- Any PR that adds `if (process.env.CLOUD)` must instead read a named feature
  flag and document the flag.
- Release cadence: one version number for both offerings.
- Billing, team-management, audit-export features live in `src/domain/billing/`,
  `src/domain/tenants/`, `src/domain/audit/` and are toggled via env flags.
- This ADR directly enables ADR-0010 (SOC2 evidence) — same instrumentation,
  same proofs, whichever deployment.

## Follow-ups

- Audit every existing `if (isCloud)` / `if (process.env.CLOUD)` site during M8.
- Add a CI lint step forbidding raw `CLOUD` literals outside `src/config/`.
