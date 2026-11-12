// Pins the CI-wait setup wording in the README, the team-init skill, the GitLab
// mapping and the project templates (0.6.0). Node built-ins only.
'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert, eq, ROOT } = require('./helpers');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Every JSON code block that names required_status_checks must carry a real-looking
// context, never an empty list.
function requiredCheckBlocks(text) {
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.filter((b) => b.includes('required_status_checks'));
}

const README = read('README.md');
const SKILL = read('skills/team-init/SKILL.md');
const MAPPING = read('docs/gitlab-mapping.md');
const CLAUDE_T = read('templates/project/CLAUDE.agent-team.md');
const AGENTS_T = read('templates/project/AGENTS.agent-team.md');

console.log('ci docs');

test('README: the scripts list names ci-wait.js with --once and --names, and reconcile-logs --merges', () => {
  assert(README.includes('`scripts/ci-wait.js`'), 'ci-wait.js missing from the scripts list');
  assert(/scripts\/ci-wait\.js` \| Waits for or checks CI on GitHub \(`gh`\) or GitLab \(`glab`\)/.test(README), 'ci-wait row');
  assert(README.includes('`--once` checks once'), '--once not described');
  assert(README.includes('`--names` prints the check names'), '--names not described');
  assert(README.includes('With `--merges`, checks the merges queued by auto-merge'), 'reconcile-logs --merges not described');
});

test('README: How it works describes the reviewer wait, the one-call merge and the completion rule', () => {
  assert(README.includes('the reviewer waits for CI with `scripts/ci-wait.js` after its review'), 'reviewer wait');
  assert(README.includes('the CI gate, then the merge, then the PR comment'), 'one-call merge order');
  assert(README.includes('it queues auto-merge when the `milestone/*` ruleset names its required checks and the repo allows auto-merge'), 'auto-merge queue condition');
  assert(README.includes('`reconcile-logs.js --merges` at checkpoints'), 'checkpoint reconcile');
  assert(README.includes('reported complete only after its PR\'s checks finish green'), 'completion rule');
});

test('README: plain-gh forms are documented exactly', () => {
  assert(README.includes('`gh pr checks <n> --required`'), 'quick check form');
  assert(README.includes('`gh pr checks <n> --watch --fail-fast --interval 30`'), 'watch form');
});

test('README: limits name the shell cap, the Codex re-wait, the SHA caveat and unknown', () => {
  assert(README.includes('Claude\'s foreground shell stops at 10 minutes'), 'shell cap');
  assert(README.includes('in at most two calls'), 'two calls');
  assert(README.includes('Codex has no background shell that wakes the Director'), 'Codex re-wait');
  assert(README.includes('whether GitHub enforces the expected head SHA at the moment a queued auto-merge fires is untested'), 'SHA caveat');
  assert(README.includes('So the Director disables auto-merge before any push to a queued PR'), 'disable before push');
  assert(README.includes('reports `unknown` (exit 2) when the token can\'t read the required checks'), 'unknown');
  assert(README.includes('Classic branch protection needs admin rights'), 'classic protection admin');
});

test('README: branch protection says names come after one CI run, empty list enforces nothing, auto-merge, private plans', () => {
  assert(README.includes('the name exists only after CI has run once on a PR'), 'names after CI run');
  assert(README.includes('Turning the rule on with an empty list enforces nothing'), 'empty list');
  assert(README.includes('**Settings → General → Pull Requests → Allow auto-merge**'), 'GitHub auto-merge setting');
  assert(README.includes('Private repos need a paid GitHub plan for rulesets and for auto-merge'), 'private plan');
  assert(README.includes('**Pipelines must succeed** in Settings → Merge requests'), 'GitLab pipelines must succeed');
  assert(README.includes('The Director never changes rulesets: it asks you'), 'director asks, never changes');
});

test('README: no Changelog heading; the 0.6.0 notes are version-tagged bullets in Limits and known gaps', () => {
  assert(!README.includes('## Changelog'), 'a Changelog heading must not exist (the README tags versions inline)');
  const limits = README.slice(README.indexOf('## Limits and known gaps'), README.indexOf('## License'));
  assert(/^- \*\*CI waits and merges \(0\.6\.0\):\*\*/m.test(limits), '0.6.0 CI bullet in Limits');
  assert(/^- \*\*Required check names and auto-merge setup \(0\.6\.0\):\*\*/m.test(limits), '0.6.0 setup bullet in Limits');
});

test('README: auto-merge is queued only with named checks and an allowed repo setting; Claude and Codex fallbacks named', () => {
  assert(README.includes('queues auto-merge when the `milestone/*` ruleset names its required checks and the repo allows auto-merge; otherwise it waits for CI in a background check (Claude) or asks the reviewer to wait again (Codex)'), 'How it works condition');
  assert(README.includes('Without this setting it waits for CI in a background check instead (Claude), or asks the reviewer to wait again (Codex).'), 'Protect-branches fallback');
});

test('README and team-init agree: names go to milestone/* and protect-main; GitLab label is Set to auto-merge', () => {
  assert(README.includes('Add them to the `milestone/*` ruleset and to `protect-main`'), 'README names targets');
  assert(SKILL.includes('add those names as required status checks to the `milestone/*` ruleset and to `protect-main`'), 'team-init names targets');
  assert(README.includes('(**Set to auto-merge**, set per MR)'), 'GitLab label');
  assert(!README.includes('Merge when pipeline succeeds**'), 'outdated GitLab label gone');
});

test('README and SKILL: every required_status_checks JSON example has a placeholder context, never an empty list', () => {
  for (const [name, text] of [['README.md', README], ['SKILL.md', SKILL]]) {
    const blocks = requiredCheckBlocks(text);
    assert(blocks.length > 0, `${name} has no required_status_checks example`);
    for (const b of blocks) {
      assert(/"context": "<your CI job name, e\.g\. [^"<>]+>"/.test(b), `${name} example lacks a placeholder context: ${b}`);
      assert(!/"required_status_checks":\s*\[\s*\]/.test(b), `${name} example has an empty list`);
    }
  }
});

test('team-init: states the rules, the names step, the ask-the-user step and the auto-merge step', () => {
  assert(SKILL.includes('Required status checks on the `milestone/*` ruleset need real check names'), 'real names');
  assert(SKILL.includes('a name exists only after CI has run once'), 'after CI run');
  assert(SKILL.includes('Turning the rule on with an empty list enforces nothing'), 'empty list');
  assert(SKILL.includes('`node "<plugin root>/scripts/ci-wait.js" --names <n>`'), '--names command');
  assert(SKILL.includes('`gh pr checks <n> --json name`'), 'gh names form');
  assert(SKILL.includes('with the bypass list still empty'), 'bypass list');
  assert(SKILL.includes('Settings → General → Pull Requests → "Allow auto-merge"'), 'GitHub auto-merge');
  assert(SKILL.includes('"Pipelines must succeed"'), 'GitLab pipelines must succeed');
  assert(SKILL.includes('The Director never changes repository settings, rulesets or branch protection'), 'never changes');
  assert(SKILL.includes('need a paid GitHub plan'), 'private plan');
  assert(SKILL.includes('record the names in STATUS.md') || SKILL.includes('Then record the names in STATUS.md'), 'records names');
});

test('gitlab-mapping: CI wait, auto-merge and cancel rows', () => {
  assert(MAPPING.includes('`node scripts/ci-wait.js <n> --sha <sha>`') && MAPPING.includes('`head_pipeline.status`'), 'CI wait row');
  assert(MAPPING.includes('| CI gate (first in the merge call) | `node scripts/ci-wait.js <n> --once --sha <sha>` |'), 'CI gate row');
  assert(MAPPING.includes('`glab mr merge <n> --squash --remove-source-branch --yes --sha <sha>`'), 'glab merge row with --sha');
  assert(MAPPING.includes('`gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`'), 'gh merge row with --match-head-commit');
  assert(MAPPING.includes('untested against a live instance'), 'cancel row caveat');
  assert(MAPPING.includes('| Queue merge after CI (gated) | `node scripts/ci-wait.js <n> --queue-check --sha <sha> && gh pr merge <n> --auto --squash --delete-branch --match-head-commit <sha>` | `node scripts/ci-wait.js <n> --queue-check --sha <sha> && glab mr merge <n> --auto-merge --squash --remove-source-branch --yes --sha <sha>` |'), 'auto-merge row');
  assert(MAPPING.includes('`glab api -X POST projects/:id/merge_requests/<n>/cancel_merge_when_pipeline_succeeds`'), 'cancel row');
});

test('templates: the CI line says names and auto-merge are recorded in STATUS.md and the user is asked', () => {
  for (const [name, text] of [['CLAUDE', CLAUDE_T], ['AGENTS', AGENTS_T]]) {
    const line = text.split('\n').find((l) => l.startsWith('- CI:'));
    assert(line, `${name} template has no CI line`);
    assert(line.includes('The required check names and the auto-merge setting are recorded in STATUS.md after the first CI run'), `${name} CI line: recorded`);
    assert(line.includes('the Director asks me to set them'), `${name} CI line: asks user`);
  }
});

test('director docs: --names rides the first merge-gate call with a plain ; and is never a call of its own (decision 0016)', () => {
  const dskill = read('skills/director/SKILL.md');
  const merging = read('skills/director/references/merging.md');
  const sh = 'node "<plugin root>/scripts/ci-wait.js" --names <n>; node "<plugin root>/scripts/ci-wait.js" <n> --once --sha <head_sha> && gh pr merge <n> --squash --delete-branch --match-head-commit <head_sha> && gh pr comment <n>';
  const ps = 'node "<plugin root>\\scripts\\ci-wait.js" --names <n>; node "<plugin root>\\scripts\\ci-wait.js" <n> --once --sha <head_sha>; if ($LASTEXITCODE -eq 0) { gh pr merge <n> --squash --delete-branch --match-head-commit <head_sha>; if ($LASTEXITCODE -eq 0) { gh pr comment <n>';
  assert(merging.includes(sh), 'sh prefixed shape');
  assert(merging.includes(ps), 'PowerShell prefixed shape');
  assert(merging.includes('there is no merge call yet. If the names are already in `STATUS.md`\'s CI block, no `--names` is needed'), 'pending case');
  assert(dskill.includes('prefix that PR\'s merge call with `node "<plugin root>/scripts/ci-wait.js" --names <n>;`'), 'SKILL prefix rule');
  assert(dskill.includes('Never run `--names` as a call of its own.'), 'SKILL never standalone');
  // Every `ci-wait.js" --names <n>` command in the two files is followed by `;`, so none stands alone.
  for (const [name, text] of [['SKILL.md', dskill], ['merging.md', merging]]) {
    const all = text.match(/ci-wait\.js" --names <n>/g) || [];
    const prefixed = text.match(/ci-wait\.js" --names <n>;/g) || [];
    assert(all.length >= 1, `${name}: no --names command at all`);
    eq(prefixed.length, all.length, `${name}: a --names command without the ; prefix`);
  }
  // README mentions are descriptive: each says the Director runs it inside its first merge call.
  const readme = read('README.md');
  const mentions = readme.match(/ci-wait\.js" --names <n>`[^.]*/g) || [];
  eq(mentions.length, 2, 'README --names command mentions');
  for (const m of mentions) assert(m.includes('(the Director runs this inside its first merge call)'), `README standalone --names: ${m.slice(0, 80)}`);
  // The pending case never asks the reviewer to run --names.
  assert(read('skills/director/references/codex.md').includes('don\'t ask it to run `--names`'), 'codex pending case');
  assert(merging.includes('put the `--names <n>;` prefix on the merge call that follows the green report; on Claude, put it on the background wait command'), 'merging pending case');
});

test('director docs: no sh merge example puts a bare ; between the gate and the merge', () => {
  let scanned = 0;
  for (const f of ['SKILL.md', 'references/merging.md', 'references/gitlab.md', 'references/codex.md']) {
    const text = read('skills/director/' + f);
    const gates = text.match(/--once[^\n`]*/g) || [];
    for (const g of gates) {
      if (!/(gh pr merge|glab mr merge)/.test(g)) continue; // not a merge example line
      if (g.includes('$LASTEXITCODE')) continue; // the PowerShell shape
      scanned++;
      assert(!/--once[^&;\n]*;\s*(gh pr merge|glab mr merge)/.test(g), `${f}: ; between the gate and the merge: ${g.slice(0, 100)}`);
    }
  }
  assert(scanned >= 1, `scanned ${scanned} sh merge example lines; a reformat must not make this test vacuous`);
  // The check bites: a bad sh shape would match.
  assert(/--once[^&;\n]*;\s*(gh pr merge|glab mr merge)/.test('ci-wait.js 5 --once --sha a; gh pr merge 5'), 'detector works');
});

// Decision 0018: every queue call is gated by --queue-check on the same line.
const QUEUE_FILES = ['skills/director/SKILL.md', 'skills/director/references/merging.md', 'skills/director/references/gitlab.md',
  'skills/director/references/codex.md', 'README.md'];
function ungatedQueueCalls(text) {
  const bad = [];
  let seen = 0;
  for (const line of text.split('\n')) {
    const re = /(gh pr merge|glab mr merge)[^\n`|]*?\s--auto(-merge)?(?![\w-])/g;
    let m;
    while ((m = re.exec(line))) {
      seen++;
      const before = line.slice(0, m.index);
      // gated: the queue-check command, then `&&` (sh) or `; if ($LASTEXITCODE -eq 0) {` (PowerShell 5.1), right before the merge
      if (!/--queue-check --sha <[a-z_]+>\s*(&&|;\s*if \(\$LASTEXITCODE -eq 0\)\s*\{)\s*$/.test(before)) bad.push(line.slice(0, 140));
    }
  }
  return { bad, seen };
}

test('director docs: every --auto / --auto-merge queue call is gated by --queue-check (decision 0018)', () => {
  let total = 0;
  for (const f of QUEUE_FILES) {
    const r = ungatedQueueCalls(read(f));
    eq(r.bad.length, 0, `${f}: ungated queue call: ${r.bad.join(' | ')}`);
    total += r.seen;
  }
  assert(total >= 7, `expected at least 7 gated queue examples across the docs, scanned ${total}`);
  // each of the Director docs that show a queue call shows it gated, in the shell shapes the docs use
  const merging = read('skills/director/references/merging.md');
  assert(merging.includes('--queue-check --sha <head_sha> && gh pr merge <n> --auto --squash --delete-branch --match-head-commit <head_sha>'), 'sh');
  assert(merging.includes('--queue-check --sha <head_sha>; if ($LASTEXITCODE -eq 0) { gh pr merge <n> --auto --squash --delete-branch --match-head-commit <head_sha> }'), 'PowerShell 5.1');
  assert(merging.includes('--queue-check --sha <head_sha> && glab mr merge <n> --auto-merge --squash --remove-source-branch --yes --sha <head_sha>'), 'GitLab');
  assert(read('skills/director/references/codex.md').includes('--queue-check --sha <head_sha>; if ($LASTEXITCODE -eq 0) { gh pr merge <n> --auto'), 'codex PowerShell');
  // the detector bites on bare and half-gated shapes, and accepts the gated ones
  eq(ungatedQueueCalls('gh pr merge 5 --auto --squash').bad.length, 1, 'bare gh');
  eq(ungatedQueueCalls('glab mr merge 5 --auto-merge --squash --yes').bad.length, 1, 'bare glab');
  eq(ungatedQueueCalls('node "x/ci-wait.js" 5 --once --sha <head_sha> && gh pr merge 5 --auto').bad.length, 1, 'the merge gate is not the queue-check');
  eq(ungatedQueueCalls('node "x/ci-wait.js" <n> --queue-check --sha <head_sha>; gh pr merge <n> --auto').bad.length, 1, 'bare ; after the queue-check');
  eq(ungatedQueueCalls('node "x/ci-wait.js" <n> --queue-check --sha <head_sha> && gh pr merge <n> --auto').bad.length, 0, 'gated sh');
  eq(ungatedQueueCalls('gh pr merge <n> --disable-auto').seen, 0, '--disable-auto is not a queue call');
});

test('director docs: queue-check exits say what the Director does; the STATUS note is not the gate', () => {
  const skill = read('skills/director/SKILL.md');
  const codex = read('skills/director/references/codex.md');
  const gitlab = read('skills/director/references/gitlab.md');
  assert(skill.includes('the queue-check decides, and a wrong note costs a failed queue call, never an ungated merge'), 'SKILL note');
  assert(skill.includes('Exit 5: don\'t queue, use the no-auto-merge fallback and say why in `STATUS.md`; 1: red, send it back; 4: head moved; 2: ask the user.'), 'SKILL exits');
  assert(codex.includes('Exit 5 (not queueable) means don\'t queue: use the followup below'), 'codex exit 5');
  assert(gitlab.includes('exit 5 (not queueable, for example "Pipelines must succeed" off) means don\'t queue and use the fallback'), 'gitlab exit 5');
});

test('director docs: SKILL puts --names on the merge call after the green report or the background wait, never the queue call; the reviewer never runs it', () => {
  const skill = read('skills/director/SKILL.md');
  assert(!skill.includes('on the queue call or the wait/followup call'), 'stale clause');
  assert(skill.includes('put it on the merge call that follows the green report, or on Claude on the background wait. The reviewer is never asked to run `--names`.'), 'new clause');
});

test('director docs: reconcile-logs --merges runs only when STATUS.md has a queued row (decision 0017)', () => {
  for (const f of ['skills/director/SKILL.md', 'skills/director/references/merging.md', 'skills/director/references/gitlab.md']) {
    const text = read(f);
    assert(/only when `STATUS\.md` has a `queued` row|when `STATUS\.md` has a `queued` row, `reconcile-logs\.js --merges`/.test(text), `${f}: queued-row condition`);
    assert(!text.includes('before the next merge when something is queued'), `${f}: old checkpoint wording`);
  }
  assert(read('skills/director/SKILL.md').includes('with nothing queued, skip it'), 'SKILL skip');
  assert(read('skills/director/references/merging.md').includes('With nothing queued, skip it (decision 0017)'), 'merging skip');
  assert(read('skills/director/references/gitlab.md').includes('run only when `STATUS.md` has a `queued` row'), 'gitlab queued row');
});

test('merging.md: names section is above, merged queued PR gets branch cleanup and comment, head_sha is asked for, no-CI milestone close', () => {
  const merging = read('skills/director/references/merging.md');
  assert(merging.includes('described under "First task PR: the names" above'), 'names are above');
  assert(!merging.includes('"First task PR: the names" below'), 'stale below');
  assert(merging.indexOf('**First task PR: the names.**') < merging.indexOf('described under "First task PR: the names" above'), 'precondition: the names section really comes first');
  assert(merging.includes('`--delete-branch` may do nothing with `--auto` (unconfirmed), so if the PR\'s `task/*` branch still exists, delete it'), 'branch cleanup');
  assert(merging.includes('post the comment "Merged by the Director after reviewer approval'), 'merged comment');
  assert(merging.includes('If the review block has no `head_sha`, ask the reviewer for it; never substitute the PR\'s current head.'), 'head_sha');
  assert(merging.includes('`ci-wait.js <milestone PR> --once --sha <head_sha> --allow-none`'), 'no-CI milestone');
  assert(merging.includes('"no CI" stated'), 'no CI stated');
  assert(read('skills/director/SKILL.md').includes('with "no CI" stated'), 'SKILL no-CI close');
  assert(read('README.md').includes('after upgrading to 0.6.0 in particular, so the reviewer TOML carries the new CI-wait text'), 'README codex-agents rerun');
});

test('reviewer.md: a blocking verdict with pending CI starts summary with the not-waited marker (decision 0017)', () => {
  const rv = read('agents/reviewer.md');
  assert(rv.includes('`summary` must start with exactly `not waited: changes requested` (`not waited: rejected` for `reject`)'), 'marker rule');
  assert(rv.includes('with `summary` starting with the `not waited:` marker'), 'pending definition');
});

test('director docs: backticks balance on every line outside fenced code blocks', () => {
  const odd = (text) => {
    const bad = [];
    let fenced = false;
    text.split('\n').forEach((l, i) => {
      if (/^\s*```/.test(l)) { fenced = !fenced; return; }
      if (!fenced && ((l.match(/`/g) || []).length % 2)) bad.push(i + 1);
    });
    return bad;
  };
  for (const f of ['SKILL.md', 'references/merging.md', 'references/gitlab.md', 'references/codex.md']) {
    eq(odd(read('skills/director/' + f)).join(','), '', `${f}: lines with an odd number of backticks`);
  }
  eq(odd('a `b` c\n(1)`nothing is queued (when `x` row)').join(','), '2', 'detector flags a stray backtick');
});

test('plugin manifests are 0.6.0', () => {
  eq(JSON.parse(read('plugin.json')).version, '0.6.0', 'plugin.json version');
  eq(JSON.parse(read('.claude-plugin/plugin.json')).version, '0.6.0', '.claude-plugin/plugin.json version');
});
