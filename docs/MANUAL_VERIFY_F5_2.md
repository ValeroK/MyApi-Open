# F5.2 — Manual UI Verification Checklist

This is a **simple, copy-paste-able** checklist you can run end-to-end in
your browser to verify F5.2 (password auth + activity-log cleanup) works
in the live dashboard.

> **Container:** assumes the smoke / dev compose stack is running on
> `http://localhost:4500` (i.e. `docker compose -f docker-compose.smoke.yml up -d`
> after a fresh `npm run dashboard:build`).

---

## 0. Pre-flight (30 seconds)

> **Got the dashboard from before this commit cached?** Run
> `npm run dashboard:reload` once. It rebuilds the SPA *and* restarts
> the smoke container so the new `Cache-Control: no-store` header on
> the SPA shell takes effect. After that, plain F5 / Ctrl+F5 is enough
> for every future rebuild.

1. Open an **Incognito / Private window** (so cached cookies don't pollute the test).
2. Open DevTools → **Network** tab. Leave it open across the whole flow.
3. Pick a unique identity for this run, e.g.:

   - **username:** `verify_<your_initials>_<yyyymmdd>` (e.g. `verify_kv_20260426`)
   - **email:** same prefix `@example.com`
   - **password #1:** `Strong-Pass-1!verify`
   - **password #2:** `Final-Pass-2!verify`

Use these everywhere below.

---

## 1. Sign up with password (P3.2)

1. Go to **`http://localhost:4500/dashboard/signup`**.
2. Confirm the page shows, **below the OAuth buttons**, a divider
   reading **"OR SIGN UP WITH EMAIL"** and a form with
   *Username, Display name, Email, Password, Confirm password,
   Terms, Privacy, Create account*.
3. Type:
   - Username, Display name, Email — values from step 0
   - Password and Confirm password — **password #1**
4. As you type the password, the helper text below the field should
   change from *(empty)* → *"weak"* → *"fair"* → *"strong"* (depending
   on length). The *Create account* button should stay **disabled**
   until both passwords match, the strength is at least *fair*, and
   both checkboxes are ticked.
5. Tick **Terms** and **Privacy** → *Create account* enables.
6. Click **Create account**.

**Expected:**
- URL ends up on `http://localhost:4500/dashboard/`.
- The dashboard's left sidebar/header shows your **display name**.
- Network tab shows: `POST /api/v1/auth/register` → **200**, then
  `GET /api/v1/auth/me` → **200**.

---

## 2. Activity log noise check (P0)

1. From the dashboard, navigate to **Activity** (sidebar) — or
   wherever your build surfaces audit entries.
2. Filter to the **last 5 minutes**.

**Expected:**
- You see exactly **one** `user_registered` row (and at most one
  `user_login_success`).
- You should **NOT** see `token_validated` or audit rows for
  `audit_log_viewed`, `services_listed`, etc. (they used to spam every
  page load).

---

## 3. Logout

1. Click your avatar/menu → **Sign out**.

**Expected:**
- URL goes back to `http://localhost:4500/dashboard/login` (or `/`).
- A subsequent `GET /api/v1/auth/me` returns **401**.

---

## 4. Log in with password (P3.1)

1. On `http://localhost:4500/dashboard/login`, scroll to the
   **OR SIGN IN WITH EMAIL** section.
2. Type your **email** and **password #1** → click **Sign in**.

**Expected:**
- URL ends on `/dashboard/`.
- Dashboard renders.
- Network: `POST /api/v1/auth/login` → **200**.

---

## 5. Forgot password (P3.3)

1. Sign out again.
2. On `/dashboard/login` click **Forgot password?**.
3. Type your email → **Send reset link**.

**Expected:**
- A success message appears: *"If that email is registered, we've sent
  a password reset link..."* (timing-safe wording — appears whether or
  not the email exists).
- Network: `POST /api/v1/auth/password/reset/request` → **200**.

### 5a. Grab the reset token

In the smoke environment the email isn't actually delivered to a real
mailbox. Get the token from the container logs instead:

```powershell
docker logs myapi-smoke 2>&1 | Select-String -Pattern "reset-password\?token=" | Select-Object -Last 1
```

Copy the URL it prints (e.g. `http://localhost:4500/dashboard/reset-password?token=abc...`).

> **Production note:** in real deploys this URL is sent via SendGrid /
> SMTP and never logged.

### 5b. Use the reset link

1. Paste the URL into the address bar.
2. Type your **password #2** twice. Strength must be at least *fair*.
3. Click **Reset password**.

**Expected:**
- A success message appears, then the page redirects to
  `/dashboard/login?reset=success`.
- A green banner shows *"Password reset successfully — please sign in
  with your new password."*
- Network: `POST /api/v1/auth/password/reset/confirm` → **200**.

### 5c. Verify token is single-use

1. Click the browser **Back** button to return to
   `/dashboard/reset-password?token=...` (same token you just used).
2. Try to submit a new password.

**Expected:** the server returns **410 Gone** and the UI shows an
error like *"This reset link has expired or already been used. Please
request a new one."*

---

## 6. Log in with the *new* password

1. On `/dashboard/login` use email + **password #2** → **Sign in**.

**Expected:** lands on `/dashboard/`. Old password (**password #1**)
should now return **401** if you try it.

---

## 7. Change password (P3.4)

1. Open in **two browser tabs / windows** (Tab A and Tab B), both
   logged in as the same user.
2. In **Tab A**, navigate to **Settings → Security → Change
   password**.
3. Fill in:
   - *Current password:* **password #2**
   - *New password / Confirm:* **password #1**
4. Click **Update password**.

**Expected:**
- Tab A shows a success toast/banner that mentions *N other session(s)
  signed out* (where N ≥ 1).
- Network in Tab A: `POST /api/v1/auth/password/change` → **200**, response
  body has `data.sessionsRevoked >= 1`.
- In **Tab B**, the next API call (or page navigation) bounces you to
  `/dashboard/login` because that session was revoked.

### 7a. Verify the change took

1. Sign out everywhere.
2. Try **password #2** → should fail with **401**.
3. Try **password #1** → should succeed.

---

## 8. Cleanup (optional)

If you don't want to leave the test user lying around, you can either:

- Sign in once more, go to **Settings → Account → Delete account**,
  *or*
- From the host:
  ```powershell
  docker exec -i -w /app myapi-smoke node -e "require('better-sqlite3')('./data/myapi.db').prepare('DELETE FROM users WHERE email = ?').run('verify_kv_20260426@example.com');"
  ```

---

## What this checklist exercises

| Step | F5.2 phase                | Endpoint hit                                |
|------|---------------------------|---------------------------------------------|
| 1    | P3.2 signup form          | `POST /api/v1/auth/register`                |
| 2    | P0 audit-log cleanup      | (read-side observation only)                |
| 3    | P1c logout audit          | `POST /api/v1/auth/logout`                  |
| 4    | P3.1 login form           | `POST /api/v1/auth/login`                   |
| 5    | P3.3 forgot/reset pages   | `/auth/password/reset/{request,confirm}`    |
| 6    | (full round-trip)         | `POST /api/v1/auth/login`                   |
| 7    | P3.4 + P2 change-password | `POST /api/v1/auth/password/change`         |

If every step passes, F5.2 is good to ship.

---

## F5.3 — Auth UX hardening (additional steps)

These steps cover the four user-reported regressions fixed in F5.3.
Run them after the F5.2 sweep above.

### 9. Email-not-configured banner (Bug 1)

1. Make sure `EMAIL_FROM` is **not** set in `src/.env` (or stop the
   container, comment out `EMAIL_FROM`, then `npm run dashboard:reload`).
2. Open `/dashboard/forgot-password`.
   - Expected: amber banner "Email delivery is not configured on this
     server" appears at the top of the form, listing the missing
     environment variables.
3. Open `/dashboard/settings`, scroll to **Change Password**.
   - Expected: the same amber banner appears above the form.
4. Set `EMAIL_FROM=noreply@example.com` (and `SMTP_HOST` / `SMTP_PORT`
   if `EMAIL_PROVIDER=smtp`), restart with `npm run dashboard:reload`,
   refresh both pages.
   - Expected: banners are gone.

### 10. Duplicate-email registration is blocked (Bug 2)

1. Open `/dashboard/signup` and register `dup_user_a` with
   `dup-test@example.com` / `Strong!Pass123`. Sign in successfully.
2. Log out (Settings → Sign out, or click your avatar → Sign out).
3. Open `/dashboard/signup` again and try to register `dup_user_b`
   with the **same email** `dup-test@example.com`.
   - Expected: red banner "An account with this email already exists.
     Sign in instead, or use 'Forgot password' if you don't remember
     it." Form does not submit.
4. Try once more with `Dup-Test@Example.COM` (different case).
   - Expected: same 409 / same banner — case-insensitive match.

### 11. OAuth-only account guard (Bug 3)

1. Sign up via Google (or another configured OAuth provider). Note the
   email associated with the OAuth account.
2. Log out.
3. Open `/dashboard/login`, switch to the password form, and try to
   sign in with that same email + any password.
   - Expected: amber banner "Continue with Google" replaces the
     password error. Password field is cleared. The banner contains a
     **"Continue with Google →"** button that initiates the OAuth flow.
4. Click the button.
   - Expected: standard Google OAuth flow runs and you land in the
     dashboard authenticated as that user.

### 12. Post-login redirect stability (Bug 4)

1. Sign in with password from `/dashboard/login`.
   - Expected: lands on `/dashboard/` (the SPA), not back on `/`.
2. Open a new tab → `/`. Click "Sign in" → "Sign in with email" →
   complete login.
   - Expected: lands on `/dashboard/`.
3. Repeat with the **Forgot password → reset → confirm** flow.
   - Expected: after the reset confirms and auto-logs you in, lands
     on `/dashboard/`.
4. Log out, then log back in immediately (within the same tab).
   - Expected: lands on `/dashboard/` — no bounce back to `/`.

> **Root cause for the regression:** the axios/fetch interceptors used to
> treat **HTTP 403** as a session-expired event and force the user out.
> The dashboard prefetches plan-gated endpoints (e.g. `/api/v1/afp/devices`)
> on boot — for free-plan users that endpoint legitimately returned 403,
> which silently logged the user out and bounced them to `/`. The
> interceptors now only react to **401**; 403 is propagated to the
> caller, which is the correct REST semantic ("authenticated but not
> authorized for this resource").

### 13. Plan tier-gating is dev-friendly

The smoke / dev container runs with `NODE_ENV=development`, so plan
tier-gates (AFP connectors, persona/service/vault limits, etc.) are
**disabled** — every requester is treated as if they were on the highest
tier. This lets engineers exercise Pro/Enterprise flows without having
to flip plans in the DB.

1. Sign in as a free-plan user, open DevTools → Network, refresh
   `/dashboard/`.
   - Expected: `/api/v1/afp/devices` returns **200** with
     `{"ok":true,"devices":[]}` (not 403).
2. In production (`NODE_ENV=production`) the gate stays active. To
   re-enable it locally for a regression test, set
   `ENFORCE_PLAN_LIMITS=true` *and* `NODE_ENV=production` on the
   container, restart, and verify the same call now returns 403 with
   the upgrade-hint payload.

If all five F5.3 steps (10–13 plus the email banners in 9) pass,
F5.3 is good to ship.
