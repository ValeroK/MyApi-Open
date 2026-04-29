# F9 — Scope hierarchy engine (cluster fix)

> **Status.** Filed 2026-04-28 from F6.7 triage. Closes `GAP-008`
> + `GAP-009` together — they cluster as "the scope engine has
> two callers using slightly different models".

## Context

`CLAUDE.md` documents a hierarchy:

> _"Scope hierarchy for access tokens: `admin:*` > `services:*` >
> `services:{name}:read`."_

The hierarchy is **not implemented**. Two adjacent defects:

### GAP-008 — `hasScope` is strict equality

`hasScope(req, scope)` (`src/index.js:3263-3267`):

```js
function hasScope(req, scope) {
  if (isMaster(req)) return true;
  const tokenScopes = getTokenScopes(req.tokenMeta?.tokenId || '');
  return tokenScopes.includes('admin:*') || tokenScopes.includes(scope);
}
```

The proxy / execute / ask handlers ask for the **broad** scope
(`services:read` / `services:write`). A token granted
`services:google:read` cannot use any of them — the set
`['services:google:read']` does not contain `services:read`.

### GAP-009 — `validateScope` ↔ `grantScopes` self-contradiction

`validateScope` (`src/database.js:1945-1953`) accepts narrow scopes
matching `/^services:[a-z0-9_-]+:(read|write|\*)$/`. The doc
comment says they're "sub-scopes of `services:read`/`services:write`".

But `access_token_scopes.scope_name` has a foreign key onto
`scope_definitions(scope_name)`, and `scope_definitions` only seeds
the broad rows. `grantScopes(tok, ['services:google:read'])` passes
`validateScope` and then **throws** at the FK constraint.

The narrow regex is therefore dead code today — `validateScope`
greenlights what `grantScopes` cannot persist.

## Two consistent options

### Option (a) — drop the narrow form entirely

- Delete the narrow regex in `validateScope` (`src/database.js:1948`).
- Update `CLAUDE.md` to remove the hierarchy claim.
- Document narrow scopes as "not supported".
- Net: every caller now uses broad scopes only, mirroring what
  actually works today.

### Option (b) — implement the hierarchy

- `hasScope(req, narrowOrBroad)` walks the hierarchy:
  given `services:read`, accept `admin:*`, `services:*`,
  `services:read`, OR any `services:<name>:read`.
- Either drop the FK on `access_token_scopes.scope_name` or have
  `grantScopes` synthesize a `scope_definitions` row on first
  grant (preferred — keeps audit + listing surfaces honest).
- Update tests:
  - `services-proxy-behavioral.test.js` GAP-008 characterization
    flips from "narrow → 403" to "narrow → past gate".
  - New positive control: narrow `services:google:read` reads
    Google but cannot read Slack.
- Net: docs become true, narrow scopes work as advertised.

## Recommendation

**Option (b)**, packaged as part of M6 monolith extraction —
the scope engine wants to live in `src/domain/scopes/` where it
can grow tests and a clear API. Until M6, these two tests in
`services-proxy-behavioral.test.js` (GAP-008 characterization)
and the `grantScopes` skip in
`services-proxy-behavioral.test.js`'s narrow-scope seed (GAP-009
characterization) hold the line.

## Acceptance criteria

- ADR ratifying Option (a) or (b).
- If (b): `src/domain/scopes/index.js` (or equivalent) with a
  `matches(grant, requested)` primitive + unit tests covering the
  hierarchy lattice.
- Existing GAP-008 / GAP-009 characterization tests in
  `services-proxy-behavioral.test.js` updated — the failing
  diffs ARE the sign-off.
- `validateScope` and `grantScopes` agree on the same truth.
- `CLAUDE.md` matches reality.

## Effort

M — 1-2 days standalone, less if folded into M6 monolith
extraction (where the scope module wants to live).

## Depends on / Blocks

- Depends on: M6 (monolith extraction) — natural home for the
  module split. Can ship standalone if M6 slips.
- Blocks: F7 (agent-defined connectors will rely on
  `services:<connectorName>:read` scopes — without the hierarchy
  every new connector forces a `scope_definitions` row).
- Related: `agent-real-life.md` runbook (which has to recommend
  broad scopes today because of GAP-008); `agent-walkthrough.mjs`
  Phase 0 sanity check warns about the same footgun.
