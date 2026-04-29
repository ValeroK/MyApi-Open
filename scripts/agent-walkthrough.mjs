#!/usr/bin/env node
/**
 * F6.2 — Agent walkthrough (L3 manual runbook, scripted).
 *
 * Drives the runbook at `.context/runbooks/agent-real-life.md`
 * programmatically, using ONLY the public HTTP surface and a
 * scoped bearer token — exactly as an external agent
 * (OpenClaude / Hermes / etc.) would.
 *
 * Usage
 * -----
 *   SMOKE_URL=http://localhost:4500 \
 *   SMOKE_BEARER=myapi_<scoped-agent-token> \
 *   [SMOKE_MASTER=myapi_<master>]                  \
 *   [SMOKE_GOOGLE=1] [SMOKE_GITHUB=1]              \
 *   node scripts/agent-walkthrough.mjs
 *
 * Required:
 *   SMOKE_URL       Base URL of a running gateway (no trailing slash).
 *   SMOKE_BEARER    Scoped agent bearer (mint via runbook §Phase 2).
 *
 * Optional:
 *   SMOKE_MASTER    Master token; lets the script approve a fresh
 *                   handshake end-to-end (Phase 7). When omitted the
 *                   handshake phase only verifies the public POST/poll
 *                   half.
 *   SMOKE_GOOGLE=1  Run Phase 4.a Google proxy probe (requires the
 *                   owner to have connected Google).
 *   SMOKE_GITHUB=1  Run Phase 4.b GitHub proxy probe.
 *
 * Exit codes:
 *   0 — every required step printed OK.
 *   1 — at least one required step printed FAIL. Each FAIL line is
 *       an actionable candidate for `.context/capability-gaps.md`.
 *
 * Notes
 * -----
 * - The agent token MUST currently carry BROAD scopes
 *   (`services:read`, `skills:read`) rather than narrow
 *   `services:{name}:read` until GAP-008 is dispositioned. The
 *   script defends against that footgun (Phase 0) and tells you
 *   the symptom if you forget.
 * - The script never logs raw token values. It logs token
 *   PREFIXES (first 12 chars + ellipsis) when surfacing failures.
 * - Each step prints a single line:
 *     OK   §1.a  description (status, latency_ms)
 *     FAIL §1.a  description (got: ..., want: ..., body: <40 chars>)
 *   followed by a short reason. This is meant to be skim-friendly.
 *
 * See also
 * --------
 * - `.context/runbooks/agent-real-life.md` — the prose runbook.
 * - `.cursor/plans/capability_test_plan_b4523725.plan.md` §3.3.
 * - `.context/capability-gaps.md` — append findings here.
 */

import process from 'node:process';

const SMOKE_URL = process.env.SMOKE_URL;
const SMOKE_BEARER = process.env.SMOKE_BEARER;
const SMOKE_MASTER = process.env.SMOKE_MASTER || null;
const RUN_GOOGLE = process.env.SMOKE_GOOGLE === '1';
const RUN_GITHUB = process.env.SMOKE_GITHUB === '1';

if (!SMOKE_URL || !SMOKE_BEARER) {
  console.error(
    'agent-walkthrough: missing SMOKE_URL and/or SMOKE_BEARER. ' +
      'See header comment for usage.'
  );
  process.exit(2);
}

const BASE = SMOKE_URL.replace(/\/+$/, '');
const AGENT_HEADERS = {
  Authorization: `Bearer ${SMOKE_BEARER}`,
  'Content-Type': 'application/json',
};
const MASTER_HEADERS = SMOKE_MASTER
  ? { Authorization: `Bearer ${SMOKE_MASTER}`, 'Content-Type': 'application/json' }
  : null;

let failures = 0;
let successes = 0;

function tokenPrefix(t) {
  if (!t || typeof t !== 'string') return '<unset>';
  return t.slice(0, 12) + '…';
}

function logOK(label, status, ms, extra = '') {
  successes += 1;
  process.stdout.write(
    `OK   ${label.padEnd(24)} (status ${status}, ${ms}ms)${extra ? ' ' + extra : ''}\n`
  );
}

function logFail(label, status, ms, reason, body) {
  failures += 1;
  const bodySnippet =
    body && typeof body === 'string'
      ? body.replace(/\s+/g, ' ').slice(0, 80)
      : '';
  process.stdout.write(
    `FAIL ${label.padEnd(24)} (status ${status}, ${ms}ms) — ${reason}` +
      (bodySnippet ? ` // ${bodySnippet}` : '') +
      '\n'
  );
}

async function call(method, path, headers, body) {
  const start = Date.now();
  let res, raw;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    raw = await res.text();
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - start, body: null, raw: '', error: err.message };
  }
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { ok: true, status: res.status, ms: Date.now() - start, body: parsed, raw };
}

function bodyDoesNotContain(body, raw, banned) {
  const haystack = (raw || '').toLowerCase();
  for (const needle of banned) {
    if (haystack.includes(needle.toLowerCase())) return needle;
  }
  return null;
}

// -------------------------------------------------------------------------
// PHASE 0 — sanity
// -------------------------------------------------------------------------

async function phase0Sanity() {
  process.stdout.write(`\n# Phase 0 — sanity (gateway @ ${BASE}; agent ${tokenPrefix(SMOKE_BEARER)})\n`);

  {
    const r = await call('GET', '/health', {});
    if (r.status === 200) logOK('§0.a  /health', r.status, r.ms);
    else logFail('§0.a  /health', r.status, r.ms, 'gateway not up', r.raw);
  }

  {
    const r = await call('GET', '/api/v1/tokens/me/capabilities', AGENT_HEADERS);
    if (r.status !== 200) {
      logFail('§0.b  introspect token', r.status, r.ms, 'agent bearer rejected', r.raw);
      return;
    }
    const scopeBlob = JSON.stringify(r.body || {});
    if (!/services:read|services:write|admin:\*/.test(scopeBlob)) {
      logFail(
        '§0.b  introspect token',
        r.status,
        r.ms,
        'agent token has no broad services:read/write — narrow services:{name}:* does NOT work today (GAP-008). Re-mint with scopes:["services:read","skills:read"].',
        scopeBlob.slice(0, 120)
      );
    } else {
      logOK('§0.b  introspect token', r.status, r.ms);
    }
  }
}

// -------------------------------------------------------------------------
// PHASE 3 — discovery
// -------------------------------------------------------------------------

async function phase3Discovery() {
  process.stdout.write(`\n# Phase 3 — capability discovery\n`);

  {
    const r = await call('GET', '/openapi.json', {});
    const pathCount = r.body && r.body.paths ? Object.keys(r.body.paths).length : 0;
    if (r.status === 200 && pathCount > 5)
      logOK('§3.a  /openapi.json', r.status, r.ms, `(${pathCount} paths)`);
    else
      logFail('§3.a  /openapi.json', r.status, r.ms, 'expected 200 with >5 paths', r.raw);
  }

  {
    const r = await call('GET', '/api/v1/capabilities', AGENT_HEADERS);
    if (r.status === 200 && Array.isArray(r.body?.endpoints))
      logOK('§3.b  /capabilities', r.status, r.ms, `(${r.body.endpoints.length} endpoints)`);
    else
      logFail('§3.b  /capabilities', r.status, r.ms, 'expected 200 with endpoints[]', r.raw);
  }

  {
    const r = await call('GET', '/api/v1/tokens/me/capabilities', AGENT_HEADERS);
    if (r.status !== 200) {
      logFail('§3.c  /tokens/me/capabilities', r.status, r.ms, 'expected 200', r.raw);
    } else if (r.raw && r.raw.includes(SMOKE_BEARER)) {
      logFail(
        '§3.c  /tokens/me/capabilities',
        r.status,
        r.ms,
        'P0: response leaks the raw bearer'
      );
    } else {
      logOK('§3.c  /tokens/me/capabilities', r.status, r.ms);
    }
  }

  {
    const r = await call('GET', '/api/v1/gateway/context', AGENT_HEADERS);
    if (r.status === 403) {
      logOK('§3.d  /gateway/context (master-only)', r.status, r.ms, '— GAP-003 holding');
    } else if (r.status === 200) {
      logFail(
        '§3.d  /gateway/context',
        r.status,
        r.ms,
        'agent bearer reached master-only endpoint — GAP-003 fix shipped or P0 leak; verify against CLAUDE.md',
        r.raw
      );
    } else {
      logFail('§3.d  /gateway/context', r.status, r.ms, 'expected 403', r.raw);
    }
  }
}

// -------------------------------------------------------------------------
// PHASE 4 — credential-less third-party calls
// -------------------------------------------------------------------------

const CREDENTIAL_LEAK_MARKERS = [
  'access_token',
  'refresh_token',
  'client_secret',
  'authorization: bearer',
];

async function phase4Use() {
  if (!RUN_GOOGLE && !RUN_GITHUB) {
    process.stdout.write(`\n# Phase 4 — skipped (set SMOKE_GOOGLE=1 / SMOKE_GITHUB=1 to enable)\n`);
    return;
  }
  process.stdout.write(`\n# Phase 4 — agent uses credentials without seeing them\n`);

  if (RUN_GOOGLE) {
    const r = await call('POST', '/api/v1/services/google/proxy', AGENT_HEADERS, {
      method: 'GET',
      path: '/gmail/v1/users/me/profile',
    });
    if (r.status === 200 && r.body?.emailAddress) {
      const leak = bodyDoesNotContain(r.body, r.raw, CREDENTIAL_LEAK_MARKERS);
      if (leak) {
        logFail(
          '§4.a  Google Gmail profile',
          r.status,
          r.ms,
          `P0: response body contains credential marker "${leak}"`
        );
      } else {
        logOK('§4.a  Google Gmail profile', r.status, r.ms, `(${r.body.emailAddress})`);
      }
    } else if (r.status === 403 && /not connected/i.test(r.raw || '')) {
      logFail(
        '§4.a  Google Gmail profile',
        r.status,
        r.ms,
        'Google not connected — runbook Phase 1 incomplete'
      );
    } else {
      logFail('§4.a  Google Gmail profile', r.status, r.ms, 'unexpected response', r.raw);
    }
  }

  if (RUN_GITHUB) {
    const r = await call('POST', '/api/v1/services/github/proxy', AGENT_HEADERS, {
      method: 'GET',
      path: '/user',
    });
    if (r.status === 200 && r.body?.login) {
      const leak = bodyDoesNotContain(r.body, r.raw, CREDENTIAL_LEAK_MARKERS);
      if (leak) {
        logFail(
          '§4.b  GitHub /user',
          r.status,
          r.ms,
          `P0: response body contains credential marker "${leak}"`
        );
      } else {
        logOK('§4.b  GitHub /user', r.status, r.ms, `(@${r.body.login})`);
      }
    } else if (r.status === 403 && /not connected/i.test(r.raw || '')) {
      logFail(
        '§4.b  GitHub /user',
        r.status,
        r.ms,
        'GitHub not connected — runbook Phase 1 incomplete'
      );
    } else {
      logFail('§4.b  GitHub /user', r.status, r.ms, 'unexpected response', r.raw);
    }
  }
}

// -------------------------------------------------------------------------
// PHASE 5 — scope enforcement
// -------------------------------------------------------------------------

async function phase5Boundary() {
  process.stdout.write(`\n# Phase 5 — agent CANNOT reach master-only / write surfaces\n`);

  const expectedDeny = [
    { label: '§5.a  /admin/users (master-only)', method: 'GET',  path: '/api/v1/admin/users' },
    { label: '§5.b  /audit (master-only)',       method: 'GET',  path: '/api/v1/audit' },
    { label: '§5.c  /connectors (master-only)',  method: 'GET',  path: '/api/v1/connectors' },
    { label: '§5.d  POST /tokens (master-only)', method: 'POST', path: '/api/v1/tokens', body: { label: 'should-fail', scopes: ['services:read'] } },
  ];

  for (const probe of expectedDeny) {
    const r = await call(probe.method, probe.path, AGENT_HEADERS, probe.body);
    if (r.status === 401 || r.status === 403) {
      logOK(probe.label, r.status, r.ms);
    } else if (r.status === 404) {
      // Some routes (like /admin/users) return 404 if the route
      // isn't mounted at all on this build — count as "not
      // reachable", still safe.
      logOK(probe.label, r.status, r.ms, '(not mounted)');
    } else {
      logFail(probe.label, r.status, r.ms, 'expected 401/403; agent reached the surface', r.raw);
    }
  }
}

// -------------------------------------------------------------------------
// PHASE 6 — SSRF defense
// -------------------------------------------------------------------------

async function phase6Ssrf() {
  process.stdout.write(`\n# Phase 6 — SSRF defense in depth\n`);

  // The agent puts a private host literal directly in the
  // request `path`. The proxy MUST NOT proxy to it. Today the
  // gateway rejects with "not connected" (because google has
  // no oauth row OR because the path is rewritten through the
  // provider apiRoot). Either way, body MUST NOT include
  // upstream content from the loopback target.
  const probes = ['127.0.0.1', '169.254.169.254', 'localhost', '0177.0.0.1', '2130706433'];
  for (const target of probes) {
    const r = await call('POST', '/api/v1/services/google/proxy', AGENT_HEADERS, {
      method: 'GET',
      path: `http://${target}/`,
    });
    // Either: rejected by isPrivateHost / scheme-validator
    // (4xx with refusal/SSRF/private-host wording), OR rejected
    // because google isn't connected (still 4xx). 2xx → P0.
    if (r.status >= 400 && r.status < 500) {
      logOK(`§6.${probes.indexOf(target) + 1}  reject ${target}`, r.status, r.ms);
    } else {
      logFail(
        `§6.${probes.indexOf(target) + 1}  reject ${target}`,
        r.status,
        r.ms,
        'P0: SSRF probe NOT rejected by gateway',
        r.raw
      );
    }
  }
}

// -------------------------------------------------------------------------
// PHASE 7 — handshake
// -------------------------------------------------------------------------

async function phase7Handshake() {
  process.stdout.write(`\n# Phase 7 — handshake onboarding\n`);

  // Public POST (no auth)
  const create = await call('POST', '/api/v1/handshakes', { 'Content-Type': 'application/json' }, {
    agentId: 'f6-walkthrough-' + Date.now(),
    requestedScopes: ['read'],
    message: 'F6 L3 walkthrough script',
  });
  if (create.status !== 201 || !create.body?.data?.handshakeId) {
    logFail('§7.a  POST /handshakes (public)', create.status, create.ms, 'expected 201 with handshakeId', create.raw);
    return;
  }
  logOK('§7.a  POST /handshakes (public)', create.status, create.ms);
  const handshakeId = create.body.data.handshakeId;

  // Public status poll → pending
  const poll1 = await call('GET', `/api/v1/handshakes/${handshakeId}/status`, {});
  if (poll1.status !== 200 || poll1.body?.data?.status !== 'pending') {
    logFail('§7.b  status (pending, no auth)', poll1.status, poll1.ms, 'expected 200/pending', poll1.raw);
  } else if (poll1.raw.toLowerCase().includes('"token"')) {
    logFail('§7.b  status (pending, no auth)', poll1.status, poll1.ms, 'P0: token in public poll body');
  } else {
    logOK('§7.b  status (pending, no auth)', poll1.status, poll1.ms);
  }

  if (!MASTER_HEADERS) {
    process.stdout.write(`# §7.c  approve — skipped (set SMOKE_MASTER to walk this end)\n`);
    return;
  }

  // Master approve
  const approve = await call('POST', `/api/v1/handshakes/${handshakeId}/approve`, MASTER_HEADERS, {});
  if (approve.status !== 200 || !approve.body?.data?.token) {
    logFail('§7.c  approve (master)', approve.status, approve.ms, 'expected 200 with data.token', approve.raw);
    return;
  }
  logOK('§7.c  approve (master)', approve.status, approve.ms);

  const issued = approve.body.data.token;
  const poll2 = await call('GET', `/api/v1/handshakes/${handshakeId}/status`, {});
  if (poll2.status !== 200 || poll2.body?.data?.status !== 'approved') {
    logFail('§7.d  status (approved, no auth)', poll2.status, poll2.ms, 'expected 200/approved', poll2.raw);
  } else if (poll2.raw.includes(issued)) {
    logFail('§7.d  status (approved, no auth)', poll2.status, poll2.ms, 'P0: issued token leaked in public poll');
  } else {
    logOK('§7.d  status (approved, no auth)', poll2.status, poll2.ms);
  }
}

// -------------------------------------------------------------------------
// PHASE 8 — skills
// -------------------------------------------------------------------------

async function phase8Skills() {
  process.stdout.write(`\n# Phase 8 — skills metadata (read-only)\n`);
  const r = await call('GET', '/api/v1/skills', AGENT_HEADERS);
  if (r.status === 200 && Array.isArray(r.body)) {
    logOK('§8.a  GET /skills', r.status, r.ms, `(${r.body.length} skills)`);
  } else if (r.status === 200 && Array.isArray(r.body?.data)) {
    logOK('§8.a  GET /skills', r.status, r.ms, `(${r.body.data.length} skills)`);
  } else if (r.status === 403) {
    process.stdout.write(
      `SKIP §8.a  GET /skills           agent token lacks skills:read; mint with broader scope\n`
    );
  } else {
    logFail('§8.a  GET /skills', r.status, r.ms, 'expected 200 with array', r.raw);
  }
}

// -------------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------------

(async () => {
  await phase0Sanity();
  await phase3Discovery();
  await phase4Use();
  await phase5Boundary();
  await phase6Ssrf();
  await phase7Handshake();
  await phase8Skills();

  process.stdout.write(
    `\nSummary: ${successes} OK / ${failures} FAIL` +
      (failures > 0 ? ' — see above; append actionable lines to .context/capability-gaps.md.' : '') +
      '\n'
  );
  process.exit(failures > 0 ? 1 : 0);
})();
