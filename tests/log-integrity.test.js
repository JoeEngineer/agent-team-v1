// Log integrity: a model-written review block can't replace the hook's own
// fields, a torn line doesn't hide earlier delegations, the logger stays out of
// projects that don't use agent-team, and model names are matched literally.
// Loaded and run by tests/run.js: node tests/run.js
'use strict';

const fs = require('fs');
const path = require('path');
const { SCRIPTS, bareProject, tmpProject, run, readLog, test, assert, eq } = require('./helpers');

const records = require(path.join(SCRIPTS, 'records.js'));
const models = require(path.join(SCRIPTS, 'models.js'));

console.log('log integrity');

function withProject(proj, fn) {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = proj;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
  }
}

test('logReview: the review block cannot replace fields the hook knows', () => {
  const proj = tmpProject();
  withProject(proj, () => {
    const record = { agent_id: 'agentA', task: { id: 'T-2', reviewed_task: 'T-1', pr: '5', attempt: 1, milestone: 'm1' }, model: 'sonnet', effort: 'high', tier: 'medium' };
    const review = {
      verdict: 'approve', severity: 'none', summary: 'ok',
      ts: '1999-01-01T00:00:00Z', tool: 'spoof', session_id: 'spoofed', review_id: 'review-fake',
      task_id: 'OTHER-9', pr: '999', milestone: 'other', reviewer_model: 'fable',
    };
    eq(records.logReview({ session_id: 'real' }, record, review), true, 'logged');
    const [row] = readLog(proj, 'reviews.jsonl');
    eq(row.verdict, 'approve', 'review content kept');
    eq(row.summary, 'ok', 'review content kept');
    eq(row.session_id, 'real', 'session_id');
    eq(row.tool, 'claude', 'tool');
    eq(row.task_id, 'T-1', 'task_id from the card');
    eq(row.pr, '5', 'pr from the card');
    eq(row.milestone, 'm1', 'milestone from the card');
    eq(row.reviewer_model, 'sonnet', 'reviewer_model');
    assert(row.ts !== review.ts, 'ts is the hook\'s');
    assert(/^review-[a-f0-9]{12}$/.test(row.review_id), 'review_id is the hook\'s');
    eq(row.review_shadowed.pr, '999', 'the block\'s own value is kept aside');
    eq(row.review_shadowed.task_id, 'OTHER-9', 'shadowed task_id');
  });
});

test('logReview: the block fills a field the hook has no value for, and equal values are not shadowed', () => {
  const proj = tmpProject();
  withProject(proj, () => {
    // A Director-written line: the card has no pr or milestone, the JSON does.
    const record = { agent_id: 'agentB', task: { id: 'T-3', attempt: 1 }, model: 'sonnet' };
    records.logReview({}, record, { verdict: 'approve', pr: '7', milestone: 'm2', attempt: 1, source: 'director' });
    const [row] = readLog(proj, 'reviews.jsonl');
    eq(row.pr, '7', 'pr filled');
    eq(row.milestone, 'm2', 'milestone filled');
    eq(row.source, 'director', 'extra field kept');
    eq(row.review_shadowed, undefined, 'nothing shadowed');
  });
});

test('findDelegation: a torn line does not hide earlier records', () => {
  const proj = tmpProject();
  withProject(proj, () => {
    fs.writeFileSync(path.join(proj, '.agent-team', 'logs', 'delegations.jsonl'),
      JSON.stringify({ agent_id: 'old', task: { id: 'T-1' } }) + '\n' +
      '{"agent_id":"torn\n' +
      JSON.stringify({ agent_id: 'new', task: { id: 'T-3' } }) + '\n');
    eq(records.findDelegation({}, (r) => r.agent_id === 'new').task.id, 'T-3', 'record after the torn line');
    eq(records.findDelegation({}, (r) => r.agent_id === 'old').task.id, 'T-1', 'record before the torn line');
  });
});

const agentCall = (type, prompt) => ({
  hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', session_id: 's',
  tool_input: { subagent_type: type, description: 'look at the billing code', prompt },
  tool_response: { agentId: 'a1', content: 'done' },
});

test('a project that never set up agent-team gets no logs folder', () => {
  const proj = bareProject();
  const exists = () => fs.existsSync(path.join(proj, '.agent-team'));
  run('user-prompt.js', { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, proj);
  assert(!exists(), 'user prompt');
  run('log-delegation.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'Explore', prompt: 'find it' } }, proj);
  run('log-delegation.js', agentCall('Explore', 'find it'), proj);
  assert(!exists(), 'a non-team subagent');
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --squash' }, tool_response: {} }, proj);
  assert(!exists(), 'a merge');
  run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_type: 'Explore', agent_id: 'a1' }, proj);
  assert(!exists(), 'a subagent stop');
});

test('a role agent or a carded delegation still logs in a project without .agent-team', () => {
  let proj = bareProject();
  run('log-delegation.js', agentCall('agent-team:scout', 'TASK id=X-1 type=research difficulty=easy milestone=none attempt=1\nWHY table'), proj);
  eq(readLog(proj, 'delegations.jsonl').length, 1, 'role agent');
  proj = bareProject();
  run('log-delegation.js', agentCall('general-purpose', 'TASK id=X-2 type=research difficulty=easy milestone=none attempt=1\nWHY table'), proj);
  eq(readLog(proj, 'delegations.jsonl')[0].task.id, 'X-2', 'carded delegation');
});

test('a project whose settings enable the plugin logs before .agent-team exists', () => {
  const proj = bareProject();
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'agent-team@agent-team': true } }));
  run('log-delegation.js', agentCall('Explore', 'find it'), proj);
  eq(readLog(proj, 'delegations.jsonl').length, 1, 'logged');
});

test('modelToTier: regex characters in a model name are matched literally', () => {
  const map = { medium: { claude: 'sonnet(beta' }, large: { claude: 'opus[1m]' } };
  eq(models.modelToTier(map, 'claude', 'claude-opus[1m]-5'), 'large', 'bracketed alias');
  eq(models.modelToTier(map, 'claude', 'claude-sonnet(beta-5'), 'medium', 'unbalanced parenthesis');
  eq(models.modelToTier(map, 'claude', 'claude-opus1-5'), null, '[1m] is not a character class');
});
