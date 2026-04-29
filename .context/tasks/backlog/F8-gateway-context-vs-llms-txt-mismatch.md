# F8 — `gateway/context` master-only vs `llms.txt` advertisement

> **Status.** Filed 2026-04-28 from F6.7 triage. Closes `GAP-003`.

## Context

`/api/v1/gateway/context` is **master-only** (`src/index.js:6404` —
`if (!isMaster(req)) return res.status(403).json({ error: "Only
master token can access gateway context" })`). The endpoint returns
the persona, user identity, vault metadata, and the agent's
endpoint manifest — exactly the bundle a fresh agent needs.

But `llms.txt` (and the inline `description_for_model` in
`src/index.js:1801`) advertises this endpoint as the agent's
**first call** after handshake-issued bearer auth:

> _"With a valid token: FIRST call `GET /api/v1/gateway/context` —
> this returns your persona, user identity, long-term memory […]
> and all available endpoints."_

A scoped agent token (the only kind a handshake produces) cannot
reach this endpoint today. So the docs lie.

The L1 suite `agent-discovery-contract.test.js` pins the
**current** behavior (scoped → 403, master → 200) so that whichever
fix lands shows up as a deliberate diff.

## Decision

Pick **one** of these and execute:

### Option A — loosen the gate

Allow any authenticated bearer to call `gateway/context`, but
narrow the response by scope (the persona + user identity are
already safe; vault metadata is gated, but it can stay gated even
within a 200 response).

- Pro: docs become true.
- Pro: agents work as advertised on first contact.
- Con: response shape becomes scope-dependent — risk of accidental
  vault-token leaks if the per-field gate is buggy.

### Option B — rewrite the docs

Move the `gateway/context` reference out of `llms.txt` /
`description_for_model`, replace it with `GET /api/v1/capabilities`
(which already does scope-narrowing correctly) plus
`GET /api/v1/tokens/me/capabilities` (introspection).

- Pro: zero new code surface.
- Pro: the existing scoped manifest is already proven safe by F6.1.
- Con: agents lose the "one-stop bootstrap" UX of `gateway/context`.

### Option C — split into two endpoints

Keep `gateway/context` master-only (rich admin view).
Add `GET /api/v1/agent/context` which returns the scoped subset
(persona + endpoints + memory but no vault, no audit). Update
docs to point agents at the new endpoint.

- Pro: best of both worlds.
- Con: most code; new endpoint + manifest entry + capability test.

## Recommendation

**Option B** for the next release; **Option C** if/when an agent
actually asks for the bundled call. Option A is dispreferred —
scope-dependent response shapes are harder to keep safe than a
new endpoint with a fixed shape.

## Acceptance criteria

- A decision recorded as a new ADR (next free `ADR-NNNN`).
- The L1 test in `agent-discovery-contract.test.js` updated to
  match the new behavior — diff is the sign-off.
- `llms.txt` + `description_for_model` updated so the runbook
  agent walkthrough doesn't print a `FAIL` on §3.d any more.
- `GAP-003` row in `capability-gaps.md` marked `resolved` with a
  link to the ADR and the closing commit.

## Effort

S — half a day for Option B; 1 day for Option C.

## Depends on / Blocks

- Depends on: nothing.
- Blocks: nothing on the M-numbered roadmap.
- Related: `agent-discovery-contract.test.js`, `llms.txt`,
  `src/index.js:6404` and `src/index.js:1801`.
