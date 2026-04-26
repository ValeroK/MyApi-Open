#!/usr/bin/env node
/**
 * F5.2 P1 — end-to-end smoke against the live myapi-smoke container.
 *
 *   1. Register a brand-new user.
 *   2. POST /password/reset/request and verify a row landed in
 *      `password_reset_tokens` (via docker exec → sqlite3 read).
 *   3. Pull the raw token from logs (the smoke container runs with
 *      LOG_LEVEL=debug; we tee it through `docker logs`).  As a
 *      fallback, pluck it from the email queue via the API.
 *   4. POST /password/reset/confirm with the new password.
 *   5. Confirm `password_reset_completed` audit row was written.
 *   6. Confirm the new password actually authenticates (POST /login).
 *
 * One-shot, prints a structured PASS/FAIL line per step.  Exits 0
 * on full success; 1 otherwise.
 *
 *   node scripts/f5-2-p1-smoke.js
 *
 * Requires myapi-smoke container running on localhost:4500.
 */

'use strict';

const http = require('http');
const { execSync } = require('child_process');

const BASE = 'http://localhost:4500';
const CONTAINER = 'myapi-smoke';

function uniqId() {
  return Math.random().toString(36).slice(2, 8);
}

function jsonRequest(method, urlPath, body, cookies = []) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = data.length;
    if (cookies.length) headers['Cookie'] = cookies.join('; ');

    const req = http.request(
      { host: 'localhost', port: 4500, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* keep raw */ }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
            raw,
            cookies: parseSetCookies(res.headers['set-cookie']),
          });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function parseSetCookies(headerVal) {
  if (!headerVal) return [];
  const arr = Array.isArray(headerVal) ? headerVal : [headerVal];
  return arr.map((h) => h.split(';')[0]); // name=value only, drop attrs
}

function sqliteQuery(sql) {
  // Run a tiny better-sqlite3 read inside the container.  We pipe
  // the script in via STDIN to side-step Windows shell quoting hell
  // (`docker exec node -e '...'` mangles single/double quotes when
  // the host shell is cmd.exe).
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH || '/app/data/myapi.db', { readonly: true });
    let buf = '';
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => {
      try {
        const rows = db.prepare(buf).all();
        process.stdout.write(JSON.stringify(rows));
      } catch (e) {
        process.stderr.write(JSON.stringify({ error: e.message }));
        process.exit(2);
      }
    });
  `;
  // Two-step exec: write the runner to /app/.tmp_q.js (under the
  // app dir so `require('better-sqlite3')` resolves against
  // /app/node_modules) then exec it with the SQL piped on stdin.
  execSync(`docker exec -i ${CONTAINER} sh -c "cat > /app/.tmp_q.js"`, {
    input: script,
    encoding: 'utf8',
  });
  const out = execSync(`docker exec -i -w /app ${CONTAINER} node /app/.tmp_q.js`, {
    input: sql,
    encoding: 'utf8',
  });
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`sqliteQuery parse failed: ${e.message}\nraw: ${out}`);
  }
}

const steps = [];
function step(name, fn) {
  steps.push({ name, fn });
}

async function main() {
  const tag = `f5p1_${uniqId()}`;
  const username = tag;
  const email = `${tag}@example.com`;
  const oldPw = 'OldPass!1234';
  const newPw = 'NewPass!9876';
  let userId = null;
  let rawToken = null;

  step('container reachable on /health (polled up to 20s)', async () => {
    const deadline = Date.now() + 20_000;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const r = await jsonRequest('GET', '/health');
        if (r.status === 200) return `status=200`;
        lastErr = new Error(`status=${r.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`/health never returned 200: ${lastErr && lastErr.message}`);
  });

  step('register fresh user', async () => {
    const r = await jsonRequest('POST', '/api/v1/auth/register', {
      username,
      email,
      password: oldPw,
      display_name: username,
    });
    if (r.status !== 201) {
      throw new Error(`expected 201, got ${r.status}: ${r.raw.slice(0, 200)}`);
    }
    userId = r.body?.data?.user?.id;
    if (!userId) throw new Error('no user.id in response');
    return `userId=${userId}`;
  });

  step('POST /password/reset/request returns 202', async () => {
    const r = await jsonRequest('POST', '/api/v1/auth/password/reset/request', { email });
    if (r.status !== 202) {
      throw new Error(`expected 202, got ${r.status}: ${r.raw.slice(0, 200)}`);
    }
    return `status=${r.status}`;
  });

  step('a row landed in password_reset_tokens', async () => {
    const rows = sqliteQuery(
      `SELECT id, expires_at, consumed_at FROM password_reset_tokens WHERE user_id = '${userId}' ORDER BY created_at DESC LIMIT 1`,
    );
    if (!rows.length) throw new Error('no token row');
    const row = rows[0];
    if (row.consumed_at) throw new Error('row already consumed??');
    const ttlMs = new Date(row.expires_at).getTime() - Date.now();
    if (ttlMs < 60_000 || ttlMs > 2 * 60 * 60 * 1000 + 60_000) {
      throw new Error(`expires_at out of expected 2h band: ttlMs=${ttlMs}`);
    }
    return `tokenId=${row.id}, ttl≈${Math.round(ttlMs / 60_000)}min`;
  });

  step('extract raw token from container logs', async () => {
    // The reset endpoint emits `[Auth/PasswordReset] dev link` at
    // debug level when the request succeeds.  The smoke container
    // runs with LOG_LEVEL=debug, so docker logs has it within ms.
    // We scan the last ~400 lines and pluck the most recent match.
    const logs = execSync(`docker logs --tail 400 ${CONTAINER} 2>&1`, { encoding: 'utf8' });
    const matches = [...logs.matchAll(/\/reset-password\?token=([A-Fa-f0-9]+)/g)];
    if (!matches.length) {
      throw new Error('no /reset-password?token=... line in last 400 docker log lines');
    }
    rawToken = matches[matches.length - 1][1];
    return `tokenLen=${rawToken.length}`;
  });

  step('POST /password/reset/confirm returns 200', async () => {
    const r = await jsonRequest('POST', '/api/v1/auth/password/reset/confirm', {
      token: rawToken,
      newPassword: newPw,
    });
    if (r.status !== 200) {
      throw new Error(`expected 200, got ${r.status}: ${r.raw.slice(0, 200)}`);
    }
    return `status=${r.status}`;
  });

  step('password_reset_tokens row marked consumed', async () => {
    const rows = sqliteQuery(
      `SELECT consumed_at FROM password_reset_tokens WHERE user_id = '${userId}' ORDER BY created_at DESC LIMIT 1`,
    );
    if (!rows[0]?.consumed_at) throw new Error('row not consumed');
    return `consumed_at=${rows[0].consumed_at}`;
  });

  step('audit_log has password_reset_completed row', async () => {
    const rows = sqliteQuery(
      `SELECT action FROM audit_log WHERE requester_id = '${userId}' AND action = 'password_reset_completed'`,
    );
    if (!rows.length) throw new Error('no password_reset_completed audit row');
    return `count=${rows.length}`;
  });

  step('login with NEW password succeeds', async () => {
    const r = await jsonRequest('POST', '/api/v1/auth/login', { email, password: newPw });
    if (r.status !== 200) {
      throw new Error(`expected 200 with new password, got ${r.status}: ${r.raw.slice(0, 200)}`);
    }
    return 'new password accepted';
  });

  step('login with OLD password fails (401)', async () => {
    const r = await jsonRequest('POST', '/api/v1/auth/login', { email, password: oldPw });
    if (r.status !== 401) {
      throw new Error(`expected 401 with old password, got ${r.status}`);
    }
    return 'old password rejected';
  });

  // NOTE: replay-token (410 INVALID_OR_EXPIRED_TOKEN) is covered
  // deterministically by the Jest suite.  Re-running it from the
  // smoke trips authRateLimit (per-IP, 10/min in dev) because the
  // smoke makes 8+ auth calls in <1s, so the assertion here would
  // race against the rate limiter, not the consumed-token check.

  // ── Run all steps sequentially ────────────────────────────────────
  let passed = 0;
  let failed = 0;
  console.log('────────────── F5.2 P1 — end-to-end smoke ──────────────');
  for (const s of steps) {
    try {
      const detail = await s.fn();
      console.log(`  PASS  ${s.name}${detail ? ` — ${detail}` : ''}`);
      passed += 1;
    } catch (e) {
      console.log(`  FAIL  ${s.name} — ${e.message}`);
      failed += 1;
      // Continue running so we get the full picture in one shot.
    }
  }
  console.log('────────────────────────────────────────────────────────');
  console.log(`Summary: ${passed} passed, ${failed} failed (${steps.length} total)`);
  console.log(`Test user: ${email}`);
  console.log(`User ID:   ${userId || '(not assigned)'}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] fatal:', err);
  process.exit(1);
});
