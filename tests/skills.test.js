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

// What the Director's and the role agents' files must say is checked by
// tests/guidance.test.js against the rule inventory (tests/guidance-rules.js).

test('STATUS template: the task states and the CI block the Director fills', () => {
  const status = fs.readFileSync(path.join(ROOT, 'templates', 'project', 'STATUS.md'), 'utf8');
  assert(status.includes('`queued` (auto-merge on, not yet merged)'));
  assert(status.includes('`waiting CI`'));
  assert(status.includes('## CI'));
  assert(status.includes('- Required checks on `milestone/*`:'));
  assert(status.includes('- Auto-merge ("Allow auto-merge"; GitLab: "Pipelines must succeed"): on / off'));
  assert(status.includes('`merge-task.js … --names`'), 'names come from the merge command');
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
