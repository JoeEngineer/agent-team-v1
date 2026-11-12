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
  for (const redirect of ['2>&1', '>&2', '1>&2', '&>out.log', '&>>out.log', '2>/dev/null', '2>$null', '>out.txt', '> out.txt',
    '>>out.txt', '2>>out.txt', '1> out.txt', '>|out.txt', '>"out file.txt"', '2>&1 >/dev/null']) {
    eq(seg(`gh pr merge --squash ${redirect}`), squash, `redirect ${redirect}`);
  }
  eq(seg('gh pr merge --squash 2>&1 | tee x'), JSON.stringify([['gh', 'pr', 'merge', '--squash'], ['tee', 'x']]), 'a pipe after the redirect still splits');
  eq(seg('gh pr merge 5 2>&1 && git status'), JSON.stringify([['gh', 'pr', 'merge', '5'], ['git', 'status']]), '&& after the redirect still splits');
  eq(seg('gh pr merge 5 >out.txt; git push origin main'), JSON.stringify([['gh', 'pr', 'merge', '5'], ['git', 'push', 'origin', 'main']]), '; after the redirect target');
});

test('segments: only a bare glued number is a file descriptor (bash reading)', () => {
  eq(JSON.stringify(lib.segments('echo a2>f')), JSON.stringify([['echo', 'a2']]), 'a2> keeps a2');
  eq(JSON.stringify(lib.segments('echo "2">f')), JSON.stringify([['echo', '2']]), 'a quoted 2 is an argument');
  eq(JSON.stringify(lib.segments('git push origin main>out.txt')), JSON.stringify([['git', 'push', 'origin', 'main']]), 'branch glued to >');
  eq(JSON.stringify(lib.segments('gh pr merge 2 >out.txt')), JSON.stringify([['gh', 'pr', 'merge', '2']]), 'a spaced 2 is an argument');
  eq(lib.segments('gh pr merge 2 >out.txt').unsure.length, 0, 'a spaced 2: nothing unsure');
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

// Review of 05d4cb1: `&>` takes no file descriptor, so in bash a number glued to
// it is the argument. The segments hold that reading (the merge logger uses it);
// the command is still marked unsure, so the guard refuses it (see below).
test('findMerges: a number glued to `&>` / `&>>` is the target in bash\'s reading', () => {
  const t = (cmd) => lib.findMerges(cmd).map((m) => `${m.forge}:${m.target}`).join(',');
  eq(t('gh pr merge 5&>/dev/null'), 'github:5', 'gh 5&>/dev/null');
  eq(t('gh pr merge 5&>>f'), 'github:5', 'gh 5&>>f');
  eq(t('gh pr merge 5 &>f'), 'github:5', 'gh 5 &>f (spaced)');
  eq(t('gh pr merge 12&>f'), 'github:12', 'gh 12&>f (multi-digit)');
  eq(t('glab mr merge 8&>/dev/null'), 'gitlab:8', 'glab 8&>/dev/null');
  eq(JSON.stringify(lib.allSegments('gh pr merge 5&>f').unsure), JSON.stringify([{ text: '5&>', why: 'glued' }]), 'glued to &>: unsure');
  eq(lib.allSegments('gh pr merge 5 &>f').unsure.length, 0, 'spaced &>: nothing unsure');
});

test('segments: a glued 1-6 before `>` is a stream number in every shell, and nothing is unsure', () => {
  const merge = JSON.stringify([['gh', 'pr', 'merge']]);
  for (const redirect of ['1>f', '2>&1', '5>>f', '5>&1', '6>f', '3>&1', '2>$null', '2>/dev/null', '1>&2']) {
    const segs = lib.segments(`gh pr merge ${redirect}`);
    eq(JSON.stringify(segs), merge, `${redirect} dropped`);
    eq(segs.unsure.length, 0, `${redirect}: nothing unsure`);
  }
});

test('segments: any other glued word is unsure, read from its raw text', () => {
  // [command, bash's reading kept in the segment, the unsure text]
  const m = ['gh', 'pr', 'merge'];
  const cases = [
    ['gh pr merge 7>out', m, '7>'],
    ['gh pr merge 12>out', m, '12>'],
    ['gh pr merge 0>out', m, '0>'],
    ['gh pr merge 7>>f', m, '7>>'],
    ['gh pr merge 12>&1', m, '12>&'],
    ['gh pr merge 7> out', m, '7>'],
    ['gh pr merge feat>out', [...m, 'feat'], 'feat>'],
    ['gh pr merge x"7">f', [...m, 'x7'], 'x"7">'],
    ['gh pr merge "7">out', [...m, '7'], '"7">'],
    ['gh pr merge ""5>f', [...m, '5'], '""5>'],
    ["gh pr merge ''5>f", [...m, '5'], "''5>"],
    ['gh pr merge 5"">f', [...m, '5'], '5"">'],
    ["gh pr merge 5''>f", [...m, '5'], "5''>"],
    ['gh pr merge \\5>f', [...m, '\\5'], '\\5>'],
    ['gh pr merge 5\\>f', [...m, '5\\'], '5\\>'],
    ['gh pr merge $x>f', [...m, '$x'], '$x>'],
    ['gh pr merge ${x}>f', [...m, '${x}'], '${x}>'],
    ['gh pr merge --squash *>&1', [...m, '--squash', '*'], '*>&'],
    ['gh pr merge 5*>f', [...m, '5*'], '5*>'],
    ['gh pr merge 5&>f', [...m, '5'], '5&>'],
    ['gh pr merge {5>f', [...m, '5'], '{5>'],
    // bash joins `5\` + newline + `2` into the fd 52; the raw text is not a lone digit
    ['gh pr merge 5\\\n2>&1', [...m, '52'], '5\\\n2>&'],
  ];
  for (const [cmd, seg, text] of cases) {
    const segs = lib.segments(cmd);
    eq(JSON.stringify(segs[0]), JSON.stringify(seg), `${JSON.stringify(cmd)}: bash reading`);
    eq(JSON.stringify(segs.unsure), JSON.stringify([{ text, why: 'glued' }]), `${JSON.stringify(cmd)}: unsure`);
  }
  // A continuation before the redirection is not part of the word.
  eq(lib.segments('gh pr merge 5 --squash \\\n2>&1').unsure.length, 0, 'continuation, then 2>&1');
  // The rest of the line is still read.
  eq(JSON.stringify(lib.segments('gh pr merge 7>out; git status')[1]), JSON.stringify(['git', 'status']), 'second segment');
});

test('segments: a backslash at the end of a redirection target is unsure', () => {
  // Bash: the target is "out 5" and the merge is the current branch's. PowerShell: PR 5.
  const segs = lib.segments('gh pr merge >out\\ 5');
  eq(JSON.stringify(segs.unsure), JSON.stringify([{ text: '>out\\', why: 'escape' }]), '>out\\ 5');
  eq(JSON.stringify(lib.segments('gh pr merge --squash >a\\&b 5').unsure), JSON.stringify([{ text: '>a\\', why: 'escape' }]), '>a\\&b');
  eq(JSON.stringify(lib.segments('gh pr merge 5 >a\\"b c"').unsure), JSON.stringify([{ text: '>a\\"b c"', why: 'escape' }]), 'backslash before a quote');
  eq(lib.segments('gh pr merge 5 2>C:\\tmp\\out.txt').unsure.length, 0, 'a Windows path is fine');
});

test('allSegments: unsure covers nested shells and redirection-only segments', () => {
  eq(JSON.stringify(lib.allSegments('bash -c "gh pr merge 7>f"').unsure), JSON.stringify([{ text: '7>', why: 'glued' }]), 'inside bash -c');
  eq(JSON.stringify(lib.allSegments('powershell -Command gh pr merge 7>f').unsure.map((u) => u.text)), JSON.stringify(['7>']), 'outer line');
  eq(JSON.stringify(lib.allSegments('7>out; gh pr merge 5').unsure), JSON.stringify([{ text: '7>', why: 'glued' }]), 'a segment with no words');
  eq(lib.allSegments('bash -c "gh pr merge 5 2>&1"').unsure.length, 0, 'nested 2>&1 is fine');
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

console.log('guard.js: words glued to a redirection');

// A word glued to a redirection, other than a lone 1-6 before `>`, makes the
// guard refuse before any lookup. The fake would allow (milestone base), so a
// deny comes from the redirection, and no lookup means nothing was checked
// against a request the shell might not merge.
function deniedBeforeLookup(cmd, text) {
  const fake = /(^|&& )glab /.test(cmd) ? fakeGlab(mr(5, 'opened', 'milestone/auth')) : fakeGh(pr(5, 'milestone/auth'));
  const r = guard(cmd, fake);
  assert(r.denied, `${cmd}: should deny`);
  eq(r.lookups.length, 0, `${cmd}: no lookup`);
  if (text) assert(r.reason.includes(`\`${text}\``), `${cmd}: names ${JSON.stringify(text)}: ${r.reason}`);
  assert(r.reason.includes('put a space before each redirection'), `${cmd}: how to fix: ${r.reason}`);
  assert(!r.reason.includes('This needs the user'), `${cmd}: the agent can fix this itself: ${r.reason}`);
  return r;
}

// Review of 05d4cb1 finding 1: on 05d4cb1 these asked about the current branch.
// Bash merges PR 5 (`&>` takes no number). They are refused like any glued word.
for (const cmd of ['gh pr merge 5&>/dev/null', 'gh pr merge 5&>>f', 'gh pr merge 5&>f', 'glab mr merge 8&>/dev/null']) {
  test(`guard: \`${cmd}\` is denied before any lookup`, () => { deniedBeforeLookup(cmd, cmd.match(/\S+&>>?/)[0]); });
}

test('guard: `gh pr merge 5 &>f` (spaced) asks about PR 5', () => {
  const bad = guard('gh pr merge 5 &>f', fakeGh(pr(5, 'main')));
  eq(bad.lookups.join('|'), GH_VIEW(5), 'asked gh about PR 5');
  assert(bad.denied && bad.reason.includes('PR 5 targets protected branch "main"'), `main denied: ${bad.reason}`);
  const ok = guard('gh pr merge 5 &>f', fakeGh(pr(5, 'milestone/auth')));
  eq(ok.lookups.join('|'), GH_VIEW(5), 'asked gh about PR 5');
  assert(!ok.denied, `milestone allowed: ${ok.reason}`);
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

// Review of cd12c29: a word mixing quotes and a digit was dropped as a file
// descriptor, so `""5>f` and `5"">f` asked about the current branch while bash
// merges PR 5. The rest are the shapes cd12c29 refused or checked in two readings.
const GLUED = [
  ['gh pr merge ""5>f', '""5>'],
  ["gh pr merge ''5>f", "''5>"],
  ['gh pr merge 5"">f', '5"">'],
  ['gh pr merge "5">f', '"5">'],
  ['gh pr merge 5\\>f', '5\\>'],
  ['gh pr merge $x>f', '$x>'],
  ['gh pr merge ${x}>f', '${x}>'],
  ['gh pr merge 7>out', '7>'],
  ['gh pr merge 12>out', '12>'],
  ['gh pr merge 0>out', '0>'],
  ['gh pr merge 7>>out', '7>>'],
  ['gh pr merge 12>&1', '12>&'],
  ['gh pr merge 7> out', '7>'],
  ['gh pr merge --squash *>&1', '*>&'],
  ['gh pr merge feat>out', 'feat>'],
  ['glab mr merge 7>out', '7>'],
  ['node ci-wait.js 5 --once && gh pr merge 7>out && gh pr comment 5 -b ok', '7>'],
  ['gh pr merge 5 7>out', '7>'],
  ['gh pr merge 5 12>&1', '12>&'],
  ['gh pr merge 5 --squash *>&1', '*>&'],
  ['bash -c "gh pr merge 7>out"', '7>'],
];
for (const [cmd, text] of GLUED) {
  test(`guard: \`${cmd}\` is denied before any lookup`, () => { deniedBeforeLookup(cmd, text); });
}

test('guard: a backslash ending a redirection target is denied before any lookup', () => {
  // Bash: target "out 5", the current branch's PR is merged. PowerShell: PR 5.
  const r = deniedBeforeLookup('gh pr merge >out\\ 5', '>out\\');
  assert(r.reason.includes('escapes the next character in bash'), `reason: ${r.reason}`);
  // Bash: target "a&b" and PR 5. Read without the escape, `&` would end the merge segment.
  deniedBeforeLookup('gh pr merge --squash >a\\&b 5', '>a\\');
});

test('guard: written with a space or a stream number 1-6, the same merges are checked normally', () => {
  // Recovery control for the refused shapes above.
  for (const [cmd, n] of [['gh pr merge 7 >out', 7], ['gh pr merge "7" >out', 7], ['gh pr merge 7 2>&1', 7], ['gh pr merge 12 >out', 12],
    ['gh pr merge 5 --squash \\\n2>&1', 5], ['gh pr merge 5 2>C:\\tmp\\out.txt', 5]]) {
    const ok = guard(cmd, fakeGh(pr(n, 'milestone/auth')));
    eq(ok.lookups.join('|'), GH_VIEW(n), `${cmd}: asked about ${n}`);
    assert(!ok.denied, `${cmd}: milestone allowed: ${ok.reason}`);
    const bad = guard(cmd, fakeGh(pr(n, 'main')));
    eq(bad.lookups.join('|'), GH_VIEW(n), `${cmd}: asked about ${n}`);
    assert(bad.denied, `${cmd}: main denied`);
  }
});

test('guard: a push with a glued redirection is denied; written plainly it is checked', () => {
  // Precondition: with stream 2 every shell reads a redirect and no refspec, and
  // the test folder has no protected current branch, so that is allowed.
  const control = guard('git push origin 2>x:main', {});
  assert(!control.denied, `2>x:main allowed: ${control.reason}`);
  assert(!guard('git push origin task/T-1 2>&1', {}).denied, 'task push with 2>&1 allowed');
  // Bash: fd 7 to a file, no refspec. PowerShell: refspec "7>x:main", a push to main.
  const r = guard('git push origin 7>x:main', {});
  assert(r.denied && r.reason.includes('`7>`'), `7>x:main denied: ${r.reason}`);
  const feat = guard('git push origin feat 7>x', {});
  assert(feat.denied && feat.reason.includes('`7>`'), `feat 7>x denied: ${feat.reason}`);
});

test('guard: a glued redirection only matters in a command that runs git, gh or glab', () => {
  eq(guard('echo a2>f', {}).denied, false, 'no git, gh or glab: not the guard\'s business');
  // Deliberately refused too (the guard doesn't sort reads from writes here): rewrite with a space.
  deniedBeforeLookup('gh pr view 5 --json number>out.json', 'number>');
});

console.log('guard.js: glued words x redirections x positions');

// Every word shape crossed with every output redirection operator and with the
// word's place relative to the PR number. For each case the test knows what
// bash and PowerShell 5.1 pass to gh (checked against real bash and
// powershell.exe), or that it can't say (a glob, a variable, an escape that
// moves the operator, PowerShell's argument mode). The rule under test: the
// guard never lets a merge through after looking up a PR that some shell's
// reading would not merge, and never lets one through when a reading is
// unknown. The forms the Director uses (a lone 1-6, a space before the
// redirection) must still be checked normally, so the rule can't pass by
// refusing everything.
const WORDS = ['5', '1', '6', '0', '7', '12', '"5"', "'5'", '""5', "''5", '5""', "5''", '\\5', '5\\', '$x', '${x}', '-', 'feat', 'task/X', '*', 'x"7"'];
const OPS = ['>', '>>', '>&1', '&>', '&>>', '>|', '*>'];
const POSITIONS = {
  target: (r) => `gh pr merge ${r}`,
  before: (r) => `gh pr merge ${r} 9`,
  after: (r) => `gh pr merge 9 ${r}`,
};
const UNKNOWN = 'unknown';
const NORUN = 'norun'; // the shell rejects the line, so nothing is merged
// The arguments bash passes for the glued word (none when it is a file descriptor).
function bashWord(word, op) {
  if (word.endsWith('\\') || word.includes('$') || word.includes('*') || op === '*>') return UNKNOWN;
  const value = word.replace(/\\(.)/g, '$1').replace(/["']/g, '');
  if (op.startsWith('&')) return [value]; // `&>` takes no number
  return /^\d+$/.test(word) ? [] : [value];
}
// PowerShell 5.1 (and cmd): only a lone 1-6 before `>`, `>>` or `>&1` is
// modelled; `N>|` doesn't parse. Anything else depends on argument mode.
function psWord(word, op) {
  if (!/^[1-6]$/.test(word)) return UNKNOWN;
  if (['>', '>>', '>&1'].includes(op)) return [];
  return op === '>|' ? NORUN : UNKNOWN;
}
function expectedTarget(reading, pos) {
  if (reading === UNKNOWN || reading === NORUN) return reading;
  const args = pos === 'target' ? reading : pos === 'before' ? [...reading, '9'] : ['9', ...reading];
  return args.length ? args[0] : null;
}
const CROSS = [];
for (const word of WORDS) {
  for (const op of OPS) {
    for (const [pos, line] of Object.entries(POSITIONS)) {
      const redirect = `${word}${op}${op.endsWith('&1') ? '' : 'f'}`;
      CROSS.push({ cmd: line(redirect), word, op, pos, sh: expectedTarget(bashWord(word, op), pos), ps: expectedTarget(psWord(word, op), pos) });
    }
  }
}
// The guard's verdict, given whether it denied and what it looked up.
function checkVerdict(c, denied, lookedUp) {
  if (denied) return;
  for (const [shell, want] of [['bash', c.sh], ['PowerShell', c.ps]]) {
    assert(want !== UNKNOWN, `${c.cmd}: allowed although the ${shell} reading is unknown`);
    if (want !== NORUN) eq(lookedUp, want, `${c.cmd}: allowed after looking up a PR ${shell} would not merge`);
  }
}

test(`cross: ${CROSS.length} cases, the verdict never trusts a reading a shell doesn't share`, () => {
  let allowed = 0;
  for (const c of CROSS) {
    // What guard.js does: refuse when anything is unsure, else look up the merge target.
    const segs = lib.allSegments(c.cmd);
    const denied = segs.unsure.length > 0;
    const [m] = lib.findMerges(c.cmd);
    checkVerdict(c, denied, m.target);
    if (!denied) allowed++;
    // The Director's forms are checked, not refused.
    if (/^[1-6]$/.test(c.word) && ['>', '>>', '>&1'].includes(c.op)) assert(!denied, `${c.cmd}: a stream 1-6 is refused`);
  }
  eq(allowed, 3 * 4 * 3, 'allowed: 1, 5 and 6 with >, >>, >&1 and >| in each position');
});

test('cross: the same cases, spaced, are read the same way by every shell and checked normally', () => {
  for (const word of ['"5"', '""5', '5""', 'feat', '7', '12']) {
    for (const op of ['>', '>>', '&>', '>|']) {
      const cmd = `gh pr merge ${word} ${op}f`;
      eq(lib.allSegments(cmd).unsure.length, 0, `${cmd}: nothing unsure`);
      eq(lib.findMerges(cmd)[0].target, word.replace(/["']/g, ''), `${cmd}: target`);
    }
  }
});

// The real guard on a sample of the cross (each word shape with each operator,
// the position rotating), so the check above can't drift from guard.js.
const SAMPLE_WORDS = new Set(['5', '0', '7', '12', '"5"', '""5', '5""', '\\5', '5\\', '$x', 'feat', '*']);
let rotate = 0;
for (const word of SAMPLE_WORDS) {
  for (const op of OPS) {
    const pos = Object.keys(POSITIONS)[rotate++ % 3];
    const c = CROSS.find((x) => x.word === word && x.op === op && x.pos === pos);
    test(`cross (guard.js): \`${c.cmd}\``, () => {
      const r = guard(c.cmd, fakeGh(pr(5, 'milestone/auth')));
      if (r.denied) eq(r.lookups.length, 0, `${c.cmd}: denied before any lookup`);
      else eq(r.lookups.length, 1, `${c.cmd}: one lookup`);
      const lookedUp = r.denied ? undefined : r.lookups[0].replace(/^pr view ?/, '').replace(/ ?--json.*$/, '') || null;
      checkVerdict(c, r.denied, lookedUp);
    });
  }
}

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

console.log('first-gate-call: the --names prefix (decision 0016)');

const NAMES_SH = 'node "/p/scripts/ci-wait.js" --names 5; ' + SH_GH;
const NAMES_PS = 'node "C:\\p\\scripts\\ci-wait.js" --names 5; ' + PS_GH;
const NAMES_SH_GL = 'node "/p/scripts/ci-wait.js" --names 5; ' + SH_GL;
const NAMES_PS_GL = 'node "C:\\p\\scripts\\ci-wait.js" --names 5; ' + PS_GL;

for (const [name, cmd] of [['sh', NAMES_SH], ['PowerShell', NAMES_PS]]) {
  test(`guard: the ${name} --names-prefixed merge chain is allowed into a milestone base`, () => {
    const r = guard(cmd, fakeGh(pr(5, 'milestone/auth')));
    eq(r.lookups.join('|'), GH_VIEW(5), 'asked gh about PR 5 only');
    assert(!r.denied, `should allow: ${r.reason}`);
  });
  test(`guard: the ${name} --names-prefixed merge chain stays denied into main`, () => {
    const r = guard(cmd, fakeGh(pr(5, 'main')));
    eq(r.lookups.join('|'), GH_VIEW(5), 'asked gh about PR 5');
    assert(r.denied && r.reason.includes('protected branch "main"'), `reason: ${r.reason}`);
  });
}
for (const [name, cmd] of [['sh', NAMES_SH_GL], ['PowerShell', NAMES_PS_GL]]) {
  test(`guard: the ${name} --names-prefixed glab chain is allowed into milestone, denied into main`, () => {
    const ok = guard(cmd, fakeGlab(mr(5, 'opened', 'milestone/auth')));
    eq(ok.lookups.join('|'), GL_VIEW(5), 'asked glab about MR 5');
    assert(!ok.denied, `should allow: ${ok.reason}`);
    const no = guard(cmd, fakeGlab(mr(5, 'opened', 'main')));
    assert(no.denied, 'main is denied');
  });
}

for (const [name, cmd] of [['sh', NAMES_SH], ['PowerShell', NAMES_PS], ['sh glab', NAMES_SH_GL], ['PowerShell glab', NAMES_PS_GL]]) {
  test(`findMerges: the ${name} --names prefix adds no merge and its number is not a target`, () => {
    const merges = lib.findMerges(cmd);
    eq(merges.length, 1, 'merge count');
    eq(merges[0].target, '5', 'target');
  });
}

test('merge log: a --names prefix leaves one merge line with pr, match_head and the ci-wait gate', () => {
  // match_head is recorded for queued (--auto) merges, so the sh case uses the --auto chain.
  for (const cmd of [NAMES_SH, NAMES_PS, 'node "/p/scripts/ci-wait.js" --names 5; ' + SH_GH_AUTO]) {
    const p = tmpProject();
    const auto = cmd.includes('--auto');
    const file = path.join(p, 'gh-args.jsonl');
    // The prefix names PR 36; the merge is PR 5, so a misread would show in the lookup or the line.
    logMerge(p, cmd.replace('--names 5', '--names 36'), fakeGh('{"number":5,"state":"MERGED","autoMergeRequest":null,"baseRefName":"milestone/auth"}', 0, { FAKE_GH_ARGS: file }));
    eq(calls(file).map((a) => a.join(' ')).join('|'), GH_VIEW(5), 'asked gh about PR 5, once');
    const lines = readLog(p, 'merges.jsonl');
    eq(lines.length, 1, 'one merge line');
    eq(lines[0].pr, '5', 'pr');
    eq(lines[0].match_head, auto ? 'abc' : undefined, 'match_head');
    eq(lines[0].gate, 'ci-wait', 'gate');
    eq(lines[0].outcome, 'merged', 'outcome');
  }
});

test('merge log: ci-wait --names is never a gate, even joined with &&; the documented shapes still log ci-wait', () => {
  const p = tmpProject();
  const merged = fakeGh('{"number":5,"state":"MERGED","autoMergeRequest":null,"baseRefName":"milestone/auth"}');
  logMerge(p, 'node "/p/scripts/ci-wait.js" --names 5 && gh pr merge 5 --squash --match-head-commit abc', merged);
  logMerge(p, NAMES_SH, merged);
  logMerge(p, NAMES_PS, merged);
  const lines = readLog(p, 'merges.jsonl');
  eq(lines.length, 3, 'three merge lines');
  eq(lines[0].gate, undefined, '--names && merge: no gate');
  eq(lines[1].gate, 'ci-wait', 'sh prefixed shape');
  eq(lines[2].gate, 'ci-wait', 'PowerShell prefixed shape');
});

test('merge log: a --names call alone logs no merge', () => {
  const p = tmpProject();
  logMerge(p, 'node "/p/scripts/ci-wait.js" --names 36', fakeGh('{"number":36,"state":"OPEN","autoMergeRequest":null}'));
  eq(readLog(p, 'merges.jsonl').length, 0, 'no merge line');
});
