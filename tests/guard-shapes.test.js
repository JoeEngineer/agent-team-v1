// Guard tests for command shapes beyond a plain `git push` / `gh pr merge`:
// subshells, shell wrappers, line continuations, redirections, push-all flags,
// and the same actions done through `gh api`.
// Loaded and run by tests/run.js: node tests/run.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SCRIPTS, tmpProject, run, test, assert, eq } = require('./helpers');

const lib = require(path.join(SCRIPTS, 'lib.js'));

console.log('guard.js: command shapes');
const proj = tmpProject();
const guard = (command, cwd = proj) =>
  run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }, cwd);

function denied(r) {
  try {
    const out = JSON.parse(r.stdout).hookSpecificOutput || {};
    return out.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

const blocked = [
  ['subshell with cd, push to main', '(cd sub && git push origin main)'],
  ['subshell force push', '(git push --force origin task/T-1)'],
  ['command substitution', 'echo $(git push --force origin task/T-1)'],
  ['backtick substitution', 'echo `git push --force origin task/T-1`'],
  ['bash -c', 'bash -c "git push --force origin task/T-1"'],
  ['bash -lc with a chain inside', "bash -lc 'git status && git push origin main'"],
  ['sh -c inside a subshell', '(sh -c "git push origin main")'],
  ['powershell -Command', 'powershell -NoProfile -Command "git push origin main"'],
  ['pwsh -c, unquoted', 'pwsh -c git push origin main'],
  ['cmd /c', 'cmd /c git push origin main'],
  ['eval', 'eval "git push origin main"'],
  ['Invoke-Expression', 'Invoke-Expression "git push --force origin task/T-1"'],
  ['backslash line continuation', 'git push origin task/T-1 \\\n  --force'],
  ['backslash continuation with CRLF', 'git push origin \\\r\n  main'],
  ['PowerShell backtick continuation', 'git push origin task/T-1 `\n  --force'],
  ['PowerShell block without spaces', 'if ($ok) {git push --force origin task/T-1}'],
  ['redirection glued to the branch', 'git push origin main>out.txt'],
  ['push --mirror', 'git push --mirror origin'],
  ['push --prune', "git push --prune origin 'refs/heads/*'"],
  ['gh api -XDELETE (no space)', 'gh api -XDELETE repos/o/r/branches/main/protection'],
  ['gh api --method=DELETE', 'gh api --method=DELETE repos/o/r/rulesets/5'],
  ['gh api merge with unverifiable base', 'gh api -X PUT repos/o/r/pulls/999999/merge'],
  ['gh api delete main ref', 'gh api -X DELETE repos/o/r/git/refs/heads/main'],
  ['gh api delete milestone ref', 'gh api -X DELETE repos/o/r/git/refs/heads/milestone/auth'],
  ['gh api move main ref', 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true'],
  ['gh api merges into main', 'gh api repos/o/r/merges -f base=main -f head=task/T-1'],
  ['gh api rename main', 'gh api -X POST repos/o/r/branches/main/rename -f new_name=old'],
  ['graphql merge mutation', "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'"],
  ['graphql protection mutation', "gh api graphql -f query='mutation { deleteBranchProtectionRule(input: {branchProtectionRuleId: \"x\"}) { clientMutationId } }'"],
];
for (const [name, cmd] of blocked) {
  test(`blocks: ${name}`, () => {
    const r = guard(cmd);
    eq(r.status, 0, 'exit code');
    assert(denied(r), `expected a deny decision for ${JSON.stringify(cmd)}, got ${JSON.stringify(r.stdout)}`);
  });
}

const allowed = [
  ['subshell without a push', '(cd sub && git status)'],
  ['push task branch in a subshell', '(cd sub && git push -u origin task/T-1)'],
  ['commit message mentioning a force push', 'git commit -m "docs: mention git push --force"'],
  ['commit message inside bash -c', "bash -c 'git commit -m \"mention git push --force\"'"],
  ['bash -c without a push', 'bash -c "git status"'],
  ['quoted command substitution that only reads', 'echo "$(git rev-parse HEAD)"'],
  ['stderr redirect after a task push', 'git push origin task/T-1 2>&1'],
  ['PowerShell null redirect', 'git push origin task/T-1 2>$null'],
  ['reflog syntax keeps its braces', 'git stash show stash@{0}'],
  ['continuation on a harmless command', 'git log \\\n  --oneline'],
  ['gh api delete a task ref', 'gh api -X DELETE repos/o/r/git/refs/heads/task/T-1'],
  ['gh api explicit GET with a field', 'gh api -X GET repos/o/r/rulesets -f per_page=5'],
  ['gh api merges into a milestone', 'gh api repos/o/r/merges -f base=milestone/auth -f head=task/T-1'],
  ['graphql query', "gh api graphql -f query='query { viewer { login } }'"],
  ['push --all with no protected branch here', 'git push --all origin'],
];
for (const [name, cmd] of allowed) {
  test(`allows: ${name}`, () => {
    const r = guard(cmd);
    eq(r.status, 0, `exit code (stderr: ${r.stderr.trim()})`);
    eq(r.stdout, '', `no decision for ${JSON.stringify(cmd)}`);
  });
}

test('push --all is blocked while a protected branch exists locally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-all-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('switch', '-q', '-c', 'task/T-9');
  assert(denied(guard('git push --all origin', dir)), '--all with a local main');
  assert(denied(guard('git push --branches origin', dir)), '--branches with a local main');
  eq(guard('git push origin task/T-9', dir).stdout, '', 'a named task branch still goes through');
});

test('segments: braces, parentheses and continuations', () => {
  eq(JSON.stringify(lib.segments('(cd a && git push origin main)')), JSON.stringify([['cd', 'a'], ['git', 'push', 'origin', 'main']]), 'subshell');
  eq(JSON.stringify(lib.segments('{ git status; }')), JSON.stringify([['git', 'status']]), 'block braces dropped');
  eq(JSON.stringify(lib.segments('git diff HEAD@{1} ${x}')), JSON.stringify([['git', 'diff', 'HEAD@{1}', '${x}']]), 'inner braces kept');
  eq(JSON.stringify(lib.segments('git push \\\n origin x')), JSON.stringify([['git', 'push', 'origin', 'x']]), 'continuation joins lines');
  eq(JSON.stringify(lib.segments('git commit -m "a (b) {c} `d`"')), JSON.stringify([['git', 'commit', '-m', 'a (b) {c} `d`']]), 'quoted text untouched');
});

test('findPrMerges sees a merge inside a shell wrapper', () => {
  const found = lib.findPrMerges('bash -c "gh pr merge 12 --squash --delete-branch"');
  eq(found.length, 1, 'one merge');
  eq(found[0].target, '12', 'target');
});
