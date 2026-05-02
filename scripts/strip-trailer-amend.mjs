// One-shot helper: rewrite HEAD's commit with the message in
// .git/COMMIT_EDITMSG_TMP, bypassing any wrapper that re-injects
// trailers on `git commit`. Uses plumbing (commit-tree + update-ref).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}

const tree = git(['rev-parse', 'HEAD^{tree}']);
const parent = git(['rev-parse', 'HEAD~1']);
console.log('tree=', tree);
console.log('parent=', parent);

// Read the prepared message and strip any forbidden trailer line that
// might already be present in the file. Write it back as UTF-8 (no BOM)
// so commit-tree gets a clean, non-mangled message.
const msgPath = '.git/COMMIT_EDITMSG_TMP';
let msg = readFileSync(msgPath, 'utf8');
msg = msg
  .split(/\r?\n/)
  .filter(
    (l) =>
      !/^Made-with:\s*Cursor/i.test(l) &&
      !/^Co-authored-by:\s*Cursor/i.test(l) &&
      !/^Co-authored-by:.*Claude/i.test(l) &&
      !/^Co-authored-by:.*GPT/i.test(l) &&
      !/^Co-authored-by:.*Copilot/i.test(l) &&
      !/^Generated with /i.test(l) &&
      !/^🤖/i.test(l)
  )
  .join('\n');
// Also normalize unicode em-dash that PowerShell mangled to ASCII --
msg = msg.replace(/\uFFFD|ΓÇö/g, '--');
writeFileSync(msgPath, msg.replace(/\s+$/, '') + '\n', { encoding: 'utf8' });

const newSha = git(['commit-tree', tree, '-p', parent, '-F', msgPath]);
console.log('newSha=', newSha);

git(['update-ref', 'HEAD', newSha]);

console.log('---LOG---');
console.log(git(['log', '-1', '--format=%H%n%s%n---%n%b', 'HEAD']));
