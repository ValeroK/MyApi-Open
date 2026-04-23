# Runbook — Manual Smoke Test (Docker-first)

**Last updated:** 2026-04-21 (M3 Step 3 landed; Step 4 pending)
**Scope:** How to boot the running MyApi application inside Docker,
exercise the HTTP surface by hand, and run the Jest suite inside a
throw-away container. Everything here runs in Docker; nothing requires
Node, Python, or native build tools on the host.

---

## TL;DR

```bash
# One-time:
cp .env.smoke.example .env.smoke

# Manual smoke session:
npm run docker:smoke             # boot the app in the background
npm run docker:smoke:init        # seed the access_tokens row (prints the master token)
npm run docker:smoke:logs        # tail nodemon output in another terminal
# ... curl endpoints / open http://localhost:4500/dashboard/ ...
npm run docker:smoke:down        # tear it down

# CI-grade test run:
npm run docker:test              # full Jest suite in Docker
npm run docker:test:oauth        # just the M3 OAuth state / PKCE suites
npm run docker:test:integration  # supertest-driven handler suites
```

---

## Prerequisites

- Docker Desktop (Windows / macOS) or Docker Engine 20.10+ running.
- Ports 4500 free on the host.
- Roughly 1.5 GB free disk for the `myapi:smoke` + `myapi:test` images.
- No Node install required on the host.

---

## One-time setup

1. **Create the smoke env file.**

   ```powershell
   # Windows / PowerShell
   Copy-Item .env.smoke.example .env.smoke
   ```
   ```bash
   # macOS / Linux / Git Bash
   cp .env.smoke.example .env.smoke
   ```

   The committed template already includes valid, non-banned test-grade
   secrets, so the app boots without further edits. If you want to smoke
   a real OAuth provider, paste its client id / secret into
   `.env.smoke` now (leave the flag `ENABLE_OAUTH_<PROVIDER>=true`).

2. **Create the host data dir.** This is where the SQLite DB lives
   across restarts. The compose file bind-mounts it into `/app/data/`.

   ```powershell
   New-Item -ItemType Directory -Path data -Force | Out-Null
   ```
   ```bash
   mkdir -p data
   ```

`.env.smoke` and `data/` are both git-ignored.

---

## Boot → smoke → tear down

### 1. Bring the container up

```bash
npm run docker:smoke
```

Equivalent to
`docker-compose -f docker-compose.smoke.yml up -d --build`. First run
takes ~90-120s (pulls node:22, installs deps, builds the dashboard).
Subsequent runs are seconds (layer cache).

### 2. Verify it is healthy

```bash
docker ps --filter "name=myapi-smoke" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
# Expect:  myapi-smoke   Up ... (healthy)   0.0.0.0:4500->4500/tcp
```

Or curl the health endpoints from the host:

```bash
curl -s http://localhost:4500/health       | jq .
curl -s http://localhost:4500/api/v1/health | jq .
```

Both should return `200` with a JSON body. If `health` is `200` but
`/api/v1/health` 404s, the router is not mounted — check
`npm run docker:smoke:logs` for the stack trace.

### 3. Seed a master token

The `access_tokens` table starts empty in a fresh `data/` volume. Seed
it via the dedicated CLI (`src/scripts/init-db.js`, rewritten in M2
Step 1 to create a real token via `createAccessToken`):

```bash
npm run docker:smoke:init
```

Equivalent to
`docker exec -it myapi-smoke node src/scripts/init-db.js`. The command
prints the raw master token exactly once — **copy it now**, it is
bcrypt-hashed in the DB and cannot be recovered. Example output:

```
✓ Created master access token (id: at_01JKX...)
  MASTER_TOKEN=myapi_7b92d40f... (64 hex chars)
  Save this token securely — it will not be shown again.
```

Export it for the rest of the session:

```bash
export MASTER_TOKEN='myapi_7b92d40f...'        # bash
$env:MASTER_TOKEN = 'myapi_7b92d40f...'         # PowerShell
```

### 4. Exercise the HTTP surface

Quick sanity set (all should be `200` with a JSON body):

```bash
curl -s -H "Authorization: Bearer $MASTER_TOKEN" \
     http://localhost:4500/api/v1/me | jq .

curl -s -H "Authorization: Bearer $MASTER_TOKEN" \
     http://localhost:4500/api/v1/services | jq .

curl -s -H "Authorization: Bearer $MASTER_TOKEN" \
     http://localhost:4500/api/v1/tokens | jq .
```

### 5. Smoke the OAuth state machinery (after M3 Step 4 lands)

Once Step 4 rewires `/oauth/authorize/:service` to `createStateToken`,
this sequence will confirm the new flow end-to-end without needing a
real upstream provider:

```bash
# 1. Hit authorize with follow-redirects off; capture the Location.
curl -si -H "Authorization: Bearer $MASTER_TOKEN" \
     "http://localhost:4500/api/v1/oauth/authorize/google" | tee /tmp/auth.out | head
# Expect: 302, Location: https://accounts.google.com/o/oauth2/v2/auth?...state=...&code_challenge=...&code_challenge_method=S256

# 2. Extract the state token from the Location.
STATE=$(grep -oE 'state=[^&]+' /tmp/auth.out | head -1 | cut -d= -f2)
echo "state=$STATE"

# 3. Peek at the DB row. The container keeps its own sqlite3 binary.
npm run docker:smoke:shell
# inside the container:
sqlite3 /app/data/myapi.db \
  "SELECT state_token, service_name, length(code_verifier), used_at FROM oauth_state_tokens ORDER BY created_at DESC LIMIT 5;"
# Expect: one row with the same state_token, service_name='google',
#         length(code_verifier) between 43 and 128, used_at=NULL.
exit
```

### 6. Open the dashboard (host-side Vite, not in Docker)

The smoke image (`Dockerfile.dev`) intentionally does NOT build the
React dashboard — keeping the image small and rebuilds fast. For
dashboard UI testing, run Vite on the host against the containerised
API:

```bash
cd src/public/dashboard-app
npm install            # first time only
npm run dev            # :5173, proxies /api/* → http://localhost:4500
```

Then browse to http://localhost:5173/. The login page proxies all
`/api/*` calls to the containerised backend on :4500, so the master
token seeded by `docker:smoke:init` works directly.

If you want the full "single container" experience with
`/dashboard/` served by the backend, use the production compose
instead (`docker-compose -f docker-compose.prod.yml`) — but it has
its own prerequisites (`.env` with real secrets, the root
`Dockerfile` frontend-build bug fixed, etc.).

### 7. Watch the logs

```bash
npm run docker:smoke:logs
```

The container runs with `node --watch --watch-path=/app/src`, so
editing any file under `./src/` on the host triggers an automatic
restart of the backend inside the container (the `./src/` bind-mount
makes host edits visible immediately). If a reload is missed on
Windows + Docker Desktop (polling quirks), `docker restart
myapi-smoke` is the fallback.

### 8. Tear down

```bash
npm run docker:smoke:down        # stop + remove container + network
```

The SQLite DB and logs survive in `./data/` and the `myapi-smoke-logs`
volume — bring the stack back up and your master token still works.

To start from scratch:

```bash
npm run docker:smoke:down
docker volume rm myapi-open_myapi-smoke-logs   # name may vary by working dir
rm -rf data/                                   # or Remove-Item -Recurse -Force data
```

---

## Running the test suite in Docker

### Full Jest suite

```bash
npm run docker:test
```

Expands to
`docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from myapi-test`.
Runs against `:memory:` SQLite, so it never touches the host file
system and can't hit the Windows `EBUSY` flake we sometimes see when
unlinking `tmp-*.sqlite` files between tests. Exits non-zero if any
test fails.

### Narrower slices

```bash
npm run docker:test:integration
# Runs: integration.test.js, security-regression.test.js,
#       oauth-*.test.js, scope-isolation.test.js, token-update.test.js,
#       phase3.audit-security.test.js

npm run docker:test:oauth
# Runs: oauth-state-*.test.js + oauth-security-hardening.test.js +
#       oauth-signup-flow.test.js
```

### Iterating on a single file

```bash
docker-compose -f docker-compose.test.yml run --rm myapi-test \
  npx jest src/tests/oauth-state-domain.test.js --watch
```

`--rm` auto-removes the container when you Ctrl-C out. `--watch` is
fine because the compose file bind-mounts `./src/` so your host edits
are visible inside the container.

---

## Known gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED :4500` from the host | Container still booting / not healthy | `docker ps` — wait for `(healthy)`, or check logs for a boot error |
| `docker-compose: command not found` | Compose V2 on some systems | Use `docker compose` (no hyphen) — aliases still resolve |
| `node --watch` doesn't restart on save (Windows) | Docker Desktop bind-mount file-event polling is slow | Restart the container: `docker restart myapi-smoke` |
| `SECRET VALIDATION FAILED` on boot | `.env.smoke` is missing or was edited to a banned default | `cp .env.smoke.example .env.smoke` again, or pick new non-banned values |
| DB file survives `docker:smoke:down` and breaks after a schema change | SQLite file in `./data/` is from a prior commit | `rm -rf data/ && npm run docker:smoke:init` to re-seed |
| Tests pass on host but fail in Docker (or vice versa) | Different `better-sqlite3` native build | `docker:test` rebuilds the native binding inside the image — trust the Docker result |
| `GET /api/v1/me` returns 403 `DEVICE_APPROVAL_FAILED` with `FOREIGN KEY constraint failed` | Pre-existing bug in device-approval middleware (issue not in scope of M3) | Not a scaffolding issue — it reproduces on the host too. Use endpoints that skip device approval (e.g. `/api/v1/services`) to validate auth works. Tracked for a separate fix. |

---

## What each compose file is for

| File | Target | `npm` alias | Notes |
|---|---|---|---|
| `docker-compose.yml` | Legacy single-service dev (to be retired) | `npm run docker:up` | Bind-mounts a file-path for SQLite (anti-pattern). Kept for backwards compat. |
| `docker-compose.dev.yml` | Hot-reload dev (legacy, mentions MongoDB) | `npm run docker:dev` | Pre-M1 artefact; its comment block still references MongoDB which M1 deleted. Prefer `docker-compose.smoke.yml`. |
| `docker-compose.prod.yml` | Production single-container deploy | (none) | `.env` + `./data` bind mount + optional Cloudflare tunnel |
| **`docker-compose.smoke.yml`** | **Manual smoke harness** | **`npm run docker:smoke*`** | **This runbook's default.** |
| **`docker-compose.test.yml`** | **One-shot Jest runner** | **`npm run docker:test*`** | **CI-grade; `:memory:` DB.** |

Cleaning up the legacy dev compose files is a separate commit
scheduled as part of the M3 wrap-up (`id: m3-wrap`).

---

## Cross-references

- `.context/decisions/ADR-0014-m3-oauth-state-hardening-plan.md` — why
  we are investing in integration coverage for OAuth state.
- `src/tests/security-regression.test.js` — the template to copy for
  new supertest-driven integration tests in Steps 4+.
- `src/server.js` — the 7-line shim that lets `require('../server')`
  bootstrap the app for tests.
- `.env.smoke.example` — committed template with non-banned smoke
  secrets; safe to copy, NEVER safe to use in production.
