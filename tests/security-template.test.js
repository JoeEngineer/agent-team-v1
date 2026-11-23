const fs = require('fs');
const path = require('path');
const { test, assert, ROOT } = require('./helpers');

console.log('security template');

const rel = 'templates/project/.github/workflows/security-scan.yml';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const wf = read(rel);

test('security-scan template exists and is named in team-init', () => {
  assert(fs.existsSync(path.join(ROOT, rel)), 'template missing');
  assert(read('skills/team-init/SKILL.md').includes(rel), 'team-init does not name ' + rel);
});

test('every uses: is pinned to a 40-hex SHA with a version comment', () => {
  const uses = wf.split('\n').filter((l) => /^\s*(-\s*)?uses:/.test(l));
  assert(uses.length >= 2, 'expected at least two uses: lines, got ' + uses.length);
  for (const l of uses) assert(/uses:\s*\S+@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\s*$/.test(l), 'not pinned: ' + l);
});

test('no pull_request_target and no write permission', () => {
  assert(!/pull_request_target/.test(wf), 'pull_request_target used');
  assert(!/write/.test(wf), 'write found');
  assert(/^permissions:\n  contents: read\n/m.test(wf), 'top-level permissions must be contents: read');
});

test('every job has a timeout and a name', () => {
  const jobs = wf.split(/^jobs:\n/m)[1].split(/^  (?=[\w-]+:\n)/m).filter(Boolean);
  assert(jobs.length >= 2, 'expected two jobs');
  for (const j of jobs) {
    assert(/^\s+name: \S+/m.test(j), 'job without name: ' + j.split('\n')[0]);
    assert(/timeout-minutes: \d+/.test(j), 'job without timeout: ' + j.split('\n')[0]);
  }
});

test('checkout does not persist credentials; Trivy is pinned; no commands/ string', () => {
  const checkouts = wf.match(/actions\/checkout@/g) || [];
  const persist = wf.match(/persist-credentials: false/g) || [];
  assert(checkouts.length > 0 && checkouts.length === persist.length, 'each checkout needs persist-credentials: false');
  const versions = [...wf.matchAll(/^\s+version:\s*(\S+)/gm)].map((m) => m[1]);
  assert(versions.length >= 2, 'Trivy version not set');
  for (const v of versions) assert(/^v\d+\.\d+\.\d+$/.test(v), 'Trivy version not pinned: ' + v);
  assert(!/version:\s*['"]?latest/i.test(wf), 'latest found');
  assert(!wf.includes('commands/'), 'contains commands/');
  assert(!/upload|sarif/i.test(wf), 'upload or SARIF found');
});

test('job names are exactly trivy-fs and trivy-image', () => {
  const names = [...wf.matchAll(/^    name: (.+)$/gm)].map((m) => m[1].trim());
  assert(JSON.stringify(names) === JSON.stringify(['trivy-fs', 'trivy-image']), 'job names: ' + names.join(','));
});

test('image build and Trivy image steps carry the Dockerfile guard; skip notice has the inverse', () => {
  const guard = "if: steps.dockerfile.outputs.found == 'true'";
  const steps = wf.split(/^      - name: /m).slice(1);
  const build = steps.find((s) => s.startsWith('Build image'));
  const scan = steps.find((s) => s.startsWith('Trivy image scan'));
  assert(build && build.includes(guard), 'build step lacks guard');
  assert(scan && scan.includes(guard), 'image scan step lacks guard');
  const note = steps.find((s) => s.includes('::notice::No Dockerfile'));
  assert(note && note.includes("found != 'true'"), 'skip notice missing or unguarded');
});

test('STATUS template has the xlarge grant section and second-review line', () => {
  const s = read('templates/project/STATUS.md');
  assert(/^## xlarge grant$/m.test(s), 'heading missing');
  assert(/^- Second security review:/m.test(s), 'second-review line missing');
  assert(s.includes('`in security review`') && s.includes('security-sensitive'), 'states or flag line missing');
  for (const w of ['(auto-merge on, not yet merged)', '`waiting CI`', '`merged`']) assert(s.includes(w), 'lost ' + w);
});
