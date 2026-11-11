// GitLab support: forge detection, the guard's `glab` checks and merge logging
// through `glab mr view`. The fake glab prints JSON shaped like the GitLab REST
// API's merge request object, which is what `glab mr view --output json` prints.
// Loaded and run by tests/run.js: node tests/run.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SCRIPTS, tmpProject, run, fakeGh, fakeGlab, readLog, test, assert, eq } = require('./helpers');

const forge = require(path.join(SCRIPTS, 'forge.js'));
const lib = require(path.join(SCRIPTS, 'lib.js'));

// A trimmed GitLab merge request object.
const mr = (iid, state, target, extra = {}) => JSON.stringify({
  id: 1000 + iid, iid, project_id: 7, title: `MR ${iid}`, state,
  target_branch: target, source_branch: `task/T-${iid}`,
  merge_when_pipeline_succeeds: false, web_url: `https://git.example.internal/team/app/-/merge_requests/${iid}`,
  ...extra,
});

function denied(r) {
  try { return (JSON.parse(r.stdout).hookSpecificOutput || {}).permissionDecision === 'deny'; } catch { return false; }
}
const reason = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason; } catch { return ''; } };

console.log('forge.js: detection');

test('forge: host of https, ssh and scp-style remotes', () => {
  eq(forge.hostOfUrl('https://gitlab.example.com/group/sub/app.git'), 'gitlab.example.com', 'https');
  eq(forge.hostOfUrl('ssh://git@git.corp.internal:2222/group/app.git'), 'git.corp.internal', 'ssh with port');
  eq(forge.hostOfUrl('git@gitlab.corp:group/app.git'), 'gitlab.corp', 'scp-style');
  eq(forge.hostOfUrl('https://oauth2:tok@gitlab.corp/g/a.git'), 'gitlab.corp', 'credentials in URL');
  eq(forge.hostOfUrl(''), null, 'empty');
});

test('forge: remote host picks the forge; unknown hosts say nothing', () => {
  eq(forge.forgeOfUrl('git@github.com:o/r.git'), 'github', 'github.com');
  eq(forge.forgeOfUrl('https://gitlab.com/o/r'), 'gitlab', 'gitlab.com');
  eq(forge.forgeOfUrl('https://gitlab.acme.io/o/r'), 'gitlab', 'self-hosted gitlab.*');
  eq(forge.forgeOfUrl('https://git.acme.io/o/r'), null, 'neutral self-hosted name');
});

test('forge: detect() order is env, git config, remote, then github', () => {
  const proj = tmpProject();
  const g = (...a) => execFileSync('git', a, { cwd: proj });
  eq(forge.detect(proj, {}), 'github', 'no remote: default');
  g('remote', 'add', 'origin', 'git@gitlab.acme.io:team/app.git');
  eq(forge.detect(proj, {}), 'gitlab', 'remote host');
  g('remote', 'set-url', 'origin', 'https://git.acme.io/team/app.git');
  eq(forge.detect(proj, {}), 'github', 'neutral host falls back');
  g('config', 'agent-team.forge', 'gitlab');
  eq(forge.detect(proj, {}), 'gitlab', 'git config wins over host');
  eq(forge.detect(proj, { AGENT_TEAM_FORGE: 'github' }), 'github', 'env wins over git config');
});

test('forge: GitLab MR states normalize like GitHub PR states', () => {
  eq(forge.fromGitlab(JSON.parse(mr(3, 'merged', 'milestone/auth'))).state, 'MERGED', 'merged');
  eq(forge.fromGitlab(JSON.parse(mr(3, 'opened', 'main'))).state, 'OPEN', 'opened');
  eq(forge.fromGitlab(JSON.parse(mr(3, 'closed', 'main'))).state, 'CLOSED', 'closed');
  const auto = forge.fromGitlab(JSON.parse(mr(4, 'opened', 'milestone/auth', { merge_when_pipeline_succeeds: true })));
  eq(auto.autoMerge, true, 'merge when pipeline succeeds');
  eq(auto.base, 'milestone/auth', 'target branch is the base');
  eq(auto.number, 4, 'iid is the number');
});

test('forge: glab view args use --output json and pass --repo', () => {
  eq(forge.viewArgs('gitlab', { target: '12', repo: 'team/sub/app' }).join(' '), 'mr view 12 --repo team/sub/app --output json', 'glab');
  eq(forge.viewArgs('github', { target: '12', repo: null }).join(' '), 'pr view 12 --json number,state,autoMergeRequest,baseRefName', 'gh unchanged');
});

console.log('lib.js: glab parsing');

test('findMerges: glab mr merge / accept / merge-request, with --repo and flags', () => {
  const [a] = lib.findMerges('glab mr merge 12 --squash --remove-source-branch --yes');
  eq(a.forge, 'gitlab', 'forge'); eq(a.target, '12', 'target'); eq(a.repo, null, 'no repo');
  const [b] = lib.findMerges('glab mr accept -R team/app -m "msg with 99" 13');
  eq(b.target, '13', 'value flags skipped'); eq(b.repo, 'team/app', 'repo');
  const [c] = lib.findMerges('glab merge-request merge --repo=team/app');
  eq(c.target, null, 'current branch'); eq(c.repo, 'team/app', '--repo=');
  const [d] = lib.findMerges('bash -c "glab mr merge 5 -y"');
  eq(d.target, '5', 'nested shell');
  eq(lib.findMerges('echo "glab mr merge 5"').length, 0, 'quoted text is not a merge');
  eq(lib.findMerges('gh pr merge 9 && glab mr merge 10').map((m) => m.forge).join(','), 'github,gitlab', 'both forges');
});

console.log('guard.js: GitLab');

const proj = tmpProject();
const guard = (command, env = {}) =>
  run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: proj }, proj, env);

test('guard: glab mr merge into a milestone branch is allowed', () => {
  const r = guard('glab mr merge 12 --squash --remove-source-branch --yes', fakeGlab(mr(12, 'opened', 'milestone/auth')));
  assert(!denied(r), `should allow: ${reason(r)}`);
});

test('guard: glab mr merge into main is blocked', () => {
  const r = guard('glab mr merge 12 --squash --yes', fakeGlab(mr(12, 'opened', 'main')));
  assert(denied(r), 'should block');
  assert(/MR 12 targets protected branch "main"/.test(reason(r)), reason(r));
});

test('guard: glab mr accept and merge-request merge into master are blocked', () => {
  assert(denied(guard('glab mr accept 3 -y', fakeGlab(mr(3, 'opened', 'master')))), 'accept alias');
  assert(denied(guard('glab merge-request merge 3', fakeGlab(mr(3, 'opened', 'master')))), 'merge-request alias');
});

test('guard: glab mr merge is blocked when glab cannot confirm the target', () => {
  const r = guard('glab mr merge 999 --yes', fakeGlab('', 1));
  assert(denied(r), 'fails closed');
  assert(/refusing to merge blind/.test(reason(r)), reason(r));
  assert(denied(guard('glab mr merge 999', fakeGlab('not json'))), 'unparseable output fails closed');
});

test('guard: glab mr merge with --repo asks glab about that repo', () => {
  const argsFile = path.join(proj, 'glab-args.jsonl');
  guard('glab mr merge 12 -R team/sub/app --yes', fakeGlab(mr(12, 'opened', 'milestone/x'), 0, { FAKE_GH_ARGS: argsFile }));
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8').trim().split('\n').pop());
  eq(args.join(' '), 'mr view 12 --repo team/sub/app --output json', 'view args');
  fs.rmSync(argsFile);
});

test('guard: protected branch list follows AGENT_TEAM_PROTECTED_BRANCHES', () => {
  const r = guard('glab mr merge 4 --yes', { ...fakeGlab(mr(4, 'opened', 'develop')), AGENT_TEAM_PROTECTED_BRANCHES: 'main,develop' });
  assert(denied(r), 'develop protected');
});

const blocked = [
  ['api merge into main', 'glab api -X PUT projects/:id/merge_requests/12/merge', mr(12, 'opened', 'main')],
  ['api merge, encoded project path', 'glab api --method PUT projects/team%2Fapp/merge_requests/12/merge', mr(12, 'opened', 'main')],
  ['api merge-when-pipeline-succeeds', 'glab api -XPOST projects/:id/merge_requests/12/merge_when_pipeline_succeeds', mr(12, 'opened', 'main')],
  ['api unprotect branch', 'glab api -X DELETE projects/:id/protected_branches/main'],
  ['api protect branch', 'glab api projects/:id/protected_branches -f name=main -f push_access_level=40'],
  ['api push rule', 'glab api -X PUT projects/:id/push_rule -f deny_delete_tag=false'],
  ['api approval rules', 'glab api -X POST projects/:id/approval_rules -f name=x'],
  ['api delete main', 'glab api -X DELETE projects/:id/repository/branches/main'],
  ['api delete milestone (encoded)', 'glab api -X DELETE projects/:id/repository/branches/milestone%2Fauth'],
  ['api delete merged branches', 'glab api -X DELETE projects/:id/repository/merged_branches'],
  ['api commit to main', 'glab api projects/:id/repository/commits -f branch=main -f commit_message=x'],
  ['api file edit on main', 'glab api -X PUT projects/:id/repository/files/README.md -f branch=main -f content=x'],
  ['api release', 'glab api projects/:id/releases -f tag_name=v1'],
  ['api edit project', 'glab api -X PUT projects/:id -f default_branch=task/T-1'],
  ['api delete project', 'glab api -X DELETE projects/team%2Fapp'],
  ['api archive project', 'glab api -X POST projects/:id/archive'],
  ['graphql accept MR', "glab api graphql -f query='mutation { mergeRequestAccept(input: {projectPath: \"t/a\", iid: \"1\"}) { errors } }'"],
  ['graphql branch rule', "glab api graphql -f query='mutation { branchRuleDelete(input: {id: \"x\"}) { errors } }'"],
  ['glab repo delete', 'glab repo delete team/app --yes'],
  ['glab repo transfer', 'glab repo transfer team/app --target-namespace other'],
  ['glab release create', 'glab release create v1.0.0'],
  ['glab in a subshell', '(cd sub && glab api -X DELETE projects/:id/protected_branches/main)'],
];
for (const [name, cmd, out] of blocked) {
  test(`guard blocks: ${name}`, () => {
    const r = guard(cmd, out ? fakeGlab(out) : fakeGlab('', 1));
    assert(denied(r), `should block: ${cmd}`);
  });
}

const allowed = [
  ['api merge into milestone', 'glab api -X PUT projects/:id/merge_requests/12/merge', mr(12, 'opened', 'milestone/auth')],
  ['api read protected branches', 'glab api projects/:id/protected_branches'],
  ['api read MR', 'glab api projects/:id/merge_requests/12'],
  ['api delete task branch', 'glab api -X DELETE projects/:id/repository/branches/task%2FT-1'],
  ['api commit to task branch', 'glab api projects/:id/repository/commits -f branch=task/T-1 -f commit_message=x'],
  ['api MR note', 'glab api projects/:id/merge_requests/12/notes -f body=ok'],
  ['api approve MR', 'glab api -X POST projects/:id/merge_requests/12/approve'],
  ['mr create', 'glab mr create --source-branch task/T-1 --target-branch milestone/auth --title x --description y --yes'],
  ['mr note', 'glab mr note 12 -m "Merged by Director after reviewer approval (task T-1, attempt 1)."'],
  ['mr list / diff / view', 'glab mr list && glab mr diff 12 && glab mr view 12'],
  ['ci status', 'glab ci status --branch task/T-1'],
  ['issue create', 'glab issue create --title x --label agent-team --description y'],
  ['repo archive is a download', 'glab repo archive team/app'],
];
for (const [name, cmd, out] of allowed) {
  test(`guard allows: ${name}`, () => {
    const r = guard(cmd, out ? fakeGlab(out) : fakeGlab('', 1));
    assert(!denied(r), `should allow: ${cmd} — ${reason(r)}`);
  });
}

test('guard: a github merge still asks gh, not glab', () => {
  // A glab call would fail (missing script) and block, so passing proves gh answered.
  const r = guard('gh pr merge 5 --squash', { ...fakeGh('{"number":5,"state":"OPEN","baseRefName":"milestone/a"}'), AGENT_TEAM_FAKE_GLAB: path.join(proj, 'no-such-glab.js') });
  assert(!denied(r), `gh answer used: ${reason(r)}`);
});

console.log('merge logging: GitLab');

const logMerge = (p, command, env, stdout = '') =>
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout } }, p, env);

test('glab mr merge: outcome and milestone come from glab mr view', () => {
  const p = tmpProject();
  const argsFile = path.join(p, 'glab-args.jsonl');
  logMerge(p, 'glab mr note 21 -m "Merged by Director" && glab mr merge 21 --squash --remove-source-branch --yes && git pull -q',
    fakeGlab(mr(21, 'merged', 'milestone/auth'), 0, { FAKE_GH_ARGS: argsFile }), 'error: 2 failed');
  const [m] = readLog(p, 'merges.jsonl');
  eq(m.pr, '21', 'iid');
  eq(m.outcome, 'merged', 'outcome');
  eq(m.outcome_source, 'glab mr view', 'source');
  eq(m.forge, 'gitlab', 'forge field');
  eq(m.milestone, 'auth', 'milestone from target branch');
  eq(m.chained, true, 'chained');
  const [args] = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq(args.join(' '), 'mr view 21 --output json', 'asked glab');
});

test('glab mr merge: open MR is not-merged; pipeline-gated merge is queued; failure is unknown', () => {
  const p = tmpProject();
  logMerge(p, 'glab mr merge 22 --yes', fakeGlab(mr(22, 'opened', 'milestone/a')));
  logMerge(p, 'glab mr merge 23 --yes', fakeGlab(mr(23, 'opened', 'milestone/a', { merge_when_pipeline_succeeds: true })));
  logMerge(p, 'glab mr merge 24 --yes', fakeGlab('', 1), 'Merged!');
  const [a, b, c] = readLog(p, 'merges.jsonl');
  eq(a.outcome, 'not-merged', 'open');
  eq(b.outcome, 'auto-merge-queued', 'merge when pipeline succeeds');
  eq(c.outcome, 'unknown', 'glab failed');
  eq(c.outcome_source, 'none', 'no source');
  eq(c.pr, '24', 'pr from command');
});

test('github merge lines have no forge field (unchanged format)', () => {
  const p = tmpProject();
  logMerge(p, 'gh pr merge 5 --squash', fakeGh('{"number":5,"state":"MERGED","autoMergeRequest":null}'));
  const [m] = readLog(p, 'merges.jsonl');
  eq(m.forge, undefined, 'no forge field');
  eq(m.outcome_source, 'gh pr view', 'source');
});

console.log('session-start: forge note');

test('session-start names the forge on GitLab only', () => {
  const p = tmpProject();
  const ctx = (env = {}) => JSON.parse(run('session-start.js', { hook_event_name: 'SessionStart', cwd: p }, p, env).stdout).hookSpecificOutput.additionalContext;
  assert(!/forge/.test(ctx()), 'no note on GitHub');
  execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.acme.io/t/a.git'], { cwd: p });
  assert(/agent-team forge: gitlab/.test(ctx()), `gitlab note: ${ctx()}`);
});
