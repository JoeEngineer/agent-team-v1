// Guard parsing shapes for both CLIs: flags before the subcommand
// (`glab mr -R g/p merge 5`), attached -R values (`-Rg/p`), grouped and
// repeated api methods (`-iX PUT`, `-X GET -X PUT`), and a protected branch in
// the endpoint's query string. Each of these let a merge or write through
// before 0.5.0's review fixes.
// Loaded and run by tests/run.js: node tests/run.js
'use strict';

const fs = require('fs');
const path = require('path');
const { SCRIPTS, tmpProject, run, fakeGh, fakeGlab, readLog, test, assert, eq } = require('./helpers');

const forge = require(path.join(SCRIPTS, 'forge.js'));
const lib = require(path.join(SCRIPTS, 'lib.js'));

const mr = (iid, state, target, extra = {}) => JSON.stringify({
  id: 1000 + iid, iid, project_id: 7, title: `MR ${iid}`, state,
  target_branch: target, source_branch: `task/T-${iid}`, merge_when_pipeline_succeeds: false, ...extra,
});
const pr = (n, base) => JSON.stringify({ number: n, state: 'OPEN', autoMergeRequest: null, baseRefName: base });

function denied(r) {
  try { return (JSON.parse(r.stdout).hookSpecificOutput || {}).permissionDecision === 'deny'; } catch { return false; }
}
const reason = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason; } catch { return ''; } };

const proj = tmpProject();
const guard = (command, env = {}) =>
  run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: proj }, proj, env);

// Run the guard and return the arguments the fake CLI was called with.
function lookupArgs(command, env) {
  const argsFile = path.join(proj, `args-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const r = guard(command, { ...env, FAKE_GH_ARGS: argsFile });
  const calls = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  if (fs.existsSync(argsFile)) fs.rmSync(argsFile);
  return { r, args: (calls.pop() || []).join(' ') };
}

console.log('lib.js: command words and -R forms');

test('commandWords: flags before the subcommand move after it', () => {
  eq(lib.glabParts(['glab', 'mr', '-R', 'g/p', 'merge', '5']).join(' '), 'mr merge -R g/p 5', 'glab -R');
  eq(lib.glabParts(['glab', 'mr', '--repo=g/p', 'merge', '5']).join(' '), 'mr merge --repo=g/p 5', 'glab --repo=');
  eq(lib.ghParts(['gh', 'pr', '-R', 'o/r', 'merge', '5']).join(' '), 'pr merge -R o/r 5', 'gh -R');
  eq(lib.glabParts(['glab', 'api', '-X', 'PUT', 'projects/:id']).join(' '), 'api -X PUT projects/:id', 'api args untouched');
  eq(lib.ghParts(['gh', 'pr', 'merge', '5', '-R', 'o/r']).join(' '), 'pr merge 5 -R o/r', 'normal order untouched');
});

test('merge targets: -Rx, -R=x, --repo x, short clusters', () => {
  const t = (cmd) => { const [m] = lib.findMerges(cmd); return m ? `${m.target}@${m.repo}` : 'none'; };
  eq(t('glab mr merge 5 -Rother/proj'), '5@other/proj', 'glab -Rx');
  eq(t('glab mr merge 5 -R=other/proj'), '5@other/proj', 'glab -R=x');
  eq(t('glab mr merge 5 -sR other/proj'), '5@other/proj', 'glab -sR x');
  eq(t('glab mr -R g/p merge 5 --yes'), '5@g/p', 'glab -R before subcommand');
  eq(t('glab mr merge -m "closes 9" 5'), '5@null', 'glab -m value skipped');
  eq(t('gh pr merge 5 -Ro/r'), '5@o/r', 'gh -Rx');
  eq(t('gh pr -R o/r merge 5 --squash'), '5@o/r', 'gh -R before subcommand');
  eq(t('gh pr merge -b "fixes 9" 5'), '5@null', 'gh -b value skipped');
});

console.log('guard.js: parsing shapes');

const blocked = [
  // B1: a flag between the command group and its subcommand.
  ['glab mr -R before merge', 'glab mr -R other/proj merge 5 --yes', fakeGlab(mr(5, 'opened', 'main'))],
  ['glab mr --repo before merge', 'glab mr --repo other/proj merge 5', fakeGlab(mr(5, 'opened', 'main'))],
  ['glab merge-request -R before accept', 'glab merge-request -R g/p accept 5', fakeGlab(mr(5, 'opened', 'main'))],
  ['glab release -R before create', 'glab release -R g/p create v1', fakeGlab('', 1)],
  ['glab repo -R before delete', 'glab repo -R g/p delete --yes', fakeGlab('', 1)],
  ['gh pr -R before merge', 'gh pr -R o/r merge 5', fakeGh(pr(5, 'main'))],
  ['gh release -R before create', 'gh release -R o/r create v1', fakeGh('', 1)],
  // B2: attached -R values.
  ['glab mr merge -Rx into main', 'glab mr merge 5 -Rother/proj', fakeGlab(mr(5, 'opened', 'main'))],
  ['gh pr merge -Rx into main', 'gh pr merge 5 -Ro/r', fakeGh(pr(5, 'main'))],
  // B3: grouped or repeated methods.
  ['glab api -iX PUT merge', 'glab api -iX PUT projects/:id/merge_requests/5/merge', fakeGlab(mr(5, 'opened', 'main'))],
  ['glab api -X GET -X PUT merge', 'glab api -X GET -X PUT projects/:id/merge_requests/5/merge', fakeGlab(mr(5, 'opened', 'main'))],
  ['glab api -X GET -X DELETE protected branch', 'glab api -X GET -X DELETE projects/:id/protected_branches/main', fakeGlab('', 1)],
  ['glab api -X with no value', 'glab api projects/:id/protected_branches/main -X', fakeGlab('', 1)],
  ['gh api -iX PUT merge', 'gh api -iX PUT repos/o/r/pulls/5/merge', fakeGh(pr(5, 'main'))],
  ['gh api -X GET -X DELETE protection', 'gh api -X GET -X DELETE repos/o/r/branches/main/protection', fakeGh('', 1)],
  // B4: protected branch in the query string, and fields in grouped flags.
  ['glab api file edit, branch in query', 'glab api -X PUT "projects/:id/repository/files/README.md?branch=main&content=x&commit_message=y"', fakeGlab('', 1)],
  ['glab api commit, branch in query', 'glab api -X POST "projects/:id/repository/commits?branch=main&commit_message=x"', fakeGlab('', 1)],
  ['glab api commit, encoded branch in query', 'glab api -X POST "projects/:id/repository/commits?branch=%6Dain&commit_message=x"', fakeGlab('', 1)],
  ['glab api commit, -if branch=main', 'glab api projects/:id/repository/commits -if branch=main -f commit_message=x', fakeGlab('', 1)],
  ['glab api commit, --field=branch=main', 'glab api projects/:id/repository/commits --field=branch=main', fakeGlab('', 1)],
  ['gh api merges, base in query', 'gh api -X POST "repos/o/r/merges?base=main&head=task/T-1"', fakeGh('', 1)],
  // B5: named paths that had no test.
  ['glab repo update', 'glab repo update team/app --description x', fakeGlab('', 1)],
  ['glab repo edit', 'glab repo edit team/app --description x', fakeGlab('', 1)],
  ['glab release delete', 'glab release delete v1 --yes', fakeGlab('', 1)],
  ['glab release upload', 'glab release upload v1 dist/app.tgz', fakeGlab('', 1)],
  ['glab release update', 'glab release update v1 --notes x', fakeGlab('', 1)],
  ['glab api protected tags', 'glab api -X POST projects/:id/protected_tags -f name=v*', fakeGlab('', 1)],
  ['glab api transfer project', 'glab api -X PUT projects/:id/transfer -f namespace=other', fakeGlab('', 1)],
];
for (const [name, cmd, env] of blocked) {
  test(`guard blocks: ${name}`, () => {
    assert(denied(guard(cmd, env)), `should block: ${cmd}`);
  });
}

const allowed = [
  ['last method wins (GET read)', 'glab api -X PUT -X GET projects/:id/protected_branches', fakeGlab('', 1)],
  ['commit to a task branch, branch in query', 'glab api -X POST "projects/:id/repository/commits?branch=task%2FT-1&commit_message=x"', fakeGlab('', 1)],
  ['grouped GET with a field', 'glab api -iX GET projects/:id/merge_requests -f state=opened', fakeGlab('', 1)],
  ['gh api grouped GET', 'gh api -iX GET repos/o/r/rulesets', fakeGh('', 1)],
];
for (const [name, cmd, env] of allowed) {
  test(`guard allows: ${name}`, () => {
    const r = guard(cmd, env);
    assert(!denied(r), `should allow: ${cmd} — ${reason(r)}`);
  });
}

test('guard: -R before the subcommand is passed to the lookup', () => {
  const a = lookupArgs('glab mr -R team/app merge 5 --yes', fakeGlab(mr(5, 'opened', 'milestone/auth')));
  assert(!denied(a.r), `milestone target allowed: ${reason(a.r)}`);
  eq(a.args, 'mr view 5 --repo team/app --output json', 'glab lookup');
  const b = lookupArgs('gh pr -R o/r merge 5 --squash', fakeGh(pr(5, 'milestone/auth')));
  assert(!denied(b.r), `milestone target allowed: ${reason(b.r)}`);
  assert(/--repo o\/r/.test(b.args), `gh lookup: ${b.args}`);
});

test('guard: attached -R values are passed to the lookup', () => {
  eq(lookupArgs('glab mr merge 5 -Rother/proj', fakeGlab(mr(5, 'opened', 'milestone/x'))).args,
    'mr view 5 --repo other/proj --output json', '-Rx');
  eq(lookupArgs('glab mr merge 5 -R=other/proj', fakeGlab(mr(5, 'opened', 'milestone/x'))).args,
    'mr view 5 --repo other/proj --output json', '-R=x');
  assert(/--repo o\/r/.test(lookupArgs('gh pr merge 5 -Ro/r', fakeGh(pr(5, 'milestone/x'))).args), 'gh -Rx');
});

test('forge: locked MRs are open; auto_merge_enabled counts as auto-merge', () => {
  eq(forge.fromGitlab(JSON.parse(mr(6, 'locked', 'main'))).state, 'OPEN', 'locked');
  eq(forge.fromGitlab(JSON.parse(mr(6, 'opened', 'milestone/a', { auto_merge_enabled: true }))).autoMerge, true, 'auto_merge_enabled');
});

test('merge logging: glab mr -R before merge is logged', () => {
  const p = tmpProject();
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'glab mr -R team/app merge 21 --yes' }, tool_response: { stdout: '' } },
    p, fakeGlab(mr(21, 'merged', 'milestone/auth')));
  const [m] = readLog(p, 'merges.jsonl');
  assert(m, 'a merge line was written');
  eq(m.pr, '21', 'iid');
  eq(m.outcome, 'merged', 'outcome');
});
