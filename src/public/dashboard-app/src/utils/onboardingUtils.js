// NOTE: These helpers are localStorage-backed stubs added during the M3
// live-smoke dashboard build-out. The full onboarding feature was referenced
// from App.jsx / Settings.jsx / Dashboard.jsx / OnboardingModal.jsx but the
// `onboardingUtils.js` module only exported `wasOnboardingDismissed`. These
// stubs make the build pass and keep onboarding UI inert ("never active")
// so it doesn't interfere with OAuth smoke testing. A future UX milestone
// that actually ships onboarding can replace them.

const DISMISSED_KEY = 'myapi_onboarding_dismissed';
const MODAL_DISMISSED_KEY = 'myapi_onboarding_modal_dismissed';
const MODAL_REQUESTED_KEY = 'myapi_onboarding_modal_requested';
const CHECKLIST_DISMISSED_KEY = 'myapi_onboarding_checklist_dismissed';
const COMPLETED_KEY = 'myapi_onboarding_completed';

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore quota / disabled storage */ }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function wasOnboardingDismissed() {
  return safeGet(DISMISSED_KEY) === '1';
}

export function dismissModal() {
  safeSet(MODAL_DISMISSED_KEY, '1');
}

export function wasModalDismissed() {
  return safeGet(MODAL_DISMISSED_KEY) === '1';
}

export function requestOnboardingModal() {
  safeSet(MODAL_REQUESTED_KEY, '1');
  safeRemove(MODAL_DISMISSED_KEY);
}

export function restartOnboarding() {
  safeRemove(DISMISSED_KEY);
  safeRemove(MODAL_DISMISSED_KEY);
  safeRemove(CHECKLIST_DISMISSED_KEY);
  safeRemove(COMPLETED_KEY);
  safeSet(MODAL_REQUESTED_KEY, '1');
}

export function isOnboardingActive() {
  // Stub: treat onboarding as never active so the UI is inert.
  return false;
}

export function wasChecklistDismissed() {
  return safeGet(CHECKLIST_DISMISSED_KEY) === '1';
}

export function dismissChecklist() {
  safeSet(CHECKLIST_DISMISSED_KEY, '1');
}

export function completeOnboarding() {
  safeSet(COMPLETED_KEY, '1');
}
