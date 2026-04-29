# Runbook — Agent real-life walkthrough (L3)

**Last updated:** 2026-04-28 (F6 bootstrap; pre-script — `scripts/agent-walkthrough.mjs` lands when agent mode is enabled)
**Scope:** Walk through MyApi the way an external AI agent (OpenClaude, Hermes, etc.) would: with **only a bearer token** and **only the public HTTP surface**. Proves the gateway is usable from the outside, not just internally instrumentable.

This is the **L3** layer of the F6 test plan
(`.cursor/plans/capability_test_plan_b4523725.plan.md` §3.3). L1 is
in-process supertest under `npm test`; L2 is gated live-smoke under
`npm run smoke:agent`. L3 is **manual** — sign-off on F6 requires walking
this once before declaring the gateway ready for an external agent.

The runbook reuses the `docker:smoke` harness from the M3 wrap-up
(`.context/runbooks/manual-smoke.md`); read that first if you've never
booted the smoke stack.

---

## TL;DR

```bash
# One-time setup (mirrors manual-smoke.md):
cp .env.smoke.example .env.smoke

# Boot + seed:
npm run docker:smoke              # boot the gateway
npm run docker:smoke:init         # seed master token; copy it from stdout
# Open http://localhost:4500/dashboard/, sign in as the master, connect
# Google + GitHub through Settings → Service Connectors. Wait for both
# rows to show "connected" on /oauth/status.

# Mint a scoped agent token:
curl -sS -X POST http://localhost:4500/api/v1/tokens \
  -H "Authorization: Bearer ${MASTER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"f6-walkthrough","scopes":["services:google:read","services:github:read"]}' \
  | jq -r '.token'
# → copy the result into AGENT_BEARER

# Walk the agent path (script lands with F6.2 in agent mode):
SMOKE_URL=http://localhost:4500 \
SMOKE_BEARER=${AGENT_BEARER} \
node scripts/agent-walkthrough.mjs

# Tear down:
npm run docker:smoke:down
```

If every step in the script prints `OK`, the gateway is L3-ready for an
external agent. Any `FAIL` line is a candidate for `.context/capability-gaps.md`.

---

## Prerequisites

- `docker:smoke` already runs cleanly on this host
  (`.context/runbooks/manual-smoke.md` § Prerequisites).
- A Google OAuth dev project with an authorized redirect URI of
  `http://localhost:4500/api/v1/oauth/callback/google`.
- A GitHub OAuth app with the same callback URL pattern. **Identity
  scopes only** for first run (per ADR-0018 / F4) — service scopes
  come on the second pass.
- `jq` and `curl` on the host. Node 20+ on the host **only** if you
  want to run `scripts/agent-walkthrough.mjs` outside of Docker
  (everything else is Dockerized).

---

## Phase 0 — Boot the gateway and seed master

Same as `manual-smoke.md`:

```bash
cp .env.smoke.example .env.smoke
# Paste real GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
# GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET into .env.smoke
npm run docker:smoke
npm run docker:smoke:init       # capture the printed master token
```

Sanity:

```bash
curl -sS http://localhost:4500/health      # → {"status":"ok",...}
curl -sS -H "Authorization: Bearer ${MASTER_TOKEN}" \
  http://localhost:4500/api/v1/services | jq '.[] | .name' | head
```

If `/health` is not `200`, stop. Anything below assumes a green smoke
stack.

---

## Phase 1 — Connect Google and GitHub as the human owner

Open `http://localhost:4500/dashboard/` in a real browser, sign in as
the master (the master token bootstraps the owner session). Go to
**Settings → Service Connectors**, click **Connect** on Google, complete
the OAuth round-trip, **complete the M3 confirm gesture**, repeat for
GitHub.

After both, verify:

```bash
curl -sS -H "Authorization: Bearer ${MASTER_TOKEN}" \
  http://localhost:4500/api/v1/oauth/status | jq
```

Expected: both `google` and `github` show `state: "connected"`. If
either shows `reauth_required`, see ADR-0017 — that's a separate F3
recovery path, not an F6 finding.

---

## Phase 2 — Mint a scoped agent token

The agent does **not** get the master token. It gets a scoped token
with the minimum scopes for what it needs to do.

```bash
curl -sS -X POST http://localhost:4500/api/v1/tokens \
  -H "Authorization: Bearer ${MASTER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "f6-walkthrough",
    "description": "F6 L3 agent walkthrough; revoke after run",
    "scopes": ["services:google:read", "services:github:read", "skills:read"]
  }' | tee /tmp/f6-token.json
```

Capture the raw token from the response (it's only shown once on
create). Store it in `AGENT_BEARER`:

```bash
export AGENT_BEARER=$(jq -r '.token' /tmp/f6-token.json)
```

`AGENT_BEARER` is what the rest of the runbook uses. The master token
should not appear again past this point.

---

## Phase 3 — Capability discovery (read-only, agent perspective)

The agent's first move is "what can I do?". Hit the discovery
endpoints with **only** the scoped bearer:

```bash
curl -sS -H "Authorization: Bearer ${AGENT_BEARER}" \
  http://localhost:4500/api/v1/capabilities | jq

curl -sS -H "Authorization: Bearer ${AGENT_BEARER}" \
  http://localhost:4500/api/v1/tokens/me/capabilities | jq

curl -sS http://localhost:4500/openapi.json | jq '.info, .paths | keys | length'

curl -sS http://localhost:4500/llms.txt | head -40
```

What to look for:

- `/capabilities` and `/tokens/me/capabilities` are populated with
  endpoint entries that **match the scoped token's allowed list**.
  If they leak entries the token cannot actually call, that's a
  P1 gap → append to `capability-gaps.md`.
- `/openapi.json` should advertise `/api/v1/services/{service}/proxy`,
  `/api/v1/services/{service}/execute`, and `/api/v1/ask` at minimum.
- `/llms.txt` should not promise the agent endpoints the scoped
  token cannot reach. (See `GAP-003` for the
  `/api/v1/gateway/context` mismatch — expect that one to surface
  here.)
- Try `GET /api/v1/gateway/context` with the agent bearer:

  ```bash
  curl -sS -i -H "Authorization: Bearer ${AGENT_BEARER}" \
    http://localhost:4500/api/v1/gateway/context | head -1
  ```

  Today this returns **403** even though `llms.txt` advertises it.
  That's `GAP-003`; capture the response body in the ledger if it
  changes.

---

## Phase 4 — Use a credential without seeing it (the core promise)

This is the cardinal F6 assertion: the agent makes a successful third-party
API call without ever having held the OAuth token.

### 4.a — Google (Gmail profile read)

```bash
curl -sS -H "Authorization: Bearer ${AGENT_BEARER}" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:4500/api/v1/services/google/proxy \
  -d '{
    "method": "GET",
    "path": "/gmail/v1/users/me/profile"
  }' | jq
```

Expected: a JSON body containing `emailAddress`, `messagesTotal`, etc.
The body **must not** contain `access_token` or any field that looks
like a credential. If it does, that's a P0 leak → append to
`capability-gaps.md` immediately, stop the runbook, file a security
regression test before touching anything else.

### 4.b — GitHub (current user read)

```bash
curl -sS -H "Authorization: Bearer ${AGENT_BEARER}" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:4500/api/v1/services/github/proxy \
  -d '{
    "method": "GET",
    "path": "/user"
  }' | jq '.login, .id, .email'
```

Expected: the master's GitHub login. Same credential-leak check as 4.a.

### 4.c — Confirm the agent never sees the raw token

```bash
# This MUST fail — the agent has no scope for /api/v1/tokens management:
curl -sS -i -H "Authorization: Bearer ${AGENT_BEARER}" \
  http://localhost:4500/api/v1/tokens | head -1

# This MUST also fail — there is no "give me my OAuth token" endpoint:
curl -sS -i -H "Authorization: Bearer ${AGENT_BEARER}" \
  http://localhost:4500/api/v1/oauth/tokens | head -1
```

Both should return 401 / 403 / 404. A 200 here is a P0 ledger entry.

---

## Phase 5 — Scope enforcement (negative tests)

Each of these MUST return 401 / 403:

```bash
# Wrong scope (agent has services:google:read, not services:google:write):
curl -sS -i -H "Authorization: Bearer ${AGENT_BEARER}" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:4500/api/v1/services/google/proxy \
  -d '{"method":"POST","path":"/gmail/v1/users/me/messages/send","body":{}}' \
  | head -1

# No scope at all for Slack:
curl -sS -i -H "Authorization: Bearer ${AGENT_BEARER}" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:4500/api/v1/services/slack/proxy \
  -d '{"method":"GET","path":"/api/auth.test"}' | head -1

# Admin-only:
curl -sS -i -H "Authorization: Bearer ${AGENT_BEARER}" \
  http://localhost:4500/api/v1/admin/users | head -1
```

Each non-401/403 is a P0 ledger entry.

---

## Phase 6 — SSRF defense in depth

The agent MUST NOT be able to use the proxy to reach internal targets:

```bash
for target in 127.0.0.1 169.254.169.254 localhost 0177.0.0.1 2130706433; do
  echo "=== ${target} ==="
  curl -sS -i -H "Authorization: Bearer ${AGENT_BEARER}" \
    -H "Content-Type: application/json" \
    -X POST http://localhost:4500/api/v1/services/google/proxy \
    -d "{\"method\":\"GET\",\"baseUrl\":\"http://${target}/\",\"path\":\"/\"}" \
    | head -1
done
```

Each MUST return 4xx with an SSRF rejection in the body. Any 2xx /
upstream-error result is a P0 entry. (M5 closes this surface
properly; F6 is the regression check that the today-state does not
silently regress before M5 lands.)

---

## Phase 7 — Handshake / agent onboarding (no token to start)

This phase tests the agent-onboards-itself path: the agent has no
credentials yet, requests access via a public handshake, the owner
approves, and a token is issued.

```bash
# As an "agent" with no credentials:
HANDSHAKE=$(curl -sS -X POST http://localhost:4500/api/v1/handshakes \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "f6-walkthrough-agent",
    "requestedScopes": ["read"],
    "message": "F6 L3 manual walkthrough"
  }' | jq -r '.id')

echo "handshake id = ${HANDSHAKE}"

# Poll status (still pending):
curl -sS http://localhost:4500/api/v1/handshakes/${HANDSHAKE}/status | jq

# As the owner: approve via the dashboard or by API:
curl -sS -X POST http://localhost:4500/api/v1/handshakes/${HANDSHAKE}/approve \
  -H "Authorization: Bearer ${MASTER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"scopes":["services:google:read"]}'

# Agent re-polls and now sees the token:
curl -sS http://localhost:4500/api/v1/handshakes/${HANDSHAKE}/status | jq
```

What to verify:

- The poll-without-auth path works (the agent has no token until
  approval).
- The approve path is master-only.
- The status payload after approval contains a usable bearer string.
- The bearer string is **not** the master token. (If it is, that's a
  P0 ledger entry.)
- The handshake row's `user_id` is `'owner'` literal — that's
  `GAP-005`, expected for now.

---

## Phase 8 — Skills metadata (read-only, agent-discoverable)

Skills today are content/metadata, not executable (see
`.context/decisions/ADR-0020` § "What exists today" and
`.cursor/plans/capability_test_plan_b4523725.plan.md` §1).

```bash
curl -sS -H "Authorization: Bearer ${AGENT_BEARER}" \
  http://localhost:4500/api/v1/skills | jq '.[] | {id, name, version}'
```

Expected: the agent can list its workspace's skills (under the
`skills:read` scope). It cannot invoke them — there is no skill-runner
today. If a future skill execution endpoint surfaces, F6 will add a
phase here.

---

## Phase 9 — Tear down

```bash
# Revoke the walkthrough token (do not leave it sitting):
curl -sS -X DELETE \
  -H "Authorization: Bearer ${MASTER_TOKEN}" \
  http://localhost:4500/api/v1/tokens/$(jq -r '.id' /tmp/f6-token.json)

# Stop the smoke stack:
npm run docker:smoke:down
```

Optionally, wipe `./data/` if you want a clean DB before the next
run.

---

## Sign-off checklist

- [ ] Phase 3 — `/capabilities` returned a manifest narrowed to the
      agent's scopes.
- [ ] Phase 4.a + 4.b — both real provider calls returned data, no
      raw token leaked.
- [ ] Phase 4.c — token-management endpoints rejected the agent.
- [ ] Phase 5 — every wrong-scope call returned 401/403.
- [ ] Phase 6 — every SSRF target rejected.
- [ ] Phase 7 — handshake → approval → scoped token round-trip
      returned a usable, non-master bearer.
- [ ] Phase 8 — skills metadata listing succeeded under
      `skills:read`.
- [ ] Phase 9 — token revoked, stack torn down.
- [ ] Any deviation from "expected" written into
      `.context/capability-gaps.md` with severity, evidence, and
      disposition.

A green sign-off means the gateway passes the F6 L3 gate and is
**eligible for connection to a real external agent** (OpenClaude,
Hermes, …) for the scopes you minted. It does not mean the gateway is
production-ready; that needs M5 + M9 + M14.
