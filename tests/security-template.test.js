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

test('job names trivy-fs and trivy-image are unchanged, with the detect job between', () => {
  const names = [...wf.matchAll(/^    name: (.+)$/gm)].map((m) => m[1].trim());
  assert(JSON.stringify(names) === JSON.stringify(['trivy-fs', 'detect-dockerfile', 'trivy-image']), 'job names: ' + names.join(','));
});

const jobBlock = (id) => {
  const part = wf.split(new RegExp('^  ' + id + ':\\n', 'm'))[1];
  assert(part, 'job missing: ' + id);
  return part.split(/^  (?=[\w-]+:\n)/m)[0];
};
const restoreStep = (job) => {
  const m = jobBlock(job).split(/^      - name: /m).find((x) => x.startsWith('Use base-branch scanner config'));
  assert(m, job + ' lacks the base-branch restore step');
  return m;
};

test('both jobs restore the four Trivy files from the base SHA on pull_request, before Trivy', () => {
  for (const job of ['trivy-fs', 'trivy-image']) {
    const step = restoreStep(job);
    assert(step.includes("if: github.event_name == 'pull_request'"), job + ': restore not limited to pull_request');
    for (const f of ['trivy.yaml', '.trivyignore', '.trivyignore.yaml', 'trivy-secret.yaml']) assert(step.includes(f), job + ': restore misses ' + f);
    assert(step.includes('git show "$BASE_SHA:$f" > "$f"'), job + ': no restore from base');
    assert(step.includes('rm -f "$f"'), job + ': no removal when the base has none');
    assert(/git fetch [^\n]*"\$BASE_SHA"/.test(step), job + ': base commit not fetched');
    const j = jobBlock(job);
    assert(j.indexOf('Use base-branch scanner config') < j.indexOf('aquasecurity/trivy-action'), job + ': restore must precede Trivy');
  }
});

test('base SHA reaches the script through env, never inline in run', () => {
  for (const job of ['trivy-fs', 'trivy-image']) {
    const step = restoreStep(job);
    assert(step.includes('        env:\n          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n'), job + ': BASE_SHA not set via env');
    const run = step.split(/^ {8}run: \|\n/m)[1];
    assert(run && !run.includes('${{'), job + ': run script has an inline expression');
  }
  // every run: block in the file is free of inline expressions
  const runs = wf.split(/^ {8}run: /m).slice(1).map((r) => r.split(/^ {6}- /m)[0].split(/^\S|^ {2}\S/m)[0]);
  for (const r of runs) assert(!r.includes('${{'), 'inline expression in run: ' + r.slice(0, 40));
});

test('trivy-image is skipped by a job-level if when there is no Dockerfile; detect job gives the output', () => {
  const j = jobBlock('trivy-image');
  assert(/^ {4}needs: detect-dockerfile$/m.test(j), 'trivy-image must need the detect job');
  assert(/^ {4}if: needs\.detect-dockerfile\.outputs\.found == 'true'$/m.test(j), 'trivy-image lacks the job-level if');
  const d = jobBlock('detect-dockerfile');
  assert(/outputs:\n {6}found: \$\{\{ steps\.dockerfile\.outputs\.found \}\}/.test(d), 'detect job lacks the found output');
  assert(d.includes('[ -f Dockerfile ]'), 'detect job does not look for a root Dockerfile');
  assert(!/::notice::|continue-on-error/.test(wf), 'a passing no-op path remains');
});

test('STATUS template has the xlarge grant section and second-review line', () => {
  const s = read('templates/project/STATUS.md');
  assert(/^## xlarge grant$/m.test(s), 'heading missing');
  assert(/^- Second security review:/m.test(s), 'second-review line missing');
  assert(s.includes('`in security review`') && s.includes('security-sensitive'), 'states or flag line missing');
  for (const w of ['(auto-merge on, not yet merged)', '`waiting CI`', '`merged`']) assert(s.includes(w), 'lost ' + w);
});
