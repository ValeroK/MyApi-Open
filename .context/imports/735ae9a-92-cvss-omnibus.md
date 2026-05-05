# Import: 735ae9a — security: Remediate 92 CVSS findings across CRITICAL/HIGH/MEDIUM severity

- Upstream commit: `omribenami/MyApi-Open@735ae9a9` (Subagent on 2026-04-13)
- Files upstream touched: ~30 files (full omnibus security pass)
- Status: deferred
- Decided by: _(awaiting user verdict — recommend defer)_
- Linked ADR: none
- Linked TASKS row: F12 / Group B.7 (verify-promoted)

## 1. What it actually does

Upstream's largest single security commit. Hunks span CRITICAL
(CVSS 9.8) through MEDIUM, covering recover-master-token gating,
SSRF/DNS rebinding, XSS forbidden-attrs, prompt-injection
sanitisation, code-review-gate self-approval block,
deviceApproval cross-token bypass, invitations role-block,
migrations RBAC, export/backup path traversal, admin
PROTECTED_ROLES blocklist, integration-layer SSRF/method
allowlist, emailService header sanitisation, encryption
AES-256-GCM/PBKDF2 (replaces CryptoJS CBC), multitenancy
membership check, MongoDB sanitiseQuery.

## 2. Do we want it?

**Defer.** Recommendation: defer triage of remaining hunks until
after Group A has merged.

## 3. Why defer (not accept, not reject)

- **Most hunks are N/A in the fork** — the underlying files were
  deleted in M1 (`recover-master-token.js`,
  `database-mongodb.js`, `multitenancy.js`,
  `integration-layer.js`, `vault/`) or rewritten from scratch
  in M2 (`encryption.js` is now `src/lib/encryption.js` with
  HKDF subkeys + AES-256-GCM, replacing upstream's
  CryptoJS-CBC fix entirely).
- **A few hunks need verification:**
  1. `src/middleware/deviceApproval.js` — fork's deviceApproval
     middleware was rewritten in F4. Need to verify the
     "silent cross-token auto-approve bypass" is closed in the
     fork's version. If it isn't, file a follow-up mini-plan.
  2. `src/routes/invitations.js` — fork has its own
     invitations route. Need to verify the
     "block admin/owner from invitation acceptance" guard
     exists.
  3. `src/lib/migrations.js` — fork's migration runner exists
     in `src/database.js` rather than a separate module;
     need to verify `requireAdminRole` middleware is present
     on any deploy/rollback HTTP endpoint (or that no such
     endpoint exists).
  4. `src/services/emailService.js` — verify
     `sanitizeHeader()` exists in the fork's emailService.
  5. `src/routes/admin.js` — verify `PROTECTED_ROLES` blocklist
     exists for role assignment.
- **Closes capability gap:** none directly.
- **Strategic fit:** the fork already moved past the architectural
  shape of upstream's omnibus commit; piecemeal verification is
  the only sane path forward.

## 4. Risks if accepted as omnibus

- **Cherry-pick will fail loudly** on N/A files — too many
  conflicts to be safe to land in one commit.
- **Triage cost is high** — each surviving hunk needs its own
  re-verification pass.

## 5. Conflict surface in our fork

- ~20 of upstream's ~30 files are deleted or rewritten in the
  fork. Cherry-pick would not apply cleanly.

## 6. Test plan if any hunk advances

- Per-hunk: file a new mini-plan under `.context/imports/`
  with its own 8-section template.
- Per-hunk: a behavioural test that the specific CVSS finding
  is not regressed.

## 7. Rollback plan

N/A until any sub-hunk advances.

## 8. Out of scope for this import

- Importing this commit as a single cherry-pick (impossible
  given the file deletion overlap).
- Re-implementing upstream's CryptoJS→AES-256-GCM hunk — fork
  already did this in M2 with stronger primitives (HKDF
  subkeys, M2 source-pin tripwires).
- Re-introducing `database-mongodb.js`, `multitenancy.js`,
  `vault/`, `integration-layer.js`, or
  `recover-master-token.js` — explicitly forbidden by ADR-0013
  and the M1/M2 source-pin tripwires.

## Action items if user chooses to advance

1. Run a per-hunk verify pass against the 5 surviving files
   listed in §3 above.
2. For each surviving hunk that's NOT already closed: file a
   `.context/imports/<short>-<hunk-slug>.md` mini-plan.
3. Merge each as its own conventional-commit per ADR-0024 §3.
