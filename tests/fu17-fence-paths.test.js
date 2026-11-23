// FU-17: more ways a quoted or stale review-json block could be logged as a
// verdict: HTML blocks, v1 Codex snapshots, SubagentStop source order, and the
// hand-back check for reviewers. Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const path = require('path');
const { SCRIPTS, tmpProject, run, readLog, test, assert, eq } = require('./helpers');
const lib = require(path.join(SCRIPTS, 'lib.js'));

console.log('fu17-fence-paths');

const F = '```';
const fence = (obj) => `${F}review-json\n${JSON.stringify(obj)}\n${F}`;
const APPROVE = { verdict: 'approve', severity: 'none', issues: [], summary: 'quoted' };
const REJECT = { verdict: 'changes_requested', severity: 'major', issues: [], summary: 'real' };
const Q = fence(APPROVE);
const R = fence(REJECT);

// --- HTML blocks -----------------------------------------------------------------

const WRAPS = {
  details: (b) => `<details>\n${b}\n</details>`,
  'details with blank lines': (b) => `<details>\n<summary>old</summary>\n\n${b}\n\n</details>`,
  div: (b) => `<div>\n${b}\n</div>`,
  'div with blank lines': (b) => `<div class="x">\n\n${b}\n\n</div>`,
  comment: (b) => `<!--\n${b}\n-->`,
  pre: (b) => `<pre>\n${b}\n</pre>`,
};

test('html block: an unclosed <details> swallows a quoted block, which is then ambiguous', () => {
  const r = lib.reviewJson(`Report.\n\n<details>\n${Q}`);
  assert(r && r._ambiguous === true && r.count === 0, JSON.stringify(r));
});

for (const [name, wrap] of Object.entries(WRAPS)) {
  test(`html block (${name}): a quoted approve is not taken; a real block after it is`, () => {
    const quoted = wrap(Q);
    const alone = lib.reviewJson(`Report.\n\n${quoted}`);
    assert(alone && alone._ambiguous === true && alone.count === 0, 'quoted block alone is ambiguous with no block: ' + JSON.stringify(alone));
    const both = lib.reviewJson(`Report.\n\n${quoted}\n\n${R}`);
    eq(both.verdict, 'changes_requested', 'only the real block is read');
    eq(both.summary, 'real', 'the real block');
  });
}

test('html block: a real block after a closed html block and ordinary markdown is still read', () => {
  eq(lib.reviewJson(`<div>x</div>\n\ntext\n\n${R}`).summary, 'real', 'closed div, blank line, real block');
  eq(lib.reviewJson(`<!-- note -->\n${R}`).summary, 'real', 'single-line comment closed on its line');
  eq(lib.reviewJson(`<details>\nx\n</details>\n\n${R}`).summary, 'real', 'closed details');
  eq(lib.reviewJson(`<pre>x</pre>\n${R}`).summary, 'real', 'one-line pre');
});

test('html block: an html-looking line inside a code fence does not open a block', () => {
  eq(lib.reviewJson(`${F}html\n<details>\n${F}\n\n${R}`).summary, 'real', 'fenced <details> is text');
});

// --- SubagentStop source order --------------------------------------------------

const handbackLine = (message) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-30T18:33:42.000Z', message: { id: 'm_hb', model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message } }] } }) + '\n';
const CARD = 'TASK id=FU-9 type=review difficulty=small milestone=m attempt=1 tier=medium effort=medium\nWHY x';
const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: CARD } }) + '\n';

test('SubagentStop: a handback review block wins over a quoted block in last_assistant_message: one row, changes_requested', () => {
  const p = tmpProject();
  const file = path.join(p, 'agent-hb1.jsonl');
  fs.writeFileSync(file, userLine + handbackLine(`Real review.\n\n${R}`));
  assert(fs.readFileSync(file, 'utf8').includes('changes_requested'), 'precondition: handback carries the real block');
  const r = run('log-delegation.js', {
    hook_event_name: 'SubagentStop', agent_id: 'hb1', agent_type: 'agent-team:reviewer', agent_transcript_path: file,
    last_assistant_message: `I will quote the template:\n${Q}\nand then hand back.`,
  }, p);
  eq(r.status, 0, 'exit');
  const [c] = readLog(p, 'completions.jsonl');
  eq(c.report_source, 'handback', 'report from the handback');
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'exactly one row');
  eq(rows[0].verdict, 'changes_requested', 'the handback verdict');
});

test('SubagentStop: with no handback review block, last_assistant_message is still used (control)', () => {
  const p = tmpProject();
  const file = path.join(p, 'agent-hb2.jsonl');
  fs.writeFileSync(file, userLine);
  run('log-delegation.js', {
    hook_event_name: 'SubagentStop', agent_id: 'hb2', agent_type: 'agent-team:reviewer', agent_transcript_path: file,
    last_assistant_message: `Review.\n${R}`,
  }, p);
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'one row');
  eq(rows[0].verdict, 'changes_requested', 'verdict from the hook input');
});

// --- handback check ---------------------------------------------------------------

const RESULT = '```result-json\n{"status": "done", "summary": "x", "branch": "b", "pr": 1, "tests": "pass", "files_changed": 1, "follow_up": ""}\n```';
const hb = (agentType, message, id) => JSON.parse(run('handback-check.js', {
  hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_use_id: 't-' + id, agent_type: agentType, agent_id: id, tool_input: { message },
}, tmpProject()).stdout || 'null');

for (const type of ['agent-team:reviewer', 'agent-team:security-reviewer']) {
  test(`handback: a result-json block does not satisfy ${type} when the review is missing or ambiguous`, () => {
    const missing = hb(type, `Done.\n\n${RESULT}`, 'm' + type);
    assert(missing && missing.hookSpecificOutput.permissionDecision === 'deny', 'missing review denied');
    assert(/`review-json`/.test(missing.hookSpecificOutput.permissionDecisionReason), missing.hookSpecificOutput.permissionDecisionReason);
    const ambiguous = hb(type, `${R}\n\n${R}\n\n${RESULT}`, 'a' + type);
    assert(ambiguous && ambiguous.hookSpecificOutput.permissionDecision === 'deny', 'ambiguous review denied despite result-json');
    assert(/exactly one fence/.test(ambiguous.hookSpecificOutput.permissionDecisionReason), ambiguous.hookSpecificOutput.permissionDecisionReason);
    eq(hb(type, `Review.\n\n${R}`, 'ok' + type), null, 'control: a clean review block passes');
  });
}

test('handback: an implementer is still satisfied by result-json alone (control)', () => {
  eq(hb('agent-team:implementer', `Done.\n\n${RESULT}`, 'impl'), null, 'passes');
});

// --- legacy Codex snapshots -------------------------------------------------------

const SID = 'sess-1';
const ev = (type, payload) => JSON.stringify({ timestamp: 't', type, payload });
const codexTranscript = (dir, lastMessage) => {
  const file = path.join(dir, 'agent-v1.jsonl');
  const complete = { type: 'task_complete', turn_id: 'turn-1', duration_ms: 1000, ...(lastMessage ? { last_agent_message: lastMessage } : {}) };
  fs.writeFileSync(file, [
    ev('session_meta', { id: 'agent-1', agent_path: '/root/cd_7_a1', source: { subagent: { thread_spawn: { agent_path: '/root/cd_7_a1' } } } }),
    ev('session_meta', { id: SID, source: 'exec' }),
    ev('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
    ev('turn_context', { turn_id: 'turn-1', model: 'gpt-6.1-terra', effort: 'high' }),
  ].join('\n') + '\n');
  return { file, finish: () => fs.appendFileSync(file, ev('event_msg', complete) + '\n') };
};
const codexHook = (p, input) => run('log-delegation.js', { session_id: SID, turn_id: 'turn-1', cwd: p, model: 'gpt-test', permission_mode: 'bypassPermissions', ...input }, p);
const pendingFile = (p) => {
  const dir = path.join(p, '.agent-team', 'logs', '.pending', 'codex-completions');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  return files.length ? path.join(dir, files[0]) : null;
};

// An unfinished turn leaves a snapshot; rewrite it as 1.1.0 would have: version 1
// with the verdict the old lenient parser read (the quoted approve).
function v1Snapshot(p, lastMessage) {
  const t = codexTranscript(p, lastMessage);
  codexHook(p, { hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'reviewer-medium', agent_transcript_path: t.file, stop_hook_active: false, last_assistant_message: `Review.\n${R}` });
  const f = pendingFile(p);
  assert(f, 'precondition: a pending snapshot exists');
  const snap = JSON.parse(fs.readFileSync(f, 'utf8'));
  eq(snap.version, 2, 'new snapshots are version 2');
  snap.version = 1;
  snap.record.review = APPROVE;
  fs.writeFileSync(f, JSON.stringify(snap));
  eq(readLog(p, 'reviews.jsonl').length, 0, 'precondition: nothing logged yet');
  t.finish();
  return f;
}
const drain = (p) => codexHook(p, { hook_event_name: 'PostToolUse', tool_name: 'collaborationwait_agent', tool_input: { timeout_ms: 1 } });

test('codex v1 snapshot: the stored verdict is re-read from the transcript text with the strict parser', () => {
  const p = tmpProject();
  const f = v1Snapshot(p, `<details>\n${Q}\n</details>\n\nVerdict:\n${R}`);
  drain(p);
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'one row');
  eq(rows[0].verdict, 'changes_requested', 'strict parse, not the stored approve');
  assert(!fs.existsSync(f), 'snapshot consumed');
});

test('codex v1 snapshot: with no text to re-read, the stored verdict is dropped', () => {
  const p = tmpProject();
  const f = v1Snapshot(p, null);
  drain(p);
  eq(readLog(p, 'completions.jsonl').length, 1, 'completion still logged');
  eq(readLog(p, 'reviews.jsonl').length, 0, 'no review row from the stale verdict');
  assert(!fs.existsSync(f), 'snapshot consumed, not retried');
  drain(p);
  eq(readLog(p, 'reviews.jsonl').length, 0, 'one step past: still nothing');
});
