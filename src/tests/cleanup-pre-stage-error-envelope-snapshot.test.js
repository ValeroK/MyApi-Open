// Cleanup Stage-0 / G0.5 — error-envelope snapshot for /api/v1.
//
// Purpose
// -------
// Pin the SHAPE of every error response the API can plausibly emit
// at each well-known status code, so dashboard / SDK clients keep
// parsing them after M6 (monolith extraction) and M7 (TS migration)
// rearrange the error-throwing code paths.
//
// What we pin
// -----------
// For each representative error case:
//   - HTTP status code
//   - top-level body keys (sorted, presence-only — values vary
//     between runs because of timestamps, request IDs, etc.)
//   - the boolean facts: `is JSON?`, `Content-Type starts with
//     application/json?`, `body has 'error' key?`, `body has
//     'code' key?`, `body has 'message' key?`
//   - the value of `error` when it's a stable enum (e.g.
//     `'CSRF token required'`) — pinning the enum ratchets the
//     error-code vocabulary so a renaming refactor surfaces in the
//     diff.
//
// Why not just snapshot the full body?
// ------------------------------------
// Full bodies contain timestamps, randomly-generated IDs (unique
// users, request_id middleware), and rate-limit windows that
// fluctuate run-to-run. A naive snapshot is a flake factory.
// Capturing the SHAPE plus the STABLE error-code enum is the right
// resolution: refactors that break the contract surface, runs
// don't.
//
// Cases captured
// --------------
//   1. 404 for an unknown /api/v1 route        — generic "not found"
//   2. 400 for missing required body fields     — validation error
//   3. 401 for /me without a session            — auth-missing
//   4. 401 for /login with bad credentials      — auth-rejected
//   5. 409 EMAIL_EXISTS on duplicate register   — domain conflict
//   6. 400 PASSWORD_REUSED on change-password
//        with newPassword === currentPassword   — domain rejection
//
// Updating
// --------
//   npx jest cleanup-pre-stage-error-envelope-snapshot --updateSnapshot
// in the SAME commit as the deliberate envelope change. Reviewers
// must read the snapshot diff for any client breaking change.
//
// Related
// -------
//   - .context/decisions/ADR-0004-cleanup-pre-stage-gates.md
//   - Cleanup plan §"Stage 0 — Cross-cutting baseline" / G0.5
//   - M9 will eventually formalise this as a typed `ErrorEnvelope`;
//     this gate is the migration baseline.

'use strict';

const request = require('supertest');

const emailService = require('../services/emailService');
if (typeof emailService.sendWelcomeEmail !== 'function') {
  emailService.sendWelcomeEmail = async () => undefined;
}
jest.spyOn(emailService, 'sendWelcomeEmail').mockImplementation(async () => undefined);

const { app } = require('../index');

function describeEnvelope(res) {
  const body = res.body || {};
  const ct = String(res.headers['content-type'] || '');
  const isJson = ct.toLowerCase().includes('application/json');
  // Sort keys for snapshot stability — Express occasionally
  // reorders keys when middleware augments the body.
  const topLevelKeys = Object.keys(body).sort();
  return {
    status: res.status,
    contentTypeIsJson: isJson,
    topLevelKeys,
    hasError: Object.prototype.hasOwnProperty.call(body, 'error'),
    hasCode: Object.prototype.hasOwnProperty.call(body, 'code'),
    hasMessage: Object.prototype.hasOwnProperty.call(body, 'message'),
    // Capture the stable error enum (string), but NOT free-form
    // values like 'Internal server error' that can legitimately
    // change wording. Empirically, every real error code in this
    // codebase is either UPPER_SNAKE or a short human sentence.
    errorValue: typeof body.error === 'string' ? body.error : null,
    codeValue: typeof body.code === 'string' ? body.code : null,
  };
}

function uniqueUser(tag = 'g05') {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    username: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}`,
    email: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}@example.com`,
    password: 'Strong!Pass123',
  };
}

describe('[Cleanup Stage 0 / G0.5] error envelope snapshot', () => {
  jest.setTimeout(20_000);

  test('snapshot: unknown /api/v1 route — pins whatever the gate-then-404 contract is', async () => {
    // EMPIRICAL FINDING (G0.5 first run): an unknown path under
    // /api/v1 currently returns 401, NOT 404, because a session-
    // requiring middleware sits in front of the catch-all 404
    // handler. That's a real surface the dashboard depends on:
    // unauthenticated curl-of-typos doesn't leak the route map.
    // We pin BOTH the status and the envelope so M6 can't
    // accidentally reorder the gate during extraction.
    const res = await request(app).get('/api/v1/this-route-does-not-exist');
    expect([401, 403, 404]).toContain(res.status);
    expect(describeEnvelope(res)).toMatchSnapshot('unknown /api/v1 route');
  });

  test('snapshot: 400 — register without required fields', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({});
    expect([400]).toContain(res.status);
    expect(describeEnvelope(res)).toMatchSnapshot('400 register missing fields');
  });

  test('snapshot: 401 — /me without a session', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    // /me may legitimately return 200 with `authenticated: false`
    // OR 401. We snapshot whichever it is — a refactor that
    // flips the contract MUST update the snapshot.
    expect([200, 401]).toContain(res.status);
    expect(describeEnvelope(res)).toMatchSnapshot('GET /me unauthenticated');
  });

  test('snapshot: 401 — login with bad credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: `nobody_${Date.now()}@example.com`, password: 'WhateverWrong!1' });
    expect([400, 401]).toContain(res.status);
    expect(describeEnvelope(res)).toMatchSnapshot('login bad credentials');
  });

  test('snapshot: 409 EMAIL_EXISTS — register duplicate email', async () => {
    const u = uniqueUser('g05_dup');
    const a = await request(app).post('/api/v1/auth/register').send({
      username: u.username,
      email: u.email,
      password: u.password,
      display_name: u.username,
    });
    expect(a.status).toBe(201);

    const b = await request(app).post('/api/v1/auth/register').send({
      username: `${u.username}_other`,
      email: u.email,
      password: u.password,
      display_name: u.username,
    });
    expect(b.status).toBe(409);
    expect(describeEnvelope(b)).toMatchSnapshot('409 EMAIL_EXISTS on register');
  });

  test('snapshot: 400 PASSWORD_REUSED — change to same password', async () => {
    const u = uniqueUser('g05_reuse');
    const agent = request.agent(app);
    const reg = await agent
      .post('/api/v1/auth/register')
      .send({
        username: u.username,
        email: u.email,
        password: u.password,
        display_name: u.username,
      });
    expect(reg.status).toBe(201);

    const change = await agent
      .post('/api/v1/auth/password/change')
      .send({ currentPassword: u.password, newPassword: u.password });
    expect(change.status).toBe(400);
    expect(describeEnvelope(change)).toMatchSnapshot('400 PASSWORD_REUSED');
  });
});
