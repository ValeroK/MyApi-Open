# F11 — 2FA reset mechanism

> **Status.** Filed 2026-04-29 from a real operator-side incident
> (`mailer.kv@gmail.com` lost their authenticator and could not log in;
> recovered by hand-editing SQLite — see §"Why" below).

## Identity

- **ID.** F11
- **Title.** Operator-driven 2FA reset (admin endpoint + dashboard UX) +
  defensive guard against silent secret rotation during setup.
- **Milestone.** Free-standing F-task. Naturally bundles into **M9**
  (frontend & output hygiene) for the dashboard surface and into the
  **F5** family for the auth-route work; not on the M-numbered
  critical path.
- **Plan reference.** `current_state.md` §6 (operator-recoverability
  for 2FA), `plan.md` §6.3 (HIGH risk: account-lockout when
  authenticator app is lost — currently mitigated only by manual DB
  edit, which is unsupportable for non-operator-owned deployments).

## Status

- **State.** backlog
- **Started.** —
- **Target done.** —

## Why

Today the only way to recover a user from a locked-out 2FA state is
to hand-edit `users.totp_secret = NULL, two_factor_enabled = 0` in
SQLite. This is what we did on 2026-04-29 for `mailer.kv@gmail.com`
after they failed `/auth/2fa/challenge` six times in a row (see
`audit_log` rows from that day) — the user's authenticator entry had
drifted from the DB-stored secret and there was no in-product path
back. **The hand-edit path is not just clunky, it is actively
broken in WAL mode** — see §"Hard requirement: must run inside the
app process" below. There are three failure modes today, all of
which need to funnel through a supported recovery path:

1. **User loses their authenticator entry** (phone restore, deleted
   entry, switched apps). Today: locked out forever; operator must
   `sqlite3` the DB. This is the path mailer.kv@gmail.com hit.
2. **User runs `/auth/2fa/setup` twice and scans the FIRST QR.**
   Each call to `/auth/2fa/setup` regenerates a fresh secret and
   overwrites `users.totp_secret` (`src/index.js:7314`,
   `setUserTotpSecret`). If the user scanned QR #1 and the page
   re-rendered/refreshed before they completed `/auth/2fa/verify`,
   the DB now holds QR #2's secret and QR #1's codes will all be
   rejected. mailer.kv@gmail.com's audit trail showed two
   `2fa_setup_started` rows ~45s apart on 2026-04-25 — exactly this
   shape.
3. **Server clock drift** beyond the ±60 s window
   (`speakeasy.totp.verify({ window: 2 })`). Operator-side issue;
   detection should surface in the same recovery UI.

The auth flow itself is correct — `speakeasy.totp.verify` with
`encoding: 'base32'` and `window: 2` matches every modern TOTP
client. What's missing is the **operator-recovery surface** and the
**defensive guard** against the double-setup foot-gun.

## What

### In scope

1. **Master-only admin endpoint.**
   `POST /api/v1/admin/users/:id/2fa/reset` — issues a single SQL
   write equivalent to today's manual fix
   (`UPDATE users SET two_factor_enabled = 0, totp_secret = NULL`)
   AND **scrubs every active session row for that user** in the
   session store (delete rows where `sess` JSON contains
   `pending_2fa_user.id === userId` OR `user.id === userId`).
   The session-scrub step is non-negotiable: discovered on
   2026-04-29 that the DB reset alone does not resolve the
   user-facing prompt — `pending_2fa_user` is a frozen snapshot
   stashed in `req.session` by the OAuth callback at
   `src/index.js:8708`, so a user who failed challenges and
   walked away still has stale rows in `data/sessions.sqlite`
   (also expires-bound, ~8 h default). Until those rows go
   away, the SPA keeps showing the prompt and
   `/auth/2fa/challenge` returns
   `400 "2FA is not enabled for this account"` (because the live
   `getUserTotpSecret` lookup now disagrees with the session
   snapshot). Wrap the whole thing in a single
   `2fa_admin_reset` audit row that captures the master-token
   id, the target user id, the request IP, and the count of
   sessions invalidated. Not a generic "edit user" endpoint —
   single-purpose, single-action, discoverable from the audit
   trail.
2. **Dashboard surface.** Admin / Power-user view: per-user row
   gains a "Reset 2FA" affordance, gated behind a confirm dialog
   that explains what happens (next login is gesture-free, the user
   must re-enroll). Same shape as the existing "Revoke all
   sessions" button. Lives wherever the admin user-list lands as
   part of M9 — if M9 hasn't started yet when this lands, the
   button can sit on Settings → Security with a "this only works on
   your own account" gate.
3. **Defensive guard against silent secret rotation during setup.**
   `/auth/2fa/setup` should refuse to regenerate a secret while
   `two_factor_enabled = 1`. Today it silently overwrites,
   producing the failure mode #2 above. Acceptable break: a user
   re-running setup on an already-enrolled account must explicitly
   disable first via `/auth/2fa/disable`. Surface that with a 409
   `ALREADY_ENROLLED` envelope so the dashboard can route the user
   correctly.
4. **Refuse master-token auth on every self-service 2FA route**
   (and on every other route in `src/index.js` that does
   `userId = req?.user?.id || req?.tokenMeta?.ownerId`). 2026-04-30
   incident: with no session active, the dashboard fell back to
   `Authorization: Bearer <master-token>` whose `owner_id` is the
   seeded literal `'owner'` (GAP-005). `authenticate` at
   `src/index.js:2581-2586` deliberately does NOT populate
   `req.user` when `matched.ownerId === 'owner'`, so userId
   resolved to `'owner'` and `setUserTotpSecret('owner',
   'LVITE43MMUQSC...')` wrote the user's TOTP secret onto a row
   that nothing else in the gateway treats as a real user (no
   email, no OAuth links, no per-user features). The user's
   actual `mailer.kv@gmail.com` row stayed at
   `totp_secret = NULL, two_factor_enabled = 0` — so even if
   they had completed verify, no real user account would have
   been protected. The 2FA setup / verify / disable / status
   endpoints (`src/index.js:7302 / 7338 / 7388 / 7436`) must
   either (a) reject any request whose `req.tokenMeta.ownerId`
   resolves to the literal `'owner'` with `403
   MASTER_TOKEN_NOT_ALLOWED_FOR_SELF_SERVICE`, or (b) plumb the
   bearer master-token's actual operator user row through
   (which means fixing GAP-005 first — every master token's
   `owner_id` must point at a real `users.id`). Option (a) is
   the smaller, safer ship; option (b) is the M6 monolith
   extraction's job.
4. **Self-service "I lost my authenticator" path** — see
   §"Stretch" below; not strictly required for v1 but the natural
   home for the same UX. Master-driven reset is the v1 ship.

### Hard requirement: must run inside the app process

Discovered the hard way on 2026-04-29: when `myapi-smoke` is
running in a Docker container with `data/myapi.db` bind-mounted
from the host, **any host-side `UPDATE users SET ...` is invisible
to the running container**. SQLite WAL mode keeps the active
`-wal` and `-shm` files open via fd inside the container; on
Windows Docker (WSL2 / 9P / virtiofs bind mounts), those files
are not even visible to the host's `ls`. A host-side
`better-sqlite3` write goes into the base file `myapi.db`, but
the running container's read sees its own snapshot view that
combines its WAL with the base file — and the WAL view masks the
host's write. Net result on 2026-04-29: host saw
`two_factor_enabled = 0`, but every fresh OAuth callback in the
container at 15:46 / 15:48 still wrote `pending_2fa_user` because
the container still read `twoFactorEnabled: true`. Only
`docker restart myapi-smoke` (clean WAL checkpoint + reopen)
unstuck the user; from there the next callback logged
`routing=fast_path_returning` instead of `routing=pending_2fa`.

**Implication for F11:** the admin reset endpoint MUST execute
through the app's own DB connection (the same `better-sqlite3`
handle `src/database.js` uses). It cannot be implemented as a
sidecar CLI that opens its own connection to
`data/myapi.db` — that path repeats the WAL footgun every time.
A supertest-driven test must explicitly cover the
"container-running-while-host-edits" anti-pattern by spinning up
the in-process app, executing the reset endpoint, and asserting
the very next request observes the change without restart.
Filing this here so we don't relearn it.

### Out of scope

- Recovery codes / backup codes. That's a bigger product question
  (where to store them, how to encrypt them at rest, how to render
  them once-only at enrollment). File as a separate brief if/when
  the operator wants it. v1 of F11 stays operator-driven.
- WebAuthn / passkeys. Out of scope for F11 — that's an M11+
  conversation about authentication factors generally.
- Notifying the user via email when their 2FA is reset. Email
  transport is already in `src/lib/notificationDispatcher.js`
  (used for `on2FAEnabled` / `on2FADisabled`); F11 should add an
  `on2FAReset` notification but that's a small fold-in, not a
  blocking dependency.

## How (sketch — to be refined when picked up)

1. New route `src/routes/admin.js` (or fold into the existing admin
   surface — check `src/routes/` at pickup time): `POST
   /api/v1/admin/users/:id/2fa/reset`. Master-token gate
   (`isMaster` middleware), then:
   1. `db.prepare('UPDATE users SET two_factor_enabled = 0,
      totp_secret = NULL WHERE id = ?').run(userId)`.
   2. Iterate the session store and delete every row whose
      decoded `sess` JSON contains either `pending_2fa_user.id ===
      userId` or `user.id === userId`. The store driver is
      `src/infra/session/SqliteSessionStore` post-M4-T4.4, so a
      direct SQL pass against `data/sessions.sqlite`'s
      `sessions` table is acceptable; for the in-memory test
      driver, walk the map. **OR** prefer the existing
      `revokeAllUserSessions(userId)` helper (used by
      `/api/v1/auth/sessions/revoke-all`,
      `src/index.js:7531`) if it covers the
      `pending_2fa_user` shape — verify at pickup that it
      reaches sessions where `user.id` is not yet set (the
      pending-2fa case has no `req.session.user` yet, so the
      naive `WHERE sess LIKE '%"id":"<userId>"%'` form is
      what's needed).
   3. Audit row via `createAuditLog({ requesterId: <master
      tokenId>, action: '2fa_admin_reset', resource:
      '/users/<id>/2fa', scope: 'admin', ip, details: {
      resetBy: <ownerId>, targetUserId, sessionsInvalidated:
      <n> } })`.
2. `/auth/2fa/setup` (`src/index.js:7302`) gains an early
   `if (user.twoFactorEnabled) return res.status(409).json({
   error: 'Already enrolled. Disable 2FA first to re-enroll.',
   code: 'ALREADY_ENROLLED' })`. Belt-and-suspenders — the
   dashboard should also disable the "Set up 2FA" button when
   `enabled` is true via `/auth/2fa/status`, but the API gate is
   the security primitive.
3. Dashboard wiring lives in
   `src/public/dashboard-app/src/pages/Settings.jsx` (own-account
   path) and the user-admin page (whichever lands first).
4. Notification fold-in in `src/lib/notificationDispatcher.js` —
   add `on2FAReset(workspaceId, userId, resetByOwnerId)` mirroring
   the existing on/off pattern.

## Stretch (v2)

Self-service flow: "I lost my authenticator" link on the login
page that POSTs `/auth/2fa/recovery-request` with the user's
email + password. If the password is correct, send an
email-confirmation link with a short-lived token (~1 h) that, on
click, lands on a confirm page that runs the same DB write the
admin endpoint does. This is essentially the password-reset flow
re-targeted at 2FA — same primitives in
`src/routes/auth.js` (`/password/reset` lineage, F5.2 P1).

The reason to ship admin-only first: the password-reset flow
required two PRs to land cleanly (F5.2 P1 then F5.3); doing the
same for 2FA is a project, not a quick fix. Operator-driven reset
covers the immediate operational need.

## Testing

- Unit / supertest:
  - `POST /api/v1/admin/users/:id/2fa/reset` with master → 200,
    DB row mutated, audit row written.
  - Same endpoint with a non-master scoped token → 403.
  - Same endpoint anonymous → 401.
  - `POST /auth/2fa/setup` for an already-enrolled user → 409
    `ALREADY_ENROLLED`, DB secret unchanged.
- Security regression (`src/tests/security-regression.test.js`):
  - Reset endpoint requires master scope (negative-assertion
    ratchet on the route file).
  - `setup` no longer silently overwrites
    (negative-assertion ratchet on the early-return).
- Manual verification:
  - Reproduce the mailer.kv@gmail.com failure shape
    (enroll → DB-edit secret to a wrong value → fail challenge
    3×) → operator hits Reset → user re-enrolls cleanly →
    challenge passes.
  - **Stale-session regression** (the second half of the
    2026-04-29 incident): enroll → fail challenge once →
    operator hits Reset → confirm the failing user's existing
    browser tab does NOT keep prompting for 2FA after a normal
    refresh (i.e. their session row is gone, the cookie maps
    to nothing, and OAuth callback re-runs cleanly). The L1
    test asserts the count of remaining sessions for that
    `userId` is 0 after the reset call.

## Risks & rollback

- **Reset endpoint is dangerous.** A compromised master token can
  disable 2FA on every user. Mitigation: every reset is audited
  with `requesterId = <master tokenId>`, `details.resetBy =
  <ownerId>`, and the action lands in `audit_log`. Operators can
  page on `action = '2fa_admin_reset'` if they want; the row
  shape mirrors `2fa_disabled`.
- **Setup-guard breaks legitimate "I want to re-enroll" flows.**
  Acceptable: the "disable then re-enroll" path is the right
  shape — silent overwrite is the bug. Dashboard can stitch the
  two calls into a single "Re-enroll" button if UX warrants.
- Rollback: the admin endpoint is additive (no schema change), the
  setup-guard is a 5-line `if` block. Both can be reverted by
  deleting the route file and the early-return; nothing else
  depends on them.

## Effort

S — half a day to a full day end-to-end:
- Admin endpoint + master-only gate + audit row: ~2 h.
- Setup-guard (409 ALREADY_ENROLLED) + test: ~1 h.
- Dashboard button + confirm dialog + wiring: ~2 h.
- Notification fold-in: ~30 min.
- Tests + manual verify: ~1 h.

## Depends on / Blocks

- **Depends on:** F5 family (already landed) — gives us the
  master-only middleware shape and the audit-row conventions to
  match.
- **Blocks:** Nothing on the roadmap. Closing F11 just removes the
  "you have to ssh into the host and run sqlite3" failure mode
  for 2FA-locked users.
- **Related:** F5.2 (password reset — same UX pattern for the
  stretch v2 self-service flow), M9 (admin user-list page is the
  natural home for the dashboard button), `src/index.js:7302`
  (the setup-guard target).

## Outcome (fill in when completing)

- Summary of what actually landed:
- Deviation from plan and why:
- Follow-ups created (new task IDs):
- Lessons learned:
