#!/usr/bin/env node
/**
 * scripts/jest-debug.js
 *
 * One-shot Jest runner + failure-summariser.  Replaces the
 * "npx jest > log; tail; grep failures; grep runtime errors"
 * dance with a single command.
 *
 * Usage:
 *   node scripts/jest-debug.js                     # runs full suite
 *   node scripts/jest-debug.js <patternOrFile>     # forwards to jest
 *   node scripts/jest-debug.js src/tests/foo.test.js --quiet
 *
 * Flags:
 *   --quiet            Only print the summary block, no per-failure details
 *   --no-runtime       Skip the runtime-error / warning extraction
 *   --log <path>       Override the log file path (default: .jest-last.log)
 *   --                 Everything after this is forwarded verbatim to Jest
 *
 * Exit code:
 *   Mirrors the underlying Jest exit code so CI can chain on $?.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ── Argument parsing ──────────────────────────────────────────────────
const argv = process.argv.slice(2);
let quiet = false;
let extractRuntime = true;
let logPath = '.jest-last.log';
const jestArgs = [];
let passthrough = false;

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (passthrough) { jestArgs.push(a); continue; }
  if (a === '--') { passthrough = true; continue; }
  if (a === '--quiet') { quiet = true; continue; }
  if (a === '--no-runtime') { extractRuntime = false; continue; }
  if (a === '--log' && i + 1 < argv.length) { logPath = argv[++i]; continue; }
  jestArgs.push(a);
}

// Always force-exit + bound the timeout so a hang doesn't wedge the
// whole agent loop.
if (!jestArgs.includes('--forceExit')) jestArgs.push('--forceExit');
if (!jestArgs.some((a) => a.startsWith('--testTimeout'))) jestArgs.push('--testTimeout=30000');

// ── Run Jest ──────────────────────────────────────────────────────────
const repoRoot = path.resolve(__dirname, '..');
const absLog = path.resolve(repoRoot, logPath);

console.log(`> npx jest ${jestArgs.join(' ')}`);
console.log(`  log -> ${path.relative(repoRoot, absLog)}`);
console.log('');

// Windows requires `shell: true` to launch `npx.cmd` (and friends);
// on POSIX we keep shell off so quoting stays predictable.
const isWin = process.platform === 'win32';
const child = spawn(
  isWin ? 'npx.cmd' : 'npx',
  ['jest', ...jestArgs],
  { cwd: repoRoot, env: process.env, shell: isWin },
);

const chunks = [];
child.stdout.on('data', (b) => chunks.push(b));
child.stderr.on('data', (b) => chunks.push(b));

child.on('error', (err) => {
  console.error('[jest-debug] failed to spawn jest:', err.message);
  process.exit(1);
});

child.on('close', (exitCode) => {
  const buf = Buffer.concat(chunks);
  fs.writeFileSync(absLog, buf);
  const out = buf.toString('utf8');

  printSummary(out, exitCode, quiet, extractRuntime);
  process.exit(exitCode == null ? 1 : exitCode);
});

// ── Pretty printer ────────────────────────────────────────────────────
function printSummary(out, exitCode, isQuiet, runtime) {
  const lines = out.split(/\r?\n/);

  // Summary lines (Test Suites / Tests / Snapshots / Time).
  const summary = lines.filter((l) => /^(Test Suites|Tests|Snapshots|Time):/.test(l));
  const fails = lines.filter((l) => /^FAIL\s/.test(l));
  const passes = lines.filter((l) => /^PASS\s/.test(l));

  console.log('────────────── Jest Summary ──────────────');
  if (summary.length) {
    summary.forEach((l) => console.log(l));
  } else {
    // Jest never reached its summary: most often "No tests found",
    // a syntax error in a test file, or a config issue.  In every
    // case the captured output is the whole story, so dump it.
    console.log('(Jest produced no summary block — full output below)');
  }
  console.log(`Exit code: ${exitCode}`);
  if (fails.length) console.log(`Failed suites: ${fails.length} (passed: ${passes.length})`);
  console.log('──────────────────────────────────────────');

  // No-summary case: print the captured output verbatim (capped) so
  // there's never a "what happened?" gap.  This is the path the user
  // hit on `does-not-exist-pattern` runs.
  if (!summary.length) {
    const tail = lines.slice(-200);
    console.log('');
    console.log('────────────── Jest output ──────────────');
    if (lines.length === 0) {
      console.log('(stdout/stderr were empty — Jest may have failed to start)');
    } else {
      tail.forEach((l) => console.log(l));
      if (lines.length > tail.length) {
        console.log(`… (${lines.length - tail.length} earlier lines, see ${path.relative(repoRoot, absLog)})`);
      }
    }
  }

  // `--quiet` skips the per-failure / runtime-error sections, but
  // ONLY when the suite actually finished.  If there's no summary
  // we already printed the raw output above and there's nothing
  // more to do.
  if (isQuiet) {
    return;
  }
  if (!summary.length) {
    return;
  }

  // Per-failure block.  Jest separates failures with a leading "● ".
  // We grab from one bullet to the next (or to the next "PASS"/summary).
  const failureBlocks = [];
  let cur = null;
  for (const raw of lines) {
    const isBullet = /^\s*●\s/.test(raw);
    if (isBullet) {
      if (cur) failureBlocks.push(cur);
      cur = [raw];
    } else if (cur) {
      // Stop at summary/pass markers or the "Force exiting" tail.
      if (/^(Test Suites|Tests|Snapshots|Time|Ran all|Force exiting):/.test(raw) ||
          /^PASS\s/.test(raw)) {
        failureBlocks.push(cur);
        cur = null;
      } else {
        cur.push(raw);
      }
    }
  }
  if (cur) failureBlocks.push(cur);

  if (failureBlocks.length) {
    console.log('');
    console.log(`────────────── ${failureBlocks.length} failure(s) ──────────────`);
    failureBlocks.forEach((block, i) => {
      console.log(`\n[${i + 1}] ${block[0].trim()}`);
      // Trim trailing blanks, cap at 30 lines per failure.
      let body = block.slice(1);
      while (body.length && !body[body.length - 1].trim()) body.pop();
      const MAX = 30;
      if (body.length > MAX) {
        body = body.slice(0, MAX).concat([`    … (${block.length - 1 - MAX} more lines, see ${path.relative(repoRoot, absLog)})`]);
      }
      body.forEach((l) => console.log(l));
    });
  }

  if (runtime) {
    const runtimePatterns = [
      /SqliteError/i,
      /TypeError:/,
      /ReferenceError:/,
      /SyntaxError:/,
      /^\s*Error:/,
      /UnhandledPromiseRejection/i,
      /\[Auth\/[A-Za-z]+\] /,
      /\[PasswordReset\]/,
      /no such (table|column)/i,
      /ECONNREFUSED|ETIMEDOUT|EADDRINUSE/,
    ];
    const hits = lines.filter((l) => runtimePatterns.some((p) => p.test(l)));
    if (hits.length) {
      console.log('');
      console.log('────────────── Runtime errors / warnings ──────────────');
      const dedup = Array.from(new Set(hits));
      dedup.slice(0, 40).forEach((l) => console.log(l));
      if (dedup.length > 40) console.log(`… (${dedup.length - 40} more, see ${path.relative(repoRoot, absLog)})`);
    }
  }
}
