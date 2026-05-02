---
description: Build dashboard (Vite → dist) and redeploy via Docker
---

# Rebuild dashboard and redeploy

From the **repository root**, run:

```bash
npm run redeploy
```

This runs `scripts/rebuild-and-redeploy.mjs`, which:

1. **`npm run dashboard:build`** — compiles `src/public/dashboard-app` into `src/public/dist/` (served at `/dashboard/`).
2. **Redeploy** — default target **`smoke`**:
   - `docker restart myapi-smoke` if that container exists;
   - otherwise **`npm run docker:smoke`** to build and start the smoke stack.

### Other targets (optional argument)

Pass a mode after `--` (npm forwards it to the script):

| Command | Effect |
|--------|--------|
| `npm run redeploy` | Same as `npm run redeploy -- smoke` |
| `npm run redeploy -- prod` | `docker compose -f docker-compose.prod.yml up -d --build` |
| `npm run redeploy -- dev` | `docker compose -f docker-compose.yml up -d --build` (`myapi-dev`) |

**Requires:** Docker CLI on `PATH`, repo root as cwd, dashboard dependencies installed (`npm run dashboard:install` if the build fails on a clean clone).

When the user invokes **/rebuild-and-redeploy**, execute the appropriate `npm run redeploy` command in the terminal from the workspace root and report stdout/stderr.
