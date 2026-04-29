# ADR-0020 — Agent-defined connectors: feasibility and short-term shape

- **Status.** Accepted (feasibility scoping; supersedable by a follow-up
  ADR once M5 closes and the connector workflow is designed for real)
- **Date.** 2026-04-28
- **Decision makers.** Repo owner + AI pairing (F6 work session)
- **Related.** `.cursor/plans/capability_test_plan_b4523725.plan.md` §4,
  `.context/capability-gaps.md` (`GAP-004`),
  `.context/tasks/backlog/F6-agent-capability-verification.md` (F6.6),
  ADR-0018 (OAuth identity vs service scope split), `plan.md` §6.3 (SSRF).
- **Tags.** architecture / agents / oauth / security / connectors

## Context

The user's vision for MyApi is that an AI agent — OpenClaude, Hermes, etc.
— can not only **use** existing connectors (Google, GitHub, Slack, …) but,
in time, **propose** a new connector against a third-party API the gateway
has never seen, and start using it. This ADR records what's true today,
what would be needed to safely deliver that vision, and the position F6
takes for the current cycle.

### What exists today

- **OAuth provider registry** — `oauthAdapters` is built once at process
  start (`src/index.js:541-836`) from a fixed roster of 31 provider names.
  Each entry is either a hand-written class (`GoogleAdapter`,
  `GitHubAdapter`, `SlackAdapter`, `WhatsAppAdapter`, `DiscordAdapter`)
  or a `GenericOAuthAdapter` instance constructed from a config object
  (auth URL, token URL, scopes, identity vs service split per
  ADR-0018). There is no runtime registration API.
- **`oauth.json`** — optional file at `src/config/oauth.json`. Read once
  at boot, `${ENV_VAR}` substitution applied, merged into `oauthConfig`.
  Useful for per-deploy redirect URIs, scope overrides, and the
  `enabled: false` hard-disable. **Not a hot reload.**
- **Connectors table** — `connectors` SQLite table
  (`src/database.js:2039-2057`) with columns `(id, type, label, config_json,
  created_at, updated_at)`. Exposed only to master tokens via
  `GET / POST /api/v1/connectors` (`src/index.js:6375-6393`). Currently
  used as a generic key/value bag; the `oauthAdapters` registry does not
  read from it.
- **Marketplace listings** — `marketplace_listings.type` validation
  accepts `persona | api | skill` (`src/index.js:11536`). No
  `connector` value, so an agent has no way to express "I'd like to
  publish a connector for service X" inside the marketplace data
  model. (Recorded as `GAP-004`.)
- **`GenericOAuthAdapter`** — the closest existing primitive to a
  data-driven adapter. Already supports the F4 identity/service scope
  split (`src/services/generic-oauth-adapter.js:14-22`). With a config
  object alone (no code), it can do authorize-URL build, token
  exchange, refresh, and `verifyToken` against arbitrary OAuth2
  providers.
- **`SafeHTTPClient`** — exists as `src/lib/ssrf-prevention.js` but is
  **underused** today (`current_state.md` §3 calls out two SSRF
  filters; the proxy endpoint uses the weaker inline `isPrivateHost`
  regex). M5 (SSRF surface unification) is the milestone that fixes
  this; until M5 closes, every outbound HTTP call from a
  data-driven adapter is a potential SSRF / credential-laundering
  hop.

### What "agent creates a new connector" would require

The full vision — an agent describes a connector, the gateway accepts
it, and starts using it immediately on behalf of users — is the
composition of five things that don't all exist:

1. **Connector spec data model.** A schema describing the inputs a
   `GenericOAuthAdapter` (or its successor) needs: name, auth URL,
   token URL, refresh URL, revoke URL, identity scopes, service
   scopes, redirect URI, expected `verifyToken` shape. Today the bag
   is `connectors.config_json` (untyped TEXT). **Missing:** a
   validated schema (JSON Schema or Zod) and a strict validator at
   the API boundary.
2. **Marketplace listing type.** Either extend
   `marketplace_listings.type` to include `connector`, or model
   connector submissions as a separate table. **Missing.**
3. **Runtime adapter loader.** A safe way to load a new adapter
   instance into `oauthAdapters` after boot, with rollback if the
   spec is malformed and observability for which adapters are
   "blessed" (hand-written) vs "data-driven" (DB-loaded). **Missing.**
4. **Safe outbound HTTP.** Every call a data-driven adapter makes
   (authorize redirect target, token exchange, refresh, revoke,
   verify, plus the proxy's downstream call) must go through
   `SafeHTTPClient` with DNS-pinned dial so a malicious connector
   spec cannot point at `169.254.169.254` or use a TOCTOU
   DNS-rebind to reach internal services. This is **M5's job**;
   without M5 the data-driven path is a remote-SSRF surface.
5. **Review / trust workflow.** An agent submitting a connector
   spec is effectively submitting code-by-data. The gateway needs a
   **state machine**: `proposed → owner-reviewed → approved-for-self
   → approved-for-marketplace → revoked`. Without this, any
   approved connector is implicitly approved for every user; with
   it, the owner gates the social risk surface. **Missing.**

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Build it now: schema + marketplace type + runtime loader + SSRF + review workflow as one cross-cutting effort. | Closes the user's vision in one shot. | Pulls forward four milestones (M5 + connector schema + workflow + UI). High risk because outbound HTTP is unsafe pre-M5 — any half-built version has a real SSRF surface. |
| B | Defer entirely. Document this as future-work, ship nothing. | Zero risk. | Loses the user's signal; nobody learns whether the underlying primitives work; the connector storage path stays untested. |
| C | Ship a small read-only spike now: schema + master-only round-trip + a clear "do not wire to runtime yet" guardrail. File a follow-up task brief gated on M5. | Validates the storage substrate today. Surfaces schema problems early. Documents the gap honestly. Zero new risk because nothing the spike persists is ever loaded into the live `oauthAdapters` registry. | Doesn't deliver the user-visible vision yet (still owner-only, still hand-wired afterwards). |
| D | Make connectors agent-creatable but **only** for the agent's own use, never the marketplace. Skip the review workflow. | Simpler than A; still delivers something agent-visible. | Same SSRF surface as A pre-M5. Also creates a "private connector" concept the rest of the codebase doesn't model. |

## Decision

We pick **Option C** for the F6 cycle.

1. F6.6 ships `src/tests/connectors-spike.test.js` proving the existing
   `connectors` table and master-only `POST /api/v1/connectors`
   endpoint round-trip a `GenericOAuthAdapter`-shaped spec (with
   schema validation), reject scoped tokens with 403, and reject a
   malformed spec with 400.
2. The spike does **not** load anything into `oauthAdapters` at
   runtime. Anything the test persists is inert until an operator
   explicitly wires it via code + restart, exactly the same as today.
3. We file a follow-up task brief
   (`.context/tasks/backlog/F7-agent-defined-connectors-runtime.md` —
   to be created when F6 closes) covering the four missing pieces
   above. **F7 is gated on M5 closing**; no work on F7 starts until
   `SafeHTTPClient` is the only outbound HTTP path in the codebase.
4. `marketplace_listings.type` stays at `persona | api | skill` for
   now. Adding `connector` is part of F7, not F6.

## Consequences

### Positive

- The **storage substrate** is exercised end-to-end before the user
  bets on the larger vision. If the schema is wrong, we learn now
  rather than mid-F7.
- The **gap is named and triaged** in `capability-gaps.md` (`GAP-004`)
  rather than living in tribal memory.
- The user's vision is preserved as a concrete, sequenced track
  (F6 spike → M5 SSRF → F7 runtime + workflow + marketplace), not
  deferred to "someday".

### Negative / costs

- The user does not get "agent submits a connector and it works" in
  this cycle. Documented up front so expectations are aligned.
- A small surface (the spike test) has to be kept green through F7
  even though F7 will rewrite it. Acceptable churn.

### Code changes required (F6.6 spike only)

- A JSON Schema (or Zod schema) for `GenericOAuthAdapter` config,
  living under `src/schemas/connector-spec.json` or
  `src/lib/schemas/connector-spec.js`.
- A validator wrapper called from `POST /api/v1/connectors` (currently
  `src/index.js:6375-6393`). Master-only stays.
- The new test file. No other production code change.

### Operational changes required

- None. Self-hosters get the same behavior as today; the spike test
  is internal.

## Follow-ups

- **F7 (to be filed when F6 closes).** Agent-defined connectors at
  runtime: connector schema (lock from this ADR), marketplace
  `connector` type (closes `GAP-004`), runtime adapter loader with
  hot-reload from the `connectors` table, review state machine,
  per-user vs per-marketplace approval split. **Hard dependency on
  M5.**
- **Documentation update.** Once F6 closes, the
  `.cursor/plans/capability_test_plan_b4523725.plan.md` §4 section
  links to this ADR rather than restating the feasibility work.
- **Revisit this decision when.** M5 closes (the SSRF gate is the
  reason F7 is blocked, not the workflow design); or sooner if a
  user reports the storage substrate doesn't fit a real provider
  shape.
