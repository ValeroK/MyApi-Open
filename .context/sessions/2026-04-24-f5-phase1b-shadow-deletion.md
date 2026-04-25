## F5.1 Phase 1b — Shadow deletion + last-mile feature ports

**Date**: 2026-04-24 (continuation of 2026-04-24-f5-phase1a-port.md)
**Branch**: M3 working tree
**Predecessor**: P1a (`fb99b74`) — port-and-fix on `src/routes/auth.js`
**Commit**: this session

### Why this session

P1a closed the latent 2FA bypass on the live password router but
deliberately left the shadow code in place so we could prove behavioural
parity before deleting it.  P1b finishes the consolidation: it ports
two compliance gaps that were still only present in the shadows, then
deletes the shadows under static tripwire pinning.

### Audit findings (shadow vs live, post-P1a)

Walked every shadow handler and confirmed full parity with the live
router from P1a, except:

1. **`/logout` — SOC2 CC6 unregister missing on live.**
   The shadow at `src/index.js:7688` (now deleted) called
   `unregisterUserSession(userId, sid)` before destroying the session.
   Without that, the per-user session list in `userSessionRegistry`
   grew without bound across the account's lifetime and the cap-of-3
   eviction silently hit on the 4th legitimate login.

2. **`/logout` — first-login session keys not cleared on live.**
   The shadow stripped `req.session.oauth_signup` and
   `req.session.isFirstLogin` before destroying.  Without that, a
   re-login on the same browser cookie could resurrect a stale signup
   funnel or onboarding banner for a returning user.

3. **`/token-login` — `token_login` audit log missing on live.**
   The shadow at `src/index.js:7004` (now deleted) emitted the SOC2
   CC7-required audit row.  The live route created the session but
   never wrote the trail.

Other handlers (`/login`, `/register`) were already at parity after
P1a.  `src/auth.js` legacy file's only non-shadowed handler was
`/auth/has-users`; a workspace-wide grep confirmed zero production
callers.

### What landed

#### Last-mile ports onto `src/routes/auth.js`

- `POST /logout`:
  - imports `unregisterUserSession` from `src/lib/authHardening.js`
  - calls `unregisterUserSession(userId, sid)` synchronously (before
    the `req.session.destroy` async chain) so the SOC2 registry tracks
    reality even if the session destroy callback fires late.
  - clears `req.session.oauth_signup` and `req.session.isFirstLogin`
    alongside the other session keys before destroy.

- `POST /token-login`:
  - emits a `token_login` audit log via `createAuditLog`.
  - uses `tokenId` as `requesterId` (mirrors the legacy contract — the
    token, not the human owner, is what authenticated the request) and
    stashes `ownerId` under `details` so cross-correlation queries
    still work.

#### Schema migration moved out of `src/auth.js`

The legacy file added `users.roles TEXT DEFAULT 'user'` and
`users.last_login TEXT` as a side-effect of `require()`.  Two test
suites (`oauth-identity-service-separation.test.js`,
`f5-password-auth-parity.test.js`) and the live `/register` handler
all INSERT into `users.roles`, so deleting the file silently broke
registration.  Moved both `safeMigration` calls into `src/database.js`
alongside the other user-column migrations so they stay applied even
after the shadow file is gone.

#### Deletions

- `src/auth.js` — entire legacy file deleted (130 lines).
- `src/index.js`:
  - `const authRoutes = require('./auth');` removed.
  - `app.use('/api/v1', authRoutes);` removed.
  - inline `app.post('/api/v1/auth/{register,login,token-login,logout}')`
    handlers removed.
  - inline `app.get('/api/v1/auth/me')` removed.
  - replaced with a single comment block citing this session and P1a.
  - net `−334` lines from `src/index.js`.

#### Tests pinned

`src/tests/f5-password-auth-shadow-deletion.test.js` (new, 9 tests):

- 4 behavioural tests:
  - `/logout` removes the session from `userSessionRegistry` after
    a successful logout (introspects `authHardening._internals` to
    avoid coupling to the opaque sessionId).
  - `/logout` deletes `req.session.oauth_signup` (source tripwire on
    `src/routes/auth.js`).
  - `/logout` deletes `req.session.isFirstLogin` (source tripwire).
  - `/logout` calls `unregisterUserSession` (source tripwire).
  - `/token-login` emits a `token_login` audit log on success
    (queries `audit_log` directly).

- 5 static deletion gates:
  - `src/auth.js` does not exist.
  - `src/index.js` does not `require('./auth')`.
  - `src/index.js` does not register inline `app.{post,get}('/api/v1/auth/{login,register,logout,token-login,me}')`.
  - `src/index.js` does not mount `authRoutes` (legacy router) on
    `/api/v1`.
  - `/logout` block in `src/routes/auth.js` calls
    `unregisterUserSession`.

### Verification

#### Unit tests

```
Test Suites: 1 skipped, 39 passed, 39 of 40 total
Tests:       22 skipped, 582 passed, 604 total
```

Up from 573 → +9 new P1b tests; zero regressions.

#### Boot probe

```
node -e "require('./src/index'); ..."
→ database initialized, oauth.json loaded, websocket bound.  Clean.
```

#### Live Docker smoke (`myapi-smoke` rebuilt with P1b code)

| Step | Endpoint | Expected | Observed |
|---|---|---|---|
| Register fresh user | `POST /api/v1/auth/register` | 201 + user + token | 201 ✓ |
| Login same user | `POST /api/v1/auth/login` | 200 + session | 200 ✓ |
| Logout same session | `POST /api/v1/auth/logout` | 200 + cleared:true | 200 ✓ |
| Audit `user_register` | DB query | row for new userId | present ✓ |
| Audit `user_login` | DB query | row for new userId | present ✓ |
| Legacy `/auth/has-users` | `GET` | NOT 200 (gone) | 401 (auth gate) ✓ |

#### Static tripwire safety

The 5 deletion gates in `f5-password-auth-shadow-deletion.test.js`
all pass — any future PR that re-introduces `src/auth.js`, an inline
`/api/v1/auth/*` handler in `src/index.js`, or a `require('./auth')`
import will fail CI immediately.

### Out of scope (next: F5 Phase 2)

- Bcrypt cost bump 12 → 14 + upgrade-on-login.
- Password policy module (length, breach check, common-password
  blocklist).
- Account lockout after N failed attempts.
- Password reset (forgot-password) and change-password flows.
- Surface password login/register in the dashboard SPA (currently
  OAuth-only — see F5 plan §UI integration).

### References

- F5 plan: `.context/tasks/backlog/F5-password-auth-hardening-and-consolidation.md`
- P1a session: `.context/sessions/2026-04-24-f5-phase1a-port.md`
- P1a commit: `fb99b74`
