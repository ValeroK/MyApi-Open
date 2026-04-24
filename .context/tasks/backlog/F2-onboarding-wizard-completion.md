# Task brief — Decide + ship the onboarding wizard (or retire it)

## Identity

- **ID.** `TBD` (to be assigned as `T9.x` when M9 opens; parked as follow-up
  `F2`).
- **Title.** The onboarding-wizard surface is half-wired. Either complete the
  feature or remove the partial implementation.
- **Milestone.** M9 — Frontend & output hygiene.
- **Plan reference.** N/A (not in §6.3 risks — this is a product-UX gap
  surfaced by the M3 live smoke, carried on `onboardingUtils.js`).
- **Workstream.** WS-frontend.

## Status

- **State.** backlog (follow-up from M3 live smoke)
- **Assignee.** anyone
- **Started.** —
- **Target done.** Opportunistic; bundle with M9.
- **Actually done.** —

## Why (1-paragraph context)

During the M3 live-smoke on 2026-04-24 the frontend `vite build` failed
inside the Docker smoke container with
`"dismissModal" is not exported by "src/utils/onboardingUtils.js"`. The
broader picture: `App.jsx` / `Settings.jsx` / `Dashboard.jsx` /
`OnboardingModal.jsx` import eight onboarding helpers
(`dismissModal`, `wasModalDismissed`, `requestOnboardingModal`,
`restartOnboarding`, `isOnboardingActive`, `wasChecklistDismissed`,
`dismissChecklist`, `completeOnboarding`) from `onboardingUtils.js`, but the
module only exported `wasOnboardingDismissed`. The M3 wrap-up commit stubbed
those helpers as localStorage-backed no-ops that keep onboarding permanently
inert, purely to unblock the smoke build. **The stubs are technical debt:
there is a real onboarding wizard UI on disk that currently never fires.**
The operator also hit "Complete your profile" during smoke login — the
`needsOnboarding=true` flag on the signup-mode user row triggers a gated UI
that the stubs neither drive nor clear.

## What (scope + explicit non-goals)

- In scope:
  - A product-level decision: **ship the wizard** or **retire the partial
    UI** (`OnboardingModal.jsx`, onboarding checklist, `needsOnboarding`
    flag on the users row, the half-wired modal-requested key).
  - If ship: wire the stubs to real state (session-store or DB-backed), add
    a real "Complete your profile" flow that moves `needsOnboarding`
    `true → false` on submit.
  - If retire: delete `OnboardingModal.jsx`, the checklist, every stub in
    `onboardingUtils.js`, and the `needsOnboarding` flag column + its
    gating. Add a migration that backfills it to `false`.
- Out of scope:
  - The SPA routing race that makes the onboarding screen look like it's
    popping up twice — that's `F1`.
  - Any server-side signup-mode change beyond the `needsOnboarding` flag
    itself.
- Non-goals:
  - Redesigning the dashboard home experience.

## How (implementation plan)

1. Product decision (one-line answer to "do we want an onboarding wizard at
   all?"). Record in an ADR.
2. If retire:
   - Delete `src/public/dashboard-app/src/components/OnboardingModal.jsx`
     and the checklist component(s).
   - Delete every stub added to
     `src/public/dashboard-app/src/utils/onboardingUtils.js` during the M3
     smoke wrap-up.
   - Drop `needsOnboarding` from the `users` table (additive migration:
     `ALTER TABLE users DROP COLUMN needsOnboarding` — better-sqlite3
     supports this on recent SQLite versions; otherwise add the column to a
     phased migration).
   - Remove every `isOnboardingActive()` / `needsOnboarding` check from
     `App.jsx`, `Settings.jsx`, `Dashboard.jsx`.
3. If ship:
   - Wire the stubs to a real backing store (DB-backed via a new `POST
     /api/v1/user/onboarding` endpoint; localStorage is not enough — it
     breaks cross-device).
   - Add the "Complete your profile" form: display-name, timezone, at
     minimum. Submit flips `needsOnboarding → false`.
   - Make the modal actually render in the happy-path first-login flow
     instead of being permanently inert.
   - Add Vitest + RTL tests for the modal state machine.
4. Either way: remove the "this is a stub" comment block from
   `onboardingUtils.js`.

## Dependencies

- Depends on: —
- Blocks: —

## Testing

- Unit tests to add: Vitest + RTL for `OnboardingModal.jsx` state machine
  (if shipping), or a deletion-gate test (if retiring — assert the imports
  are gone from `App.jsx` etc.).
- Integration tests to add: If shipping, an end-to-end signup → "Complete
  your profile" → `needsOnboarding=false` Jest supertest flow.
- Security regression tests (§5.4 of `plan.md`): none — this is UX.
- Manual verification steps: signup via Google as a brand-new account;
  observe either (retire) straight-to-dashboard or (ship) the wizard.

## Risks & rollback

- What breaks if this ships wrong? If shipping a real wizard and the
  backing store fails to persist, every login re-shows the wizard — noisy
  but not dangerous.
- How do we roll back? Revert the single PR.
- What should we watch in logs/metrics for 24h after? The
  `/api/v1/user/onboarding` endpoint (if shipping) — 4xx rate, latency.

## Artifacts

- ADR(s): probably one — decision to ship vs. retire the wizard.
- Related session notes: `../sessions/2026-04-24-m3-smoke.md`.

## Outcome (fill in when completing)

- Summary of what actually landed: …
- Deviation from plan and why: …
- Follow-ups created (new task IDs): …
- Lessons learned: …
