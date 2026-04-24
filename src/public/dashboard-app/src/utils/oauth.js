// B5/B6 (2026-04-24 F4 hardening): single entry point for every
// "start an OAuth flow" call in the SPA. Previously LogIn.jsx and
// SignUp.jsx hand-rolled their own URLSearchParams construction while
// ServiceConnectors.jsx called this helper — the drift meant any
// defensive addition here (CSRF nonce, telemetry, mode sanitisation)
// silently skipped identity flows. Every call site routes through here
// now and the security-regression tripwires enforce it.
//
// `options`:
//   - mode: 'login' | 'signup' | 'connect'   (default: 'connect')
//   - returnTo: internal path to redirect to after the callback
//   - forcePrompt: boolean — tells the server to set provider-specific
//                  "force re-consent" params (e.g. Google
//                  prompt=select_account, Facebook auth_type=reauthenticate).
//                  Defaults to true for login/signup and false for connect.
export function startOAuthFlow(service, options = {}) {
  try {
    if (!service || typeof service !== 'string' || service.trim().length === 0) {
      throw new Error(`Invalid service parameter: "${service}"`);
    }

    const mode = options.mode || 'connect';
    const isIdentityMode = mode === 'login' || mode === 'signup';
    const forcePrompt = options.forcePrompt != null
      ? !!options.forcePrompt
      : isIdentityMode;

    console.log(`[OAuth] Starting OAuth flow for: ${service}`, { mode, forcePrompt });

    sessionStorage.setItem('oauth_service', service);
    sessionStorage.setItem('oauth_mode', mode);
    if (options.returnTo) sessionStorage.setItem('oauth_returnTo', options.returnTo);

    const params = new URLSearchParams();
    params.append('mode', mode);
    params.append('forcePrompt', forcePrompt ? '1' : '0');
    if (options.returnTo) params.append('returnTo', options.returnTo);

    // Connect-mode MUST bind the state row to the signed-in user on the
    // server. The authorize endpoint resolves ownerId from (session →
    // bearer → cookie); masterToken on the query string is one of the
    // fallback channels and is only relevant when the dashboard runs
    // without a session cookie. Login/signup-mode has no signed-in
    // user yet, so injecting a stale masterToken would bind the state
    // row to the wrong account. Skip injection for identity flows.
    if (!isIdentityMode) {
      const masterToken = localStorage.getItem('masterToken');
      if (masterToken) {
        params.append('token', masterToken);
      } else {
        console.warn(`[OAuth] Connect-mode started without masterToken in localStorage; relying on session cookie.`);
      }
    }

    const endpoint = `/api/v1/oauth/authorize/${service}?${params.toString()}`;
    console.log(`[OAuth] Redirecting to: ${endpoint}`);

    window.location.href = endpoint;

    return new Promise(() => {
      // Intentionally never resolves — navigation unloads the page.
    });
  } catch (error) {
    console.error(`[OAuth] Error starting OAuth flow for ${service}:`, error);
    return Promise.reject(error);
  }
}

export function handleOAuthCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const service = urlParams.get('oauth_service');
  const status = urlParams.get('oauth_status');
  const error = urlParams.get('error');
  const mode = urlParams.get('mode');
  const token = urlParams.get('token');

  if (!service) return null;

  return { service, status, error, mode, token };
}

export function clearOAuthSession() {
  sessionStorage.removeItem('oauth_service');
  sessionStorage.removeItem('oauth_mode');
}

export const AVAILABLE_SERVICES = [
  { id: 'google', name: 'Google Workspace', icon: '🔵', color: '#4285F4', description: 'Sign in with Google Workspace and connect Gmail/Calendar', scopes: ['email', 'profile', 'gmail', 'calendar'] },
  { id: 'github', name: 'GitHub', icon: '🐙', color: '#333333', description: 'Connect to GitHub repositories and account', scopes: ['repo', 'user'] },
  { id: 'facebook', name: 'Facebook', icon: 'f', color: '#1877F2', description: 'Connect to Facebook account', scopes: ['email', 'public_profile', 'user_posts'] },
  { id: 'instagram', name: 'Instagram', icon: '📷', color: '#E4405F', description: 'Connect your Instagram business profile', scopes: ['user_profile', 'user_media'] },
  { id: 'tiktok', name: 'TikTok', icon: '🎵', color: '#111827', description: 'Connect to TikTok account', scopes: ['user.info.basic'] },
  { id: 'twitter', name: 'X / Twitter', icon: '𝕏', color: '#111827', description: 'Connect to X account', scopes: ['tweet.read', 'users.read'] },
  { id: 'reddit', name: 'Reddit', icon: '👽', color: '#FF4500', description: 'Connect to Reddit account', scopes: ['identity', 'read'] },
  { id: 'linkedin', name: 'LinkedIn', icon: 'in', color: '#0A66C2', description: 'Connect to LinkedIn profile and pages', scopes: ['r_liteprofile', 'r_emailaddress'] },
  { id: 'slack', name: 'Slack', icon: '💬', color: '#36C5F0', description: 'Connect to Slack workspace and channels', scopes: ['chat:write', 'chat:read'] },
  { id: 'discord', name: 'Discord', icon: '🎮', color: '#5865F2', description: 'Connect to Discord server and channels', scopes: ['identify', 'email'] },
  { id: 'whatsapp', name: 'WhatsApp', icon: '💬', color: '#25D366', description: 'Connect to WhatsApp Business Account', scopes: ['messages', 'contacts'] },
];

export function getServiceById(serviceId) {
  return AVAILABLE_SERVICES.find((s) => s.id === serviceId);
}

export function formatServiceStatus(status) {
  const statusMap = {
    connected: { label: 'Connected', color: '#10B981', icon: '✓' },
    disconnected: { label: 'Disconnected', color: '#6B7280', icon: '✕' },
    pending: { label: 'Pending', color: '#F59E0B', icon: '⏳' },
    error: { label: 'Error', color: '#EF4444', icon: '!' },
  };

  return statusMap[status] || statusMap.disconnected;
}

export function formatLastSynced(timestamp) {
  if (!timestamp) return 'Never';
  const date = new Date(timestamp);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}
