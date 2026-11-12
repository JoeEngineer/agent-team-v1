// tests/live/ci-turns.js: how many turns and context tokens a Director transcript
// spent, and how many of them were about CI. Synthetic fixtures in the real shapes
// (Claude stream-json, Codex rollout); no network, no Claude or Codex needed.
'use strict';

const nodeAssert = require('assert');
const { test, assert, eq } = require('./helpers');
const T = require('./live/ci-turns.js');

// ---- Claude stream-json builders ----
const usage = (input, cacheRead, cacheCreate) => ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, output_tokens: 5 });
const asst = (id, blocks, u, extra) => ({ type: 'assistant', message: { id, role: 'assistant', content: blocks, usage: u }, parent_tool_use_id: null, ...extra });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const bash = (id, command, bg) => tool(id, 'Bash', bg ? { command, run_in_background: true } : { command });
const result = (toolUseId, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }, parent_tool_use_id: null });
const done = { type: 'result', stop_reason: 'end_turn' };

// ---- Codex rollout builders ----
const ev = (type, payload) => ({ timestamp: 't', type, payload });
const fcall = (cmd, name = 'exec_command') => ev('response_item', { type: 'function_call', name, arguments: JSON.stringify({ cmd }), call_id: 'c' + Math.random() });
const tokenCount = (input, total) => ev('event_msg', { type: 'token_count', info: {
  total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 1, total_tokens: total },
  last_token_usage: { input_tokens: input, cached_input_tokens: Math.floor(input / 2), output_tokens: 1, total_tokens: input + 1 } } });

test('ci-turns: background task notification starts a CI turn, attributed to the PR', () => {
  const stream = [
    { type: 'system', subtype: 'init', plugins: [{ name: 'agent-team', path: 'P', version: '0.5.0' }], model: 'm' },
    { type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', output: '{"additionalContext":"agent-team hooks: active (claude, 0.5.0)"}' },
    asst('m1', [bash('tu1', 'gh pr checks 7 --watch', true)], usage(2, 1000, 500)),
    { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'tu1' },
    result('tu1', 'Command running in background with ID: b1. Output is being written to: x'),
    asst('m2', [{ type: 'text', text: 'waiting' }], usage(2, 1700, 0)),
    done,
    { type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'tu1', summary: 'Background command "watch" completed (exit code 0)' },
    asst('m3', [{ type: 'text', text: 'checks done' }], usage(4, 1800, 100)),
    done,
  ];
  const r = T.parseClaudeStream(stream);
  eq(r.turns.length, 3, 'turn count');
  nodeAssert.deepStrictEqual(r.turns.map((t) => t.ci), [true, false, true]);
  eq(r.turns[2].notified.length, 1, 'turn 3 started by the notification');
  eq(r.turns[1].notified.length, 0, 'turn 2 was not');
  eq(r.ci.turns, 2, 'ci turns');
  eq(r.ci.contextTokens, 1502 + 1904, 'ci context tokens');
  eq(r.contextTokens, 1502 + 1702 + 1904, 'all context tokens');
  nodeAssert.deepStrictEqual(r.ci.byPr, { 7: { turns: 2, contextTokens: 3406 } });
  eq(r.ci.startedByNotification, 1, 'one CI turn started by a notification');
  eq(r.meta.hooksActive.version, '0.5.0', 'hooks line from SessionStart hook_response');
  eq(r.meta.plugins[0].path, 'P', 'init plugins kept');
});

test('ci-turns: a notification for a non-CI command does not make a CI turn', () => {
  const r = T.parseClaudeStream([
    asst('m1', [bash('tu1', 'npm test', true)], usage(1, 100, 0)),
    { type: 'system', subtype: 'task_started', task_id: 'b9', tool_use_id: 'tu1' },
    result('tu1', 'Command running in background with ID: b9. Output'),
    done,
    { type: 'system', subtype: 'task_notification', task_id: 'b9', tool_use_id: 'tu1', summary: 'Background command "tests" completed' },
    asst('m2', [{ type: 'text', text: 'tests passed' }], usage(1, 120, 0)),
  ]);
  eq(r.turns.length, 2, 'two turns');
  eq(r.turns[1].notified.length, 1, 'turn 2 was started by a notification');
  eq(r.ci.turns, 0, 'but none is about CI');
});

test('ci-turns: a notification that lands mid-turn (no idle gap) does not start a turn', () => {
  const r = T.parseClaudeStream([
    asst('m1', [bash('tu1', 'node scripts/ci-wait.js 4 --once', true)], usage(1, 100, 0)),
    { type: 'system', subtype: 'task_started', task_id: 'b2', tool_use_id: 'tu1' },
    result('tu1', 'Command running in background with ID: b2. Output'),
    { type: 'system', subtype: 'task_notification', task_id: 'b2', tool_use_id: 'tu1', summary: 'done' },
    asst('m2', [{ type: 'text', text: 'continuing' }], usage(1, 120, 0)),
  ]);
  eq(r.turns[1].notified.length, 0, 'no result event between, so not a wake-up');
  eq(r.ci.turns, 1, 'only the command turn');
});

test('ci-turns: a split assistant message counts once; tokens are not summed', () => {
  const u = usage(3, 2000, 100);
  const r = T.parseClaudeStream([
    asst('msgA', [{ type: 'thinking', thinking: '' }], u),
    asst('msgA', [bash('tu1', 'gh run view 123 --log-failed', false)], u),
    asst('msgA', [{ type: 'text', text: 'x' }], { ...u, output_tokens: 99 }),
    asst('msgB', [{ type: 'text', text: 'y' }], usage(3, 2200, 0)),
  ]);
  eq(r.turns.length, 2, 'two messages, four lines');
  eq(r.turns[0].tokens, 2103, 'input + cache read + cache creation, once');
  eq(r.contextTokens, 2103 + 2203, 'total');
  eq(r.turns[0].tools.length, 1, 'tool_use from the middle line is kept');
  eq(r.turns[0].ci, true, 'gh run view is CI');
});

test('ci-turns: subagent messages are not the Director\'s turns', () => {
  const r = T.parseClaudeStream([
    asst('m1', [{ type: 'text', text: 'hi' }], usage(1, 10, 0)),
    asst('s1', [bash('tu9', 'gh pr checks 3', false)], usage(1, 5000, 0), { parent_tool_use_id: 'toolu_agent' }),
    asst('s2', [{ type: 'text', text: 'sub' }], usage(1, 5000, 0), { isSidechain: true }),
  ]);
  eq(r.turns.length, 1, 'only the Director');
  eq(r.contextTokens, 11, 'tokens');
  eq(r.ci.turns, 0, 'subagent CI is not counted');
});

test('ci-turns: PowerShell command with a chained, queued merge is CI and names the PR', () => {
  const cmd = 'node "C:\\p\\scripts\\ci-wait.js" 12 --once --sha abc123\nif ($LASTEXITCODE -eq 0) { gh pr merge 12 --squash --auto --match-head-commit abc123 }';
  const r = T.parseClaudeStream([asst('m1', [tool('tu1', 'PowerShell', { command: cmd })], usage(1, 10, 0))]);
  eq(r.ci.turns, 1, 'CI turn');
  nodeAssert.deepStrictEqual(r.turns[0].tools[0].kinds, ['ci-wait', 'merge-auto']);
  nodeAssert.deepStrictEqual(r.turns[0].prs, ['12']);
});

test('ci-turns: foreground --watch vs background --watch', () => {
  const r = T.parseClaudeStream([
    asst('m1', [bash('a', 'gh pr checks 5 --watch --fail-fast', false)], usage(1, 10, 0)),
    asst('m2', [bash('b', 'gh pr checks 6 --watch', true)], usage(1, 20, 0)),
    asst('m3', [bash('c', 'gh run watch 99', false)], usage(1, 30, 0)),
    asst('m4', [bash('d', 'gh pr checks 8 --watch &', false)], usage(1, 40, 0)),
    asst('m5', [bash('e', 'gh pr checks 9', false)], usage(1, 50, 0)),
  ]);
  eq(r.watch.foreground, 2, 'a (flag) and c (gh run watch)');
  eq(r.watch.background, 2, 'b (run_in_background) and d (trailing &)');
  eq(r.ci.turns, 5, 'every one is a CI turn');
});

test('ci-turns: a non-shell tool that polls a CI background task is CI; other tools are not', () => {
  const r = T.parseClaudeStream([
    asst('m1', [bash('tu1', 'node scripts/ci-wait.js 4', true)], usage(1, 10, 0)),
    { type: 'system', subtype: 'task_started', task_id: 'bq1', tool_use_id: 'tu1' },
    asst('m2', [tool('tu2', 'TaskOutput', { task_id: 'bq1' })], usage(1, 20, 0)),
    asst('m3', [tool('tu3', 'Agent', { prompt: 'wait for gh pr checks to finish' })], usage(1, 30, 0)),
  ]);
  nodeAssert.deepStrictEqual(r.turns.map((t) => t.ci), [true, true, false]);
});

test('ci-turns: every CI pattern, and near misses', () => {
  const yes = [
    'gh pr checks 3', 'gh pr checks 3 --required', 'gh run watch 5', 'gh run view 5 --log', 'node x/scripts/ci-wait.js 4 --once',
    'glab ci status', 'gh pr view 3 --json statusCheckRollup', 'glab mr view 3 --output json | jq .head_pipeline',
    'node scripts/reconcile-logs.js --merges', 'gh pr merge 4 --squash --auto', 'gh pr merge 4 --auto --squash --match-head-commit abc',
    'glab mr merge 4 --auto-merge', 'gh pr merge 4 --disable-auto', 'gh.exe pr checks 3',
  ];
  for (const c of yes) assert(T.ciKinds(c).length > 0, `should match: ${c}`);
  const no = [
    'gh pr merge 4 --squash --match-head-commit abc', 'gh pr view 3 --json state', 'gh pr list', 'git push origin task/x',
    'node scripts/reconcile-logs.js --dry-run', 'gh pr merge 4 --squash --auto-something', 'echo hello', 'gh run list',
  ];
  for (const c of no) eq(T.ciKinds(c).length, 0, `should not match: ${c}`);
});

test('ci-turns: PR numbers come from the command, not from flag values', () => {
  nodeAssert.deepStrictEqual(T.prNumbers('gh pr checks 12 --watch'), ['12']);
  nodeAssert.deepStrictEqual(T.prNumbers('node ci-wait.js 4 5 --deadline 540 --sha 123456'), ['4', '5']);
  nodeAssert.deepStrictEqual(T.prNumbers('gh pr merge #7 --squash --auto --match-head-commit 1234567'), ['7']);
  nodeAssert.deepStrictEqual(T.prNumbers('gh pr view --json statusCheckRollup 9'), ['9']);  // the value after --json is skipped, 9 is the PR
  nodeAssert.deepStrictEqual(T.prNumbers('gh pr view 9 --json statusCheckRollup,state'), ['9']);
  nodeAssert.deepStrictEqual(T.prNumbers('gh pr checks 3 && gh pr merge 4 --auto'), ['3', '4']);
  nodeAssert.deepStrictEqual(T.prNumbers('gh run view 99887766'), []);
  // Codex 0.167 wraps the command in JS: tools.exec_command({cmd:"gh pr checks 12",workdir:"p"})
  nodeAssert.deepStrictEqual(T.prNumbers('text(await tools.exec_command({cmd:"gh pr checks 12",workdir:"p"}));'), ['12']);
});

test('ci-turns: summary groups CI turns by PR, with an unattributed bucket', () => {
  const r = T.parseClaudeStream([
    asst('m1', [bash('a', 'gh pr checks 3', false)], usage(1, 100, 0)),
    asst('m2', [bash('b', 'gh pr checks 3', false)], usage(1, 200, 0)),
    asst('m3', [bash('c', 'gh pr merge 4 --squash --auto', false)], usage(1, 300, 0)),
    asst('m4', [bash('d', 'node scripts/reconcile-logs.js --merges', false)], usage(1, 400, 0)),
    asst('m5', [bash('e', 'git status', false)], usage(1, 500, 0)),
  ]);
  nodeAssert.deepStrictEqual(r.ci.byPr, { 3: { turns: 2, contextTokens: 302 }, 4: { turns: 1, contextTokens: 301 } });
  nodeAssert.deepStrictEqual(r.ci.unattributed, { turns: 1, contextTokens: 401 });
  eq(r.ci.turns, 4, 'ci turns');
});

test('ci-turns: Codex exec_command rollout; repeated token_count is skipped; input includes cache', () => {
  const rollout = [
    ev('session_meta', { id: 's1', source: 'exec' }),
    ev('turn_context', { model: 'gpt-x' }),
    fcall('gh pr checks 3 --watch'),
    tokenCount(1000, 1000),
    tokenCount(1000, 1000),                                   // duplicate emit, same running total
    ev('response_item', { type: 'function_call_output', call_id: 'x', output: 'ok' }),
    fcall('node "C:/p/scripts/ci-wait.js" 3 --once --sha abc', 'shell_command'),
    ev('response_item', { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.exec_command({cmd: "gh pr merge 3 --squash --auto"}))', call_id: 'z' }),
    tokenCount(1500, 2500),
    fcall('git status'),
    tokenCount(1600, 4100),
    ev('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'agent-team hooks: active (codex, 0.5.0)' }] }),
  ];
  const r = T.parseCodexRollout(rollout);
  eq(r.turns.length, 3, 'three model calls');
  nodeAssert.deepStrictEqual(r.turns.map((t) => t.tokens), [1000, 1500, 1600]);
  eq(r.contextTokens, 4100, 'last_token_usage.input_tokens summed');
  nodeAssert.deepStrictEqual(r.turns.map((t) => t.ci), [true, true, false]);
  eq(r.ci.turns, 2, 'ci turns');
  nodeAssert.deepStrictEqual(r.ci.byPr, { 3: { turns: 2, contextTokens: 2500 } });
  eq(r.watch.foreground, 1, 'Codex has no background shell: --watch is foreground');
  eq(r.meta.hooksActive.version, '0.5.0', 'hooks line found');
});

test('ci-turns: Codex command shapes (argv array, local_shell_call) and subagent rollouts', () => {
  const argv = ev('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'gh pr checks 8'] }), call_id: 'k' });
  const local = ev('response_item', { type: 'local_shell_call', action: { command: ['gh', 'run', 'watch', '5'] }, call_id: 'l' });
  const r = T.parseCodexRollout([argv, tokenCount(10, 10), local, tokenCount(20, 30)]);
  nodeAssert.deepStrictEqual(r.turns.map((t) => t.ci), [true, true]);
  nodeAssert.deepStrictEqual(r.turns[0].prs, ['8']);
  assert(T.isDirectorRollout([ev('session_meta', { source: 'exec' })]), 'exec session is the Director');
  assert(!T.isDirectorRollout([ev('session_meta', { source: { subagent: { thread_spawn: {} } } })]), 'subagent session is not');
  assert(!T.isDirectorRollout([]), 'no session_meta is not');
});

test('ci-turns: milestone-json is found in the Director\'s message, not in the template or a subagent', () => {
  eq(T.milestoneJsonIn('milestone-json {"status":"complete|incomplete","pr":<n>}'), null, 'template does not parse');
  const j = T.milestoneJsonIn('done\nmilestone-json {"status":"complete","pr":12,"ci":"green"}');
  eq(j.pr, 12, 'pr');
  eq(T.milestoneJsonInEvent(asst('m', [{ type: 'text', text: 'milestone-json {"status":"incomplete","pr":3,"ci":"pending"}' }], usage(1, 1, 1))).status, 'incomplete', 'claude assistant');
  eq(T.milestoneJsonInEvent(asst('m', [{ type: 'text', text: 'milestone-json {"status":"complete","pr":3,"ci":"x"}' }], usage(1, 1, 1), { parent_tool_use_id: 'a' })), null, 'subagent');
  eq(T.milestoneJsonInEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'milestone-json {"status":"complete","pr":4,"ci":"green"}' } }).pr, 4, 'codex item');
  eq(T.milestoneJsonInEvent({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'milestone-json {"status":"complete","pr":4,"ci":"green"}' } }), null, 'tool output');
  const r = T.parseClaudeStream([asst('m1', [{ type: 'text', text: 'milestone-json {"status":"complete","pr":9,"ci":"green"}' }], usage(1, 1, 1))]);
  eq(r.milestoneJson.pr, 9, 'parse result carries it');
});

test('ci-turns: empty and junk input give zero turns', () => {
  eq(T.parseClaudeStream('').turns.length, 0, 'empty claude');
  eq(T.parseCodexRollout('not json\n\n{"a":1}').turns.length, 0, 'junk codex');
  const r = T.parseClaudeStream('not json\n' + JSON.stringify(asst('m', [{ type: 'text', text: 'x' }], usage(1, 2, 3))) + '\n');
  eq(r.contextTokens, 6, 'stray stderr line skipped');
});

test('ci-turns: backgrounding shapes (& echo $!, nohup, Start-Process, Start-Job) vs foreground look-alikes', () => {
  const bg = [
    'gh pr checks 3 --watch &', 'gh pr checks 3 --watch & echo $!', 'gh pr checks 3 --watch &; echo started',
    'nohup gh pr checks 3 --watch > out.txt 2>&1 &', 'gh pr checks 3 --watch &\necho started',
    'Start-Process gh -ArgumentList "pr checks 3 --watch" -NoNewWindow', 'Start-Job { gh pr checks 3 --watch }', 'Start-ThreadJob { gh run watch 5 }',
  ];
  for (const c of bg) assert(T.isBackgroundCommand(c), `should be background: ${JSON.stringify(c)}`);
  const fg = ['gh pr checks 3 --watch', 'a && gh pr checks 3 --watch', 'gh pr checks 3 2>&1', 'gh pr view 3 >&2', 'gh pr checks 3 &>/dev/null',
    'Start-Process gh -ArgumentList "pr checks 3 --watch" -Wait -NoNewWindow', 'nohup gh pr checks 3 --watch', ''];
  for (const c of fg) assert(!T.isBackgroundCommand(c), `should be foreground: ${JSON.stringify(c)}`);
  // and it reaches the watch count
  const r = T.parseClaudeStream([
    asst('m1', [bash('a', 'gh pr checks 3 --watch & echo $!', false)], usage(1, 10, 0)),
    asst('m2', [tool('b', 'PowerShell', { command: 'Start-Job { gh pr checks 4 --watch }' })], usage(1, 20, 0)),
    asst('m3', [tool('c', 'PowerShell', { command: 'Start-Process powershell -ArgumentList "-Command gh run watch 9" -Wait' })], usage(1, 30, 0)),
  ]);
  eq(r.watch.background, 2, 'background watches');
  eq(r.watch.foreground, 1, 'foreground watch (Start-Process -Wait)');
});

test('ci-turns: the Monitor tool runs a command in the background and is CI when the command is', () => {
  const r = T.parseClaudeStream([
    asst('m1', [tool('mon1', 'Monitor', { command: 'until gh pr checks 5 --watch; do sleep 20; done', description: 'wait for ci', timeout_ms: 600000 })], usage(1, 10, 0)),
    asst('m2', [tool('mon2', 'Monitor', { command: 'tail -f build.log' })], usage(1, 20, 0)),
  ]);
  nodeAssert.deepStrictEqual(r.turns.map((t) => t.ci), [true, false]);
  nodeAssert.deepStrictEqual(r.turns[0].prs, ['5']);
  eq(r.turns[0].tools[0].background, true, 'Monitor is background');
  eq(r.watch.foreground, 0, 'a --watch inside Monitor is not foreground');
  eq(r.watch.background, 1, 'but is counted as a background watch');
  eq(T.commandOf('Monitor', { command: 'echo hi' }).background, true, 'commandOf marks Monitor background');
  eq(T.commandOf('Bash', { command: 'echo hi' }).background, false, 'Bash foreground by default');
});

test('ci-turns: ci-wait.js --names and --once take PR numbers; flag values still do not', () => {
  nodeAssert.deepStrictEqual(T.prNumbers('node scripts/ci-wait.js --names 12'), ['12']);
  nodeAssert.deepStrictEqual(T.prNumbers('node scripts/ci-wait.js --once 4 5 --allow-none'), ['4', '5']);
  nodeAssert.deepStrictEqual(T.prNumbers('node scripts/ci-wait.js 7 --timeout 540 --interval 30'), ['7']);
  const r = T.parseClaudeStream([asst('m1', [bash('a', 'node scripts/ci-wait.js --names 12', false)], usage(1, 10, 0))]);
  nodeAssert.deepStrictEqual(r.ci.byPr, { 12: { turns: 1, contextTokens: 11 } });
  eq(r.ci.unattributed.turns, 0, 'attributed, not unattributed');
});

// ---- attribution: PR numbers come only from the CI part of a call ----
test('ci-turns: a reconcile call followed by a STATUS sed edit and a `gh pr create --body` heredoc names no PR (Claude cw9 turn 21 shape)', () => {
  const cmd = [
    'cd /p; S=live-x',
    'node "$P/scripts/reconcile-logs.js" --merges',
    "sed -i 's/| in review | #55 |/| merged | #55 |/; s/| in review | #56 |/| merged | #56 |/' STATUS.md",
    'gh pr create --base main --head milestone/$S --title "$S" --body "$(cat <<\'EOF\'',
    'Milestone: #54 sum, #55 clamp, #56 slugify',
    'Run gh pr checks 55 to see the checks.',
    'Closes #28',
    'EOF',
    ')"',
  ].join('\n');
  nodeAssert.deepStrictEqual(T.ciKinds(cmd), ['reconcile-merges'], 'it is a reconcile turn');
  nodeAssert.deepStrictEqual(T.prNumbers(cmd), [], 'and names no PR');
  const r = T.parseClaudeStream([asst('m1', [bash('a', cmd, false)], usage(1, 100, 0))]);
  eq(r.ci.turns, 1, 'one CI turn');
  nodeAssert.deepStrictEqual(r.ci.byPr, {}, 'charged to no PR');
  eq(r.ci.unattributed.turns, 1, 'unattributed');
  // control: the same call with the PR given to a CI command does name it
  nodeAssert.deepStrictEqual(T.prNumbers(`${cmd}\nnode ci-wait.js 55 --once`), ['55'], 'ci-wait.js 55 still names 55 and the body still adds nothing');
});

test('ci-turns: a Codex reconcile call that also reads a PR body (gh pr view --json title,body) names no PR (Codex after turn 42 shape)', () => {
  const cmd = 'text(await tools.exec_command({cmd:"node C:/p/scripts/reconcile-logs.js --merges; git worktree list; gh pr view 43 --json title,body,commits",max_output_tokens:2500}));';
  nodeAssert.deepStrictEqual(T.ciKinds(cmd), ['reconcile-merges']);
  nodeAssert.deepStrictEqual(T.prNumbers(cmd), []);
  // control: asking for the checks of the same PR does name it
  nodeAssert.deepStrictEqual(T.prNumbers('text(await tools.exec_command({cmd:"gh pr view 43 --json headRefOid,statusCheckRollup",max_output_tokens:900}));'), ['43']);
  nodeAssert.deepStrictEqual(T.prNumbers('gh pr checks 3 && gh pr view 4 --json title && gh pr merge 5 --squash --auto'), ['3', '5'], 'only CI segments name PRs');
});

test('ci-turns: quoted text, --body, .Replace(), sed, here-strings and echo never name a PR or count as CI', () => {
  const none = [
    'gh pr comment 9 --body "see gh pr checks 9"',
    'gh pr comment 9 -b "ci-wait.js 9 --once"',
    "(Get-Content STATUS.md -Raw).Replace('node reconcile-logs.js --merges','gh pr checks 9') | Set-Content STATUS.md",
    "$t -replace 'gh pr checks 9','x'",
    "sed -i 's/gh pr checks 9/x/' STATUS.md",
    'echo "run gh pr checks 9"',
    'Write-Host "ci-wait.js 9"',
    "@'\ngh pr checks 9\nnode ci-wait.js 9\n'@ | Set-Content notes.md",
    "cat > notes.md <<'EOF'\nnode reconcile-logs.js --merges\ngh pr checks 9\nEOF",
    'text(await tools.exec_command({cmd:"gh pr comment 9 --body \\"gh pr checks 9\\"",max_output_tokens:500}));',
  ];
  for (const c of none) {
    nodeAssert.deepStrictEqual(T.ciKinds(c), [], `not CI: ${c.slice(0, 50)}`);
    nodeAssert.deepStrictEqual(T.prNumbers(c), [], `names no PR: ${c.slice(0, 50)}`);
  }
  eq(T.isWatch('gh pr comment 9 --body "gh pr checks 9 --watch"'), false, 'a --watch inside a body is not a watch');
  eq(T.isWatch('gh pr checks 9 --watch'), true, 'control: a real watch');
});

test('ci-turns: a STATUS edit only is not a reconcile turn; the same call that ends with reconcile-logs.js --merges is (Codex cw9 turns 26 and 40 shape)', () => {
  const edit = "(Get-Content STATUS.md -Raw).Replace('| 1 | in review | #57 |','| 2 | in review | #57 |').Replace('| 2 | in review | #59 |','| 2 | merged | #59 |').TrimEnd() | Set-Content STATUS.md -Encoding UTF8";
  const run = 'node C:/cw6/32052/h/plugins/cache/agent-team/agent-team/0.6.0/scripts/reconcile-logs.js --merges';
  nodeAssert.deepStrictEqual(T.ciKinds(edit), [], 'the edit alone is not about CI');
  nodeAssert.deepStrictEqual(T.ciKinds(`${edit}\n${run}`), ['reconcile-merges'], 'with reconcile-logs.js --merges it runs, so it counts');
  nodeAssert.deepStrictEqual(T.prNumbers(`${edit}\n${run}`), [], 'and still names no PR');
  const wrapped = (c) => `text(await tools.exec_command({cmd:${JSON.stringify(c)},max_output_tokens:500}));`;
  const customCall = (input) => ev('response_item', { type: 'custom_tool_call', name: 'exec', input, call_id: 'x' + Math.random() });
  const r = T.parseCodexRollout([
    ev('session_meta', { id: 's', source: 'exec' }),
    customCall(wrapped(edit)), tokenCount(100, 100),                       // edit only
    customCall(wrapped(`${edit}\n${run}`)), tokenCount(200, 300),         // edit, then reconcile
  ]);
  nodeAssert.deepStrictEqual(r.turns.map((t) => t.ci), [false, true]);
  eq(r.ci.unattributed.turns, 1, 'the second turn is the one reconcile turn, tied to no PR');
});
