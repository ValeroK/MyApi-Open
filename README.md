<p align="center">
  <img width="256" alt="MyApi Logo" src="src/public/dashboard-app/public/myapi-logo-1024.png">
</p>

# MyApi — The Privacy-First Personal API Platform & AI Agent Gateway

[![CI](https://github.com/omribenami/MyApi-Open/actions/workflows/ci.yml/badge.svg)](https://github.com/omribenami/MyApi-Open/actions/workflows/ci.yml)
[![License: AGPL-3.0 + Commons Clause](https://img.shields.io/badge/license-AGPL--3.0%20%2B%20Commons%20Clause-orange.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-supported-2496ed)](https://docs.docker.com)
[![Discord](https://img.shields.io/badge/discord-join-5865f2)](https://discord.gg/WPp4sCN4xB)

## 🚀 Managed Cloud Version: [myapiai.com](https://www.myapiai.com)

**Don't want to self-host?** The official managed version at **[myapiai.com](https://www.myapiai.com)** offers cloud hosting with automatic backups, SSL, email, and always-up-to-date features.

👉 **[Visit myapiai.com](https://www.myapiai.com)** to get started instantly.

---

Connect your services once. Issue scoped tokens to AI agents. Keep full control over who accesses what — with a full audit trail of every action.

## Why MyApi?

Most AI agent setups suffer from the same fundamental flaws: raw credentials scattered across local environments, zero audit trails, and the inability to revoke access without rotating every key you own. Whether you're using **OpenClaw**, **Hermes**, or **Claude Code**, your security is only as strong as your last `.env` file.

**MyApi flips the equation.** Instead of configuring every agent individually, MyApi acts as a privacy-first gateway and central hub between your sensitive data and the agents that use it. Connect your services once; authorize your agents forever.

### Core Advantages

* **Unified Connection:** Your agents across different platforms share the same data and services seamlessly.
* **Agent Management:** Centrally manage personas, specialized skills, and knowledge bases from a single dashboard.
* **Multiple Agents — One Brain:** Ensure all your agents have a consistent "memory" and context by connecting them to a single source of truth.
* **Shareable Scoped Tokens:** Grant an agent access to a **"Bundle"** (Persona + unique skills + unique knowledge base) rather than giving them raw, unfettered access to your entire infrastructure.
* **Secure Infrastructure:** Provide agents with a hardened connection to your services and workstations via one secure, audited API.
* **Instant Revocation:** End access for a single agent or tool instantly without touching your primary service credentials.

<p align="center">
<img width="1268" height="1080" alt="image" align="center" src="https://github.com/user-attachments/assets/62ebccc0-2b70-4097-b9db-59672f5b19ab" />
</p>

You connect your services (Google, GitHub, Slack, and 30+ more) through MyApi once. Agents get a scoped token — or better yet, authenticate via **cryptographic keypair signing (ASC)** so no raw secret ever crosses the wire. Your credentials are never exposed, every action is logged, and a one-click ZIP export means your entire agent setup is always backed up and portable.

---

## Features

| Feature | Description |
|---|---|
| **OAuth Aggregation** | Connect 30+ (and counting) services (Google, GitHub, Slack, Notion, Salesforce, Jira...) in one place. Tokens auto-refresh. Agents proxy through MyApi — never touch credentials. OAuth flows are DB-backed (single-use PKCE state rows, 10-min TTL, background prune) and a user-driven confirm gesture gates every first-seen provider identity — no silent logins, no session fixation. See [SECURITY.md](SECURITY.md#oauth-state--pkce-m3). |
| **AI Agent Gateway** | Issue scoped Bearer tokens to any AI agent. First access requires your approval. Every request is logged. |
| **Persona System** | Multiple AI identities, each with its own soul content (SOUL.md), attached knowledge docs, and skills. Active persona shapes every API response. |
| **Knowledge Base** | Upload or write Markdown/PDF documents. Attach them to specific personas for grounded, contextual responses. |
| **Skills & Marketplace** | Build reusable capability modules. Install community skills from the marketplace. Publish your own. |
| **Token Vault** | AES-256-GCM encrypted storage for third-party API keys (OpenAI, Stripe, AWS, etc.). Rotate once, updated everywhere. |
| **AFP Connector** | API File Protocol — desktop daemon (Windows/macOS/Linux) for persistent local agent connections with scoped filesystem and shell access. |
| **ASC — Secure Agent Auth** | Agentic Secure Connection — agents authenticate via Ed25519 keypair signing instead of raw tokens. Signatures are timestamp-bound; replayed requests are rejected within 60 seconds. |
| **Backup & Import** | One-click ZIP export of your full agent ecosystem (personas, knowledge, skills, memory). Import back on any instance in seconds. Checksums included. |
| **Team Workspaces** | Multi-tenancy with Owner/Admin/Member/Viewer roles. Fully isolated contexts per workspace. |
| **Device Management** | Every new device (browser, CLI, AFP daemon, ASC agent) requires approval before access. Revoke instantly. |
| **Immutable Audit Log** | Append-only log of every API action — what, when, by which token, with what result. |
| **2FA & Scoped Tokens** | TOTP-based two-factor auth, session management, and fine-grained token scopes (`basic`, `knowledge`, `services:write`, etc.). |

---

## Architecture

<p align="center">
  <img width="512" src="https://github.com/user-attachments/assets/5bf8bf21-dfca-4afe-b724-9cee6eab8470" alt="MyApi Stack">
</p>

Three-tier: **React dashboard → Express API gateway → SQLite (or PostgreSQL)**. The gateway (`src/index.js`) is the single entry point for every agent request, every OAuth callback, and every dashboard action.

### What MyApi stores

| Table | Contents | Encryption |
|---|---|---|
| `oauth_tokens` | Access + refresh tokens from the 45+ OAuth providers you connect (Google, GitHub, Slack, …) | AES-256-GCM (`ENCRYPTION_KEY`) |
| `vault_tokens` | Manually-added API keys (OpenAI, Stripe, AWS, any custom API) | AES-256-GCM (`VAULT_KEY`) |
| `access_tokens` | Scoped Bearer tokens issued **to agents** (`myapi_…`) | bcrypt-hashed |
| `audit_log` | Every API request — who, what, when, from-IP, user-agent | — |

### How a request flows

```
Request → auth middleware → scope validator → RBAC → device approval gate
        → route handler → database layer (src/database.js) → response
```

For an agent request to an external service (the hot path), this expands to:

```
 Agent (OpenClaw, ChatGPT, Claude Code, …)
   │
   │ POST /api/v1/services/github/proxy
   │ Authorization: Bearer myapi_xxx...
   │ Body: { path: "/user/repos", method: "GET" }
   ▼
 MyApi gateway
   1. authenticate()              — bcrypt-compare against access_tokens
   2. scope-validator              — require services:read / services:write
   3. deviceApproval gate          — block until user approves in dashboard
   4. rate-limit check             — per-user, per-service
   5. getOAuthToken() + refresh    — decrypt, auto-refresh if expired
   6. SSRF guard                   — reject private/internal targets
   7. upstream HTTPS call          — attach real credential server-side
   8. audit_log INSERT             — full trail with user-agent (e.g. "OpenClaw")
   │
   ▼
 GitHub / Google / OpenAI / …     ← the real key only exists between step 5 and 7
   │
   ▼
 Upstream JSON response → returned to the agent (key never revealed)
```

**The security property:** the agent only ever holds `myapi_…`. If it's compromised, you revoke one token in the dashboard — no upstream rotation needed.

---

## Quick Start

### Option A: Docker (Recommended)

```bash
# 1. Clone
git clone https://github.com/omribenami/MyApi-Open.git
cd MyApi-Open

# 2. Configure
cp src/.env.example src/.env
# Edit src/.env — fill in your secrets (see Configuration below)
# Generate secure keys:
#   openssl rand -hex 32

# 3. Start (development — hot reload on both frontend and backend)
docker-compose -f docker-compose.dev.yml up --build
# Dashboard  →  http://localhost:5173
# API        →  http://localhost:4500

# 4. Start (production)
docker-compose -f docker-compose.prod.yml up -d --build
# Dashboard + API  →  http://localhost:4500/dashboard/
```

### Option B: Manual (Node.js 18+)

```bash
# 1. Clone
git clone https://github.com/omribenami/MyApi-Open.git
cd MyApi-Open

# 2. Install dependencies
npm install

# 3. Configure
cp src/.env.example src/.env
# Edit src/.env — fill in your secrets (see Configuration below)

# 4. Start the backend server
node src/index.js
# The database initializes automatically on startup
# API  →  http://localhost:4500
# 👀 Watch console output for the master token!

# 5. Frontend — in a separate terminal
cd src/public/dashboard-app
npm install
npm run dev
# Dashboard  →  http://localhost:5173

# 6. Production build (optional)
# Build the frontend to be served by Express at /dashboard/
npm run build    # output → src/public/dist/
# Then restart the server to serve from the built files
```

---

## First Run

### Getting Your Master Token

On first startup, the server generates a **master token** printed to console logs:

```
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🔐 SAVE THIS TOKEN - IT WILL ONLY BE SHOWN ONCE!           ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Token: myapi_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**This token is your admin password.** Store it securely — it provides full access to your MyApi instance.

#### Finding Your Token

- **Docker:** Check logs with `docker-compose logs myapi | grep "Token:"`
- **Manual install:** Check terminal output where you ran `node src/index.js`

#### If You Lost It

The token is NOT stored anywhere in the database for security. If you lost it:

1. **Stop the server**
2. **Delete the database:** `rm src/data/myapi.db`
3. **Restart** — a new token will be generated
4. **Copy it immediately** — it won't be shown again

### Accessing the Dashboard

1. **Open** `http://localhost:4500/dashboard/` (production) or `http://localhost:5173` (development)
2. **On login screen**, paste your master token into the token field
3. You now have full access — create personas, connect services, manage agents

### After First Login

- Set a user password in Settings (optional, but recommended)
- Create scoped tokens for specific agents/workflows
- Enable 2FA for production instances
- Generate device tokens for programmatic access

---

## Configuration

### Setup Environment File

Copy `src/.env.example` to `src/.env`:

```bash
cp src/.env.example src/.env
```

Then edit `src/.env` with your configuration values. At minimum, you need the encryption/session keys.

### Generate Secure Keys

```bash
# Generate a 32-byte hex key (for ENCRYPTION_KEY, VAULT_KEY, JWT_SECRET, SESSION_SECRET)
openssl rand -hex 32
```

### Required

| Variable | Description |
|---|---|
| `PORT` | Server port (default: `4500`) |
| `NODE_ENV` | `development` or `production` |
| `ENCRYPTION_KEY` | 32-byte hex key — AES-256-GCM encryption for OAuth tokens |
| `VAULT_KEY` | 32-byte hex key — AES-256-GCM vault token encryption |
| `JWT_SECRET` | JWT signing secret |
| `SESSION_SECRET` | Express session secret |

> **Boot-time validation (every `NODE_ENV`).** MyApi calls
> `validateRequiredSecrets()` from `src/lib/validate-secrets.js` at
> startup and **exits with code 1** if any of the four required secrets
> is missing, whitespace-only, or set to a known-insecure value
> (`change-me`, `changeme`, `secret`, `password`,
> `default-vault-key-change-me`, or one of the verbatim placeholders
> shipped in `src/.env.example` such as
> `your-vault-key-here-change-in-production`). Regenerate all four with
> `openssl rand -hex 32` before booting — the gate runs in dev, test,
> staging, and production identically (see ADR-0013 / T2.5).

### Functionally Required

| Variable | Description |
|---|---|
| `BASE_URL` | Public URL of your instance (e.g. `https://your-domain.com`) — used for OAuth callbacks |
| `POWER_USER_EMAIL` | Email address granted User Management access in the dashboard |

### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4500` | Port the API and dashboard listen on |
| `LOG_LEVEL` | `info` | One of `debug` \| `info` \| `warn` \| `error` \| `silent`. Use `debug` to trace request lifecycle + cleanup ticks. |
| `DB_PATH` | `./data/myapi.db` | SQLite database path (relative or absolute) |
| `SESSION_DB_PATH` | `<src>/db.sqlite` | Path to the express-session SQLite store. **Pin this OUTSIDE `src/` for any dev workflow that uses `node --watch`** — see [Trust Proxy & Session DB notes](#trust-proxy--session-db-notes) below. |
| `SESSION_COOKIE_SECURE` | `false` | Set `true` in production (HTTPS terminator in front) |
| `SESSION_COOKIE_DOMAIN` | _(host-only)_ | Your domain (e.g. `.your-domain.com`) — recommended for production multi-subdomain deployments |
| `TRUSTED_PROXIES` | `loopback` | Comma-separated list of CIDRs / IPs / `loopback`/`linklocal`/`uniquelocal` that Express may honor `X-Forwarded-For` from — see [Trust Proxy & Session DB notes](#trust-proxy--session-db-notes) below. |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Requests per window per IP |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window in milliseconds (15 min default) |
| `EMAIL_PROVIDER` | `smtp` | `smtp`, `sendgrid`, or `resend` for outbound email |
| `CORS_ORIGIN` / `ALLOWED_ORIGINS` | _(none)_ | Comma-separated allowed origins (wildcards supported, e.g. `https://*.example.com`). `CORS_ORIGIN` takes precedence if both are set. |
| `OAUTH_PRUNE_INTERVAL_MS` | `600000` | Cadence of the OAuth-state prune job (10 min default; min `1000`) |
| `OAUTH_PRUNE_GRACE_SEC` | `3600` | Seconds an expired/used OAuth state row is retained before becoming eligible for prune |
| `BETA` / `BETA_MAX_USERS` | `true` / `50` | When `BETA=true` caps signups at `BETA_MAX_USERS`, only the Free plan is purchasable, and overflow signups go to a waitlist |

#### Trust Proxy & Session DB notes

These two variables are subtle but high-impact — read carefully if you're
running anything more involved than direct `npm start`.

**`TRUSTED_PROXIES`** — controls how Express resolves `req.ip` from
`X-Forwarded-For`. `req.ip` feeds three security-relevant surfaces:

1. **Rate-limit keys** — per-IP buckets for both global and bearer-token
   limiters. Spoofable IPs ⇒ trivially bypassable rate limits.
2. **Audit log attribution** — every entry in `audit_log.ip` is
   `req.ip`. Spoofable ⇒ falsified evidence in compliance trails.
3. **Security telemetry** — token-creation warnings log `req.ip`.

The default `loopback` is **secure-by-default** — `X-Forwarded-For` is
honored only when the immediate connection is from `127.0.0.1` or `::1`.
Anything from a public client is ignored, and `req.ip` is set to the
real TCP source. Set this to a tighter list for production:

| Topology | Recommended value |
|---|---|
| Direct connection (no proxy) | _leave unset_ |
| Same-host nginx / Caddy / haproxy | `loopback` |
| AWS ALB in 10.x VPC | `loopback,10.0.0.0/16` |
| Cloudflare in front | `loopback,<their published CIDRs>` |
| Docker bridge dev (you want real client IP from host curl) | `loopback,uniquelocal` |
| Paranoid mode (trust nobody) | `none` |

> ⚠️ **Never set `TRUSTED_PROXIES=0.0.0.0/0`** or any wildcard — it
> reintroduces the same vulnerability the secure default closes
> (anyone could send `X-Forwarded-For: 9.9.9.9` and have it land in
> `req.ip`).

The validator (`src/lib/trust-proxy.js`) fails loud at boot if any
entry is malformed, so typos surface immediately.

**`SESSION_DB_PATH`** — pin this OUTSIDE `src/` whenever you run with
`node --watch --watch-path=src` (the dev / smoke harness defaults).
Each authenticated request mutates the session DB via `req.session.save()`,
and Node's watcher treats that mutation as a source change → process
restart → in-flight OAuth code-exchange dies → "redirected back to login
without connecting." Setting `SESSION_DB_PATH=./data/sessions.sqlite`
moves the file out of the watched tree.

In production (no `--watch`), this is purely cosmetic and you can leave
it on the default — but pinning it under your `data/` directory keeps
backup paths uniform.

### OAuth Service Credentials

OAuth providers follow the pattern `{SERVICE}_CLIENT_ID` / `{SERVICE}_CLIENT_SECRET` with a corresponding `ENABLE_OAUTH_{SERVICE}=true` feature flag. See [`docs/SERVICES_MANUAL.md`](docs/SERVICES_MANUAL.md) for the full configuration reference covering all 45+ supported services.

### Email Configuration

MyApi sends transactional email for password reset links and "your password
was changed" notifications. If no email transport is configured, those
features become no-ops on the server and the dashboard surfaces an amber
banner on the **Forgot Password** and **Settings → Change Password** pages.

The dashboard probes [`GET /api/v1/auth/email-config-status`](src/routes/auth.js)
on mount and shows the banner whenever `configured: false`.

#### Required environment variables

| Variable | Description |
|---|---|
| `EMAIL_FROM` | The "from" address used for every outbound email. **Required for any email feature.** Example: `noreply@your-domain.com` |
| `EMAIL_FROM_NAME` | Optional display name (default: `MyApi`) |
| `EMAIL_PROVIDER` | One of `smtp` (default), `sendgrid`, or `resend` |

#### Per-provider variables

**SMTP (default):**

| Variable | Description |
|---|---|
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP port (typically `587` for STARTTLS or `465` for TLS) |
| `SMTP_SECURE` | `true` for port 465, `false` otherwise |
| `SMTP_USER` | Username (optional — leave unset for relay-without-auth) |
| `SMTP_PASSWORD` | Password (required when `SMTP_USER` is set) |

**Resend:**

| Variable | Description |
|---|---|
| `RESEND_API_KEY` | API key from your Resend dashboard |

**SendGrid:**

| Variable | Description |
|---|---|
| `SENDGRID_API_KEY` | API key from your SendGrid dashboard |

#### Verifying the configuration

After setting the env vars and restarting the server, the dashboard banner
will disappear and you can confirm directly:

```bash
curl http://localhost:4500/api/v1/auth/email-config-status
# → {"configured":true,"provider":"smtp","missing":[]}
```

If `configured: false`, the `missing` array tells you exactly which
variables to set.

---

## Agent Integration

MyApi is designed to be called by AI agents (OpenClaw, Hermes, Claude Code, ChatGPT GPTs, custom MCP clients, …). Agents never handle raw credentials — they hold a scoped `myapi_…` Bearer token and proxy everything through MyApi.

### 1. Enroll the agent (RFC 8628 Device Flow)

```bash
# Agent requests a device code (needs a bootstrap token from the dashboard)
curl -X POST https://your-myapi.com/api/v1/agentic/device/authorize \
  -H "Authorization: Bearer <bootstrap-token>" \
  -H "Content-Type: application/json" \
  -d '{"label":"OpenClaw on laptop","scope":"services:read"}'

# Returns: { user_code: "ABCD-EFGH", verification_uri_complete: "...", device_code: "..." }
# User opens the verification_uri and approves in the dashboard.
# Agent then polls /api/v1/agentic/device/token and receives its final myapi_... Bearer.
```

Optional hardening: the agent can register an **Ed25519 public key** (`POST /api/v1/agentic/asc/register`) and sign each request with `X-Agent-PublicKey` / `X-Agent-Signature` / `X-Agent-Timestamp` (±60 s replay window). This makes a stolen Bearer alone useless.

### 2. Call any connected service through the proxy

```bash
curl -X POST https://your-myapi.com/api/v1/services/github/proxy \
  -H "Authorization: Bearer myapi_xxx..." \
  -H "X-Workspace-ID: <workspace-id>" \
  -H "Content-Type: application/json" \
  -d '{"path":"/user/repos","method":"GET"}'
```

MyApi decrypts your GitHub token, calls `https://api.github.com/user/repos` with it, logs the action, and returns GitHub's JSON. The agent never sees the token.

The same pattern works for every OAuth service (`/services/google/proxy`, `/services/slack/proxy`, `/services/notion/proxy`, …) and for vault-token APIs registered with `auth_type='api_key'` (OpenAI, Stripe, custom APIs).

### 3. Self-describing keys

Each vault token can carry machine-readable usage instructions so agents can learn new APIs without human configuration:

- `GET /api/v1/vault/tokens/:id/instructions` — fetch human/AI-authored usage notes + examples.
- `POST /api/v1/vault/tokens/:id/learn-from-api` — agents can write back auto-discovered usage patterns after a successful call.

### MCP (Model Context Protocol) on-ramp

`src/mcp-server.js` exposes MyApi as an MCP server for Claude Desktop, Cursor, and other MCP clients:

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "myapi": {
      "command": "node",
      "args": ["/path/to/MyApi-Open/src/mcp-server.js"],
      "env": { "MYAPI_USER_ID": "<your-user-id>" }
    }
  }
}
```

> The MCP transport is functional; several per-service handlers currently return placeholder data and are being wired to the REST proxy — track progress in the roadmap.

### Key API endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/services/:name/proxy` | Proxy any HTTP request to a connected OAuth or API-key service |
| `POST /api/v1/ask` | Natural-language intent → service resolution → proxy execution |
| `GET  /api/v1/services/:id/methods` | Discover callable methods for a connected service |
| `POST /api/v1/vault/tokens` | Store a new encrypted API key (master only) |
| `GET  /api/v1/vault/tokens` | List vault tokens (metadata only; secret never returned) |
| `GET  /api/v1/vault/tokens/:id/reveal` | Decrypt a vault secret (master only — escape hatch) |
| `POST /api/v1/agentic/device/authorize` | Begin RFC 8628 Device Flow for an agent |
| `POST /api/v1/agentic/asc/register` | Register an Ed25519 public key for signed-request auth |
| `GET  /api/v1/audit/log` | Immutable audit trail |

The full OpenAPI surface is served at `/api/v1/openapi.json`.

---

## Production / Self-Hosting

MyApi is fully self-hostable. For a production deployment you'll need:

- A server with Docker + Docker Compose (or Node.js 18+)
- A domain with **HTTPS** — e.g. `https://your-domain.com` (nginx + Let's Encrypt, or Cloudflare Tunnel)
- The environment variables above configured for your domain

### Key Production Variables

| Variable | Example |
|---|---|
| `BASE_URL` | `https://your-domain.com` |
| `PUBLIC_URL` | `https://your-domain.com` |
| `SESSION_COOKIE_DOMAIN` | `.your-domain.com` |
| `SESSION_COOKIE_SECURE` | `true` |
| `CORS_ORIGIN` | `https://your-domain.com` |
| `TRUSTED_PROXIES` | `loopback` (same-host nginx) — or your proxy CIDR (ALB / Cloudflare / etc.). Required for correct `req.ip`, audit-log attribution, and rate-limit bucketing once a real proxy is in front. See [Trust Proxy & Session DB notes](#trust-proxy--session-db-notes). |
| `SESSION_DB_PATH` | `/var/lib/myapi/sessions.sqlite` — outside the source tree, alongside your backup target |

### nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4500;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Pair this with `TRUSTED_PROXIES=loopback` in your `.env` so Express
honors the `X-Forwarded-For` nginx adds (because the connection arrives
from `127.0.0.1`, which is in the trust set) but rejects spoofed
forwards from anywhere else. If nginx is on a different host, set
`TRUSTED_PROXIES` to that host's address instead.

See the full deployment guide: [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md)

---

## Roadmap

- Expanded agent capabilities (streaming responses, webhook triggers)
- Additional OAuth providers (target 60+, including more enterprise services)
- Additional enterprise features on [myapiai.com](https://www.myapiai.com)

---

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Run the tests: `npm test` (from repo root)
4. Make sure `cd src/public/dashboard-app && npm run lint` passes
5. Open a pull request against `main`

For security issues, see [`SECURITY.md`](SECURITY.md) for the responsible disclosure process.

---

## Community & Support

- **Discord**: [discord.gg/WPp4sCN4xB](https://discord.gg/WPp4sCN4xB)
- **Issues**: [GitHub Issues](https://github.com/omribenami/MyApi-Open/issues)
- **Documentation**: [`docs/`](docs/) — architecture, API reference, services guide, compliance

---

## Step-by-Step Setup Guide

This section walks you end-to-end through every supported deployment
topology. Pick the one that matches your goal:

| Topology | When to use it | Setup section |
|---|---|---|
| **Local Dev** (Node 18+, no Docker) | Hacking on the codebase, fastest iteration loop | [Local Dev](#1-local-development-nodejs-18) |
| **Docker Compose Dev** | Codebase iteration with realistic networking + frontend hot-reload | [Docker Dev](#2-docker-compose-dev) |
| **Docker Compose Smoke** | End-to-end tests against a running container; what CI uses | [Docker Smoke](#3-docker-compose-smoke) |
| **Docker Compose Production** | Self-hosting on a server (with a reverse proxy in front) | [Docker Production](#4-docker-compose-production) |

All four topologies require the same one-time prerequisite — generating
secrets and copying an env file. Do that first.

### 0. Prerequisites (all topologies)

```bash
# Clone
git clone https://github.com/omribenami/MyApi-Open.git
cd MyApi-Open

# Generate four 32-byte hex secrets
openssl rand -hex 32   # ← paste this as ENCRYPTION_KEY
openssl rand -hex 32   # ← paste this as VAULT_KEY
openssl rand -hex 32   # ← paste this as JWT_SECRET
openssl rand -hex 32   # ← paste this as SESSION_SECRET
```

Boot-time validation will refuse to start the server if any of these
four are missing, blank, or set to a known-insecure placeholder
(`change-me`, `your-vault-key-here-change-in-production`, etc.).

---

### 1. Local Development (Node.js 18+)

Best for: changing backend code rapidly. No Docker, no frontend
hot-reload (you run frontend in a second terminal).

```bash
# 1. Configure
cp src/.env.example src/.env
# Edit src/.env — paste the 4 secrets you just generated.
# Recommended defaults for local dev:
#   NODE_ENV=development
#   PORT=4500
#   LOG_LEVEL=debug
#   DB_PATH=./data/myapi.db
#   SESSION_DB_PATH=./data/sessions.sqlite     # outside src/ — see notes
#   SESSION_COOKIE_SECURE=false
#   POWER_USER_EMAIL=you@example.com
#   ALLOWED_ORIGINS=http://localhost:4500,http://localhost:5173
#   # TRUSTED_PROXIES — leave UNSET (default loopback is correct)

# 2. Install backend deps
npm install

# 3. Start the API (port 4500)
node src/index.js
# 👀 First boot prints the master token. SAVE IT — it's only shown once.
# API → http://localhost:4500
# Dashboard (built bundle) → http://localhost:4500/dashboard/

# 4. (Optional) Frontend dev server with hot reload — separate terminal
cd src/public/dashboard-app
npm install
npm run dev
# Vite dev → http://localhost:5173 (proxies API calls to :4500)
```

**Stopping:** `Ctrl-C` in each terminal. The DB at `./data/myapi.db` and
session store at `./data/sessions.sqlite` persist between restarts.

---

### 2. Docker Compose Dev

Best for: realistic networking (bridge, port mapping) + frontend
hot-reload + backend hot-reload, all in one shot.

```bash
# 1. Configure
cp src/.env.example src/.env       # same edits as Local Dev §1
# IMPORTANT: SESSION_DB_PATH=./data/sessions.sqlite is REQUIRED here —
# the dev container runs `node --watch --watch-path=src` and the default
# session DB path inside src/ would trigger restart loops.

# 2. Build + start (foreground — Ctrl-C to stop)
docker-compose -f docker-compose.dev.yml up --build

# 3. Open
# Dashboard → http://localhost:5173   (Vite, hot-reload)
# API       → http://localhost:4500   (Node, hot-reload via --watch)

# 4. (Optional) Run in background instead
docker-compose -f docker-compose.dev.yml up -d --build
docker-compose -f docker-compose.dev.yml logs -f      # tail logs
docker-compose -f docker-compose.dev.yml down         # stop & cleanup
```

**Master token:** scan startup logs for `Token: myapi_…` (only the very
first boot — once persisted, the token stays in the DB). Recovery: stop
container, delete `./data/myapi.db`, restart.

---

### 3. Docker Compose Smoke

Best for: end-to-end testing against a real running container with
realistic env, real ports, real bridge networking. This is the topology
CI uses for smoke tests, and the one to reach for when reproducing a
production-only bug locally.

```bash
# 1. Configure (smoke has its own env-file)
cp .env.smoke.example .env.smoke
# .env.smoke is gitignored — fill in:
#  - 4 generated secrets (or use the long fake values shipped in the
#    template; they pass the validator but are NOT production-safe)
#  - Any real OAuth client IDs/secrets you want to e2e-test
# Smoke ships with two opinionated overrides over .env.example:
#  - RATE_LIMIT_MAX_REQUESTS=1000          (so curl loops don't trip)
#  - OAUTH_PRUNE_INTERVAL_MS=60000         (watch the tick fire)
#  - TRUSTED_PROXIES=loopback,uniquelocal  (host curl through docker bridge → real client IP)

# 2. Build + start
docker-compose -f docker-compose.smoke.yml --env-file .env.smoke up -d --build

# 3. Verify boot
docker logs --tail 30 myapi-smoke
# Expect: "Server ready on http://0.0.0.0:4500" + master token line.

# 4. Hit it
curl http://localhost:4500/ping                        # → 200 "pong"
curl http://localhost:4500/api/v1/auth/email-config-status

# 5. Restart to pick up env changes (compose restart only re-runs the
#    process, it does NOT re-read .env.smoke):
docker-compose -f docker-compose.smoke.yml --env-file .env.smoke up -d --force-recreate

# 6. Tear down
docker-compose -f docker-compose.smoke.yml down
```

**Bind mounts:** `./data/` is bind-mounted to `/app/data/` inside the
container, so your DB + session store survive `down`/`up` cycles.

---

### 4. Docker Compose Production

Best for: self-hosting on a real server with a domain, HTTPS, and a
reverse proxy in front.

#### a. Pre-flight checks

| Item | What you need |
|---|---|
| Server | Linux box with Docker + Docker Compose, public IP, ports 80 + 443 open |
| Domain | DNS A record pointing at the server (e.g. `api.your-domain.com`) |
| TLS | Let's Encrypt cert (via certbot) **or** Cloudflare Tunnel **or** any HTTPS terminator |

#### b. Configure

```bash
cp src/.env.example src/.env
```

Edit `src/.env` — minimal production values:

```bash
NODE_ENV=production
PORT=4500
LOG_LEVEL=info

# 4 generated secrets (openssl rand -hex 32)
JWT_SECRET=<generated>
SESSION_SECRET=<generated>
ENCRYPTION_KEY=<generated>
VAULT_KEY=<generated>

# Public URLs
BASE_URL=https://api.your-domain.com
PUBLIC_URL=https://api.your-domain.com
ALLOWED_ORIGINS=https://api.your-domain.com,https://your-domain.com

# Cookie & session
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_DOMAIN=.your-domain.com

# Database & session store — outside the container's app dir for backups
DB_PATH=/app/data/myapi.db
SESSION_DB_PATH=/app/data/sessions.sqlite

# CRITICAL — Trust proxy for your topology (see Trust Proxy notes above)
#   nginx on same host        →
TRUSTED_PROXIES=loopback
#   AWS ALB in 10.x VPC       →   TRUSTED_PROXIES=loopback,10.0.0.0/16
#   Cloudflare in front       →   TRUSTED_PROXIES=loopback,<their CIDRs>

# Rate limits — production defaults
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Power user (gets User Management dashboard access)
POWER_USER_EMAIL=admin@your-domain.com

# Email (any one provider — see Configuration § Email)
EMAIL_PROVIDER=resend
EMAIL_FROM=noreply@your-domain.com
EMAIL_FROM_NAME=Your-App-Name
RESEND_API_KEY=<your resend key>

# OAuth — fill only the providers you actually want active
ENABLE_OAUTH_GOOGLE=true
GOOGLE_CLIENT_ID=<from console.cloud.google.com>
GOOGLE_CLIENT_SECRET=<from console.cloud.google.com>
GOOGLE_REDIRECT_URI=https://api.your-domain.com/api/v1/oauth/callback/google
# … repeat for any other ENABLE_OAUTH_* you flip to true
```

#### c. Set up reverse proxy

Use the [nginx config above](#nginx-reverse-proxy) (or your preferred
terminator). Key invariants:

1. nginx must `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
2. The Express container's `TRUSTED_PROXIES` must include nginx's IP
   (or `loopback` if nginx is on the same host).

#### d. First boot

```bash
# Build + start in background
docker-compose -f docker-compose.prod.yml up -d --build

# Tail startup logs
docker-compose -f docker-compose.prod.yml logs -f myapi | head -60

# Look for: 🔐 SAVE THIS TOKEN — Token: myapi_xxxxxxx...
# That's your master admin token. Store in your password manager NOW.
# It's NOT recoverable from the database.
```

#### e. Verify

```bash
# 1. Liveness
curl https://api.your-domain.com/ping
# → 200 "pong"

# 2. TLS cert
curl -vI https://api.your-domain.com/ 2>&1 | grep -E 'subject|issuer'

# 3. Trust-proxy resolved correctly (audit log will show real client IP,
#    not 127.0.0.1, after a real authenticated request).

# 4. Email transport
curl https://api.your-domain.com/api/v1/auth/email-config-status
# → {"configured":true,"provider":"resend","missing":[]}
```

#### f. First-login flow

1. Open `https://api.your-domain.com/dashboard/`.
2. Paste the master token from step `d` into the login form.
3. Settings → Set a user password (recommended).
4. Settings → Enable 2FA (strongly recommended for production).
5. Settings → User Management → invite teammates by email.
6. Connect → click your enabled OAuth providers, authorize.
7. Generate scoped Bearer tokens for each agent that will call your API.

#### g. Backups

The two SQLite files in `./data/` (or wherever you mounted them) hold
all state. Snapshot them with `sqlite3 myapi.db ".backup backup.db"`
on a cron — never `cp` a live SQLite file.

#### h. Updates

```bash
git pull origin main
docker-compose -f docker-compose.prod.yml up -d --build
# Migrations run automatically on boot (see src/migrations/).
# Watch logs for `[Migration]` lines on first boot after upgrade.
```

---

## License

Copyright © 2026 Agentic Integrations LLC. Licensed under the [GNU Affero General Public License v3.0](LICENSE) with a **[Commons Clause](https://commonsclause.com/)** non-commercial restriction.

**Key terms:**
- ✅ Use, modify, and self-host freely for personal and non-commercial use
- ✅ Deploy on your own infrastructure, no restrictions
- ✅ Modify the source code for internal use
- ❌ Cannot commercialize or resell as a service (including SaaS, hosting, API aggregation, etc.)

Any modified version you run as a network service must also be made available under AGPL-3.0. For commercial licensing or exceptions, contact [Agentic Integrations LLC](https://www.myapiai.com).

See the [LICENSE](LICENSE) file for full terms.
