// Resolving queued auto-merges: logMerges' extra fields (auto, match_head, gate,
// cancellations) and `reconcile-logs.js --merges`. Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, tmpProject, run, fakeGh, fakeGlab, readLog, test, assert, eq } = require('./helpers');

const FAKE_CI = path.join(__dirname, 'fake-ci-cli.js');
const SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

const prJson = (state, o = {}) => JSON.stringify({
  headRefOid: o.head || SHA, baseRefName: 'milestone/m', state,
  autoMergeRequest: o.auto ? { mergeMethod: 'SQUASH' } : null,
  mergedAt: o.mergedAt || null,
  statusCheckRollup: o.checks || [],
});
const mrJson = (state, o = {}) => JSON.stringify({
  iid: o.iid, sha: o.head || SHA, state, target_branch: 'milestone/m',
  merge_when_pipeline_succeeds: Boolean(o.auto), merged_at: o.mergedAt || null,
  head_pipeline: o.pipeline || null,
});
const check = (name, conclusion) => ({ __typename: 'CheckRun', name, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion: conclusion || '', startedAt: '2026-11-01T00:00:00Z' });

const queued = (pr, ts, extra = {}) => ({
  ts, tool: 'claude', guidance_version: '0.5.0', command: `gh pr merge ${pr} --auto`, pr: String(pr),
  milestone: 'm', outcome: 'auto-merge-queued', outcome_source: 'gh pr view', chained: false, auto: true, ...extra,
});

// A project whose merges.jsonl holds `rows`, and a fake gh/glab that plays `routes`.
function setup(rows, routes) {
  const proj = tmpProject();
  const logs = path.join(proj, '.agent-team', 'logs');
  fs.writeFileSync(path.join(logs, 'merges.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-mr-'));
  const routesFile = path.join(dir, 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify(routes));
  const callLog = path.join(dir, 'calls.log');
  const env = {
    AGENT_TEAM_FAKE_GH: FAKE_CI, AGENT_TEAM_FAKE_GLAB: FAKE_CI, FAKE_CI_ROUTES: routesFile,
    FAKE_CI_STATE: path.join(dir, 'state.json'), FAKE_CI_LOG: callLog,
  };
  const calls = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { proj, env, calls, rows: () => readLog(proj, 'merges.jsonl') };
}

const reconcile = (s, args = ['--merges']) => spawnSync('node', [path.join(SCRIPTS, 'reconcile-logs.js'), ...args], {
  encoding: 'utf8', cwd: s.proj, timeout: 60000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: s.proj, AGENT_TEAM_PROJECTS_ROOT: path.join(s.proj, 'no-projects-root'), ...s.env },
});

console.log('merge-reconcile: resolution lines');

test('queued then merged: appends a merged line with the real merge time; queued line untouched; second run adds nothing', () => {
  const q = queued(90, '2026-11-01T10:00:00.000Z', { match_head: SHA });
  const s = setup([q], { 'view:90': prJson('MERGED', { mergedAt: '2026-11-01T10:07:30Z' }) });
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  assert(/PR 90: merged at 2026-11-01T10:07:30Z/.test(r.stdout), r.stdout);
  const [first, res] = s.rows();
  eq(JSON.stringify(first), JSON.stringify(q), 'queued line byte for byte');
  eq(res.outcome, 'merged', 'outcome');
  eq(res.merged_at, '2026-11-01T10:07:30Z', 'merged_at');
  eq(res.resolves_ts, q.ts, 'resolves_ts');
  eq(res.resolution_id, 'github:90:2026-11-01T10:00:00.000Z', 'resolution_id');
  eq(res.outcome_source, 'gh pr view', 'outcome_source');
  eq(res.tool, 'claude', 'tool of the queued line');
  eq(res.milestone, 'm', 'milestone');
  eq(res.guidance_version, '0.5.0', 'queued run version kept');
  assert(res.reconciled_by && res.reconciled_by !== 'unknown', 'reconciled_by');
  eq(res.forge, undefined, 'no forge field on github');
  const callsBefore = s.calls().length;
  eq(callsBefore, 1, 'one forge call');
  reconcile(s);
  eq(s.rows().length, 2, 'second run: no new line');
  eq(s.calls().length, callsBefore, 'second run: resolved PR not asked again');
});

test('closed and cancelled (open, auto-merge off) outcomes; gitlab MR keeps its forge', () => {
  const s = setup([
    queued(1, '2026-11-01T10:00:00.000Z'), queued(2, '2026-11-01T10:01:00.000Z'),
    queued(3, '2026-11-01T10:02:00.000Z', { forge: 'gitlab' }),
  ], {
    'view:1': prJson('CLOSED'), 'view:2': prJson('OPEN', { auto: false }),
    'view:3': mrJson('merged', { iid: 3, mergedAt: '2026-11-01T11:00:00Z' }),
  });
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  const [, , , a, b, c] = s.rows();
  eq(a.outcome, 'closed', 'closed'); eq(a.merged_at, null, 'closed has no merged_at');
  eq(b.outcome, 'auto-merge-cancelled', 'cancelled'); eq(b.merged_at, null, 'cancelled has no merged_at');
  eq(c.outcome, 'merged', 'gitlab merged'); eq(c.forge, 'gitlab', 'forge'); eq(c.outcome_source, 'glab mr view', 'source');
  eq(c.resolution_id, 'gitlab:3:2026-11-01T10:02:00.000Z', 'gitlab resolution id');
});

test('still queued: no line; prints CI pending, red with failing names, or green', () => {
  const s = setup([queued(1, 't1'), queued(2, 't2'), queued(3, 't3')], {
    'view:1': prJson('OPEN', { auto: true, checks: [check('build', ''), check('lint', 'SUCCESS')] }),
    'view:2': prJson('OPEN', { auto: true, checks: [check('build', 'FAILURE'), check('unit', 'FAILURE'), check('lint', 'SUCCESS')] }),
    'view:3': prJson('OPEN', { auto: true, checks: [check('build', 'SUCCESS')] }),
  });
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  assert(/PR 1: still queued, CI pending/.test(r.stdout), r.stdout);
  assert(/PR 2: still queued, CI red \(build, unit\)/.test(r.stdout), r.stdout);
  assert(/PR 3: still queued, CI green/.test(r.stdout), r.stdout);
  eq(s.rows().length, 3, 'no line appended');
  assert(!/head moved/.test(r.stdout), 'head unchanged: no warning');
});

test('still queued with a moved head: warns to disable auto-merge', () => {
  const s = setup([queued(7, 't7', { match_head: SHA }), queued(8, 't8', { match_head: SHA })], {
    'view:7': prJson('OPEN', { auto: true, head: NEW_SHA, checks: [check('build', 'SUCCESS')] }),
    'view:8': prJson('OPEN', { auto: true, head: SHA, checks: [check('build', 'SUCCESS')] }),
  });
  const r = reconcile(s);
  assert(/PR 7: still queued, CI green; head moved since queued: disable auto-merge now/.test(r.stdout), r.stdout);
  assert(!/PR 8:.*head moved/.test(r.stdout), 'PR 8 head is the queued one');
});

test('older queued line for a PR with a newer one is superseded without asking the forge', () => {
  const s = setup([queued(5, '2026-11-01T10:00:00.000Z'), queued(5, '2026-11-01T12:00:00.000Z')], {
    'view:5': prJson('MERGED', { mergedAt: '2026-11-01T12:30:00Z' }),
  });
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  eq(s.calls().length, 1, 'one forge call for the PR');
  const [, , old, latest] = s.rows();
  eq(old.outcome, 'auto-merge-cancelled', 'older: cancelled'); eq(old.note, 'superseded', 'older: note');
  eq(old.resolves_ts, '2026-11-01T10:00:00.000Z', 'older: resolves_ts'); eq(old.merged_at, null, 'older: merged_at');
  eq(latest.outcome, 'merged', 'newer: merged'); eq(latest.resolves_ts, '2026-11-01T12:00:00.000Z', 'newer: resolves_ts');
  reconcile(s);
  eq(s.rows().length, 4, 'idempotent');
});

test('offline: forge cannot answer -> no line, "unknown (gh couldn\'t answer)", exit 0; the next run, once gh answers, resolves it', () => {
  const s = setup([queued(9, 't9')], { 'view:9': { err: 'HTTP 502 bad gateway' } });
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  assert(r.stdout.includes("PR 9: unknown (gh couldn't answer)"), r.stdout);
  eq(s.rows().length, 1, 'nothing written');
  // Recovery control: gh answers again.
  fs.writeFileSync(s.env.FAKE_CI_ROUTES, JSON.stringify({ 'view:9': prJson('CLOSED') }));
  const r2 = reconcile(s);
  eq(r2.status, 0, r2.stderr);
  eq(s.rows()[1].outcome, 'closed', 'resolved after recovery');
});

test('--dry-run writes nothing and still prints one line per PR', () => {
  const s = setup([queued(1, 't1')], { 'view:1': prJson('MERGED', { mergedAt: '2026-11-01T10:07:30Z' }) });
  const r = reconcile(s, ['--merges', '--dry-run']);
  eq(r.status, 0, r.stderr);
  assert(/\[dry run\] PR 1: merged at/.test(r.stdout), r.stdout);
  eq(s.rows().length, 1, 'nothing written');
});

test('a plain reconcile-logs.js run includes the merge step (no projects root needed)', () => {
  const s = setup([queued(1, 't1')], { 'view:1': prJson('CLOSED') });
  const r = reconcile(s, []);
  eq(r.status, 0, r.stderr);
  eq(s.rows()[1].outcome, 'closed', 'resolved by the plain run');
});

console.log('merge-reconcile: request budget');

test('one forge call per PR; 50 PRs at most, oldest first, the rest counted; a failing PR does not stop the others', () => {
  const rows = [];
  const routes = { 'view:1': { err: 'HTTP 500' } };
  for (let i = 1; i <= 53; i++) {
    rows.push(queued(i, `2026-11-01T10:${String(i).padStart(2, '0')}:00.000Z`));
    if (i > 1) routes[`view:${i}`] = prJson('CLOSED');
  }
  rows.push(queued(2, '2026-11-02T10:00:00.000Z')); // PR 2 queued twice: still one call
  const s = setup(rows, routes);
  eq(rows.length, 54, 'precondition: 54 queued lines over 53 PRs');
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  const calls = s.calls();
  eq(calls.length, 50, 'exactly 50 forge calls');
  eq(calls[0][2], '1', 'oldest PR first');
  eq(new Set(calls.map((c) => c[2])).size, 50, 'no PR asked twice');
  assert(r.stdout.includes('3 more PR(s) skipped'), r.stdout);
  assert(r.stdout.includes("PR 1: unknown"), 'failing PR reported');
  const resolutions = s.rows().filter((x) => x.resolution_id);
  eq(resolutions.filter((x) => x.outcome === 'closed').length, 49, 'PRs 2-50 closed; PR 1 failed, 51-53 skipped');
  eq(resolutions.filter((x) => x.note === 'superseded').length, 1, 'PR 2 older line superseded without a call');
  // One step past: the next run picks up the remaining PRs.
  fs.writeFileSync(s.env.FAKE_CI_ROUTES, JSON.stringify(Object.fromEntries(Array.from({ length: 53 }, (_, i) => [`view:${i + 1}`, prJson('CLOSED')]))));
  reconcile(s);
  eq(s.rows().filter((x) => x.resolution_id && x.outcome === 'closed').length, 53, 'all 53 PRs resolved after a second run');
});

console.log('merge-reconcile: logMerges fields');

const logMerge = (proj, command, env) => run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '' } }, proj, env);

test('auto-merge command records auto and match_head (gh --match-head-commit, glab --sha); a plain merge has neither', () => {
  const p = tmpProject();
  logMerge(p, `gh pr merge 8 --auto --squash --match-head-commit ${SHA}`, fakeGh(prJson('OPEN', { auto: true })));
  logMerge(p, `glab mr merge 9 --auto-merge --sha ${SHA}`, fakeGlab(mrJson('opened', { iid: 9, auto: true })));
  logMerge(p, 'gh pr merge 10 --squash', fakeGh('{"number":10,"state":"MERGED","autoMergeRequest":null}'));
  const [a, b, c] = readLog(p, 'merges.jsonl');
  eq(a.auto, true, 'gh auto'); eq(a.match_head, SHA, 'gh match_head');
  eq(b.auto, true, 'glab auto'); eq(b.match_head, SHA, 'glab match_head'); eq(b.forge, 'gitlab', 'forge');
  eq(c.auto, undefined, 'plain: no auto'); eq(c.match_head, undefined, 'plain: no match_head'); eq(c.gate, undefined, 'plain: no gate');
});

test('gate: ci-wait.js or gh pr checks earlier in the same command; none otherwise or when it comes after', () => {
  const p = tmpProject();
  const merged = fakeGh('{"number":90,"state":"MERGED","autoMergeRequest":null}');
  logMerge(p, 'node ${CLAUDE_PLUGIN_ROOT}/scripts/ci-wait.js 90 && gh pr merge 90 --squash', merged);
  logMerge(p, 'gh pr checks 90 && gh pr merge 90 --squash --delete-branch --match-head-commit abc && gh pr comment 90 -b done', merged);
  logMerge(p, 'gh pr merge 90 --squash && gh pr checks 90', merged);
  const [a, b, c] = readLog(p, 'merges.jsonl');
  eq(a.gate, 'ci-wait', 'ci-wait'); eq(b.gate, 'gh-checks', 'gh-checks'); eq(b.chained, true, 'chained');
  eq(c.gate, undefined, 'a check after the merge is not a gate');
});

test('gate: the PowerShell shape from decision 0012 is a gate; ; and || joiners, and ci-wait named only as an argument, are not', () => {
  const p = tmpProject();
  const merged = fakeGh('{"number":5,"state":"MERGED","autoMergeRequest":null}');
  logMerge(p, 'node "C:\\p\\scripts\\ci-wait.js" 5 --once --sha abc; if ($LASTEXITCODE -eq 0) { gh pr merge 5 --squash --match-head-commit abc; if ($LASTEXITCODE -eq 0) { gh pr comment 5 -b done } }', merged);
  logMerge(p, 'cat scripts/ci-wait.js; gh pr merge 5 --squash', merged);
  logMerge(p, 'cat scripts/ci-wait.js && gh pr merge 5 --squash', merged);
  logMerge(p, 'node scripts/ci-wait.js 5; gh pr merge 5 --squash', merged);
  logMerge(p, 'node scripts/ci-wait.js 5 || gh pr merge 5 --squash', merged);
  logMerge(p, 'echo gh pr checks 5 && gh pr merge 5 --squash', merged);
  logMerge(p, 'gh pr checks 5 && gh pr merge 5 --squash', merged);
  const gates = readLog(p, 'merges.jsonl').map((m) => m.gate);
  eq(JSON.stringify(gates), JSON.stringify(['ci-wait', null, null, null, null, null, 'gh-checks']), 'gates in order');
});

test('cancellation and reconcile share one resolution_id: whichever comes second adds nothing (cancel first, and reconcile first)', () => {
  // Cancel first: the logged cancellation carries the id.
  const p = tmpProject();
  logMerge(p, 'gh pr merge 11 --auto --squash', fakeGh(prJson('OPEN', { auto: true })));
  const [q] = readLog(p, 'merges.jsonl');
  eq(q.outcome, 'auto-merge-queued', 'precondition: queued');
  logMerge(p, 'gh pr merge 11 --disable-auto', fakeGh('', 1));
  const c = readLog(p, 'merges.jsonl')[1];
  eq(c.resolution_id, `github:11:${q.ts}`, 'cancellation resolution_id');
  // Reconcile first (its forge call said "no auto-merge"): a late cancel adds nothing.
  const s = setup([q], { 'view:11': prJson('OPEN', { auto: false }) });
  reconcile(s);
  const res = s.rows()[1];
  eq(res.resolution_id, c.resolution_id, 'same id as a cancellation');
  logMerge(s.proj, 'gh pr merge 11 --disable-auto', fakeGh('', 1));
  eq(s.rows().length, 2, 'late cancel added nothing');
});

test('glab api cancel needs POST: a GET of the same path is not a cancellation; --method POST and -X POST are', () => {
  const p = tmpProject();
  const url = 'projects/:id/merge_requests/12/cancel_merge_when_pipeline_succeeds';
  logMerge(p, `glab api ${url}`, fakeGlab('', 1));
  logMerge(p, `glab api -X GET ${url}`, fakeGlab('', 1));
  eq(readLog(p, 'merges.jsonl').length, 0, 'GET logs nothing');
  logMerge(p, `glab api --method POST ${url}`, fakeGlab('', 1));
  eq(readLog(p, 'merges.jsonl').length, 1, '--method POST logged');
  logMerge(p, `glab api -X POST ${url}`, fakeGlab('', 1));
  eq(readLog(p, 'merges.jsonl').length, 2, '-X POST logged');
});

test('queued --auto then a plain merge of the same PR: reconcile resolves the queued line as merged directly, flagged so it is not counted twice, no forge call', () => {
  const direct = { ...queued(20, '2026-11-01T11:00:00.000Z'), command: 'gh pr merge 20 --squash', outcome: 'merged', auto: undefined };
  const s = setup([queued(20, '2026-11-01T10:00:00.000Z'), direct], {});
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  eq(s.calls().length, 0, 'no forge call');
  const res = s.rows()[2];
  eq(res.outcome, 'merged', 'outcome'); eq(res.note, 'merged directly', 'note');
  eq(res.superseded_by_ts, direct.ts, 'superseded_by_ts'); eq(res.resolves_ts, '2026-11-01T10:00:00.000Z', 'resolves_ts');
  reconcile(s);
  eq(s.rows().length, 3, 'idempotent');
});

test('a GitLab MR still queued: pipeline status text and a moved head raise the head-moved alert', () => {
  const s = setup([queued(31, 't31', { forge: 'gitlab', match_head: SHA })], {
    'view:31': mrJson('opened', { iid: 31, auto: true, head: NEW_SHA, pipeline: { id: 5, status: 'running' } }),
  });
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  assert(/MR 31: still queued, CI pending; head moved since queued: disable auto-merge now/.test(r.stdout), r.stdout);
  eq(s.rows().length, 1, 'no line appended');
  eq(s.calls()[0][0], 'mr', 'asked glab (mr view)');
});

test('gh pr merge --disable-auto is logged as auto-merge-cancelled by the director, resolving the latest open queued line; reconcile then adds no second cancellation', () => {
  const p = tmpProject();
  logMerge(p, 'gh pr merge 11 --auto --squash', fakeGh(prJson('OPEN', { auto: true })));
  logMerge(p, 'gh pr merge 11 --auto --squash', fakeGh(prJson('OPEN', { auto: true })));
  const [, q2] = readLog(p, 'merges.jsonl');
  eq(q2.outcome, 'auto-merge-queued', 'precondition: a queued line exists');
  const argsFile = path.join(p, 'gh-args.jsonl');
  logMerge(p, 'gh pr merge 11 --disable-auto', fakeGh('', 1, { FAKE_GH_ARGS: argsFile }));
  const rows = readLog(p, 'merges.jsonl');
  const c = rows[2];
  eq(rows.length, 3, 'one new line');
  eq(c.outcome, 'auto-merge-cancelled', 'outcome'); eq(c.cancelled_by, 'director', 'cancelled_by');
  eq(c.resolves_ts, q2.ts, 'resolves the latest open queued line'); eq(c.pr, '11', 'pr');
  eq(fs.existsSync(argsFile), false, 'a numbered --disable-auto asks the forge nothing');
  // Reconcile: the first queued line has a newer one (superseded); the latest is already resolved.
  const s = { proj: p, env: { AGENT_TEAM_FAKE_GH: FAKE_CI, FAKE_CI_ROUTES: path.join(p, 'none.json'), FAKE_CI_STATE: path.join(p, 's.json'), FAKE_CI_LOG: path.join(p, 'calls.log') } };
  fs.writeFileSync(s.env.FAKE_CI_ROUTES, '{}');
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  eq(fs.existsSync(s.env.FAKE_CI_LOG), false, 'no forge call: nothing latest is unresolved');
  const after = readLog(p, 'merges.jsonl');
  eq(after.filter((x) => x.outcome === 'auto-merge-cancelled' && x.resolves_ts === q2.ts).length, 1, 'exactly one cancellation of the latest line');
  eq(after.filter((x) => x.note === 'superseded').length, 1, 'older line superseded');
  reconcile(s);
  eq(readLog(p, 'merges.jsonl').length, after.length, 'idempotent');
});

test('glab api cancel_merge_when_pipeline_succeeds is logged as a cancellation; disable-auto with nothing queued has resolves_ts null', () => {
  const p = tmpProject();
  logMerge(p, 'glab mr merge 12 --auto-merge', fakeGlab(mrJson('opened', { iid: 12, auto: true })));
  const [q] = readLog(p, 'merges.jsonl');
  eq(q.outcome, 'auto-merge-queued', 'precondition');
  logMerge(p, 'glab api -X POST projects/:id/merge_requests/12/cancel_merge_when_pipeline_succeeds', fakeGlab('', 1));
  const c = readLog(p, 'merges.jsonl')[1];
  eq(c.outcome, 'auto-merge-cancelled', 'outcome'); eq(c.forge, 'gitlab', 'forge'); eq(c.pr, '12', 'pr');
  eq(c.resolves_ts, q.ts, 'resolves_ts'); eq(c.cancelled_by, 'director', 'cancelled_by');
  logMerge(p, 'gh pr merge 77 --disable-auto', fakeGh('', 1));
  const n = readLog(p, 'merges.jsonl')[2];
  eq(n.outcome, 'auto-merge-cancelled', 'nothing queued still not a failed merge'); eq(n.resolves_ts, null, 'resolves_ts null');
});

console.log('merge-reconcile: archive-logs');

test('archive-logs stays offline, warns about unresolved queued merges, exit code unchanged', () => {
  const p = tmpProject();
  const logs = path.join(p, '.agent-team', 'logs');
  const rows = [queued(1, 't1'), queued(2, 't2'), { ...queued(2, 't3'), outcome: 'merged', resolves_ts: 't2' }, queued(3, 't4')];
  fs.writeFileSync(path.join(logs, 'merges.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-arch-'));
  const gh = path.join(p, 'gh-must-not-run.js');
  fs.writeFileSync(gh, "require('fs').writeFileSync(process.env.GH_RAN, 'x'); process.exit(1);");
  const ran = path.join(p, 'gh-ran');
  const r = spawnSync('node', [path.join(SCRIPTS, 'archive-logs.js'), 'm1', '--project', 'proj'], {
    cwd: p, encoding: 'utf8', env: { ...process.env, AGENT_TEAM_ARCHIVE: root, AGENT_TEAM_FAKE_GH: gh, GH_RAN: ran },
  });
  eq(r.status, 0, r.stderr);
  assert(r.stdout.includes('2 auto-merge-queued merges unresolved; run reconcile-logs.js --merges first'), r.stdout);
  eq(fs.existsSync(ran), false, 'archive never calls the forge');
});
