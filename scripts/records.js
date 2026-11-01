// Tool-neutral helpers for writing delegation, review and merge records.
// Shared by the Claude logger (log-delegation.js) and the Codex logger.
// No main and no side effects on require.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const lib = require('./lib');

function base(input, tool = 'claude') {
  return {
    ts: new Date().toISOString(),
    tool,
    session_id: input.session_id,
    guidance_version: lib.guidanceVersion(),
  };
}

function startFile(input) {
  const dir = path.join(lib.logDir(input), '.pending');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(input.tool_use_id || 'unknown').replace(/[^\w-]/g, '_')}.json`);
}

function takeDuration(input) {
  try {
    const file = startFile(input);
    const { started } = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    return Date.now() - started;
  } catch {
    return undefined;
  }
}

// Create a marker file once; false if it already exists. Used to log an event
// once when several hooks see it.
function claimOnce(input, key) {
  const dir = path.join(lib.logDir(input), '.pending');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, String(key).replace(/[^\w-]/g, '_')), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

// Best-effort sweep of old .pending entries: dedupe markers (stop-*, resume-*, review-*)
// and leaked start files (toolu_*.json) older than maxAgeMs. Looks at no more
// than `cap` entries per run, skips anything else (dotfiles, other tasks'
// files) and swallows every error.
const PRUNABLE = /^(stop-|resume-|review-|toolu_.*\.json$)/;
function prunePending(input, { maxAgeMs = 24 * 3600 * 1000, cap = 200 } = {}) {
  try {
    const dir = path.join(lib.logDir(input), '.pending');
    const now = Date.now();
    let seen = 0;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || !PRUNABLE.test(name)) continue;
      if (++seen > cap) break;
      try {
        const f = path.join(dir, name);
        if (now - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f);
      } catch { /* best effort */ }
    }
  } catch { /* no .pending yet */ }
}

const shortHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
      try {
        const r = JSON.parse(line);
        return r && typeof r === 'object' ? [r] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

// Serialize writes of one durable event. Unlike claimOnce, a lock is released
// after writing, so a process that dies before appending cannot consume the
// event forever. Recover a dead process's lock on a later hook/reconcile run.
function withRecordLock(input, id, fn) {
  const dir = path.join(lib.logDir(input), '.pending', 'record-locks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${shortHash(id)}.lock`);
  let fd;
  try {
    try { fd = fs.openSync(file, 'wx'); } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let dead = false;
      try {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
        }
      } catch {
        // The owner may still be writing its pid. Only reap a torn lock after
        // a generous grace period, never while another fresh hook is starting.
        dead = Date.now() - fs.statSync(file).mtimeMs > 5 * 60 * 1000;
      }
      if (!dead) return false;
      fs.unlinkSync(file);
      try { fd = fs.openSync(file, 'wx'); } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
      }
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return fn();
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.unlinkSync(file);
    }
  }
}

// The JSONL record, rather than an expiring marker, is the durable receipt.
function appendOnce(input, file, idField, record) {
  return withRecordLock(input, `${file}:${record[idField]}`, () => {
    if (readJsonl(path.join(lib.logDir(input), file)).some((r) => r[idField] === record[idField])) return false;
    lib.appendJsonl(input, file, record);
    return true;
  });
}

// The milestone for a line about a task: the task's own card, else the card of
// the latest delegation for the task id (a review's card may not carry it).
// Returns undefined when neither has one.
function milestoneFor(input, taskId, task) {
  if (task && task.milestone) return task.milestone;
  if (!taskId) return undefined;
  const d = findDelegation(input, (r) => r.task && r.task.id === taskId && r.task.milestone);
  return d ? d.task.milestone : undefined;
}

function reviewIdentity(input, record, review, tool = 'claude') {
  const task = record.task || {};
  const identity = task.id || record.turn_id;
  return record.agent_id && identity ? `review-${shortHash(JSON.stringify([
    tool, record.session_id || input.session_id || null, record.agent_id,
    task.id || null, task.reviewed_task || null, task.attempt == null ? null : String(task.attempt),
    task.role || task.type || record.agent || null, record.turn_id || null, review,
  ]))}` : null;
}

const milestoneField = (m) => (m ? { milestone: m } : {});

// Task identity matters: a resumed reviewer may issue the same verdict for a
// new attempt, or reuse its thread for a new task whose attempt resets to one.
function logReview(input, record, review, tool = 'claude') {
  const task = record.task || {};
  const identity = task.id || record.turn_id;
  const reviewId = reviewIdentity(input, record, review, tool);
  if (record.agent_id && !identity && !claimOnce(input, `review-${record.agent_id}-${shortHash(JSON.stringify(review))}`)) return false;
  const row = {
    ...base(input, tool),
    // A backfilled line keeps the run's version and says which version wrote it.
    ...(record.reconciled_by ? { guidance_version: record.guidance_version, reconciled_by: record.reconciled_by } : {}),
    ...(reviewId ? { review_id: reviewId } : {}),
    ...(record.turn_id ? { turn_id: record.turn_id } : {}),
    agent_id: record.agent_id || null,
    task_id: task.reviewed_task || task.id,
    review_task_id: task.id,
    role: task.role || task.type || record.agent || null,
    pr: task.pr,
    attempt: task.attempt,
    ...milestoneField(milestoneFor(input, task.reviewed_task || task.id, task)),
    reviewer_model: tool === 'codex' && record.resolved_model !== undefined ? record.resolved_model : (record.resolved_model || record.model),
    reviewer_effort: tool === 'codex' && record.resolved_effort !== undefined ? record.resolved_effort : (record.resolved_effort || record.effort),
    requested_model: record.model ?? null,
    requested_effort: record.effort ?? null,
    reviewer_tier: record.tier === undefined ? null : record.tier,
    ...review,
  };
  if (reviewId) return appendOnce(input, 'reviews.jsonl', 'review_id', row);
  lib.appendJsonl(input, 'reviews.jsonl', row);
  return true;
}

// The last delegations.jsonl record for which predicate(record) is true, or
// null (missing file, corrupt line, no match).
function findDelegation(input, predicate) {
  try {
    const lines = fs.readFileSync(path.join(lib.logDir(input), 'delegations.jsonl'), 'utf8').trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = JSON.parse(lines[i]);
      if (predicate(rec)) return rec;
    }
  } catch { /* none yet */ }
  return null;
}

// Ask GitHub what happened to the PR instead of guessing from command output:
// the Director often chains a merge with other commands whose output mentions
// "error" or "failed". Returns null if gh can't answer.
function prState(input, { target, repo }) {
  const args = ['pr', 'view'];
  if (target) args.push(target);
  if (repo) args.push('--repo', repo);
  args.push('--json', 'number,state,autoMergeRequest,baseRefName');
  // Tests point AGENT_TEAM_FAKE_GH at a Node script: on Windows, execFileSync
  // only finds gh.exe on PATH, so a fake `gh` script there would be skipped.
  const fake = process.env.AGENT_TEAM_FAKE_GH;
  const [bin, binArgs] = fake ? [process.execPath, [fake, ...args]] : ['gh', args];
  try {
    const out = execFileSync(bin, binArgs, {
      cwd: input.cwd || lib.projectDir(input),
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 7000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function mergeOutcome(state) {
  if (!state) return 'unknown';
  if (state.state === 'MERGED') return 'merged';
  if (state.state === 'OPEN' && state.autoMergeRequest) return 'auto-merge-queued';
  return 'not-merged';
}

// "milestone/<name>" base branch -> "<name>"; any other base has no milestone.
function milestoneOfBase(state) {
  const m = state && typeof state.baseRefName === 'string' && state.baseRefName.match(/^milestone\/(.+)$/);
  return m ? m[1] : undefined;
}

function logMerges(input, tool = 'claude') {
  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!/\bgh\s+pr\s+merge\b/.test(cmd)) return;
  // Only real `gh pr merge` segments count, not the words inside a quoted string.
  for (const m of lib.findPrMerges(cmd)) {
    const state = prState(input, m);
    lib.appendJsonl(input, 'merges.jsonl', {
      ...base(input, tool),
      command: cmd.slice(0, 300),
      pr: state && state.number != null ? String(state.number) : m.target,
      ...milestoneField(milestoneOfBase(state)),
      outcome: mergeOutcome(state),
      outcome_source: state ? 'gh pr view' : 'none',
      chained: lib.segments(cmd).length > 1,
    });
  }
}

module.exports = {
  base, startFile, takeDuration, claimOnce, prunePending, shortHash, logReview,
  readJsonl, withRecordLock, appendOnce, reviewIdentity, findDelegation, milestoneFor, milestoneOfBase, prState, mergeOutcome, logMerges,
};
