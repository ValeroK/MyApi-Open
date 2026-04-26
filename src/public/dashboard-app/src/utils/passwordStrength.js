/**
 * F5.2 P3 — shared password strength heuristic.
 *
 * Mirrors the server-side `isStrongPassword` rule (length ≥ 8 AND at
 * least 3 of: uppercase / lowercase / digit / symbol) so the UI never
 * green-lights a password the API will reject.  This is purely UX —
 * the authoritative check lives server-side in
 * `src/lib/passwordPolicy.js`.
 *
 *   score 0 — empty                               → tone muted
 *   score 1 — too short / single char family      → tone red
 *   score 2 — meets length + ≥3 classes (fair)    → tone amber
 *   score 3 — long (≥12) + ≥3 classes (strong)    → tone green
 */
export function classifyPassword(pw) {
  if (!pw || pw.length < 8) {
    return { score: 0, label: pw ? 'too short' : '', tone: 'muted' };
  }
  let classes = 0;
  if (/[A-Z]/.test(pw)) classes += 1;
  if (/[a-z]/.test(pw)) classes += 1;
  if (/[0-9]/.test(pw)) classes += 1;
  if (/[^A-Za-z0-9]/.test(pw)) classes += 1;

  if (classes < 3) {
    return { score: 1, label: 'weak — add upper/lower/number/symbol', tone: 'red' };
  }
  if (pw.length < 12) return { score: 2, label: 'fair', tone: 'amber' };
  return { score: 3, label: 'strong', tone: 'green' };
}

export default classifyPassword;
