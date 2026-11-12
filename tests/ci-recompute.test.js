// tests/live/ci-recompute.js: recompute a finished live run's Director metrics from its
// saved transcript with the current parser. Synthetic transcripts; no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeAssert = require('assert');
const { spawnSync } = require('child_process');
const { test, assert, eq } = require('./helpers');
const R = require('./live/ci-recompute.js');

const usage = (input, cacheRead, cacheCreate) => ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate });
const asst = (id, command, u, text) => ({ type: 'assistant', message: { id, content: [].concat(text ? [{ type: 'text', text }] : [], command ? [{ type: 'tool_use', id: 'tu-' + id, name: 'Bash', input: { command } }] : []), usage: u }, parent_tool_use_id: null });
const ev = (type, payload) => ({ type, payload });
const tokenCount = (input, total) => ev('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: total }, last_token_usage: { input_tokens: input } } });
const fcall = (cmd) => ev('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: 'c' + cmd.length });
const jsonl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n');

const claude = jsonl([
  asst('m1', 'gh pr checks 7 --watch', usage(1, 100, 0)),
  asst('m2', 'node ci-wait.js 7 --once --sha abc', usage(1, 200, 0)),
  asst('m3', 'node ci-wait.js --names 7', usage(1, 300, 0)),
  asst('m4', 'git status', usage(1, 400, 0), 'done\nmilestone-json {"status":"complete","pr":9,"ci":"green"}'),
]);

test('ci-recompute: a Claude transcript gives turns, tokens, CI split by PR group and the two checkable targets', () => {
  const r = R.recompute(claude, { taskPrs: ['7'], milestonePrs: ['9'] });
  eq(r.tool, 'claude', 'detected as Claude');
  eq(r.turns, 4, 'turns');
  eq(r.contextTokens, 101 + 201 + 301 + 401, 'context tokens');
  eq(r.ci.turns, 3, 'CI turns');
  eq(r.ci.contextTokens, 603, 'CI tokens');
  eq(r.ciShare, +(603 / 1004).toFixed(3), 'share');
  eq(r.watch.foreground, 1, 'one foreground --watch');
  eq(r.breakdown.taskPrs.turns, 3, 'all three name task PR 7');
  eq(r.breakdown.milestonePr.turns, 0, 'none name the milestone PR 9');
  nodeAssert.deepStrictEqual(r.milestoneJson, { status: 'complete', pr: 9, ci: 'green' });
  nodeAssert.deepStrictEqual(r.targets.map((t) => [t.id, t.result]), [['no-foreground-watch', 'FAIL'], ['ci-turns-per-task-pr', 'FAIL']]);
  nodeAssert.deepStrictEqual(r.ciTurns.map((t) => t.i), [0, 1, 2], 'lists the CI turns by index');
  assert(/--names 7/.test(r.ciTurns[2].tools[0].cmd), 'and the command that made each one count');
});

test('ci-recompute: a Codex rollout is detected by its session_meta', () => {
  const rollout = jsonl([
    ev('session_meta', { id: 's', source: 'exec' }),
    fcall('node ci-wait.js 5 --once'), tokenCount(1000, 1000),
    fcall('git status'), tokenCount(1200, 2200),
  ]);
  const r = R.recompute(rollout, { taskPrs: ['5'] });
  eq(r.tool, 'codex', 'detected as Codex');
  eq(r.turns, 2, 'turns');
  eq(r.contextTokens, 2200, 'tokens');
  eq(r.ci.turns, 1, 'one CI turn');
  eq(r.targets[1].result, 'PASS', 'one CI turn for the one task PR');
});

test('ci-recompute: empty and unparseable input give zeros, not a crash', () => {
  const r = R.recompute('', {});
  eq(r.turns, 0, 'no turns'); eq(r.ci.turns, 0, 'no CI turns'); eq(r.ciShare, 0, 'no share');
  eq(R.recompute('not json at all\n{broken', {}).turns, 0, 'junk lines are skipped');
  eq(r.targets[1].result, 'N/A', 'no task PRs: the per-PR target is N/A');
});

test('ci-recompute CLI: reads the PR numbers from the report next to the transcript, flags override, bad usage exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw7-'));
  try {
    const t = path.join(dir, 'x.transcript.jsonl');
    fs.writeFileSync(t, claude);
    fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ taskPrs: [{ number: 7 }], milestonePr: { number: 9 }, milestone: { reported: { pr: 9 } } }));
    const script = path.join(__dirname, 'live', 'ci-recompute.js');
    const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30000 });
    const a = run([t]);
    eq(a.status, 0, a.stderr);
    const ja = JSON.parse(a.stdout);
    eq(ja.breakdown.taskPrs.turns, 3, 'task PR 7 came from the report');
    eq(ja.breakdown.milestonePrNumbers[0], '9', 'milestone PR 9 came from the report');
    const b = JSON.parse(run([t, '--task-prs', '8', '--milestone-prs', '7']).stdout);
    eq(b.breakdown.taskPrs.turns, 0, 'flags win over the report');
    eq(b.breakdown.milestonePr.turns, 3, 'and PR 7 is now the milestone PR');
    eq(run([]).status, 2, 'no transcript: usage, exit 2');
    eq(run([path.join(dir, 'missing.jsonl')]).status, 2, 'unreadable transcript: exit 2');
    eq(run([t, '--bogus']).status, 2, 'unknown flag: exit 2');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
