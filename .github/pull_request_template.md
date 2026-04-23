<!--
  Thanks for the PR! Fill in the sections below. Keep it terse.

  MyApi is a secrets custodian — every change touches trust in some way,
  even when it doesn't look security-relevant. The checklist is not paperwork;
  it's the reason we don't leak anyone's tokens.

  For task-level context, link to `.context/TASKS.md` (e.g. `T2.4`) and to
  any ADR under `.context/decisions/` that this PR depends on.
-->

## Summary

<!-- 1–3 sentences: what changed, why. -->

## Linked task(s) / ADR(s)

- `.context/TASKS.md`: T…
- `.context/decisions/`: ADR-… (if applicable)

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (requires migration / CHANGELOG entry)
- [ ] Refactor / code health (no behavior change)
- [ ] Security fix or hardening
- [ ] Documentation / `.context/` update only
- [ ] Build / CI / dependency update

## Security checklist

- [ ] No secrets, private keys, tokens, or production URLs in the diff.
- [ ] No new outbound HTTP call outside `src/infra/http/` (or: justified below).
- [ ] No new `fetch`, `https.request`, or `axios.*` outside `src/infra/http/`
      (or: justified below).
- [ ] No new `eval`, `Function(...)`, `child_process` without an explicit note.
- [ ] Any new OAuth scopes / RBAC roles / token scopes are documented
      (`src/middleware/scope-validator.js` + relevant ADR).
- [ ] Any new encryption usage goes through `src/lib/encryption.js` /
      `src/infra/crypto/` only. No new `crypto-js`, no raw `createCipher`.
- [ ] Any new SQL with dynamic identifiers (`table`, `column`) uses
      `validateSqlIdentifier()` (once introduced in M10) or is on an allow-list.
- [ ] New routes declare required scope + RBAC role + rate-limit class.
- [ ] Logs and Sentry events do not leak `authorization`, `code`, `state`,
      `refresh_token`, `client_secret`, or password fields.
- [ ] `.env.example` updated if a new env var was introduced.

## Testing

- [ ] `npm run lint:backend` passes locally.
- [ ] `npm run lint:frontend` passes locally (if frontend changed).
- [ ] `npm run typecheck` passes locally.
- [ ] `npm test` passes locally.
- [ ] New code has unit or integration tests.
- [ ] Security-relevant changes have a regression test added to
      `src/tests/security-regression.test.js`.

## `.context/` updates

- [ ] Task(s) flipped to `[x]` in `.context/TASKS.md` and milestone progress
      bumped.
- [ ] `.context/current_state.md` §5 ("What changed recently") updated if the
      change is user-visible or architectural.
- [ ] New ADR filed under `.context/decisions/` if a non-trivial design
      decision was made.

## How to verify

<!-- Short manual test plan + relevant CLI commands. -->

## Rollback plan

<!-- How does an operator revert this? `git revert <sha>`? DB migration down?
     Feature flag off? -->
