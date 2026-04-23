# Task brief — <short imperative title>

> Copy this file into `.context/tasks/backlog/<NNN>-<slug>.md` when you want to
> track a task at more detail than a row in `TASKS.md`. Move it between
> `backlog/`, `in_progress/`, and `completed/` as its status changes.

## Identity

- **ID.** T<milestone>.<index> (e.g. `T2.4`) — must match `TASKS.md`.
- **Title.** <one-line imperative>
- **Milestone.** M<milestone> — <milestone title>
- **Plan reference.** [`plan.md` §N.M](../../plan.md#...)
- **Workstream.** WS-<n>

## Status

- **State.** backlog / in_progress / blocked / review / completed / cancelled
- **Assignee.** <@handle or "anyone">
- **Started.** YYYY-MM-DD
- **Target done.** YYYY-MM-DD
- **Actually done.** YYYY-MM-DD

## Why (1-paragraph context)

What real-world problem is this task solving? Which risk from `plan.md` §6.3
does it close? Which user-visible behavior does it preserve/change?

## What (scope + explicit non-goals)

- In scope: …
- Out of scope: …
- Non-goals: …

## How (implementation plan)

1. …
2. …
3. …

## Dependencies

- Depends on: `T…`, `T…`
- Blocks: `T…`

## Testing

- Unit tests to add: …
- Integration tests to add: …
- Security regression tests (§5.4 of `plan.md`): …
- Manual verification steps: …

## Risks & rollback

- What breaks if this ships wrong?
- How do we roll back? (revert PR? run a reverse migration?)
- What should we watch in logs/metrics for 24 h after?

## Artifacts

- PR: #…
- ADR(s): `../decisions/ADR-NNNN-...md`
- Related session notes: `../sessions/YYYY-MM-DD-…md`

## Outcome (fill in when completing)

- Summary of what actually landed:
- Deviation from plan and why:
- Follow-ups created (new task IDs):
- Lessons learned:
