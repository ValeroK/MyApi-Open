# ADR-0002 — Dual-driver session + rate-limit store (SQLite default, Redis optional)

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** `plan.md` §0.1 (OQ-2), §3.3 (AD-2, AD-3), §6.4, `TASKS.md` M4
- **Tags.** architecture, session, rate-limit, ops

## Context

Today, both sessions (`express-session`) and rate limiters (`express-rate-limit`
plus several bespoke in-memory `Map`s with a cleanup interval) use in-process
state. That works for a single-node self-host and falls apart for:

- Multi-node cloud deployment (each instance has its own view of a user's
  rate-limit bucket).
- Restart durability (session + OAuth state wiped on every deploy).
- Observability (buckets are unqueryable outside a node).

We need a store that can be backed by either a local embedded database (for
self-hosters who don't want to run Redis) or Redis (for managed cloud), without
two divergent codepaths.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Redis only | Industry default; horizontally scalable | Self-hosters must run Redis; heavier footprint for a personal API |
| B | SQLite only | Zero-dep self-host | Breaks multi-node; poor fit for managed cloud |
| C | **Dual-driver behind one interface** (SQLite default; Redis when `REDIS_URL` is set) | Self-host stays zero-Redis; cloud gets a real distributed store; same API | Two drivers to test |

## Decision

**Option C — dual-driver.**

- Define `SessionStore` and `RateLimitStore` interfaces in `src/infra/session/`
  and `src/infra/rate-limit/`.
- Default driver: SQLite-backed (`better-sqlite3-session-store` for sessions;
  a token-bucket table for rate limits).
- Alternate driver: Redis-backed (`connect-redis` + `ioredis`) selected at
  boot when `REDIS_URL` is set.
- Both drivers are exercised in CI integration tests (testcontainers provides
  the Redis instance for cloud-build jobs).
- No more bespoke in-memory `Map`s; no more `global.sessions`; no more
  `rateLimitCleanupInterval`.

Rate-limit and session share the same driver on purpose — if the user has
Redis, they almost certainly want both in Redis; if they don't, both stay on
SQLite.

## Consequences

- One more dep group (`ioredis`, `connect-redis`) pulled in only when Redis is
  actually selected at runtime (kept out of the default Docker image layer).
- Small DB schema additions in `src/migrations/` for session + rate-limit tables.
- OAuth state storage benefits indirectly: the `state_tokens` table (ADR-0006)
  now survives restarts and multi-node deploys.
- Tests multiply by driver: CI must run the same suite against SQLite and
  Redis; acceptable cost for correctness.
- Related design question OQ-11 (Redis TLS) follows up from this ADR.

## Follow-ups

- Executed by tasks **T4.1–T4.8** in `TASKS.md`.
- New alert: `rate_limit_store_errors_total{driver=…}` spike.
- Open question: OQ-11 — exact TLS policy for `rediss://` vs `redis://`.
