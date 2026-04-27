import { useState, useEffect } from 'react';
import BrandLogo from '../components/BrandLogo';

/**
 * F5.2 P3.3 — Forgot-password page.
 *
 * Single email input → POST /api/v1/auth/password/reset/request.
 * The server always responds 202 (timing-safe; no email-enumeration
 * oracle), so the UI mirrors that contract: irrespective of whether
 * the email is registered, we render the same "if that email exists,
 * we sent a link" success state.  The user is told the link expires
 * in 2 hours so they don't sit on it for a day.
 */
function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  // F5.3 — pull /auth/email-config-status so we can warn the user up
  // front when the server has no usable email transport (the most
  // common case on a self-hosted dev install where EMAIL_FROM is
  // unset).  Without this, /reset/request returns 202 by design (no
  // email-enumeration oracle) and the user wonders why no email
  // arrived.  `null` while the probe is in flight, `false` if the
  // probe itself fails — only `configured === true` hides the banner.
  const [emailConfig, setEmailConfig] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/auth/email-config-status', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg) => {
        if (!cancelled && cfg) setEmailConfig(cfg);
      })
      .catch(() => {
        if (!cancelled) setEmailConfig({ configured: false, provider: 'unknown', missing: [] });
      });
    return () => { cancelled = true; };
  }, []);

  // F5.3 — when the server has no email transport, the only honest
  // outcome of submitting this form is "the link was never sent", so we
  // both visually disable the button below *and* gate the handler here
  // to defend against keyboard submit / scripted clicks.
  const emailNotConfigured = emailConfig && emailConfig.configured === false;

  const handleSubmit = async (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    setError('');
    if (emailNotConfigured) {
      setError('Email delivery is not configured on this server. Contact the administrator or see the README "Email Configuration" section.');
      return;
    }
    if (!email.trim()) {
      setError('Enter the email associated with your account.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/v1/auth/password/reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email.trim() }),
      });
      // Per the server contract /reset/request always returns 202 for
      // valid + invalid emails alike.  429 is the only non-202 the user
      // can hit (per-email or per-IP rate limit).  Surface that
      // explicitly so they know to wait, and for everything else fall
      // through to the success state — matching the timing-safe UX
      // contract from F5.2 P1.
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || 'Too many requests for this email. Please wait an hour and try again.');
        return;
      }
      setSubmitted(true);
    } catch (err) {
      setError(err?.message || 'Could not send the reset email. Please try again.');
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
            <h1 className="text-3xl font-semibold">Reset your password</h1>
            <p className="mt-2 text-slate-400">
              Enter your email and we'll send a reset link.
            </p>
          </div>

          <div className="rounded-3xl border border-slate-700/80 bg-slate-900/85 p-5 shadow-2xl shadow-black/40 sm:p-7 lg:p-8">
            {submitted ? (
              <div className="space-y-4 text-center" data-testid="forgot-password-success">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                  ✓
                </div>
                <h2 className="text-xl font-semibold">Check your inbox</h2>
                <p className="text-sm text-slate-300">
                  If an account is registered to{' '}
                  <span className="font-mono text-slate-200">{email}</span>, we've sent a
                  reset link. The link expires in <strong>2 hours</strong>.
                </p>
                <p className="text-xs text-slate-500">
                  Didn't get it? Check your spam folder, or{' '}
                  <button
                    type="button"
                    onClick={() => { setSubmitted(false); setError(''); }}
                    className="text-blue-400 hover:text-blue-300"
                  >
                    try a different email
                  </button>
                  .
                </p>
                <a
                  href="/dashboard/login"
                  className="inline-block pt-2 text-sm font-semibold text-blue-400 hover:text-blue-300"
                >
                  Back to sign in →
                </a>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" data-testid="forgot-password-form">
                {/* F5.3 — visible upfront warning when the server has no
                    working email transport.  Without it the user clicks
                    "Send reset link", gets the timing-safe 202, and is
                    left wondering why nothing arrived. */}
                {emailConfig && emailConfig.configured === false && (
                  <div
                    role="status"
                    data-testid="email-not-configured-banner"
                    className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
                  >
                    <p className="font-semibold">Email delivery is not configured on this server</p>
                    <p className="mt-1 text-amber-200/80">
                      Reset links cannot be sent right now. Contact the server
                      administrator
                      {Array.isArray(emailConfig.missing) && emailConfig.missing.length > 0 && (
                        <> (missing: <span className="font-mono">{emailConfig.missing.join(', ')}</span>)</>
                      )}
                      , or see the README "Email Configuration" section for setup instructions.
                    </p>
                  </div>
                )}
                {error && (
                  <div role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                    {error}
                  </div>
                )}
                <div>
                  <label htmlFor="fp-email" className="mb-2 block text-sm font-medium text-slate-300">
                    Email
                  </label>
                  <input
                    id="fp-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    disabled={busy || emailNotConfigured}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="min-h-[48px] w-full rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 disabled:opacity-60"
                    placeholder="you@example.com"
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy || !email.trim() || emailNotConfigured}
                  data-testid="forgot-password-submit"
                  title={emailNotConfigured ? 'Email delivery is not configured on this server' : undefined}
                  className="min-h-[48px] w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy
                    ? 'Sending…'
                    : emailNotConfigured
                      ? 'Email delivery unavailable'
                      : 'Send reset link'}
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

export default ForgotPassword;
