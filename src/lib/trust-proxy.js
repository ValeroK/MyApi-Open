// src/lib/trust-proxy.js
//
// M4-T4.8 — env-driven `app.set('trust proxy', …)` configuration.
//
// Closes H5 (req.ip spoofability) by replacing the legacy
// `app.set('trust proxy', 1)` — which honored ANY single-hop
// X-Forwarded-For header from any client — with a CIDR / symbolic
// list driven by the `TRUSTED_PROXIES` env var. The default
// (`['loopback']`) is secure-by-default: X-Forwarded-For is only
// honored when the immediate connection is from 127.0.0.1 / ::1.
//
// Env contract
// ------------
//   TRUSTED_PROXIES (comma-separated, optional)
//
//   Each entry must be one of:
//     - A symbolic name: `loopback`, `linklocal`, `uniquelocal`
//       (these expand to the standard CIDR sets — see proxy-addr).
//     - A bare IPv4 / IPv6 address (e.g. `127.0.0.1`, `::1`).
//     - An IPv4 / IPv6 CIDR (e.g. `10.0.0.0/8`, `2001:db8::/32`).
//
//   Two escape-hatch values:
//     - empty / unset             → defaults to `['loopback']`
//     - `none` or `false`         → returns `false` (no trust at all)
//
// Examples
// --------
//   (unset)                                 → ['loopback']           (default — secure)
//   TRUSTED_PROXIES=none                    → false                  (paranoid mode)
//   TRUSTED_PROXIES=loopback                → ['loopback']           (explicit default)
//   TRUSTED_PROXIES=loopback,uniquelocal    → ['loopback','uniquelocal']  (behind docker bridge)
//   TRUSTED_PROXIES=10.0.0.0/8              → ['10.0.0.0/8']         (behind ALB in 10.x VPC)
//   TRUSTED_PROXIES=127.0.0.1,10.0.0.0/8    → ['127.0.0.1','10.0.0.0/8']
//
// Validation policy
// -----------------
// We FAIL LOUD on any invalid entry. Silent drop on a typo'd CIDR
// could leave the operator thinking they secured req.ip when they
// haven't — that's the same class of error H5 itself is. The error
// message echoes the bad entries verbatim and reminds the operator
// of the accepted forms.
//
// Why a 0-dep regex validator instead of `ipaddr.js`?
// ---------------------------------------------------
// `proxy-addr` (Express's underlying parser) already validates the
// list at app.set() time, but it does so by SILENTLY DROPPING bad
// entries. We want the loud-error path. A small regex validator
// here gives us that without pulling a new dep. The regexes are
// permissive — they catch obvious garbage (`bogus`, `999.999.999.999`,
// `10.0.0.0/99`) but defer the final answer on edge cases to
// proxy-addr. False negatives in our validator manifest as a
// thrown error instead of silent insecurity, which is the safer
// failure mode.

'use strict';

const SYMBOLIC = new Set(['loopback', 'linklocal', 'uniquelocal']);

const IPV4_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/;

function isValidIPv4(addr) {
  if (typeof addr !== 'string') return false;
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => IPV4_OCTET.test(p));
}

function isValidIPv6(addr) {
  // Permissive: must contain at least one colon and consist only of
  // hex / colons. proxy-addr does the canonical parse downstream.
  if (typeof addr !== 'string') return false;
  if (!/^[0-9a-fA-F:]+$/.test(addr)) return false;
  if (!addr.includes(':')) return false;
  return true;
}

function isValidEntry(entry) {
  if (typeof entry !== 'string') return false;
  if (SYMBOLIC.has(entry)) return true;

  const slashIdx = entry.indexOf('/');
  if (slashIdx >= 0) {
    const addr = entry.slice(0, slashIdx);
    const prefix = entry.slice(slashIdx + 1);
    if (!/^\d+$/.test(prefix)) return false;
    const prefixNum = Number(prefix);
    if (isValidIPv4(addr)) return prefixNum >= 0 && prefixNum <= 32;
    if (isValidIPv6(addr)) return prefixNum >= 0 && prefixNum <= 128;
    return false;
  }

  return isValidIPv4(entry) || isValidIPv6(entry);
}

function parseTrustedProxies(envValue) {
  // Empty / unset → secure default.
  if (envValue == null) {
    return ['loopback'];
  }
  const raw = String(envValue).trim();
  if (raw === '') {
    return ['loopback'];
  }

  // Paranoid escape hatch: trust nobody at all.
  if (raw === 'none' || raw === 'false') {
    return false;
  }

  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return ['loopback'];
  }

  const bad = entries.filter((e) => !isValidEntry(e));
  if (bad.length > 0) {
    throw new Error(
      `[trust-proxy] Invalid TRUSTED_PROXIES entries: ${JSON.stringify(bad)}. ` +
        `Each entry must be one of: a symbolic name (loopback, linklocal, uniquelocal), ` +
        `an IPv4 / IPv6 address, or an IPv4 / IPv6 CIDR. ` +
        `Got: ${JSON.stringify(raw)}`,
    );
  }

  return entries;
}

module.exports = {
  parseTrustedProxies,
  isValidEntry,
  isValidIPv4,
  isValidIPv6,
};
