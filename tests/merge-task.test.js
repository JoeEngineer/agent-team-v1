// scripts/merge-task.js: the gate, the merge, the comment and the log line in
// one call (decision 0019). main() runs in process against a stand-in CLI: the
// read calls play back from tests/fake-ci-cli.js, and the merge and comment
// calls are recorded here. Loaded and run by tests/run.js.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, ROOT, test, assert, eq, tmpProject, bareProject, readLog } = require('./helpers');
const { Playback, keyOf } = require('./fake-ci-cli');

const mergeTask = require(path.join(SCRIPTS, 'merge-task.js'));

console.log('merge-task');

// lib.projectDir prefers CLAUDE_PROJECT_DIR over the cwd: without this, a run
// inside a Claude session would log to that session's project. Restored at the end.
const SAVED_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PROJECT_DIR;
// The default cwd: a repo that doesn't use agent-team, so nothing is logged
// unless a test passes its own project.
const SCRATCH = bareProject();

const SHA = 'a'.repeat(40);
const SHA2 = 'c'.repeat(40);
const check = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, conclusion, workflowName: 'CI', startedAt: '2026-01-01T00:00:00Z' });
const ok = (name) => check(name, 'COMPLETED', 'SUCCESS');
const bad = (name) => check(name, 'COMPLETED', 'FAILURE');
const running = (name) => check(name, 'IN_PROGRESS', '');
const pr = (rollup, { sha = SHA, base = 'milestone/auth', state = 'OPEN', auto = false } = {}) => JSON.stringify({
  number: 7, headRefOid: sha, baseRefName: base, state, statusCheckRollup: rollup,
  autoMergeRequest: auto ? { enabledAt: '2026-01-01T00:00:00Z' } : null, mergedAt: state === 'MERGED' ? '2026-01-01T00:10:00Z' : null,
});
const rules = (...contexts) => JSON.stringify(contexts.length
  ? [{ type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context })) } }] : []);
const NOT_PROTECTED = { err: 'gh: Branch not protected (HTTP 404)' };
const mr = (status, { sha = SHA, target = 'milestone/auth', state = 'opened', auto = false } = {}) => JSON.stringify({
  iid: 12, state, sha, target_branch: target, merge_when_pipeline_succeeds: auto,
  head_pipeline: status === null ? null : { id: 55, status },
});

// Run main() with read calls from `routes` and writes (merge, comment) recorded.
// onMerge(args) may throw to make the merge command fail.
function exec(argv, routes, { forgeName = 'github', cwd = SCRATCH, env = {}, onMerge } = {}) {
  const pb = new Playback({ rules: rules(), protection: NOT_PROTECTED, ...routes });
  const reads = pb.runner();
  const writes = [];
  let t = 1000000;
  const run = (f, a, c, to) => {
    const isWrite = (a[0] === 'pr' && (a[1] === 'merge' || a[1] === 'comment')) || (a[0] === 'mr' && (a[1] === 'merge' || a[1] === 'note'));
    if (!isWrite) return reads(f, a, c, to);
    writes.push(a);
    if (a[1] === 'merge' && onMerge) onMerge(a);
    return '';
  };
  const lines = [];
  const errs = [];
  const code = mergeTask.main(argv, {
    run, forge: forgeName, cwd, env, now: () => t, sleep: (ms) => { t += ms; },
    out: (l) => lines.push(JSON.parse(l)), err: (l) => errs.push(l),
  });
  return { code, lines, res: lines[lines.length - 1], writes, errs, pb, views: pb.calls.filter((c) => keyOf(c.args).startsWith('view')).length };
}

const ARGS = ['7', '--sha', SHA, '--task', 'AUTH-3', '--attempt', '2'];
const MERGE = ['pr', 'merge', '7', '--squash', '--delete-branch', '--match-head-commit', SHA];

test('green: gate, then the pinned merge, then the comment; exit 0, state merged, one log line', () => {
  const dir = tmpProject();
  const r = exec(ARGS, { view: [pr([ok('build')]), pr([ok('build')]), pr([ok('build')], { state: 'MERGED' })] }, { cwd: dir });
  eq(r.code, 0, 'exit');
  eq(r.res.state, 'merged', 'state');
  eq(r.res.base, 'milestone/auth', 'base');
  eq(r.res.ci, 'green', 'ci');
  eq(JSON.stringify(r.writes[0]), JSON.stringify(MERGE), 'merge command: squash, delete branch, pinned to the reviewed head');
  eq(JSON.stringify(r.writes[1]), JSON.stringify(['pr', 'comment', '7', '-b', 'Merged by the Director after reviewer approval (task AUTH-3, attempt 2).']), 'comment');
  eq(r.writes.length, 2, 'exactly one merge and one comment');
  eq(r.views, 3, 'three looks: before, the gate, after');
  const log = readLog(dir, 'merges.jsonl');
  eq(log.length, 1, 'one merge line');
  const l = log[0];
  eq(l.outcome, 'merged', 'outcome');
  eq(l.pr, '7', 'pr');
  eq(l.milestone, 'auth', 'milestone from the base');
  eq(l.task, 'AUTH-3', 'task');
  eq(l.attempt, 2, 'attempt');
  eq(l.gate, 'ci-wait', 'gate');
  eq(l.match_head, SHA, 'match_head');
  eq(l.via, 'merge-task', 'via');
  eq(l.auto, undefined, 'not an auto-merge');
  eq(l.outcome_source, 'gh pr view', 'outcome read from the forge');
  assert(!/[A-Za-z]:[\\/]|\/home\/|\/Users\//.test(l.command), `no local path in command: ${l.command}`);
  assert(/STATUS\.md/.test(r.res.next), 'next names STATUS.md');
});

test('an abbreviated --sha is accepted, and the merge is pinned to the full head', () => {
  const r = exec(['7', '--sha', SHA.slice(0, 9), '--task', 'T-1'], { view: [pr([ok('b')]), pr([ok('b')]), pr([ok('b')], { state: 'MERGED' })] });
  eq(r.code, 0, 'exit');
  eq(r.writes[0][r.writes[0].length - 1], SHA, 'full SHA passed to --match-head-commit');
  assert(r.writes[1][4].includes('attempt 1'), 'attempt defaults to 1');
});

test('red: nothing is merged; exit 1, the failing checks and the send-back step', () => {
  const r = exec(ARGS, { view: pr([bad('build'), ok('lint')]) });
  eq(r.code, 1, 'exit');
  eq(r.res.state, 'red', 'state');
  eq(JSON.stringify(r.res.failing), '["build"]', 'failing');
  eq(r.writes.length, 0, 'no merge, no comment');
  assert(/Send the task back to the implementer with the failing check names/.test(r.res.next), r.res.next);
  assert(/ask the user instead/.test(r.res.next), 'approved-with-explanation case asks the user');
});

test('head moved: exit 4 before any gate or merge, with the incremental-review step', () => {
  const r = exec(ARGS, { view: pr([ok('build')], { sha: SHA2 }) });
  eq(r.code, 4, 'exit');
  eq(r.res.state, 'head_moved', 'state');
  eq(r.res.head_sha, SHA2, 'reports the new head');
  eq(r.views, 1, 'one look only');
  eq(r.writes.length, 0, 'no merge');
  assert(r.res.next.includes(`git diff ${SHA}..${SHA2}`), r.res.next);
  // moved between the first look and the gate: the gate catches it
  const late = exec(ARGS, { view: [pr([ok('build')]), pr([ok('build')], { sha: SHA2 })] });
  eq(late.code, 4, 'gate exit');
  eq(late.writes.length, 0, 'no merge after a late move');
});

test('unknown: required checks unreadable -> exit 2, ask the user, nothing merged or queued', () => {
  const r = exec(ARGS, { view: pr([ok('build')]), protection: { err: 'gh: Resource not accessible by integration (HTTP 403)' } });
  eq(r.code, 2, 'exit');
  eq(r.res.state, 'unknown', 'state');
  eq(r.writes.length, 0, 'no merge');
  assert(/Don't merge, don't queue and don't wait: ask the user/.test(r.res.next), r.res.next);
  // the request itself can't be read
  const blind = exec(ARGS, { view: { err: 'gh: To use GitHub CLI, run: gh auth login' } });
  eq(blind.code, 2, 'unreadable request');
  eq(blind.writes.length, 0, 'no merge blind');
});

test('none: no CI stops at exit 3; with --allow-none it merges and the log says ci none', () => {
  const none = exec(ARGS, { view: pr([]) });
  eq(none.code, 3, 'exit');
  eq(none.res.state, 'none', 'state');
  eq(none.writes.length, 0, 'no merge');
  assert(/--allow-none/.test(none.res.next) && /tests_passed/.test(none.res.next), none.res.next);
  const dir = tmpProject();
  const r = exec([...ARGS, '--allow-none'], { view: [pr([]), pr([]), pr([], { state: 'MERGED' })] }, { cwd: dir });
  eq(r.code, 0, 'exit with --allow-none');
  eq(r.res.state, 'merged', 'state');
  eq(readLog(dir, 'merges.jsonl')[0].ci, 'none', 'log records ci none');
});

test('refused: a protected base, a non-milestone base, a closed request; never a merge', () => {
  for (const [base, why] of [['main', /only the user merges into it/], ['master', /only the user merges into it/], ['develop', /milestone\/\* only/]]) {
    const r = exec(ARGS, { view: pr([ok('build')], { base }) });
    eq(r.code, 9, `exit for base ${base}`);
    eq(r.res.state, 'refused', 'state');
    assert(why.test(r.res.note), r.res.note);
    eq(r.writes.length, 0, `no merge into ${base}`);
    eq(r.views, 1, 'refused before the gate');
  }
  const custom = exec(ARGS, { view: pr([ok('build')], { base: 'milestone/x' }) }, { env: { AGENT_TEAM_PROTECTED_BRANCHES: 'milestone/x' } });
  eq(custom.code, 9, 'AGENT_TEAM_PROTECTED_BRANCHES is honoured');
  const closed = exec(ARGS, { view: pr([ok('build')], { state: 'CLOSED' }) });
  eq(closed.code, 9, 'closed');
  assert(/closed, not open/.test(closed.res.note), closed.res.note);
  eq(closed.writes.length, 0, 'no merge of a closed request');
});

test('already merged: exit 0, nothing run, no log line', () => {
  const dir = tmpProject();
  const r = exec(ARGS, { view: pr([ok('build')], { state: 'MERGED' }) }, { cwd: dir });
  eq(r.code, 0, 'exit');
  eq(r.res.state, 'merged', 'state');
  eq(r.writes.length, 0, 'no merge, no comment');
  eq(readLog(dir, 'merges.jsonl').length, 0, 'no log line');
  assert(/already merged/.test(r.res.next), r.res.next);
});

test('pending and queueable: auto-merge is queued behind the queue-check, pinned to the head; state queued, logged as auto-merge-queued', () => {
  const dir = tmpProject();
  const pending = pr([running('build')]);
  const r = exec(ARGS, { view: [pending, pending, pending, pr([running('build')], { auto: true })], rules: rules('build') }, { cwd: dir });
  eq(r.code, 0, 'exit');
  eq(r.res.state, 'queued', 'state');
  eq(JSON.stringify(r.writes[0]), JSON.stringify(['pr', 'merge', '7', '--auto', '--squash', '--delete-branch', '--match-head-commit', SHA]), 'queue command');
  assert(/^Auto-merge queued by the Director after reviewer approval of a{12} \(task AUTH-3, attempt 2\)/.test(r.writes[1][4]), r.writes[1][4]);
  const l = readLog(dir, 'merges.jsonl')[0];
  eq(l.outcome, 'auto-merge-queued', 'outcome');
  eq(l.auto, true, 'auto');
  eq(l.match_head, SHA, 'match_head, for reconcile\'s head-moved check');
  eq(l.gate, 'ci-wait-queue', 'gate');
  assert(/gh pr merge 7 --disable-auto/.test(r.res.next), 'next names the cancel command');
  assert(/reconcile-logs\.js --merges/.test(r.res.next), 'next names the checkpoint');
  // the queued line is one reconcile can resolve
  const records = require(path.join(SCRIPTS, 'records.js'));
  eq(records.unresolvedQueued ? records.unresolvedQueued(readLog(dir, 'merges.jsonl')).length : 1, 1, 'reconcile sees one open queued line');
});

test('pending and not queueable: exit 8 waiting, nothing queued, next gives the --wait rerun and the Codex followup', () => {
  const pending = pr([running('build')]);
  const r = exec(ARGS, { view: pending });
  eq(r.code, 8, 'exit');
  eq(r.res.state, 'waiting', 'state');
  eq(r.writes.length, 0, 'no merge, no queue');
  assert(r.res.next.includes(`merge-task.js" 7 --sha ${SHA} --task AUTH-3 --attempt 2 --wait 1800`), r.res.next);
  assert(/wait again and report ci/.test(r.res.next), 'Codex followup');
  assert(/waiting CI/.test(r.res.next), 'STATUS state');
});

test('--wait: pending and not queueable waits, then merges on green; still pending after the wait says no further wait', () => {
  const pending = pr([running('build')]);
  const green = pr([ok('build')]);
  const r = exec([...ARGS, '--wait', '600'], { view: [pending, pending, pending, pending, green, pr([ok('build')], { state: 'MERGED' })] });
  eq(r.code, 0, 'exit');
  eq(r.res.state, 'merged', 'state');
  eq(JSON.stringify(r.writes[0]), JSON.stringify(MERGE), 'a direct, pinned merge after the wait');
  const still = exec([...ARGS, '--wait', '60'], { view: pending });
  eq(still.code, 8, 'still pending');
  eq(still.writes.length, 0, 'no merge');
  assert(/don't start another wait/.test(still.res.next), still.res.next);
  // red during the wait is red
  const red = exec([...ARGS, '--wait', '600'], { view: [pending, pending, pending, pr([bad('build')])] });
  eq(red.code, 1, 'red after waiting');
  eq(red.writes.length, 0, 'no merge on red');
});

test('pending with a red check, or an unreadable required set: the queue-check result decides; nothing is queued', () => {
  const mixed = pr([running('build'), bad('lint')]);
  const red = exec(ARGS, { view: mixed, rules: rules('build', 'lint') });
  eq(red.code, 1, 'red');
  eq(red.writes.length, 0, 'no queue on red');
});

test('the merge command fails: exit 7, state failed, logged as not-merged, no comment', () => {
  const dir = tmpProject();
  const open = pr([ok('build')]);
  const r = exec(ARGS, { view: open }, { cwd: dir, onMerge: () => { throw Object.assign(new Error('Command failed'), { status: 1, stderr: 'GraphQL: Repository rule violations found' }); } });
  eq(r.code, 7, 'exit');
  eq(r.res.state, 'failed', 'state');
  eq(r.writes.length, 1, 'the merge was tried once; no comment');
  assert(/rule violations/.test(r.res.note), r.res.note);
  assert(/don't look for a way around it/.test(r.res.next), r.res.next);
  eq(readLog(dir, 'merges.jsonl')[0].outcome, 'not-merged', 'logged as not merged');
});

test('the look after the merge fails: exit 2 unknown, logged as unknown, and next says to check the request', () => {
  const dir = tmpProject();
  const open = pr([ok('build')]);
  const r = exec(ARGS, { view: [open, open, { err: 'gh: HTTP 502' }] }, { cwd: dir });
  eq(r.code, 2, 'exit');
  eq(r.res.state, 'unknown', 'state');
  const l = readLog(dir, 'merges.jsonl')[0];
  eq(l.outcome, 'unknown', 'outcome');
  eq(l.outcome_source, 'none', 'outcome_source');
});

test('--names prints the names line first and never changes the result', () => {
  const open = pr([ok('build')]);
  const r = exec([...ARGS, '--names'], { view: [open, open, open, pr([ok('build')], { state: 'MERGED' })], repo: JSON.stringify({ allow_auto_merge: true }) });
  eq(r.code, 0, 'exit');
  eq(r.lines.length, 2, 'two lines');
  eq(JSON.stringify(r.lines[0].names.checks), '["build"]', 'check names');
  eq(r.res.state, 'merged', 'result');
  // a names lookup that fails doesn't stop the merge
  const broken = exec([...ARGS, '--names'], { view: [open, { err: 'gh: HTTP 502' }, open, pr([ok('build')], { state: 'MERGED' })] });
  eq(broken.code, 0, 'merge still runs');
});

test('GitLab: glab merge, note and queue commands; a success pipeline merges, a running one queues when the setting is on', () => {
  const merged = exec(ARGS.map((a) => (a === '7' ? '12' : a)), { view: [mr('success'), mr('success'), mr('success', { state: 'merged' })] }, { forgeName: 'gitlab' });
  eq(merged.code, 0, 'exit');
  eq(JSON.stringify(merged.writes[0]), JSON.stringify(['mr', 'merge', '12', '--squash', '--remove-source-branch', '--yes', '--sha', SHA]), 'glab merge');
  eq(JSON.stringify(merged.writes[1].slice(0, 4)), JSON.stringify(['mr', 'note', '12', '-m']), 'glab note');
  const dir = tmpProject();
  const queued = exec(ARGS.map((a) => (a === '7' ? '12' : a)), {
    view: [mr('running'), mr('running'), mr('running'), mr('running', { auto: true })],
    project: JSON.stringify({ only_allow_merge_if_pipeline_succeeds: true }),
  }, { forgeName: 'gitlab', cwd: dir });
  eq(queued.code, 0, 'exit');
  eq(queued.res.state, 'queued', 'state');
  eq(JSON.stringify(queued.writes[0]), JSON.stringify(['mr', 'merge', '12', '--auto-merge', '--squash', '--remove-source-branch', '--yes', '--sha', SHA]), 'glab queue');
  eq(readLog(dir, 'merges.jsonl')[0].forge, 'gitlab', 'forge on the log line');
  assert(/cancel_merge_when_pipeline_succeeds/.test(queued.res.next), 'next names the GitLab cancel call');
  const main = exec(ARGS.map((a) => (a === '7' ? '12' : a)), { view: mr('success', { target: 'main' }) }, { forgeName: 'gitlab' });
  eq(main.code, 9, 'protected target refused');
});

test('arguments: --sha and --task are required, one request per call, unknown options refused; no CLI call', () => {
  for (const argv of [[], ['7'], ['7', '--sha', SHA], ['7', '--task', 'T-1'], ['7', '--sha', 'zzz', '--task', 'T-1'], ['7', '8', '--sha', SHA, '--task', 'T-1'],
    ['x', '--sha', SHA, '--task', 'T-1'], [...ARGS, '--admin'], [...ARGS, '--auto'], [...ARGS, '--wait', '99999'], [...ARGS, '--attempt', 'two'], ['7', '--sha', '--task', 'T-1']]) {
    const r = exec(argv, {});
    eq(r.code, 9, `exit for ${JSON.stringify(argv)}`);
    eq(r.pb.calls.length, 0, 'no CLI call');
    eq(r.writes.length, 0, 'no merge');
    assert(/usage: merge-task\.js/.test(r.errs.join('\n')), 'usage shown');
  }
});

test('no log line in a project that does not use agent-team', () => {
  const dir = bareProject();
  const open = pr([ok('build')]);
  const r = exec(ARGS, { view: [open, open, pr([ok('build')], { state: 'MERGED' })] }, { cwd: dir });
  eq(r.code, 0, 'merge still runs');
  assert(!fs.existsSync(path.join(dir, '.agent-team')), 'no .agent-team folder was created');
});

test('the log line takes tool and session from the SessionStart marker', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, '.agent-team', 'logs', '.pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agent-team', 'logs', '.pending', 'hooks-alive.json'), JSON.stringify({ tool: 'codex', session_id: 's-1' }));
  const open = pr([ok('build')]);
  exec(ARGS, { view: [open, open, pr([ok('build')], { state: 'MERGED' })] }, { cwd: dir });
  const l = readLog(dir, 'merges.jsonl')[0];
  eq(l.tool, 'codex', 'tool');
  eq(l.session_id, 's-1', 'session');
});

test('process: the real script against the stand-in CLI exits 1 on red and prints one JSON result line', () => {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-merge-'));
  const routes = path.join(tmp, 'routes.json');
  fs.writeFileSync(routes, JSON.stringify({ view: pr([bad('build')]), rules: rules(), protection: NOT_PROTECTED }));
  const p = spawnSync('node', [path.join(SCRIPTS, 'merge-task.js'), ...ARGS], {
    encoding: 'utf8', cwd: tmp,
    env: { ...process.env, AGENT_TEAM_FAKE_GH: path.join(ROOT, 'tests', 'fake-ci-cli.js'), FAKE_CI_ROUTES: routes, FAKE_CI_STATE: path.join(tmp, 'state.json'), AGENT_TEAM_FORGE: 'github' },
  });
  eq(p.status, 1, `exit (stderr: ${p.stderr})`);
  const lines = p.stdout.trim().split('\n');
  eq(lines.length, 1, 'one line');
  eq(JSON.parse(lines[0]).state, 'red', 'state');
});

if (SAVED_PROJECT_DIR !== undefined) process.env.CLAUDE_PROJECT_DIR = SAVED_PROJECT_DIR;

// ---- the guard checks merge-task.js like a typed merge ----------------------
{
  const { run, fakeGh, fakeGlab } = require('./helpers');
  const proj = tmpProject();
  const guard = (command, env) => run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: proj }, proj, env);
  const denied = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny'; } catch { return false; } };
  const CMD = `node "/plugins/agent-team/scripts/merge-task.js" 7 --sha ${SHA} --task AUTH-3 --attempt 1`;

  test('guard: merge-task.js on a request into main is denied; into a milestone branch it is allowed', () => {
    const main = guard(CMD, fakeGh('{"number":7,"state":"OPEN","autoMergeRequest":null,"baseRefName":"main"}'));
    assert(denied(main), `expected a deny: ${main.stdout}`);
    assert(/PR 7 targets protected branch/.test(main.stdout), main.stdout);
    const ok_ = guard(CMD, fakeGh('{"number":7,"state":"OPEN","autoMergeRequest":null,"baseRefName":"milestone/auth"}'));
    assert(!denied(ok_), `expected no deny: ${ok_.stdout}`);
  });

  test('guard: merge-task.js with an unreadable base is denied (fail closed); Windows path and PowerShell call operator too', () => {
    assert(denied(guard(CMD, fakeGh('', 1))), 'unreadable base');
    const win = String.raw`& node "C:\Users\x\.claude\plugins\agent-team\scripts\merge-task.js" 7 --sha ` + `${SHA} --task T-1`;
    assert(denied(guard(win, fakeGh('{"number":7,"state":"OPEN","baseRefName":"master"}'))), 'Windows path');
    const chained = `git pull && ${CMD}`;
    assert(denied(guard(chained, fakeGh('{"number":7,"state":"OPEN","baseRefName":"main"}'))), 'inside a chain');
  });

  test('guard: merge-task.js on GitLab reads the target branch with glab', () => {
    const r = guard(CMD, { ...fakeGlab('{"iid":7,"state":"opened","target_branch":"main"}'), AGENT_TEAM_FORGE: 'gitlab' });
    assert(denied(r), `expected a deny: ${r.stdout}`);
  });

  test('guard: a command that only mentions merge-task.js in a quoted string, or has no request number, is not looked up', () => {
    const quoted = guard('echo "run merge-task.js 7 later"', fakeGh('', 1));
    assert(!denied(quoted), 'a quoted mention is not a merge');
    // The file named as an argument of another command, with a number after it: no lookup, no deny.
    for (const cmd of ['git log scripts/merge-task.js -n 5', 'git diff HEAD~1 -- scripts/merge-task.js 7', 'wc -l scripts/merge-task.js 12 && git status']) {
      assert(!denied(guard(cmd, fakeGh('', 1))), `not a merge: ${cmd}`);
    }
    // Run directly (a shebang call) it is checked like the node form.
    assert(denied(guard(`scripts/merge-task.js 7 --sha ${SHA} --task T-1 && git status`, fakeGh('{"number":7,"state":"OPEN","baseRefName":"main"}'))), 'direct call into main');
    const bare = guard('node scripts/merge-task.js --help', fakeGh('', 1));
    assert(!denied(bare), 'no request number: the script refuses it itself');
  });
}
