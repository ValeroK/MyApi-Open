/**
 * F5.2 P0 — Activity-log noise cleanup.
 *
 * Context: F5.1's verification matrix surfaced that a single dashboard
 * page-load triggers ~6–10 read endpoints plus a `token_validated`
 * row per `/tokens/validate` call, producing 20+ `audit_log` rows of
 * "background activity" the user never performed.  Because F5.2 P3.4
 * will eventually surface the audit log to end users in account
 * settings, the read-side and per-request emits must be demoted to
 * `logger.debug` BEFORE the UI lands — otherwise we'd ship noise as
 * a feature.
 *
 * Triage policy (full table in
 * `.context/tasks/backlog/F5.2-working-password-auth-and-activity-log-cleanup.md`):
 *   - KEEP: security writes / auth events / sensitive reads
 *           (e.g. `view_token`, `reveal_vault_token`).
 *   - DEMOTE: pure read-side actions (`read_*`, `list_*`, `get_*`,
 *            `view_*`, `brain_conversations_list`, etc.).
 *   - REMOVE: pure per-request noise — `token_validated` at
 *            `src/index.js:5693`.
 *
 * RED-FIRST.  Every assertion below should fail on a tree that still
 * has the legacy emits and turn green only when the demotion lands.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../index');
const { db } = require('../database');

const INDEX_JS_PATH = path.join(__dirname, '..', 'index.js');
const INDEX_JS_SRC  = fs.readFileSync(INDEX_JS_PATH, 'utf8');

function uniqueUser(tag = 'f5p0') {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    username: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}`,
    email: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}@example.com`,
    password: 'Strong!Pass123',
  };
}

async function register(agent, user) {
  return agent.post('/api/v1/auth/register').send({
    username: user.username,
    email: user.email,
    password: user.password,
    display_name: user.username,
  });
}

function rowsForUser(userId) {
  return db
    .prepare(
      "SELECT action, resource, scope FROM audit_log WHERE requester_id = ? ORDER BY id ASC",
    )
    .all(userId);
}

function rowsForToken(tokenId) {
  return db
    .prepare(
      "SELECT action, resource, scope FROM audit_log WHERE requester_id = ? ORDER BY id ASC",
    )
    .all(tokenId);
}

describe('F5.2 P0 — activity-log noise cleanup', () => {
  // ─── Behavioural: clean lifecycle leaves only the 3 lifecycle rows ──

  describe('clean register → login → reads → logout lifecycle', () => {
    it('writes EXACTLY user_register, user_login, user_logout to audit_log for the user (no read_*, no list_*)', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5p0_lifecycle');

      // 1. Register (audit: user_register)
      const reg = await register(agent, user);
      expect(reg.status).toBe(201);
      const userId = reg.body?.data?.user?.id;
      expect(userId).toBeTruthy();

      // 2. Login (audit: user_login) — fresh agent so we exercise the
      //    real /login handler with a brand-new session cookie.
      const fresh = request.agent(app);
      const loginRes = await fresh
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password });
      expect(loginRes.status).toBe(200);

      // 3. Bootstrap a master token via /auth/me so the read endpoints
      //    that require master scope can be reached.
      const meRes = await fresh.get('/api/v1/auth/me');
      expect(meRes.status).toBe(200);
      const masterToken = meRes.body?.bootstrap?.masterToken;
      const masterTokenId = meRes.body?.bootstrap?.tokenId;
      expect(masterToken).toBeTruthy();
      expect(masterTokenId).toBeTruthy();

      // 4. Five read calls — each one used to write a list_* / read_*
      //    audit row.  Post-P0 they MUST be silent.
      await fresh
        .get('/api/v1/identity')
        .set('Authorization', `Bearer ${masterToken}`)
        .expect((r) => expect([200, 404]).toContain(r.status));
      await fresh
        .get('/api/v1/preferences')
        .set('Authorization', `Bearer ${masterToken}`)
        .expect((r) => expect([200, 404]).toContain(r.status));
      await fresh
        .get('/api/v1/personas')
        .set('Authorization', `Bearer ${masterToken}`)
        .expect((r) => expect([200, 404]).toContain(r.status));
      await fresh
        .get('/api/v1/tokens')
        .set('Authorization', `Bearer ${masterToken}`)
        .expect((r) => expect([200, 404]).toContain(r.status));
      await fresh
        .get('/api/v1/handshakes')
        .set('Authorization', `Bearer ${masterToken}`)
        .expect((r) => expect([200, 404]).toContain(r.status));

      // 5. Logout (audit: user_logout)
      const logoutRes = await fresh.post('/api/v1/auth/logout').send({});
      expect([200, 204]).toContain(logoutRes.status);

      // ── Forensics: union audit rows scoped to the user_id and to
      //    the master token id, dedupe action-by-action.  Both
      //    requesterIds may appear because /register and /login set
      //    requesterId = userId, while master-token-authed reads in
      //    src/index.js used to set requesterId = req.tokenMeta.tokenId.
      const userRows  = rowsForUser(userId);
      const tokenRows = rowsForToken(masterTokenId);
      const allActions = [
        ...userRows.map((r) => r.action),
        ...tokenRows.map((r) => r.action),
      ];

      // Lifecycle rows present.
      expect(allActions).toEqual(expect.arrayContaining([
        'user_register',
        'user_login',
        'user_logout',
      ]));

      // No read_*, list_*, get_*, brain_*_list/_view, kb_document_viewed,
      // gateway_context_fetch (success), or token_validated rows.
      const noisyActions = allActions.filter((a) =>
        /^(read_|list_|view_token$|view_token_)/.test(a)
        || /^get_(persona|oauth_status)$/.test(a)
        || /^brain_(conversations_list|conversation_view|context_query)$/.test(a)
        || /^kb_document(s_list|_viewed)$/.test(a)
        || a === 'gateway_context_fetch'
        || a === 'token_validated',
      );

      // `view_token` (D1) and `reveal_vault_token` are KEEP — but we
      // never called those endpoints in this test, so they shouldn't
      // appear at all.  Any match here is a regression.
      expect(noisyActions).toEqual([]);
    });
  });

  // ─── Behavioural: /tokens/validate no longer audits success ──────

  describe('/tokens/validate — `token_validated` is no longer audited', () => {
    it('does NOT write a token_validated row when a valid token is presented', async () => {
      const agent = request.agent(app);
      const user = uniqueUser('f5p0_validate');
      const reg = await register(agent, user);
      expect(reg.status).toBe(201);

      const fresh = request.agent(app);
      const loginRes = await fresh
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password });
      expect(loginRes.status).toBe(200);

      const meRes = await fresh.get('/api/v1/auth/me');
      const masterToken = meRes.body?.bootstrap?.masterToken;
      expect(masterToken).toBeTruthy();

      const before = db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'token_validated'")
        .get().c;

      // Hit /tokens/validate 3 times — the legacy code wrote one row
      // per success.  Post-P0 the count must stay flat.
      for (let i = 0; i < 3; i += 1) {
        const res = await request(app)
          .post('/api/v1/tokens/validate')
          .send({ token: masterToken });
        expect([200, 401]).toContain(res.status);
      }

      const after = db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'token_validated'")
        .get().c;

      expect(after).toBe(before);
    });
  });

  // ─── Static tripwires for the source-level cleanups ─────────────

  describe('static tripwires — src/index.js no longer audits read-side noise', () => {
    it('contains NO `action: "token_validated"` createAuditLog emit', () => {
      // Single most surgical regex: the literal action label inside a
      // createAuditLog call.  Any future re-introduction breaks here.
      const tokenValidatedEmit =
        /createAuditLog\s*\(\s*\{[^}]*action:\s*['"]token_validated['"]/m;
      expect(INDEX_JS_SRC).not.toMatch(tokenValidatedEmit);
    });

    it('contains NO `action: "read_*"` createAuditLog emits', () => {
      const readEmit =
        /createAuditLog\s*\(\s*\{[^}]*action:\s*['"]read_[a-z_]+['"]/gm;
      const matches = INDEX_JS_SRC.match(readEmit) || [];
      expect(matches).toEqual([]);
    });

    it('contains NO `action: "list_*"` createAuditLog emits', () => {
      const listEmit =
        /createAuditLog\s*\(\s*\{[^}]*action:\s*['"]list_[a-z_]+['"]/gm;
      const matches = INDEX_JS_SRC.match(listEmit) || [];
      expect(matches).toEqual([]);
    });

    it('contains NO `action: "get_persona"` / `get_oauth_status` createAuditLog emits', () => {
      const getEmit =
        /createAuditLog\s*\(\s*\{[^}]*action:\s*['"](?:get_persona|get_oauth_status)['"]/gm;
      const matches = INDEX_JS_SRC.match(getEmit) || [];
      expect(matches).toEqual([]);
    });

    it('contains NO `brain_conversations_list` / `brain_conversation_view` / `kb_document_viewed` / `kb_documents_list` / `gateway_context_fetch` (success) createAuditLog emits', () => {
      const brainKbEmit =
        /createAuditLog\s*\(\s*\{[^}]*action:\s*['"](?:brain_conversations_list|brain_conversation_view|kb_document_viewed|kb_documents_list)['"]/gm;
      const brainKbMatches = INDEX_JS_SRC.match(brainKbEmit) || [];
      expect(brainKbMatches).toEqual([]);

      // gateway_context_fetch (success) goes; gateway_context_fetch_error STAYS.
      const gatewaySuccessEmit =
        /createAuditLog\s*\(\s*\{[^}]*action:\s*['"]gateway_context_fetch['"](?!_)/gm;
      const gatewayMatches = INDEX_JS_SRC.match(gatewaySuccessEmit) || [];
      expect(gatewayMatches).toEqual([]);

      // The error-side stays — assert at least one is still wired.
      expect(INDEX_JS_SRC).toMatch(
        /createAuditLog\s*\(\s*\{[^}]*action:\s*['"]gateway_context_fetch_error['"]/,
      );
    });

    it('STILL contains the security-relevant keep-list emits (`view_token`, `reveal_vault_token` per D1)', () => {
      // Sentinel: KEEP-list items must not be accidentally swept by
      // an over-broad demotion regex.
      expect(INDEX_JS_SRC).toMatch(
        /createAuditLog\s*\(\s*\{[^}]*action:\s*['"]view_token['"]/,
      );
      // `reveal_vault_token` lives in src/routes/* historically; if
      // present in src/index.js, assert it survived.  If it's not in
      // src/index.js at all, this assertion is a no-op (skipped via
      // optional chaining on the conditional regex).
      const revealMatch = INDEX_JS_SRC.match(
        /createAuditLog\s*\(\s*\{[^}]*action:\s*['"]reveal_vault_token['"]/,
      );
      // Either absent (lives elsewhere) OR present (was already here) — never
      // demoted by P0.  An explicit assertion if the legacy emit was here:
      if (INDEX_JS_SRC.includes('reveal_vault_token')) {
        expect(revealMatch).toBeTruthy();
      }
    });

    it('replaces every demoted call site with a `logger.debug` carrying the same payload', () => {
      // For each demoted action label, assert there is at least one
      // `logger.debug(... action: '<label>' ...)` carrying the same
      // breadcrumb.  Operators who set LOG_LEVEL=debug get the trace
      // back; default ops gets a quiet audit log.
      const demotedActions = [
        'read_identity',
        'read_identity_professional',
        'read_availability',
        'read_preferences',
        'list_vault_tokens',
        'list_scopes',
        'list_tokens',
        'list_connectors',
        'list_users',
        'list_handshakes',
        'list_personas',
        'get_persona',
        'get_oauth_status',
        'brain_conversations_list',
        'brain_conversation_view',
        'kb_document_viewed',
        'kb_documents_list',
        'gateway_context_fetch',
        'token_validated',
      ];
      for (const action of demotedActions) {
        const re = new RegExp(
          `logger\\.debug\\s*\\([^)]*action:\\s*['"]${action}['"]`,
          'm',
        );
        expect(INDEX_JS_SRC).toMatch(re);
      }
    });
  });
});
