# Import: 5921232 — fix(discord): per-user bot token for guild/channel proxy access

- Upstream commit: `omribenami/MyApi-Open@5921232e` (Subagent on 2026-04-18)
- Files upstream touched (5): `.env.example`, `src/index.js`,
  `src/public/dashboard-app/src/components/ServiceCard.jsx`,
  `src/public/dashboard-app/src/components/ServiceConfigModal.jsx`,
  `src/public/dashboard-app/src/pages/ServiceConnectors.jsx`
  (+493 / -77)
- Status: proposed
- Decided by: _(awaiting user verdict)_
- Linked ADR: none (security-improving)
- Linked TASKS row: F12 / Group A.8

## 1. What it actually does

Switches Discord proxy auth from a shared env-var
`DISCORD_BOT_TOKEN` to a per-user bot token stored in the
service-preferences table. Specifically:

- Proxy uses `Authorization: Bot <token>` for `/guilds/*` and
  `/channels/*` endpoints; `/users/@me*` keeps the OAuth bearer.
- Bot token stored per-user in service prefs `bot_token` key —
  no shared env, prevents cross-user access.
- Returns 503 with setup instructions when bot token is missing.
- ServiceConfigModal wired into ServiceConnectors (gear button
  on connected service cards); Discord config exposes
  `bot_token` field.
- Disconnect endpoint returns 200 instead of 404 when no token
  exists (idempotent).

## 2. Do we want it?

**Yes — security-improving + UX-improving.**

## 3. Why do we want it?

- Closes risk: §6.3 — shared env-var bot token is a multi-tenant
  blast-radius problem; per-user storage scopes the surface.
- Closes capability gap: GAP for "Discord guild operations
  require operator to configure their own bot" — today this is
  only possible via env-var edit + container restart; the
  ServiceConfigModal makes it self-serve.
- Aligned with milestone: F12 / Group A; security + UX.
- Strategic fit: per-user secrets is the model the fork already
  uses for vault tokens (M2) — Discord bot token belongs in the
  same shape.

## 4. Risks it poses

- **Security risk.** Storing the bot token correctly in service
  prefs requires it to be encrypted (same vault-style envelope
  used elsewhere). Verify the upstream commit uses
  `encryptVaultToken(...)` not raw storage; if not, that's a
  blocking issue and the fork must rewrite that hunk.
- **Architectural risk.** Medium — introduces the
  ServiceConfigModal pattern to the SPA, which other services
  may want later. Good direction but cross-check whether other
  services' configs already exist in the fork.
- **Maintenance risk.** Low.
- **Test-baseline risk.** Need behavioural tests for the
  per-user bot-token switching in the proxy.
- **UX risk.** Operators must set the bot token before
  guild/channel calls work — the 503 with setup instructions
  is the safety net. Document in `runbooks/agent-real-life.md`.
- **Migration risk.** Existing operators using
  `DISCORD_BOT_TOKEN` env-var will see guild calls 503 after
  this import unless they also set the per-user token. CHANGELOG
  must call this out.

## 5. Conflict surface in our fork

- `src/index.js` — Discord proxy handler. Need to verify the
  fork's Discord proxy shape (it's mid-monolith and may have
  drifted from upstream).
- `.env.example` — large diff; cross-check against the fork's
  evolved 498-line file (the relevant bit is just the
  removal of `DISCORD_BOT_TOKEN` and the addition of
  setup-doc comment).
- `ServiceConfigModal.jsx` and `ServiceConnectors.jsx` — likely
  new files in the fork; add cleanly.
- `ServiceCard.jsx` — gear button addition; cross-check that
  the fork's ServiceCard is open to the new prop.

## 6. Test plan for the import

- New test file: `src/tests/discord-per-user-bot-token.test.js`
  - User has bot token set + calls `/guilds/123/channels` →
    proxy uses `Bot <user-token>` (mock outbound).
  - User has bot token set + calls `/users/@me` → proxy uses
    OAuth bearer (mock outbound).
  - User has NO bot token + calls `/guilds/...` → 503 with
    setup instructions in body.
  - Cross-user: user A's bot token never visible / used in
    user B's proxy call.
  - Disconnect with no token → 200 (idempotent).
- Source-pin tripwire: extend
  `src/tests/security-regression.test.js` with assertion that
  the Discord proxy never reads
  `process.env.DISCORD_BOT_TOKEN`.
- Snapshot churn: low.
- Estimated baseline delta: 71/77/898 → 72/78/903 (+1 suite,
  +5 tests, +1 source-pin).

## 7. Rollback plan

Multi-file revert. Discord guild/channel calls will go back to
relying on the env var (or 503 if the env var was dropped in
the same commit).

## 8. Out of scope for this import

- Generalising ServiceConfigModal to other services (Slack,
  Notion, etc.) — separate UX task.
- Migrating existing users from env-var to per-user token —
  requires a one-time admin migration script; document in
  CHANGELOG and the runbook but don't ship code in this import.
- Encrypting the bot token at rest if upstream stores it raw —
  if so, that becomes a HARD BLOCKER and the import is
  rewritten before merge.
