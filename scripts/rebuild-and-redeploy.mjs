#!/usr/bin/env node
/**
 * Build the Vite dashboard into src/public/dist/, then redeploy via Docker.
 *
 * Usage (from repo root):
 *   node scripts/rebuild-and-redeploy.mjs           # default: smoke stack
 *   node scripts/rebuild-and-redeploy.mjs smoke
 *   node scripts/rebuild-and-redeploy.mjs prod    # docker-compose.prod.yml
 *   node scripts/rebuild-and-redeploy.mjs dev     # docker-compose.yml (myapi-dev)
 *
 * npm: npm run redeploy [-- smoke|prod|dev]
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = (process.argv[2] || 'smoke').toLowerCase();

function run(cmd, args, extra = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: true,
    ...extra,
  });
  return r.status ?? 0;
}

const buildStatus = run('npm', ['run', 'dashboard:build']);
if (buildStatus !== 0) process.exit(buildStatus);

if (mode === 'smoke') {
  const st = run('docker', ['restart', 'myapi-smoke'], { shell: false });
  if (st === 0) process.exit(0);
  console.log('[redeploy] docker restart myapi-smoke failed (container missing?); running npm run docker:smoke …');
  process.exit(run('npm', ['run', 'docker:smoke']));
}

if (mode === 'prod') {
  process.exit(run('docker', ['compose', '-f', 'docker-compose.prod.yml', 'up', '-d', '--build'], { shell: false }));
}

if (mode === 'dev') {
  process.exit(run('docker', ['compose', '-f', 'docker-compose.yml', 'up', '-d', '--build'], { shell: false }));
}

console.error(`[redeploy] Unknown mode "${mode}". Use: smoke | prod | dev`);
process.exit(2);
