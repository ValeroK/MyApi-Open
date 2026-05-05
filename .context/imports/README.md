# `.context/imports/` — upstream-import mini-plans

> Per ADR-0024 (`upstream-import-policy`). This folder is the
> source of truth for every accepted, deferred, rejected, or merged
> upstream backport from `omribenami/MyApi-Open`.

## What lives here

- One `<short-hash>-<slug>.md` per upstream commit considered for
  import. The 7-character short hash is taken from `git log`.
- One `.verify-pass-<date>.md` record per audit batch. These are
  the per-row verdicts on whether an upstream commit's hunks are
  already present in the fork.
- One `.audit-last-run.md` log appended to by
  `node scripts/upstream-audit.mjs --write-status`.
- This `README.md` (the navigational index).

## How to read this folder

1. Start with the **per-batch index table** below to see every
   mini-plan's status at a glance.
2. Open the mini-plan for any candidate to read its 8-section
   detail (see ADR-0024 §2 for the template).
3. To regenerate the candidate matrix from upstream history:
   `node scripts/upstream-audit.mjs` (human-readable) or
   `node scripts/upstream-audit.mjs --json` (machine-readable).
4. To see which mini-plans currently exist on disk and their
   parsed status: read this index, then re-validate by opening
   each mini-plan's `Status:` line.

## Status legend (mini-plan `Status:` field)

- `proposed`  — written, awaiting user verdict
- `accepted`  — verdict received, queued for cherry-pick
- `merged`    — landed on `main`; row exists in `M-import` milestone
- `deferred`  — waiting on a follow-up ADR or external decision
- `rejected`  — explicitly out of scope; will not be imported
- `verify-fail` — post-verify, hunk already present; no work needed

## Batch 1 — F12 / 2026-05 (this batch)

Source: `.context/tasks/backlog/F12-upstream-import-2026-05.md`.
Workflow: ADR-0024.

### Group A — Strong candidates (8)

| File | Hash | Subject | Status |
|------|------|---------|--------|
| `b8a074b-dependabot-github-actions.md` | b8a074b | ci: add Dependabot for automatic GitHub Actions version updates | proposed |
| `1d8cadd-bundle-token-auto-scopes.md` | 1d8cadd | fix(tokens): auto-add `skills:read` and `knowledge` scopes for bundle tokens | proposed |
| `c9cc8cb-oauth-lan-ip-callback.md` | c9cc8cb | fix(oauth): allow LAN IP callbacks for myapi-agent client | proposed |
| `ebdd006-frontend-master-token-localstorage.md` | ebdd006 | fix(security): remediate audit findings across auth, encryption, and frontend (master-token localStorage cleanup) | proposed |
| `99f864d-new-device-email-alert.md` | 99f864d | feat(security): email alert when new device attempts OAuth token use | proposed |
| `d84fd51-gateway-connected-services-instructions.md` | d84fd51 | feat(gateway): add `connected_services` with per-service AI instructions | proposed |
| `3b517de-skills-ai-first-improvements.md` | 3b517de | feat(skills): AI-first API improvements for agent efficiency | proposed |
| `5921232-discord-per-user-bot-token.md` | 5921232 | fix(discord): per-user bot token for guild/channel proxy access | proposed |

### Group B — Verify-pass-promoted (6 of 10; 4 already-present)

| File | Hash | Subject | Status |
|------|------|---------|--------|
| `244624b-env-example-restructure.md` | 244624b | docs(.env): comprehensive environment variable documentation | proposed (likely-reject) |
| `669d30f-multi-fix-bundle.md` | 669d30f | fix(security): patch critical and high severity vulnerabilities | proposed (narrow: 2 hunks) |
| `735ae9a-92-cvss-omnibus.md` | 735ae9a | security: Remediate 92 CVSS findings | deferred |
| `e500414-setinterval-unref.md` | e500414 | fix(tests): unref module-level `setInterval`s | proposed |
| `d302595-remove-token-eye-button.md` | d302595 | fix(tokens): remove eye/reveal button, enforce show-once | proposed |
| `9cd414a-red-security-alert-card.md` | 9cd414a | fix(dashboard): show red security alert card | deferred (depends on e0707c5 / ADR-0026) |

The other 4 Group B candidates (a070466, b5c2359, 780c05d, 134def1)
are already present in the fork — see
`.verify-pass-2026-05-04.md` for evidence. No mini-plan written
per the verify-pass anti-duplication rule.

### Group C — Architectural (2; both deferred)

| File | Hash | Subject | Required ADR | Status |
|------|------|---------|--------------|--------|
| `52dd343-gmail-write-surface.md` | 52dd343 | feat(gmail): add send and trash endpoints, upgrade to `gmail.modify` scope | ADR-0025 | deferred |
| `e0707c5-token-anomaly-detection.md` | e0707c5 | feat(security): token anomaly detection, suspension, re-approval flow | ADR-0026 | deferred |

### Group D — Capability (5)

| File | Hash | Subject | Required ADR | Status |
|------|------|---------|--------------|--------|
| `2c6aca8-onboarding-fullpage-wizard.md` | 2c6aca8 | feat(onboarding): replace modal with full-page wizard + OAuth signup flow | none | proposed |
| `6ab11cb-admin-broadcast.md` | 6ab11cb | feat(admin): broadcast notification + dedicated Broadcast page | ADR-0027 | deferred |
| `a6da498-tickets-system.md` | a6da498 | feat(tickets): power-user complaint tracking system (+ 5 follow-on commits) | ADR-0028 | deferred |
| `f5297d5-beta-mode.md` | f5297d5 | feat(beta): BETA mode toggle with user cap, waitlist, launch flow | ADR-0029 | deferred |
| `2eb8439-service-conn-disconn-emails.md` | 2eb8439 | feat(email): service connected/disconnected emails | none | proposed |

## Quick reference

- **Audit script.** `scripts/upstream-audit.mjs` (read-only).
- **Workflow & rules.** `.context/decisions/ADR-0024-upstream-import-policy.md`.
- **Parent task.** `.context/tasks/backlog/F12-upstream-import-2026-05.md`.
- **Milestone tracker.** `.context/TASKS.md` → `M-import` (merged-only counter).
- **Verify-pass record.** `.context/imports/.verify-pass-2026-05-04.md`.
- **Release rollover target.** `v0.7.0` per ADR-0023, when `[Unreleased]` reaches ~10 entries or 2 weeks pass.

## How to add a new mini-plan

```bash
# 1. Identify a candidate from the audit:
node scripts/upstream-audit.mjs

# 2. Copy the 8-section template from ADR-0024 §2 into
#    .context/imports/<short-hash>-<slug>.md

# 3. Fill in sections 1–8 from `git show <hash>` + a quick fork
#    cross-check (Grep / Read).

# 4. Set Status: proposed and add a row to this README's index +
#    the F12 candidate matrix.

# 5. Tag the user for accept / defer / reject.
```

## Hard rules (non-negotiable; from ADR-0024 §3)

- One upstream commit per cherry-pick.
- Never carry over upstream's `Co-Authored-By: Subagent` /
  `Co-Authored-By: Claude *` trailers.
- Never delete a fork-only `src/lib/*`, `src/domain/*`, or
  `src/tests/*` file just because the cherry-pick wants a
  different layout. Extend, don't replace.
- Never silence or `.skip` an existing test to make a cherry-pick
  pass.
- Never reintroduce a symbol named in `oauth-state-inventory`,
  `legacy-vault-inventory`, `default-vault-key-removed`, or
  `validate-required-secrets` (the M2/M3 source-pin tripwires).
- The test gate (71/77 suites, 898 tests, 28/28 snapshots, exit 0)
  is a ratchet — never lower.
- Direct-to-main commits are the default delivery mode (PRs
  opt-in per import).
- Architectural imports require their ADR in the SAME commit.
- `CHANGELOG.md` `[Unreleased]` is updated on every merged import.
