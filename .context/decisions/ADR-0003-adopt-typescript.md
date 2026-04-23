# ADR-0003 — Adopt TypeScript progressively on the backend

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** `plan.md` §0.1 (OQ-3), §3.3 (AD-8), §4.1, `TASKS.md` M0, M7
- **Tags.** language, build, security

## Context

MyApi is a secrets custodian. A surprisingly large share of its real bugs are
"some function returned `undefined` where a buffer was expected" or "scope
string silently turned into `undefined`, RBAC allowed too much" — errors a
type system would reject at compile time.

The codebase is JavaScript today with JSDoc in places. We need static typing
where a type-system mistake **is** a security mistake (crypto, outbound HTTP,
session, token issuance). We do not want a risky all-at-once rewrite.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Stay in JS + more JSDoc | No build step; no migration effort | JSDoc inference is weaker than `.ts`; IDE experience degrades in large modules |
| B | Rewrite everything in TypeScript at once | Consistent end state | High risk during a period when we are already rewriting for security |
| C | **Progressive adoption** — `tsc` in `checkJs` mode for everything; convert `src/domain/**` and `src/infra/{crypto,http,session}/**` to `.ts` first | Immediate type-check safety net on all JS; focused conversion where it matters; low migration risk | Two file extensions during transition |

## Decision

**Option C — progressive TypeScript.**

- Add `tsconfig.json` at repo root with
  `allowJs: true, checkJs: true, strict: true, noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true, noEmit: true`.
- `npm run typecheck` runs `tsc` across the whole backend and blocks in CI.
- Conversion priority (strictly ordered):
  1. `src/infra/crypto/**` — a bug here leaks every token.
  2. `src/infra/http/**` — a bug here turns us into an SSRF relay.
  3. `src/infra/session/**`, `src/infra/rate-limit/**` — driver correctness.
  4. `src/domain/oauth/**`, `src/domain/vault/**`, `src/domain/tokens/**`,
     `src/domain/audit/**`.
  5. Everything else, opportunistically as modules are touched.
- Frontend stays JSX for now; revisit once the backend conversion stabilizes.
- Build pipeline: `tsc --outDir dist/` at package time; runtime runs
  compiled `.js`. Decided so Node has no runtime TS overhead in production.

## Consequences

- Modest CI latency bump (`tsc` across ~30 k LOC) — acceptable.
- Every PR touching `src/domain/**` or `src/infra/{crypto,http,session}/**`
  must keep types strict. No `any`. No `// @ts-expect-error` without a TODO
  that references an ADR or task.
- Developer ergonomics improve: named scope types replace string literals;
  branded types used for `UserId`, `TokenId`, `TenantId`.
- Related: OQ-15 asks whether `exactOptionalPropertyTypes` is on from day one.
  **Yes**, for new `.ts` files in `src/domain/**` only; relaxable per file
  during conversion if it blocks too much.

## Follow-ups

- Executed by tasks **T0.5–T0.7, T7.1–T7.7** in `TASKS.md`.
- Future ADR: build pipeline details (tsc vs esbuild vs tsup). Default is `tsc`.
- Revisit once 60% of `src/` is `.ts`: do we then enforce `noImplicitAny` on the
  remaining JS too?
