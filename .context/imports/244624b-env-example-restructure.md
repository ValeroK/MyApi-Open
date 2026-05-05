# Import: 244624b — docs(.env): comprehensive environment variable documentation

- Upstream commit: `omribenami/MyApi-Open@244624b4` (Subagent on 2026-04-17)
- Files upstream touched: `.env.docker` (+365 / -X), `src/.env.example`
  (+429 / -X) — net +631 / -163
- Status: proposed (likely-reject)
- Decided by: _(awaiting user verdict — recommend reject)_
- Linked ADR: none
- Linked TASKS row: F12 / Group B.5 (verify-promoted)

## 1. What it actually does

Re-organises `src/.env.example` and `.env.docker` into a
category-based layout (Social, Productivity, File Storage,
Support, etc.) with setup URLs per service, descriptions of
what each integration provides, and inline secret-generation
commands.

## 2. Do we want it?

**Conditional reject.** Recommendation: **do not import**.

## 3. Why do we (probably do not) want it?

- The fork's `src/.env.example` has independently evolved into a
  498-line file with a different organisational structure
  (CORE / SECURITY / DATABASE / SESSION / OAUTH / per-service)
  that already covers most of the same ground.
- Critically, the fork's version carries M2-specific framing
  (the `validateRequiredSecrets()` blocklist semantics, the
  `default-vault-key-change-me` story) that upstream's version
  doesn't. Replacing it would lose M2 context.
- Closes capability gap: marginally — both versions cover the
  service-credential discoverability problem; fork's version
  is arguably worse on the per-OAuth-service URL discoverability
  but better on security framing.

## 4. Risks if we import anyway

- **Documentation regression** — losing M2 secret-validation
  framing.
- **Maintenance fork drift** — fork is the canonical version
  for our deployment; merging upstream's structure forces us
  to re-add M2 framing.
- **No security/capability/architectural risk.**

## 5. Conflict surface in our fork

- `src/.env.example` — large textual conflict; would need
  full hand-merge.
- `.env.docker` — file does not exist in the fork (the fork
  uses `.env.smoke.example` for Docker dev/test compose).

## 6. Test plan if accepted

- Verify `src/lib/validate-secrets.js` blocklist still catches
  every banned placeholder in the merged file.
- Verify `src/tests/validate-required-secrets.test.js` source-pin
  tripwires still pass against the new file shape.
- No new tests required.

## 7. Rollback plan

`git revert <import-sha>`. The fork's pre-import `.env.example`
returns. No data loss.

## 8. Out of scope for this import

- Adding a separate doc page that captures upstream's "category +
  per-service URL" framing as an addition (not a replacement).
  This is a valid follow-up if the user wants the docs but not
  the file restructure.
- Touching `connectors/agent-auth/install.py` (related but
  separate concern).

## Recommendation

**Reject.** Open a separate doc-page follow-up if the user wants
upstream's per-service URL discoverability without losing the
fork's M2 framing.
