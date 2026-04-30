# Capability gaps — running ledger

> **Purpose.** Single living record of capabilities that are missing, broken,
> or contradicting their own docs, surfaced during the **F6 — Agent capability
> verification** test push. Every test step (L1 supertest, L2 live-smoke, L3
> runbook, connector spike) appends here when it discovers something. Per
> `.cursor/rules/test-first.mdc` and the F6 plan
> (`.cursor/plans/capability_test_plan_b4523725.plan.md` §4c), nothing gets
> "noticed and forgotten" — every finding lands a row.
>
> - Last updated: **2026-04-28** (F6.7 triage pass — every `open` row now
>   has a target milestone or follow-up task brief; F8 / F9 / F10 filed
>   for the gaps that didn't naturally bundle into M6 / M14).
> - Owner: F6 driver (currently AI pairing).
> - Companion: `.context/tasks/backlog/F6-agent-capability-verification.md`.

---

## Triage summary (F6.7, 2026-04-28)

Every gap surfaced during F6 has been classified. The table below is the
authoritative map; details remain in §3.

| ID | Severity | Status | Target | Task brief |
|----|----------|--------|--------|------------|
| GAP-001 | P2 | open | **M14** (docs & runbooks) | folded into M14; no new brief — `ENABLE_OAUTH_*` docs/code drift surfaces in the docs sweep |
| GAP-002 | P0 | **resolved 2026-04-28** | F6.1 | one-line `authenticate` middleware add + 5-test ratchet |
| GAP-003 | P1 | open | **F8** (new) | `gateway/context` master-only vs `llms.txt` advertisement — pick one and align |
| GAP-004 | P2 | open | **F7** (deferred per ADR-0020) | marketplace `connector` type lands with the runtime loader |
| GAP-005 | P1 | open | **M6** (monolith extraction) | `'owner'` literal threads through the multi-tenant cleanup |
| GAP-006 | P2 | open | **M14** | `/services/available` defense-in-depth scope; folded into the docs sweep + small handler tweak |
| GAP-007 | P2 | open | **accept-risk** | already covered by `COALESCE`; ADR-0016 §Follow-ups documents the ambiguity |
| GAP-008 | P1 | open | **F9** (new) | scope hierarchy not implemented; cluster fix with GAP-009 |
| GAP-009 | P1 | open | **F9** (same) | `validateScope` ↔ `grantScopes` self-contradiction |
| GAP-010 | P1 | open | **F10** (new) | service catalog seed dead at boot; smallest open delta |
| GAP-011 | P2 | open | **M6** | duplicate `/handshakes/:id/status` handler removed during monolith extraction |

**Disposition stamps** (also in each row's `Disposition` field below):
- `fix-now`: 1 (GAP-002).
- `file-task` → existing milestone: 5 (GAP-001 / 005 / 006 / 011 + the M14
  / M6 split).
- `file-task` → new F-brief: 4 (GAP-003 → F8, GAP-008+009 → F9,
  GAP-010 → F10).
- `accept-risk`: 1 (GAP-007).

---

## How to use this document

1. When a test, runbook step, or static review surfaces a missing or
   broken behavior, **append a row** to §3 with the next free `GAP-NNN`.
2. Fill every column. If you do not yet know the disposition, set it to
   `triage` and circle back.
3. Decide a disposition:
   - `fix-now` — fix in the same PR as the test that surfaced it. Test goes
     green, gap row marked `resolved` with the commit SHA in **Notes**.
   - `file-task` — create or update a task brief under
     `.context/tasks/backlog/` and link it both ways.
   - `accept-risk` — write an ADR explaining why we're not fixing, link
     it, mark the row `wont-fix`.
4. **Do not delete rows.** Resolutions stay in the ledger as history.
5. When all `open` rows are dispositioned, the F6 milestone can close.

### Severity guide

| Sev | Meaning | Examples |
|-----|---------|----------|
| **P0** | Credential exposure, authentication bypass, SSRF, audit-log gap, scope escalation. | Bearer token logged in plaintext; an unauthenticated route returns secrets. |
| **P1** | Agent-facing capability is broken or contradicts its own docs. Ship-blocking for "real life" agent use. | `/gateway/context` advertised as the agent first call but rejects scoped tokens. |
| **P2** | UX papercut, docs drift, defense-in-depth nice-to-have. | `ENABLE_OAUTH_*` documented but unread. |

### Status values

`triage` → `open` → `in-progress` → `resolved` / `wont-fix`

---

## Pre-seeded findings (from exploration on 2026-04-27/28)

These are findings the F6 exploration pass surfaced **before** any new test
landed. They are pre-seeded so that the L1 / L2 work has concrete targets
to either close (`fix-now`) or characterize (red-first test that pins the
current behavior, then `file-task` for the real fix). Until the relevant
test lands they all carry `evidence` pointing at the static read of
`src/index.js` rather than a failing test ID.

### GAP-001 — `ENABLE_OAUTH_{SERVICE}` flags are documented but unread

- **Discovered.** 2026-04-28
- **Layer.** static review (exploration pass for F6)
- **Endpoint / area.** OAuth provider gating (boot-time)
- **Severity.** P2
- **Description.** `README.md` and `src/.env.example` document
  `ENABLE_OAUTH_GOOGLE`, `ENABLE_OAUTH_GITHUB`, etc. as the way to toggle
  providers. The actual gate in `src/index.js:838-854` (`isOAuthServiceEnabled`)
  keys on **adapter credentials being present** and the
  `oauthConfig[service].enabled !== false` override from `oauth.json`. No
  code reads `ENABLE_OAUTH_*`. An operator who sets only the flag (no
  creds) will see the service stay disabled with no useful log line; an
  operator who sets only creds (no flag) will see the service silently
  enabled. Either way the user is confused.
- **Evidence.** `src/index.js:838-854` (no `ENABLE_OAUTH` reference in the
  whole file); `README.md` § Configuration; `src/.env.example`.
- **Disposition.** `file-task` — fold into a docs/UX task in M9 or M14.
  Decision required: either wire the flags or remove them from docs +
  `.env.example`. Do **not** silently introduce both.
- **Status.** `open`
- **Notes.** L1 suite `agent-discovery-contract.test.js` will assert the
  current effective behavior (creds-only) so we don't accidentally regress
  while deciding.

### GAP-002 — `/api/v1/google/*` mount has no `authenticate` ✅ RESOLVED

- **Discovered.** 2026-04-28
- **Layer.** static review
- **Endpoint / area.** `app.use('/api/v1/google', ...)` parallel mount
- **Severity.** **P0 confirmed** (auth bypass; closed `fix-now`).
- **Description.** `src/index.js:2985-2986` mounted `src/routes/google.js`
  without the `authenticate` middleware. Inside the router,
  `resolveUserId(req)` falls back to literal `'owner'` when no token /
  session is present (`src/routes/google.js:16-24`). On any deployment
  where the operator had connected Google in the dashboard (the
  documented happy path), an unauthenticated remote caller could list
  & read Gmail messages by hitting `GET /api/v1/google/gmail/messages`
  or `GET /api/v1/google/gmail/messages/:id` — no token, no session,
  nothing. Static comparison against every sibling pre-`/api/v1`
  mount (devices, dashboard, skills, notifications, activity, email,
  workspaces, invitations, export, import, vault, afp, fal, agentic,
  tickets — all 16 of them) confirmed each had `authenticate` as the
  second positional argument; only Google did not.
- **Evidence.** `src/index.js:2985-2986` (pre-fix);
  `src/routes/google.js:16-24` (`resolveUserId` fallback);
  `src/tests/google-mount-auth-posture.test.js` red-first run on
  2026-04-28 produced 4 failed / 1 passed assertions confirming the
  bypass. Post-fix run: 5 / 5 green.
- **Disposition.** `fix-now` — landed 2026-04-28 in the same change as
  the test that surfaced it. Fix: one-line addition of `authenticate`
  to the mount in `src/index.js`. Snapshot diffs in the three Stage-0
  pre-stage gates (G0.1 API surface, G0.2 middleware chain, G0.3
  boot-side-effects line drift) regenerated in the same change — the
  diffs ARE the security-fix evidence per ADR-0019.
- **Status.** `resolved`
- **Notes.** Test baseline: **55 / 56 → 56 / 57 suites**, **767 → 772
  passing tests** (+5), **28 / 28 snapshots** (3 updated, 0 net change
  in count). New permanent ratchet:
  `src/tests/google-mount-auth-posture.test.js` static gate asserts
  the mount line includes `authenticate` as the second arg, mirroring
  the M2 / M3 inventory-gate pattern.

### GAP-003 — `/api/v1/gateway/context` is master-only but `llms.txt` advertises it as the agent first call

- **Discovered.** 2026-04-28
- **Layer.** static review
- **Endpoint / area.** `GET /api/v1/gateway/context`
  (`src/index.js:6397-6478`)
- **Severity.** P1
- **Description.** The handler returns 403 unless `isMaster(req.tokenMeta)`.
  But `llms.txt` (`src/index.js:3891-3929`) and the AI plugin manifest
  (`src/index.js:1794-1808`) point agents at it as the first call to
  understand the gateway. A scoped agent token therefore cannot follow
  the documented onboarding path; it has to fall back to
  `/api/v1/capabilities`. Either the gate is too tight (intent: agents
  should call this) or the docs are wrong (intent: master-only
  introspection).
- **Evidence.** `src/index.js:6397-6398` (the master gate),
  `src/index.js:3891-3929` (`llms.txt`), `src/index.js:1794-1808` (plugin
  manifest).
- **Disposition.** `file-task` — needs a product call. Two reasonable
  options: (a) loosen the gate to `services:*` and scrub vault metadata
  out of the response for non-master callers, (b) keep the gate and
  rewrite the agent-facing docs to point at `/capabilities` instead.
  Track in F6 task brief; decision likely surfaces an ADR.
- **Status.** `open`
- **Notes.** L1 suite `agent-discovery-contract.test.js` will pin the
  current behavior so the docs/code drift is locked behind a test until
  the product call lands.

### GAP-004 — Marketplace has no `connector` listing type

- **Discovered.** 2026-04-28
- **Layer.** static review
- **Endpoint / area.** Marketplace listings (`src/index.js:11536`)
- **Severity.** P2
- **Description.** `marketplace_listings.type` validation accepts
  `persona | api | skill`. There is no `connector` value, so the user's
  vision of an agent (or a human) submitting a connector spec to the
  marketplace cannot be expressed in the data model today.
- **Evidence.** `src/index.js:11536`,
  `src/database.js:483-508` (`marketplace_listings` schema — `type` is
  free-text but the validation gate enumerates the three).
- **Disposition.** `file-task` — link from the F6 connector-feasibility
  ADR (`ADR-0020`). Adding the type is small; the **review/approval
  workflow** is the real work and waits on M5 (SSRF) +
  ADR-0020's recommendation.
- **Status.** `open`

### GAP-005 — `POST /api/v1/handshakes` writes literal `'owner'` for `user_id`

- **Discovered.** 2026-04-28
- **Layer.** static review
- **Endpoint / area.** `POST /api/v1/handshakes` (`src/index.js:7743-7770`)
- **Severity.** P1
- **Description.** The handler is intentionally public (the agent has no
  identity yet — that's the point of a handshake) but the row it writes
  hardcodes `user_id = 'owner'`. In a multi-tenant world this means
  every handshake silently targets the literal owner of the gateway,
  regardless of which workspace or user the agent intended to bind to.
  As long as MyApi runs single-owner this is benign; as soon as the
  workspace model is real (M6+), it's a multi-tenant correctness bug.
- **Evidence.** `src/index.js:7743-7770`,
  `createHandshake("owner", agentId, …)` call site.
- **Disposition.** `file-task` — track for M6 multi-tenancy pass. The
  L1 suite `handshake-flow-behavioral.test.js` will pin the current
  single-owner behavior with an explicit comment so it is not mistaken
  for "intended" once M6 opens.
- **Status.** `open`
- **Notes — 2026-04-30 incident, second concrete repro of the same
  literal.** When `mailer.kv@gmail.com` had no active session (their
  session row had been over-deleted during the 2026-04-29 2FA-reset
  ops fix), the dashboard fell back to
  `Authorization: Bearer <master-token>` whose `owner_id` is the
  seeded literal `'owner'`. `authenticate` at `src/index.js:2581-2586`
  deliberately does NOT populate `req.user` when
  `matched.ownerId === 'owner'`, so every self-service endpoint that
  does `userId = req?.user?.id || req?.tokenMeta?.ownerId` resolved
  to `'owner'`. The user clicked **Settings → Enable 2FA**;
  `setUserTotpSecret('owner', 'LVITE43MMUQSC...')` wrote the user's
  TOTP secret onto a row no other code path treats as a real user
  (no email, no OAuth links, no per-user features). Their actual
  `mailer.kv@gmail.com` row stayed at `totp_secret = NULL,
  two_factor_enabled = 0` — so even a successful verify would have
  protected nothing. The 2FA setup / verify / disable / status
  endpoints in `src/index.js:7302 / 7338 / 7388 / 7436` should
  refuse master-token auth with `403
  MASTER_TOKEN_NOT_ALLOWED_FOR_SELF_SERVICE` until M6 fixes the
  underlying `'owner'` literal, OR the same M6 pass plumbs the
  bearer master-token's actual operator user row through. Both
  options recorded in the F11 brief §"In scope" #4. **Until the
  fix lands, the runbook is: log out → log in via Google →
  Settings → 2FA setup, never via `Authorization: Bearer
  <master-token>`.**

### GAP-006 — `/api/v1/services/available` and `/categories` require auth but no scope

- **Discovered.** 2026-04-28
- **Layer.** static review
- **Endpoint / area.** `GET /api/v1/services/available`
  (`src/routes/services.js:365-376`),
  `GET /api/v1/services/categories` (`src/routes/services.js:289-304`)
- **Severity.** P2
- **Description.** Both routes use `requireAuth` but no
  `requireScopes`/`requireServiceScope`. A token with **any** scope —
  including a narrowly-scoped agent token — can enumerate the full
  catalog. This isn't a credential exposure (it's just the catalog) but
  defense-in-depth says scoped tokens should see only the services they
  can actually use.
- **Evidence.** `src/routes/services.js:289-376`.
- **Disposition.** `file-task` — bundle with M6 monolith extraction so
  the catalog filter and the scope-aware narrowing land together.
- **Status.** `open`

### GAP-007 — Pre-M3 `oauth_tokens.provider_subject` rows may be NULL

- **Discovered.** 2026-04-28
- **Layer.** static review (cross-checked against M3 wrap-up notes)
- **Endpoint / area.** `oauth_tokens` table (`src/database.js`)
- **Severity.** P2
- **Description.** Rows written before M3 Step 7 (T3.7) carry
  `provider_subject = NULL`. The `COALESCE` branch in `storeOAuthToken`
  preserves the existing NULL on UPDATE if the caller passes NULL.
  Result: returning users with very old rows still get `NULL` for the
  first-seen key, which forces them through the confirm gesture every
  time even though they already linked the provider. The M3 wrap-up
  threaded `provider_subject` through every live caller so **new** rows
  are correct; old rows quietly slip.
- **Evidence.** `src/database.js` `storeOAuthToken` (post-M3 wrap-up);
  `current_state.md` 2026-04-24 entry §M3 wrap-up Task A.
- **Disposition.** `file-task` — ship a one-shot backfill migration
  that, for each `oauth_tokens` row with non-NULL `expires_at` and NULL
  `provider_subject`, calls the relevant adapter's `verifyToken` to
  resolve the subject and writes it. Bundle with M6 or earlier if a
  user reports the symptom.
- **Status.** `open`

---

## L1 / L2 / L3 findings (to be appended as work lands)

### GAP-008 — Scope hierarchy not implemented; narrow `services:{name}:{verb}` is useless against the proxy

- **Discovered.** 2026-04-28
- **Layer.** L1 supertest
  (`src/tests/services-proxy-behavioral.test.js`, suite §2 "scope gate")
- **Endpoint / area.** `POST /api/v1/services/:serviceName/proxy`
  scope check (`src/index.js:9987-9995`)
- **Severity.** **P1** (capability broken; contradicts docs)
- **Description.** `CLAUDE.md` documents a scope hierarchy
  `admin:* > services:* > services:{name}:read`. The proxy's actual
  check is `hasScope(req, 'services:read')` /
  `hasScope(req, 'services:write')` and `hasScope`
  (`src/index.js:3263-3267`) is **strict equality** against the
  rows of `access_token_scopes` for that token. There is **no**
  hierarchy expansion. Concretely:
  - Token granted `services:google:read` → cannot use the proxy at
    all (proxy asks for `services:read`, token has
    `services:google:read`, set does not contain → 403).
  - The agent walkthrough runbook (`agent-real-life.md`) and any
    real-world deployment that mints narrow tokens following the
    documented hierarchy will hit a 403 wall.
  - Master + broad `services:read` / `services:write` work
    correctly (proven green in the same suite).
- **Evidence.** `src/index.js:3263-3267` (`hasScope` strict
  equality); `src/index.js:9987-9995` (proxy asks for the broad
  scope only); `src/database.js:1945-1953` (`validateScope` accepts
  the narrow regex *as a sub-scope* — comment-claim only); 2026-04-28
  red-first run of `services-proxy-behavioral.test.js` reproduced
  the 403 with body `Insufficient scope` for a token granted
  `services:google:read` doing GET; the eventual passing test
  pins the same 403.
- **Disposition.** `file-task` — the right fix expands `hasScope`
  (or its callers) so a `services:{name}:{verb}` grant satisfies
  `services:{verb}` for that single service. Bundle with M6
  monolith extraction so the scope-engine lives in its own
  module. Until the fix lands:
  1. The L3 runbook + L2 live-smoke must mint **broad**
     (`services:read` / `services:write`) tokens — not narrow.
     The runbook will be updated when this gap is dispositioned.
  2. The proxy test suite documents the current behavior with
     red-first cases that say "today, narrow scope is rejected
     here" and a positive-control case for the broad scope.
  3. F7 (agent-defined connectors) inherits this gap: any "the
     agent gets a token scoped to its own connector" design must
     account for the missing hierarchy.
- **Status.** `open`
- **Notes.** Sibling finding GAP-009 below. Together they cluster
  as "the scope engine has two callers using slightly different
  models". A single ADR after F6 closes likely supersedes both.

### GAP-009 — `validateScope` accepts narrow scopes but `grantScopes` cannot insert them (FK constraint)

- **Discovered.** 2026-04-28
- **Layer.** L1 supertest setup (test seed exposed it while
  pursuing GAP-008's positive control)
- **Endpoint / area.** `grantScopes(tokenId, [...scopes])` ↔
  `validateScope(scopeName)`
  (`src/database.js:1945-1985`)
- **Severity.** **P1** (internal API self-contradiction; blocks
  the documented narrow-scope use case at the data layer)
- **Description.** `validateScope` returns `true` for any string
  matching `/^services:[a-z0-9_-]+:(read|write|\*)$/`. The doc
  comment immediately above explicitly says "These are sub-scopes
  of `services:read`/`services:write`". But
  `access_token_scopes.scope_name` has a foreign key onto
  `scope_definitions(scope_name)` (`src/database.js:417`),
  and `scope_definitions` only seeds the broad `services:read` /
  `services:write` rows (`src/database.js:1920-1921`). Result:
  `grantScopes(tok, ['services:google:read'])` passes
  `validateScope` and then **throws** at the FK constraint when
  it tries to insert. Calling code that follows the doc comment
  is broken at runtime.
- **Evidence.** Reproduced 2026-04-28 in the proxy test seed:
  `grantScopes(...).run(...)` raised `FOREIGN KEY constraint
  failed` and broke `beforeAll`. Working around it by NOT calling
  `grantScopes` for narrow scopes restored the suite (and is the
  correct characterization for GAP-008 anyway).
- **Disposition.** `file-task` — bundle with the GAP-008 fix.
  Two consistent options:
  (a) Drop the narrow-regex carve-out from `validateScope`;
      accept only broad scopes. Document narrow scopes as "not
      supported".
  (b) Keep the narrow-regex carve-out and either drop the FK or
      have `grantScopes` synthesize a `scope_definitions` row on
      first grant. This pairs with the GAP-008 fix that makes
      `hasScope` actually expand the narrow scope.
  Option (b) implements the documented hierarchy; (a) walks it
  back. The decision belongs in the same ADR that resolves
  GAP-008.
- **Status.** `open`
- **Notes.** This is a "trust your own internal API" defect.
  `grantScopes` callers (`src/scripts/init-db.js`,
  `src/index.js` token-create handlers) currently dodge it by
  only granting broad scopes; the narrow regex is therefore dead
  code today.

### GAP-010 — Service catalog seed is dead code at boot

- **Discovered.** 2026-04-28
- **Layer.** L1 supertest setup
  (`src/tests/services-execute-behavioral.test.js`, GAP found while
  setting up the connection-gate test against `serviceName='google'`)
- **Endpoint / area.** Boot path in `src/database.js:743-744` —
  `seedServiceCategories();` and `seedServices();` calls are
  commented out with `// TODO: MongoDB version` notes.
- **Severity.** **P1** (capability not wired; agent-facing
  endpoints return 404 on every clean boot).
- **Description.** The service catalog
  (`service_categories` + `services` rows for google / github /
  slack / etc.) is **not** populated on a fresh boot. Both
  `seedServiceCategories` and `seedServices` are exported and
  contain the canonical 40+ provider list, but they are never
  called. Practical impact: `POST /api/v1/services/google/execute`
  always returns 404 `Service not found` — even with master auth
  and a connected OAuth row — until something else writes the
  catalog. The dashboard's "Connect Google" flow may also be
  broken; `GET /api/v1/services` would return an empty list to
  any UI fetch. Pre-F6 this was hidden because no behavioral test
  ever called `getServiceByName('google')`.
- **Evidence.** `src/database.js:743-744`:
  ```
  // seedServiceCategories(); // TODO: MongoDB version
  // seedServices();           // TODO: MongoDB version
  ```
  The L1 execute suite reproduced 404s on every gate that runs
  past the lookup until `seedServiceCategories(); seedServices();`
  was added to the suite's `beforeAll`. After: 9 / 9 green.
- **Disposition.** `file-task` — restore the boot-time calls
  (or reach a different decision: "the catalog should come from
  `oauth.json` only", in which case delete the seed code). The
  immediate fix is one line; the open question is whether the
  catalog should be *static* (current code), *config-driven*
  (`oauth.json`), or *DB-only with explicit operator action*. Pick
  one. Bundle into M9 / M14 docs + admin path or earlier if a
  user reports the dashboard listing is empty.
- **Status.** `open`
- **Notes.** Until restored, every F6 L1 / L2 suite that touches
  `/services/:name/{execute,proxy}` for a real connected service
  must call `seedServiceCategories(); seedServices();` in its
  setup. The proxy suite avoided this only because it tests the
  "not connected" case (which returns 403 *before* the
  `serviceRecord` lookup matters for OAuth lookup — the proxy's
  failure mode is `oauth_tokens` row absence, not `services` row
  absence).

### GAP-011 — Duplicate `GET /api/v1/handshakes/:id/status` handler (second is unreachable)

- **Discovered.** 2026-04-28
- **Layer.** static review during L1 supertest
  (`src/tests/handshake-flow-behavioral.test.js`, suite §6)
- **Endpoint / area.** `GET /api/v1/handshakes/:id/status`
- **Severity.** **P2** (dead code; not a security issue but a
  correctness/maintenance trap — a future hotfix to "the status
  handler" risks editing the wrong copy).
- **Description.** Two handlers register the same path:
  - `src/index.js:7778` — returns
    `{ handshakeId, status, requestedScopes, createdAt, message }`
    where `message` is state-dependent ("pending", "approved",
    "denied"). This is the one Express 5 routes to.
  - `src/index.js:7847` — returns
    `{ handshakeId, status, createdAt, updatedAt }`. Never
    reached because the earlier registration wins.
  The two response shapes are different. The agent runbook
  references the first shape ("Returns `{ status: pending |
  approved | denied }`") which is also what the live handler
  returns; so this is purely dead-code residue from a copy-paste
  rather than a behavioral conflict today. But if anyone ever
  reorders the registrations or refactors out the handlers
  defensively, the second handler's narrower body would silently
  start serving — and break the runbook + L3 walkthrough.
- **Evidence.** `src/index.js:7778-7796` and `:7847-7853`. The
  L1 suite locks the count at two and `npm test` is green
  against today's behavior.
- **Disposition.** `file-task` — delete `src/index.js:7847-7853`
  as part of the M6 monolith extraction (the surface only has one
  legitimate handler). Until then, the L1 test pin prevents the
  count from drifting upward.
- **Status.** `open`
- **Notes.** No data-model fix needed; pure code cleanup.

> _The next entry will be `GAP-012`. Each F6 work step (per the
> plan §5) appends below this line as it surfaces things._

