import { useEffect, useMemo, useState } from 'react';
import BrandLogo from '../components/BrandLogo';
import { classifyPassword } from '../utils/passwordStrength';

/**
 * F5.2 P3.3 — Reset-password landing page.
 *
 * Linked from the email sent by /auth/password/reset/request.  We:
 *   1. Pull the `?token=...` from the URL on mount; refuse to render
 *      the form if it's missing.
 *   2. Collect a new password (with live strength feedback that mirrors
 *      the server's `isStrongPassword` rule) plus a confirmation field.
 *   3. POST to /auth/password/reset/confirm.  On 200 the server has
 *      already revoked the user's other sessions and (in 401 routes
 *      only) signed them in via cookie; we surface a success banner
 *      and direct them to /dashboard/login (sessions are revoked
 *      everywhere by design — they should sign in fresh).
 *   4. On 410 (token expired/consumed) and 400 (weak password) we keep
 *      the user on the page with a clear error so they don't bounce.
 */
function ResetPassword() {
  const token = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search || '').get('token') || '';
    } catch (_) {
      return '';
    }
  }, []);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const strength = classifyPassword(password);
  const matches = password && confirm && password === confirm;
  const submitDisabled = busy || !token || !matches || strength.score < 2;

  useEffect(() => {
    if (!token) {
      setError('This reset link is missing its token. Please request a new one.');
    }
  }, [token]);

  const handleSubmit = async (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    setError('');
    if (!token) return;
    if (!matches) {
      setError("Passwords don't match.");
      return;
    }
    if (strength.score < 2) {
      setError('Pick a stronger password (8+ chars, mix of letter cases, numbers, or symbols).');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/v1/auth/password/reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 410) {
        setError(data?.error || 'This reset link has expired or already been used. Please request a new one.');
        return;
      }
      if (res.status === 400) {
        setError(data?.error || 'Password did not meet the strength requirements.');
        return;
      }
      if (res.status === 429) {
        setError('Too many attempts. Please wait and try again.');
        return;
      }
      if (!res.ok) {
        setError(data?.error || 'Could not reset password. Please try again.');
        return;
      }

      setSuccess(true);
      // The server has revoked all sessions for this user; ensure no
      // stale auth artifacts in localStorage trick the dashboard into
      // hydrating with a dead master token.
      try { localStorage.removeItem('myapi_master_token'); } catch (_) { /* unavailable */ }

      setTimeout(() => {
        window.location.href = '/dashboard/login?reset=success';
      }, 1500);
    } catch (err) {
      setError(err?.message || 'Could not reset password. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto w-full max-w-[1440px] px-4 py-8 sm:px-8 sm:py-10 lg:px-12">
        <div className="mx-auto max-w-md pt-6">
          <div className="mb-8 text-center">
            <BrandLogo size="md" className="mb-6 justify-center" />
            <h1 className="text-3xl font-semibold">Choose a new password</h1>
            <p className="mt-2 text-slate-400">
              We'll sign you out everywhere after the reset.
            </p>
          </div>

          <div className="rounded-3xl border border-slate-700/80 bg-slate-900/85 p-5 shadow-2xl shadow-black/40 sm:p-7 lg:p-8">
            {success ? (
              <div className="space-y-4 text-center" data-testid="reset-password-success">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                  ✓
                </div>
                <h2 className="text-xl font-semibold">Password updated</h2>
                <p className="text-sm text-slate-300">
                  Redirecting you to the sign-in page…
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" data-testid="reset-password-form">
                {error && (
                  <div role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                    {error}
                  </div>
                )}

                <div>
                  <label htmlFor="rp-password" className="mb-2 block text-sm font-medium text-slate-300">
                    New password
                  </label>
                  <input
                    id="rp-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    disabled={busy || !token}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="min-h-[48px] w-full rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 disabled:opacity-60"
                    placeholder="8+ chars, mix cases / numbers / symbols"
                    autoFocus
                  />
                  {password && (
                    <p
                      data-testid="reset-password-strength"
                      data-strength-tone={strength.tone}
                      className="mt-1 text-xs"
                      style={{
                        color:
                          strength.tone === 'green'
                            ? '#4ade80'
                            : strength.tone === 'amber'
                            ? '#fbbf24'
                            : strength.tone === 'red'
                            ? '#f87171'
                            : '#94a3b8',
                      }}
                    >
                      Password strength: {strength.label}
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="rp-confirm" className="mb-2 block text-sm font-medium text-slate-300">
                    Confirm new password
                  </label>
                  <input
                    id="rp-confirm"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                    disabled={busy || !token}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="min-h-[48px] w-full rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 disabled:opacity-60"
                    placeholder="Re-enter password"
                  />
                  {confirm && !matches && (
                    <p className="mt-1 text-xs text-red-300">Passwords don't match</p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={submitDisabled}
                  data-testid="reset-password-submit"
                  className="min-h-[48px] w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? 'Updating…' : 'Update password'}
                </button>

                <div className="pt-2 text-center">
                  <a
                    href="/dashboard/login"
                    className="text-xs font-medium text-slate-400 hover:text-slate-200"
                  >
                    ← Back to sign in
                  </a>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ResetPassword;
