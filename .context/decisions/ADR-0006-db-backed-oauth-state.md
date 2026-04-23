# ADR-0006 — DB-backed OAuth state tokens with server-side PKCE verifier

- **Status.** Accepted
- **Date.** 2026-04-21
- **Decision makers.** repo owner + AI pairing
- **Related.** `plan.md` §0.1 (OQ-6), §3.3 (AD-10), §6.3 (critical items on
  OAuth state + deterministic PKCE), `TASKS.md` M3
- **Tags.** security, oauth, csrf

## Context

Today, OAuth state is validated against a server-side **session map**
(`req.session.oauthStateMeta`). Problems:

1. Session-only: if the user starts the OAuth flow in one tab (one cookie
   context) and finishes it in another, validation fails or — worse — is
   permissive. With MemoryStore default (§5.3), state is lost on restart.
2. Discord bot-installation flow skips state validation entirely
   (`isDiscordBotInstall` branch) — a documented bypass.
3. **PKCE `code_verifier` is derived deterministically** from
   `SESSION_SECRET + state` (`buildPkcePairFromState`). PKCE's threat model
   assumes an attacker who can read the `state` (public parameter) cannot
   predict the `code_verifier`. Deterministic derivation from a shared
   secret means a single `SESSION_SECRET` leak invalidates PKCE for every
   past and future flow.

We need state that is cross-browser, single-use, expiring, and couples the
PKCE verifier to the state row rather than deriving it from a secret.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Keep session-based state; fix Discord bypass and randomize PKCE | Smallest diff | Still breaks multi-node; still loses state on restart |
| B | **DB-backed state row, random PKCE verifier stored alongside**, single-use + 10 min TTL | Works across browsers, instances, restarts; the state row is the one place the flow lives; PKCE verifier is random and throwaway | Adds a schema + pruning job |
| C | HMAC-signed stateless state (JWT-style) with random nonce | No DB writes | "Single-use" is hard to prove statelessly; replay detection needs some server-side memory anyway |

## Decision

**Option B — DB-backed, single-use, 10-minute TTL state rows with the PKCE
verifier stored in the same row.**

Schema (`state_tokens`):

| Column | Type | Notes |
|--------|------|-------|
| `state` | TEXT PK | Random URL-safe token from `crypto.randomBytes(32)` |
| `user_id` | INTEGER NULL | Populated for logged-in link flows |
| `mode` | TEXT | `login` / `link` / `install` (Discord bot) |
| `service` | TEXT | OAuth service id |
| `return_to` | TEXT NULL | Post-callback redirect |
| `code_verifier` | TEXT | Random `crypto.randomBytes(32)`, base64url |
| `created_at` | INTEGER | epoch ms |
| `expires_at` | INTEGER | epoch ms (default `created_at + 10 min`) |
| `used_at` | INTEGER NULL | set on first callback match; subsequent callbacks reject |

Callback validation:

1. Look up by `state`.
2. Reject if missing, `expires_at < now`, or `used_at IS NOT NULL`.
3. Set `used_at = now` inside the same transaction that consumes the row.
4. Use the stored `code_verifier` for the PKCE token exchange.

No Discord carve-out: the Discord bot-install flow uses the same state table.
(Discord does return `state` on bot installs; prior code asserted otherwise.)

Background pruner removes rows with `used_at` set or `expires_at < now - 1h`.

## Consequences

- Single consistent OAuth flow across all providers and modes.
- Closes the critical finding "OAuth state not DB-validated + Discord bot
  install bypass" in one change.
- Closes the high finding "deterministic PKCE verifier" — PKCE verifier is
  now unpredictable even if `SESSION_SECRET` leaks.
- One new table + two new indexes (`state_tokens_expires_idx`,
  `state_tokens_used_idx`) — negligible storage cost.
- The `/api/v1/oauth/authorize/:service` endpoint response now includes the
  same state it stored, which must be preserved by the OAuth provider in the
  standard `state` query parameter — already true for every listed provider.

## Follow-ups

- Executed by tasks **T3.1–T3.9** in `TASKS.md`.
- Pruner task added to the background scheduler (T3.9).
- Security regression suite grows cases: reused state, missing state, expired
  state, valid flow end-to-end (T3.8).
