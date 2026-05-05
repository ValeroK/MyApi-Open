# Import: 3b517de — feat(skills): AI-first API improvements for agent efficiency

- Upstream commit: `omribenami/MyApi-Open@3b517de3` (Subagent on 2026-04-14)
- Files upstream touched: `src/database.js` (+71 / -X),
  `src/index.js` (+116 / -X), `src/routes/skills.js` (+244 / -X)
  — net +388 / -43
- Status: proposed
- Decided by: _(awaiting user verdict)_
- Linked ADR: none (but ties to F9 scope-hierarchy work)
- Linked TASKS row: F12 / Group A.7

## 1. What it actually does

Major UX upgrade to the `/skills/*` surface for agents:

- Server-side filtering on list (`?slug`, `?category`, `?q`,
  `?limit`) — avoids 900KB full-payload dumps for single-skill
  lookups.
- New `GET /skills/_by_slug/:slug` (no numeric ID needed).
- New `GET /skills/_batch?id=&slug=` (multi-fetch in one call).
- New `GET /skills/suggestions?q=` (fuzzy discovery).
- New `GET /skills/:id/content` (clean content endpoint —
  JSON or `text/markdown`).
- YAML frontmatter auto-sanitised on create/update (arrows,
  colons, control chars).
- All 4xx responses include a `_hint` block (docs, capabilities,
  quickStart, scopeHelp).
- 403 responses include capabilities pointer for self-introspection.
- Empty list/suggestion results include a `_discovery` block
  with next-step endpoints.
- OpenAPI + `llms.txt` updated.

## 2. Do we want it?

**Yes — major agent-UX upgrade with no architectural cost.**

## 3. Why do we want it?

- Closes capability gap: matches `F9` (scope-hierarchy engine)
  context — `_hint` blocks help agents discover their own scopes.
- Closes capability gap: 900KB list-payload dumps are a real
  performance issue surfaced in the F6 walkthrough.
- Aligned with milestone: F12 / Group A; biggest single
  capability uplift in the strong-candidates list.
- Strategic fit: textbook agent-gateway-thesis — agents that
  can discover, filter, and self-introspect work better than
  agents that have to grep through a 900KB JSON dump.

## 4. Risks it poses

- **Security risk.** New endpoints need scope-validation hooks.
  The `_hint` block must NOT include scope details an
  unauthenticated caller shouldn't see (e.g. presence of
  master-only endpoints). Verify upstream redacts appropriately.
- **Architectural risk.** Medium-high. Adds substantial new
  code surface to `src/routes/skills.js` (+244 LOC) and
  `src/database.js` (+71 LOC). M6 monolith extraction will
  need to re-anchor.
- **Maintenance risk.** Medium — fuzzy-search needs index
  maintenance.
- **Test-baseline risk.** The fork's existing skills tests
  may need substantial extension; need to confirm no test
  asserts the OLD behaviour (full-payload listing).
- **UX risk.** Backward-compat for agents that rely on the
  full-payload list — mitigated because `?limit` is opt-in
  and the default still returns all skills (just now with
  optional filtering).
- **Migration risk.** No DB migration. Index for fuzzy search
  may need to be created lazily on first query.

## 5. Conflict surface in our fork

- `src/database.js` — the fork has its own evolved skills CRUD;
  cross-check upstream's added 71 LOC against the fork's shape
  before merging. Hunks may need to be rewritten to fit.
- `src/index.js` — OpenAPI block at line 4188+ needs the new
  endpoints documented; align with upstream's spec.
- `src/routes/skills.js` — biggest conflict surface. The fork's
  `routes/skills.js` exists; need a side-by-side reconciliation
  pass.
- `llms.txt` (or its dynamic generator in `src/index.js`) needs
  the new endpoints added.

## 6. Test plan for the import

- New test file: `src/tests/skills-ai-first-endpoints.test.js`
  - List with no filter: returns the same N rows as before.
  - List with `?slug=foo`: returns just the matching row.
  - `_by_slug/foo`: same shape as `:id`.
  - `_batch?slug=a&slug=b`: returns both in one round-trip.
  - `suggestions?q=fo`: fuzzy-match returns 'foo'.
  - `:id/content` with `Accept: text/markdown`: returns raw
    markdown with correct content-type.
  - YAML frontmatter sanitisation: posting a skill with `---\n
    foo: > bad`\nbar:: control` returns a saved skill with
    sanitised frontmatter.
- Source-pin tripwire: none — content surface is intentionally
  flexible.
- Snapshot churn: G0.1 (API surface) snapshot will need regen
  for the new endpoints.
- Estimated baseline delta: 71/77/898 → 72/78/910 (+1 suite,
  +12 tests).

## 7. Rollback plan

Three-file revert. Agents lose new endpoints but retain the
existing `/skills/:id` and `/skills` list surface unchanged.

## 8. Out of scope for this import

- Server-side ranking of `suggestions` results (today fuzzy is
  literal; ranking is a future task).
- Pagination on the `/skills` list (this commit doesn't add it
  — separate concern).
- Cache layer in front of `/skills/:id/content` (separate
  performance task).
