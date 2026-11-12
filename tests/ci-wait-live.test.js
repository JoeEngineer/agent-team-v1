// tests/live/ci-wait-lib.js (pure helpers) and tests/live/ci-wait-live.js driven by a
// stand-in `gh` and a local bare repo: preflight verdicts, the cleanup selection, cleanup
// after a failure and after an interrupt, the fixture and the Director prompt.
// No network, no Claude, no Codex, no GitHub.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeAssert = require('assert');
const { spawnSync } = require('child_process');
const { test, assert, eq } = require('./helpers');
const L = require('./live/ci-wait-lib.js');

const LIVE = path.join(__dirname, 'live');
const HARNESS = path.join(LIVE, 'ci-wait-live.js');
const FIXTURE = path.join(LIVE, 'fixtures', 'ci-sample');
const RUN = 'live-20261112t012548-claude';
const OTHER_TOOL = 'live-20261112t012548-codex';
const OTHER_RUN = 'live-20261111t000000-claude';

// ---- arguments ----
test('ci-wait-live args: a full run needs tool, repo, plugin and label', () => {
  const full = ['--tool', 'claude', '--repo', 'o/r', '--plugin', '/p', '--label', 'before'];
  const ok = L.parseArgs(full);
  eq(ok.error, undefined, 'valid args');
  eq(ok.opts.tool, 'claude', 'tool');
  eq(ok.opts.keep, false, 'keep defaults off');
  eq(ok.opts.probeAutoHead, false, 'probe defaults off');
  for (const drop of ['--tool', '--plugin', '--label']) {
    const i = full.indexOf(drop);
    const r = L.parseArgs(full.filter((_, k) => k !== i && k !== i + 1));
    assert(r.error && r.error.includes(drop.replace(/^--/, '')), `missing ${drop} is reported: ${r.error}`);
  }
  assert(L.parseArgs(full.slice(2)).error.includes('--tool'), 'no --tool');
  assert(L.parseArgs(['--tool', 'gemini', '--repo', 'o/r']).error.includes('--tool must be'), 'unknown tool');
  assert(L.parseArgs(['--repo', 'nope']).error.includes('OWNER/REPO'), 'repo shape');
  assert(L.parseArgs([...full, '--bogus']).error.includes('unknown argument'), 'unknown flag');
  assert(L.parseArgs([...full, '--label']).error.includes('needs a value'), 'flag without value');
  assert(L.parseArgs([...full, '--timeout-min', '0']).error.includes('positive'), 'zero timeout');
  assert(L.parseArgs(['--tool', 'claude', '--repo', 'o/r', '--plugin', '/p', '--label', 'a b']).error.includes('--label'), 'label characters');
  const both = L.parseArgs([...full, '--probe-auto-head', '--keep']);
  assert(both.opts.probeAutoHead && both.opts.keep, 'flags set');
});

test('ci-wait-live args: --seed-only, --smoke and --cleanup-run are their own modes', () => {
  const s = L.parseArgs(['--repo', 'o/r', '--seed-only']);
  eq(s.opts.seedOnly, true, 'seed-only');
  eq(s.opts.tool, 'claude', 'seed-only needs no tool');
  assert(L.parseArgs(['--repo', 'o/r', '--seed-only', '--smoke']).error, 'seed-only + smoke rejected');
  const c = L.parseArgs(['--repo', 'o/r', '--cleanup-run', RUN, '--dry-run']);
  eq(c.opts.cleanupRun, RUN, 'cleanup run');
  eq(c.opts.dryRun, true, 'dry run');
  assert(L.parseArgs(['--repo', 'o/r', '--cleanup-run', 'main']).error, 'a prefix that is not a run prefix is refused');
  assert(L.parseArgs(['--repo', 'o/r', '--cleanup-run', 'live-1-claude']).error, 'a malformed timestamp is refused');
  assert(L.parseArgs(['--tool', 'claude', '--repo', 'o/r', '--plugin', 'p', '--label', 'x', '--dry-run']).error.includes('--cleanup-run'), '--dry-run alone');
});

test('ci-wait-live: the run prefix is unique per second and per tool, and matches RUN_RE', () => {
  const d = new Date('2026-11-12T01:25:48.999Z');
  eq(L.runPrefix('claude', d), RUN, 'prefix');
  assert(L.RUN_RE.test(L.runPrefix('codex', d)), 'codex prefix matches');
  assert(L.runPrefix('claude', d) !== L.runPrefix('claude', new Date('2026-11-12T01:25:49Z')), 'next second differs');
  assert(L.runPrefix('claude', d) !== L.runPrefix('codex', d), 'tools differ');
});

// ---- cleanup selection (dry-run listing) ----
const listing = () => ({
  branches: ['main', `milestone/${RUN}`, `task/${RUN}-1`, `task/${RUN}-1-sum`, `${RUN}-seed`, `${RUN}-probe`,
    `task/${RUN}9`, `task/x-${RUN}`, `milestone/${OTHER_RUN}`, `${OTHER_TOOL}-seed`, 'feature/x', 'master'],
  prs: [
    { number: 1, title: `${RUN} seed`, headRefName: `${RUN}-seed` },
    { number: 2, title: `${RUN}-1: sum`, headRefName: `task/${RUN}-1` },
    { number: 3, title: `${OTHER_TOOL} seed`, headRefName: `${OTHER_TOOL}-seed` },
    { number: 4, title: 'a real PR', headRefName: 'feature/x' },
    { number: 5, title: 'milestone', headRefName: `milestone/${RUN}` },
    { number: 6, title: 'older run', headRefName: `milestone/${OTHER_RUN}` },
    { number: 7, title: `renamed head but ours: ${RUN.toUpperCase()}-2`, headRefName: 'wip' },
  ],
  issues: [
    { number: 10, title: `${RUN}: milestone`, body: '' },
    { number: 11, title: 'task 2', body: `id ${RUN}-2` },
    { number: 12, title: 'someone else', body: OTHER_RUN },
    { number: 13, title: 'no body', body: null },
  ],
});

test('ci-wait-live cleanup: selects only this run\'s PRs, issues and branches', () => {
  const sel = L.selectCleanup(listing(), RUN, 'main');
  nodeAssert.deepStrictEqual(sel.branches, [`milestone/${RUN}`, `task/${RUN}-1`, `task/${RUN}-1-sum`, `${RUN}-seed`, `${RUN}-probe`]);
  nodeAssert.deepStrictEqual(sel.prs, [1, 2, 5, 7]);
  nodeAssert.deepStrictEqual(sel.issues, [10, 11]);
});

test('ci-wait-live cleanup: never main, the default branch, another run, or a longer name', () => {
  const sel = L.selectCleanup(listing(), RUN, 'main');
  for (const b of ['main', 'master', 'feature/x', `milestone/${OTHER_RUN}`, `${OTHER_TOOL}-seed`, `task/${RUN}9`, `task/x-${RUN}`]) assert(!sel.branches.includes(b), `${b} must stay`);
  // even a default branch that happens to carry the prefix is refused
  nodeAssert.deepStrictEqual(L.selectCleanup({ branches: [RUN] }, RUN, RUN).branches, []);
  nodeAssert.deepStrictEqual(L.selectCleanup({ branches: ['main'] }, RUN, 'main').branches, []);
  assert(L.selectCleanup(listing(), 'main', 'main').refused, 'a bad run prefix selects nothing');
  assert(L.selectCleanup(listing(), '', 'main').refused, 'an empty prefix selects nothing');
  assert(L.selectCleanup(listing(), 'live-', 'main').refused, 'a bare "live-" prefix selects nothing');
});

test('ci-wait-live cleanup: empty and missing listings select nothing', () => {
  nodeAssert.deepStrictEqual(L.selectCleanup({ branches: [], prs: [], issues: [] }, RUN, 'main'), { branches: [], prs: [], issues: [] });
  nodeAssert.deepStrictEqual(L.selectCleanup(null, RUN, 'main'), { branches: [], prs: [], issues: [] });
});

// ---- preflight ----
const goodRepo = () => ({ private: true, default_branch: 'main', permissions: { push: true }, allow_auto_merge: true, allow_squash_merge: true });
const goodInput = () => ({ authOk: true, repo: goodRepo(), actions: { enabled: true },
  rules: [{ type: 'non_fast_forward' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'other' }, { context: 'sample-ci' }] } }] });

test('ci-wait-live preflight: a fully set up repo passes', () => {
  const r = L.evaluatePreflight(goodInput(), 'o/r');
  assert(r.ok, JSON.stringify(r.problems));
  eq(r.problems.length, 0, 'no problems');
});

test('ci-wait-live preflight: each missing piece is named, with the steps for it', () => {
  const cases = [
    ['gh-auth', (i) => { i.authOk = false; }, 'gh auth login'],
    ['repo', (i) => { i.repo = null; i.repoError = 'Not Found'; }, 'o/r'],
    ['push', (i) => { i.repo.permissions = { pull: true }; }, 'write access'],
    ['auto-merge', (i) => { i.repo.allow_auto_merge = false; }, 'Allow auto-merge'],
    ['squash', (i) => { i.repo.allow_squash_merge = false; }, 'squash'],
    ['actions', (i) => { i.actions = { enabled: false }; }, 'Actions'],
    ['actions', (i) => { i.actions = null; i.actionsError = 'HTTP 403'; }, 'Actions'],
    ['ruleset', (i) => { i.rules = []; }, 'Include by pattern > milestone/*'],
    ['ruleset', (i) => { i.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }]; }, 'sample-ci'],
    ['ruleset', (i) => { i.rules = null; i.rulesError = 'HTTP 404'; }, '--seed-only'],
  ];
  for (const [id, mutate, mention] of cases) {
    const input = goodInput(); mutate(input);
    const r = L.evaluatePreflight(input, 'o/r');
    assert(!r.ok, `${id} should fail`);
    const p = r.problems.find((x) => x.id === id);
    assert(p, `problem ${id} reported, got ${r.problems.map((x) => x.id)}`);
    assert((p.message + p.steps).includes(mention), `${id} text mentions ${mention}: ${p.message} / ${p.steps}`);
  }
});

test('ci-wait-live preflight: --seed-only does not need the ruleset or auto-merge', () => {
  const input = goodInput(); input.rules = []; input.repo.allow_auto_merge = false; input.seedOnly = true;
  const r = L.evaluatePreflight(input, 'o/r');
  assert(r.ok, JSON.stringify(r.problems));
  assert(r.checks.some((c) => /allow_auto_merge/.test(c.name) && /full run needs it/.test(c.detail)), 'auto-merge noted');
  input.repo = null; input.repoError = 'x';
  assert(!L.evaluatePreflight(input, 'o/r').ok, 'an unreachable repo still fails');
});

test('ci-wait-live preflight: the required checks are read from every status-check rule', () => {
  nodeAssert.deepStrictEqual(L.requiredChecksIn(goodInput().rules), ['other', 'sample-ci']);
  nodeAssert.deepStrictEqual(L.requiredChecksIn(null), []);
  nodeAssert.deepStrictEqual(L.requiredChecksIn([{ type: 'required_status_checks' }, { type: 'required_status_checks', parameters: {} }]), []);
});

// ---- reviews, merges, milestone timing ----
test('ci-wait-live reviews: ci values counted; a pending review is a timeout only with a stated wait of 8+ minutes', () => {
  eq(L.waitedMinutes('waited 9 minutes for the sample-ci check'), 9, 'minutes');
  eq(L.waitedMinutes('timed out after 540s'), 9, 'seconds');
  eq(L.waitedMinutes('still pending'), null, 'no time stated');
  eq(L.waitedMinutes(''), null, 'empty');
  eq(L.waitedMinutes(undefined), null, 'undefined');
  const rs = L.reviewStats([
    { ci: 'green', summary: 'ok' },
    { ci: 'pending', task_id: 'T-1', summary: 'CI was still pending' },
    { ci: 'pending', task_id: 'T-2', summary: 'waited 9 min, check still pending (timeout)' },
    { ci: 'pending', task_id: 'T-3', summary: 'waited 3 min' },
    { summary: 'no ci field' },
  ]);
  eq(rs.total, 5, 'total');
  nodeAssert.deepStrictEqual(rs.byCi, { green: 1, pending: 3, '(missing)': 1 });
  nodeAssert.deepStrictEqual(rs.pending.map((p) => [p.task, p.statesTimeWaited, p.timeout]), [['T-1', false, false], ['T-2', true, true], ['T-3', true, false]]);
  nodeAssert.deepStrictEqual(L.reviewStats([]), { total: 0, byCi: {}, pending: [] });
  nodeAssert.deepStrictEqual(L.reviewStats(null), { total: 0, byCi: {}, pending: [] });
});

test('ci-wait-live merges: a queued line is resolved only by a later line for the same PR', () => {
  const q = (pr) => ({ pr, outcome: 'auto-merge-queued' });
  const st = L.mergesStats([q('5'), { pr: '6', outcome: 'merged' }, q('7'), { pr: '5', outcome: 'merged' }, { pr: '8', outcome: 'merged' }, q('8')]);
  eq(st.queued, 3, 'queued lines');
  nodeAssert.deepStrictEqual(st.unresolved, ['7', '8']);   // 5 resolved later; 8's "merged" came BEFORE its queue line
  eq(L.mergesStats([q('9'), { pr: '9', outcome: 'auto-merge-cancelled' }]).unresolved.length, 0, 'cancelled resolves');
  eq(L.mergesStats([q('9'), { pr: '9', outcome: 'closed' }]).unresolved.length, 0, 'closed resolves');
  eq(L.mergesStats([q('9'), { pr: '9', outcome: 'not-merged' }]).unresolved.length, 1, 'not-merged does not');
  nodeAssert.deepStrictEqual(L.mergesStats([]), { total: 0, outcomes: {}, queued: 0, unresolved: [] });
});

test('ci-wait-live milestone: "complete" printed before the checks finished is flagged', () => {
  const done = (t) => ({ __typename: 'CheckRun', name: 'sample-ci', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: t });
  const running = { __typename: 'CheckRun', name: 'sample-ci', status: 'IN_PROGRESS', conclusion: '', completedAt: '0001-01-01T00:00:00Z' };
  const T0 = Date.parse('2026-11-12T01:30:00Z');
  const complete = { status: 'complete', pr: 9, ci: 'green' };
  const after = L.milestoneTiming(complete, T0 + 30000, [done('2026-11-12T01:30:00Z')]);
  eq(after.completeBeforeChecksFinished, false, 'printed 30 s after the check finished');
  assert(/after the last check finished/.test(after.detail), after.detail);
  const before = L.milestoneTiming(complete, T0 - 20000, [done('2026-11-12T01:30:00Z')]);
  eq(before.completeBeforeChecksFinished, true, 'printed 20 s before it finished');
  assert(/20s before/.test(before.detail), before.detail);
  const pending = L.milestoneTiming(complete, T0 + 99999, [running]);
  eq(pending.completeBeforeChecksFinished, true, 'still running now');
  eq(pending.checks.finishedAtMs, null, 'an unfinished check has no finish time');
  eq(L.milestoneTiming(complete, T0, []).completeBeforeChecksFinished, true, 'no checks at all');
  eq(L.milestoneTiming({ status: 'incomplete', pr: 9, ci: 'pending' }, T0, [running]).completeBeforeChecksFinished, false, 'incomplete is never early');
  eq(L.milestoneTiming(null, null, [running]).completeBeforeChecksFinished, false, 'no report');
  // a finished check without a usable time cannot prove "early"
  eq(L.milestoneTiming(complete, T0, [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '0001-01-01T00:00:00Z' }]).completeBeforeChecksFinished, false, 'zero time ignored');
  eq(L.checksFinished([done('2026-11-12T01:30:00Z'), { __typename: 'StatusContext', state: 'SUCCESS' }]).finishedAtMs, T0, 'status contexts have no time and are ignored for it');
  eq(L.checksFinished([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-11-12T01:30:00Z' }]).failed, 1, 'failed counted');
});

test('ci-wait-live targets: PASS, FAIL and N/A come out of the metrics', () => {
  const summary = (fg, byPr, unattributed) => ({ watch: { foreground: fg, background: 1 }, ci: { byPr, unattributed: { turns: unattributed || 0, contextTokens: 0 } } });
  const quiet = { total: 3, byCi: { green: 3 }, pending: [] };
  const okMs = { reported: { status: 'complete' }, completeBeforeChecksFinished: false, detail: 'fine' };
  const good = L.evaluateTargets({ summary: summary(0, { 4: { turns: 1 }, 5: { turns: 1 } }), taskPrs: ['4', '5'], reviews: quiet, milestone: okMs });
  nodeAssert.deepStrictEqual(good.map((t) => t.result), ['PASS', 'PASS', 'PASS', 'PASS']);
  const bad = L.evaluateTargets({ summary: summary(2, { 4: { turns: 3 } }, 2), taskPrs: ['4', '5'],
    reviews: { total: 2, byCi: { pending: 1 }, pending: [{ statesTimeWaited: false, waitedMinutes: null, timeout: false }] },
    milestone: { reported: { status: 'complete' }, completeBeforeChecksFinished: true, detail: 'early' } });
  nodeAssert.deepStrictEqual(bad.map((t) => t.result), ['FAIL', 'FAIL', 'FAIL', 'FAIL']);
  assert(/#4: 3/.test(bad[1].detail) && /#5: 0/.test(bad[1].detail) && /2 CI turn/.test(bad[1].detail), bad[1].detail);
  const none = L.evaluateTargets({ summary: summary(0, {}), taskPrs: [], reviews: { total: 0, byCi: {}, pending: [{ timeout: true, waitedMinutes: 9 }] }, milestone: { reported: null, completeBeforeChecksFinished: false, detail: 'none' } });
  nodeAssert.deepStrictEqual(none.map((t) => t.result), ['PASS', 'N/A', 'PASS', 'N/A']);
  assert(L.renderTable(good).split('\n').length === 4, 'one row per target');
});

// ---- secrets ----
test('ci-wait-live redact: known token shapes and listed secrets are gone from the serialized output', () => {
  const secret = 'rt-0123456789abcdefghijklmnop';
  const tokens = ['ghp_' + 'a'.repeat(30), 'github_pat_' + 'B'.repeat(30), 'sk-' + 'c'.repeat(30)];
  const report = { director: { stderrTail: `auth failed for ${tokens[0]} and Bearer ${'z'.repeat(30)}` }, cmd: `export K=${tokens[1]} ${tokens[2]}`,
    file: JSON.stringify({ access_token: 'x'.repeat(40), refresh_token: secret }), plain: `refresh ${secret}` };
  const out = L.redact(JSON.stringify(report, null, 2), [secret]);
  for (const t of [...tokens, secret, 'x'.repeat(40), 'z'.repeat(30)]) assert(!out.includes(t), `secret leaked: ${t.slice(0, 8)}...`);
  assert(out.includes('[redacted]'), 'redaction marker present');
  assert(out.includes('auth failed for'), 'surrounding text kept');
  nodeAssert.deepStrictEqual(L.secretsFromJson(JSON.stringify({ a: { tokens: ['short', 'xxxxx'], id_token: 'q'.repeat(25) } })), ['q'.repeat(25)]);
  nodeAssert.deepStrictEqual(L.secretsFromJson('not json'), []);
  eq(L.redact('short', ['abc']), 'short', 'a secret under 8 characters is not applied (too likely to mangle)');
});

// ---- the Director's prompt ----
test('ci-wait-live prompt: version-neutral, fixed three-task plan, every name carries the run prefix', () => {
  for (const tool of ['claude', 'codex']) {
    const p = L.directorPrompt(tool, RUN);
    assert(!/ci-wait|auto-merge|--auto|watch|background|wait|poll|checks/i.test(p.replace(/"ci":"<the state of that PR's checks[^"]*"/, '')), `prompt must not steer CI behaviour (${tool})`);
    for (const n of [1, 2, 3]) assert(p.includes(`${RUN}-${n}:`), `task ${n} id`);
    assert(/small tier/.test(p) && /architect/.test(p) && /approved everything/.test(p), 'fixed plan, small tier, user approval');
    assert(/milestone-json \{"status":/.test(p) && /open the milestone PR/.test(p), 'final line and milestone PR');
    assert(p.includes(tool === 'codex' ? '$agent-team:milestone' : '(agent-team:milestone)'), 'skill invocation form');
  }
  assert(!L.smokePrompt().includes('agent-team'), 'smoke prompt is not a milestone');
});

// ---- the fixture ----
test('ci-wait-live fixture: sample-ci workflow, pinned actions, no dependencies, team-init files', () => {
  const wf = fs.readFileSync(path.join(FIXTURE, '.github', 'workflows', 'sample-ci.yml'), 'utf8');
  assert(/^\s{2}sample-ci:\s*$/m.test(wf) && /name: sample-ci\s*$/m.test(wf), 'job and check name sample-ci');
  assert(/^on:\s*\n\s+pull_request:\s*\n\s+push:\s*\n\s+branches: \['milestone\/\*\*'\]/m.test(wf), 'pull_request (any base) and push to milestone/**');
  assert(!/pull_request:\s*\n\s+branches/.test(wf), 'pull_request has no base filter');
  assert(/run: npm test/.test(wf) && /run: sleep \d+/.test(wf), 'runs the tests and sleeps');
  const uses = wf.split('\n').filter((l) => /\buses:/.test(l));
  assert(uses.length >= 2, 'uses actions');
  for (const u of uses) assert(/@[0-9a-f]{40}\s+#\s*v\d/.test(u), `pinned by SHA: ${u.trim()}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8'));
  assert(!pkg.dependencies && !pkg.devDependencies, 'no dependencies');
  eq(pkg.scripts.test, 'node --test', 'test script');
  for (const f of ['STATUS.md', 'docs/decisions/0000-template.md', '.gitignore', 'CLAUDE.md', 'AGENTS.md', 'src/index.js', 'test/smoke.test.js']) assert(fs.existsSync(path.join(FIXTURE, f)), `fixture has ${f}`);
  const ig = fs.readFileSync(path.join(FIXTURE, '.gitignore'), 'utf8');
  for (const line of ['.agent-team/logs/*', '!.agent-team/logs/.gitkeep', '.agent-team/worktrees/', '.claude/worktrees/', '.codex/agents/*-small.toml']) assert(ig.split('\n').includes(line), `gitignore has ${line}`);
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const t = fs.readFileSync(path.join(FIXTURE, f), 'utf8');
    assert(/^## Agent team \(Director pattern\)/m.test(t) && /Standing authorization/.test(t), `${f} has the agent-team section`);
    assert(!/<fill in>/.test(t) && /npm test/.test(t) && /sample-ci/.test(t), `${f} specifics are filled in`);
  }
  assert(!/ci-wait|auto-merge/i.test(fs.readFileSync(path.join(FIXTURE, 'CLAUDE.md'), 'utf8')), 'fixture CLAUDE.md is version-neutral');
});

test('ci-wait-live: the live harness is not picked up by tests/run.js', () => {
  const picked = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'));
  assert(!picked.some((f) => /ci-wait-live\.js/.test(f)), 'run.js only loads tests/*.test.js');
  assert(!fs.readdirSync(LIVE).some((f) => f.endsWith('.test.js')), 'no .test.js in tests/live');
});

// ---- the harness against a stand-in gh and a local bare repo ----
// The fake `gh` answers what --seed-only and --cleanup-run ask, keeps its state in a bare
// repo (branches) and a JSON file (the seed PR), and records every call.
const FAKE = `
const fs = require('fs');
const cp = require('child_process');
const a = process.argv.slice(2);
const E = process.env;
fs.appendFileSync(E.FAKE_CALLS, JSON.stringify(a) + '\\n');
const out = (s) => { process.stdout.write(typeof s === 'string' ? s : JSON.stringify(s)); process.exit(0); };
const git = (args, cwd) => cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
const state = () => { try { return JSON.parse(fs.readFileSync(E.FAKE_STATE, 'utf8')); } catch (e) { return { prs: [] }; } };
const has = (x) => a.includes(x);
if (a[0] === '--version') out('gh fake');
if (a[0] === 'auth') out('ok');
if (a[0] === 'api' && a[1] === 'repos/o/r' && has('--jq')) out('main');
if (a[0] === 'api' && a[1] === 'repos/o/r') out({ private: true, default_branch: 'main', permissions: { push: true }, allow_auto_merge: true, allow_squash_merge: true });
if (a[0] === 'api' && a[1] === 'repos/o/r/actions/permissions') out({ enabled: true });
if (a[0] === 'api' && /rules\\/branches/.test(a[1])) out([]);
if (a[0] === 'repo' && a[1] === 'clone') { const r = git(['clone', '-q', E.FAKE_BARE, a[3]]); process.exit(r.status); }
if (a[0] === 'pr' && a[1] === 'create') {
  const s = state(); const n = 7 + s.prs.length;
  s.prs.push({ number: n, title: a[a.indexOf('--title') + 1], headRefName: a[a.indexOf('--head') + 1], open: true });
  fs.writeFileSync(E.FAKE_STATE, JSON.stringify(s));
  out('https://github.com/o/r/pull/' + n + '\\n');
}
if (a[0] === 'pr' && a[1] === 'checks') out(E.FAKE_CHECKS || '[]');
if (a[0] === 'pr' && a[1] === 'list') {
  if (E.FAKE_LIST_FAIL) { process.stderr.write('boom'); process.exit(1); }
  out(state().prs.filter((p) => p.open).concat(JSON.parse(E.FAKE_EXTRA_PRS || '[]')));
}
if (a[0] === 'pr' && a[1] === 'close') { const s = state(); s.prs.forEach((p) => { if (String(p.number) === a[2]) p.open = false; }); fs.writeFileSync(E.FAKE_STATE, JSON.stringify(s)); out(''); }
if (a[0] === 'issue' && a[1] === 'list') out(JSON.parse(E.FAKE_ISSUES || '[]'));
if (a[0] === 'issue' && a[1] === 'close') out('');
if (a[0] === 'api' && a[1] === 'repos/o/r/branches') out(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], E.FAKE_BARE).stdout);
if (a[0] === 'api' && has('DELETE')) { const ref = decodeURIComponent(a[a.length - 1].replace('repos/o/r/git/', '')); git(['update-ref', '-d', ref], E.FAKE_BARE); out(''); }
if (a[0] === 'pr' && a[1] === 'merge') {
  if (E.FAKE_MERGE_FAIL) { process.stderr.write('Pull request is not in the correct state to enable auto-merge'); process.exit(1); }
  const s = state(); s.queued = a[a.indexOf('--match-head-commit') + 1]; s.mergeArgs = a.slice(2); fs.writeFileSync(E.FAKE_STATE, JSON.stringify(s)); out('');
}
if (a[0] === 'pr' && a[1] === 'view') {
  const s = state(); const p = s.prs.find((x) => String(x.number) === a[2]) || {};
  const head = git(['rev-parse', 'refs/heads/' + p.headRefName], E.FAKE_BARE).stdout.trim();
  const moved = !!s.queued && head !== s.queued;
  out({ state: E.FAKE_PROBE === 'merge-anyway' && moved ? 'MERGED' : 'OPEN', autoMergeRequest: s.queued ? { enabledBy: 'x' } : null, headRefOid: head, mergedAt: null });
}
process.stderr.write('fake gh: unexpected call ' + a.join(' '));
process.exit(9);
`;

function harnessEnv(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwlive-'));
  const fake = path.join(dir, 'fake-gh.js');
  fs.writeFileSync(fake, FAKE);
  const bare = path.join(dir, 'origin.git');
  const sh = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); };
  sh(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = path.join(dir, 'seed');
  sh(dir, ['clone', '-q', bare, seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), 'scratch\n');
  sh(seed, ['add', 'README.md']);
  sh(seed, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']);
  sh(seed, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  sh(seed, ['push', '-q', 'origin', `HEAD:refs/heads/milestone/${OTHER_RUN}`]);        // another run's branch: must survive
  const env = Object.assign({}, process.env, {
    CI_WAIT_LIVE_FAKE_GH: fake, FAKE_CALLS: path.join(dir, 'calls.jsonl'), FAKE_STATE: path.join(dir, 'state.json'), FAKE_BARE: bare,
    AGENT_TEAM_LIVE_TMP: path.join(dir, 'tmp'), FAKE_ISSUES: '[]',
  }, extra);
  return { dir, env, bare, tmpBase: path.join(dir, 'tmp'), outDir: path.join(dir, 'out'),
    calls: () => { try { return fs.readFileSync(env.FAKE_CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } },
    branches: () => spawnSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: bare, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort() };
}
const isMutation = (c) => (c[0] === 'pr' && c[1] === 'close') || (c[0] === 'issue' && c[1] === 'close') || (c[0] === 'api' && c.includes('DELETE'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
const harness = (h, args, extra) => spawnSync(process.execPath, [HARNESS, ...args], { env: Object.assign({}, h.env, extra), encoding: 'utf8', timeout: 120000 });

test('ci-wait-live cleanup-run --dry-run lists this run\'s items and changes nothing', () => {
  const h = harnessEnv({ FAKE_ISSUES: JSON.stringify(listing().issues), FAKE_EXTRA_PRS: JSON.stringify(listing().prs) });
  try {
    const r = harness(h, ['--repo', 'o/r', '--cleanup-run', RUN, '--dry-run']);
    eq(r.status, 0, `exit (stderr: ${r.stderr})`);
    // the bare repo holds only main and another run's branch, so no branch is selected
    assert(/cleanup \(dry run\) would handle for .*: 4 PR\(s\), 2 issue\(s\), 0 branch\(es\)/.test(r.stdout), r.stdout);
    const calls = h.calls();
    assert(calls.some((c) => c[0] === 'pr' && c[1] === 'list'), 'precondition: it did list the repo');
    eq(calls.filter(isMutation).length, 0, 'no close and no delete in a dry run');
  } finally { rm(h.dir); }
});

test('ci-wait-live cleanup-run closes and deletes exactly this run\'s items; another run\'s branch survives', () => {
  const h = harnessEnv({ FAKE_ISSUES: JSON.stringify(listing().issues), FAKE_EXTRA_PRS: JSON.stringify(listing().prs) });
  try {
    spawnSync('git', ['update-ref', `refs/heads/task/${RUN}-1`, 'refs/heads/main'], { cwd: h.bare });
    spawnSync('git', ['update-ref', `refs/heads/${RUN}-seed`, 'refs/heads/main'], { cwd: h.bare });
    spawnSync('git', ['update-ref', 'refs/heads/feature/x', 'refs/heads/main'], { cwd: h.bare });
    const before = h.branches();
    assert(before.includes(`task/${RUN}-1`) && before.includes(`milestone/${OTHER_RUN}`), `precondition: branches exist (${before})`);
    const r = harness(h, ['--repo', 'o/r', '--cleanup-run', RUN]);
    eq(r.status, 0, `exit (stderr: ${r.stderr})`);
    const muts = h.calls().filter(isMutation).map((c) => c.filter((x) => x !== '--repo' && x !== 'o/r').join(' '));
    nodeAssert.deepStrictEqual(muts.filter((m) => m.startsWith('pr close')).sort(), ['pr close 1', 'pr close 2', 'pr close 5', 'pr close 7']);
    nodeAssert.deepStrictEqual(muts.filter((m) => m.startsWith('issue close')).map((m) => m.split(' ')[2]).sort(), ['10', '11']);
    nodeAssert.deepStrictEqual(h.branches(), ['feature/x', 'main', `milestone/${OTHER_RUN}`]);
  } finally { rm(h.dir); }
});

test('ci-wait-live cleanup-run: a failed listing closes and deletes nothing, and says so', () => {
  const h = harnessEnv({ FAKE_LIST_FAIL: '1' });
  try {
    const r = harness(h, ['--repo', 'o/r', '--cleanup-run', RUN]);
    eq(r.status, 1, 'exit 1');
    assert(/could not list the repo/.test(r.stdout), r.stdout);
    assert(h.calls().some((c) => c[0] === 'pr' && c[1] === 'list'), 'precondition: the listing was attempted');
    eq(h.calls().filter(isMutation).length, 0, 'nothing touched');
  } finally { rm(h.dir); }
});

test('ci-wait-live: bad arguments exit 2 with the usage', () => {
  const r = spawnSync(process.execPath, [HARNESS, '--repo', 'o/r'], { encoding: 'utf8', timeout: 30000 });
  eq(r.status, 2, 'exit 2');
  assert(/--tool claude\|codex is required/.test(r.stdout) && /Exit codes:/.test(r.stdout), r.stdout);
});

test('ci-wait-live --seed-only: failure path (the seed check fails) cleans up its branch and PR, exit 1', () => {
  const h = harnessEnv({ FAKE_CHECKS: JSON.stringify([{ name: 'sample-ci', bucket: 'fail', startedAt: '', completedAt: '' }]) });
  try {
    const r = harness(h, ['--repo', 'o/r', '--seed-only', '--out-dir', h.outDir, '--label', 'f']);
    eq(r.status, 1, `exit 1 on a harness error (stdout: ${r.stdout.slice(-400)})`);
    const calls = h.calls();
    // Trigger and precondition: the seed branch was pushed and its PR opened before the check failed.
    assert(calls.some((c) => c[0] === 'pr' && c[1] === 'create'), 'precondition: the seed PR was opened');
    assert(/the seed PR check failed/.test(r.stdout), r.stdout);
    // Postcondition: only this run's branch is gone; main and the other run's branch stay.
    nodeAssert.deepStrictEqual(h.branches(), ['main', `milestone/${OTHER_RUN}`]);
    assert(calls.some((c) => c[0] === 'pr' && c[1] === 'close'), 'the seed PR was closed');
    assert(!fs.existsSync(h.tmpBase), 'temp folder removed');
    const json = fs.readdirSync(h.outDir).find((f) => f.endsWith('-f.json'));
    assert(json, 'the report was still written');
    assert(JSON.parse(fs.readFileSync(path.join(h.outDir, json), 'utf8')).errors.length === 1, 'the error is in the report');
  } finally { rm(h.dir); }
});

test('ci-wait-live --seed-only: recovery control, a passing check ends with exit 0 and the same cleanup', () => {
  const h = harnessEnv({ FAKE_CHECKS: JSON.stringify([{ name: 'sample-ci', bucket: 'pass', startedAt: '2026-11-12T01:00:00Z', completedAt: '2026-11-12T01:01:48Z' }]) });
  try {
    const r = harness(h, ['--repo', 'o/r', '--seed-only', '--out-dir', h.outDir, '--label', 'ok']);
    eq(r.status, 0, `exit 0 (stdout: ${r.stdout.slice(-500)})`);
    assert(/sample-ci ran green in/.test(r.stdout) && /job 108s/.test(r.stdout), r.stdout);
    nodeAssert.deepStrictEqual(h.branches(), ['main', `milestone/${OTHER_RUN}`]);
    assert(!fs.existsSync(h.tmpBase), 'temp folder removed');
    const json = JSON.parse(fs.readFileSync(path.join(h.outDir, fs.readdirSync(h.outDir).find((f) => f.endsWith('-ok.json'))), 'utf8'));
    eq(json.seed.check.state, 'pass', 'seed check state');
    eq(json.errors.length, 0, 'no errors');
  } finally { rm(h.dir); }
});

test('ci-wait-live --seed-only --keep leaves the branch and the temp folder, and says how to clean up', () => {
  const h = harnessEnv({ FAKE_CHECKS: JSON.stringify([{ name: 'sample-ci', bucket: 'pass', startedAt: '', completedAt: '' }]) });
  try {
    const r = harness(h, ['--repo', 'o/r', '--seed-only', '--keep', '--out-dir', h.outDir]);
    eq(r.status, 0, `exit 0 (${r.stdout.slice(-300)})`);
    assert(h.branches().some((b) => b.endsWith('-seed')), 'seed branch kept');
    assert(/--cleanup-run live-\d{8}t\d{6}-claude/.test(r.stdout), 'tells how to clean up later');
    assert(fs.existsSync(h.tmpBase), 'temp folder kept');
  } finally { rm(h.dir); }
});

// Windows delivers no SIGTERM to a Node process (it just ends it), so this runs elsewhere only.
if (process.platform !== 'win32') {
  test('ci-wait-live: SIGTERM mid-run cleans up its own branch and PR, exit 130', () => {
    const h = harnessEnv({ FAKE_CHECKS: '[]' });     // checks never appear: the harness is waiting when the signal lands
    const driver = path.join(h.dir, 'driver.js');
    fs.writeFileSync(driver, `
      const { spawn } = require('child_process'); const fs = require('fs');
      const p = spawn(process.execPath, [${JSON.stringify(HARNESS)}, '--repo', 'o/r', '--seed-only', '--out-dir', ${JSON.stringify(h.outDir)}], { env: process.env });
      let out = ''; p.stdout.on('data', (d) => { out += d; });
      const t0 = Date.now();
      const poll = setInterval(() => {
        const calls = fs.existsSync(process.env.FAKE_CALLS) ? fs.readFileSync(process.env.FAKE_CALLS, 'utf8') : '';
        if (/"pr","checks"/.test(calls)) { clearInterval(poll); p.kill('SIGTERM'); }
        else if (Date.now() - t0 > 60000) { clearInterval(poll); p.kill('SIGKILL'); }
      }, 200);
      p.on('close', (code, sig) => { process.stdout.write(JSON.stringify({ code, sig, out })); });
    `);
    try {
      const r = spawnSync(process.execPath, [driver], { env: h.env, encoding: 'utf8', timeout: 90000 });
      const res = JSON.parse(r.stdout);
      assert(h.calls().some((c) => c[0] === 'pr' && c[1] === 'checks'), 'precondition: the harness was waiting for checks');
      eq(res.code, 130, `exit 130 (out: ${res.out.slice(-300)})`);
      assert(/interrupted \(SIGTERM\)/.test(res.out), res.out);
      nodeAssert.deepStrictEqual(h.branches(), ['main', `milestone/${OTHER_RUN}`]);
      assert(h.calls().some((c) => c[0] === 'pr' && c[1] === 'close'), 'its PR was closed');
      assert(!fs.existsSync(h.tmpBase), 'temp folder removed');
      // One step past the signal: nothing keeps polling or touching the repo afterwards.
      const n = h.calls().length;
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 1500)']);
      eq(h.calls().length, n, 'no further gh calls after the cleanup');
    } finally { rm(h.dir); }
  });
}

// ---- --probe-auto-head: queue auto-merge at a SHA, push another commit, see whether it merged ----
function probe(extra) {
  const h = harnessEnv(Object.assign({ FAKE_CHECKS: JSON.stringify([{ name: 'sample-ci', bucket: 'pass', startedAt: '', completedAt: '' }]),
    CI_WAIT_LIVE_POLL_MS: '40', CI_WAIT_LIVE_GRACE_MS: '300' }, extra));
  const sh = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  sh(h.bare, ['update-ref', `refs/heads/milestone/${RUN}`, 'refs/heads/main']);
  const clone = path.join(h.dir, 'pclone');
  sh(h.dir, ['clone', '-q', h.bare, clone]);
  sh(clone, ['config', 'user.name', 't']); sh(clone, ['config', 'user.email', 't@example.invalid']);
  const driver = path.join(h.dir, 'probe-driver.js');
  fs.writeFileSync(driver, `
    const h = require(${JSON.stringify(HARNESS)});
    h.S.run = ${JSON.stringify(RUN)}; h.S.defaultBranch = 'main';
    h.probeAutoHead({ repo: 'o/r' }, ${JSON.stringify(clone)}).then((r) => process.stdout.write(JSON.stringify(r)));
  `);
  const r = spawnSync(process.execPath, [driver], { env: h.env, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`driver failed: ${r.stderr}${r.stdout}`);
  const head = sh(h.bare, ['rev-parse', `refs/heads/${RUN}-probe`]);
  return { h, res: JSON.parse(r.stdout), head, state: JSON.parse(fs.readFileSync(h.env.FAKE_STATE, 'utf8')), calls: h.calls() };
}

test('ci-wait-live probe: merged after the head moved is reported as merged-anyway', () => {
  const p = probe({ FAKE_PROBE: 'merge-anyway' });
  try {
    // Precondition: the merge was queued at sha1 with --match-head-commit, and a second commit moved the head.
    eq(p.state.queued, p.res.sha1, 'auto-merge was queued at the first commit');
    assert(p.calls.some((c) => c[0] === 'pr' && c[1] === 'merge' && c.includes('--auto') && c.includes('--squash') && c.includes('--match-head-commit')), 'queued with --auto --squash --match-head-commit');
    assert(p.res.sha2 && p.res.sha2 !== p.res.sha1 && p.head === p.res.sha2, 'the head moved to a second commit after queueing');
    eq(p.res.result, 'merged-anyway', 'result');
    eq(p.res.mergedWithMovedHead, true, 'moved head');
    eq(p.res.queued, true, 'queued flag');
  } finally { rm(p.h.dir); }
});

test('ci-wait-live probe: still open after the checks went green is reported as held', () => {
  const p = probe({ FAKE_PROBE: 'held' });
  try {
    assert(p.res.sha2 && p.head === p.res.sha2, 'precondition: the head moved');
    eq(p.res.result, 'held', 'result');
    eq(p.res.state, 'OPEN', 'state');
    eq(p.res.mergedAnyway, false, 'not merged');
  } finally { rm(p.h.dir); }
});

test('ci-wait-live probe: when auto-merge cannot be queued it is inconclusive and nothing more is pushed', () => {
  const p = probe({ FAKE_MERGE_FAIL: '1' });
  try {
    eq(p.res.result, 'inconclusive', 'result');
    assert(/could not queue auto-merge: Pull request is not in the correct state/.test(p.res.reason), p.res.reason);
    eq(p.head, p.res.sha1, 'no second commit was pushed');
    assert(!p.calls.some((c) => c[0] === 'pr' && c[1] === 'checks'), 'it did not go on to wait for checks');
  } finally { rm(p.h.dir); }
});
