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
// Steps of a job, split on the 6-space "- " that starts each step.
const stepsOf = (job) => jobBlock(job).split(/^ {6}- /m).slice(1);
const indexOfStep = (job, name) => stepsOf(job).findIndex((x) => x.startsWith('name: ' + name + '\n'));
const stepNamed = (job, name) => {
  const i = indexOfStep(job, name);
  assert(i >= 0, job + ' lacks the step: ' + name);
  return stepsOf(job)[i];
};
const BASE_CHECKOUT = 'Check out base branch config';
const RESTORE = 'Use base-branch scanner config';
const GUARD = 'Refuse a .scan-base from the PR';
const PR_ONLY = "        if: github.event_name == 'pull_request'\n";
const usesLine = (step) => (step.match(/^ {8}uses: .*$/m) || [''])[0];

test('both jobs check out the base SHA a second time, pinned like the first, with no credentials and a fixed path', () => {
  for (const job of ['trivy-fs', 'trivy-image']) {
    const first = stepNamed(job, 'Check out');
    const base = stepNamed(job, BASE_CHECKOUT);
    assert(base.includes(PR_ONLY), job + ': base checkout not limited to pull_request');
    assert(usesLine(base) && usesLine(base) === usesLine(first), job + ': base checkout not pinned to the same SHA as the first');
    assert(base.includes('          ref: ${{ github.event.pull_request.base.sha }}\n'), job + ': base checkout lacks ref: base.sha');
    assert(base.includes('          persist-credentials: false'), job + ': base checkout persists credentials');
    const p = base.match(/^ {10}path: (\S+)$/m);
    assert(p, job + ': base checkout lacks a path');
    assert(p[1] === '.scan-base', job + ': unexpected base checkout path ' + p[1]);
    assert(!/^ {10}(ref|path):/m.test(first), job + ': the first checkout must scan the PR tree (no ref or path)');
    assert(indexOfStep(job, 'Check out') < indexOfStep(job, BASE_CHECKOUT), job + ': base checkout must come after the first');
  }
});

// A PR that commits .scan-base (say a symlink to .) would make the second
// checkout reuse the workspace repo and check the base out over the PR tree.
test('both jobs fail closed on a .scan-base from the PR, in the step right before the base checkout', () => {
  for (const job of ['trivy-fs', 'trivy-image']) {
    const g = indexOfStep(job, GUARD);
    const b = indexOfStep(job, BASE_CHECKOUT);
    assert(g >= 0, job + ' lacks the step: ' + GUARD);
    assert(b >= 0 && g === b - 1, job + ': the .scan-base guard must be the step immediately before the base checkout (guard ' + g + ', checkout ' + b + ')');
    const step = stepsOf(job)[g];
    assert(step.includes(PR_ONLY), job + ': the .scan-base guard is not run on pull_request');
    const run = step.split(/^ {8}run: \|\n/m)[1];
    assert(run !== undefined, job + ': the .scan-base guard has no run: | script');
    // -e misses a dangling symlink, so -L is needed too; the branch must exit non-zero, not remove the path.
    assert(/^ {10}if \[ -e \.scan-base \] \|\| \[ -L \.scan-base \]; then\n {12}echo "::error::[^"\n]+"\n {12}exit 1\n {10}fi\n?$/.test(run),
      job + ': the guard must be exactly: if [ -e .scan-base ] || [ -L .scan-base ]; then echo "::error::..."; exit 1; fi, got:\n' + run);
    assert(!/rm |continue-on-error|\|\| true/.test(step), job + ': the guard must fail the job, not remove the path or swallow the exit');
  }
});

test('both jobs restore the four Trivy files from the base checkout on pull_request, delete it, all before Trivy', () => {
  for (const job of ['trivy-fs', 'trivy-image']) {
    const step = stepNamed(job, RESTORE);
    assert(step.includes(PR_ONLY), job + ': restore not limited to pull_request');
    assert(step.includes('for f in trivy.yaml .trivyignore .trivyignore.yaml trivy-secret.yaml; do\n'), job + ': restore does not loop over exactly the four files');
    const rm = step.indexOf('rm -f "$f"');
    const guard = step.indexOf('if [ -f ".scan-base/$f" ]; then');
    const cp = step.indexOf('cp ".scan-base/$f" "$f"');
    assert(rm >= 0, job + ': the PR copy is not removed first');
    assert(guard >= 0, job + ': no guard for a base that lacks the file');
    assert(cp > guard, job + ': copy not behind the guard');
    assert(rm < guard, job + ': the PR copy must be removed before the guarded copy, so a base without the file leaves none');
    const del = step.indexOf('rm -rf .scan-base');
    assert(del > cp, job + ': the base checkout is not deleted after the copy');
    assert(step.indexOf('done', cp) < del, job + ': the base checkout must be deleted after the loop');
    const trivy = stepsOf(job).findIndex((x) => x.includes('aquasecurity/trivy-action'));
    const order = [indexOfStep(job, 'Check out'), indexOfStep(job, GUARD), indexOfStep(job, BASE_CHECKOUT), indexOfStep(job, RESTORE), trivy];
    assert(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), job + ': order must be checkout, .scan-base guard, base checkout, restore, Trivy: ' + order);
  }
});

test('trivy-fs keeps the PR copies of the four config files in .scan-pr-config so the secret scan reads them', () => {
  const step = stepNamed('trivy-fs', RESTORE);
  const mk = step.indexOf('mkdir .scan-pr-config');
  const keep = step.indexOf('cp "$f" ".scan-pr-config/$f"');
  const rm = step.indexOf('rm -f "$f"');
  assert(mk >= 0 && mk < step.indexOf('for f in'), 'mkdir .scan-pr-config (fails if the PR has the path) must precede the loop');
  assert(keep >= 0 && keep < rm, 'the PR copy must be copied aside before it is removed');
  assert(step.indexOf('rm -rf .scan-pr-config') < 0, '.scan-pr-config must stay for the scan');
  const scan = stepNamed('trivy-fs', 'Trivy file system scan');
  assert(/scan-ref: \.\n/.test(scan) && /scanners: vuln,misconfig,secret/.test(scan) && /exit-code: '1'/.test(scan), 'fs scan must cover the workspace with secret and fail on findings');
});

test('push runs are limited to main; milestone/** is not a push trigger', () => {
  const on = wf.split(/^permissions:/m)[0];
  assert(/^  push:\n    branches:\n      - main\n/m.test(on), 'push must list main');
  assert(!/milestone\/\*\*'?\n/.test(on.replace(/^#.*$/gm, '')), 'milestone/** is back in the push trigger');
});

test('the base SHA appears only in with: ref, never in a run script, and no git fetch is used', () => {
  const lines = wf.split('\n').filter((l) => l.includes('base.sha'));
  assert(lines.length === 2, 'expected base.sha in exactly the two base checkouts, got ' + lines.length);
  for (const l of lines) assert(/^ {10}ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/.test(l), 'base.sha outside with: ref: ' + l);
  let runs = 0;
  for (const job of ['trivy-fs', 'detect-dockerfile', 'trivy-image']) {
    for (const st of stepsOf(job)) {
      const run = st.split(/^ {8}run: /m)[1];
      if (run === undefined) continue;
      runs++;
      assert(!run.includes('${{'), job + ': inline expression in run of step ' + st.split('\n')[0]);
    }
  }
  assert(runs === 6, 'expected six run steps (guard and restore in two jobs, detect, build), parsed ' + runs);
  assert(!/git (fetch|show|cat-file)|BASE_SHA/.test(wf), 'a token-less git fetch or BASE_SHA remains');
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

test('team-init step 6 and decision 0027 state the limits of the base-config restore', () => {
  const step6 = (read('skills/team-init/SKILL.md').match(/^6\. Offer the optional security scan.*$/m) || [''])[0];
  assert(step6, 'team-init step 6 not found');
  for (const w of ['shows as skipped, not passed', 'from the base branch', 'base `trivy.yaml` names', 'edit the workflow itself', 'required workflow'])
    assert(step6.includes(w), 'team-init step 6 lacks: ' + w);
  const d = read('docs/decisions/0027-scanner-template-base-config.md');
  const assumptions = (d.split(/^## Assumptions\n/m)[1] || '').split(/^## /m)[0];
  for (const w of ['except for files a\n  base `trivy.yaml` names', 'A skipped required job does not block a merge', 'Inline `trivy:ignore` comments are not covered',
    'can\n  still edit the workflow itself', 'unparsed and has had no live run'])
    assert(assumptions.includes(w), '0027 assumptions lack: ' + w.replace(/\n\s*/g, ' '));
  assert(!/cannot weaken/.test(wf), 'the template header still claims a PR cannot weaken its scan');
  for (const w of ['editing this\n# workflow', 'trivy:ignore', 'Dockerfile (trivy-image is then skipped'])
    assert(wf.split(/^name: /m)[0].includes(w), 'template header lacks the gap: ' + w.replace(/\n# /g, ' '));
});

test('STATUS template has the xlarge grant section and second-review line', () => {
  const s = read('templates/project/STATUS.md');
  assert(/^## xlarge grant$/m.test(s), 'heading missing');
  assert(/^- Second security review:/m.test(s), 'second-review line missing');
  assert(s.includes('`in security review`') && s.includes('security-sensitive'), 'states or flag line missing');
  for (const w of ['(auto-merge on, not yet merged)', '`waiting CI`', '`merged`']) assert(s.includes(w), 'lost ' + w);
});
