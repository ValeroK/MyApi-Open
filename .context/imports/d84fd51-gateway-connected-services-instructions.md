# Import: d84fd51 — feat(gateway): add connected_services with per-service AI instructions

- Upstream commit: `omribenami/MyApi-Open@d84fd51d` (Subagent on 2026-04-18)
- Files upstream touched: `src/index.js` (+112 / -0)
- Status: proposed
- Decided by: _(awaiting user verdict)_
- Linked ADR: none (but relates to F8 — `gateway-context-vs-llms-txt-mismatch`)
- Linked TASKS row: F12 / Group A.6

## 1. What it actually does

`GET /api/v1/gateway/context` now returns a new `connected_services`
array listing only the services the operator has actually
connected. Each entry includes:

- Exact proxy paths the agent should use.
- Usage notes per service (rate limits, scope hints, gotchas).
- Example actions (method + path + sample body).
- Discord includes guild/channel/message paths with an
  `auth_note` explaining the per-service bot-token switching
  introduced by `5921232`.

## 2. Do we want it?

**Yes — strong agent-gateway-thesis fit.**

## 3. Why do we want it?

- Closes capability gap: GAP-003 (`gateway-context-vs-llms-txt-mismatch`,
  see F8 brief). Today the gateway/context payload is thin and
  agents fall back to `/openapi.json` and `/llms.txt` — which
  describe the *whole* surface, not just what's available to
  THIS token. `connected_services` gives an agent a
  least-privilege, ready-to-use action list.
- Aligned with milestone: F12 / Group A. Closes (or at least
  significantly narrows) F8.
- Strategic fit: this IS the agent-gateway thesis — the gateway
  is supposed to give an agent everything it needs to act, in
  one place, scoped to what it can actually do.

## 4. Risks it poses

- **Security risk.** The connected_services list reveals which
  services the operator has connected. This is information the
  bearer of the token already has access to (they can call
  `/api/v1/services/<name>/proxy/...` and discover by 200 vs 404).
  Net-zero security delta.
- **Architectural risk.** Medium. 112 LOC of mostly-static
  `actions:` arrays per service that drift if upstream APIs
  change. Acceptable trade-off — the upstream maintenance
  burden has been visible (e.g. `52dd343` Gmail send/trash).
- **Maintenance risk.** Same as above — service catalogues
  always need maintenance.
- **Test-baseline risk.** Need behavioural tests asserting
  `connected_services` reflects the operator's actual
  `oauth_tokens` rows.
- **UX risk.** None.
- **Migration risk.** None — additive field.

## 5. Conflict surface in our fork

- `src/index.js` — `/api/v1/gateway/context` handler. Need to
  compare upstream's exact action arrays against the fork's
  current `actions:` lists at lines 6545+ (Google) and 6585+
  (Twitter) — the fork already has SOME action arrays, but they
  may differ from upstream's wording.
- Downstream: F8 brief should be updated/closed as part of this
  import.

## 6. Test plan for the import

- New test file: `src/tests/gateway-context-connected-services.test.js`
  - With zero connected services → empty array.
  - With Google + Discord connected → both surface in array
    with correct proxy_note + actions count.
  - With a service connected but the token lacking the relevant
    `services:<name>:read` scope → that service is filtered out.
  - The actions list is byte-stable for Google over multiple
    calls (canary against accidental drift).
- Source-pin tripwire: none — content drift is expected.
- Snapshot churn: G0.x snapshots that pin `gateway/context`
  payload shape will need regen.
- Estimated baseline delta: 71/77/898 → 72/78/902 (+1 suite,
  +4 tests).

## 7. Rollback plan

Single-handler revert. Agents fall back to `openapi.json` /
`llms.txt` discovery. No data loss.

## 8. Out of scope for this import

- Updating F8 to closed status — handled in the same commit's
  `current_state.md` update.
- Per-skill `actions:` pages (different surface; that's the
  Skills brief work).
- Removing the existing `actions:` arrays at
  `src/index.js:6545+` (the `connected_services` array
  intentionally complements rather than replaces them).
