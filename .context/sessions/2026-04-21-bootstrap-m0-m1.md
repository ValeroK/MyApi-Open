# Session — 2026-04-21 — Bootstrap `.context/`, land M0 + most of M1

- **Date.** 2026-04-21
- **Participants.** repo owner + AI pairing (Claude/Cursor)
- **Duration.** ~1 session
- **Related work.** `TASKS.md` M0, M1; `plan.md` §§0.1, 9; ADRs 0001–0010

## Goal

Move the planning docs into their permanent home under `.context/`, scaffold
the folder the user rules expect, and push through as much of Milestones M0
(foundations) and M1 (critical security deletions) as possible in one pass.

## Summary

1. Created `.context/` with `decisions/`, `tasks/{backlog,in_progress,completed}/`,
   `sessions/`, and moved `plan.md` + `TASKS.md` into it.
2. Seeded `current_state.md`, `roadmap.md`, and `README.md` for the folder.
3. Wrote `TEMPLATE.md` for tasks, decisions, and sessions.
4. Authored 10 ADRs (one per ratified OQ in `plan.md` §0.1).
5. Added `.cursor/rules/context-folder.mdc` so future agent sessions
   auto-load this folder and keep it current.
6. Landed backend lint + type-check scaffolding:
   `eslint.config.js`, `tsconfig.json`, `.editorconfig`, `.prettierrc.json`,
   `.prettierignore`, new `package.json` scripts + devDeps.
7. Landed CI updates in `.github/workflows/ci.yml`: new `lint-backend`,
   `lint-frontend`, `typecheck` jobs; removed `|| true` from the security
   audit job; Docker build now waits on lint + typecheck.
8. Added `.github/CODEOWNERS` and a `.github/pull_request_template.md` with
   security + `.context/` checklists.
9. **M1 deletions:** cut the three Turso endpoints and the `turso-import.html`
   UI; removed the `REMOVED_CLIENT_ID` / `REMOVED_SECRET` Google OAuth
   fallbacks; changed `google.enabled` to be computed from env presence.
10. Added `src/tests/security-regression.test.js` with two live suites
    (Turso gone, Google OAuth fallbacks gone) and three skipped stubs for
    the M3/M5/M9 cases enumerated in `plan.md` §5.4.
11. Updated `TASKS.md` progress counters: M0 is 9/9, M1 is 5/7 (T1.6 blocked,
    T1.7 partially a no-op). Global: 14/120.

## Key decisions (all pre-existing in `plan.md`; no new ADRs this session)

- Ratified ADR-0003 scope: `tsconfig.json` stays in `checkJs` mode repo-wide;
  `exactOptionalPropertyTypes` is **off** at the repo level and enabled
  per-file in new `src/domain/**` TS modules as they are created.
- Confirmed ADR-0008: CI security job now genuinely fails at HIGH+. If a
  transitive dep lands a HIGH and no upgrade is available, we file a dated
  suppression note (per ADR-0008 "Decision" section).

## Action items

| Owner | Action | Target | Task ID |
|-------|--------|--------|---------|
| repo owner | Run `npm install` to pull new devDeps | next session | — |
| repo owner | Run `gitleaks detect --log-opts="--all"`; rotate any exposed provider credentials and file an ADR | before first public release | T1.6 |
| repo owner | Rotate Google OAuth client secret at the provider (paired with T1.6) | before first public release | T1.4/T1.6 |
| AI / next session | Start M2 — inspect the nested `src/package.json` that pulls `crypto-js`, plan the one-shot vault migration | next session | T2.1, T2.2 |

## Open questions raised

- **Why is there a nested `src/package.json` + lockfile?** It is the only
  thing pulling `crypto-js` into the repo. Understanding this before M2 avoids
  a migration that silently re-introduces the broken path. Promote to the
  open-questions list if unresolved after the first M2 pass.
- **Do tests currently pass?** Existing `src/tests/*.test.js` require
  `src/index`. Some tests hit routes at fixed line numbers. Run `npm test`
  once the lint config is vetted locally to establish the M0 baseline.
- **Any hidden `fetch(...)` call sites?** A quick ripgrep during M5 will
  count the sites we need to migrate onto `SafeHTTPClient`.

## Artifacts

- PRs: TBD (this batch is a single PR; prep via `pr-prep` skill when owner
  is ready).
- Files written: see `TASKS.md` M0/M1 rows for exact paths.
- No external fetches made.
