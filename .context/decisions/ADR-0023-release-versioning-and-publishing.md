# ADR-0023 — Release versioning and publishing

- **Status.** Accepted
- **Date.** 2026-05-04
- **Decision makers.** repo owner (ValeroK), AI pairing session
- **Related.** `plan.md` §3, `TASKS.md` M-import, ADR-0007 (clean-rewrite-allowed),
  ADR-0008 (npm audit blocks high), ADR-0012 (test-first and baseline ratchet),
  CHANGELOG.md, `.github/workflows/release.yml`,
  `docker-compose.release.yml`
- **Tags.** ops / build / release / governance

## Context

Until now this fork shipped no release artefacts. `package.json` carried the
sanitized-snapshot placeholder version `1.0.0` (root) and `0.1.0`
(`src/package.json`) without ever being bumped. There were no `v*` tags, no
public Docker image, no CHANGELOG, and no audit trail tying a particular
binary to a particular commit + test baseline. The only publish path was
`.github/workflows/deploy.yml`, which builds `myapi-backend:<sha>` from
`src/Dockerfile` and pushes it to the operator's private
`vars.REGISTRY_URL` for their own deploy target — useful for ops, useless
for distribution.

The fork has now closed M0 (foundation), M1 (critical fixes), M2 (crypto
consolidation), M3 (OAuth state hardening), M4 (pluggable session +
rate-limit infra), F4 (OAuth identity-vs-service scope separation), F5
(password-auth parity + reset/change), F6 (agent capability verification —
the cardinal MVP property is now proved end-to-end by
`scripts/agent-walkthrough.mjs`). The surface is mature enough that
people who want to *use* it as a self-hosted personal API + AI-agent
gateway need a versioned, pullable artefact. The rolling
upstream-import batch (ADR-0024 / `M-import` / F12) needs a baseline
release to increment from.

We also need a published release because the F12 import process (per
section 1 of `.cursor/plans/upstream_import_careful_plan_*.plan.md`)
defines rollback as `git revert` on `main` — but if we ever need to
rollback the *running binary* we need an immutable previous tag to
`docker pull` and re-deploy.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Tag `v0.6.0`, publish `ghcr.io/valerok/myapi-open:v0.6.0` (multi-arch) on tag push, leave `deploy.yml` alone | Honest pre-production marker; reserves `v1.0.0` for SOC2/M7 finish; GHCR is free + same auth domain as the repo; existing `deploy.yml` keeps shipping `myapi-backend:<sha>` to the operator's private registry untouched (additive) | Two image namespaces (`ghcr.io/valerok/myapi-open` for distribution, operator's `vars.REGISTRY_URL/myapi-backend` for ops) — needs to be documented |
| B | Tag `v1.0.0` to match existing `package.json` placeholder | Doesn't require a downward version bump | Lies about maturity (M5/M6/M7 not done; M-import not started); leaves no semver headroom for anything that lands before SOC2/M7 |
| C | Tag `v1.0.0-alpha.1` (or `-beta.1`) | Preserves `1.0.0` as the eventual production target while signalling pre-production | npm semver pre-release tags interact awkwardly with Docker tag selectors; `:latest` would still need a separate stable tag; people grep for `v1.x` and would miss us |
| D | No public registry — release as a `git tag` only and let users `docker build .` themselves | Zero infra surface; no GHCR account decision | Defeats the point — "we can pull and use" was the explicit ask; build context requires `npm ci` + dashboard build, which is slow and brittle on first-time users |
| E | Publish to Docker Hub (`docker.io/valerok/myapi-open`) instead of GHCR | More discoverable to people who don't know GHCR exists | Needs a separate Docker Hub account + access token in repo secrets; rate-limited for anonymous pulls; further from the source of truth |

## Decision

We chose **Option A**.

- **Version: `v0.6.0`.** Milestone-aligned (M0 + M1 + M2 + M3 + M4 + F-series
  done = ~6 milestones of foundation). v0.7.0 is reserved for the F12
  upstream-import batch landing. v1.0.0 is reserved for the SOC2 / M7-finish
  state. Bumps `package.json` `1.0.0 → 0.6.0` and `src/package.json`
  `0.1.0 → 0.6.0` so they match (a future small task should add a source-pin
  test that fails if they drift).
- **Registry: `ghcr.io/valerok/myapi-open` (public).** Pushed via
  `GITHUB_TOKEN` from the repo's own Actions — no extra registry secret
  needed. Public visibility means `docker pull` works without auth. (The
  package's visibility on first push defaults to private — see §
  "Operational changes required" below.)
- **Image: built from the root `Dockerfile`** (the documented 6-stage
  monolith image that ships backend + built React/Vite dashboard on `:4500`).
  *Not* `src/Dockerfile`, which is the smaller backend-only image used by
  `deploy.yml` for the operator's existing deploy. The release image is the
  single artefact a user pulls; `deploy.yml`'s pipeline is unchanged.
- **Two tags per release:** `:v<X.Y.Z>` (immutable) and `:latest` (movable).
  No tag soup (no `:main`, no `:<sha>`, no `:edge`). Reproducibility comes
  from the immutable semver tag.
- **Multi-arch:** `linux/amd64` + `linux/arm64` (BuildKit + QEMU) so it
  runs on both x86 servers and Apple Silicon / Raspberry Pi 4+.
- **Test gate enforced in the release workflow.** The same `npm test --silent`
  baseline that gates `main` also gates the release tag. If tests fail,
  no image is pushed and no GitHub Release is created.
- **`deploy.yml` is left alone (additive policy).** It continues to ship
  `myapi-backend:<sha>` to the operator's `vars.REGISTRY_URL` for ops
  purposes. The release pipeline is a separate workflow
  (`release.yml`) that triggers only on tag push.

## Consequences

### Positive

- A versioned, pullable artefact exists for the first time:
  `docker pull ghcr.io/valerok/myapi-open:v0.6.0`.
- The release tag is an immutable rollback target if any of the F12
  upstream-import PRs goes wrong post-merge.
- The CHANGELOG.md becomes the single human-readable summary of what shipped
  in each release; the matching `git tag` and GHCR image can be diffed via
  `git diff v0.6.0...v0.7.0` later.
- Multi-arch coverage makes self-hosting on Apple Silicon /
  Raspberry Pi 4+ a one-line `docker compose up -d` instead of a
  source build.
- Reproducibility: the release workflow runs the locked test gate
  before pushing the image, so a green release tag means a green test
  baseline, by construction.

### Negative / costs

- Two image namespaces now exist (`ghcr.io/valerok/myapi-open` for
  distribution, operator's `vars.REGISTRY_URL/myapi-backend` for ops).
  Documented in CHANGELOG.md and README "Run the release" section.
- First-time push to GHCR creates the package as **private** by default —
  one-time manual step in GitHub Settings → Packages to flip
  `myapi-open` to public visibility. Documented in README.
- Multi-arch build on QEMU adds ~3-6 min to the release run vs.
  `linux/amd64`-only. Acceptable for a tag-triggered (not push-triggered)
  workflow.
- We are now committing to keeping the test gate green at tag time, not
  just at merge time. Consistent with ADR-0012's ratchet rule.
- ESLint `npm audit` baseline is **report-only** at release time too
  (per ADR-0008 it would normally block at HIGH+, but we exempt the
  release workflow from the audit gate the same way `ci.yml` does, so
  upstream advisories outside our control don't block a release).

### Code changes required (high level)

- `package.json` (root): `version` `1.0.0` → `0.6.0`. (Done.)
- `src/package.json`: `version` `0.1.0` → `0.6.0`. (Done.)
- `CHANGELOG.md` at repo root, with `[Unreleased]` and `[0.6.0]`
  sections. (Done.)
- `.github/workflows/release.yml` (new): tag-triggered, runs the test
  gate, builds the root `Dockerfile` multi-arch, pushes to
  `ghcr.io/valerok/myapi-open:vX.Y.Z` + `:latest`, creates a GitHub
  Release with the matching CHANGELOG section in the body, attaches
  `docker-compose.release.yml` as a release asset.
- `docker-compose.release.yml` (new): no `build:` context, uses
  `image: ghcr.io/valerok/myapi-open:v0.6.0` (pinned by default — users
  can flip to `:latest` if they want the rolling tag), env-var template
  for the four required secrets, persistent named volumes for `data`
  and `sessions`.
- `README.md`: new "Run the release" section pointing at the compose
  file and listing the four required env vars.

### Operational changes required

- One-time after the first `release.yml` push: open
  `https://github.com/users/ValeroK/packages/container/myapi-open/settings`
  → Change visibility → Public. (Anonymous `docker pull` requires this.)
- Tag policy: only `v<MAJOR>.<MINOR>.<PATCH>` tags trigger
  `release.yml`. Pre-releases (`v0.7.0-rc.1`) are tolerated by the
  workflow but are NOT pushed as `:latest`.
- Rollback procedure: `docker pull
  ghcr.io/valerok/myapi-open:v<previous>` and `docker compose -f
  docker-compose.release.yml up -d --force-recreate` against an
  immutable previous tag. No `:latest` chase required.

## Follow-ups

- Tasks created: `M-import` milestone in `TASKS.md` (release-* tasks 1–6
  are tracked there as the v0.6.0 ship work; M-import owns
  v0.7.0 onwards).
- Metrics/alerts to add: GitHub Actions email-on-failure for `release.yml`
  is sufficient for v0.6.0; consider GHCR pull-count + image-size
  trend tracking after v0.8.0.
- When to revisit this decision:
  - When the first non-owner pulls the image (validate visibility,
    documentation, env-var defaults).
  - When the first `linux/arm64` user reports a runtime issue
    (`better-sqlite3` native compile under Alpine vs. slim-buster
    is the most likely failure mode).
  - When SBOM or cosign signing becomes a real downstream requirement.
  - When we have to ship a security-only patch — verify that the
    "tag → workflow → push → GitHub Release" loop completes end-to-end
    in under 30 min from `git tag` to `docker pull`.

## What this ADR explicitly defers

- **No SBOM in v0.6.0.** `anchore/sbom-action` ships SBOM generation;
  defer until v0.7.0 or when an external user asks.
- **No cosign / image signing in v0.6.0.** Keyless OIDC signing via
  `sigstore/cosign-installer` is the right answer once at least one
  external user is pulling; not before.
- **No Helm chart / k8s manifests.** `docker compose` only.
- **No private "enterprise" image variant.** Public GHCR only.
- **No automatic version bump.** Tagging is manual (`git tag -a vX.Y.Z`)
  to avoid releases happening on every merge.
