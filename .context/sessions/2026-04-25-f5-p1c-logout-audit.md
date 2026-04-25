# 2026-04-25 — F5.1 P1c: `user_logout` audit + dead `global.sessions` cleanup

> **Naming.** P1a (`fb99b74`) ported security controls onto the live
> router. P1b (this same commit window) deleted the shadow handlers.
> P1c is the post-shadow-deletion follow-up that closes the two
> non-blocking findings surfaced by P1b's verification matrix.  The
> backlog's "F5.1 Phase 2 — Harden hashing primitive" (bcrypt cost
> bump) is a different, larger work item.

## Context

The verification matrix from the F5.1 P1a+P1b stage (commit `fb99b74` plus
the P1b commit on the same branch) flagged two non-blocking findings:

1. **Logout audit gap.**  `POST /api/v1/auth/logout` clears the session
   and unregisters the SOC2 concurrent-session entry, but never emits a
   `user_logout` audit event.  Auditors could observe `user_login` events
   that "never end" — session lifetimes were not reconstructable from the
   audit log alone.

2. **Register-token orphan.**  `POST /api/v1/auth/register` writes
   `global.sessions[sessionToken] = { userId, … }` and returns a `data.token`
   field to the client, but **nothing in the codebase ever reads
   `global.sessions`**.  The dashboard's real master Bearer token is
   minted lazily by `/auth/me` into the `access_tokens` table.  The
   register-time token was therefore dead bytes that could be mistaken for
   a Bearer credential, and the 15-minute reaper in `src/index.js`
   (`cleanupExpiredSessions`) was sweeping a Map nobody read.

## Decisions

| ID  | Decision                                                                                       | Rationale                                                                                              |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| D1  | Skip `user_logout` audit on anonymous logout (no session user)                                 | Matches `user_login` semantics; an unauthenticated POST has no actor to attribute.                     |
| D2  | Drop `data.token` from `/register` response entirely                                           | Cleanest security posture; no caller reads it.  Documented as a low-risk breaking shape change.        |
| D3  | Include `details.sid` in the `user_logout` row                                                 | Allows auditors to cross-correlate `user_login` ↔ `user_logout` rows by session ID for lifetime queries. |
| D4  | Emit `user_logout` for token-login sessions too (single handler covers both)                   | `req.session.user.id = validToken.ownerId`, so the same emit path attributes the human, not the token. |

## Implementation

### `src/routes/auth.js`

* `/logout` (router.post('/logout', …)):
    * Replaced the orphaned `global.sessions` sweep loop with a deletion
      comment.
    * Added a `createAuditLog({ action: 'user_logout', requesterId:
      userId, scope: 'session', resource: '/users/' + userId, ip:
      req.ip, details: { sid } })` emit inside the existing
      `if (userId && sid)` block — anonymous logouts naturally skip,
      and the emit happens BEFORE session destruction so the userId/sid
      are still in scope.
    * Added an `[Auth/Logout] user_logout audited` `logger.info`
      breadcrumb so the application log + audit trail correlate by SID
      without grep gymnastics.
* `/register`:
    * Deleted the `sessionToken` generation, the
      `global.sessions[sessionToken] = …` write, and the `token`
      field in the 201 JSON response.
    * Added an `[Auth/Register] user registered` `logger.info`
      breadcrumb (operators reading container stdout previously saw
      nothing for this event, only the audit row).

### `src/index.js`

* Deleted the `cleanupExpiredSessions` function (~22 lines).
* Deleted its `setInterval(…, 15 * 60 * 1000)` registration.
* Replaced both with one-line comments referencing F5.1 P2.

## Tests

`src/tests/f5-logout-audit-and-session-cleanup.test.js` — 7 tests, all
red-first, all green after the implementation:

| #   | Type                | Asserts                                                                                                                |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Behavioural         | `user_logout` row written with correct `requester_id`, `scope=session`, `resource=/users/<id>`, `ip`, `details.sid`.   |
| 2   | Behavioural (guard) | Anonymous `POST /logout` returns 200 but does NOT create a `user_logout` row.                                          |
| 3   | Behavioural         | `POST /register` 201 response no longer carries `data.token`.                                                          |
| 4   | Behavioural         | `POST /register` does not mutate `global.sessions`.                                                                    |
| 5   | Static tripwire     | No `global.sessions[…]` writes anywhere in `src/routes/auth.js`.                                                       |
| 6   | Static tripwire     | `cleanupExpiredSessions` function/call is gone from `src/index.js`.                                                    |
| 7   | Static tripwire     | `/logout` handler in `src/routes/auth.js` contains a `createAuditLog({ action: 'user_logout' })` call.                 |

## Verification

* **Jest:** 589 passed / 22 skipped / 0 failed (+7 new vs. P1b baseline of 582).
* **Static greps:** No `global.sessions` writes in `src/`; only
  deletion-comment mentions remain.
* **Docker smoke** (rebuild `myapi:smoke`, recreate `myapi-smoke`):
    * `POST /register` → 201, response body has no `data.token` field.
    * `POST /login` → 200.
    * `POST /logout` (with CSRF) → 200.
    * `POST /logout` (no session) → 200, no audit row written.
* **DB forensics** (live SQLite read): the password user's lifecycle
  produced exactly three rows — `user_register` → `user_login` →
  `user_logout` — with the logout row carrying
  `details = {"sid":"7QpC1gJcsSjC-O2FNLuP3xuQNoNhIobU"}`.
* **Browser e2e** (Chrome devtools, fetch-driven from
  `http://localhost:4500/dashboard/`): register/login/`/me`/csrf-token/
  logout/`/me` all green; the resulting audit_log shows the expected
  three-row lifecycle for `usr_6676d3d240c1c9520083321f8ebeac19` with
  `sid=xw5y2an-OVX72u4gzi0Hp3jSgenbq5gk` on the logout row.

## Breaking-change note

`POST /api/v1/auth/register` no longer returns a top-level `data.token`
field.  The field carried no auth power (it was a key into a write-only
in-memory map), so any client that was reading it as a Bearer credential
was already broken in subtle ways.  No internal code path or test reads
the field; no API consumer was discovered via grep.  Risk classified
**low**.

## Follow-ups (not blocked on this change)

* `/auth/me`'s lazy master-token mint is documented but undocumented in
  the OpenAPI spec — worth surfacing alongside the F5.4 (UI password
  signup/login) phase.
* `qa-tests/phase1-security.js` is a free-standing axios script not
  picked up by Jest; worth folding into the suite or marking
  deprecated.
