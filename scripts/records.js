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
    const dir = path.join(lib.logPath(input), '.pending');
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

// A reviews.jsonl row: the hook's own fields plus the review block's. A field
// the hook has a value for always wins; the block's different value for it is
// kept under `review_shadowed` instead. The block may fill a field the hook has
// no value for (a Director-written line passes `pr` or `milestone` this way),
// but never the row's identity (`review_id`, `ts`, `tool`, `guidance_version`).
const HOOK_ONLY = ['review_id', 'ts', 'tool', 'guidance_version', 'reconciled_by', 'review_shadowed'];
function withReview(known, review) {
  const row = { ...known };
  const shadowed = {};
  for (const [key, value] of Object.entries(review && typeof review === 'object' ? review : {})) {
    if (known[key] == null && !HOOK_ONLY.includes(key)) row[key] = value;
    else if (JSON.stringify(known[key]) !== JSON.stringify(value)) shadowed[key] = value;
  }
  if (Object.keys(shadowed).length) row.review_shadowed = shadowed;
  return row;
}

// Task identity matters: a resumed reviewer may issue the same verdict for a
// new attempt, or reuse its thread for a new task whose attempt resets to one.
function logReview(input, record, review, tool = 'claude') {
  const task = record.task || {};
  const identity = task.id || record.turn_id;
  const reviewId = reviewIdentity(input, record, review, tool);
  if (record.agent_id && !identity && !claimOnce(input, `review-${record.agent_id}-${shortHash(JSON.stringify(review))}`)) return false;
  // The review block is written by a model. Its fields are the review's content;
  // the fields below are what the hook knows, and the block must not replace them.
  const known = {
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
  };
  const row = withReview(known, review);
  if (reviewId) return appendOnce(input, 'reviews.jsonl', 'review_id', row);
  lib.appendJsonl(input, 'reviews.jsonl', row);
  return true;
}

// The last delegations.jsonl record for which predicate(record) is true, or
// null (missing file, corrupt line, no match).
function findDelegation(input, predicate) {
  // readJsonl skips a torn or corrupt line, so one bad line can't hide the
  // records written before it.
  const rows = readJsonl(path.join(lib.logPath(input), 'delegations.jsonl'));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) return rows[i];
  }
  return null;
}

// A retry keeps the task's attempt-1 `type` and `difficulty`. For a new
// delegation line's task card, compare with the first earlier delegation of the
// same task id (followup lines are scope additions and are not compared, nor
// compared against). Returns { type: {from, to}, difficulty: {from, to} } with
// only the fields that changed, or null.
function cardDrift(input, task, kind) {
  if (kind === 'followup' || !task || !task.id) return null;
  let first = null;
  try {
    for (const line of fs.readFileSync(path.join(lib.logDir(input), 'delegations.jsonl'), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec && rec.kind !== 'followup' && rec.task && rec.task.id === task.id && (rec.task.type || rec.task.difficulty)) { first = rec.task; break; }
    }
  } catch { /* no delegations yet */ }
  if (!first) return null;
  const drift = {};
  for (const f of ['type', 'difficulty']) {
    if (first[f] && task[f] && first[f] !== task[f]) drift[f] = { from: first[f], to: task[f] };
  }
  return Object.keys(drift).length ? drift : null;
}

const driftMessage = (id, drift) => `agent-team: task ${id} changed ${Object.entries(drift).map(([f, d]) => `${f} ${d.from} -> ${d.to}`).join(' and ')} since its first delegation. ` +
  'A retry keeps the attempt-1 type and difficulty; record new scope as kind "followup" or a new task id.';

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

// A shell command fit for a shared log: leading directory changes (`cd x;`,
// `cd x &&`, Set-Location, pushd) are dropped, and any absolute local path
// left (C:\..., /Users/..., /home/..., ~/...) becomes <path>. Archives can then
// be shared without local paths or usernames.
const LEADING_CD = /^\s*(?:cd|chdir|pushd|set-location|sl)\b(?:[^;&|\n"']|"[^"]*"|'[^']*')*(?:;|&&|\n)\s*/i;
const PATH_START = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|/)`;
const ABS_PATH = new RegExp(
  String.raw`"${PATH_START}[^"]*"|'${PATH_START}[^']*'|(?<=^|[\s=])${PATH_START}[^\s"';&|]*`, 'g');
function sanitizeCommand(cmd) {
  let out = String(cmd || '');
  for (let prev = null; prev !== out;) { prev = out; out = out.replace(LEADING_CD, ''); }
  return out.replace(ABS_PATH, '<path>');
}

function logMerges(input, tool = 'claude') {
  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!/\bgh\s+pr\s+merge\b/.test(cmd)) return;
  // Only real `gh pr merge` segments count, not the words inside a quoted string.
  for (const m of lib.findPrMerges(cmd)) {
    const state = prState(input, m);
    lib.appendJsonl(input, 'merges.jsonl', {
      ...base(input, tool),
      command: sanitizeCommand(cmd).slice(0, 300),
      pr: state && state.number != null ? String(state.number) : m.target,
      ...milestoneField(milestoneOfBase(state)),
      outcome: mergeOutcome(state),
      outcome_source: state ? 'gh pr view' : 'none',
      chained: lib.segments(cmd).length > 1,
    });
  }
}

// Why an attempt after the first exists. A followup is not an attempt (kind=followup).
const ATTEMPT_REASONS = ['sendback', 'escalation', 'fold-in', 'retry'];
const known = (v) => v != null && v !== '' && !['inherited', 'unknown', 'default'].includes(String(v));

// Compare a task card's requested tier= and effort= with the settings that run:
// the spawn's own for a new agent, the original agent's for a resume (a resume
// can't change them). Also checks reason=. Returns { fields, messages }: fields
// (tier_mismatch / effort_mismatch: {card, ran}) go on the delegation line,
// messages go to the Director.
function cardSettings(task, ran, kind) {
  const fields = {};
  const messages = [];
  if (!task || typeof task !== 'object') return { fields, messages };
  const resumed = kind === 'resume' || kind === 'followup';
  for (const f of ['tier', 'effort']) {
    if (!task[f] || !known(ran[f]) || String(task[f]) === String(ran[f])) continue;
    fields[`${f}_mismatch`] = { card: task[f], ran: ran[f] };
    messages.push(resumed
      ? `agent-team: task ${task.id || '?'} card says ${f} ${task[f]} but a resume keeps the agent's ${f} ${ran[f]}. To change tier or effort, spawn a new agent.`
      : `agent-team: task card says ${f} ${task[f]} but the spawn ran ${f} ${ran[f]}`);
  }
  if (task.reason && !ATTEMPT_REASONS.includes(task.reason)) {
    messages.push(`agent-team: task ${task.id || '?'} has reason=${task.reason}; use one of ${ATTEMPT_REASONS.join(', ')}.`);
  }
  if (task.reason === 'escalation' && kind === 'resume' && !fields.tier_mismatch && !fields.effort_mismatch) {
    messages.push(`agent-team: task ${task.id || '?'} is an escalation sent as a resume, which keeps the original model and effort. Spawn a new agent with the new settings, and put them on the card (tier=, effort=).`);
  }
  return { fields, messages };
}

// A role-agent delegation without a TASK line is logged without task fields,
// and the Coach can't use it.
const UNCARDED_MESSAGE = 'agent-team: this delegation has no TASK line, so it is logged without task fields and the Coach can\'t count it. ' +
  'Start every delegation prompt with a task card, including side work such as plugin fixes (use milestone=none outside a milestone).';

// Close the latest open pause in pauses.jsonl: append a `resume` line with the
// pause's start, duration and what ended it. `reasons` limits which pauses this
// caller may close (null: any). Returns the resume line, or null when there is
// no open pause (or another hook is closing it).
function closeOpenPause(input, closedBy, { reasons = null, note } = {}) {
  // logPath, not logDir: checking for a pause must not create the logs folder
  // (the prompt hook runs this in every project the plugin is enabled for).
  const file = path.join(lib.logPath(input), 'pauses.jsonl');
  if (!fs.existsSync(file)) return null;
  const done = withRecordLock(input, 'pause-close', () => {
    const rows = readJsonl(file);
    const last = rows[rows.length - 1];
    if (!last || last.kind === 'resume' || !last.reason) return null;
    if (reasons && !reasons.includes(last.reason)) return null;
    const now = new Date();
    const started = Date.parse(last.ts);
    const rec = {
      ts: now.toISOString(),
      guidance_version: lib.guidanceVersion(),
      kind: 'resume',
      reason: last.reason,
      paused_ts: last.ts || null,
      duration_ms: Number.isFinite(started) ? Math.max(0, now.getTime() - started) : null,
      closed_by: closedBy,
      ...milestoneField(last.milestone),
      ...(note ? { note } : {}),
    };
    lib.appendJsonl(input, 'pauses.jsonl', rec);
    return rec;
  });
  return done || null;
}

module.exports = {
  base, startFile, takeDuration, claimOnce, prunePending, shortHash, logReview,
  readJsonl, withRecordLock, appendOnce, reviewIdentity, findDelegation, milestoneFor, milestoneOfBase, prState, mergeOutcome, logMerges,
  cardDrift, driftMessage, sanitizeCommand,
  ATTEMPT_REASONS, cardSettings, UNCARDED_MESSAGE, closeOpenPause,
};
