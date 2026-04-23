# syntax=docker/dockerfile:1.7
# =============================================================================
# Dockerfile — production-style single-container image for MyApi
# =============================================================================
#
# Purpose
# -------
# Ship the monolith (backend + built React/Vite dashboard) as one image
# on :4500. Used by `docker-compose.yml` for the default dev setup.
# Dev-iteration use cases should prefer `Dockerfile.dev` instead (see
# docker-compose.test.yml / docker-compose.smoke.yml) — this file bakes
# the dashboard in, which is slow to rebuild on every source edit.
#
# Layer caching strategy
# ----------------------
# Six distinct stages, ordered stable → volatile so a source-only change
# re-runs only the final two COPY layers:
#
#   1. Base image (node:22-slim)                        stable
#   2. apt-get install python3/make/g++                 stable (rare)
#   3. COPY src/package*.json + `npm ci`                backend deps
#   4. COPY dashboard/package*.json + `npm ci`          frontend deps
#   5. COPY dashboard source + `npm run build`          frontend artefact
#   6. COPY src/ + connectors/ + LICENSE                source code
#
# A typical backend-source edit invalidates only stage 6 (~1 s). A
# frontend source edit invalidates stages 5+6 (~30 s for the vite
# build). A dep change invalidates stage 3 or 4 plus everything after.
#
# BuildKit cache mounts
# ---------------------
# Two mounts, both requiring BuildKit (default on Docker 23+):
#   - `/root/.npm`        : npm tarball cache, shared across both
#                           `npm ci` invocations (backend + frontend).
#   - `/var/cache/apt`    : apt package cache, so re-running the
#                           apt-get install layer (e.g. after Node base
#                           bumps) is near-instant.
# =============================================================================

FROM node:22-slim

WORKDIR /app

# ---------------------------------------------------------------------------
# Stage 2: system build tools for `better-sqlite3` native compilation.
# ---------------------------------------------------------------------------
# `rm -rf /var/lib/apt/lists/*` keeps the image small; the BuildKit cache
# mount on /var/cache/apt accelerates re-runs without leaving cached
# .debs inside the image layer.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Stage 3: backend production dependencies.
# ---------------------------------------------------------------------------
# `--omit=dev` replaces the deprecated `--only=production` (npm ≥ 8.3).
# `npm rebuild better-sqlite3` is needed because the pre-built binary
# shipped by the npm registry may not match the slim image's glibc.
COPY src/package.json src/package-lock.json ./src/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd src && \
    npm ci --omit=dev --no-audit --no-fund && \
    npm rebuild better-sqlite3

# ---------------------------------------------------------------------------
# Stage 4: frontend dependencies (devDeps INCLUDED — vite is a devDep).
# ---------------------------------------------------------------------------
COPY src/public/dashboard-app/package.json src/public/dashboard-app/package-lock.json ./src/public/dashboard-app/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd src/public/dashboard-app && \
    npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 5: build the frontend to src/public/dashboard-app/dist/.
# ---------------------------------------------------------------------------
# COPY is scoped to just the dashboard-app source so a backend-only edit
# doesn't invalidate this layer.
COPY src/public/dashboard-app/ ./src/public/dashboard-app/
RUN cd src/public/dashboard-app && npm run build

# ---------------------------------------------------------------------------
# Stage 6: backend source + connectors + license.
# ---------------------------------------------------------------------------
# This layer is the only one that invalidates on a typical backend edit.
COPY src/ ./src/
COPY connectors/ ./connectors/
COPY LICENSE ./

RUN mkdir -p src/data src/logs

EXPOSE 4500

WORKDIR /app/src
CMD ["node", "index.js"]
