# F10 — Service catalog seed wiring

> **Status.** Filed 2026-04-28 from F6.7 triage. Closes `GAP-010`.

## Context

`src/database.js:743-744`:

```js
// seedServiceCategories(); // TODO: MongoDB version
// seedServices();           // TODO: MongoDB version
```

Both calls are commented out with a `TODO: MongoDB version` note
that has been there since the MongoDB experiment. The exported
functions `seedServiceCategories` and `seedServices` are still
present and contain the canonical 40+ provider list with
`ON CONFLICT DO NOTHING` so re-runs are safe.

Practical impact today: the `services` table is **empty on every
clean boot**. `getServiceByName('google')` returns `undefined`,
so `POST /api/v1/services/google/execute` always returns 404
`Service not found` — even with master auth and a connected OAuth
row.

The L1 suite `services-execute-behavioral.test.js` works around it
by calling `seedServiceCategories(); seedServices();` in
`beforeAll`. That workaround is acceptable for the test layer but
not for production.

## Decision

Three consistent options:

### Option (a) — restore the calls (smallest diff)

Uncomment the two lines + delete the `TODO` notes. The catalog is
populated on every boot just like before the MongoDB experiment.

- Pro: one-line diff per call.
- Pro: matches what `oauth.json` advertises.
- Con: catalog is hard-coded in JS; new providers require code change.

### Option (b) — config-driven seed from `oauth.json`

Read `src/config/oauth.json` at boot and seed the catalog from it.
Drop the JS catalog list.

- Pro: single source of truth for providers.
- Pro: new providers land via config edit.
- Con: more code; needs schema for `oauth.json`.

### Option (c) — remove seed entirely

Treat `services` as a DB-only table with explicit operator
admin path (`POST /api/v1/services` master-only). Update the
dashboard to fetch the catalog from the DB and provide an "add
service" UI.

- Pro: the gateway becomes truly self-hosted with no shipped
  catalog.
- Con: most code; needs the admin path + UI; ships an empty
  product on first boot.

## Recommendation

**Option (a)** for the next release — un-block dashboard /
execute / proxy / ask immediately. **Option (b)** as the M14
follow-up when the docs sweep happens (`oauth.json` already exists
and is partially used; consolidating is natural there). **Option
(c)** if/when an operator asks for it.

## Acceptance criteria

- The two `seedServiceCategories(); seedServices();` calls live in
  the boot path (probably right after `migrationRunner` finishes,
  in `src/database.js`'s init function or in `src/index.js`'s
  bootstrap).
- The `services-execute-behavioral.test.js` workaround
  (`beforeAll(() => { seedServiceCategories(); seedServices(); })`)
  is removed in the same change. The test passing without the
  workaround IS the sign-off.
- `GAP-010` row in `capability-gaps.md` marked `resolved` with
  the closing commit + a one-line note.

## Effort

XS — half a day end-to-end including the test cleanup. This is
the smallest open item in the F-backlog.

## Depends on / Blocks

- Depends on: nothing. Can ship today.
- Blocks: nothing on the M-numbered roadmap.
- Related: `services-execute-behavioral.test.js`,
  `oauth.json`, `agent-real-life.md` runbook (which assumes the
  catalog is populated when it instructs the operator to "Connect
  Google" through the dashboard).
