# Session — 2026-04-24 — F5.1 Phase 0: shadow-route audit + baseline

- **Date.** 2026-04-24
- **Participants.** Cursor AI agent (F5.1 lead) + human reviewer.
- **Duration.** ~20 min.
- **Related work.** `F5` backlog
  (`.context/tasks/backlog/F5-password-auth-hardening-and-consolidation.md`),
  Phase 0 of the F5.1 milestone. No code changes in this session — pure
  audit + evidence capture so Phase 1 (route consolidation) can ship safely.

## Goal

Establish, with evidence, exactly which of the four candidate password-auth
handlers wins at runtime for `POST /api/v1/auth/register`, capture the
pre-consolidation test baseline, and document the mount-order reasoning so
Phase 1 can delete the three losers without surprise.

## Summary

The F5 backlog claimed there were four overlapping password-auth code paths.
This session verified that claim and discriminated the winner with a live
canary against the running smoke container.

### Mount order (verified via Grep against `src/index.js`)

| Line | Mount | Module | Priority |
|-----:|-------|--------|:--------:|
| 2242 | `app.use('/api/v1/auth', newAuthRoutes)` | `src/routes/auth.js` | **1 (wins)** |
| 2308 | `app.use('/api/v1', authRoutes)` | `src/auth.js` (legacy) | 2 (shadowed) |
| 6860 | `app.post('/api/v1/auth/register', authRateLimit, …)` | inline in `src/index.js` | 3 (shadowed) |
| 6887 | `app.post('/api/v1/auth/login', authRateLimit, …)` | inline in `src/index.js` | 3 (shadowed) |

Express matches `app.use` / `app.post` in registration order. `/api/v1/auth`
at line 2242 is registered before either `/api/v1` (line 2308, which would
also match `/api/v1/auth/register`) or the inline `app.post` at 6860, so
requests resolve to `newAuthRoutes` first and terminate there.

### Live canary evidence

Two probes against the running `myapi-smoke` container on
`http://localhost:4500/api/v1/auth/register`:

**Canary 1 — weak password**

```
POST /api/v1/auth/register
Content-Type: application/json
{"username":"f5canary_abc","password":"abc"}
```

Response:

```
HTTP 400
{"error":"Password must be at least 8 characters and contain 3 of: uppercase, lowercase, number, symbol"}
```

This exact string exists in two places in the tree:
- `src/routes/auth.js:233` (uses `isStrongPassword` + that message).
- `src/index.js:6865` (same `isStrongPassword`, same message).

It does **not** exist in `src/auth.js` (that file's message is lowercase
*"password must be at least 6 characters"*), so canary 1 eliminates
`src/auth.js` but leaves a routes/auth vs inline-index tie.

**Canary 2 — short username, strong password (discriminator)**

```
POST /api/v1/auth/register
Content-Type: application/json
{"username":"ab","password":"Strong123!"}
```

Response:

```
HTTP 400
{"error":"username must be between 3 and 50 characters"}
```

This exact string exists **only** in `src/routes/auth.js:234`. Neither
`src/index.js:6860` nor `src/auth.js` performs username-length validation
(the inline route delegates to `createUser()`, which does not validate
length; the legacy route only checks `password.length < 6`). Canary 2 is
therefore a definitive discriminator.

### Winner

`src/routes/auth.js` is unambiguously the live handler for:

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/token-login`
- `GET  /api/v1/auth/csrf-token`
- `GET  /api/v1/auth/me`

The inline `src/index.js` handlers at 6860 / 6887 and the legacy
`src/auth.js` module are dead paths. Phase 1 can delete them.

### Baseline Jest run

```
npx jest --forceExit
Test Suites: 1 skipped, 37 passed, 37 of 38 total
Tests:       22 skipped, 560 passed, 582 total
Time:        6.095 s
```

This is the green target Phase 1 must preserve.

### Transient-500 observation

Canary 1 was initially attempted via PowerShell's `Invoke-WebRequest` and
returned HTTP 500 with `{"error":"Internal server error"}`. A second
attempt via `curl.exe` returned the expected 400. The 500 response body
matches the global error handler at `src/index.js:12546` (non-multer error
path), suggesting a transient middleware throw — unrelated to the four
handler candidates. Not reproducible on retry. Filed as a low-severity
observation; revisit only if it recurs during Phase 1 or later smoke runs.

## Key decisions

- **Phase 1 deletions are safe.** Live canary + mount-order evidence both
  converge on `src/routes/auth.js`; no runtime traffic flows to the three
  shadow paths.
- **No code instrumentation needed.** Response-shape discrimination via
  canary payloads is sufficient; we do not need to add temporary log lines
  inside the handler bodies.
- **Tripwire scope stays narrow.** The Phase 1 "no `bcrypt.hashSync`"
  tripwire is scoped to `src/routes/auth.js` only. The boot-time
  master-token hashSync in `src/index.js:3321` is platform infrastructure
  (see "Out-of-scope infrastructure" section in the F5 plan) and must not
  be swept up in the ban.
- **One orphan to port before deletion.** `src/auth.js` exposes
  `GET /api/v1/auth/has-users` (line 125) that is not present on
  `src/routes/auth.js`. Before Phase 1 deletes `src/auth.js`, the endpoint
  must be either (a) confirmed unused by grepping the dashboard for call
  sites, or (b) ported to `src/routes/auth.js`. Deferred to the start of
  Phase 1.

## Action items

| Owner | Action | Target | Task ID |
|-------|--------|--------|---------|
| Next (Phase 1) | Grep dashboard + tests for callers of `/auth/has-users`. If zero, drop. If non-zero, port to `src/routes/auth.js` before deleting `src/auth.js`. | Phase 1 start | F5.1-P1 |
| Next (Phase 1) | Add three static tripwires to `security-regression.test.js` per the F5 plan's Phase 1 spec (routes/auth.js hashSync ban, no inline index.js /auth/* handlers, no `src/auth.js`). | Phase 1 step 0 | F5.1-P1 |
| Next (Phase 1) | Delete shadow routes: inline `/auth/register` + `/auth/login` in `src/index.js`, and the entire `src/auth.js` module. | Phase 1 main | F5.1-P1 |
| Next (Phase 1) | Port `authRateLimit` middleware to `src/routes/auth.js` login path so the per-IP throttle that previously lived on line 6887 is not lost. | Phase 1 main | F5.1-P1 |

## Open questions raised

- **Does `/auth/has-users` have any live callers?** Resolved at Phase 1
  start via grep (see action items above).
- **Is the transient-500 on the first canary a real bug?** Not reproducible
  in this session; not blocking. If it reappears during Phase 1 or live
  smoke, open a separate defect and investigate the global error handler
  at `src/index.js:12546`.

## Artifacts

- F5 plan (living doc): `.context/tasks/backlog/F5-password-auth-hardening-and-consolidation.md`
- Canary request/response evidence: captured inline above.
- Baseline Jest count: 560 passed / 22 skipped / 582 total (post-F4, pre-F5).
