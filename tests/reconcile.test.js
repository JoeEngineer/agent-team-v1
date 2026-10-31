// Tests for scripts/reconcile-logs.js. Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SCRIPTS, tmpProject, run, readLog, test, assert, eq } = require('./helpers');
const { spawnSync } = require('child_process');

const REVIEW = (v) => '```review-json\n{"verdict":"' + v + '","severity":"none","issues":[],"summary":"s"}\n```';
const CARD = (n) => `TASK id=RC-1 type=review difficulty=easy milestone=rc attempt=${n} pr=9`;
const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

// A session folder under a fake projects root holding one agent transcript.
function setup(agentId, turns, { sessionId = 'sess-1', writeTranscript = true } = {}) {
  const proj = tmpProject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-projects-'));
  const dir = path.join(root, 'some-project-folder', sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  if (writeTranscript) {
    const lines = [];
    turns.forEach((report, i) => {
      const ts = (s) => `2026-10-30T1${i}:00:${s}.000Z`;
      lines.push({ type: 'user', isMeta: i > 0, timestamp: ts('00'), message: { role: 'user', content: CARD(i + 1) } });
      lines.push({ type: 'assistant', timestamp: ts('05'), message: { id: `m${i}`, model: 'claude-sonnet-5-5', usage, content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: report } }] } });
    });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'agent-team:reviewer' }));
  }
  const delegation = { ts: 't', tool: 'claude', session_id: sessionId, kind: 'subagent', agent: 'agent-team:reviewer', agent_id: agentId, model: 'sonnet', effort: 'medium', tier: 'medium', background: true, task: { id: 'RC-1', type: 'review', attempt: '1', pr: '9' } };
  const logs = path.join(proj, '.agent-team', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'delegations.jsonl'), JSON.stringify(delegation) + '\n' + 'not json\n');
  return { proj, root, file, logs };
}

const reconcile = (s, args = [], env = {}) =>
  spawnSync('node', [path.join(SCRIPTS, 'reconcile-logs.js'), ...args], {
    encoding: 'utf8',
    cwd: s.proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: s.proj, AGENT_TEAM_PROJECTS_ROOT: s.root, ...env },
  });

test('reconcile: a missed review is backfilled with its verdict and report_source reconcile; a second run adds nothing', () => {
  const s = setup('rc1', [REVIEW('changes_requested')]);
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'precondition: hook logged nothing');
  const r = reconcile(s);
  eq(r.status, 0, 'exit 0');
  assert(/1 completions backfilled/.test(r.stdout), `counts printed: ${r.stdout}`);
  const [c] = readLog(s.proj, 'completions.jsonl');
  eq(c.report_source, 'reconcile', 'report_source');
  eq(c.agent_id, 'rc1', 'agent id');
  eq(c.review.verdict, 'changes_requested', 'completion review');
  eq(c.tokens_with_cache, 3, 'tokens from the transcript');
  const [rev] = readLog(s.proj, 'reviews.jsonl');
  eq(rev.verdict, 'changes_requested', 'review line verdict');
  eq(rev.task_id, 'RC-1', 'review task id');
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 1, 'second run: no new completion');
  eq(readLog(s.proj, 'reviews.jsonl').length, 1, 'second run: no new review');
});

test('reconcile: marker removed (pruned) still adds nothing, and a later hook fire adds nothing', () => {
  const s = setup('rc2', [REVIEW('approve')]);
  reconcile(s);
  fs.rmSync(path.join(s.logs, '.pending'), { recursive: true, force: true });
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 1, 'content match keeps it idempotent without markers');
  // Re-create the markers via the hook's own key by reconciling fresh, then fire the hook.
  const s2 = setup('rc2b', [REVIEW('approve')]);
  reconcile(s2);
  run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_id: 'rc2b', agent_type: 'agent-team:reviewer', agent_transcript_path: s2.file }, s2.proj);
  eq(readLog(s2.proj, 'completions.jsonl').length, 1, 'hook after reconcile adds nothing');
  eq(readLog(s2.proj, 'reviews.jsonl').length, 1, 'no second review');
});

test('reconcile: a completion the hook already logged is not duplicated', () => {
  const s = setup('rc3', [REVIEW('approve')]);
  run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_id: 'rc3', agent_type: 'agent-team:reviewer', agent_transcript_path: s.file }, s.proj);
  eq(readLog(s.proj, 'completions.jsonl').length, 1, 'precondition: hook logged it');
  const r = reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 1, 'no duplicate');
  assert(/0 completions backfilled, 1 already present/.test(r.stdout), r.stdout);
});

test('reconcile: a transcript that cannot be found is reported, not an error', () => {
  const s = setup('rc4', [], { writeTranscript: false });
  const r = reconcile(s);
  eq(r.status, 0, 'exit 0');
  assert(/1 transcript not found/.test(r.stdout), r.stdout);
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'nothing written');
});

test('reconcile: --dry-run writes nothing', () => {
  const s = setup('rc5', [REVIEW('approve')]);
  const r = reconcile(s, ['--dry-run']);
  assert(/would be backfilled/.test(r.stdout) && /1 would/.test(r.stdout), r.stdout);
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'no completion');
  eq(readLog(s.proj, 'reviews.jsonl').length, 0, 'no review');
  assert(!fs.existsSync(path.join(s.logs, '.pending')), 'no markers claimed');
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 1, 'a real run after the dry run still backfills');
});

test('reconcile: a resumed agent gets one line per turn, each with its own verdict', () => {
  const s = setup('rc6', [REVIEW('changes_requested'), REVIEW('approve')]);
  const resume = { ts: 't', tool: 'claude', session_id: 'sess-1', kind: 'resume', agent: 'agent-team:reviewer', agent_id: 'rc6', task: { id: 'RC-1', type: 'review', attempt: '2', pr: '9' } };
  fs.appendFileSync(path.join(s.logs, 'delegations.jsonl'), JSON.stringify(resume) + '\n');
  reconcile(s);
  const cs = readLog(s.proj, 'completions.jsonl');
  eq(cs.length, 2, 'two completions');
  eq(cs[0].review.verdict, 'changes_requested', 'turn 1');
  eq(cs[1].review.verdict, 'approve', 'turn 2');
  eq(cs[1].task.attempt, '2', 'turn 2 task from the resume record');
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 2, 'second run adds nothing');
});

test('reconcile: no projects folder (Codex-only install) exits 0 with a message; codex records are skipped', () => {
  const s = setup('rc7', [REVIEW('approve')]);
  const r = reconcile(s, [], { AGENT_TEAM_PROJECTS_ROOT: path.join(s.root, 'missing') });
  eq(r.status, 0, 'exit 0');
  assert(/nothing to reconcile/.test(r.stdout), r.stdout);
  const logs = path.join(s.logs, 'delegations.jsonl');
  fs.writeFileSync(logs, JSON.stringify({ tool: 'codex', kind: 'subagent', agent_id: 'rc7', session_id: 'sess-1', task: {} }) + '\n');
  const r2 = reconcile(s);
  eq(r2.status, 0, 'exit 0');
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'codex agent not backfilled');
});
