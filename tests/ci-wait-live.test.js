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
const RUN = 'live-20261112t012548-claude-a1b2';
const SIBLING = 'live-20261112t012548-claude-c3d4';   // same tool, same second, other random part
const OTHER_TOOL = 'live-20261112t012548-codex-a1b2';
const OTHER_RUN = 'live-20261111t000000-claude-9f3e';

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
  assert(L.parseArgs(['--repo', 'o/r', '--cleanup-run', 'live-20261112t012548-claude']).error, 'a prefix without the random part is refused');
  assert(L.parseArgs(['--repo', 'o/r', '--cleanup-run', 'live-20261112t012548-claude-a1b']).error, 'a short random part is refused');
  assert(L.parseArgs(['--tool', 'claude', '--repo', 'o/r', '--plugin', 'p', '--label', 'x', '--dry-run']).error.includes('--cleanup-run'), '--dry-run alone');
});

test('ci-wait-live args: --preflight-only needs only a repo and cannot be mixed with --cleanup-run', () => {
  const p = L.parseArgs(['--repo', 'o/r', '--preflight-only']);
  eq(p.error, undefined, 'valid without tool, plugin or label');
  eq(p.opts.preflightOnly, true, 'flag set');
  assert(L.parseArgs(['--preflight-only']).error.includes('--repo'), 'still needs --repo');
  assert(L.parseArgs(['--repo', 'o/r', '--preflight-only', '--cleanup-run', RUN]).error.includes('cannot be combined'), 'with --cleanup-run');
  assert(L.parseArgs(['--repo', 'o/r', '--preflight-only', '--dry-run']).error.includes('--cleanup-run'), '--dry-run alone');
  eq(L.parseArgs(['--repo', 'o/r']).error.includes('--tool'), true, 'a plain run still needs a tool');
});

test('ci-wait-live: the run prefix differs per second, per tool and per random part, and matches RUN_RE', () => {
  const d = new Date('2026-11-12T01:25:48.999Z');
  eq(L.runPrefix('claude', d, 'a1b2'), RUN, 'prefix');
  assert(L.RUN_RE.test(L.runPrefix('codex', d)), 'codex prefix matches');
  assert(L.RUN_RE.test(L.runPrefix('claude', d)), 'a generated random part matches');
  assert(L.runPrefix('claude', d, 'a1b2') !== L.runPrefix('claude', new Date('2026-11-12T01:25:49Z'), 'a1b2'), 'next second differs');
  assert(L.runPrefix('claude', d, 'a1b2') !== L.runPrefix('codex', d, 'a1b2'), 'tools differ');
  // two runs of the same tool in the same second differ by the random part (16 draws, 65536 values)
  const seen = new Set(Array.from({ length: 16 }, () => L.runPrefix('claude', d)));
  assert(seen.size > 1, 'the random part varies between calls');
});

test('ci-wait-live cleanup: a run in the same second with the same tool does not touch this one, and vice versa', () => {
  const l = {
    branches: [`milestone/${RUN}`, `task/${RUN}-1`, `milestone/${SIBLING}`, `task/${SIBLING}-1`, `${SIBLING}-seed`],
    prs: [{ number: 1, title: `${RUN} seed`, headRefName: `${RUN}-seed` }, { number: 2, title: `${SIBLING}-1: x`, headRefName: `task/${SIBLING}-1` }],
    issues: [{ number: 3, title: `${RUN}: m`, body: '' }, { number: 4, title: `${SIBLING}: m`, body: `${SIBLING}-1` }],
  };
  nodeAssert.deepStrictEqual(L.selectCleanup(l, RUN, 'main'), { branches: [`milestone/${RUN}`, `task/${RUN}-1`], prs: [1], issues: [3] });
  nodeAssert.deepStrictEqual(L.selectCleanup(l, SIBLING, 'main'), { branches: [`milestone/${SIBLING}`, `task/${SIBLING}-1`, `${SIBLING}-seed`], prs: [2], issues: [4] });
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
  eq(before.marginSeconds, -20, 'margin is reported (negative: printed before the finish)');
  eq(after.marginSeconds, 30, 'margin is reported (positive: printed after the finish)');
  assert(/margin 30s/.test(after.detail) && /margin -20s/.test(before.detail), 'margin shows in the verdict text');
  // clock tolerance: only a clear gap is flagged (10 s)
  const at = (s) => L.milestoneTiming(complete, T0 + s * 1000, [done('2026-11-12T01:30:00Z')]);
  eq(at(-5).completeBeforeChecksFinished, false, '5 s early is within the tolerance');
  assert(/within the 10s clock tolerance/.test(at(-5).detail), at(-5).detail);
  eq(at(-10).completeBeforeChecksFinished, false, 'exactly 10 s early is not flagged');
  eq(at(-11).completeBeforeChecksFinished, true, '11 s early is flagged');
  eq(at(-11).marginSeconds, -11, 'margin of the flagged case');
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
  // reads: no-PR CI turns that are real CI looks; reconcile: no-PR reconcile-only checkpoints
  const summary = (fg, byPr, reads, reconcile) => ({ watch: { foreground: fg, background: 1 }, ci: { byPr,
    unattributed: { turns: (reads || 0) + (reconcile || 0), contextTokens: 0 },
    noPr: { reconcile: { turns: reconcile || 0, contextTokens: 0 }, reads: { turns: reads || 0, contextTokens: 0 } } } });
  const quiet = { total: 3, byCi: { green: 3 }, pending: [] };
  const okMs = { reported: { status: 'complete' }, completeBeforeChecksFinished: false, detail: 'fine' };
  const good = L.evaluateTargets({ summary: summary(0, { 4: { turns: 1 }, 5: { turns: 1 } }), taskPrs: ['4', '5'], reviews: quiet, milestone: okMs });
  nodeAssert.deepStrictEqual(good.map((t) => t.result), ['PASS', 'PASS', 'PASS', 'PASS']);
  const bad = L.evaluateTargets({ summary: summary(2, { 4: { turns: 3 } }, 2), taskPrs: ['4', '5'],
    reviews: { total: 2, byCi: { pending: 1 }, pending: [{ statesTimeWaited: false, waitedMinutes: null, timeout: false }] },
    milestone: { reported: { status: 'complete' }, completeBeforeChecksFinished: true, detail: 'early' } });
  nodeAssert.deepStrictEqual(bad.map((t) => t.result), ['FAIL', 'FAIL', 'FAIL', 'FAIL']);
  assert(/#4: 3/.test(bad[1].detail) && /#5: 0/.test(bad[1].detail) && /2 unattributed CI read\(s\) name no PR and are charged to the total \(5 for 2 task PR\(s\)\)/.test(bad[1].detail), bad[1].detail);
  // Reconcile-only no-PR turns are reported, not charged to a task PR. Other no-PR CI turns are real CI looks and are charged.
  const perPrOk = { 4: { turns: 1 }, 5: { turns: 1 } };
  const pick = (s) => L.evaluateTargets({ summary: s, taskPrs: ['4', '5'], reviews: quiet, milestone: okMs })[1];
  eq(pick(summary(0, perPrOk, 0, 0)).result, 'PASS', '1 turn each');
  eq(pick(summary(0, perPrOk, 0, 6)).result, 'PASS', 'every PR at 1 and six reconcile-only checkpoint turns: still PASS');
  assert(/6 reconcile checkpoint\(s\) not charged/.test(pick(summary(0, perPrOk, 0, 6)).detail), pick(summary(0, perPrOk, 0, 6)).detail);
  eq(pick(summary(0, { 4: { turns: 2 }, 5: { turns: 1 } }, 0, 0)).result, 'FAIL', 'one task PR with 2 real CI turns fails, with no no-PR turns at all');
  eq(pick(summary(0, { 4: { turns: 2 }, 5: { turns: 1 } }, 0, 6)).result, 'FAIL', 'and still fails next to reconcile turns');
  eq(pick(summary(0, { 4: { turns: 1 } }, 0, 2)).result, 'PASS', 'a PR with no CI turn and two reconcile turns');
  eq(pick(summary(0, perPrOk, 1, 0)).result, 'FAIL', 'every PR at 1 and one unattributed CI read (a loop poll): 3 for 2 PRs');
  eq(pick(summary(0, { 4: { turns: 1 } }, 1, 3)).result, 'PASS', 'one read leaves room when a PR has no turn; reconcile turns beside it do not count');
  eq(pick(summary(0, { 4: { turns: 1 } }, 2, 0)).result, 'FAIL', 'two unattributed reads with one attributed turn: 3 for 2 PRs');
  // no split given (an older summary): every no-PR turn is treated as a read
  const old = summary(0, perPrOk, 0, 0); old.ci.unattributed.turns = 1; delete old.ci.noPr;
  eq(pick(old).result, 'FAIL', 'without the split a no-PR turn is charged');
  eq(pick(summary(0, { 4: { turns: 1 }, 9: { turns: 3 } }, 0)).result, 'PASS', 'turns on a PR that is not a task PR (the milestone PR) are not counted');
  const none = L.evaluateTargets({ summary: summary(0, {}), taskPrs: [], reviews: { total: 0, byCi: {}, pending: [{ timeout: true, waitedMinutes: 9 }] }, milestone: { reported: null, completeBeforeChecksFinished: false, detail: 'none' } });
  nodeAssert.deepStrictEqual(none.map((t) => t.result), ['PASS', 'N/A', 'PASS', 'N/A']);
  assert(L.renderTable(good).split('\n').length === 4, 'one row per target');
});

test('ci-wait-live breakdown: milestone-PR, other-PR and total CI turns are reported with tokens and foreground watches, never pass/fail', () => {
  const tool = (watch, background) => ({ watch, background: !!background });
  const turns = [
    { ci: true, tokens: 100, prs: ['4'], tools: [tool(false)] },                       // task PR
    { ci: true, tokens: 200, prs: ['9'], tools: [tool(true)] },                        // milestone PR, foreground watch
    { ci: true, tokens: 300, prs: [9], tools: [tool(true, true), tool(true)] },        // milestone PR (number, not string), 1 bg + 1 fg watch
    { ci: true, tokens: 400, prs: ['4', '9'], tools: [] },                             // task and milestone together
    { ci: true, tokens: 500, prs: ['77'], tools: [tool(true)] },                       // some other PR
    { ci: true, tokens: 600, prs: [], tools: [] },                                     // names no PR
    { ci: false, tokens: 9999, prs: ['9'], tools: [tool(true)] },                      // not a CI turn: ignored
  ];
  const b = L.ciBreakdown(turns, { taskPrs: ['4', '5'], milestonePrs: ['9'] });
  nodeAssert.deepStrictEqual(b.milestonePr, { turns: 3, contextTokens: 900, foregroundWatch: 2 });
  nodeAssert.deepStrictEqual(b.otherPr, { turns: 1, contextTokens: 500, foregroundWatch: 1 });
  nodeAssert.deepStrictEqual(b.taskPrs, { turns: 2, contextTokens: 500, foregroundWatch: 0 });
  nodeAssert.deepStrictEqual(b.unattributed, { turns: 1, contextTokens: 600, foregroundWatch: 0 });
  nodeAssert.deepStrictEqual(b.total, { turns: 6, contextTokens: 2100, foregroundWatch: 3 });
  // boundaries: no turns, no milestone PR known
  nodeAssert.deepStrictEqual(L.ciBreakdown([], { taskPrs: [], milestonePrs: [] }).total, { turns: 0, contextTokens: 0, foregroundWatch: 0 });
  eq(L.ciBreakdown(turns, { taskPrs: ['4'], milestonePrs: [] }).milestonePr.turns, 0, 'without a known milestone PR its turns land in other');
  eq(L.ciBreakdown(turns, { taskPrs: ['4'], milestonePrs: [] }).otherPr.turns, 4, 'PR 9 (x3, one next to task PR 4) and 77 are "other"');
  // a turn naming a task PR and another PR counts under task and other
  const mixed = L.ciBreakdown([{ ci: true, tokens: 7, prs: ['4', '77'], tools: [] }, { ci: true, tokens: 5, prs: ['9', '77'], tools: [] }, { ci: true, tokens: 3, prs: ['4', '9'], tools: [] }], { taskPrs: ['4'], milestonePrs: ['9'] });
  nodeAssert.deepStrictEqual(mixed.taskPrs, { turns: 2, contextTokens: 10, foregroundWatch: 0 });
  nodeAssert.deepStrictEqual(mixed.milestonePr, { turns: 2, contextTokens: 8, foregroundWatch: 0 });
  nodeAssert.deepStrictEqual(mixed.otherPr, { turns: 2, contextTokens: 12, foregroundWatch: 0 }, '4+77 and 9+77 count as other; 4+9 does not');
  eq(mixed.total.turns, 3, 'total still counts each turn once');
  // evaluateTargets: three INFO rows appended, the four real targets unchanged, one row each in the table
  const summary = { watch: { foreground: 0, background: 0 }, ci: { byPr: { 4: { turns: 1 } }, unattributed: { turns: 0, contextTokens: 0 } } };
  const quiet = { total: 0, byCi: {}, pending: [] };
  const ms = { reported: { status: 'complete' }, completeBeforeChecksFinished: false, detail: 'fine' };
  const t = L.evaluateTargets({ summary, taskPrs: ['4'], reviews: quiet, milestone: ms, breakdown: b });
  nodeAssert.deepStrictEqual(t.map((x) => x.result), ['PASS', 'PASS', 'PASS', 'PASS', 'INFO', 'INFO', 'INFO', 'INFO', 'INFO']);
  nodeAssert.deepStrictEqual(t.slice(4).map((x) => x.name), ['milestone PR CI turns', 'other PR CI turns', 'reconcile checkpoints (no PR, not charged to a task PR)', 'unattributed CI reads (no PR, charged to the task-PR total)', 'total CI-related Director turns']);
  assert(/3 turn\(s\), 900 context tokens, 2 foreground --watch \(milestone PR #9\)/.test(t[4].detail), t[4].detail);
  assert(/0 turn\(s\), 0 context tokens/.test(t[6].detail), `no reconcile turn here: ${t[6].detail}`);
  assert(/1 turn\(s\), 600 context tokens/.test(t[7].detail), t[7].detail);
  assert(/6 turn\(s\), 2100 context tokens/.test(t[8].detail), t[8].detail);
  eq(L.renderTable(t).split('\n').length, 9, 'one row per target and metric');
  // the no-PR split: a reconcile-only turn versus a turn with any other CI kind
  const rt = (kinds) => ({ ci: true, tokens: 10, prs: [], tools: [{ kinds, watch: false, background: false }] });
  const split = L.ciBreakdown([rt(['reconcile-merges']), rt(['reconcile-merges']), rt(['status-check-rollup']), rt(['reconcile-merges', 'pr-checks']), rt(['pr-checks'])], { taskPrs: ['4'], milestonePrs: [] });
  eq(split.reconcile.turns, 2, 'reconcile-only turns');
  eq(split.unattributedReads.turns, 3, 'a rollup read, reconcile plus a check, and a check are reads');
  eq(split.unattributed.turns, 5, 'the total of no-PR turns is unchanged');
  // a Director that polls only the milestone PR is visible even though the per-task-PR target passes
  const only = L.ciBreakdown([1, 2, 3, 4, 5].map((i) => ({ ci: true, tokens: 10, prs: ['9'], tools: [] })), { taskPrs: ['4', '5'], milestonePrs: ['9'] });
  const tt = L.evaluateTargets({ summary: Object.assign({}, summary, { ci: { byPr: { 9: { turns: 5 } }, unattributed: { turns: 0, contextTokens: 0 } } }), taskPrs: ['4', '5'], reviews: quiet, milestone: ms, breakdown: only });
  eq(tt[1].result, 'PASS', 'the existing target still ignores the milestone PR');
  assert(/5 turn\(s\), 50 context tokens/.test(tt[4].detail), tt[4].detail);
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
if (a[0] === 'api' && a[1] === 'repos/o/r') out({ private: true, default_branch: 'main', permissions: { push: true }, allow_auto_merge: E.FAKE_AUTO_MERGE !== '0', allow_squash_merge: true });
if (a[0] === 'api' && a[1] === 'repos/o/r/actions/permissions') out({ enabled: true });
if (a[0] === 'api' && /rules\\/branches/.test(a[1])) out(JSON.parse(E.FAKE_RULES || '[]'));
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
    assert(!fs.readdirSync(h.outDir).some((f) => f.endsWith('.run.json')), 'the run file is removed with the temp folder');
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
    assert(!fs.readdirSync(h.outDir).some((f) => f.endsWith('.run.json')), 'the run file is removed with the temp folder');
  } finally { rm(h.dir); }
});

// --keep leaves exactly what a hard-killed run leaves: GitHub items, the temp folder, the run file.
function keptRun() {
  const h = harnessEnv({ FAKE_CHECKS: JSON.stringify([{ name: 'sample-ci', bucket: 'pass', startedAt: '', completedAt: '' }]) });
  const r = harness(h, ['--repo', 'o/r', '--seed-only', '--keep', '--out-dir', h.outDir]);
  const runFile = fs.readdirSync(h.outDir).find((f) => f.endsWith('.run.json'));
  const run = runFile ? runFile.replace(/^ci-wait-/, '').replace(/\.run\.json$/, '') : null;
  const rec = run ? JSON.parse(fs.readFileSync(path.join(h.outDir, runFile), 'utf8')) : null;
  if (rec) {      // a copied Codex auth.json, as a Codex run would have left
    fs.mkdirSync(path.join(rec.tmp, 'h'), { recursive: true });
    fs.writeFileSync(path.join(rec.tmp, 'h', 'auth.json'), '{"refresh_token":"rt-0123456789abcdefghijklmnop"}');
  }
  return { h, r, run, rec, runFile };
}

test('ci-wait-live --seed-only --keep leaves the branch, the temp folder and a run file, and says how to clean up', () => {
  const k = keptRun();
  try {
    eq(k.r.status, 0, `exit 0 (${k.r.stdout.slice(-300)})`);
    assert(k.h.branches().some((b) => b.endsWith('-seed')), 'seed branch kept');
    assert(/--cleanup-run live-\d{8}t\d{6}-claude-[0-9a-f]{4} --out-dir /.test(k.r.stdout), 'tells how to clean up later');
    assert(fs.existsSync(k.h.tmpBase), 'temp folder kept');
    assert(k.rec && k.rec.run === k.run && k.rec.base === k.h.tmpBase && fs.existsSync(k.rec.tmp), 'the run file records the run and the temp folder');
  } finally { rm(k.h.dir); }
});

test('ci-wait-live cleanup-run also deletes the recorded temp folder (a hard-killed run), auth.json included', () => {
  const k = keptRun();
  try {
    assert(k.rec && fs.existsSync(path.join(k.rec.tmp, 'h', 'auth.json')), 'precondition: the folder holds a copied auth.json');
    const dry = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir, '--dry-run']);
    eq(dry.status, 0, `dry run exit (${dry.stdout})`);
    assert(/\(dry run\) would delete the temp folder/.test(dry.stdout), dry.stdout);
    assert(fs.existsSync(path.join(k.rec.tmp, 'h', 'auth.json')), 'a dry run deletes nothing');
    const r = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
    eq(r.status, 0, `exit 0 (${r.stdout})`);
    assert(/deleted the temp folder/.test(r.stdout), r.stdout);
    assert(!fs.existsSync(k.rec.tmp) && !fs.existsSync(k.h.tmpBase), 'temp folder and its base are gone, auth.json with them');
    assert(!fs.existsSync(path.join(k.h.outDir, k.runFile)), 'the run file is removed');
    nodeAssert.deepStrictEqual(k.h.branches(), ['main', `milestone/${OTHER_RUN}`]);
    // one step past: a second cleanup finds nothing to do and succeeds
    const again = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
    eq(again.status, 0, 'second cleanup exits 0');
    assert(/no run file/.test(again.stdout), again.stdout);
  } finally { rm(k.h.dir); }
});

test('ci-wait-live cleanup-run refuses a recorded folder that is not a harness temp folder', () => {
  const k = keptRun();
  try {
    const file = path.join(k.h.outDir, k.runFile);
    const mutate = (fn) => { const rec = JSON.parse(fs.readFileSync(file, 'utf8')); fn(rec); fs.writeFileSync(file, JSON.stringify(rec)); };
    const cleanup = () => harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
    // a folder with other content
    fs.writeFileSync(path.join(k.rec.tmp, 'precious.txt'), 'keep');
    let r = cleanup();
    eq(r.status, 1, 'exit 1 when refused');
    assert(/refusing to delete/.test(r.stdout) && fs.existsSync(path.join(k.rec.tmp, 'precious.txt')), `kept (${r.stdout})`);
    fs.rmSync(path.join(k.rec.tmp, 'precious.txt'));
    // a folder that is not <base>/<digits>
    const odd = path.join(k.h.dir, 'not-a-pid'); fs.mkdirSync(path.join(odd, 'h'), { recursive: true });
    mutate((rec) => { rec.tmp = odd; });
    r = cleanup();
    eq(r.status, 1, 'exit 1 when the name is wrong');
    assert(/refusing to delete/.test(r.stdout) && fs.existsSync(odd), r.stdout);
    // a digits-named folder with the right content, but not under the recorded base
    const elsewhere = path.join(k.h.dir, '4242'); fs.mkdirSync(path.join(elsewhere, 'p'), { recursive: true });
    mutate((rec) => { rec.tmp = elsewhere; });
    r = cleanup();
    eq(r.status, 1, 'exit 1 when the folder is not under the recorded base');
    assert(/refusing to delete/.test(r.stdout) && fs.existsSync(elsewhere), r.stdout);
    // a run file for another run
    mutate((rec) => { rec.tmp = k.rec.tmp; rec.run = OTHER_RUN; });
    r = cleanup();
    eq(r.status, 1, 'exit 1 for another run\'s file');
    assert(/another run/.test(r.stdout) && fs.existsSync(k.rec.tmp), r.stdout);
    // recovery control: the genuine record is deleted normally
    mutate((rec) => { rec.run = k.run; });
    r = cleanup();
    eq(r.status, 0, `genuine record works (${r.stdout})`);
    assert(!fs.existsSync(k.rec.tmp), 'deleted');
  } finally { rm(k.h.dir); }
});

test('ci-wait-live cleanup-run: a recorded base that is not the expected base is refused (unit and end to end)', () => {
  const exp = path.join(os.tmpdir(), 'cw6-expected');
  eq(L.deletableTemp(path.join(exp, '4242'), exp, ['h', 'p'], exp), true, 'control: the expected base is fine');
  eq(L.deletableTemp(path.join(exp, '4242'), exp, ['h', 'p'], path.join(os.tmpdir(), 'cw6-other')), false, 'recorded base differs from the expected one');
  eq(L.deletableTemp(path.join(exp, '4242'), exp, [], exp), true, 'an empty folder of the right shape is deletable (a run killed before the clone)');
  eq(L.deletableTemp(path.join(exp, '4242'), exp, ['h', 'p']), false, 'no expected base given: refused');
  eq(L.expectedTempBase({ AGENT_TEAM_LIVE_TMP: exp }, 'win32', 'T'), exp, 'the env var wins');
  eq(L.expectedTempBase({}, 'win32', 'T'), 'C:\\cw6', 'Windows default');
  eq(L.expectedTempBase({}, 'linux', path.join('T')), path.join('T', 'cw6'), 'other default');
  const k = keptRun();
  try {
    const file = path.join(k.h.outDir, k.runFile);
    // a self-consistent record (<base>/<digits> with h and p) under a base the harness would not use
    const other = path.join(k.h.dir, 'otherbase'); const tmp = path.join(other, '4242');
    fs.mkdirSync(path.join(tmp, 'h'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'h', 'auth.json'), '{}');
    fs.writeFileSync(file, JSON.stringify(Object.assign({}, k.rec, { tmp, base: other })));
    const r = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
    eq(r.status, 1, 'refused: exit 1');
    assert(/refusing to delete/.test(r.stdout) && fs.existsSync(path.join(tmp, 'h', 'auth.json')), `kept (${r.stdout})`);   // precondition: the shape was valid, only the base was wrong
    // recovery control: the same shape under the expected base is deleted
    fs.writeFileSync(file, JSON.stringify(k.rec));
    const ok2 = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
    eq(ok2.status, 0, `expected base works (${ok2.stdout})`);
    assert(!fs.existsSync(k.rec.tmp), 'deleted');
  } finally { rm(k.h.dir); }
});

test('ci-wait-live cleanup-run: an empty recorded folder is deleted', () => {
  const k = keptRun();
  try {
    fs.rmSync(path.join(k.rec.tmp, 'h'), { recursive: true, force: true });
    fs.rmSync(path.join(k.rec.tmp, 'p'), { recursive: true, force: true });
    eq(fs.readdirSync(k.rec.tmp).length, 0, 'precondition: the folder is empty');
    const r = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
    eq(r.status, 0, `exit 0 (${r.stdout})`);
    assert(!fs.existsSync(k.rec.tmp), 'deleted');
  } finally { rm(k.h.dir); }
});

test('ci-wait-live cleanup-run: a recorded pid that is still alive is refused unless --force', () => {
  eq(L.pidAlive(process.pid), true, 'this process is alive');
  eq(L.pidAlive(0), false, 'pid 0 is not a run');
  eq(L.pidAlive(undefined), false, 'a missing pid is not alive');
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  eq(L.pidAlive(Number(gone.stdout)), false, 'an exited process is not alive');
  const k = keptRun();
  try {
    const file = path.join(k.h.outDir, k.runFile);
    // a live process that is not this harness: a sleeping node child
    const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
    try {
      assert(child.pid && L.pidAlive(child.pid), 'precondition: the recorded pid is alive');
      fs.writeFileSync(file, JSON.stringify(Object.assign({}, k.rec, { pid: child.pid })));
      const mut0 = k.h.calls().filter(isMutation).length;      // the seed run's own PR close
      assert(k.h.branches().some((b) => b.endsWith('-seed')), 'precondition: the seed branch is on the remote');
      const dry = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir, '--dry-run']);
      eq(dry.status, 1, 'a dry run reports the refusal too');
      const r = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
      eq(r.status, 1, 'exit 1 while the pid is alive');
      assert(/still alive/.test(r.stdout) && /--force/.test(r.stdout), r.stdout);
      eq(k.h.calls().filter(isMutation).length, mut0, 'no pr close, issue close or branch DELETE call was made');
      assert(k.h.branches().some((b) => b.endsWith('-seed')), 'the remote branch is still there');
      assert(fs.existsSync(path.join(k.rec.tmp, 'h', 'auth.json')) && fs.existsSync(file), 'nothing deleted, run file kept');
      const f = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir, '--force']);
      eq(f.status, 0, `--force deletes (${f.stdout})`);
      assert(!k.h.branches().some((b) => b.endsWith('-seed')), '--force also runs the remote cleanup');
      assert(!fs.existsSync(k.rec.tmp), 'deleted with --force');
    } finally { child.kill(); }
  } finally { rm(k.h.dir); }
});

test('ci-wait-live cleanup-run: a run file with a missing or invalid pid needs --force, and touches nothing remote', () => {
  eq(L.pidState(undefined), 'unknown', 'missing');
  eq(L.pidState(null), 'unknown', 'null');
  eq(L.pidState('abc'), 'unknown', 'not a number');
  eq(L.pidState(-4), 'unknown', 'negative');
  eq(L.pidState(1.5), 'unknown', 'not an integer');
  eq(L.pidState(process.pid), 'alive', 'alive');
  const k = keptRun();
  try {
    const file = path.join(k.h.outDir, k.runFile);
    const mut0 = k.h.calls().filter(isMutation).length;
    for (const bad of [undefined, 'abc', 0]) {
      const rec = Object.assign({}, k.rec); if (bad === undefined) delete rec.pid; else rec.pid = bad;
      fs.writeFileSync(file, JSON.stringify(rec));
      assert(L.pidState(rec.pid) === 'unknown', 'precondition: the pid reads as unknown');
      const r = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
      eq(r.status, 1, `pid ${JSON.stringify(bad)}: exit 1`);
      assert(/no valid pid/.test(r.stdout) && /--force/.test(r.stdout), r.stdout);
      eq(k.h.calls().filter(isMutation).length, mut0, 'no remote mutation');
      assert(fs.existsSync(path.join(k.rec.tmp, 'h', 'auth.json')), 'nothing deleted');
    }
    const dry = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir, '--dry-run']);
    eq(dry.status, 1, 'a dry run reports it too');
    const f = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir, '--force']);
    eq(f.status, 0, `--force proceeds (${f.stdout})`);
    assert(!fs.existsSync(k.rec.tmp) && !k.h.branches().some((b) => b.endsWith('-seed')), 'temp folder and remote branch cleaned with --force');
  } finally { rm(k.h.dir); }
});

test('ci-wait-live cleanup-run: a run file that is not valid JSON is refused like an unknown pid, and touches nothing', () => {
  const k = keptRun();
  try {
    const file = path.join(k.h.outDir, k.runFile);
    const mut0 = k.h.calls().filter(isMutation).length;
    for (const bad of ['{"run": "truncated', '', 'null', '[]', '42']) {
      fs.writeFileSync(file, bad);
      // precondition: the file is there and is not a run record
      let rec; try { rec = JSON.parse(bad); } catch (e) { rec = undefined; }
      assert(fs.existsSync(file) && (rec === undefined || rec === null || typeof rec !== 'object' || Array.isArray(rec)), `precondition: ${JSON.stringify(bad)} is not a run record`);
      const r = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
      eq(r.status, 1, `${JSON.stringify(bad)}: exit 1`);
      assert(/not valid JSON/.test(r.stdout) && /--force/.test(r.stdout) && /Nothing was closed or deleted/.test(r.stdout), r.stdout);
      eq(k.h.calls().filter(isMutation).length, mut0, 'no remote mutation');
      assert(k.h.branches().some((b) => b.endsWith('-seed')), 'the remote branch is still there');
      assert(fs.existsSync(path.join(k.rec.tmp, 'h', 'auth.json')) && fs.existsSync(file), 'nothing deleted, run file kept');
    }
    // one step past: a dry run reports it too, and still nothing changed
    fs.writeFileSync(file, '{"run": "truncated');
    const dry = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir, '--dry-run']);
    eq(dry.status, 1, 'a dry run reports the refusal');
    eq(k.h.calls().filter(isMutation).length, mut0, 'still no mutation after the dry run');
    // --force goes ahead with the remote cleanup and leaves the temp folder for the user
    const f = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir, '--force']);
    eq(f.status, 0, `--force proceeds (${f.stdout})`);
    assert(!k.h.branches().some((b) => b.endsWith('-seed')), '--force runs the remote cleanup');
    assert(/not valid JSON/.test(f.stdout) && !/no run file/.test(f.stdout), f.stdout);
    assert(fs.existsSync(path.join(k.rec.tmp, 'h', 'auth.json')), 'the temp folder is left for the user (nothing says where it is)');
  } finally { rm(k.h.dir); }
  // recovery control: a valid record whose pid is gone is cleaned normally
  const g = keptRun();
  try {
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(g.h.outDir, g.runFile), JSON.stringify(Object.assign({}, g.rec, { pid: Number(gone.stdout) })));
    const r = harness(g.h, ['--repo', 'o/r', '--cleanup-run', g.run, '--out-dir', g.h.outDir]);
    eq(r.status, 0, `a valid record with a dead pid is cleaned (${r.stdout})`);
    assert(!g.h.branches().some((b) => b.endsWith('-seed')) && !fs.existsSync(g.rec.tmp), 'branch and temp folder gone');
  } finally { rm(g.h.dir); }
});

test('ci-wait-live cleanup-run: a run file that cannot be read (a directory, EISDIR) is refused too; only a missing file is "no run file"', () => {
  const k = keptRun();
  try {
    const file = path.join(k.h.outDir, k.runFile);
    fs.rmSync(file);
    fs.mkdirSync(file);
    let code = null; try { fs.readFileSync(file, 'utf8'); } catch (e) { code = e.code; }
    assert(code && code !== 'ENOENT', `precondition: reading the run file fails with something other than ENOENT (${code})`);
    const mut0 = k.h.calls().filter(isMutation).length;
    const r = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
    eq(r.status, 1, 'exit 1');
    assert(/cannot be read/.test(r.stdout) && /--force/.test(r.stdout) && /Nothing was closed or deleted/.test(r.stdout), r.stdout);
    eq(k.h.calls().filter(isMutation).length, mut0, 'no remote mutation');
    assert(k.h.branches().some((b) => b.endsWith('-seed')) && fs.existsSync(path.join(k.rec.tmp, 'h', 'auth.json')), 'nothing closed or deleted');
    // one step past: --force goes ahead with the remote cleanup and says why the temp folder is left
    const f = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir, '--force']);
    eq(f.status, 0, `--force proceeds (${f.stdout})`);
    assert(!k.h.branches().some((b) => b.endsWith('-seed')) && /cannot be read/.test(f.stdout), f.stdout);
  } finally { rm(k.h.dir); }
});

test('ci-wait-live cleanup-run: with no run file the remote cleanup still runs', () => {
  const k = keptRun();
  try {
    fs.rmSync(path.join(k.h.outDir, k.runFile));
    assert(k.h.branches().some((b) => b.endsWith('-seed')), 'precondition: the seed branch exists');
    const r = harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
    eq(r.status, 0, `exit 0 (${r.stdout})`);
    assert(/no run file/.test(r.stdout) && !k.h.branches().some((b) => b.endsWith('-seed')), 'branch deleted, temp folder left to the user');
  } finally { rm(k.h.dir); }
});

// A symlink (a junction on Windows, which needs no privilege) in place of tmp, h or p.
function tryLink(target, linkPath) {
  try { fs.symlinkSync(target, linkPath, 'junction'); return true; } catch (e) { return false; }
}
test('ci-wait-live cleanup-run: a link for tmp, h or p is refused and nothing outside is deleted', () => {
  const k = keptRun();
  try {
    const outside = path.join(k.h.dir, 'outside'); fs.mkdirSync(outside);
    const victim = path.join(outside, 'auth.json'); fs.writeFileSync(victim, 'precious');
    const probe = path.join(k.h.dir, 'probe-link');
    if (!tryLink(outside, probe)) { console.log('  (skipped: links cannot be created here)'); return; }
    fs.rmSync(probe, { recursive: true, force: true });
    const file = path.join(k.h.outDir, k.runFile);
    const cleanup = () => harness(k.h, ['--repo', 'o/r', '--cleanup-run', k.run, '--out-dir', k.h.outDir]);
    for (const which of ['h', 'p']) {
      fs.rmSync(path.join(k.rec.tmp, which), { recursive: true, force: true });
      assert(tryLink(outside, path.join(k.rec.tmp, which)), `precondition: ${which} is a link`);
      assert(fs.lstatSync(path.join(k.rec.tmp, which)).isSymbolicLink(), `${which} reads as a link`);
      const r = cleanup();
      eq(r.status, 1, `${which} as a link: exit 1`);
      assert(/refusing to delete/.test(r.stdout) && /link/.test(r.stdout), r.stdout);
      eq(fs.readFileSync(victim, 'utf8'), 'precious', `the auth.json outside survives (${which})`);
      assert(fs.existsSync(k.rec.tmp) && fs.existsSync(file), 'folder and run file kept');
      fs.rmSync(path.join(k.rec.tmp, which), { recursive: true, force: true });   // removes the link only
      eq(fs.readFileSync(victim, 'utf8'), 'precious', 'removing the link leaves its target');
      fs.mkdirSync(path.join(k.rec.tmp, which));
    }
    // tmp itself a link to a real <base>/<digits> folder
    const real = path.join(k.h.dir, 'real'); fs.mkdirSync(path.join(real, 'h'), { recursive: true });
    fs.writeFileSync(path.join(real, 'h', 'auth.json'), 'precious2');
    const linkTmp = path.join(k.h.tmpBase, '7777');
    assert(tryLink(real, linkTmp), 'precondition: tmp is a link');
    fs.writeFileSync(file, JSON.stringify(Object.assign({}, k.rec, { tmp: linkTmp })));
    const rt = cleanup();
    eq(rt.status, 1, 'tmp as a link: exit 1');
    eq(fs.readFileSync(path.join(real, 'h', 'auth.json'), 'utf8'), 'precious2', 'the target of a linked tmp survives');
    fs.rmSync(linkTmp, { recursive: true, force: true });
    // recovery control: the genuine record is deleted normally
    fs.writeFileSync(file, JSON.stringify(k.rec));
    const good = cleanup();
    eq(good.status, 0, `genuine record works (${good.stdout})`);
    assert(!fs.existsSync(k.rec.tmp), 'deleted');
    eq(fs.readFileSync(victim, 'utf8'), 'precious', 'the outside file is still there');
  } finally { rm(k.h.dir); }
});

test('ci-wait-live args: --force only goes with --cleanup-run', () => {
  eq(L.parseArgs(['--repo', 'o/r', '--cleanup-run', RUN, '--force']).opts.force, true, 'accepted');
  assert(L.parseArgs(['--repo', 'o/r', '--seed-only', '--force']).error.includes('--cleanup-run'), 'rejected elsewhere');
});

// ---- --preflight-only: read-only, starts nothing ----
const READY_RULES = JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'sample-ci' }] } }]);
const startedSomething = (calls) => calls.some((c) => (c[0] === 'repo' && c[1] === 'clone') || (c[0] === 'pr' && c[1] === 'create') || isMutation(c));

test('ci-wait-live --preflight-only: ready repo exits 0 and starts nothing', () => {
  const h = harnessEnv({ FAKE_RULES: READY_RULES });
  try {
    const r = harness(h, ['--repo', 'o/r', '--preflight-only']);
    eq(r.status, 0, `exit 0 (${r.stdout})`);
    assert(/The repo is ready for a run/.test(r.stdout), r.stdout);
    assert(h.calls().some((c) => c[0] === 'api' && c[1] === 'repos/o/r/actions/permissions'), 'precondition: the preflight reads ran');
    assert(!startedSomething(h.calls()), 'no clone, no PR, no close or delete');
    assert(!fs.existsSync(h.tmpBase), 'no temp folder');
  } finally { rm(h.dir); }
});

test('ci-wait-live --preflight-only: a repo that is not ready exits 2 with the steps, and starts nothing', () => {
  for (const [extra, mention] of [[{ FAKE_AUTO_MERGE: '0', FAKE_RULES: READY_RULES }, 'Allow auto-merge'], [{ FAKE_RULES: '[]' }, 'Include by pattern > milestone/*']]) {
    const h = harnessEnv(extra);
    try {
      const r = harness(h, ['--repo', 'o/r', '--preflight-only']);
      eq(r.status, 2, `exit 2 (${r.stdout})`);
      assert(r.stdout.includes(mention) && /Nothing was changed/.test(r.stdout), r.stdout);
      assert(h.calls().some((c) => c[0] === 'api' && c[1] === 'repos/o/r/actions/permissions'), 'precondition: the preflight reads ran');
      assert(!startedSomething(h.calls()), 'no clone, no PR, no close or delete');
    } finally { rm(h.dir); }
  }
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
