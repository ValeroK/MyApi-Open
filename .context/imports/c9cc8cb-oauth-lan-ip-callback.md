# Import: c9cc8cb — fix(oauth): allow LAN IP callbacks for myapi-agent client

- Upstream commit: `omribenami/MyApi-Open@c9cc8cbf` (Subagent on 2026-04-19)
- Files upstream touched: `src/index.js` (+3 / -2)
- Status: proposed
- Decided by: _(awaiting user verdict — security-sensitive)_
- Linked ADR: none (but flagged for review against ADR-0014, ADR-0019)
- Linked TASKS row: F12 / Group A.3

## 1. What it actually does

Extends the OAuth redirect-URI allowlist for the `myapi-agent`
client to accept LAN IPs (e.g. `192.168.x.x`, `10.x.x.x`) on the
`/callback` path, in addition to `localhost`. Justified upstream
as PKCE-only — no client secret is at risk if redirect_uri is
permissive — and necessary for agents running on local networks.

## 2. Do we want it?

**Conditional accept** — only after we verify the fork's PKCE
enforcement on this client matches upstream's claim.

## 3. Why do we want it?

- Closes capability gap: GAP for "agent on a Pi/laptop on the
  same Wi-Fi as the operator" — currently has to use port-forward
  hacks because only `localhost:*` callbacks are allowed.
- Aligned with milestone: F12 / Group A; ties into the
  `agent-walkthrough.mjs` E2E story.
- Strategic fit: agent-gateway-thesis — agents on the same LAN
  are a real deployment topology.

## 4. Risks it poses

- **Security risk (PRIMARY).** Permissive redirect_uri pattern
  (`http://*:*/callback`) is normally a CRITICAL anti-pattern
  because an attacker on the LAN can intercept the auth code at
  their own LAN IP. PKCE makes this safe ONLY if the attacker
  cannot also obtain the `code_verifier` — which they can't, since
  it's bound to the legitimate agent's session. **MUST verify
  the fork enforces PKCE on this client** before accepting.
- **Architectural risk.** Low — single regex change.
- **Maintenance risk.** Low.
- **Test-baseline risk.** None if the existing OAuth state suite
  still passes; need a new test asserting that a LAN IP callback
  is accepted only when PKCE verifier matches.
- **UX risk.** None.
- **Migration risk.** None — additive to allowlist.

## 5. Conflict surface in our fork

- `src/index.js` — OAuth redirect_uri validation logic. The fork's
  M3 work in `src/domain/oauth/state.js` made PKCE mandatory for
  the callback path — so the security premise checks out, but
  needs explicit confirmation before merging.
- `oauth-state-inventory.test.js` should already enforce PKCE
  presence; confirm it's red on a hypothetical bypass.

## 6. Test plan for the import

- New test file: `src/tests/oauth-lan-ip-callback.test.js`
  - Accept: LAN IP (`192.168.1.5:8765`) + valid PKCE → 302.
  - Reject: LAN IP + missing/invalid `code_verifier` → 400
    `STATE_PKCE_MISMATCH` (or equivalent).
  - Reject: external IP (`203.0.113.10`) → 400 `INVALID_REDIRECT_URI`.
- Source-pin tripwire: extend `oauth-state-inventory.test.js` to
  source-pin the LAN-IP regex literal.
- Snapshot churn: G0.3 may shift if line numbers move.
- Estimated baseline delta: 71/77/898 → 72/78/901 (+1 suite,
  +3 tests).

## 7. Rollback plan

`git revert <import-sha>`. LAN-IP agents lose callback access
immediately; legitimate `localhost` flows are unaffected.

## 8. Out of scope for this import

- Public IP / IPv6 / hostname-style callback patterns — keep the
  explicit IPv4 LAN-range scope.
- Removing the `myapi-agent` client identifier itself (that's a
  separate refactor).
- Documenting the LAN-IP behavior in `runbooks/agent-real-life.md`
  (follow-up doc task).
