# ADR-0011 — Gitleaks baseline scan 2026-04-21 and follow-up rotations

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** @kobi
- **Related.** `plan.md` §“Secrets management”, `TASKS.md` M1 / T1.6, ADR-0007 (rate limiting), ADR-0010 (single-codebase SOC2)
- **Tags.** security / secrets / compliance

## Context

`TASKS.md` T1.6 required running `gitleaks detect --log-opts="--all"` against
the full history of this repo and triaging anything it surfaced. We ran
`gitleaks 8.30.1` on 2026-04-21 against a 23-commit history (~6.4 MB scanned)
plus a second `--no-git` sweep of the working tree. We need a durable record
of:

1. what was found,
2. which findings are benign placeholders (to be suppressed via
   `.gitleaksignore`),
3. which findings are real credentials (to be rotated at the provider and
   scrubbed from HEAD),
4. what the ongoing policy is.

This ADR is that record.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Ignore findings, document as "historical noise" | Zero cost now | Unrotated tokens remain usable against live MyApi instances; gitleaks CI would keep alerting; SOC2 auditor question mark |
| B | Rotate all token-shaped findings + suppress placeholders + add CI check | Actual security outcome; clear audit trail; prevents regression | Requires operator action (DB revocation); mild ongoing maintenance of `.gitleaksignore` |
| C | Rewrite git history with `git filter-repo` to remove all leaked tokens | Clears the leak from every clone | Breaks every outstanding clone/branch/fork; operationally disruptive; does not help if the repo has been cloned externally (which it has — it is `MyApi-Open`, a public-facing repo) |

## Decision

We chose **Option B**. The repo is public, so rewriting history cannot recall
any copy that has already been cloned; the only credentials that matter are
the ones that are still live. We therefore treat any credential-shaped string
in history as burned, and the mitigation is revocation + forward-facing
hygiene — not history rewriting.

## Findings

Gitleaks reported 12 findings across history and 14 across the working tree
(12 overlapping + 2 extra from in-flight edits). All 14 are catalogued below.

### Bucket A — placeholders and framework keywords (safe, suppressed)

These are example snippets in docs, mock values in tests, or `.env` template
keys with empty values. They do not grant access to anything. They are
suppressed in `.gitleaksignore` with descriptive comments so future contributors
understand why.

| File | Line | Rule | Nature |
|------|------|------|--------|
| `README.md` | 304 | curl-auth-header | `Authorization: Bearer myapi_xxx...` placeholder |
| `docs/AGENT_README.md` | 16 | curl-auth-header | `Authorization: Bearer YOUR_TOKEN` placeholder |
| `docs/SERVICES_MANUAL.md` | 568 | generic-api-key | `TWITCH_CLIENT_SECRET=` with empty value in a `.env` template |
| `src/lib/data-exposure-prevention.js` | 32 | generic-api-key | Comment `sk_live_abc123... → sk_live_***` explaining the redactor |
| `src/__tests__/export-routes.test.js.skip` | 48 | generic-api-key | Mock id `tok_regular_1234567890` in a skipped Jest fixture |
| `src/public/dashboard-app/src/pages/MyListings.jsx` | 231 | curl-auth-header | `'bearer'` inside an `<option>` list for auth_type |
| `src/public/dashboard-app/src/pages/Connectors.jsx` | 614 | generic-api-key | Example tokenId `tok_a44fbb…` (tokenId is documented as non-secret) |
| `src/public/dashboard-app/src/pages/PlatformDocs.jsx` | 322 | curl-auth-header | `Authorization: Bearer YOUR_GUEST_TOKEN` placeholder |
| `src/routes/IMPORT_DOCUMENTATION.md` | 172, 422, 434 | curl-auth-header | `Authorization: Bearer YOUR_TOKEN` placeholders |

### Bucket C — token-shaped strings in history (reviewed, **no rotation required**)

Each of these looks like a live `myapi_…` token on shape alone. The repo
owner confirmed on 2026-04-21 that all three were **dev/test tokens issued
only against ephemeral local `http://localhost:4500` MyApi instances**, never
against any publicly reachable deployment, and those local instances no longer
hold the tokens. No provider-side rotation is therefore required.

The tokens have still been removed from HEAD and added to `.gitleaksignore`
under their original commit SHAs so they don't re-alert on future scans.

| Token shape | File (HEAD before fix) | Last known commit | Issued to | Rotation decision |
|-------------|------------------------|-------------------|-----------|-------------------|
| `myapi_8e04fdb6…f028d2f5` (agent token) | `docs/AGENT_README.md:10` | `94a85d9` | Local dev instance (doc example) | **Not required — confirmed test token, dev DB no longer holds it** |
| `myapi_9a81e1bc…f51fae` (MASTER token) | `qa-tests/phase1-security.js:10` | `94a85d9` | QA script against `localhost:4500` | **Not required — confirmed test token, dev DB no longer holds it** |
| `myapi_guest_04634b05…63cb2ad` (guest token) | `qa-tests/phase1-security.js:11` | `94a85d9` | QA script against `localhost:4500` | **Not required — confirmed test token, dev DB no longer holds it** |

The revocation SQL template below is kept for reference in case a future
scan surfaces a real token.

### Revocation SQL (reference, unused for 2026-04-21 scan)

Run this on every MyApi instance where the operator of this repo has ever
deployed (including local dev DBs they still care about):

```sql
-- Revoke by token hash. MyApi stores sha256(token) in access_tokens.tokenHash.
-- Compute the hashes from the raw token once, outside the DB, and then:
UPDATE access_tokens
   SET revokedAt = CURRENT_TIMESTAMP,
       revokedReason = 'gitleaks-ADR-0011'
 WHERE tokenHash IN ($hash_agent, $hash_master, $hash_guest)
   AND revokedAt IS NULL;
```

Helper (Node, one-shot, local machine only):

```js
const crypto = require('crypto');
const raw = 'myapi_...'; // paste from the commit, once, on a trusted machine
console.log(crypto.createHash('sha256').update(raw).digest('hex'));
```

After revocation, record the exact `revokedAt` timestamp for each token in the
table above.

## Consequences

### Positive
- All gitleaks findings are now either suppressed with rationale or rotated.
- `.gitleaksignore` gives every future contributor a one-glance map of why
  each placeholder is safe.
- `qa-tests/phase1-security.js` now refuses to run without env-var tokens,
  closing the "someone will hardcode again" regression path.
- Re-running gitleaks on 2026-04-21 after the fixes produced **0 findings**
  in both history and working-tree modes.

### Negative / costs
- The token-shaped strings remain in git history forever. Because all three
  were confirmed test tokens that never left local dev instances (see Bucket
  C table), the residual risk is that *future* contributors assume the
  pattern is acceptable and hardcode real tokens. Mitigations: the env-var
  refactor of `qa-tests/phase1-security.js`, the `.gitleaksignore` comments,
  and the planned `gitleaks protect --staged` CI job (T1.6b).
- `qa-tests/phase1-security.js` is a one-line breaking change for anyone who
  ran it without env vars; they'll get a clear error message.

### Code changes landed in this ADR's commit
- `docs/AGENT_README.md` — token example replaced with `myapi_xxx...xxx` and
  explanatory warning.
- `qa-tests/phase1-security.js` — tokens moved to `QA_MASTER_TOKEN` /
  `QA_GUEST_TOKEN` env vars; script exits 2 if missing.
- `.gitleaksignore` — created with Bucket A placeholder ignores and
  Bucket C history-commit ignores.
- `.gitignore` — added `gitleaks-*.json` so scan reports never get
  accidentally committed.

### Operational changes required
- **Operator action (outstanding):** revoke the three tokens in the MyApi DB,
  then fill in the Rotation date column above.
- **CI (future, T14.x):** add a `gitleaks-protect` job to `.github/workflows/ci.yml`
  to run `gitleaks protect --staged` on PRs so new leaks fail the build.

## Follow-ups

- ~~**T1.6 follow-up — revoke tokens in DB.**~~ Not required; operator
  confirmed 2026-04-21 that the three Bucket-C tokens were dev-only test
  tokens against local instances that no longer hold them.
- **T1.6b.** Add `gitleaks-protect` to CI on PRs so new hardcoded tokens
  fail the build. Rolled into M14 CI hardening.
- **Quarterly scan.** Re-run `gitleaks detect --log-opts="--all"` at least
  every 90 days or before any external audit; append a row to this ADR's
  findings tables if new findings appear (do not amend historical rows).
- **Revisit.** If we ever rewrite history with `git filter-repo`, this ADR
  gets superseded by a new one describing the rewrite.
