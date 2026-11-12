// Merge command shapes the Director uses with CI-gated and auto-merge calls
// (decision 0012): `--auto` / `--disable-auto` / glab `--auto-merge` into a
// milestone base, the chained "CI gate && merge && comment" call in sh and
// PowerShell 5.1, and redirections such as `2>&1` that must not be read as a
// PR number. Every test asserts which PR the fake gh / glab was asked about (the
// precondition), not only the verdict.
// Loaded and run by tests/run.js: node tests/run.js
'use strict';

const fs = require('fs');
const path = require('path');
const { SCRIPTS, tmpProject, run, fakeGh, fakeGlab, readLog, test, assert, eq } = require('./helpers');

const lib = require(path.join(SCRIPTS, 'lib.js'));

const pr = (n, base, extra = {}) => JSON.stringify({ number: n, state: 'OPEN', autoMergeRequest: null, baseRefName: base, ...extra });
const mr = (iid, state, target) => JSON.stringify({ iid, state, target_branch: target, merge_when_pipeline_succeeds: false });

const proj = tmpProject();
let seq = 0;

// The lookups the fake CLI received, one array of arguments per call.
function calls(file) {
  if (!fs.existsSync(file)) return [];
  const out = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  fs.rmSync(file);
  return out;
}
const argsFile = () => path.join(proj, `args-${process.pid}-${seq++}.jsonl`);

// Run the guard; returns { denied, reason, lookups } where lookups are the
// joined arguments of each fake gh / glab call.
function guard(command, env) {
  const file = argsFile();
  const r = run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: proj }, proj, { ...env, FAKE_GH_ARGS: file });
  let out = {};
  try { out = JSON.parse(r.stdout).hookSpecificOutput || {}; } catch { /* allowed: no output */ }
  return { denied: out.permissionDecision === 'deny', reason: out.permissionDecisionReason || '', lookups: calls(file).map((a) => a.join(' ')) };
}

const GH_VIEW = (n) => `pr view${n ? ' ' + n : ''} --json number,state,autoMergeRequest,baseRefName`;
const GL_VIEW = (n) => `mr view${n ? ' ' + n : ''} --output json`;

console.log('lib.segments: redirections');

test('segments: redirections are not arguments and do not break the segment', () => {
  const seg = (cmd) => JSON.stringify(lib.segments(cmd));
  const squash = JSON.stringify([['gh', 'pr', 'merge', '--squash']]);
  for (const redirect of ['2>&1', '>&2', '1>&2', '&>out.log', '&>>out.log', '2>/dev/null', '2>$null', '*>&1', '>out.txt', '> out.txt',
    '>>out.txt', '2>>out.txt', '1> out.txt', '>|out.txt', '>"out file.txt"', '2>&1 >/dev/null']) {
    eq(seg(`gh pr merge --squash ${redirect}`), squash, `redirect ${redirect}`);
  }
  eq(seg('gh pr merge --squash 2>&1 | tee x'), JSON.stringify([['gh', 'pr', 'merge', '--squash'], ['tee', 'x']]), 'a pipe after the redirect still splits');
  eq(seg('gh pr merge 5 2>&1 && git status'), JSON.stringify([['gh', 'pr', 'merge', '5'], ['git', 'status']]), '&& after the redirect still splits');
  eq(seg('gh pr merge 5 >out.txt; git push origin main'), JSON.stringify([['gh', 'pr', 'merge', '5'], ['git', 'push', 'origin', 'main']]), '; after the redirect target');
});

test('segments: only a bare glued number is a file descriptor', () => {
  eq(JSON.stringify(lib.segments('echo a2>f')), JSON.stringify([['echo', 'a2']]), 'a2> keeps a2');
  eq(JSON.stringify(lib.segments('echo "2">f')), JSON.stringify([['echo', '2']]), 'a quoted 2 is an argument');
  eq(JSON.stringify(lib.segments('git push origin main>out.txt')), JSON.stringify([['git', 'push', 'origin', 'main']]), 'branch glued to >');
  eq(JSON.stringify(lib.segments('gh pr merge 2 >out.txt')), JSON.stringify([['gh', 'pr', 'merge', '2']]), 'a spaced 2 is an argument');
});

test('segments: a command substitution after > is still read', () => {
  eq(JSON.stringify(lib.segments('cat > >(git push origin main)')), JSON.stringify([['cat'], ['git', 'push', 'origin', 'main']]), 'process substitution');
  eq(JSON.stringify(lib.segments('echo hi > $(git push origin main)')), JSON.stringify([['echo', 'hi'], ['git', 'push', 'origin', 'main']]), 'command substitution');
});

test('findMerges: the target is the number, or null when only a redirect follows', () => {
  const t = (cmd) => lib.findMerges(cmd).map((m) => `${m.forge}:${m.target}`).join(',');
  eq(t('gh pr merge --squash 2>&1'), 'github:null', 'gh 2>&1');
  eq(t('gh pr merge --squash >&2'), 'github:null', 'gh >&2');
  eq(t('gh pr merge --squash &>out.log'), 'github:null', 'gh &>file');
  eq(t('gh pr merge --squash 2>out.log'), 'github:null', 'gh 2>file');
  eq(t('gh pr merge --squash > out.log'), 'github:null', 'gh > file');
  eq(t('gh pr merge 7 --squash 2>&1 | tee x'), 'github:7', 'gh 7 then pipe');
  eq(t('glab mr merge --squash 2>/dev/null'), 'gitlab:null', 'glab 2>/dev/null');
  eq(t('glab mr merge 8 --yes 2>&1'), 'gitlab:8', 'glab 8');
});

// Review of 05d4cb1: `&>` takes no file descriptor, so a number glued to it is
// the argument. On 05d4cb1 these gave target null (the current branch).
test('findMerges: a number glued to `&>` / `&>>` is the target', () => {
  const t = (cmd) => lib.findMerges(cmd).map((m) => `${m.forge}:${m.target}`).join(',');
  eq(t('gh pr merge 5&>/dev/null'), 'github:5', 'gh 5&>/dev/null');
  eq(t('gh pr merge 5&>>f'), 'github:5', 'gh 5&>>f');
  eq(t('gh pr merge 5 &>f'), 'github:5', 'gh 5 &>f (spaced)');
  eq(t('gh pr merge 12&>f'), 'github:12', 'gh 12&>f (multi-digit)');
  eq(t('glab mr merge 8&>/dev/null'), 'gitlab:8', 'glab 8&>/dev/null');
  eq(JSON.stringify(lib.segments('gh pr merge 5&>f').readings), undefined, 'one reading: every shell agrees');
});

test('segments: a glued 1-6 is a stream number in every shell; a quoted word is an argument', () => {
  const merge = JSON.stringify([['gh', 'pr', 'merge']]);
  for (const redirect of ['1>f', '2>&1', '5>>f', '5>&1', '6>f', '3>&1']) {
    const segs = lib.segments(`gh pr merge ${redirect}`);
    eq(JSON.stringify(segs), merge, `${redirect} dropped`);
    eq(segs[0].readings, undefined, `${redirect}: one reading`);
  }
  const quoted = lib.segments('gh pr merge "7">out');
  eq(JSON.stringify(quoted), JSON.stringify([['gh', 'pr', 'merge', '7']]), 'a quoted 7 is an argument');
  eq(quoted[0].readings, undefined, 'quoted: one reading');
});

test('segments: any other word glued to `>` gets a bash and a PowerShell reading', () => {
  const r = (cmd) => {
    const [seg] = lib.segments(cmd);
    assert(seg.readings, `${cmd}: has readings`);
    return JSON.stringify({ seg, sh: seg.readings.sh, ps: seg.readings.ps });
  };
  const m = ['gh', 'pr', 'merge'];
  const want = (seg, sh, ps) => JSON.stringify({ seg, sh, ps });
  // Bash: a file descriptor. PowerShell (only streams 1-6 and *): one literal argument.
  eq(r('gh pr merge 7>out'), want(m, m, [...m, '7>out']), '7>out');
  eq(r('gh pr merge 12>out'), want(m, m, [...m, '12>out']), '12>out');
  eq(r('gh pr merge 0>out'), want(m, m, [...m, '0>out']), '0>out');
  eq(r('gh pr merge 7>>f'), want(m, m, [...m, '7>>f']), '7>>f');
  eq(r('gh pr merge 12>&1'), want(m, m, [...m, '12>&1']), '12>&1');
  eq(r('gh pr merge 7> out'), want(m, m, [...m, '7>', 'out']), '7> out (PowerShell: two arguments)');
  // Bash: an argument (a glob for *). PowerShell: a literal, or the * stream.
  eq(r('gh pr merge feat>out'), want([...m, 'feat'], [...m, 'feat'], [...m, 'feat>out']), 'feat>out');
  eq(r('gh pr merge x"7">f'), want([...m, 'x7'], [...m, 'x7'], [...m, 'x7>f']), 'partly quoted');
  eq(r('gh pr merge --squash *>&1'), want([...m, '--squash'], [...m, '--squash', '*'], [...m, '--squash']), '*>&1');
  // The rest of the line is still read in both.
  eq(r('gh pr merge 7>out; git status'), want(m, m, [...m, '7>out']), 'first segment before ;');
  eq(JSON.stringify(lib.segments('gh pr merge 7>out; git status')[1]), JSON.stringify(['git', 'status']), 'second segment');
});

test('ambiguousMerge: only when the readings name different requests', () => {
  const a = (cmd) => JSON.stringify(lib.ambiguousMerge(lib.segments(cmd)[0]));
  eq(a('gh pr merge 7>out'), JSON.stringify({ sh: 'PR (current branch)', ps: 'PR 7>out' }), '7>out');
  eq(a('gh pr merge 12>out'), JSON.stringify({ sh: 'PR (current branch)', ps: 'PR 12>out' }), '12>out');
  eq(a('gh pr merge --squash *>&1'), JSON.stringify({ sh: 'PR *', ps: 'PR (current branch)' }), '*>&1');
  eq(a('gh pr merge -R o/r feat>out'), JSON.stringify({ sh: 'PR feat in o/r', ps: 'PR feat>out in o/r' }), 'with a repo');
  eq(a('glab mr merge 7>out'), JSON.stringify({ sh: 'MR (current branch)', ps: 'MR 7>out' }), 'glab');
  eq(a('gh>out pr merge 5'), JSON.stringify({ sh: 'PR 5', ps: 'no merge' }), 'a glued command word');
  // The target comes first, so the glued word can't change it.
  eq(a('gh pr merge 5 7>out'), 'null', '5 then 7>out');
  eq(a('gh pr merge 5 *>&1'), 'null', '5 then *>&1');
  eq(a('gh pr merge 5 12>&1'), 'null', '5 then 12>&1');
  eq(a('gh pr merge 7 2>&1'), 'null', 'one reading');
  eq(a('echo 7>out'), 'null', 'no merge in any reading');
  eq(lib.ambiguousMerge(undefined), null, 'no segment');
});

console.log('merge shapes: findMerges on chained calls');

const SH_GH = 'node "/p/scripts/ci-wait.js" 5 --once --sha abc && gh pr merge 5 --squash --delete-branch --match-head-commit abc && gh pr comment 5 -b "Merged by Director"';
const PS_GH = 'node "C:\\p\\scripts\\ci-wait.js" 5 --once --sha abc; if ($LASTEXITCODE -eq 0) { gh pr merge 5 --squash --delete-branch --match-head-commit abc; if ($LASTEXITCODE -eq 0) { gh pr comment 5 -b "Merged by Director" } }';
const SH_GL = 'node "/p/scripts/ci-wait.js" 5 --once --sha abc && glab mr merge 5 --squash --remove-source-branch --yes --sha abc && glab mr note 5 -m "Merged by Director"';
const PS_GL = 'node "C:\\p\\scripts\\ci-wait.js" 5 --once --sha abc; if ($LASTEXITCODE -eq 0) { glab mr merge 5 --squash --remove-source-branch --yes --sha abc; if ($LASTEXITCODE -eq 0) { glab mr note 5 -m "Merged by Director" } }';
const SH_GH_AUTO = 'node "/p/scripts/ci-wait.js" 5 --once --sha abc && gh pr merge 5 --auto --squash --delete-branch --match-head-commit abc && gh pr comment 5 -b "Queued by Director"';

const chains = [
  ['sh gh', SH_GH, 'github'],
  ['PowerShell gh', PS_GH, 'github'],
  ['sh glab', SH_GL, 'gitlab'],
  ['PowerShell glab', PS_GL, 'gitlab'],
  ['sh gh with --auto', SH_GH_AUTO, 'github'],
];
for (const [name, cmd, forgeName] of chains) {
  test(`findMerges: ${name} chain has exactly one merge, target 5`, () => {
    const merges = lib.findMerges(cmd);
    eq(merges.length, 1, 'merge count');
    eq(merges[0].forge, forgeName, 'forge');
    eq(merges[0].target, '5', 'target');
    eq(merges[0].repo, null, 'repo');
  });
}

test('findMerges: --match-head-commit and --sha values are not read as the target', () => {
  const [g] = lib.findMerges('gh pr merge --squash --match-head-commit abc123');
  eq(g.target, null, 'gh value skipped');
  const [l] = lib.findMerges('glab mr merge --squash --sha abc123');
  eq(l.target, null, 'glab value skipped');
});

console.log('guard.js: auto-merge and merge shapes');

const GH_MERGES = [
  ['--auto --squash --delete-branch', 'gh pr merge 5 --auto --squash --delete-branch'],
  ['--auto with --match-head-commit', 'gh pr merge 5 --auto --squash --delete-branch --match-head-commit abc123'],
  ['--disable-auto', 'gh pr merge 5 --disable-auto'],
];
const GL_MERGES = [
  ['--auto-merge with --sha', 'glab mr merge 5 --auto-merge --squash --remove-source-branch --yes --sha abc123'],
];

for (const [name, cmd] of GH_MERGES) {
  test(`guard: gh pr merge ${name} is allowed into a milestone base`, () => {
    const r = guard(cmd, fakeGh(pr(5, 'milestone/auth')));
    eq(r.lookups.join('|'), GH_VIEW(5), 'asked gh about PR 5');
    assert(!r.denied, `should allow: ${r.reason}`);
  });
  for (const base of ['main', 'master']) {
    test(`guard: gh pr merge ${name} is denied into ${base}`, () => {
      const r = guard(cmd, fakeGh(pr(5, base)));
      eq(r.lookups.join('|'), GH_VIEW(5), 'asked gh about PR 5');
      assert(r.denied, 'should deny');
      assert(r.reason.includes(`protected branch "${base}"`), `reason: ${r.reason}`);
    });
  }
  test(`guard: gh pr merge ${name} is denied when the base cannot be confirmed`, () => {
    const r = guard(cmd, fakeGh('', 1));
    eq(r.lookups.join('|'), GH_VIEW(5), 'asked gh about PR 5');
    assert(r.denied, 'should deny');
    assert(r.reason.includes('could not confirm the base branch of PR 5'), `reason: ${r.reason}`);
  });
}

for (const [name, cmd] of GL_MERGES) {
  test(`guard: glab mr merge ${name} is allowed into a milestone target`, () => {
    const r = guard(cmd, fakeGlab(mr(5, 'opened', 'milestone/auth')));
    eq(r.lookups.join('|'), GL_VIEW(5), 'asked glab about MR 5');
    assert(!r.denied, `should allow: ${r.reason}`);
  });
  for (const base of ['main', 'master']) {
    test(`guard: glab mr merge ${name} is denied into ${base}`, () => {
      const r = guard(cmd, fakeGlab(mr(5, 'opened', base)));
      eq(r.lookups.join('|'), GL_VIEW(5), 'asked glab about MR 5');
      assert(r.denied, 'should deny');
      assert(r.reason.includes(`protected branch "${base}"`), `reason: ${r.reason}`);
    });
  }
  test(`guard: glab mr merge ${name} is denied when the target cannot be confirmed`, () => {
    const r = guard(cmd, fakeGlab('', 1));
    eq(r.lookups.join('|'), GL_VIEW(5), 'asked glab about MR 5');
    assert(r.denied, 'should deny');
    assert(r.reason.includes('could not confirm the base branch of MR 5'), `reason: ${r.reason}`);
  });
}

test('guard: --admin is denied on any base, before any lookup', () => {
  const r = guard('gh pr merge 5 --admin --auto --squash', fakeGh(pr(5, 'milestone/auth')));
  assert(r.denied, 'should deny');
  assert(r.reason.includes('--admin'), `reason: ${r.reason}`);
  eq(r.lookups.length, 0, 'no lookup, the flag alone decides');
  const chained = guard('node ci-wait.js 5 --once && gh pr merge 5 --admin --squash', fakeGh(pr(5, 'milestone/auth')));
  assert(chained.denied && chained.reason.includes('--admin'), `chained --admin: ${chained.reason}`);
});

test('guard: GraphQL auto-merge mutations are still denied', () => {
  const gh = guard("gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'", fakeGh(pr(5, 'milestone/auth')));
  assert(gh.denied && gh.reason.includes('enablePullRequestAutoMerge'), `gh graphql: denied=${gh.denied} ${gh.reason}`);
  const gl = guard("glab api graphql -f query='mutation { mergeRequestSetAutoMerge(input: {iid: \"5\"}) { errors } }'", fakeGlab(mr(5, 'opened', 'milestone/auth')));
  assert(gl.denied && gl.reason.includes('mergeRequestSetAutoMerge'), `glab graphql: denied=${gl.denied} ${gl.reason}`);
});

test('guard: glab cancel_merge_when_pipeline_succeeds is allowed, with no lookup', () => {
  // A lookup that fails would block, so passing also shows the path is not read as a merge.
  const r = guard('glab api -X POST projects/:id/merge_requests/5/cancel_merge_when_pipeline_succeeds', fakeGlab('', 1));
  eq(r.lookups.length, 0, 'no merge lookup');
  assert(!r.denied, `should allow: ${r.reason}`);
  // Control: queueing the auto-merge over REST is still checked against the target.
  const queue = guard('glab api -X PUT projects/:id/merge_requests/5/merge_when_pipeline_succeeds', fakeGlab(mr(5, 'opened', 'main')));
  eq(queue.lookups.join('|'), GL_VIEW(5), 'asked glab about MR 5');
  assert(queue.denied, 'merge_when_pipeline_succeeds into main is denied');
});

console.log('guard.js: chained CI-gate merge calls');

for (const [name, cmd, forgeName] of chains) {
  const fake = forgeName === 'gitlab' ? fakeGlab : fakeGh;
  const view = forgeName === 'gitlab' ? GL_VIEW : GH_VIEW;
  const info = (base) => (forgeName === 'gitlab' ? mr(5, 'opened', base) : pr(5, base));
  test(`guard: ${name} chain is allowed into a milestone, one lookup of 5`, () => {
    const r = guard(cmd, fake(info('milestone/auth')));
    eq(r.lookups.join('|'), view(5), 'asked about 5, once');
    assert(!r.denied, `should allow: ${r.reason}`);
  });
  test(`guard: ${name} chain is denied into main`, () => {
    const r = guard(cmd, fake(info('main')));
    eq(r.lookups.join('|'), view(5), 'asked about 5, once');
    assert(r.denied && r.reason.includes('protected branch "main"'), `reason: ${r.reason}`);
  });
  test(`guard: ${name} chain is denied when the base cannot be confirmed`, () => {
    const r = guard(cmd, fake('', 1));
    eq(r.lookups.join('|'), view(5), 'asked about 5, once');
    assert(r.denied && r.reason.includes('could not confirm'), `reason: ${r.reason}`);
  });
}

console.log('guard.js: redirections after a merge');

test('guard: `gh pr merge --squash 2>&1` asks about the current branch, not PR 2', () => {
  const ok = guard('gh pr merge --squash 2>&1', fakeGh(pr(11, 'milestone/auth')));
  eq(ok.lookups.join('|'), GH_VIEW(null), 'no number in the lookup');
  assert(!ok.denied, `milestone allowed: ${ok.reason}`);
  // Fail-open check: before the fix the lookup was for PR 2, so a main-based current-branch PR got through.
  const bad = guard('gh pr merge --squash 2>&1', fakeGh(pr(11, 'main')));
  eq(bad.lookups.join('|'), GH_VIEW(null), 'no number in the lookup');
  assert(bad.denied && bad.reason.includes('PR (current branch) targets protected branch "main"'), `main denied: ${bad.reason}`);
});

test('guard: other redirect forms leave the target alone', () => {
  for (const redirect of ['>&2', '&>out.log', '2>out.log', '2>>out.log', '>out.log', '2>$null']) {
    const r = guard(`gh pr merge --squash ${redirect}`, fakeGh(pr(11, 'milestone/auth')));
    eq(r.lookups.join('|'), GH_VIEW(null), `lookup for ${redirect}`);
    assert(!r.denied, `${redirect}: ${r.reason}`);
  }
});

test('guard: `gh pr merge 7 --squash 2>&1 | tee x` asks about PR 7', () => {
  const r = guard('gh pr merge 7 --squash 2>&1 | tee x', fakeGh(pr(7, 'milestone/auth')));
  eq(r.lookups.join('|'), GH_VIEW(7), 'asked about 7');
  assert(!r.denied, `milestone allowed: ${r.reason}`);
  const bad = guard('gh pr merge 7 --squash 2>&1 | tee x', fakeGh(pr(7, 'main')));
  eq(bad.lookups.join('|'), GH_VIEW(7), 'asked about 7');
  assert(bad.denied, 'main denied');
});

test('guard: `glab mr merge --squash 2>/dev/null` asks about the current branch', () => {
  const ok = guard('glab mr merge --squash 2>/dev/null', fakeGlab(mr(11, 'opened', 'milestone/auth')));
  eq(ok.lookups.join('|'), GL_VIEW(null), 'no number in the lookup');
  assert(!ok.denied, `milestone allowed: ${ok.reason}`);
  const bad = guard('glab mr merge --squash 2>/dev/null', fakeGlab(mr(11, 'opened', 'main')));
  eq(bad.lookups.join('|'), GL_VIEW(null), 'no number in the lookup');
  assert(bad.denied && bad.reason.includes('MR (current branch) targets protected branch "main"'), `main denied: ${bad.reason}`);
});

test('guard: a redirect does not hide a later push to main', () => {
  const r = guard('gh pr merge 5 --squash >out.log; git push origin main', fakeGh(pr(5, 'milestone/auth')));
  eq(r.lookups.join('|'), GH_VIEW(5), 'merge still asked about 5');
  assert(r.denied && r.reason.includes('push to protected branch "main"'), `push denied: ${r.reason}`);
});

console.log('guard.js: numbers glued to a redirection');

// Review of 05d4cb1 finding 1: on 05d4cb1 these asked about the current branch
// (lookup without a number), so a main-based PR 5 passed when the current branch's PR was on a milestone.
for (const cmd of ['gh pr merge 5&>/dev/null', 'gh pr merge 5&>>f', 'gh pr merge 5 &>f', 'gh pr merge 5&>f']) {
  test(`guard: \`${cmd}\` asks about PR 5`, () => {
    const bad = guard(cmd, fakeGh(pr(5, 'main')));
    eq(bad.lookups.join('|'), GH_VIEW(5), 'asked gh about PR 5');
    assert(bad.denied && bad.reason.includes('PR 5 targets protected branch "main"'), `main denied: ${bad.reason}`);
    const ok = guard(cmd, fakeGh(pr(5, 'milestone/auth')));
    eq(ok.lookups.join('|'), GH_VIEW(5), 'asked gh about PR 5');
    assert(!ok.denied, `milestone allowed: ${ok.reason}`);
  });
}

test('guard: `glab mr merge 8&>/dev/null` asks about MR 8', () => {
  const bad = guard('glab mr merge 8&>/dev/null', fakeGlab(mr(8, 'opened', 'main')));
  eq(bad.lookups.join('|'), GL_VIEW(8), 'asked glab about MR 8');
  assert(bad.denied && bad.reason.includes('MR 8 targets protected branch "main"'), `main denied: ${bad.reason}`);
});

// A lone 1-6 glued to `>`, `>>` or `>&` is a stream number in bash, PowerShell and cmd alike.
for (const redirect of ['2>&1', '5>>f', '5>&1', '1>out']) {
  test(`guard: \`gh pr merge ${redirect}\` asks about the current branch`, () => {
    const bad = guard(`gh pr merge ${redirect}`, fakeGh(pr(11, 'main')));
    eq(bad.lookups.join('|'), GH_VIEW(null), 'no number in the lookup');
    assert(bad.denied && bad.reason.includes('PR (current branch) targets protected branch "main"'), `main denied: ${bad.reason}`);
    const ok = guard(`gh pr merge ${redirect}`, fakeGh(pr(11, 'milestone/auth')));
    eq(ok.lookups.join('|'), GH_VIEW(null), 'no number in the lookup');
    assert(!ok.denied, `milestone allowed: ${ok.reason}`);
  });
}

// Finding 3: bash reads `7>out` as fd 7, PowerShell as the argument "7>out" (only
// streams 1-6 and * redirect). The guard can't tell which shell runs it, so it
// refuses rather than check one request while the shell merges another.
const AMBIGUOUS = [
  ['gh pr merge 7>out', 'bash merges PR (current branch), PowerShell merges PR 7>out'],
  ['gh pr merge 12>out', 'bash merges PR (current branch), PowerShell merges PR 12>out'],
  ['gh pr merge 0>out', 'bash merges PR (current branch), PowerShell merges PR 0>out'],
  ['gh pr merge 7>>out', 'bash merges PR (current branch), PowerShell merges PR 7>>out'],
  ['gh pr merge 12>&1', 'bash merges PR (current branch), PowerShell merges PR 12>&1'],
  ['gh pr merge 7> out', 'bash merges PR (current branch), PowerShell merges PR 7>'],
  ['gh pr merge --squash *>&1', 'bash merges PR *, PowerShell merges PR (current branch)'],
  ['gh pr merge feat>out', 'bash merges PR feat, PowerShell merges PR feat>out'],
  ['glab mr merge 7>out', 'bash merges MR (current branch), PowerShell merges MR 7>out'],
  ['node ci-wait.js 5 --once && gh pr merge 7>out && gh pr comment 5 -b ok', 'bash merges PR (current branch), PowerShell merges PR 7>out'],
];
for (const [cmd, readings] of AMBIGUOUS) {
  test(`guard: \`${cmd}\` is denied: the target depends on the shell`, () => {
    // The fake would allow (milestone base), so the deny comes from the ambiguity, before any lookup.
    const fake = cmd.startsWith('glab') ? fakeGlab(mr(7, 'opened', 'milestone/auth')) : fakeGh(pr(7, 'milestone/auth'));
    const r = guard(cmd, fake);
    assert(r.denied, 'should deny');
    assert(r.reason.includes(`the merge target depends on the shell: ${readings}.`), `reason: ${r.reason}`);
    assert(r.reason.includes('put a space before `>`, or quote the word'), `how to fix: ${r.reason}`);
    eq(r.lookups.length, 0, 'no lookup');
  });
}

test('guard: written so both shells agree, the same merges are checked normally', () => {
  // Recovery control for the ambiguous shapes above: a space or quotes make it one reading.
  for (const [cmd, n] of [['gh pr merge 7 >out', 7], ['gh pr merge "7">out', 7], ['gh pr merge 7 2>&1', 7], ['gh pr merge 12 >out', 12]]) {
    const ok = guard(cmd, fakeGh(pr(n, 'milestone/auth')));
    eq(ok.lookups.join('|'), GH_VIEW(n), `${cmd}: asked about ${n}`);
    assert(!ok.denied, `${cmd}: milestone allowed: ${ok.reason}`);
    const bad = guard(cmd, fakeGh(pr(n, 'main')));
    eq(bad.lookups.join('|'), GH_VIEW(n), `${cmd}: asked about ${n}`);
    assert(bad.denied, `${cmd}: main denied`);
  }
});

test('guard: a glued word after the target is not ambiguous, and is looked up once', () => {
  for (const cmd of ['gh pr merge 5 7>out', 'gh pr merge 5 12>&1', 'gh pr merge 5 --squash *>&1']) {
    const ok = guard(cmd, fakeGh(pr(5, 'milestone/auth')));
    // Both readings are checked; the second reuses the first lookup.
    eq(ok.lookups.join('|'), GH_VIEW(5), `${cmd}: asked about 5, once`);
    assert(!ok.denied, `${cmd}: milestone allowed: ${ok.reason}`);
    const bad = guard(cmd, fakeGh(pr(5, 'main')));
    eq(bad.lookups.join('|'), GH_VIEW(5), `${cmd}: asked about 5, once`);
    assert(bad.denied && bad.reason.includes('PR 5 targets protected branch "main"'), `${cmd}: main denied: ${bad.reason}`);
  }
});

test('guard: a push only PowerShell would make (`7>x:main`) is checked too', () => {
  // Precondition: with stream 2 every shell reads a redirect and no refspec, and
  // the test folder has no protected current branch, so that is allowed.
  const control = guard('git push origin 2>x:main', {});
  assert(!control.denied, `2>x:main allowed: ${control.reason}`);
  // Bash: fd 7 to a file, no refspec. PowerShell: refspec "7>x:main", a push to main.
  const r = guard('git push origin 7>x:main', {});
  assert(r.denied && r.reason.includes('push to protected branch "main"'), `7>x:main denied: ${r.reason}`);
  const ok = guard('git push origin feat 7>x', {});
  assert(!ok.denied, `feat 7>x allowed: ${ok.reason}`);
});

console.log('merge logging: chained and redirected merges');

const logMerge = (p, command, env) =>
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '' }, cwd: p }, p, env);

test('merge log: the chained sh call records one merge for PR 5', () => {
  const p = tmpProject();
  const file = path.join(p, 'gh-args.jsonl');
  // The fake answers with number 5 only when asked about 5; a wrong target would show in the args.
  logMerge(p, SH_GH, fakeGh('{"number":5,"state":"MERGED","autoMergeRequest":null,"baseRefName":"milestone/auth"}', 0, { FAKE_GH_ARGS: file }));
  eq(calls(file).map((a) => a.join(' ')).join('|'), GH_VIEW(5), 'asked gh about PR 5, once');
  const lines = readLog(p, 'merges.jsonl');
  eq(lines.length, 1, 'one merge line');
  eq(lines[0].pr, '5', 'pr');
  eq(lines[0].outcome, 'merged', 'outcome');
  eq(lines[0].milestone, 'auth', 'milestone');
  eq(lines[0].chained, true, 'chained');
});

test('merge log: the PowerShell chain with a failed lookup still records pr 5 from the command', () => {
  const p = tmpProject();
  const file = path.join(p, 'gh-args.jsonl');
  logMerge(p, PS_GH, fakeGh('', 1, { FAKE_GH_ARGS: file }));
  eq(calls(file).map((a) => a.join(' ')).join('|'), GH_VIEW(5), 'asked gh about PR 5, once');
  const lines = readLog(p, 'merges.jsonl');
  eq(lines.length, 1, 'one merge line');
  eq(lines[0].pr, '5', 'pr from the command target');
  eq(lines[0].outcome, 'unknown', 'outcome');
  eq(lines[0].chained, true, 'chained');
});

test('merge log: the glab chain records one merge for MR 5', () => {
  const p = tmpProject();
  const file = path.join(p, 'glab-args.jsonl');
  logMerge(p, SH_GL, fakeGlab(mr(5, 'merged', 'milestone/auth'), 0, { FAKE_GH_ARGS: file }));
  eq(calls(file).map((a) => a.join(' ')).join('|'), GL_VIEW(5), 'asked glab about MR 5, once');
  const lines = readLog(p, 'merges.jsonl');
  eq(lines.length, 1, 'one merge line');
  eq(lines[0].pr, '5', 'iid');
  eq(lines[0].forge, 'gitlab', 'forge');
});

test('merge log: `gh pr merge --squash 2>&1` is the current branch, not PR 2, and not chained', () => {
  const p = tmpProject();
  const file = path.join(p, 'gh-args.jsonl');
  logMerge(p, 'gh pr merge --squash 2>&1', fakeGh('{"number":11,"state":"MERGED","autoMergeRequest":null,"baseRefName":"milestone/auth"}', 0, { FAKE_GH_ARGS: file }));
  eq(calls(file).map((a) => a.join(' ')).join('|'), GH_VIEW(null), 'asked gh about the current branch');
  const lines = readLog(p, 'merges.jsonl');
  eq(lines.length, 1, 'one merge line');
  eq(lines[0].pr, '11', 'pr from the forge answer');
  eq(lines[0].chained, false, 'a redirect is not a chain');
});

test('merge log: with the lookup failing, a `2>&1` merge has no pr, never "2"', () => {
  const p = tmpProject();
  const file = path.join(p, 'gh-args.jsonl');
  logMerge(p, 'gh pr merge --squash 2>&1', fakeGh('', 1, { FAKE_GH_ARGS: file }));
  eq(calls(file).map((a) => a.join(' ')).join('|'), GH_VIEW(null), 'asked gh about the current branch');
  const [m] = readLog(p, 'merges.jsonl');
  eq(m.pr, null, 'no pr');
  eq(m.outcome, 'unknown', 'outcome');
  // Control: the same command with a number records it.
  logMerge(p, 'gh pr merge 7 --squash 2>&1 | tee x', fakeGh('', 1));
  eq(readLog(p, 'merges.jsonl')[1].pr, '7', 'pr 7 from the command');
});

test('merge log: `gh pr merge 5&>/dev/null` with the lookup failing records pr 5', () => {
  const p = tmpProject();
  const file = path.join(p, 'gh-args.jsonl');
  logMerge(p, 'gh pr merge 5&>/dev/null', fakeGh('', 1, { FAKE_GH_ARGS: file }));
  eq(calls(file).map((a) => a.join(' ')).join('|'), GH_VIEW(5), 'asked gh about PR 5');
  const [m] = readLog(p, 'merges.jsonl');
  eq(m.pr, '5', 'pr from the command target');
  eq(m.chained, false, 'a redirect is not a chain');
});
