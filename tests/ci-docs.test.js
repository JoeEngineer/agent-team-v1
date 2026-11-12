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
  assert(MAPPING.includes('| Queue merge after CI | `gh pr merge <n> --auto --squash --delete-branch --match-head-commit <sha>` | `glab mr merge <n> --auto-merge --squash --remove-source-branch --yes --sha <sha>` |'), 'auto-merge row');
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

test('plugin manifests are 0.6.0', () => {
  eq(JSON.parse(read('plugin.json')).version, '0.6.0', 'plugin.json version');
  eq(JSON.parse(read('.claude-plugin/plugin.json')).version, '0.6.0', '.claude-plugin/plugin.json version');
});
