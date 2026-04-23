# `.context/` — living project memory

This folder is the project's working memory for both humans and AI pair-programmers.
Everything here is **source-controlled** and **canonical**: if something in the code
contradicts a decision here, fix one of them on purpose.

## Layout

```
.context/
├── README.md               ← you are here
├── plan.md                 ← architecture, design, testing, security plan
├── TASKS.md                ← milestone + task tracker (working state)
├── current_state.md        ← short "where are we today" snapshot
├── roadmap.md              ← milestone-level sequence and target dates
├── decisions/              ← Architecture Decision Records (ADRs)
│   ├── TEMPLATE.md
│   ├── ADR-0001-drop-mongodb.md
│   ├── ADR-0002-dual-driver-session-ratelimit.md
│   ├── ADR-0003-adopt-typescript.md
│   ├── ADR-0004-oss-cloud-feature-parity.md
│   ├── ADR-0005-one-shot-vault-migration.md
│   ├── ADR-0006-db-backed-oauth-state.md
│   ├── ADR-0007-clean-rewrite-allowed.md
│   ├── ADR-0008-npm-audit-blocks-high.md
│   ├── ADR-0009-tiered-coverage.md
│   └── ADR-0010-single-codebase-soc2.md
├── tasks/
│   ├── TEMPLATE.md         ← copy this to start a new detailed task brief
│   ├── backlog/            ← briefs not yet in progress
│   ├── in_progress/        ← exactly-one-at-a-time discipline is fine
│   └── completed/          ← archived briefs with outcome notes
└── sessions/
    ├── TEMPLATE.md
    └── YYYY-MM-DD-*.md     ← pairing-session or design-review notes
```

## Read order for a new contributor (or AI)

1. `current_state.md` — 5-minute skim: where we are, what's broken, what's next.
2. `roadmap.md` — milestone sequence and dependencies.
3. `plan.md` — full architecture / security / testing plan. This is the **why**.
4. `TASKS.md` — active execution tracker. This is the **what**.
5. `decisions/` — why we chose X over Y. Consult before revisiting a decision.
6. `sessions/` — last few entries for recent human context.

## Update discipline

- Touch **`TASKS.md` progress counters** every time a task flips status.
- Touch **`current_state.md`** at the start of every new working session or when
  a milestone flips to `Complete`.
- Add an **ADR** before making any non-trivial architectural change.
- Drop a **session note** after a substantial pairing session or decision meeting.
- Never delete history. Mark tasks `[cancelled]` with a reason; archive ADRs as
  `superseded by ADR-XXXX` rather than editing them.

## Related documents outside `.context/`

| Path | Purpose |
|------|---------|
| `CLAUDE.md` (repo root) | Quick reference for AI coding agents on how the codebase is laid out. Keep in sync with `current_state.md`. |
| `SECURITY.md` | Public-facing responsible disclosure + security posture. Updated only when user-visible controls change. |
| `README.md` | Project pitch + quickstart. Not a design doc. |
| `docs/runbooks/` | Operational procedures referenced from `plan.md` §4.5. |
