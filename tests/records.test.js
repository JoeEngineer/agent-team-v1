// Tests for scripts/records.js: the tool-neutral record helpers.
'use strict';

const fs = require('fs');
const path = require('path');
const { SCRIPTS, tmpProject, fakeGh, readLog, test, assert, eq } = require('./helpers');

const records = require(path.join(SCRIPTS, 'records.js'));

const inputFor = (proj, extra = {}) => ({ session_id: 's1', cwd: proj, ...extra });

// records.js resolves the project from CLAUDE_PROJECT_DIR; point it at the temp project.
function withProject(proj, env, fn) {
  const saved = {};
  const vars = { CLAUDE_PROJECT_DIR: proj, ...env };
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('records.js: requiring it has no side effects and exports no main', () => {
  assert(typeof records.base === 'function', 'base exported');
  assert(records.main === undefined, 'no main');
});

test('base: tool defaults to claude and can be codex', () => {
  const input = { session_id: 's9' };
  eq(records.base(input).tool, 'claude', 'default tool');
  const b = records.base(input, 'codex');
  eq(b.tool, 'codex', 'codex tool');
  eq(b.session_id, 's9', 'session id');
  assert(b.ts && b.guidance_version !== undefined, 'ts and guidance_version present');
});

test('findDelegation: generic predicate returns the last match', () => {
  const proj = tmpProject();
  withProject(proj, {}, () => {
    const input = inputFor(proj);
    const dir = path.join(proj, '.agent-team', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'delegations.jsonl'), [
      { n: 1, kind: 'subagent', task: { id: 'T-1' } },
      { n: 2, kind: 'bridge', task: { id: 'T-1' } },
      { n: 3, kind: 'resume', task: { id: 'T-1' } },
      { n: 4, kind: 'resume', task: { id: 'T-2' } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    eq(records.findDelegation(input, (r) => r.task.id === 'T-1').n, 3, 'last T-1 record');
    eq(records.findDelegation(input, (r) => r.kind === 'subagent').n, 1, 'only match');
    eq(records.findDelegation(input, (r) => r.kind === 'nope'), null, 'no match is null');
  });
});

test('findDelegation: missing or corrupt delegations file gives null', () => {
  const proj = tmpProject();
  withProject(proj, {}, () => {
    const input = inputFor(proj);
    eq(records.findDelegation(input, () => true), null, 'missing file');
    const dir = path.join(proj, '.agent-team', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'delegations.jsonl'), 'not json{{\n');
    eq(records.findDelegation(input, () => true), null, 'corrupt file');
    fs.writeFileSync(path.join(dir, 'delegations.jsonl'), '');
    eq(records.findDelegation(input, () => true), null, 'empty file');
  });
});

test('logReview: no agent_id logs every time with a null agent_id; with one, duplicates are dropped', () => {
  const proj = tmpProject();
  withProject(proj, {}, () => {
    const input = inputFor(proj);
    const rec = { task: { id: 'T-1', pr: '3', attempt: 1 }, model: 'm' };
    const review = { verdict: 'approve' };
    records.logReview(input, rec, review);
    records.logReview(input, rec, review);
    const anon = readLog(proj, 'reviews.jsonl');
    eq(anon.length, 2, 'no agent_id: nothing to dedupe on');
    eq(anon[0].agent_id, null, 'agent_id null');
    eq(anon[0].reviewer_tier, null, 'tier null when undefined');

    const withId = { ...rec, agent_id: 'a1' };
    records.logReview(input, withId, review);
    records.logReview(input, withId, review);
    eq(readLog(proj, 'reviews.jsonl').length, 3, 'duplicate with agent_id dropped');
    records.logReview(input, withId, { verdict: 'changes' });
    eq(readLog(proj, 'reviews.jsonl').length, 4, 'new verdict content still logged');
  });
});

test('logMerges with tool codex: record is tagged codex and uses gh state', () => {
  const proj = tmpProject();
  withProject(proj, fakeGh('{"number":42,"state":"MERGED","autoMergeRequest":null}'), () => {
    records.logMerges(inputFor(proj, { tool_input: { command: 'gh pr merge 42 --squash && git pull' } }), 'codex');
    const [m] = readLog(proj, 'merges.jsonl');
    eq(m.tool, 'codex', 'tool');
    eq(m.pr, '42', 'pr');
    eq(m.outcome, 'merged', 'outcome');
    eq(m.outcome_source, 'gh pr view', 'source');
    eq(m.chained, true, 'chained');
  });
});

test('logMerges: gh failure is unknown; non-merge command logs nothing', () => {
  const proj = tmpProject();
  withProject(proj, fakeGh('', 1), () => {
    records.logMerges(inputFor(proj, { tool_input: { command: 'gh pr merge 7 --squash' } }), 'codex');
    records.logMerges(inputFor(proj, { tool_input: { command: 'echo "gh pr merge 8"' } }), 'codex');
    records.logMerges(inputFor(proj, { tool_input: {} }), 'codex');
    const all = readLog(proj, 'merges.jsonl');
    eq(all.length, 1, 'only the real merge logged');
    eq(all[0].outcome, 'unknown', 'outcome');
    eq(all[0].pr, '7', 'pr from command');
  });
});
