# Import: a6da498 — feat(tickets): power-user complaint tracking system

- Upstream commit: `omribenami/MyApi-Open@a6da4985` (Subagent on 2026-04-18)
- Files upstream touched: `src/config/database.js` (+19 / -0),
  `src/index.js` (+4 / -0), `App.jsx` (+9 / -0),
  `Layout.jsx` (+3 / -1), `Tickets.jsx` (+390 / -0, NEW),
  `src/routes/tickets.js` (+113 / -0, NEW)
- Follow-on commits in same upstream run (bundle if accepted):
  - `91dd869` — `feat(tickets): add tickets:read and tickets:write
    scopes for guest tokens`
  - `9220522` — `feat(tokens): add Tickets scope section to guest
    token creation UI`
  - `22b0d45` — `feat(tokens): add tickets:read and tickets:write
    to edit token modal`
  - `bc19dfe` — `feat(tickets): add branded email notifications
    for new tickets and status changes`
  - `ef02c3c` — `fix(tickets): add migration to create tickets
    table in production`
- Status: deferred (architectural; requires ADR-0028)
- Decided by: _(awaiting user verdict)_
- Linked ADR: ADR-0028 (`tickets-capability-surface`; mandatory)
- Linked TASKS row: F12 / Group D.3

## 1. What it actually does

New "Tickets" capability surface backed by a dedicated SQLite
table. AI agents can open/update tickets via API; owner manages
them through the frontend with inline status/commit editing.

- `tickets` table with `status` (open/inprogress/closed),
  `source`, `fix_commit`.
- CRUD API at `/api/v1/tickets`, gated by master token +
  `requirePowerUser`.
- React page with stats bar, status filter, inline edits,
  create modal.
- Tickets nav item added to Admin menu (isPowerUser only).

Follow-on commits add: scoped guest-token access (`tickets:read`,
`tickets:write`), token creation/edit UI for those scopes,
branded email notifications, and a production migration script.

## 2. Do we want it?

**Conditional yes — requires ADR-0028 first.**

The capability is genuinely useful (agents file complaints, owner
acts on them) but adds a substantial product surface that doesn't
exist in the fork today. ADR-0028 must decide:
- Is "tickets" the right framing or is it duplicating
  `notifications`?
- Is `requirePowerUser` (a new role concept upstream introduced)
  the right gate, or should it be master-only / RBAC?
- Are the new scopes worth the scope-graph complexity (see F9
  scope-hierarchy-engine)?

## 3. Why we (might) want it?

- Closes capability gap: agents have no clean channel to
  report problems to the operator today (besides
  notifications, which are user-facing not operator-facing).
- Aligned with milestone: F12 / Group D; bundles into M9
  frontend hygiene + F9 scope hierarchy.
- Strategic fit: agent-gateway-thesis — agents need a
  feedback loop with their operator.

## 4. Risks it poses

- **Security risk.** New write surface for guest tokens
  (`tickets:write`) — moderate. Verify input validation
  guards against XSS in the SPA render.
- **Architectural risk (HIGH).**
  - Introduces `requirePowerUser` middleware (new concept;
    not in fork today).
  - Introduces 6 new commits' worth of scope plumbing
    (F9 wants to consolidate scope semantics first).
  - The "Tickets" table is a single-tenant store; multi-
    tenant scoping needed if hosted-product axis ever
    activates.
- **Maintenance risk.** Medium — small ORM-like surface
  in `routes/tickets.js`.
- **Test-baseline risk.** Need full CRUD coverage + scope
  enforcement + email notification.
- **UX risk.** "Tickets" framing collides mentally with
  GitHub Issues. Acceptable.
- **Migration risk.** Need the `ef02c3c` follow-on migration
  in the same release, OR ensure the table is created
  on first call.

## 5. Conflict surface in our fork

- `src/config/database.js` — fork has its own DB config; slot
  the new table create.
- `src/index.js` — clean ADD.
- `src/public/dashboard-app/src/App.jsx` — routing slot.
- `src/public/dashboard-app/src/components/Layout.jsx` — nav
  slot.
- `src/public/dashboard-app/src/pages/Tickets.jsx` — clean
  ADD.
- `src/routes/tickets.js` — clean ADD.
- DEPENDENCY: `requirePowerUser` middleware does NOT exist in
  the fork. Either:
  - import it from upstream (where defined? — verify),
  - or rewrite as `requireMaster` for the initial import and
    revisit when proper RBAC lands (M10 area).

## 6. Test plan for the import (when ADR-0028 lands)

- ADR-0028 written first.
- New test file: `src/tests/tickets-crud.test.js` — full
  POST/GET/PATCH/DELETE coverage with master + scoped tokens.
- New test file: `src/tests/tickets-scope-enforcement.test.js`
  — verify `tickets:read` allows read-only, `tickets:write`
  allows write.
- New test file: `src/tests/tickets-email-notification.test.js`
  — verify branded email fires on status change.
- Source-pin tripwire: optional cardinal "ticket creation
  always writes an audit_log row".
- Snapshot churn: G0.1 API surface needs regen for
  `/api/v1/tickets` endpoints.
- Estimated baseline delta: 71/77/898 → 74/80/918 (+3 suites,
  +20 tests).

## 7. Rollback plan

Multi-file revert across 6 commits if all are imported. The
`tickets` table remains (additive); no data loss. SPA loses
the page; nav item disappears.

## 8. Out of scope for this import

- Multi-tenant scoping of tickets — separate enhancement.
- Custom ticket workflows / states beyond open/inprogress/
  closed — separate feature.
- Linking tickets to Git commits in upstream automatically
  (only the `fix_commit` text field exists; no integration).
- `requirePowerUser` middleware design — handled in ADR-0028.

## ADR-0028 outline (must land FIRST if accepted; mandatory)

- Decision: do we accept the Tickets capability, and how do
  we implement the scope/role gate?
- Options:
  - A: Accept verbatim including `requirePowerUser` middleware
       (closest to upstream).
  - B: Accept but rewrite gate to `requireMaster` for now;
       defer `requirePowerUser` to M10 RBAC work.
  - C: Reject — defer to a separate "operator feedback channel"
       design.
- Recommendation: B (closest to fork's current RBAC posture).
- Bundle: import 6 commits (a6da498 + 5 follow-ons) as 6
  separate single-conventional-commits per ADR-0024 §3.
