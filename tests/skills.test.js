const fs = require('fs');
const path = require('path');
const { test, assert, eq, ROOT } = require('./helpers');

console.log('skills');

const skillsDir = path.join(ROOT, 'skills');

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const folders = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);

test('skills folder is not empty', () => assert(folders.length > 0, 'no skills'));

for (const name of folders) {
  test(`skill ${name} has SKILL.md with matching name and description`, () => {
    const file = path.join(skillsDir, name, 'SKILL.md');
    assert(fs.existsSync(file), `missing ${file}`);
    const fm = frontmatter(fs.readFileSync(file, 'utf8'));
    assert(fm, 'no frontmatter');
    eq(fm.name, name);
    assert(fm.description && fm.description.trim().length > 0, 'empty description');
  });
}

for (const name of ['team-init', 'milestone', 'status', 'coach', 'director']) {
  test(`skill ${name} exists`, () => assert(folders.includes(name), `missing skills/${name}`));
}

test('commands/ does not exist', () => assert(!fs.existsSync(path.join(ROOT, 'commands')), 'commands/ still present'));

test('no $ARGUMENTS or commands/ references in shipped files', () => {
  const files = ['skills', 'agents', 'templates', 'scripts', 'hooks'].flatMap(d => walk(path.join(ROOT, d)));
  assert(files.length > 0, 'no files scanned');
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert(!text.includes('$ARGUMENTS'), `$ARGUMENTS in ${f}`);
    assert(!/commands[\/\\]/.test(text), `commands/ reference in ${f}`);
  }
});

test('Codex guidance distinguishes same-settings followups from changed-settings spawns', () => {
  const skill = fs.readFileSync(path.join(skillsDir, 'director', 'SKILL.md'), 'utf8');
  const codex = fs.readFileSync(path.join(skillsDir, 'director', 'references', 'codex.md'), 'utf8');
  assert(!skill.includes('Codex has no per-spawn model'), 'stale claim that Codex lacks per-spawn model selection');
  assert(codex.includes('only when retaining that agent\'s model and effort is intended'));
  assert(codex.includes('fresh spawn with a unique task name'));
  assert(codex.includes('fork_turns: "none"'));
  assert(codex.includes('Log the new name as a new delegation before spawning'));
  assert(codex.includes('resolved model and effort'));
  assert(codex.includes('exact `turn_id` window'));
  assert(codex.includes('.pending/codex-completions/<event_id>.json'));
  assert(codex.includes('including a `wait_agent` dispatch'));
  assert(codex.includes('`--dry-run` previews reconciliation and does not mutate'));
});

test('Director CI guidance: one gated merge call, disable auto-merge before pushes, milestone-close CI rule', () => {
  const dir = path.join(skillsDir, 'director');
  const merging = fs.readFileSync(path.join(dir, 'references', 'merging.md'), 'utf8');
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert(merging.includes('Merge in ONE call holding exactly three things: the CI gate, the merge and the comment'));
  assert(merging.includes('ci-wait.js" <n> --once --sha <head_sha> && gh pr merge <n> --squash --delete-branch --match-head-commit <head_sha> && gh pr comment <n>'));
  assert(merging.includes('if ($LASTEXITCODE -eq 0)'));
  assert(merging.includes('Never join the gate, merge and comment with a bare `;`; use `&&` in sh'));
  assert(!merging.includes('in a Bash call of its own'), 'stale call-of-its-own rule');
  assert(merging.includes('disable auto-merge first'));
  assert(merging.includes('--disable-auto'));
  assert(merging.includes('reconcile-logs.js" --merges'));
  assert(skill.includes('Before any push to a queued PR, disable auto-merge first'));
  assert(skill.includes('report "complete" only on green'));
  assert(merging.includes('report "complete" only on green'));
  assert(skill.includes('ask the user; don\'t merge'));
});

test('Director CI guidance: allow-none, auto-merge conditions, unknown, queued state, fallbacks, GitLab cancel', () => {
  const dir = path.join(skillsDir, 'director');
  const merging = fs.readFileSync(path.join(dir, 'references', 'merging.md'), 'utf8');
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const codex = fs.readFileSync(path.join(dir, 'references', 'codex.md'), 'utf8');
  const gitlab = fs.readFileSync(path.join(dir, 'references', 'gitlab.md'), 'utf8');
  const status = fs.readFileSync(path.join(ROOT, 'templates', 'project', 'STATUS.md'), 'utf8');
  // --allow-none only with --sha
  assert(merging.includes('use the same call with `--allow-none` after `--sha <head_sha>` (`--allow-none` only passes with a matching `--sha`)'));
  // --auto only with named required checks and auto-merge allowed
  assert(merging.includes('Auto-merge is usable when `STATUS.md`\'s CI block records named required checks on the milestone base and "Allow auto-merge" on (GitLab: "Pipelines must succeed" on;'));
  assert(merging.includes('without named ones it could merge before CI ran'));
  // Codex: PS 5.1 gate form and the reviewer re-wait followup
  assert(codex.includes('ci-wait.js" <n> --once --sha <head_sha>; if ($LASTEXITCODE -eq 0) { gh pr merge <n> --squash --delete-branch --match-head-commit <head_sha>; if ($LASTEXITCODE -eq 0) { gh pr comment <n>'));
  assert(codex.includes('send a followup to the same reviewer ("wait again and report ci", `kind=followup`'));
  assert(merging.includes('Send a followup to the same reviewer ("wait again and report ci", `kind=followup`, same attempt)'));
  // STATUS template: queued state and CI block; waiting CI is used by the fallbacks
  assert(status.includes('`queued` (auto-merge on, not yet merged)'));
  assert(status.includes('`waiting CI`'));
  assert(status.includes('## CI'));
  assert(status.includes('- Required checks on `milestone/*`:'));
  assert(status.includes('- Auto-merge ("Allow auto-merge"; GitLab: "Pipelines must succeed"): on / off'));
  assert(merging.includes('set the state to `waiting CI`'));
  assert(codex.includes('set the state to `waiting CI`'));
  assert(skill.includes('state `queued` or `waiting CI`'));
  // First-CI-run trigger points at the setup steps
  assert(skill.includes('On the first task PR whose CI has run on the milestone, do this once'));
  assert(skill.includes('ci-wait.js" --names <n>'));
  assert(skill.includes('"CI names and auto-merge (after the first CI run)"'));
  assert(skill.includes('README\'s "Required check names"'));
  assert(skill.includes('You never change repo settings yourself'));
  // Milestone close: ci-wait on the milestone PR
  assert(skill.includes('`node "<plugin root>/scripts/ci-wait.js" <milestone PR> --once`'));
  assert(merging.includes('(5) `node "<plugin root>/scripts/ci-wait.js" <milestone PR> --once`'));
  // Reviewer unknown: the Director asks the user, never queues or waits; only a reviewed head is merged or queued
  assert(skill.includes('When it is `unknown`, don\'t merge, don\'t queue and don\'t wait: ask the user.'));
  assert(merging.includes('Don\'t merge, don\'t queue and don\'t wait: ask the user.'));
  assert(skill.includes('Commits pushed after the review get an incremental review first, and that review\'s result decides.'));
  assert(skill.includes('When it is `red`, don\'t merge: send it back to the implementer with the failing check names, unless the reviewer approved and explained why the failure isn\'t this PR\'s fault, in which case ask the user'));
  assert(skill.includes('"Pipelines must succeed" in Settings → Merge requests'), 'GitLab first-CI-run step');
  assert(skill.includes('Only a reviewed head (`head_sha`) is ever merged or queued'));
  // GitLab: the cancel row is a glab api call, and merging.md points at it
  assert(gitlab.includes('glab api -X POST projects/:id/merge_requests/<n>/cancel_merge_when_pipeline_succeeds'));
  assert(gitlab.includes('untested against a live instance'));
  assert(!merging.includes('GitLab: cancel auto-merge'), 'merging.md must point at the gitlab.md cancel row');
  assert(merging.includes('GitLab: the cancel row in `gitlab.md`'));
  assert(!gitlab.includes('GitLab may queue the merge to happen when the pipeline succeeds'), 'stale running-pipeline paragraph');
  assert(gitlab.includes('The gate passes only on a green pipeline'));
  assert(gitlab.includes('Treat a queued MR as merged only after a checkpoint'));
});

// Split a markdown file into sections keyed by their heading line.
function sections(text) {
  const out = [];
  let cur = { heading: '', lines: [] };
  for (const line of text.split('\n')) {
    if (/^#{2,3} /.test(line)) { out.push(cur); cur = { heading: line, lines: [] }; } else cur.lines.push(line);
  }
  out.push(cur);
  return out.map((x) => ({ heading: x.heading, body: x.lines.join('\n') }));
}

test('merging.md: the --auto block sits in the pending case under its own lead-in; unknown has its own section with no queue step', () => {
  const merging = fs.readFileSync(path.join(skillsDir, 'director', 'references', 'merging.md'), 'utf8');
  const lines = merging.split('\n');
  // Precondition: the gated sh queue command appears in exactly one code line (decision 0018)
  const autoIdx = lines.map((l, i) => (l.startsWith('node "<plugin root>/scripts/ci-wait.js" <n> --queue-check --sha <head_sha> && gh pr merge <n> --auto ') ? i : -1)).filter((i) => i >= 0);
  eq(autoIdx.length, 1, 'expected exactly one gated gh pr merge --auto code line');
  const fence = autoIdx[0] - 1;
  eq(lines[fence], '```bash', 'the --auto line must open its own code block');
  // The non-empty line before the block is the pending lead-in, alone in its paragraph
  let lead = fence - 1;
  while (lead >= 0 && lines[lead].trim() === '') lead--;
  eq(lines[lead], 'If auto-merge is usable, queue the pending PR:', 'lead-in before the --auto block');
  eq(lines[lead - 1].trim(), '', 'the lead-in must be its own paragraph');
  // The block sits under the pending heading
  const secs = sections(merging);
  const pendingIdx = secs.findIndex((x) => x.heading === '### Reviewer reported `ci: pending`');
  assert(pendingIdx >= 0, 'no "Reviewer reported `ci: pending`" section');
  const pending = secs[pendingIdx].body;
  assert(pending.includes('&& gh pr merge <n> --auto '), 'the --auto block must be in the pending section');
  assert(pending.includes('--queue-check --sha <head_sha>; if ($LASTEXITCODE -eq 0) { gh pr merge <n> --auto '), 'PowerShell 5.1 gated queue shape');
  assert(pending.includes('--queue-check --sha <head_sha> && glab mr merge <n> --auto-merge '), 'GitLab gated queue shape');
  for (const exit of ['Exit 5 (not queueable', 'Exit 1 (red)', 'Exit 4 (head moved)', 'Exit 2 (the helper can\'t tell)']) eq(lines.filter((l) => l.startsWith(`- ${exit}`)).length, 1, `queue-check ${exit}`);
  assert(pending.includes('the queue-check decides, and a wrong note costs a failed queue call, never an ungated merge'), 'note is not the gate');
  assert(!/unknown/.test(pending), 'the pending section must not mention unknown');
  // unknown: its own section, after the pending one, with no queue, merge or wait step
  const unknownIdx = secs.findIndex((x) => x.heading === '### Reviewer reported `ci: unknown`');
  assert(unknownIdx >= 0, 'no "Reviewer reported `ci: unknown`" section');
  assert(unknownIdx > pendingIdx, 'unknown section must come after the pending section');
  const unknown = secs[unknownIdx].body;
  assert(unknown.includes('ask the user'), 'unknown must ask the user');
  assert(!unknown.includes('--auto') && !unknown.includes('--timeout') && !unknown.includes('```'), 'unknown section must hold no command');
  const unnegated = unknown.replace(/Don't merge, don't queue and don't wait/g, '');
  assert(!/\b(queue|merge|wait)\b/i.test(unnegated), `unknown section has a queue/merge/wait step: ${unnegated}`);
  // No paragraph anywhere mixes unknown with a queue step
  for (const para of merging.split(/\n\s*\n/)) {
    if (/unknown/.test(para)) assert(!/queue it|queue the|--auto\b/.test(para), `paragraph mixes unknown and queueing: ${para}`);
  }
  // Every non-green gate exit has exactly one instruction line
  for (const code of ['1 (red)', '8 (pending)', '4 (head moved)', '2 (`unknown`', '3 (none)']) {
    eq(lines.filter((l) => l.startsWith(`- ${code}`)).length, 1, `gate exit ${code}`);
  }
  // Red never merges, even when the reviewer approved
  const red = secs.find((x) => x.heading === '### Red CI');
  assert(red, 'no "Red CI" section');
  assert(red.body.includes('still don\'t merge'), 'red must never merge');
  assert(red.body.includes('send it back to the implementer with the failing check names'), 'red goes back to the implementer');
  for (const route of ['the reviewer', 'the merge-call gate (exit 1)', 'a checkpoint', 'a cancelled auto-merge']) {
    assert(red.body.includes(route), `Red CI must cover the route: ${route}`);
  }
  const cancelled = lines.filter((l) => l.startsWith('- Cancelled or red:'));
  eq(cancelled.length, 1, 'one checkpoint line for cancelled or red');
  assert(cancelled[0].includes('send it back to the implementer with the failing check names'), 'checkpoint red goes back to the implementer');
  // The fallback's extra wait happens once
  assert(pending.includes('Still pending after this one extra wait: tell the user'), 'single extra wait');
});

test('Reviewer CI wait: review work first, 900 s budget, unknown vs pending, blocking-finding single check', () => {
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'reviewer.md'), 'utf8');
  // The wait is the last numbered step: nothing numbered after it
  const steps = [...reviewer.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
  const waitIdx = steps.findIndex((x) => x.text.startsWith('Wait for CI last'));
  assert(waitIdx >= 0, 'no wait step in the numbered review steps');
  eq(waitIdx, steps.length - 1, 'wait must be the last numbered step');
  assert(steps.findIndex((x) => x.text.startsWith('For tests the PR adds')) < waitIdx);
  assert(steps.findIndex((x) => x.text.startsWith('Separate blocking problems')) < waitIdx);
  assert(!reviewer.includes('so it runs while you review'), 'stale: CI does not run while you review');
  // Second call and the budget
  assert(reviewer.includes('`--timeout <900 - waited>`'));
  assert(reviewer.includes('counts only the time spent inside `ci-wait.js` (the sum of the `waited_s` it reports)'));
  assert(reviewer.includes('at most 2 calls per reviewed head'));
  assert(reviewer.includes('The two-call cap starts again for each reviewed head'));
  // The Codex re-wait followup is an explicit exception to the per-head cap, not a contradiction of it
  assert(reviewer.includes('A Director followup asking you to "wait again and report ci" (the Codex fallback for pending CI) gets one more wait on the same head'));
  // Blocking finding: one --once check, not the full wait
  assert(reviewer.includes('ci-wait.js" <n> --once --sha <head_sha>`'));
  assert(reviewer.includes('`summary` must start with exactly `not waited: changes requested`'));
  // unknown is its own value; pending is a timeout (plus the one marked case)
  assert(reviewer.includes('"ci": "green | red | pending | none | unknown"'));
  assert(reviewer.includes('- `unknown`: the helper could not tell'));
  assert(reviewer.includes('Don\'t report it as `pending`'));
  assert(!/Report `pending` only on a timeout/.test(reviewer), 'old pending wording');
  assert(!/unknown[^.]*report `pending`/i.test(reviewer), 'unknown must not be reported as pending');
});

test('--watch appears in no Director file; the reviewer has it only as a fallback', () => {
  const files = walk(path.join(skillsDir, 'director'));
  assert(files.length > 0, 'no Director files scanned');
  for (const f of files) assert(!fs.readFileSync(f, 'utf8').includes('--watch'), `--watch in ${f}`);
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'reviewer.md'), 'utf8');
  assert(reviewer.includes('ci-wait.js" <n> --sha <head_sha>'));
  assert(reviewer.includes('"head_sha"'));
  assert(reviewer.includes('timeout: 600000'));
  assert(reviewer.includes('gh pr checks <n> --watch --fail-fast --interval 30'));
});

test('Codex mapping and Coach guidance separate requested from observed settings', () => {
  const mapping = fs.readFileSync(path.join(ROOT, 'docs', 'codex-mapping.md'), 'utf8');
  const coach = fs.readFileSync(path.join(ROOT, 'agents', 'coach.md'), 'utf8');
  assert(mapping.includes('full-history fork does not apply setting overrides'));
  assert(mapping.includes('this session\'s runtime result'));
  assert(coach.includes('not requested settings'));
  assert(coach.includes('Don\'t count a requested escalation as an executed higher-setting trial'));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert(readme.includes('drains snapshots from observed Codex stop events'));
  assert(readme.includes('A Codex stop that never reached the hook is recovered from the child transcript by `turn_id`'));
  assert(readme.includes('rebuilds missing Claude completion or review records'));
  assert(!readme.includes('Codex records come from its hooks'));
});
