-- Migration: F5.3 auth-method tracking + email uniqueness
-- Created: 2026-04-26
--
-- Two related fixes for the password-auth UX hardening pass:
--
-- 1. `password_set_at` lets `/auth/login` distinguish between
--    "this user has a real password" and "OAuth signup minted a
--    random throwaway hash". Without it, an OAuth-only account
--    that someone tries to password-login into just gets the
--    generic "Invalid email or password" with zero hint that the
--    account exists under a different sign-in method.
--
--    Backfill: stamp every existing row that already has a
--    password_hash so we don't regress anyone currently using
--    password login.  Going forward, OAuth signup leaves this
--    column NULL while /auth/register, /auth/password/reset/confirm,
--    and /auth/password/change all stamp it.
--
-- 2. UNIQUE index on LOWER(email) closes the duplicate-email
--    registration hole.  /auth/register adds an explicit pre-check
--    too; the index is the belt-and-braces guarantee.

ALTER TABLE users ADD COLUMN password_set_at TEXT;

UPDATE users
SET password_set_at = created_at
WHERE password_hash IS NOT NULL AND password_hash != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
ON users (LOWER(email))
WHERE email IS NOT NULL AND email != '';
