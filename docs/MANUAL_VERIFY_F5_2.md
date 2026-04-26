# F5.2 — Manual UI Verification Checklist

This is a **simple, copy-paste-able** checklist you can run end-to-end in
your browser to verify F5.2 (password auth + activity-log cleanup) works
in the live dashboard.

> **Container:** assumes the smoke / dev compose stack is running on
> `http://localhost:4500` (i.e. `docker compose -f docker-compose.smoke.yml up -d`
> after a fresh `npm run dashboard:build`).

---

## 0. Pre-flight (30 seconds)

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
