# Import: 669d30f — fix(security): patch critical and high severity vulnerabilities (NARROW)

- Upstream commit: `omribenami/MyApi-Open@669d30fb` (Subagent on 2026-04-22)
- Files upstream touched: 31 files, net +1243 / -180
- Status: proposed (NARROW — 2 hunks only)
- Decided by: _(awaiting user verdict)_
- Linked ADR: none
- Linked TASKS row: F12 / Group B.6 (verify-promoted)

## 1. What it actually does (overall)

Upstream omnibus security patch covering 14 named fixes across
admin RBAC, auth, IDOR, CSRF, scope-validator, LLM SSRF,
HTML injection, Stripe webhooks, etc.

**Per the verify-pass record:** most hunks are **already closed**
in the fork via M1 deletions / M2 consolidation / F4
identity-vs-service split / F6 capability work. Only TWO hunks
remain importable:

### Hunk H1 — `src/lib/csrf-protection.js` length-guard

Upstream change:

```diff
- return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(sessionToken));
+ const tokenBuf = Buffer.from(token);
+ const sessionBuf = Buffer.from(sessionToken);
+ if (tokenBuf.length !== sessionBuf.length) return false;
+ return crypto.timingSafeEqual(tokenBuf, sessionBuf);
```

Today the fork's `src/lib/csrf-protection.js:27-30` calls
`crypto.timingSafeEqual` directly on buffers built from
attacker-controlled token strings. Node throws
`RangeError: Input buffers must have the same byte length`
when lengths differ, which the fork's middleware catches as a
generic 500 instead of returning `false` (treat as invalid).

### Hunk H2 — `src/middleware/scope-validator.js` workspaceId source

Upstream change:

```diff
- req.headers?.['x-workspace-id'] || 'system'
+ req.tokenMeta?.workspaceId || 'system'
```

Three sites in fork's `src/middleware/scope-validator.js`
(lines 52, 86, 117) currently use the user-controlled
`x-workspace-id` header in audit logs. Upstream switches to the
authenticated `req.tokenMeta?.workspaceId` so an attacker can't
spoof their `workspace_id` value in audit trails.

## 2. Do we want it?

**Yes (NARROW — H1 + H2 only). Reject the rest.**

## 3. Why do we want it?

- Closes risk: §6.3 — H1 closes a low-severity DoS vector
  (`RangeError → 500`); H2 closes an audit-trail integrity
  bug (attacker can spoof `workspace_id` in their own audit
  log entries).
- Closes capability gap: none.
- Aligned with milestone: F12 / Group B; security quality.
- Strategic fit: matches the fork's M2/M3/F4/F5 hardening
  trajectory.

## 4. Risks it poses (for H1 + H2 only)

- **Security risk.** Net-positive (both ARE security fixes).
- **Architectural risk.** None — surgical hunks.
- **Maintenance risk.** None.
- **Test-baseline risk.** Need new behavioural tests.
- **UX risk.** None.
- **Migration risk.** None.

## 5. Conflict surface in our fork

- `src/lib/csrf-protection.js` — clean 4-line addition.
- `src/middleware/scope-validator.js` — 3 site replacements;
  cross-check `req.tokenMeta` is populated by the auth
  middleware before the scope-validator runs (it is — verified
  via grep).

## 6. Test plan for the import

- New test file: `src/tests/csrf-length-mismatch.test.js`
  - POST with CSRF header of different length than the
    session-stored token returns `403 invalid CSRF`, not 500.
- New test file: `src/tests/scope-validator-workspace-id-source.test.js`
  - Hit a scope-gated endpoint with a token whose
    `tokenMeta.workspaceId = 'ws_real'` AND
    `X-Workspace-ID: ws_attacker` header → audit log row's
    `workspace_id` column is `ws_real`, not `ws_attacker`.
- Source-pin tripwire: extend
  `src/tests/security-regression.test.js` with two assertions:
  - `csrf-protection.js` source contains the length-guard.
  - `scope-validator.js` source does not contain
    `x-workspace-id` (textual gate).
- Snapshot churn: none.
- Estimated baseline delta: 71/77/898 → 73/79/903 (+2 suites,
  +5 tests, +2 source-pins).

## 7. Rollback plan

Two-file revert. CSRF reverts to throwing on length mismatch;
audit logs go back to header-controlled workspace_id.

## 8. Out of scope for this import

- All 12 other hunks in upstream's bundle commit — verified
  closed by the fork's existing M1/M2/F4 work. If any of them
  surface as a regression later, file a separate mini-plan.
- The `src/middleware/policyEngine.js` related hunks — fork
  has deleted that module per M1 unreachable-cleanup.
- The `src/routes/policy.js` and `src/routes/oauth-server.js`
  hunks — also deleted in the fork's M1/M2 sweep.
