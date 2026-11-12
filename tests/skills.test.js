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
  assert(merging.includes('In sh never join with a bare `;`'));
  assert(!merging.includes('in a Bash call of its own'), 'stale call-of-its-own rule');
  assert(merging.includes('disable auto-merge first'));
  assert(merging.includes('--disable-auto'));
  assert(merging.includes('reconcile-logs.js" --merges'));
  assert(skill.includes('Before any push to a queued PR, disable auto-merge first'));
  assert(skill.includes('report "complete" only on green'));
  assert(merging.includes('report "complete" only on green'));
  assert(skill.includes('ask the user; don\'t merge'));
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
