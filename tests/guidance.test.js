// The guidance the agents read (the Director skill, its references, the role
// files): every rule in tests/guidance-rules.js is present in its home file,
// the files stay inside their size budgets, and the things that drifted when
// they were written out in several places are written out in one. Method:
// docs/guidance.md and decision 0020. Loaded and run by tests/run.js.
'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert, eq, ROOT } = require('./helpers');
const RULES = require('./guidance-rules');

console.log('guidance');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const DIRECTOR = 'skills/director';
const REFS = fs.readdirSync(path.join(ROOT, DIRECTOR, 'references')).filter((f) => f.endsWith('.md')).sort();
const AGENTS = fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).sort();
// Everything an agent reads as instructions.
const GUIDANCE = [`${DIRECTOR}/SKILL.md`, ...REFS.map((f) => `${DIRECTOR}/references/${f}`), ...AGENTS.map((f) => `agents/${f}`)];
const text = Object.fromEntries(GUIDANCE.map((f) => [f, read(f)]));
const bytes = (rel) => Buffer.byteLength(read(rel), 'utf8');

// ---- the inventory ----------------------------------------------------------

test('inventory: ids are unique and every entry is complete', () => {
  const seen = new Set();
  for (const [id, home, anchor, rule] of RULES) {
    assert(/^[A-Z]{1,2}-\d{2}$/.test(id), `bad id ${id}`);
    assert(!seen.has(id), `duplicate id ${id}`);
    seen.add(id);
    assert(fs.existsSync(path.join(ROOT, home)), `${id}: home ${home} does not exist`);
    assert(anchor instanceof RegExp, `${id}: anchor must be a regex`);
    assert(typeof rule === 'string' && rule.length >= 15, `${id}: rule text missing`);
    assert(anchor.source.length <= 90, `${id}: anchor is ${anchor.source.length} chars; an anchor is a few distinctive words, not the sentence`);
  }
  assert(RULES.length >= 200, `only ${RULES.length} rules: the inventory must not shrink by accident`);
});

test('inventory: every rule is stated in its home file', () => {
  const missing = RULES.filter(([, home, anchor]) => !anchor.test(read(home))).map(([id, home, , rule]) => `${id} (${home}): ${rule}`);
  eq(missing.join('\n'), '', 'rules missing from their home file');
});

test('inventory: every guidance file has rules, and the script-enforced ones name a script that exists', () => {
  const homes = new Set(RULES.map(([, home]) => home));
  for (const f of GUIDANCE) assert(homes.has(f), `${f} holds no inventoried rule`);
  const enforcers = { guard: 'guard.js', 'merge-task': 'merge-task.js', 'ci-wait': 'ci-wait.js', logger: 'log-delegation.js', 'handback-check': 'handback-check.js', 'session-start': 'session-start.js' };
  for (const [id, , , , enforced] of RULES) {
    if (enforced === undefined) continue;
    assert(enforcers[enforced], `${id}: unknown enforcer ${enforced}`);
    assert(fs.existsSync(path.join(ROOT, 'scripts', enforcers[enforced])), `${id}: scripts/${enforcers[enforced]} missing`);
  }
});

// ---- size budgets -----------------------------------------------------------
// Claude Code re-attaches only the first 5,000 tokens of an invoked skill after
// a compaction, and nothing of the reference files it had read. SKILL.md holds
// every rule that must survive, so it stays far below that cap (bytes / 3 is a
// safe over-estimate of tokens for this kind of text). The other budgets stop
// the files growing back a sentence at a time: to add a rule, find the room.
const BUDGET = {
  'skills/director/SKILL.md': 9400,
  'skills/director/references/merging.md': 9430,
  'skills/director/references/routing.md': 7850,
  'skills/director/references/task-card.md': 6200,
  'skills/director/references/decisions.md': 1800,
  'skills/director/references/codex.md': 7500,
  'skills/director/references/gitlab.md': 4200,
  'agents/reviewer.md': 9500,
  'agents/implementer.md': 6000,
  'agents/coach.md': 12970,
  'agents/architect.md': 3000,
  'agents/scout.md': 1500,
  'agents/security-reviewer.md': 8040,
};

test('budgets: every guidance file has a budget and is inside it', () => {
  for (const f of GUIDANCE) {
    assert(BUDGET[f], `${f} has no size budget`);
    const n = bytes(f);
    assert(n <= BUDGET[f], `${f} is ${n} bytes, over its ${BUDGET[f]}-byte budget. Move detail to a reference or a script's output, or drop something, before raising the budget`);
  }
});

test('budgets: SKILL.md fits the post-compaction re-attach cap with room to spare', () => {
  const tokens = Math.ceil(bytes('skills/director/SKILL.md') / 3);
  assert(tokens <= 3500, `SKILL.md is about ${tokens} tokens by the bytes/3 estimate; the cap is 5,000 and the budget 3,500`);
});

test('budgets: what a Claude + GitHub Director loads (SKILL, merging, routing, task-card, decisions) stays under 33.8 KB', () => {
  const core = ['SKILL.md', 'references/merging.md', 'references/routing.md', 'references/task-card.md', 'references/decisions.md'];
  const total = core.reduce((sum, f) => sum + bytes(`${DIRECTOR}/${f}`), 0);
  assert(total <= 33800, `the core Director set is ${total} bytes (it was 42,073 before 1.0.0, about 28,800 in 1.0.2; decision 0025 caps it at 33,800)`);
});

// ---- one home per thing -----------------------------------------------------

const filesWith = (re) => GUIDANCE.filter((f) => re.test(text[f]));

test('single source: the merge is never written out by hand in the guidance', () => {
  eq(filesWith(/\b(gh pr merge|glab mr merge) <n> [^\n`]*--(squash|auto)/).join(','), '', 'a typed merge command');
  eq(filesWith(/--match-head-commit/).join(','), '', '--match-head-commit');
  eq(filesWith(/\$LASTEXITCODE/).join(','), '', 'a PowerShell exit-code chain');
  // (the Coach reads --queue-check in logged commands; nobody else runs it)
  eq(filesWith(/--queue-check/).filter((f) => f !== 'agents/coach.md').join(','), '', 'the queue check (it lives inside merge-task.js)');
  // The one typed merge command left is the auto-merge cancel.
  assert(text[`${DIRECTOR}/references/merging.md`].includes('gh pr merge <n> --disable-auto'), 'the cancel command');
});

test('single source: each command line has one home', () => {
  eq(filesWith(/merge-task\.js" <n> --sha/).join(','), `${DIRECTOR}/references/merging.md`, 'the merge command line');
  eq(filesWith(/reconcile-logs\.js" --merges/).join(','), `${DIRECTOR}/references/merging.md`, 'the checkpoint command');
  eq(filesWith(/archive-logs\.js"/).join(','), `${DIRECTOR}/references/merging.md`, 'the archive command');
  eq(filesWith(/^@'$/m).join(','), `${DIRECTOR}/references/codex.md`, 'the PowerShell here-string form');
  eq(filesWith(/0 green, 1 red/).join(','), 'agents/reviewer.md', 'the ci-wait exit-code list');
  eq(filesWith(/one `Closes #N` line/).join(','), `${DIRECTOR}/references/merging.md`, 'the Closes rule');
});

test('single source: the Director files name no model, and use <plugin root> for script paths', () => {
  for (const f of GUIDANCE.filter((g) => g.startsWith(DIRECTOR))) {
    assert(!/\$\{CLAUDE_PLUGIN_ROOT\}/.test(text[f]), `${f} uses \${CLAUDE_PLUGIN_ROOT}; write <plugin root>`);
    assert(!/--watch/.test(text[f]), `${f} has --watch: the Director never watches CI`);
  }
  assert(!/haiku|sonnet|opus|fable|gpt-/i.test(text[`${DIRECTOR}/references/routing.md`]), 'routing.md names a model');
  assert(!/haiku|sonnet|fable|gpt-/i.test(text[`${DIRECTOR}/SKILL.md`]), 'SKILL.md names a model');
});

// ---- the xlarge grant never widens by wording --------------------------------
// Decision 0022 grants "hard-fix escalation", and decision 0023 scopes it to a
// task that has failed twice at large/high. Ladder step 4 also covers a `reject`
// at any tier, so a no-ask sentence that doesn't name the large/high failures
// would send a rejected small or medium task to xlarge without the user's yes.

test('routing: xlarge runs "without asking" only for a task that has failed twice at large/high', () => {
  const noAsk = (t) => t.split(/(?<=\.)\s+|\n/).filter((s) => /without asking/.test(s));
  const unscoped = (t) => noAsk(t).filter((s) => !/a task that has failed twice at large\/high/.test(s));
  const routing = text[`${DIRECTOR}/references/routing.md`];
  eq(noAsk(routing).length, 1, 'routing.md has one no-ask sentence: the hard-fix grant in ladder step 4');
  eq(unscoped(routing).join('\n'), '', 'a no-ask sentence that is not scoped to a large/high failure');
  assert(/The grant doesn't cover a `reject` at a lower tier/.test(routing), 'a reject at a lower tier stays outside the grant');
  eq(unscoped('Stop. With `hard-fix` in the milestone\'s grant, the next attempt runs at xlarge/high without asking.').length, 1, 'detector flags the unscoped wording');
  eq(unscoped('A task that has already failed at large/high runs at xlarge/high without asking.').length, 1, 'detector flags the 1.1.0 wording (one failure)');
  eq(unscoped('With hard-fix, a task that has failed twice at large/high runs at xlarge/high without asking.').length, 0, 'detector accepts the scoped wording');
});

// ---- the escalation ladder and the grant (decision 0023) ---------------------

test('routing: ladder steps 3 and 4 send a large/high task back once, then go to xlarge or the user', () => {
  const routing = text[`${DIRECTOR}/references/routing.md`];
  const step = (n) => (routing.match(new RegExp(`^${n}\\. .*$`, 'm')) || [''])[0];
  assert(/Exit 1 means there is none, so the task is at large\/high: send back once to the same agent; on the next failure, step 4\./.test(step(3)), 'step 3: exit 1 sends it back once to the same agent, then step 4');
  assert(/A step 1 send-back at large\/high is that one\./.test(step(3)), 'step 3: a step 1 send-back at large/high counts as the one');
  assert(!/ask the user/.test(step(3)), 'step 3 no longer asks the user (step 4 does)');
  assert(/^4\. \*\*Large\/high failing a second time, or a verdict of `reject`:\*\*/.test(step(4)), 'step 4 starts at a second failure at large/high');
  assert(/as a new spawn of the role that made the failed attempt/.test(step(4)), 'the granted attempt belongs to the role that failed');
  assert(!/already failed at large/.test(routing), 'the 1.1.0 wording (one failure) is gone');
  assert(/hard-fix escalation, after a second failure at large\/high \| ask the user \| xlarge \/ high/.test(routing), 'the grant table row');
});

test('routing: the grant is what status.js prints, and the sentence that told the Director to re-read STATUS.md is gone', () => {
  const routing = text[`${DIRECTOR}/references/routing.md`];
  const section = routing.slice(routing.indexOf('## The xlarge grant'), routing.indexOf('## Local-only routes'));
  assert(section.includes('node "<plugin root>/scripts/status.js" grant --milestone <slug>'), 'the grant command');
  assert(!/re-read it there/.test(routing), 'the old re-read sentence');
  assert(!/is the `## xlarge grant` block/.test(routing), 'the old definition of the grant');
});

test('labels: the coach row of the grant is "coach (run for this milestone)" in the table, the intake question and the STATUS template; the log name stays coach', () => {
  const label = 'coach (run for this milestone)';
  const milestone = read('skills/milestone/SKILL.md');
  for (const [name, body] of [['routing.md', text[`${DIRECTOR}/references/routing.md`]], ['milestone SKILL.md', milestone], ['STATUS template', read('templates/project/STATUS.md')]]) {
    assert(body.includes(label), `${name} lacks "${label}"`);
    assert(!/coach \(at milestone close\)|coach at close/.test(body), `${name} still has the old coach label`);
  }
  assert(milestone.includes('"xlarge_grant":["security-review-close","security-review-task","architect","coach","hard-fix"]'), 'the logged role name is still coach');
});

test('task card: the reason row lists exactly the reasons the logger accepts, and the flags row the flags it knows', () => {
  const { ATTEMPT_REASONS, KNOWN_FLAGS } = require(path.join(ROOT, 'scripts', 'records.js'));
  const ticked = (row) => [...row.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).filter((w) => w !== 'reason');
  const rows = text[`${DIRECTOR}/references/task-card.md`].split('\n');
  const reasonRow = rows.find((l) => l.startsWith('| `reason`'));
  assert(reasonRow, 'the reason row');
  eq(ticked(reasonRow).sort().join(','), [...ATTEMPT_REASONS].sort().join(','), 'task-card.md reason values vs ATTEMPT_REASONS in scripts/records.js');
  assert(ATTEMPT_REASONS.includes('confirm'), 'ATTEMPT_REASONS has confirm');
  eq(ticked('a `x` and `y`, `reason`').join(','), 'x,y', 'the extractor reads backticked words');
  const flagsRow = rows.find((l) => l.startsWith('| `flags`'));
  assert(flagsRow, 'the flags row');
  for (const flag of KNOWN_FLAGS) assert(flagsRow.includes(flag), `the flags row lacks ${flag}`);
  assert(flagsRow.includes('flags=security-sensitive[,above-table]'), 'the flags= form');
});

// ---- structure --------------------------------------------------------------

const headings = (t) => [...t.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1].replace(/`/g, ''));

test('structure: SKILL.md lists every reference file, and every reference it names exists', () => {
  const skill = text[`${DIRECTOR}/SKILL.md`];
  for (const f of REFS) assert(skill.includes(`references/${f}`), `SKILL.md never points at references/${f}`);
  for (const m of skill.matchAll(/references\/([\w-]+\.md)/g)) assert(REFS.includes(m[1]), `SKILL.md names references/${m[1]}, which does not exist`);
});

test('structure: every quoted section name in the Director files is a real heading', () => {
  const all = GUIDANCE.filter((g) => g.startsWith(DIRECTOR)).flatMap((f) => headings(text[f]));
  let checked = 0;
  for (const f of GUIDANCE.filter((g) => g.startsWith(DIRECTOR))) {
    // `x.md`, "Section" and ("Section" below) forms
    for (const m of text[f].matchAll(/(?:\.md`?,? |\()"([A-Z][^"\n]{3,60})"(?: below| above)?[).,]/g)) {
      checked++;
      assert(all.some((h) => h === m[1] || h.startsWith(m[1])), `${f} points at a section "${m[1]}" that no Director file has`);
    }
  }
  assert(checked >= 6, `only ${checked} section pointers checked; the pattern must keep matching`);
});

test('structure: every script the guidance names exists', () => {
  const scripts = new Set(fs.readdirSync(path.join(ROOT, 'scripts')));
  let seen = 0;
  for (const f of GUIDANCE) {
    for (const m of text[f].matchAll(/\b([a-z][a-z-]+\.js)\b/g)) {
      if (m[1] === 'models.js' || scripts.has(m[1])) { seen++; continue; }
      assert(false, `${f} names ${m[1]}, which is not in scripts/`);
    }
  }
  assert(seen >= 20, 'script names were scanned');
});

test('structure: backticks balance on every line outside fenced code blocks', () => {
  const odd = (t) => {
    const bad = [];
    let fenced = false;
    t.split('\n').forEach((l, i) => {
      if (/^\s*```/.test(l)) { fenced = !fenced; return; }
      if (!fenced && ((l.match(/`/g) || []).length % 2)) bad.push(i + 1);
    });
    return bad;
  };
  for (const f of GUIDANCE) eq(odd(text[f]).join(','), '', `${f}: lines with an odd number of backticks`);
  eq(odd('a `b` c\n(1)`nothing is queued (when `x` row)').join(','), '2', 'detector flags a stray backtick');
});

test('structure: the reviewer waits for CI in its last numbered step', () => {
  const steps = [...text['agents/reviewer.md'].matchAll(/^(\d+)\. (.*)$/gm)].map((m) => m[2]);
  const wait = steps.findIndex((s) => s.startsWith('**Wait for CI last.**'));
  assert(wait >= 0, 'no wait step');
  eq(wait, steps.length - 1, 'the wait must be the last numbered step');
});

// ---- the merge script and the guidance agree --------------------------------

test('merging.md lists every state merge-task.js can print, with its exit code', () => {
  const { EXIT } = require(path.join(ROOT, 'scripts', 'merge-task.js'));
  const merging = text[`${DIRECTOR}/references/merging.md`];
  const rows = merging.split('\n').filter((l) => /^\| `[a-z_]+`/.test(l));
  for (const [state, code] of Object.entries(EXIT)) {
    const row = rows.find((l) => l.includes(`\`${state}\``));
    assert(row, `merging.md has no row for state ${state}`);
    assert(new RegExp(`\\b${code}\\b`).test(row.split('|')[2]), `the row for ${state} doesn't show exit ${code}: ${row}`);
  }
});

test('the comment merge-task.js posts, and the STATUS.md states it names, match the guidance', () => {
  const script = read('scripts/merge-task.js');
  assert(script.includes('Merged by the Director after reviewer approval (task ${opts.task}, attempt ${opts.attempt}).'), 'merge comment');
  const status = read('templates/project/STATUS.md');
  for (const state of ['waiting CI', 'queued', 'merged']) {
    assert(status.includes(`\`${state}\``), `STATUS template lacks the state ${state}`);
    assert(script.includes(state), `merge-task.js never names the state ${state}`);
  }
});
