#!/usr/bin/env node
// scripts/upstream-audit.mjs
//
// Read-only audit of upstream commits since the fork-point that are
// candidates for a per-import mini-plan under .context/imports/.
//
// Source of truth for ADR-0024 (upstream-import-policy) and the F12
// brief (.context/tasks/backlog/F12-upstream-import-2026-05.md).
//
// Usage (PowerShell or bash):
//   node scripts/upstream-audit.mjs                # human-readable report
//   node scripts/upstream-audit.mjs --json         # machine-readable JSON
//   node scripts/upstream-audit.mjs --since=<sha>  # override fork-point
//   node scripts/upstream-audit.mjs --remote=upstream/main  # override head
//   node scripts/upstream-audit.mjs --status       # cross-check mini-plan presence
//
// Prerequisites:
//   - git remote `upstream` configured to omribenami/MyApi-Open
//   - `git fetch upstream` already run (script does NOT fetch — read-only)
//
// The script intentionally:
//   - Does NOT touch the working tree, the index, or the network.
//   - Does NOT add a dependency (uses only Node 20+ built-ins).
//   - Does NOT mutate any file unless `--write-status` is passed
//     (and even then, only writes a summary line at the bottom of
//     .context/imports/.audit-last-run.md — never a mini-plan body).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const IMPORTS_DIR = join(REPO_ROOT, '.context', 'imports');

const DEFAULT_FORK_POINT = '725060bb';
const DEFAULT_REMOTE_HEAD = 'upstream/main';

// Skip-prefix list pulls noise out of the audit. Subjects starting
// with these prefixes are categorised but not surfaced as candidates;
// they're listed under the "filtered" section of the report.
const SKIP_PREFIXES = [
  'sync:', // upstream's own re-sync-from-private commits
  'merge ', // merge commits
  'release:', // upstream's release-pipeline noise
  'changelog', // pure changelog edits
  'docs(landing', // upstream landing-page work
  'docs(legal', // upstream legal-page work (Texas-LLC ToS, etc.)
];

// Subjects matching any of these regexes are categorised as
// "saas-direction" and NOT recommended for import unless the user
// explicitly accepts an ADR-0029 (hosted-product-direction) carve-out.
const SAAS_DIRECTION_PATTERNS = [
  /\bbeta[- ]mode\b/i,
  /\bwaitlist\b/i,
  /\bstripe\b.*\$10/i,
  /\bstripe.*starter/i,
  /\bgithub-dark\b/i,
  /\blanding\b/i,
  /\btexas[- ]llc\b/i,
];

function parseArgs(argv) {
  const args = {
    json: false,
    status: false,
    writeStatus: false,
    forkPoint: DEFAULT_FORK_POINT,
    remoteHead: DEFAULT_REMOTE_HEAD,
  };
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true;
    else if (a === '--status') args.status = true;
    else if (a === '--write-status') args.writeStatus = true;
    else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a.startsWith('--since=')) {
      args.forkPoint = a.slice('--since='.length);
    } else if (a.startsWith('--remote=')) {
      args.remoteHead = a.slice('--remote='.length);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
}

function ensureRemoteRefExists(ref) {
  try {
    git(['rev-parse', '--verify', ref]);
  } catch {
    throw new Error(
      `Ref ${ref} not found locally. Run \`git fetch upstream\` first; this script is read-only and never fetches.`
    );
  }
}

function listCandidateCommits({ forkPoint, remoteHead }) {
  ensureRemoteRefExists(forkPoint);
  ensureRemoteRefExists(remoteHead);

  // Format: <hash>\t<author email>\t<iso date>\t<subject>
  // %x09 is a literal tab; safer than spaces because subjects can have anything.
  const raw = git([
    'log',
    `${forkPoint}..${remoteHead}`,
    '--pretty=format:%H%x09%ae%x09%aI%x09%s',
    '--no-merges',
    '--reverse',
  ]);

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, ...rest] = line.split('\t');
      return {
        hash,
        shortHash: hash.slice(0, 7),
        author,
        date,
        subject: rest.join('\t'),
      };
    });
}

function classify(commit) {
  const subjectLower = commit.subject.toLowerCase();
  for (const prefix of SKIP_PREFIXES) {
    if (subjectLower.startsWith(prefix)) {
      return { category: 'skip', reason: `skip-prefix: ${prefix}` };
    }
  }
  for (const re of SAAS_DIRECTION_PATTERNS) {
    if (re.test(commit.subject)) {
      return { category: 'saas-direction', reason: `matches ${re}` };
    }
  }
  if (/security|fix\(.*sec|cve|sanitis|sanitiz|csp|hsts/i.test(commit.subject)) {
    return { category: 'security', reason: 'security keyword' };
  }
  if (/anomaly|tokenSecurity|asnLookup/i.test(commit.subject)) {
    return { category: 'architectural', reason: 'matches anomaly-detection pattern (needs ADR-0026)' };
  }
  if (/gmail.*(send|trash|modify)/i.test(commit.subject)) {
    return { category: 'architectural', reason: 'gmail write surface (needs ADR-0025)' };
  }
  if (/admin.*broadcast|broadcast.*page/i.test(commit.subject)) {
    return { category: 'architectural', reason: 'admin broadcast (needs ADR-0027)' };
  }
  if (/ticket/i.test(commit.subject)) {
    return { category: 'architectural', reason: 'tickets capability (needs ADR-0028)' };
  }
  if (/onboarding|wizard/i.test(commit.subject)) {
    return { category: 'capability', reason: 'onboarding/wizard UX' };
  }
  if (/notification|connected_services|ai instruction|gateway/i.test(commit.subject)) {
    return { category: 'capability', reason: 'agent-gateway-thesis fit' };
  }
  if (/feat/i.test(commit.subject)) {
    return { category: 'capability', reason: 'feat commit' };
  }
  return { category: 'unclassified', reason: 'no rule matched' };
}

function listExistingMiniPlans() {
  if (!existsSync(IMPORTS_DIR)) return new Map();
  const out = new Map();
  for (const name of readdirSync(IMPORTS_DIR)) {
    if (!name.endsWith('.md')) continue;
    if (name.startsWith('.')) continue;
    if (name === 'README.md') continue;
    const m = name.match(/^([0-9a-f]{7,})-/);
    if (!m) continue;
    const path = join(IMPORTS_DIR, name);
    let status = 'unknown';
    try {
      const body = readFileSync(path, 'utf8');
      const sm = body.match(/^- *Status:\s*([a-z-]+)/im);
      if (sm) status = sm[1];
    } catch {
      /* ignore */
    }
    out.set(m[1], { name, path, status });
  }
  return out;
}

function buildReport(commits, miniPlans) {
  const buckets = {
    security: [],
    capability: [],
    architectural: [],
    'saas-direction': [],
    skip: [],
    unclassified: [],
  };
  for (const c of commits) {
    const klass = classify(c);
    const planEntry = [...miniPlans.entries()].find(([k]) => c.hash.startsWith(k) || k.startsWith(c.shortHash));
    const row = {
      ...c,
      ...klass,
      miniPlan: planEntry ? planEntry[1].name : null,
      miniPlanStatus: planEntry ? planEntry[1].status : null,
    };
    buckets[klass.category].push(row);
  }
  return buckets;
}

function renderHuman({ buckets, forkPoint, remoteHead, totalCommits, miniPlanCount }) {
  const lines = [];
  lines.push('# Upstream audit report');
  lines.push('');
  lines.push(`- Fork-point:        ${forkPoint}`);
  lines.push(`- Upstream head:     ${remoteHead}`);
  lines.push(`- Commits in range:  ${totalCommits}`);
  lines.push(`- Mini-plans on disk: ${miniPlanCount}`);
  lines.push('');
  for (const [bucket, rows] of Object.entries(buckets)) {
    lines.push(`## ${bucket} (${rows.length})`);
    if (rows.length === 0) {
      lines.push('  (none)');
      lines.push('');
      continue;
    }
    for (const r of rows) {
      const tag = r.miniPlan ? `[${r.miniPlanStatus || 'unknown'}]` : '[no plan]';
      lines.push(`  ${r.shortHash}  ${r.date.slice(0, 10)}  ${tag}  ${r.subject}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      [
        'Usage: node scripts/upstream-audit.mjs [options]',
        '',
        '  --json                 emit JSON report on stdout',
        '  --status               cross-check mini-plan files in .context/imports/',
        '  --write-status         append summary to .context/imports/.audit-last-run.md',
        '  --since=<sha>          override fork-point (default 725060bb)',
        '  --remote=<ref>         override upstream head (default upstream/main)',
        '',
        'Read-only. Never fetches. Never edits mini-plans. ADR-0024.',
        '',
      ].join('\n')
    );
    return;
  }

  const commits = listCandidateCommits(args);
  const miniPlans = args.status || args.writeStatus || true ? listExistingMiniPlans() : new Map();
  const buckets = buildReport(commits, miniPlans);

  const summary = {
    forkPoint: args.forkPoint,
    remoteHead: args.remoteHead,
    totalCommits: commits.length,
    miniPlanCount: miniPlans.size,
    generatedAt: new Date().toISOString(),
    buckets,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2));
    process.stdout.write('\n');
  } else {
    process.stdout.write(renderHuman(summary));
    process.stdout.write('\n');
  }

  if (args.writeStatus) {
    const stamp = new Date().toISOString();
    const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
    const line = `- ${stamp}  fork=${args.forkPoint}  head=${args.remoteHead}  total=${commits.length}  miniPlans=${miniPlans.size}  ${JSON.stringify(counts)}\n`;
    const target = join(IMPORTS_DIR, '.audit-last-run.md');
    let prev = '';
    if (existsSync(target)) prev = readFileSync(target, 'utf8');
    if (!prev.startsWith('# Upstream audit history')) {
      prev = '# Upstream audit history\n\n' + prev;
    }
    writeFileSync(target, prev + line, 'utf8');
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`upstream-audit: ${err.message}\n`);
  process.exit(1);
}
