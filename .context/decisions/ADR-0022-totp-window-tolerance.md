# ADR-0022 — TOTP verify window widened from ±60s to ±120s

- **Status.** Accepted
- **Date.** 2026-04-30
- **Decision makers.** repo owner + AI pairing session
- **Related.** `plan.md` §6.3 (auth hardening), `TASKS.md` change log 2026-04-30, ADR-0012 (test-first), `src/tests/totp-window-tolerance.test.js`, `.context/tasks/backlog/F11-2fa-reset-mechanism.md`
- **Tags.** security, ops

## Context

`mailer.kv@gmail.com` could not complete 2FA enrolment on a freshly
wiped DB with a freshly scanned QR. Live instrumentation against the
running container (read in-process to avoid Windows Docker bind-mount
WAL stale reads) proved:

- Setup wrote secret `EVRDG2CC…` to the correct user row at
  `2026-04-30T06:41:52Z`. No subsequent setup ran. The audit log had
  exactly one `2fa_setup_started` for that user.
- Speakeasy was invoked correctly (`secret.base32` and the secret
  encoded in the QR's `otpauth_url` are byte-identical — verified
  with a `generateSecret({ length: 32 })` probe inside the container).
- Container clock matched host clock to within 100 ms.
- A live code read from the user's authenticator at `06:49:53Z` was
  `910278`. `speakeasy.totp.verifyDelta({ secret, encoding: 'base32',
  token: '910278', window: 10 })` returned `{ delta: +4 }` — i.e. the
  phone's TOTP step was exactly 120 s ahead of the server's step.

The previous server-side tolerance was `speakeasy.totp.verify({
window: 2 })` (= ±60 s = 5 acceptable steps). At a +120 s phone drift,
no live code would ever pass the verifier — every honest enrolment
attempt rejected with `Invalid 2FA code`. The user followed the
operator-suggested workaround (delete all stale authenticator
entries, run "Time correction for codes" on the phone) and the drift
persisted; the phone's NTP / authenticator-internal-offset just
re-acquired the same +120 s. This is consistent with reports of
mid-tier Android devices on weak NTP that drift in the 30–180 s band.

A 2FA enrolment that never accepts a real code is worse than no 2FA
at all — the user gives up, runs without 2FA, and there is no
operator-side recovery (F11 not yet shipped). Tightening tolerance is
not the right knob for this product surface.

## Options considered

| # | Option | Pros | Cons |
|---|--------|------|------|
| A | Keep `window: 2`, tell users to fix their phone clock | No security trade-off; standard advice | Already failed in this incident — user did "Sync now" and drift persisted; not actionable for end users running on cheap Android NTP |
| B | Bump constant to `window: 4` (= ±120 s) at every verify call site | One-line per site; covers the observed drift; brute-force math still ~14 days at 50 % against the 6-digit space; meets test-first requirements | Slightly wider attack surface (≈9 codes accepted per submission instead of 5); replay-tracker TTL must also widen to cover the new validity span; locks in a fixed value that can't be tuned per deployment without code change |
| C | Add a `TOTP_WINDOW` env var (default 2, validated to `1..6`) and thread through every verify call site | Operators can dial up tolerance for fleets with bad NTP without code change; production stays tight at 2 by default | More plumbing (env parse, validation, threading); a default of 2 still leaves this user broken until they set the env var; argues for default 4 anyway, at which point it's Option B with extra surface area |

## Decision

We chose **Option B** because the product is currently single-tenant
local-deploy (the `myapi-smoke` harness + a small set of operators
running their own instances), the operator made a direct judgement
call on the trade-off after seeing the live `delta = +4` evidence,
and the brute-force math at `window: 4` is materially the same as at
`window: 2` for a TOTP space (the binding control is the 30 s code
rotation + per-user replay-tracker, not the per-minute or per-window
acceptance count).

If the product gains a second-tenant SaaS dimension (M11+) we should
revisit and adopt Option C with a stricter default, since per-tenant
clock-drift policy becomes meaningful when you can't ask one operator
to vouch for the whole fleet.

## Consequences

- **Positive.**
  - Honest users with phones drifting up to ±120 s can enrol and log
    in without operator intervention or running "Time correction for
    codes" on the device.
  - Replay-tracker TTL is now correctly sized for the verifier's
    validity span — pre-fix the 90 s TTL was actually 30 s short of
    the previous `window: 2` 120 s span, a latent micro-gap closed
    in the same change.

- **Negative / costs.**
  - The brute-force window grows from ~5 acceptable codes per
    submission to ~9 (≈+80 %). At the new `2fa-attempts` cap of
    10 / min / IP (BUG-15 / 2026-04-29), 50 % brute-force probability
    against the 6-digit TOTP space is now ~7.7 days instead of ~14
    days. Both numbers are well outside any operationally relevant
    horizon, and a sustained-fail signature against
    `/auth/2fa/challenge` already trips `alerting.trackFailedLogin`
    on every miss; an actual brute-force run produces a loud audit
    trail long before it lands a hit.

- **Code changes required (high level).**
  - 4 call sites in `src/index.js` updated `window: 2` → `window: 4`
    (`/auth/2fa/verify`, `/auth/2fa/disable`, `/auth/2fa/challenge`,
    `/admin/security/rotate-key`).
  - 1 call site in `src/routes/auth.js` (`POST /auth/login` 2FA gate)
    updated `window: 2` → `window: 4`.
  - `TOTP_CODE_TTL_MS` in `src/lib/authHardening.js` raised
    `90_000` → `270_000` (240 s validity span at `window: 4` + 30 s
    buffer); inline comment block updated to point at the new
    source-pin test.
  - New test `src/tests/totp-window-tolerance.test.js` (6 tests):
    behavioural assertions at ±90 s (accepted) and +150 s (rejected)
    via `POST /api/v1/auth/login` + `totpCode`, plus source-pins on
    every `speakeasy.totp.verify` block in `src/index.js` and
    `src/routes/auth.js` to fail the build if any future edit
    silently re-tightens the window or drops the replay TTL below
    240 s.

- **Operational changes required.** None. The change is a one-shot
  bump; no env vars to set, no runbook updates beyond the change-log
  entry in `current_state.md`. F11's master-only reset endpoint is
  still the right next step for the lockout failure mode this
  incident also surfaced (operator-side recovery when a user is
  fully locked out for any reason).

## Follow-ups

- **Tasks created.** None new. F11 (`.context/tasks/backlog/F11-2fa-reset-mechanism.md`) remains the right follow-up for operator-driven 2FA reset; this ADR closes the *enrolment-side* failure mode, F11 will close the *post-enrolment-loss* failure mode.
- **Metrics/alerts to add.** None new. `2fa_failed_attempt` audit-log emission already covers the brute-force surface; the per-IP `429` from `twoFactorRateLimit` already covers the rate-limit side.
- **When to revisit this decision.** When the product takes on multi-tenant SaaS shape (M11+) and per-tenant TOTP-window policy becomes meaningful. At that point adopt Option C: thread `TOTP_WINDOW` through env, default to `2` for SaaS tenants, and let single-tenant local deploys override to `4` or `6` as needed.
