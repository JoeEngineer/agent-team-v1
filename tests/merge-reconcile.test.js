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

const logMerge = (proj, command, env) => run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '' } }, proj, env);

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
  assert(/PR 2: auto-merge was cancelled; CI has no checks/.test(r.stdout), r.stdout);
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

// Final review M2: a queued PR that merged at another head than the reviewed
// match_head was reported as plain "merged".
test('merged at another head than the queued match_head: a loud line, head_moved and merged_head on the resolution (GitHub and GitLab)', () => {
  const s = setup([
    queued(90, '2026-11-01T10:00:00.000Z', { match_head: SHA }),
    queued(91, '2026-11-01T10:01:00.000Z', { match_head: SHA }),
    queued(92, '2026-11-01T10:02:00.000Z', { match_head: SHA.slice(0, 12) }),
    queued(93, '2026-11-01T10:03:00.000Z', { match_head: SHA, forge: 'gitlab' }),
  ], {
    'view:90': prJson('MERGED', { head: NEW_SHA, mergedAt: '2026-11-01T10:07:30Z' }),
    'view:91': prJson('MERGED', { head: SHA, mergedAt: '2026-11-01T10:08:00Z' }),
    'view:92': prJson('MERGED', { head: SHA, mergedAt: '2026-11-01T10:09:00Z' }),
    'view:93': mrJson('merged', { iid: 93, head: NEW_SHA, mergedAt: '2026-11-01T10:10:00Z' }),
  });
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  eq(s.calls().length, 4, 'precondition: each PR was asked once');
  assert(r.stdout.includes(`WARNING: PR 90 merged at ${NEW_SHA}, not the reviewed ${SHA}: check it`), r.stdout);
  assert(r.stdout.includes(`WARNING: MR 93 merged at ${NEW_SHA}, not the reviewed ${SHA}: check it`), r.stdout);
  assert(/PR 91: merged at 2026-11-01T10:08:00Z/.test(r.stdout) && !/PR 91 merged at/.test(r.stdout), `same head: plain line\n${r.stdout}`);
  assert(/PR 92: merged at/.test(r.stdout), `a short match_head that prefixes the head is the same head\n${r.stdout}`);
  const res = Object.fromEntries(s.rows().filter((x) => x.resolution_id).map((x) => [x.pr, x]));
  eq(res['90'].outcome, 'merged', 'still a merge'); eq(res['90'].head_moved, true, 'head_moved'); eq(res['90'].merged_head, NEW_SHA, 'merged_head');
  eq(res['90'].merged_at, '2026-11-01T10:07:30Z', 'merged_at kept');
  eq(res['93'].head_moved, true, 'gitlab head_moved'); eq(res['93'].merged_head, NEW_SHA, 'gitlab merged_head');
  eq(res['91'].head_moved, undefined, 'same head: no head_moved'); eq(res['91'].merged_head, undefined, 'same head: no merged_head');
  eq(res['92'].head_moved, undefined, 'prefix: no head_moved');
  // One step past: the resolved PRs are not asked again and nothing more is written.
  const n = s.rows().length;
  reconcile(s);
  eq(s.rows().length, n, 'idempotent'); eq(s.calls().length, 4, 'no further forge call');
});

// Final review minor (f): the cancelled line now carries the CI state, so a red
// PR can be sent back without another CI turn.
test('auto-merge found cancelled: the line gives the CI state and failing check names (red, pending, green, GitLab pipeline)', () => {
  const s = setup([queued(1, 't1'), queued(2, 't2'), queued(3, 't3'), queued(4, 't4', { forge: 'gitlab' })], {
    'view:1': prJson('OPEN', { auto: false, checks: [check('build', 'FAILURE'), check('unit', 'FAILURE'), check('lint', 'SUCCESS')] }),
    'view:2': prJson('OPEN', { auto: false, checks: [check('build', '')] }),
    'view:3': prJson('OPEN', { auto: false, checks: [check('build', 'SUCCESS')] }),
    'view:4': mrJson('opened', { iid: 4, auto: false, pipeline: { id: 9, status: 'failed' } }),
  });
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  assert(r.stdout.includes('PR 1: auto-merge was cancelled; CI red (build, unit)'), r.stdout);
  assert(r.stdout.includes('PR 2: auto-merge was cancelled; CI pending'), r.stdout);
  assert(r.stdout.includes('PR 3: auto-merge was cancelled; CI green'), r.stdout);
  assert(r.stdout.includes('MR 4: auto-merge was cancelled; CI red'), r.stdout);
  eq(s.rows().filter((x) => x.outcome === 'auto-merge-cancelled').length, 4, 'four cancelled lines');
});

// Final review minor (b): openQueued keyed on ts alone, so resolving one PR
// also hid another PR queued in the same millisecond.
test('two PRs queued in the same millisecond: resolving one leaves the other open, and the next run still asks about it', () => {
  const T = '2026-11-01T10:00:00.000Z';
  const s = setup([queued(1, T), queued(2, T)], {
    'view:1': prJson('MERGED', { mergedAt: '2026-11-01T10:05:00Z' }),
    'view:2': prJson('OPEN', { auto: true, checks: [check('build', '')] }),
  });
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  assert(/PR 1: merged/.test(r.stdout) && /PR 2: still queued/.test(r.stdout), r.stdout);
  eq(s.rows().filter((x) => x.resolution_id).length, 1, 'precondition: PR 1 resolved, PR 2 not');
  const r2 = reconcile(s);
  assert(/PR 2: still queued/.test(r2.stdout), `second run still asks about PR 2:\n${r2.stdout}`);
  eq(s.calls().filter((c) => c[2] === '2').length, 2, 'PR 2 asked on both runs');
  eq(s.calls().filter((c) => c[2] === '1').length, 1, 'PR 1 not asked again');
  const records = require(path.join(SCRIPTS, 'records.js'));
  eq(JSON.stringify(records.openQueued(s.rows()).map((x) => x.pr)), '["2"]', 'openQueued: only PR 2');
  eq(JSON.stringify(records.unresolvedQueued(s.rows()).map((x) => x.pr)), '["2"]', 'unresolvedQueued (archive-logs): only PR 2');
  // An older resolution line written without resolution_id still resolves only its own PR.
  const legacy = [queued(1, T), queued(2, T), { ts: 'x', pr: '1', outcome: 'closed', resolves_ts: T }];
  eq(JSON.stringify(records.openQueued(legacy).map((x) => x.pr)), '["2"]', 'legacy line: forge, PR and resolves_ts');
});

// Final review minor (a): a plain merge attempt on a queued PR logged the queue
// again without match_head, superseding the pinned line and losing the
// head-moved check.
test('a later non-auto merge attempt on a queued PR keeps the pinned match_head, so reconcile still flags a merge at another head', () => {
  const p = tmpProject();
  logMerge(p, `gh pr merge 5 --auto --squash --match-head-commit ${SHA}`, fakeGh(prJson('OPEN', { auto: true })));
  logMerge(p, 'gh pr merge 5 --squash', fakeGh(prJson('OPEN', { auto: true })));
  const [q, again] = readLog(p, 'merges.jsonl');
  eq(q.match_head, SHA, 'precondition: the queue is pinned');
  eq(again.outcome, 'auto-merge-queued', 'precondition: the plain attempt found the queue still on');
  eq(again.auto, undefined, 'not an auto command');
  eq(again.match_head, SHA, 'match_head carried forward');
  eq(again.match_head_from_ts, q.ts, 'from the pinned line');
  const s = { proj: p, rows: () => readLog(p, 'merges.jsonl'), env: { AGENT_TEAM_FAKE_GH: FAKE_CI, FAKE_CI_ROUTES: path.join(p, 'routes.json'), FAKE_CI_STATE: path.join(p, 's.json'), FAKE_CI_LOG: path.join(p, 'calls.log') } };
  fs.writeFileSync(s.env.FAKE_CI_ROUTES, JSON.stringify({ 'view:5': prJson('MERGED', { head: NEW_SHA, mergedAt: '2026-11-01T10:07:30Z' }) }));
  const r = reconcile(s);
  assert(r.stdout.includes(`WARNING: PR 5 merged at ${NEW_SHA}, not the reviewed ${SHA}: check it`), r.stdout);
  const res = s.rows().find((x) => x.resolves_ts === again.ts);
  eq(res.head_moved, true, 'head_moved on the latest line\'s resolution');
  // Control: a plain attempt with nothing queued carries nothing.
  const p2 = tmpProject();
  logMerge(p2, 'gh pr merge 6 --squash', fakeGh(prJson('OPEN', { auto: true })));
  eq(readLog(p2, 'merges.jsonl')[0].match_head, undefined, 'nothing to carry');
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

// Final review minor (c): --merges printed nothing both when nothing was
// queued and when merges.jsonl was missing.
test('--merges with nothing queued says so and counts the merge lines; with no merges.jsonl it says that, with a stderr note, exit 0; no forge call either way', () => {
  const resolvedOnly = [queued(1, 't1'), { ...queued(1, 't2'), outcome: 'closed', resolves_ts: 't1', resolution_id: 'github:1:t1' }];
  const s = setup(resolvedOnly, {});
  const file = path.join(s.proj, '.agent-team', 'logs', 'merges.jsonl');
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  eq(r.stdout.trim(), `no queued merges (2 merge lines in ${file})`, 'nothing queued');
  eq(r.stderr, '', 'no stderr when the log exists');
  eq(reconcile(s, ['--merges', '--dry-run']).stdout.trim(), `[dry run] no queued merges (2 merge lines in ${file})`, 'dry run');
  const one = setup([{ ...queued(3, 't3'), outcome: 'merged', auto: undefined }], {});
  assert(reconcile(one).stdout.includes('(1 merge line in '), 'singular');
  const empty = setup([], {});
  fs.rmSync(path.join(empty.proj, '.agent-team', 'logs', 'merges.jsonl'));
  const missing = reconcile(empty);
  eq(missing.status, 0, 'exit 0');
  eq(missing.stdout.trim(), `no merges.jsonl at ${path.join(empty.proj, '.agent-team', 'logs', 'merges.jsonl')}; hooks may be off`, 'missing file');
  assert(/agent-team hooks: active/.test(missing.stderr), `stderr note: ${missing.stderr}`);
  eq(fs.existsSync(path.join(empty.proj, '.agent-team', 'logs', 'merges.jsonl')), false, 'nothing created');
  eq(s.calls().length + empty.calls().length, 0, 'no forge call');
  // A plain run (not --merges) keeps its own summary and adds neither line.
  const plain = reconcile(empty, []);
  assert(!/hooks may be off|no queued merges/.test(plain.stdout), plain.stdout);
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

test('a forge-confirmed cancellation and reconcile share one resolution_id: whichever comes second adds nothing (cancel first, and reconcile first)', () => {
  // Cancel first: the cancellation, confirmed by gh (open, auto-merge off), carries the id.
  const p = tmpProject();
  logMerge(p, 'gh pr merge 11 --auto --squash', fakeGh(prJson('OPEN', { auto: true })));
  const [q] = readLog(p, 'merges.jsonl');
  eq(q.outcome, 'auto-merge-queued', 'precondition: queued');
  logMerge(p, 'gh pr merge 11 --disable-auto', fakeGh(prJson('OPEN', { auto: false })));
  const c = readLog(p, 'merges.jsonl')[1];
  eq(c.resolution_id, `github:11:${q.ts}`, 'cancellation resolution_id');
  // Reconcile first (its forge call said "no auto-merge"): a late cancel adds nothing.
  const s = setup([q], { 'view:11': prJson('OPEN', { auto: false }) });
  reconcile(s);
  const res = s.rows()[1];
  eq(res.resolution_id, c.resolution_id, 'same id as a cancellation');
  logMerge(s.proj, 'gh pr merge 11 --disable-auto', fakeGh(prJson('OPEN', { auto: false })));
  eq(s.rows().length, 2, 'late cancel added nothing');
});

test('glab api cancel needs POST: a GET of the same path is not a cancellation (and asks nothing); --method POST and -X POST are', () => {
  const p = tmpProject();
  const url = 'projects/:id/merge_requests/12/cancel_merge_when_pipeline_succeeds';
  const argsFile = path.join(p, 'glab-args.jsonl');
  const off = fakeGlab(mrJson('opened', { iid: 12, auto: false }), 0, { FAKE_GH_ARGS: argsFile });
  logMerge(p, `glab api ${url}`, off);
  logMerge(p, `glab api -X GET ${url}`, off);
  eq(readLog(p, 'merges.jsonl').length, 0, 'GET logs nothing');
  eq(fs.existsSync(argsFile), false, 'GET asks glab nothing');
  logMerge(p, `glab api --method POST ${url}`, off);
  eq(readLog(p, 'merges.jsonl').length, 1, '--method POST logged');
  logMerge(p, `glab api -X POST ${url}`, off);
  eq(readLog(p, 'merges.jsonl').length, 2, '-X POST logged');
  const asked = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).join(' '));
  eq(asked.join('|'), 'mr view 12 --output json|mr view 12 --output json', 'each POST asked glab about MR 12 once');
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

const GH_RESOLUTION_VIEW = (n) => `pr view ${n} --json headRefOid,baseRefName,state,statusCheckRollup,autoMergeRequest,mergedAt,number`;
const argsOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).join(' ')) : []);

test('gh pr merge --disable-auto is logged as auto-merge-cancelled only after one gh pr view confirms auto-merge is off, resolving the latest open queued line; reconcile then adds no second cancellation', () => {
  const p = tmpProject();
  logMerge(p, 'gh pr merge 11 --auto --squash', fakeGh(prJson('OPEN', { auto: true })));
  logMerge(p, 'gh pr merge 11 --auto --squash', fakeGh(prJson('OPEN', { auto: true })));
  const [, q2] = readLog(p, 'merges.jsonl');
  eq(q2.outcome, 'auto-merge-queued', 'precondition: a queued line exists');
  const argsFile = path.join(p, 'gh-args.jsonl');
  const logged = logMerge(p, 'gh pr merge 11 --disable-auto', fakeGh(prJson('OPEN', { auto: false }), 0, { FAKE_GH_ARGS: argsFile }));
  const rows = readLog(p, 'merges.jsonl');
  const c = rows[2];
  eq(rows.length, 3, 'one new line');
  eq(c.outcome, 'auto-merge-cancelled', 'outcome'); eq(c.cancelled_by, 'director', 'cancelled_by');
  eq(c.resolves_ts, q2.ts, 'resolves the latest open queued line'); eq(c.pr, '11', 'pr');
  eq(c.outcome_source, 'gh pr view', 'the cancel is the forge\'s answer, not the command\'s');
  eq(argsOf(argsFile).join('|'), GH_RESOLUTION_VIEW(11), 'asked gh about PR 11, once, after the command');
  eq(logged.stdout, '', 'confirmed: no warning');
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

test('glab api cancel_merge_when_pipeline_succeeds, confirmed by glab, is logged as a cancellation; a confirmed disable-auto with nothing queued has resolves_ts null', () => {
  const p = tmpProject();
  logMerge(p, 'glab mr merge 12 --auto-merge', fakeGlab(mrJson('opened', { iid: 12, auto: true })));
  const [q] = readLog(p, 'merges.jsonl');
  eq(q.outcome, 'auto-merge-queued', 'precondition');
  logMerge(p, 'glab api -X POST projects/:id/merge_requests/12/cancel_merge_when_pipeline_succeeds', fakeGlab(mrJson('opened', { iid: 12, auto: false })));
  const c = readLog(p, 'merges.jsonl')[1];
  eq(c.outcome, 'auto-merge-cancelled', 'outcome'); eq(c.forge, 'gitlab', 'forge'); eq(c.pr, '12', 'pr');
  eq(c.resolves_ts, q.ts, 'resolves_ts'); eq(c.cancelled_by, 'director', 'cancelled_by'); eq(c.outcome_source, 'glab mr view', 'source');
  logMerge(p, 'gh pr merge 77 --disable-auto', fakeGh(prJson('OPEN', { auto: false })));
  const n = readLog(p, 'merges.jsonl')[2];
  eq(n.outcome, 'auto-merge-cancelled', 'nothing queued still not a failed merge'); eq(n.resolves_ts, null, 'resolves_ts null');
  eq(n.pr, '77', 'pr');
});

// Final review M3: a cancel that failed (gh exits 1, or auto-merge is still on)
// used to be logged as cancelled, so reconcile stopped tracking a PR that could
// still auto-merge the unreviewed head of a send-back push.
for (const [why, env, warn] of [
  ['gh pr view says auto-merge is still on', () => fakeGh(prJson('OPEN', { auto: true })), /gh pr view says auto-merge is still on/],
  ["gh can't answer (the stand-in exits 1)", () => fakeGh('', 1), /gh pr view couldn't answer/],
]) {
  test(`--disable-auto when ${why}: no cancelled line, the queued line stays open, a loud warning; reconcile still tracks it; a later confirmed cancel resolves it`, () => {
    const p = tmpProject();
    logMerge(p, `gh pr merge 11 --auto --squash --match-head-commit ${SHA}`, fakeGh(prJson('OPEN', { auto: true })));
    const [q] = readLog(p, 'merges.jsonl');
    eq(q.outcome, 'auto-merge-queued', 'precondition: queued');
    const argsFile = path.join(p, 'gh-args.jsonl');
    const r = logMerge(p, 'gh pr merge 11 --disable-auto && git push', { ...env(), FAKE_GH_ARGS: argsFile });
    eq(argsOf(argsFile).join('|'), GH_RESOLUTION_VIEW(11), 'precondition: the forge was asked about PR 11 after the cancel');
    eq(readLog(p, 'merges.jsonl').length, 1, 'no line written');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert(/WARNING: auto-merge may still be on for PR 11/.test(ctx), ctx);
    assert(warn.test(ctx), ctx);
    assert(/Do not push to this PR until `gh pr view 11 --json autoMergeRequest` shows auto-merge off/.test(ctx), ctx);
    assert(r.stderr.includes('WARNING: auto-merge may still be on for PR 11'), `stderr: ${r.stderr}`);
    // One step past: reconcile still asks the forge about it and reports it queued.
    const s = { proj: p, rows: () => readLog(p, 'merges.jsonl'), env: { AGENT_TEAM_FAKE_GH: FAKE_CI, FAKE_CI_ROUTES: path.join(p, 'routes.json'), FAKE_CI_STATE: path.join(p, 's.json'), FAKE_CI_LOG: path.join(p, 'calls.log') } };
    fs.writeFileSync(s.env.FAKE_CI_ROUTES, JSON.stringify({ 'view:11': prJson('OPEN', { auto: true, checks: [check('build', '')] }) }));
    const rr = reconcile(s);
    assert(/PR 11: still queued, CI pending/.test(rr.stdout), rr.stdout);
    eq(s.rows().length, 1, 'still open after reconcile');
    // Recovery control: the next cancel, confirmed, resolves the queued line.
    logMerge(p, 'gh pr merge 11 --disable-auto', fakeGh(prJson('OPEN', { auto: false })));
    const after = s.rows();
    eq(after.length, 2, 'cancel logged once confirmed');
    eq(after[1].outcome, 'auto-merge-cancelled', 'outcome'); eq(after[1].resolves_ts, q.ts, 'resolves the queued line');
  });
}

test('glab cancel that glab does not confirm: no line, warning names the glab check; a merged or closed PR gets that resolution instead of a cancel', () => {
  const p = tmpProject();
  logMerge(p, `glab mr merge 12 --auto-merge --sha ${SHA}`, fakeGlab(mrJson('opened', { iid: 12, auto: true })));
  const cancel = 'glab api -X POST projects/:id/merge_requests/12/cancel_merge_when_pipeline_succeeds';
  const r = logMerge(p, cancel, fakeGlab(mrJson('opened', { iid: 12, auto: true })));
  eq(readLog(p, 'merges.jsonl').length, 1, 'no line while still on');
  assert(/auto-merge may still be on for MR 12.*glab mr view 12 --output json \(merge_when_pipeline_succeeds\)/.test(JSON.parse(r.stdout).hookSpecificOutput.additionalContext), r.stdout);
  // The MR merged before the cancel landed: the queued line is resolved as merged.
  logMerge(p, cancel, fakeGlab(mrJson('merged', { iid: 12, mergedAt: '2026-11-01T12:00:00Z' })));
  const res = readLog(p, 'merges.jsonl')[1];
  eq(res.outcome, 'merged', 'merged, not cancelled'); eq(res.merged_at, '2026-11-01T12:00:00Z', 'merged_at');
  eq(res.cancelled_by, undefined, 'not a cancellation'); eq(res.note, 'checked after a cancel', 'note');
  eq(res.forge, 'gitlab', 'forge'); eq(res.head_moved, undefined, 'merged at the queued head');
  // A closed PR, on GitHub, with --disable-auto on the current branch (no number in the command).
  const p2 = tmpProject();
  logMerge(p2, 'gh pr merge 30 --auto --squash', fakeGh(prJson('OPEN', { auto: true })));
  const argsFile = path.join(p2, 'gh-args.jsonl');
  logMerge(p2, 'gh pr merge --disable-auto', fakeGh(JSON.stringify({ ...JSON.parse(prJson('CLOSED')), number: 30 }), 0, { FAKE_GH_ARGS: argsFile }));
  eq(argsOf(argsFile).join('|'), 'pr view --json headRefOid,baseRefName,state,statusCheckRollup,autoMergeRequest,mergedAt,number', 'asked about the current branch');
  const closed = readLog(p2, 'merges.jsonl')[1];
  eq(closed.outcome, 'closed', 'closed'); eq(closed.pr, '30', 'pr from the forge'); eq(closed.resolution_id.startsWith('github:30:'), true, 'resolves PR 30');
});

// Review of #103: each forge call had its own 7 s limit, so two cancels against
// a hanging gh took 14 s, and Claude Code kills the PostToolUse hook at 10 s,
// losing both warnings. All calls of one run now share one deadline.
function hangingLog(command, routes, queuedPrs) {
  const p = tmpProject();
  const logs = path.join(p, '.agent-team', 'logs');
  fs.writeFileSync(path.join(logs, 'merges.jsonl'), queuedPrs.map((n) => JSON.stringify(queued(n, `2026-11-01T10:0${n % 10}:00.000Z`, { match_head: SHA }))).join('\n') + '\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-hang-'));
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify(routes));
  const env = {
    AGENT_TEAM_FAKE_GH: FAKE_CI, FAKE_CI_ROUTES: path.join(dir, 'routes.json'), FAKE_CI_STATE: path.join(dir, 'state.json'),
    FAKE_CI_LOG: path.join(dir, 'calls.log'), FAKE_CI_PID: path.join(dir, 'pids.txt'),
  };
  const t0 = Date.now();
  const r = logMerge(p, command, env);
  const elapsed = Date.now() - t0;
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean) : []);
  return { r, elapsed, rows: readLog(p, 'merges.jsonl'), calls: read('calls.log').map((l) => JSON.parse(l)), pids: read('pids.txt').map(Number) };
}
const ctxOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

test('hook budget: two cancels against a hanging gh end under 9 s, with a warning for each; the queued lines stay open', () => {
  const h = hangingLog('gh pr merge 11 --disable-auto; gh pr merge 12 --disable-auto', { 'view:11': { hang: true }, 'view:12': { hang: true } }, [11, 12]);
  eq(h.pids.length >= 1, true, 'precondition: the stand-in gh started hanging');
  eq(h.r.status, 0, `hook exit (stderr: ${h.r.stderr})`);
  assert(h.elapsed < 9000, `took ${h.elapsed} ms; Claude Code kills the hook at 10 s`);
  const ctx = ctxOf(h.r);
  assert(/auto-merge may still be on for PR 11\. `gh pr merge --disable-auto` ran, but gh pr view couldn't answer \(timed out\)/.test(ctx), ctx);
  assert(/auto-merge may still be on for PR 12/.test(ctx), ctx);
  assert(/`gh pr view 12 --json autoMergeRequest`/.test(ctx), ctx);
  for (const n of [11, 12]) assert(h.r.stderr.includes(`auto-merge may still be on for PR ${n}`), `stderr has PR ${n}: ${h.r.stderr}`);
  eq(h.rows.length, 2, 'nothing written: both queued lines stay open');
  eq(JSON.stringify(require(path.join(SCRIPTS, 'records.js')).openQueued(h.rows).map((x) => x.pr)), '["11","12"]', 'both still open for reconcile');
});

test('hook budget: a slow merge then a cancel: the merge is logged unknown, the cancel is "not checked" with the check to run, all under 9 s', () => {
  const h = hangingLog('gh pr merge 13 --squash && gh pr merge 11 --disable-auto', { 'view:13': { hang: true }, 'view:11': prJson('OPEN', { auto: false }) }, [11]);
  eq(h.calls.length, 1, 'precondition: only the merge lookup ran; the cancel lookup was skipped');
  eq(h.calls[0][2], '13', 'the merge lookup was for PR 13');
  assert(h.elapsed < 9000, `took ${h.elapsed} ms`);
  const ctx = ctxOf(h.r);
  assert(/auto-merge may still be on for PR 11: `gh pr merge --disable-auto` ran, but it was not checked: the hook's time for forge calls ran out\. Verify with `gh pr view 11 --json autoMergeRequest`/.test(ctx), ctx);
  const merge = h.rows.find((x) => x.pr === '13');
  eq(merge.outcome, 'unknown', 'the slow merge is logged as unknown');
  eq(h.rows.filter((x) => x.outcome === 'auto-merge-cancelled').length, 0, 'no cancelled line for the unchecked cancel');
  // The other order: the cancel hangs, so the merge after it is not looked up.
  const h2 = hangingLog('gh pr merge 11 --disable-auto; gh pr merge 13 --auto --squash', { 'view:11': { hang: true }, 'view:13': prJson('OPEN', { auto: true }) }, [11]);
  assert(h2.elapsed < 9000, `took ${h2.elapsed} ms`);
  eq(h2.calls.length, 1, 'only the cancel lookup ran');
  const m13 = h2.rows.find((x) => x.pr === '13');
  eq(m13.outcome, 'unknown', 'skipped merge: unknown'); eq(m13.note, "not checked: the hook's time for forge calls ran out", 'note');
  const ctx2 = ctxOf(h2.r);
  assert(/PR 11/.test(ctx2) && /the outcome of PR 13's merge was not checked.*`gh pr view 13 --json state,autoMergeRequest`: if auto-merge is queued, reconcile-logs\.js will not track it/.test(ctx2), ctx2);
});

test('a cancel in another repo asks that repo: gh -R o/r, and glab api projects/<encoded path>', () => {
  const p = tmpProject();
  const ghArgs = path.join(p, 'gh-args.jsonl');
  logMerge(p, 'gh pr merge 11 -R o/r --disable-auto', fakeGh(prJson('OPEN', { auto: false }), 0, { FAKE_GH_ARGS: ghArgs }));
  eq(argsOf(ghArgs).join('|'), 'pr view 11 --repo o/r --json headRefOid,baseRefName,state,statusCheckRollup,autoMergeRequest,mergedAt,number', 'gh --repo');
  const glArgs = path.join(p, 'glab-args.jsonl');
  logMerge(p, 'glab api -X POST projects/grp%2Fapp/merge_requests/12/cancel_merge_when_pipeline_succeeds', fakeGlab(mrJson('opened', { iid: 12, auto: false }), 0, { FAKE_GH_ARGS: glArgs }));
  eq(argsOf(glArgs).join('|'), 'mr view 12 --repo grp/app --output json', 'glab --repo, decoded');
  eq(readLog(p, 'merges.jsonl').length, 2, 'both confirmed cancels logged');
});

test('--disable-auto=true is a cancel (pflag form); --disable-auto=false is not', () => {
  const p = tmpProject();
  logMerge(p, 'gh pr merge 11 --auto --squash', fakeGh(prJson('OPEN', { auto: true })));
  logMerge(p, 'gh pr merge 11 --disable-auto=false --squash', fakeGh(prJson('OPEN', { auto: true })));
  const rows = readLog(p, 'merges.jsonl');
  eq(rows[1].cancelled_by, undefined, '=false: logged as a merge attempt, not a cancel');
  logMerge(p, 'gh pr merge 11 --disable-auto=true', fakeGh(prJson('OPEN', { auto: false })));
  const c = readLog(p, 'merges.jsonl')[2];
  eq(c.outcome, 'auto-merge-cancelled', '=true is a cancel'); eq(c.cancelled_by, 'director', 'cancelled_by');
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
