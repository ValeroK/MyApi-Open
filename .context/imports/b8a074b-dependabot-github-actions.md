# Import: b8a074b — ci: add Dependabot for automatic GitHub Actions version updates

- Upstream commit: `omribenami/MyApi-Open@b8a074bc` (Subagent on 2026-04-18)
- Files upstream touched: `.github/dependabot.yml` (+8 / -0)
- Status: proposed
- Decided by: _(awaiting user verdict)_
- Linked ADR: none
- Linked TASKS row: F12 / Group A.1

## 1. What it actually does

Adds an 8-line Dependabot config that polls weekly for GitHub Actions
version bumps (e.g. `actions/checkout@v4 → v5`,
`docker/build-push-action@v5 → v6`) and opens automatic PRs.

## 2. Do we want it?

**Yes (low-risk, high-leverage).**

## 3. Why do we want it?

- Closes capability gap: none documented, but matches ADR-0023's
  promise that the release pipeline stays current.
- Aligned with milestone: F12 / Group A; no architectural impact.
- Strategic fit: keeps the release pipeline (`release.yml`,
  `ci.yml`, `deploy.yml`) on supported action versions without
  manual operator burden — matches the fork's "small ops surface"
  principle.

## 4. Risks it poses

- **Security risk.** Negligible. Dependabot opens PRs, not direct
  pushes; we still review them.
- **Architectural risk.** None — single config file, no app code
  affected.
- **Maintenance risk.** Low — generates ~1-2 PRs per week. If
  noisy, can be tuned to monthly.
- **Test-baseline risk.** Zero — no source code touched.
- **UX risk.** None.
- **Migration risk.** None.
- **Indirect risk.** A Dependabot PR could itself break CI if a
  major-version bump is incompatible. Mitigated by running the
  test gate on every PR per ADR-0023.

## 5. Conflict surface in our fork

- `.github/dependabot.yml` — file does not exist in the fork.
  Clean add.

## 6. Test plan for the import

- New test file(s): none.
- Source-pin tripwire: none.
- Snapshot churn expected: none.
- Estimated baseline delta: 71/77/898 → 71/77/898 (unchanged).
- Verification: after merge, confirm Dependabot opens a PR within
  7 days (manual check on GitHub).

## 7. Rollback plan

`git revert <import-sha>` removes `.github/dependabot.yml`.
Dependabot stops opening PRs immediately on next poll.

## 8. Out of scope for this import

- npm dependency updates (Dependabot can also do `package.json`
  but upstream's commit is GitHub-Actions-only — keep that scope).
- Auto-merge of Dependabot PRs (manual review per PR is the
  fork's policy until a second maintainer joins).
