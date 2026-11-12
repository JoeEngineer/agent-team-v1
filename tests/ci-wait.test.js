// scripts/ci-wait.js: waiting for / checking CI on GitHub (gh) and GitLab (glab).
// Most tests run main() in process with a stand-in CLI that plays back a
// sequence of responses (tests/fake-ci-cli.js), a fake clock and a fake sleep, so
// a 9-minute wait takes no time and every call is counted. A few run the real
// script as a child process against the same stand-in to cover the parts that
// only a process shows: per-call kill on timeout, the real deadline, exit codes.
// Loaded and run by tests/run.js: node tests/run.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, test, assert, eq } = require('./helpers');
const { Playback } = require('./fake-ci-cli');

const ciWait = require(path.join(SCRIPTS, 'ci-wait.js'));
const forge = require(path.join(SCRIPTS, 'forge.js'));
const CI_WAIT = path.join(SCRIPTS, 'ci-wait.js');
const FAKE_CLI = path.join(__dirname, 'fake-ci-cli.js');

// ---- builders for what gh / glab print ------------------------------------
const SHA = 'a'.repeat(40);
const SHA2 = 'c'.repeat(40);
const run_ = (name, status, conclusion, extra = {}) =>
  ({ __typename: 'CheckRun', name, status, conclusion, workflowName: 'CI', startedAt: '2026-01-01T00:00:00Z', ...extra });
const ok = (name, extra) => run_(name, 'COMPLETED', 'SUCCESS', extra);
const bad = (name, conclusion = 'FAILURE', extra) => run_(name, 'COMPLETED', conclusion, extra);
const running = (name, extra) => run_(name, 'IN_PROGRESS', '', extra);
const ctxt = (context, state) => ({ __typename: 'StatusContext', context, state, startedAt: '2026-01-01T00:00:00Z' });
const pr = (rollup, { sha = SHA, base = 'main', state = 'OPEN' } = {}) =>
  JSON.stringify({ headRefOid: sha, baseRefName: base, state, statusCheckRollup: rollup });
const rules = (...contexts) => JSON.stringify([
  { type: 'deletion' },
  ...(contexts.length ? [{ type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context })) } }] : []),
]);
const NOT_PROTECTED = { err: 'gh: Branch not protected (HTTP 404)' };
const FORBIDDEN = { err: 'gh: Resource not accessible by integration (HTTP 403)' };
const NOT_LOGGED_IN = { err: 'gh: To use GitHub CLI, run: gh auth login' };
// A GitHub scenario with no required checks unless the test says otherwise.
const gh = (view, extra = {}) => ({ view, rules: rules(), protection: NOT_PROTECTED, ...extra });
const mr = (status, { sha = SHA, id = 55, target = 'main', state = 'opened' } = {}) =>
  JSON.stringify({ iid: 12, state, sha, target_branch: target, head_pipeline: status === null ? null : { id, status } });

// ---- in-process harness ----------------------------------------------------
const T0 = 1000000;
function exec(argv, routes, { forgeName = 'github', callMs = 0 } = {}) {
  const pb = new Playback(routes);
  const base = pb.runner();
  let t = T0;
  const sleeps = [];
  const raw = [];
  const errs = [];
  const runner = (f, a, c, to) => {
    try { return base(f, a, c, to); } finally { t += callMs; }
  };
  const code = ciWait.main(argv, {
    run: runner, forge: forgeName, cwd: process.cwd(),
    now: () => t, sleep: (ms) => { sleeps.push(ms); t += ms; },
    out: (l) => raw.push(l), err: (l) => errs.push(l),
  });
  const recs = raw.map((l) => JSON.parse(l));
  return { code, raw, recs, rec: recs[0], pb, sleeps, errs, elapsed: (t - T0) / 1000 };
}

const REC_KEYS = ['pr', 'forge', 'ci', 'head_sha', 'sha_matches', 'required', 'failing', 'pending', 'waited_s', 'note'];

console.log('ci-wait: results and exit codes');

test('green: one JSON line with the pinned fields, exit 0', () => {
  const r = exec(['7'], gh(pr([ok('build'), ok('lint')])));
  eq(r.code, 0, 'exit');
  eq(r.raw.length, 1, 'one line');
  assert(!r.raw[0].includes('\n'), 'line has no newline inside');
  eq(JSON.stringify(Object.keys(r.rec)), JSON.stringify(REC_KEYS), 'field names and order');
  eq(r.rec.pr, 7, 'pr'); eq(r.rec.forge, 'github', 'forge'); eq(r.rec.ci, 'green', 'ci');
  eq(r.rec.head_sha, SHA, 'head_sha'); eq(r.rec.sha_matches, null, 'sha_matches without --sha');
  eq(r.rec.required, null, 'required'); eq(JSON.stringify(r.rec.failing), '[]', 'failing'); eq(JSON.stringify(r.rec.pending), '[]', 'pending');
  eq(r.rec.waited_s, 0, 'waited_s');
  eq(r.sleeps.length, 0, 'green on the first look: no sleep');
});

test('red: a failing check stops the wait at once, exit 1, names the failing check', () => {
  const r = exec(['7'], gh(pr([ok('build'), bad('lint'), running('slow')])));
  eq(r.code, 1, 'exit');
  eq(r.rec.ci, 'red', 'ci');
  eq(JSON.stringify(r.rec.failing), '["lint"]', 'failing');
  eq(JSON.stringify(r.rec.pending), '["slow"]', 'pending');
  eq(r.pb.count('view'), 1, 'one status call: fail fast');
  eq(r.sleeps.length, 0, 'no sleep');
});

test('pending then green: polls every interval, reports waited_s', () => {
  const r = exec(['7', '--interval', '30', '--timeout', '540'], gh([pr([running('build')]), pr([running('build')]), pr([ok('build')])]));
  eq(r.code, 0, 'exit');
  eq(r.rec.ci, 'green', 'ci');
  eq(r.pb.count('view'), 3, 'status calls');
  eq(JSON.stringify(r.sleeps), '[30000,30000]', 'sleeps');
  eq(r.rec.waited_s, 60, 'waited_s');
});

test('pending until the deadline: exit 8, last poll lands on the deadline, nothing runs after', () => {
  const r = exec(['7', '--interval', '30', '--timeout', '120'], gh(pr([running('build'), ok('lint')])));
  eq(r.code, 8, 'exit');
  eq(r.rec.ci, 'pending', 'ci');
  eq(JSON.stringify(r.rec.pending), '["build"]', 'pending');
  eq(r.pb.count('view'), 4, 'precondition: all ceil(120/30) polls were used');
  eq(r.elapsed, 120, 'ended at the deadline');
  eq(r.rec.waited_s, 120, 'waited_s');
  assert(/deadline reached after 120s/.test(r.rec.note), `note: ${r.rec.note}`);
  const callsAtEnd = r.pb.calls.length;
  eq(callsAtEnd, 4 + 2, 'no call after the deadline (4 polls + 2 required lookups)');
});

test('required: a required check that never appears stays pending, and the note names it', () => {
  const r = exec(['7', '--interval', '30', '--timeout', '90'], gh(pr([ok('lint')]), { rules: rules('build') }));
  eq(r.code, 8, 'exit');
  eq(JSON.stringify(r.rec.required), '["build"]', 'required');
  eq(JSON.stringify(r.rec.pending), '["build"]', 'pending names the missing check');
  assert(/required check not on the head: build/.test(r.rec.note), `note: ${r.rec.note}`);
  assert(/deadline reached/.test(r.rec.note), 'deadline note');
  eq(r.pb.count('view'), 3, 'polled to the deadline');
});

test('required: the missing check shows up later -> green (recovery)', () => {
  const r = exec(['7', '--interval', '30', '--timeout', '90'], gh([pr([ok('lint')]), pr([ok('lint'), ok('build')])], { rules: rules('build') }));
  eq(r.code, 0, 'exit');
  eq(r.rec.ci, 'green', 'ci');
  eq(r.pb.count('view'), 2, 'polls');
});

console.log('ci-wait: none, grace, unknown');

test('none: still no checks after the grace period -> exit 3 (0 with --allow-none), no polling afterwards', () => {
  const routes = gh(pr([]));
  const r = exec(['7', '--interval', '30', '--timeout', '300', '--grace', '60'], routes);
  eq(r.code, 3, 'exit');
  eq(r.rec.ci, 'none', 'ci');
  eq(r.pb.count('view'), 3, 'polled at 0s, 30s, 60s and then stopped');
  eq(r.rec.waited_s, 60, 'waited_s');
  assert(/grace period/.test(r.rec.note), `note: ${r.rec.note}`);
  const a = exec(['7', '--interval', '30', '--timeout', '300', '--grace', '60', '--allow-none'], routes);
  eq(a.code, 0, '--allow-none exit');
  eq(a.rec.ci, 'none', '--allow-none still says none');
});

test('none: during the grace period it is pending, and a deadline shorter than the grace ends pending', () => {
  const r = exec(['7', '--interval', '30', '--timeout', '60', '--grace', '120'], gh(pr([])));
  eq(r.code, 8, 'exit');
  eq(r.rec.ci, 'pending', 'ci');
  assert(/allowing 120s for CI to start/.test(r.rec.note), `note: ${r.rec.note}`);
  eq(r.pb.count('view'), 2, 'polls');
});

test('none: checks appear during the grace period -> normal decision', () => {
  const r = exec(['7', '--interval', '30', '--grace', '120'], gh([pr([]), pr([ok('build')])]));
  eq(r.code, 0, 'exit');
  eq(r.rec.ci, 'green', 'ci');
});

test('unknown: a CLI error is exit 2, never none, never retried on the first look', () => {
  for (const flags of [[], ['--allow-none'], ['--once']]) {
    const r = exec(['7', ...flags], gh(NOT_LOGGED_IN));
    eq(r.code, 2, `exit (${flags})`);
    eq(r.rec.ci, 'unknown', 'ci');
    assert(/gh auth login/.test(r.rec.note), `note: ${r.rec.note}`);
    eq(r.rec.head_sha, null, 'head_sha');
    eq(r.pb.calls.length, 1, `one call, no required lookup, no retry (${flags})`);
    eq(r.sleeps.length, 0, 'no sleep');
  }
});

test('unknown: PR not found, non-JSON output and JSON without a head all give exit 2', () => {
  const nf = exec(['99'], gh({ err: 'GraphQL: Could not resolve to a PullRequest with the number of 99.' }));
  eq(nf.code, 2, 'not found'); eq(nf.rec.ci, 'unknown', 'ci');
  const html = exec(['99'], gh('<html>502 Bad Gateway</html>'));
  eq(html.code, 2, 'non-JSON'); assert(/not JSON/.test(html.rec.note), html.rec.note);
  const nohead = exec(['99'], gh('{}'));
  eq(nohead.code, 2, 'no head'); assert(/headRefOid/.test(nohead.rec.note), nohead.rec.note);
  const empty = exec(['99'], gh(''));
  eq(empty.code, 2, 'empty output');
});

test('unknown: a long error message is cut to one line', () => {
  const r = exec(['7'], gh({ err: `${'x'.repeat(2000)}\nsecond line` }));
  assert(r.rec.note.length < 400, `note length ${r.rec.note.length}`);
  assert(!r.rec.note.includes('second line'), 'first line only');
});

test('unknown: a hung CLI call (killed by its timeout) is unknown with the call limit passed down', () => {
  const r = exec(['7', '--call-timeout', '12'], gh({ hang: true }));
  eq(r.code, 2, 'exit');
  assert(/timed out/.test(r.rec.note), r.rec.note);
  eq(r.pb.calls[0].timeout, 12000, 'per-call timeout reaches the runner');
});

test('unknown: one failed look in the middle of a wait is tolerated, three in a row are not', () => {
  const blip = exec(['7'], gh([pr([running('b')]), { err: 'gh: HTTP 502' }, pr([ok('b')])]));
  eq(blip.code, 0, 'blip then green');
  eq(blip.pb.count('view'), 3, 'polls');
  const dead = exec(['7'], gh([pr([running('b')]), { err: 'gh: HTTP 502' }]));
  eq(dead.code, 2, 'three in a row');
  assert(/3 failures in a row/.test(dead.rec.note), dead.rec.note);
  eq(dead.pb.count('view'), 4, 'precondition: pending, then three failures');
  const last = exec(['7', '--interval', '30', '--timeout', '60'], gh([pr([running('b')]), { err: 'gh: HTTP 502' }]));
  eq(last.code, 2, 'last look failed: not reported as the earlier pending');
  assert(/last check/.test(last.rec.note), last.rec.note);
  const gone = exec(['7'], gh([pr([running('b')]), { err: 'gh: Not Found (HTTP 404)' }]));
  eq(gone.code, 2, 'not found mid-wait');
  eq(gone.pb.count('view'), 2, 'stops at the 404');
});

console.log('ci-wait: head moved (--sha)');

test('head moved before the first look: exit 4, sha_matches false, no further calls', () => {
  const r = exec(['7', '--sha', 'b'.repeat(40)], gh(pr([bad('lint')])));
  eq(r.code, 4, 'exit');
  eq(r.rec.sha_matches, false, 'sha_matches');
  eq(r.rec.head_sha, SHA, 'head_sha is the head we saw');
  eq(r.rec.ci, 'unknown', 'the old head status is not reported');
  eq(JSON.stringify(r.rec.failing), '[]', 'failing is empty');
  assert(/head moved/.test(r.rec.note), r.rec.note);
  eq(r.pb.calls.length, 1, 'no required lookup for a head that is not ours');
});

test('head matches: a full SHA or a 7+ character prefix, any case', () => {
  for (const sha of [SHA, SHA.slice(0, 7), SHA.slice(0, 12).toUpperCase()]) {
    const r = exec(['7', '--sha', sha], gh(pr([ok('build')])));
    eq(r.code, 0, `exit for ${sha}`);
    eq(r.rec.sha_matches, true, 'sha_matches');
  }
});

test('head moved while waiting: stops at the poll that sees it, exit 4', () => {
  const r = exec(['7', '--sha', SHA], gh([pr([running('b')]), pr([running('b')], { sha: SHA2 }), pr([ok('b')], { sha: SHA2 })]));
  eq(r.code, 4, 'exit');
  eq(r.rec.head_sha, SHA2, 'new head');
  eq(r.pb.count('view'), 2, 'precondition: first poll matched, second saw the move; no third');
  eq(r.sleeps.length, 1, 'one sleep');
});

test('--once with --sha: a moved head is exit 4', () => {
  const r = exec(['--once', '7', '--sha', 'd'.repeat(7)], gh(pr([ok('b')])));
  eq(r.code, 4, 'exit');
});

console.log('ci-wait: required checks vs all checks');

test('required set decides: a failing optional check does not matter', () => {
  const r = exec(['7'], gh(pr([ok('build'), bad('lint')]), { rules: rules('build') }));
  eq(r.code, 0, 'exit');
  eq(JSON.stringify(r.rec.required), '["build"]', 'required');
  eq(JSON.stringify(r.rec.failing), '[]', 'failing');
});

test('required set decides: a failing required check is red even while others run', () => {
  const r = exec(['7'], gh(pr([bad('build'), running('lint')]), { rules: rules('build') }));
  eq(r.code, 1, 'exit');
  eq(JSON.stringify(r.rec.failing), '["build"]', 'failing');
  eq(r.pb.count('view'), 1, 'fail fast');
});

test('required set decides: a pending optional check does not hold up green', () => {
  const r = exec(['7'], gh(pr([ok('build'), running('lint')]), { rules: rules('build') }));
  eq(r.code, 0, 'exit');
});

test('no required checks: all checks decide, required is null, the note says so', () => {
  const r = exec(['7'], gh(pr([ok('build'), bad('lint')])));
  eq(r.code, 1, 'exit');
  eq(r.rec.required, null, 'required');
  assert(/no required checks on 'main'; decided on all checks/.test(r.rec.note), r.rec.note);
});

test('required checks unreadable (ruleset 403): fall back to all checks with a note, not an error', () => {
  const r = exec(['7'], gh(pr([ok('build'), ok('lint')]), { rules: FORBIDDEN }));
  eq(r.code, 0, 'exit');
  eq(r.rec.ci, 'green', 'ci');
  eq(r.rec.required, null, 'required');
  assert(/could not read the required checks of 'main'.*rulesets.*403.*decided on all checks/.test(r.rec.note), r.rec.note);
  eq(r.pb.count('protection'), 0, 'stops at the first unreadable source');
  const red = exec(['7'], gh(pr([ok('build'), bad('lint')]), { rules: FORBIDDEN }));
  eq(red.code, 1, 'all-checks fallback is the stricter reading');
});

test('required checks half-readable (ruleset names, protection 403): not trusted, all checks decide', () => {
  const r = exec(['7'], gh(pr([ok('build'), bad('lint')]), { rules: rules('build'), protection: FORBIDDEN }));
  eq(r.code, 1, 'exit: lint counts because the required set is incomplete');
  eq(r.rec.required, null, 'required');
  assert(/branch protection/.test(r.rec.note), r.rec.note);
});

test('required checks: rulesets and classic protection are merged (contexts and checks)', () => {
  const r = exec(['7'], gh(pr([ok('build'), ok('ci/legacy'), ok('deploy')]), {
    rules: rules('build'),
    protection: JSON.stringify({ strict: true, contexts: ['ci/legacy'], checks: [{ context: 'deploy', app_id: 1 }, { context: 'build', app_id: 2 }] }),
  }));
  eq(JSON.stringify(r.rec.required), '["build","ci/legacy","deploy"]', 'required');
  eq(r.code, 0, 'exit');
});

test('required checks: the lookup targets the base branch, url-encoded, with plain GETs', () => {
  const r = exec(['7'], gh(pr([ok('b')], { base: 'milestone/ci-wait' })));
  const api = r.pb.calls.filter((c) => c.args[0] === 'api').map((c) => c.args);
  eq(JSON.stringify(api), JSON.stringify([
    ['api', 'repos/{owner}/{repo}/rules/branches/milestone%2Fci-wait'],
    ['api', 'repos/{owner}/{repo}/branches/milestone%2Fci-wait/protection/required_status_checks'],
  ]), 'api calls');
  eq(JSON.stringify(r.pb.calls[0].args), JSON.stringify(['pr', 'view', '7', '--json', 'headRefOid,baseRefName,state,statusCheckRollup']), 'pr view call');
});

test('a rerun: the latest run of a check wins, in either order', () => {
  const failedThenFixed = [bad('test', 'FAILURE', { startedAt: '2026-01-01T00:00:00Z' }), ok('test', { startedAt: '2026-01-01T00:05:00Z' })];
  eq(exec(['7'], gh(pr(failedThenFixed))).code, 0, 'fixed rerun');
  eq(exec(['7'], gh(pr([...failedThenFixed].reverse()))).code, 0, 'fixed rerun, array reversed');
  const passedThenBroke = [ok('test', { startedAt: '2026-01-01T00:00:00Z' }), bad('test', 'FAILURE', { startedAt: '2026-01-01T00:05:00Z' })];
  eq(exec(['7'], gh(pr(passedThenBroke))).code, 1, 'newer failure');
  eq(exec(['7'], gh(pr([...passedThenBroke].reverse()))).code, 1, 'newer failure, array reversed');
  const required = exec(['7'], gh(pr(failedThenFixed), { rules: rules('test') }));
  eq(required.code, 0, 'rerun with a required check');
});

test('the same job name in two workflows are two checks: a failure in one is not hidden', () => {
  const r = exec(['7'], gh(pr([ok('test', { workflowName: 'A' }), bad('test', 'FAILURE', { workflowName: 'B' })])));
  eq(r.code, 1, 'exit');
  eq(JSON.stringify(r.rec.failing), '["test"]', 'failing');
});

test('check conclusions: skipped and neutral pass; failure, cancelled, timed_out, action_required are red; running is pending', () => {
  for (const c of ['SUCCESS', 'SKIPPED', 'NEUTRAL']) eq(exec(['--once', '7'], gh(pr([bad('x', c)]))).code, 0, c);
  for (const c of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']) eq(exec(['--once', '7'], gh(pr([bad('x', c)]))).code, 1, c);
  eq(exec(['--once', '7'], gh(pr([run_('x', 'QUEUED', '')]))).code, 8, 'queued');
  eq(exec(['--once', '7'], gh(pr([run_('x', 'IN_PROGRESS', '')]))).code, 8, 'in progress');
  eq(exec(['--once', '7'], gh(pr([run_('x', 'COMPLETED', 'SOMETHING_NEW')]))).code, 8, 'unrecognised conclusion is never green');
});

test('status contexts count like check runs, and can be required', () => {
  eq(exec(['--once', '7'], gh(pr([ctxt('ci/jenkins', 'SUCCESS')]))).code, 0, 'success');
  eq(exec(['--once', '7'], gh(pr([ctxt('ci/jenkins', 'FAILURE')]))).code, 1, 'failure');
  eq(exec(['--once', '7'], gh(pr([ctxt('ci/jenkins', 'ERROR')]))).code, 1, 'error');
  eq(exec(['--once', '7'], gh(pr([ctxt('ci/jenkins', 'PENDING')]))).code, 8, 'pending');
  eq(exec(['--once', '7'], gh(pr([ctxt('ci/jenkins', 'EXPECTED')]))).code, 8, 'expected');
  const req = exec(['--once', '7'], gh(pr([ctxt('ci/jenkins', 'SUCCESS'), bad('other')]), { rules: rules('ci/jenkins') }));
  eq(req.code, 0, 'required status context');
});

test('a merged PR is reported with its state in the note', () => {
  const r = exec(['--once', '7'], gh(pr([ok('b')], { state: 'MERGED' })));
  assert(/PR is MERGED/.test(r.rec.note), r.rec.note);
});

console.log('ci-wait: GitLab');

test('GitLab: pipeline status maps to ci and exit code', () => {
  const table = [
    ['success', 'green', 0], ['failed', 'red', 1], ['canceled', 'red', 1],
    ['running', 'pending', 8], ['pending', 'pending', 8], ['created', 'pending', 8], ['waiting_for_resource', 'pending', 8],
    ['preparing', 'pending', 8], ['scheduled', 'pending', 8], ['manual', 'pending', 8],
    ['skipped', 'none', 3], [null, 'none', 3], ['something_new', 'unknown', 2],
  ];
  for (const [status, ci, code] of table) {
    const r = exec(['--once', '12'], { view: mr(status) }, { forgeName: 'gitlab' });
    eq(r.rec.ci, ci, `ci for ${status}`);
    eq(r.code, code, `exit for ${status}`);
    eq(r.rec.forge, 'gitlab', 'forge');
    eq(r.rec.head_sha, status === 'something_new' ? SHA : SHA, 'head_sha');
    eq(r.rec.required, null, 'required is null on GitLab');
  }
});

test('GitLab: manual gets a note; failed names the pipeline; calls are mr view only', () => {
  const man = exec(['--once', '12'], { view: mr('manual') }, { forgeName: 'gitlab' });
  assert(/manual action/.test(man.rec.note), man.rec.note);
  const red = exec(['--once', '12'], { view: mr('failed') }, { forgeName: 'gitlab' });
  eq(JSON.stringify(red.rec.failing), '["pipeline #55"]', 'failing');
  eq(JSON.stringify(red.pb.calls.map((c) => c.args)), JSON.stringify([['mr', 'view', '12', '--output', 'json']]), 'only one mr view call');
  eq(red.pb.calls[0].forge, 'gitlab', 'runner told it is glab');
});

test('GitLab: no pipeline waits out the grace period, then none; pending then success; head moved', () => {
  const none = exec(['12', '--interval', '30', '--grace', '60', '--timeout', '300'], { view: mr(null) }, { forgeName: 'gitlab' });
  eq(none.code, 3, 'none after grace');
  eq(none.pb.count('view'), 3, 'polls: 0, 30, 60');
  const skipped = exec(['12', '--interval', '30', '--grace', '60', '--timeout', '300'], { view: mr('skipped') }, { forgeName: 'gitlab' });
  eq(skipped.pb.count('view'), 3, 'skipped also gets the grace period');
  assert(/skipped/.test(skipped.rec.note), skipped.rec.note);
  const late = exec(['12', '--interval', '30'], { view: [mr(null), mr('running'), mr('success')] }, { forgeName: 'gitlab' });
  eq(late.code, 0, 'pipeline appears and passes');
  const moved = exec(['12', '--sha', 'e'.repeat(40)], { view: mr('success') }, { forgeName: 'gitlab' });
  eq(moved.code, 4, 'head moved');
  eq(moved.rec.sha_matches, false, 'sha_matches');
});

test('GitLab: a CLI error is unknown, with glab named in the note', () => {
  const r = exec(['12'], { view: { err: 'glab: 401 Unauthorized' } }, { forgeName: 'gitlab' });
  eq(r.code, 2, 'exit');
  assert(/glab mr view failed: glab: 401/.test(r.rec.note), r.rec.note);
});

console.log('ci-wait: --once with several requests');

test('--once: one line per request in argument order; exit is the worst', () => {
  const routes = {
    'view:1': pr([ok('b')]), 'view:2': pr([bad('b')]), 'view:3': pr([running('b')]), 'view:4': pr([]),
    rules: rules(), protection: NOT_PROTECTED,
  };
  const r = exec(['--once', '1', '2', '3', '4'], routes);
  eq(JSON.stringify(r.recs.map((x) => x.pr)), '[1,2,3,4]', 'order');
  eq(JSON.stringify(r.recs.map((x) => x.ci)), '["green","red","pending","none"]', 'ci per request');
  eq(r.code, 1, 'red outranks pending and none');
  eq(r.sleeps.length, 0, '--once never sleeps');
  eq(exec(['--once', '1', '3'], routes).code, 8, 'pending outranks green');
  eq(exec(['--once', '1', '4'], routes).code, 3, 'none outranks green');
  eq(exec(['--once', '1', '4', '--allow-none'], routes).code, 0, '--allow-none: none is fine');
  eq(exec(['--once', '3', '4', '--allow-none'], routes).code, 8, '--allow-none does not hide pending');
  eq(exec(['--once', '1'], routes).code, 0, 'single green');
});

test('--once: exit-code order is 2 > 4 > 1 > 8 > 3 > 0', () => {
  eq(ciWait.worst([0, 3, 8, 1, 4, 2]), 2, 'unknown first');
  eq(ciWait.worst([0, 3, 8, 1, 4]), 4, 'then head moved');
  eq(ciWait.worst([0, 3, 8, 1]), 1, 'then red');
  eq(ciWait.worst([0, 3, 8]), 8, 'then pending');
  eq(ciWait.worst([0, 3]), 3, 'then none');
  eq(ciWait.worst([0]), 0, 'green');
  eq(ciWait.worst([]), 0, 'nothing');
  eq(ciWait.worst([3, 2, 3]), 2, 'order does not matter');
});

test('--once: a request that errors is unknown for that request only; the rest are still reported', () => {
  const routes = { 'view:1': pr([ok('b')]), 'view:2': NOT_LOGGED_IN, 'view:3': pr([bad('b')]), rules: rules(), protection: NOT_PROTECTED };
  const r = exec(['--once', '1', '2', '3'], routes);
  eq(JSON.stringify(r.recs.map((x) => x.ci)), '["green","unknown","red"]', 'ci per request');
  eq(r.code, 2, 'unknown wins');
});

test('--once: a hung request is unknown for that request only', () => {
  const routes = { 'view:1': { hang: true }, 'view:2': pr([ok('b')]), rules: rules(), protection: NOT_PROTECTED };
  const r = exec(['--once', '1', '2'], routes);
  eq(r.recs.length, 2, 'both reported');
  eq(r.recs[0].ci, 'unknown', 'hung');
  assert(/timed out/.test(r.recs[0].note), r.recs[0].note);
  eq(r.recs[1].ci, 'green', 'the rest still run');
  eq(r.pb.calls.filter((c) => c.key === 'view:1').length, 1, 'the hung request is not retried');
});

test('budget: --once is one status call per request plus one required lookup (2 calls) per base', () => {
  const single = exec(['--once', '7'], gh(pr([ok('b')])));
  eq(single.pb.calls.length, 3, 'single request: view + rules + protection');
  const routes = { view: pr([ok('b')]), rules: rules(), protection: NOT_PROTECTED };
  const many = exec(['--once', '1', '2', '3'], routes);
  eq(many.pb.count('view'), 3, 'one status call each');
  eq(many.pb.count('rules'), 1, 'rulesets looked up once for the shared base');
  eq(many.pb.count('protection'), 1, 'protection looked up once for the shared base');
  const two = exec(['--once', '1', '2'], { 'view:1': pr([ok('b')], { base: 'main' }), 'view:2': pr([ok('b')], { base: 'dev' }), rules: rules(), protection: NOT_PROTECTED });
  eq(two.pb.count('rules'), 2, 'a different base is looked up again');
});

test('budget: wait mode makes at most 2 + ceil(timeout / interval) calls, never none for a deadline of 0', () => {
  const cases = [[540, 30], [100, 30], [10, 30], [0, 30], [60, 60], [45, 7], [1, 0.25]];
  for (const [timeout, interval] of cases) {
    const r = exec(['7', '--timeout', String(timeout), '--interval', String(interval), '--grace', '0'], gh(pr([running('b')])));
    const polls = Math.max(1, Math.ceil(timeout / interval));
    eq(r.pb.count('view'), polls, `status calls for ${timeout}/${interval}`);
    assert(r.pb.calls.length <= 2 + Math.ceil(timeout / interval) || timeout === 0, `total calls ${r.pb.calls.length} for ${timeout}/${interval}`);
    eq(r.code, 8, `exit for ${timeout}/${interval}`);
    assert(r.elapsed <= timeout, `ended at ${r.elapsed}s, deadline ${timeout}s`);
  }
  const zero = exec(['7', '--timeout', '0'], gh(pr([running('b')])));
  eq(zero.pb.count('view'), 1, 'timeout 0 still looks once');
  eq(zero.sleeps.length, 0, 'and does not sleep');
});

test('budget: the required lookup happens once per wait, not once per poll', () => {
  const r = exec(['7', '--timeout', '300', '--interval', '30'], gh(pr([running('b')]), { rules: rules('b') }));
  eq(r.pb.count('rules'), 1, 'rulesets');
  eq(r.pb.count('protection'), 1, 'protection');
  eq(r.pb.count('view'), 10, 'polls');
});

test('deadline: each call is limited to the call timeout and never runs past deadline + interval', () => {
  const r = exec(['7', '--timeout', '20', '--interval', '5', '--call-timeout', '100'], gh(pr([running('b')])), { callMs: 0 });
  const views = r.pb.calls.filter((c) => c.key.startsWith('view'));
  eq(views[0].timeout, 25000, 'first call: up to deadline + interval');
  eq(views[views.length - 1].timeout, 5000, 'last call at the deadline: one interval');
  for (const c of r.pb.calls) assert(c.timeout >= 1000 && c.timeout <= 100000, `timeout ${c.timeout}`);
  const slow = exec(['7', '--timeout', '100', '--interval', '30', '--call-timeout', '30'], gh(pr([running('b')])), { callMs: 10000 });
  assert(slow.elapsed <= 100 + 30 + 10, `calls that take time still end within deadline + interval: ${slow.elapsed}s`);
  assert(slow.rec.waited_s >= 100, `waited_s ${slow.rec.waited_s}`);
});

console.log('ci-wait: --names');

test('--names (GitHub): head checks, required checks, auto_merge_allowed; read-only calls', () => {
  const r = exec(['--names', '7'], gh(pr([ok('build'), ok('lint', { workflowName: 'Other' })]), { rules: rules('build'), repo: 'true\n' }));
  eq(r.code, 0, 'exit');
  eq(JSON.stringify(Object.keys(r.rec)), JSON.stringify(['pr', 'forge', 'head_sha', 'base', 'checks', 'required', 'auto_merge_allowed', 'note']), 'fields');
  eq(JSON.stringify(r.rec.checks), '["build","lint"]', 'checks');
  eq(JSON.stringify(r.rec.required), '["build"]', 'required');
  eq(r.rec.auto_merge_allowed, true, 'auto_merge_allowed');
  eq(r.rec.base, 'main', 'base');
  eq(JSON.stringify(r.pb.calls.map((c) => c.args)), JSON.stringify([
    ['pr', 'view', '7', '--json', 'headRefOid,baseRefName,state,statusCheckRollup'],
    ['api', 'repos/{owner}/{repo}/rules/branches/main'],
    ['api', 'repos/{owner}/{repo}/branches/main/protection/required_status_checks'],
    ['api', 'repos/{owner}/{repo}', '--jq', '.allow_auto_merge'],
  ]), 'exact calls');
  for (const c of r.pb.calls) {
    for (const a of c.args) assert(!/^(-X|--method|-f|-F|--field|--raw-field|--input|edit|merge|close)$/.test(a), `write-looking argument ${a}`);
  }
});

test('--names (GitHub): nothing required -> []; unreadable -> null with a note; auto-merge off and not visible', () => {
  const none = exec(['--names', '7'], gh(pr([ok('b')]), { repo: 'false' }));
  eq(JSON.stringify(none.rec.required), '[]', 'nothing required');
  eq(none.rec.auto_merge_allowed, false, 'auto-merge off');
  const hidden = exec(['--names', '7'], gh(pr([ok('b')]), { rules: FORBIDDEN, repo: 'null' }));
  eq(hidden.code, 0, 'unreadable settings are not an error');
  eq(hidden.rec.required, null, 'required unknown');
  eq(hidden.rec.auto_merge_allowed, null, 'auto_merge_allowed unknown');
  assert(/could not read the required checks/.test(hidden.rec.note) && /not visible/.test(hidden.rec.note), hidden.rec.note);
  const failedRepo = exec(['--names', '7'], gh(pr([ok('b')]), { repo: FORBIDDEN }));
  eq(failedRepo.rec.auto_merge_allowed, null, 'repo call failed');
  assert(/could not read the repo settings/.test(failedRepo.rec.note), failedRepo.rec.note);
});

test('--names: a PR that cannot be read is exit 2', () => {
  const r = exec(['--names', '7'], gh(NOT_LOGGED_IN));
  eq(r.code, 2, 'exit');
  eq(r.rec.ci, 'unknown', 'unknown');
  eq(r.pb.calls.length, 1, 'stops after the failed view');
});

test('--names (GitLab): job names of the head pipeline and the merge setting', () => {
  const r = exec(['--names', '12'], {
    view: mr('running'),
    jobs: JSON.stringify([{ name: 'build' }, { name: 'test' }, { name: 'test' }]),
    project: JSON.stringify({ only_allow_merge_if_pipeline_succeeds: true, name: 'app' }),
  }, { forgeName: 'gitlab' });
  eq(r.code, 0, 'exit');
  eq(JSON.stringify(r.rec.checks), '["build","test"]', 'job names, once each');
  eq(r.rec.only_allow_merge_if_pipeline_succeeds, true, 'setting');
  eq(r.rec.auto_merge_allowed, null, 'no repo-level auto-merge switch on GitLab');
  eq(r.rec.required, null, 'required');
  eq(JSON.stringify(r.pb.calls.map((c) => c.args)), JSON.stringify([
    ['mr', 'view', '12', '--output', 'json'],
    ['api', 'projects/:id/pipelines/55/jobs?per_page=100'],
    ['api', 'projects/:id'],
  ]), 'exact calls');
  const nopipe = exec(['--names', '12'], { view: mr(null), project: JSON.stringify({}) }, { forgeName: 'gitlab' });
  eq(nopipe.code, 0, 'no pipeline is not an error');
  eq(JSON.stringify(nopipe.rec.checks), '[]', 'no jobs');
  assert(/no pipeline/.test(nopipe.rec.note), nopipe.rec.note);
  eq(nopipe.rec.only_allow_merge_if_pipeline_succeeds, null, 'setting not in the output');
});

console.log('ci-wait: arguments');

test('arguments: bad input is exit 2 with usage on stderr and nothing on stdout, and no CLI call', () => {
  const bad_ = [
    [], ['abc'], ['0'], ['7', '8'], ['--once'], ['--once', ...Array.from({ length: 21 }, (_, i) => String(i + 1))],
    ['7', '--sha'], ['7', '--sha', 'xyz'], ['7', '--sha', 'abc'], ['7', '--timeout', '-1'], ['7', '--timeout', 'soon'],
    ['7', '--interval', '0'], ['7', '--call-timeout', '0'], ['--once', '1', '--names'], ['--names', '1', '--once'],
    ['--once', '1', '2', '--sha', 'a'.repeat(7)], ['7', '--bogus'], ['--names'], ['--names', '1', '2'],
  ];
  for (const argv of bad_) {
    const r = exec(argv, {});
    eq(r.code, 2, `exit for ${JSON.stringify(argv).slice(0, 60)}`);
    eq(r.raw.length, 0, 'nothing on stdout');
    assert(/usage: ci-wait\.js/.test(r.errs.join('\n')), 'usage on stderr');
    eq(r.pb.calls.length, 0, 'no CLI call');
  }
});

test('arguments: --flag=value, 20 requests, duplicates, and fractional seconds are accepted', () => {
  const ok20 = exec(['--once', ...Array.from({ length: 20 }, (_, i) => String(i + 1))], gh(pr([ok('b')])));
  eq(ok20.recs.length, 20, '20 requests');
  eq(ok20.code, 0, 'exit');
  const dup = exec(['--once', '5', '5'], gh(pr([ok('b')])));
  eq(dup.recs.length, 1, 'duplicates dropped');
  const inline = exec(['7', '--timeout=60', '--interval=30', '--grace=0', '--sha=' + SHA.slice(0, 8)], gh(pr([running('b')])));
  eq(inline.pb.count('view'), 2, '--timeout=60 --interval=30 -> 2 polls');
  eq(inline.rec.sha_matches, true, '--sha=');
  const frac = ciWait.parseArgs(['7', '--interval', '0.25', '--timeout', '1.5']);
  eq(frac.interval, 0.25, 'fractional interval'); eq(frac.timeout, 1.5, 'fractional timeout');
  const d = ciWait.parseArgs(['7']);
  eq(`${d.timeout}/${d.interval}/${d.grace}/${d.allowNone}`, '540/30/120/false', 'defaults');
});

// ---- forge.js status functions (unit) --------------------------------------
console.log('forge.js: CI status');

test('forge: requestStatus never throws and keeps CLI errors apart from "no checks"', () => {
  const failing = (e) => () => { throw e; };
  const e404 = Object.assign(new Error('x'), { stderr: 'gh: Could not resolve (HTTP 404)' });
  const r = forge.requestStatus('github', 5, '.', 1000, failing(e404));
  eq(r.ok, false, 'ok'); eq(r.notFound, true, 'notFound');
  const r2 = forge.requestStatus('github', 5, '.', 1000, () => '[]');
  eq(r2.ok, false, 'a JSON array is not a PR');
  const r3 = forge.requestStatus('github', 5, '.', 1000, () => pr([]));
  eq(r3.ok, true, 'a PR with no checks is ok'); eq(r3.checks.length, 0, 'no checks');
  const r4 = forge.requestStatus('gitlab', 5, '.', 1000, () => '{"iid":5}');
  eq(r4.ok, false, 'an MR without a sha is not ok');
});

test('forge: existing exports are unchanged', () => {
  for (const k of ['FORGES', 'detect', 'forgeOfUrl', 'hostOfUrl', 'viewArgs', 'fromGitlab', 'fromGithub', 'requestInfo', 'noun', 'viewCommand']) {
    assert(k in forge, `forge.${k}`);
  }
  eq(JSON.stringify(forge.viewArgs('github', { target: '5' })), JSON.stringify(['pr', 'view', '5', '--json', 'number,state,autoMergeRequest,baseRefName']), 'github viewArgs');
});

// ---- the real script, as a child process -----------------------------------
console.log('ci-wait: as a process');

function proc(argv, routes, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-ciwait-'));
  const file = (n) => path.join(dir, n);
  fs.writeFileSync(file('routes.json'), JSON.stringify(routes));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CI_WAIT, ...argv], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    env: {
      ...process.env, AGENT_TEAM_FORGE: 'github', AGENT_TEAM_FAKE_GH: FAKE_CLI, AGENT_TEAM_FAKE_GLAB: FAKE_CLI,
      FAKE_CI_ROUTES: file('routes.json'), FAKE_CI_STATE: file('state.json'), FAKE_CI_LOG: file('log.jsonl'), FAKE_CI_PID: file('pids.txt'), ...env,
    },
  });
  const read = (n) => (fs.existsSync(file(n)) ? fs.readFileSync(file(n), 'utf8').trim().split('\n').filter(Boolean) : []);
  return {
    status: r.status, signal: r.signal, stderr: r.stderr, elapsed: (Date.now() - t0) / 1000,
    lines: r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    calls: read('log.jsonl').map((l) => JSON.parse(l)), pids: read('pids.txt').map(Number),
    dir,
  };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const viewCalls = (p) => p.calls.filter((a) => a[1] === 'view');

test('process: green through the real script and stand-in gh, with the real argument array', () => {
  const p = proc(['7'], gh(pr([ok('build')])));
  eq(p.status, 0, `exit (stderr: ${p.stderr})`);
  eq(p.lines.length, 1, 'one line');
  eq(p.lines[0].ci, 'green', 'ci');
  eq(JSON.stringify(p.calls[0]), JSON.stringify(['pr', 'view', '7', '--json', 'headRefOid,baseRefName,state,statusCheckRollup']), 'gh arguments');
});

test('process: pending then green waits one real interval', () => {
  const p = proc(['7', '--interval', '0.3', '--timeout', '10', '--grace', '0'], gh([pr([running('b')]), pr([ok('b')])]));
  eq(p.status, 0, `exit (stderr: ${p.stderr})`);
  eq(viewCalls(p).length, 2, 'polls');
  assert(p.lines[0].waited_s >= 0.3, `waited_s ${p.lines[0].waited_s}`);
});

test('process: pending until a real deadline is honoured to within one interval', () => {
  const p = proc(['7', '--interval', '0.3', '--timeout', '0.9', '--grace', '0'], gh(pr([running('b')])));
  eq(p.status, 8, `exit (stderr: ${p.stderr})`);
  eq(viewCalls(p).length, 3, 'ceil(0.9/0.3) polls');
  const w = p.lines[0].waited_s;
  assert(w >= 0.8 && w <= 0.9 + 0.3 + 3, `waited_s ${w}`);
  eq(p.pids.length, 0, 'nothing left hanging');
});

test('process: a hung gh is killed at the call timeout, reported unknown, and the next request still runs', () => {
  const p = proc(['--once', '1', '2', '--call-timeout', '1'], { 'view:1': { hang: true }, 'view:2': pr([ok('b')]), rules: rules(), protection: NOT_PROTECTED });
  eq(p.pids.length, 1, 'precondition: the stand-in started hanging');
  eq(p.status, 2, `exit (stderr: ${p.stderr})`);
  eq(p.lines.length, 2, 'both requests reported');
  eq(p.lines[0].ci, 'unknown', 'hung request');
  assert(/timed out/.test(p.lines[0].note), p.lines[0].note);
  eq(p.lines[1].ci, 'green', 'second request');
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) { gone = !alive(p.pids[0]); if (!gone) pause(100); }
  assert(gone, `child ${p.pids[0]} is still running after ci-wait exited`);
  assert(p.elapsed < 30, `took ${p.elapsed}s`);
});

test('process: a hang during a wait is killed and reported unknown at once on the first look', () => {
  const p = proc(['7', '--call-timeout', '1', '--timeout', '30', '--interval', '5'], gh({ hang: true }));
  eq(p.pids.length, 1, 'precondition: hang reached');
  eq(p.status, 2, 'exit');
  eq(p.lines[0].ci, 'unknown', 'ci');
  assert(p.elapsed < 15, `did not wait out the deadline: ${p.elapsed}s`);
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) { gone = !alive(p.pids[0]); if (!gone) pause(100); }
  assert(gone, 'child killed');
  // recovery control: the same command against a healthy CLI works
  eq(proc(['7', '--call-timeout', '1'], gh(pr([ok('b')]))).status, 0, 'healthy CLI');
});

test('process: GitLab is picked from AGENT_TEAM_FORGE and runs glab mr view', () => {
  const p = proc(['--once', '12'], { view: mr('success') }, { AGENT_TEAM_FORGE: 'gitlab' });
  eq(p.status, 0, `exit (stderr: ${p.stderr})`);
  eq(p.lines[0].forge, 'gitlab', 'forge');
  eq(JSON.stringify(p.calls[0]), JSON.stringify(['mr', 'view', '12', '--output', 'json']), 'glab arguments');
});

test('process: usage errors exit 2 with nothing on stdout', () => {
  const p = proc([], {});
  eq(p.status, 2, 'exit');
  eq(p.lines.length, 0, 'stdout');
  assert(/usage: ci-wait\.js/.test(p.stderr), p.stderr);
});

test('process: exit codes for red, none and head moved', () => {
  eq(proc(['--once', '7'], gh(pr([bad('b')]))).status, 1, 'red');
  eq(proc(['--once', '7'], gh(pr([]))).status, 3, 'none');
  eq(proc(['--once', '7', '--allow-none'], gh(pr([]))).status, 0, 'none allowed');
  eq(proc(['--once', '7', '--sha', 'f'.repeat(40)], gh(pr([ok('b')]))).status, 4, 'head moved');
});
