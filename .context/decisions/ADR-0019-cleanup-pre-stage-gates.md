# ADR-0019 — Cleanup pre-stage gates (Stage 0 baseline)

- **Status.** Accepted
- **Date.** 2026-04-27
- **Decision makers.** repo owner + AI pairing
- **Related.** `plan.md` §"Cleanup plan" (M4, M6, M7, M8, M9), ADR-0001, ADR-0002, ADR-0003, ADR-0012
- **Tags.** testing, refactor-safety, regression-prevention

## Context

The cleanup plan committed to next (M4 dual-driver session/rate-limit, M6
monolith extraction, M7 TypeScript migration, M8 deletion of MongoDB /
legacy / dead code, M9 frontend & output hygiene) all touch the same
high-blast-radius surface area:

- the global Express middleware chain
- the route-mounting graph under `/api/v1/*`
- the auth lifecycle (session, CSRF, password change, logout)
- the error-envelope contract every dashboard / SDK client parses
- the security-header policy (CSP, HSTS, Cache-Control)
- background timers registered at module-load time

Every prior production-grade refactor of comparable scope (F1, F4, F5)
has surfaced silent regressions in *exactly* one of these surfaces. Each
of those regressions was caught only by user-visible breakage on the
dashboard, never by the unit-test suite — because the regressions live
between modules, not inside them.

The user's directive was explicit: **"my concern is breaking existing
functionality in the area we touch — add to the plan more tests that
needs to be done before starting every stage."** This ADR is the
durable record of how that concern is satisfied at the cross-cutting
layer.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Trust the existing 638-test suite to catch regressions during M4–M9 | Cheap; no new tests | Misses every cross-module regression — the entire failure class that broke F1/F4/F5 |
| B | Write per-milestone gates only at the start of each milestone (G4.x for M4, G6.x for M6, …) | Lazy; tests written when context is fresh | Each milestone arrives without a baseline to compare against; you can't tell the gate from the regression |
| C | **Stage-0 baseline gates (G0.1–G0.6) — pinned now, valid across every cleanup milestone, supplemented by per-milestone gates layered on top** | Catches the cross-cutting regression class once; per-milestone gates can focus on milestone-specific properties; survives every refactor in the cleanup window | Six new test files to maintain; snapshot updates required for any deliberate surface change |

## Decision

**Option C — six Stage-0 gates landed before any cleanup milestone
starts.**

The six gates and what each pins:

| Gate | File | Pins |
|------|------|------|
| G0.1 | `src/tests/cleanup-pre-stage-api-surface-snapshot.test.js` | Every mounted route (runtime walk of the Express stack) and every `app.use` mount point in `src/index.js` (static lex scan). Cross-checked. |
| G0.2 | `src/tests/cleanup-pre-stage-middleware-chain-snapshot.test.js` | Ordered top-level middleware chain (name, arity, kind, slash); app-level settings (`trust proxy`, `etag`, `x-powered-by`); 4-arity error handlers tail-loaded. |
| G0.3 | `src/tests/cleanup-pre-stage-boot-side-effects-inventory.test.js` | Every `setInterval`/`setTimeout` registration in `src/index.js` (line, indent, kind, nearest preceding line-comment). Top-level (module-load) timers separated from `bootstrap()`-resident timers. Orphan timers (no `.unref()` / no captured handle) ratcheted. |
| G0.4 | `src/tests/cleanup-pre-stage-auth-lifecycle-e2e.test.js` | Full register → /me → change-password → logout → re-login → /me → logout cycle on a single supertest agent. Cookie regeneration on login. Cache-Control: no-store on logout. Idempotent logout. No user-existence leak on bad-credentials login. |
| G0.5 | `src/tests/cleanup-pre-stage-error-envelope-snapshot.test.js` | Body shape + stable error-code enum for 6 representative cases (404/401 catch-all, 400 missing fields, 401 unauthenticated /me, 401 bad creds, 409 EMAIL_EXISTS, 400 PASSWORD_REUSED). |
| G0.6 | `src/tests/cleanup-pre-stage-security-headers-snapshot.test.js` | Per-response-family header policy (public JSON, JSON 4xx, unauth /me, authenticated logout, root /). CSP nonce scrubbed for snapshot stability. Hard assertions for `no-store` on auth-state mutators and on `/auth/email-config-status` (F5.3 ratchet). |

Why static + runtime in G0.1 and G0.3: `src/index.js` is monolithic and
some of its handlers / timers live inside `bootstrap()`, which is not
called by `require('../index')` in the test environment. A runtime-only
walk would miss them. A textual scan catches the lot. The two views are
cross-checked in G0.1 to prevent textual hallucinations from masking a
real route deletion.

Why snapshots and not hard assertions: most properties (route lists,
header policy, error envelope shape) ARE genuinely allowed to change —
the question is "can you see the change in the diff before merging?".
Snapshots make every change visible; hard assertions make only the
already-known-bad changes visible.

Where hard assertions ARE used (in addition to the snapshot): F5.3
ratchets specifically — `Cache-Control: no-store` on logout and on
`/auth/email-config-status`, no-user-existence-leak on login, idempotent
logout. These are bug-for-bug regressions that have already happened
once; they get the stricter gate.

## Consequences

**Positive.**

- M4 / M6 / M7 / M8 / M9 each start against a known-pinned baseline.
- Every cleanup commit that legitimately changes a pinned property
  shows up as an explicit snapshot diff in code review — no silent
  contract changes.
- Real findings already surfaced by writing the gates:
  - Unknown `/api/v1` routes return **401**, not 404, because a
    session-requiring middleware sits in front of the catch-all
    (G0.5).
  - Error envelope is INCONSISTENT — most errors are `{error}` only;
    only `409 EMAIL_EXISTS` is `{error, code}`. M9 has a concrete
    target (G0.5).
  - Four orphan `setInterval` timers in `src/index.js` lack
    `.unref()` and lack captured handles — they keep the event
    loop alive and force every Jest run through `--forceExit`.
    M4 / M6 has a concrete target (G0.3).
  - `x-powered-by: Express` is still on every response —
    helmet-removal target for M9 (G0.2).

**Negative.**

- Six new test files to maintain. Mitigated by tight ownership: each
  file is internally documented with its update procedure.
- Snapshots must be regenerated alongside any deliberate surface
  change, in the same commit. This is a discipline cost, not a
  technical cost.

**Cost paid up-front.**

- 30 new tests (1 source-non-trivial + 4 G0.1 + 5 G0.2 + 4 G0.3 + 4 G0.4
  + 6 G0.5 + 7 G0.6). Pre-gate suite was **638 / 638 passing**;
  post-gate suite is **668 / 668 passing**, 22 skipped. Sweep time
  delta: under 1 second.

## Update procedure

When a cleanup milestone deliberately changes a pinned surface:

1. Make the source change.
2. Re-run the affected gate with `--updateSnapshot`.
3. Read the snapshot diff. If anything looks unintended, fix the source
   first.
4. Commit source + snapshot in the same commit.
5. Reviewer reads the snapshot diff alongside the code diff. **No
   snapshot-only commits are merged without an accompanying source
   change** (a snapshot-only diff usually means the gate caught a
   non-determinism — fix the gate, don't accept the flake).

## Per-milestone follow-ups

The Stage-0 gates do NOT replace per-milestone gates (G4.x for M4,
G6.x for M6, …). They *baseline* the cross-cutting properties; each
milestone still owns the milestone-specific gates documented in its
own task entry. The cleanup plan tracks both.
