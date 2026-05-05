# Import: 1d8cadd — fix(tokens): auto-add skills:read and knowledge scopes for bundle tokens

- Upstream commit: `omribenami/MyApi-Open@1d8cadd5` (Subagent on 2026-04-18)
- Files upstream touched: `src/index.js` (+11 / -0)
- Status: proposed
- Decided by: _(awaiting user verdict)_
- Linked ADR: none
- Linked TASKS row: F12 / Group A.2

## 1. What it actually does

When creating a guest token with a `scope_bundle` containing a
`persona_id`, the token-create handler now inspects the persona's
attached skills and KB documents and **auto-grants** `skills:read`
(if the persona has skills) and/or `knowledge` (if it has KB docs)
without requiring the operator to remember to add them manually.

## 2. Do we want it?

**Yes (UX-quality fix, no architectural change).**

## 3. Why do we want it?

- Closes capability gap: matches the fork's
  `src/scripts/mint-agent-token.js` workflow — minting a bundle
  token without these scopes today produces a confusing 403 when
  the agent tries to use the persona's skills/KB.
- Aligned with milestone: F12 / Group A.
- Strategic fit: agent-gateway-thesis — bundle tokens exist
  precisely so an agent can pick up a persona and use its skills.
  Forgetting to grant `skills:read` defeats that purpose.

## 4. Risks it poses

- **Security risk.** Auto-granting scopes is generally
  scope-creep-prone, but here both `skills:read` and `knowledge`
  are read-only, and the operator already opted into the persona
  by attaching it to the token via `scope_bundle.persona_id`.
  Acceptable.
- **Architectural risk.** Low. The hunk lives in the token-create
  handler in `src/index.js`; M6 monolith extraction will need to
  re-anchor it.
- **Maintenance risk.** Low.
- **Test-baseline risk.** Need a new test to lock the behaviour.
- **UX risk.** Tokens may end up with broader scope than the
  operator typed. Mitigated by surfacing the auto-added scopes in
  the create-token response (verify upstream does this).
- **Migration risk.** None — only affects new tokens.

## 5. Conflict surface in our fork

- `src/index.js` — token-create handler. Need to confirm the
  fork's handler shape matches upstream's around the same line
  region (M3/F4 may have rewired token creation).
- `getPersonaSkills` / `getPersonaDocuments` (or equivalents)
  must exist in `src/database.js` — verify before merging.

## 6. Test plan for the import

- New test file: `src/tests/bundle-token-auto-scopes.test.js`
  (supertest-driven; create persona with skills → mint bundle
  token → assert `scopes` includes `skills:read`).
- Source-pin tripwire: none (this is a UX fix, not a security
  invariant).
- Snapshot churn: low (G0.x snapshots may need regen if the
  handler region drifts).
- Estimated baseline delta: 71/77/898 → 72/78/901 (+1 suite,
  +3 tests).

## 7. Rollback plan

Single hunk in `src/index.js`; revert with `git revert
<import-sha>`. Existing tokens are unaffected (auto-add only runs
on new token creation).

## 8. Out of scope for this import

- Retroactive scope-adding for existing bundle tokens.
- Auto-removing scopes when a persona's skills/docs are detached
  later.
- Surfacing the auto-add behaviour in the dashboard's
  AccessTokens UI (separate UX task).
