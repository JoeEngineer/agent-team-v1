// Codex hook handler. Never throws; never logs tool_input.message (encrypted).
// 1. Raw fields of delegation-related events -> codex-events.jsonl (the Coach ignores it).
// 2. Normalized records in the shared log files with tool "codex":
//    spawn -> fallback delegation, SubagentStop -> completion (+ review),
//    follow-up -> fallback resume, Bash -> merges. See docs/decisions/0004.
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const models = require('./models');
const records = require('./records');

const DELEGATION_TOOL = /^(?:collaboration)?(?:spawn_agent|followup_task|wait_agent|close_agent|send_input|resume_agent)$/;
const FOLLOWUP_TOOL = /^(?:followup_task|send_input|resume_agent)$/;
const MAX_MESSAGE = 2000;
const MAX_RESPONSE = 500;
const TIER_SUFFIX = /-(small|medium|large|xlarge)$/;

function smallResponse(resp) {
  if (resp === undefined || resp === null) return null;
  try {
    const s = typeof resp === 'string' ? resp : JSON.stringify(resp);
    if (s.length <= MAX_RESPONSE) return resp;
    return { truncated: s.slice(0, MAX_RESPONSE) + '...[truncated]' };
  } catch {
    return null;
  }
}

const bare = (name) => String(name || '').replace(/^collaboration/, '');

function rawLog(input) {
  const event = input.hook_event_name;
  const name = input.tool_name || '';
  const isTool = (event === 'PreToolUse' || event === 'PostToolUse') && DELEGATION_TOOL.test(name);
  if (!isTool && event !== 'SubagentStart' && event !== 'SubagentStop') return;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.slice(0, MAX_MESSAGE) : null;
  lib.appendJsonl(input, 'codex-events.jsonl', {
    ts: new Date().toISOString(),
    tool: 'codex',
    guidance_version: lib.guidanceVersion(),
    hook_event_name: event,
    tool_name: input.tool_name || null,
    session_id: input.session_id || null,
    turn_id: input.turn_id || null,
    model: input.model || null,
    agent_id: input.agent_id || null,
    agent_type: input.agent_type || null,
    task_name: ti.task_name || null,
    reasoning_effort: ti.reasoning_effort || null,
    tool_response: smallResponse(input.tool_response),
    last_assistant_message: last,
    transcript_path: input.transcript_path || null,
    agent_transcript_path: input.agent_transcript_path || null,
  });
}

let MAP = null;
function tierMap() {
  if (!MAP) {
    try { MAP = models.loadMap().map; } catch { MAP = {}; }
  }
  return MAP;
}

// model / effort from .codex/agents/<agent_type>.toml (flat `key = "value"` lines only).
function readAgentToml(input, agentType) {
  if (!agentType || !/^[\w.-]+$/.test(agentType)) return null;
  try {
    const text = fs.readFileSync(path.join(lib.projectDir(input), '.codex', 'agents', `${agentType}.toml`), 'utf8');
    const get = (key) => {
      const m = text.match(new RegExp(`^${key}\\s*=\\s*["']([^"'\\r\\n]*)["']`, 'm'));
      return m ? m[1] : null;
    };
    return { model: get('model'), effort: get('model_reasoning_effort') };
  } catch {
    return null;
  }
}

// model, tier and where they came from, for a Codex agent type.
function routingFor(input, agentType, requestedModel) {
  const toml = readAgentToml(input, agentType);
  const suffix = ((agentType || '').match(TIER_SUFFIX) || [])[1] || null;
  const map = tierMap();
  const out = { model: 'inherited', model_source: 'inherited', tier: null, tier_source: null, tomlEffort: toml && toml.effort };
  if (typeof requestedModel === 'string' && requestedModel) {
    out.model = requestedModel;
    out.model_source = 'override';
    out.tier = models.modelToTier(map, 'codex', requestedModel);
    out.tier_source = out.tier ? 'override' : null;
  } else if (toml && toml.model) {
    out.model = toml.model;
    out.model_source = 'agent-file';
    out.tier = models.modelToTier(map, 'codex', toml.model) || suffix;
    out.tier_source = out.tier ? 'agent-file' : null;
  } else if (suffix) {
    const e = models.entry(map, 'codex', suffix);
    if (e) {
      out.model = e.model;
      out.model_source = 'agent-name';
      out.tier = suffix;
      out.tier_source = 'agent-name';
    }
  }
  const e = out.tier && models.entry(map, 'codex', out.tier);
  if (e && e.billing) out.billing = e.billing;
  return out;
}

const hasTaskName = (name) => (rec) => rec.task_name === name;

// Latest delegation with this task_name, preferring the Director's own line
// (it carries the task card).
function latestDelegation(input, name) {
  if (!name) return null;
  return records.findDelegation(input, (r) => r.task_name === name && r.source === 'director') ||
    records.findDelegation(input, hasTaskName(name));
}

const lacking = (v) => v == null || v === '' || v === 'inherited' || v === 'unknown';

// The delegation a completion links to. A Director line may lack model, effort
// or tier (it only knows what the Director passed); fill those from the hook
// fallback line for the same task_name, then tier from the task card, so the
// completion keeps its routing fields. The tier is derived from the resolved
// model only after this (see onSubagentStop).
function linkedDelegation(input, name) {
  const d = latestDelegation(input, name);
  if (!d || d.source !== 'director') return d;
  if (!lacking(d.model) && !lacking(d.effort) && !lacking(d.tier)) return d;
  const hook = records.findDelegation(input, (r) => r.task_name === name && r.source === 'hook');
  const out = { ...d };
  if (hook) {
    if (lacking(out.model) && !lacking(hook.model)) { out.model = hook.model; out.model_source = hook.model_source; }
    if (lacking(out.effort) && !lacking(hook.effort)) { out.effort = hook.effort; out.effort_source = hook.effort_source; }
    if (lacking(out.tier) && hook.tier != null) { out.tier = hook.tier; out.tier_source = hook.tier_source; }
  }
  if (lacking(out.tier) && d.task && models.TIERS.includes(d.task.tier)) {
    out.tier = d.task.tier;
    out.tier_source = 'task-card';
  }
  if (out.tier && !out.billing) {
    const e = models.entry(tierMap(), 'codex', out.tier);
    if (e && e.billing) out.billing = e.billing;
  }
  return out;
}

function onSpawn(input) {
  const ti = input.tool_input || {};
  const name = ti.task_name;
  if (!name || records.findDelegation(input, hasTaskName(name))) return;
  const r = routingFor(input, ti.agent_type, ti.model);
  lib.appendJsonl(input, 'delegations.jsonl', {
    ...records.base(input, 'codex'),
    kind: 'subagent',
    source: 'hook',
    task_name: name,
    agent: ti.agent_type || null,
    agent_id: null,
    tool_use_id: input.tool_use_id || null,
    model: r.model,
    model_source: r.model_source,
    tier: r.tier,
    tier_source: r.tier_source,
    ...(r.billing ? { billing: r.billing } : {}),
    resolved_model: null,
    effort: ti.reasoning_effort || r.tomlEffort || 'inherited',
    effort_source: ti.reasoning_effort ? 'override' : (r.tomlEffort ? 'agent-file' : 'inherited'),
    task: {},
  });
}

function onFollowup(input) {
  const ti = input.tool_input || {};
  const target = ti.target || ti.id || ti.agent_id;
  const prior = latestDelegation(input, target);
  if (!prior) return;
  // A Director-written resume line for this task_name already covers it.
  if (prior.kind === 'resume' && prior.source === 'director') return;
  if (input.tool_use_id && !records.claimOnce(input, `resume-${input.tool_use_id}`)) return;
  lib.appendJsonl(input, 'delegations.jsonl', {
    ...records.base(input, 'codex'),
    kind: 'resume',
    source: 'hook',
    task_name: target,
    agent: prior.agent || null,
    agent_id: prior.agent_id || null,
    tool_use_id: input.tool_use_id || null,
    model: prior.model || 'unknown',
    model_source: prior.model ? 'prior-delegation' : 'unknown',
    tier: prior.tier === undefined ? null : prior.tier,
    tier_source: prior.tier_source || null,
    ...(prior.billing ? { billing: prior.billing } : {}),
    resolved_model: prior.resolved_model || null,
    effort: prior.effort || 'unknown',
    effort_source: prior.effort ? 'prior-delegation' : 'unknown',
    task: {},
  });
}

// Read exactly one child turn. Inherited context and later turns are not facts
// about this stop. A stop hook can run before task_complete has been appended.
function readTranscript(file, turnId) {
  const out = { taskName: null, model: null, effort: null, tokens: null, detail: null, duration_ms: null, turnFound: false, complete: false };
  const events = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        events.push(e && typeof e === 'object' && !Array.isArray(e) ? e : { type: 'unreadable' });
      } catch {
        // A torn record might be the final cumulative endpoint. Preserve the
        // uncertainty instead of silently retaining an earlier usage sample.
        events.push({ type: 'unreadable' });
      }
    }
  } catch { return out; }
  const pathOf = (p) => (p && (p.agent_path || (p.source && p.source.subagent && p.source.subagent.thread_spawn && p.source.subagent.thread_spawn.agent_path))) || null;
  for (const e of events) {
    if (e.type !== 'session_meta' || !e.payload) continue;
    const p = pathOf(e.payload);
    if (p) { out.taskName = String(p).split('/').filter(Boolean).pop() || null; break; }
  }
  if (!turnId) return out;
  const isStart = (e) => e.type === 'event_msg' && e.payload && e.payload.type === 'task_started';
  const startIdx = events.findIndex((e) => isStart(e) && e.payload.turn_id === turnId);
  if (startIdx < 0) return out;
  out.turnFound = true;
  let endIdx = events.findIndex((e, i) => i > startIdx && isStart(e));
  if (endIdx < 0) endIdx = events.length;
  const completeIdx = events.findIndex((e, i) => i > startIdx && e.type === 'event_msg' && e.payload && e.payload.type === 'task_complete' && e.payload.turn_id === turnId);
  if (completeIdx >= 0) {
    out.complete = true;
    const duration = events[completeIdx].payload.duration_ms;
    if (Number.isFinite(duration) && duration >= 0) out.duration_ms = duration;
    // Terminal records have an exact id even if their append is delayed past
    // the next start. Unkeyed usage/context must still stop at that boundary.
    endIdx = Math.min(endIdx, completeIdx);
  }
  const previousStart = events.slice(0, startIdx).findLastIndex(isStart);
  let baseline = null;
  // A previous turn with no endpoint must not silently borrow an older
  // cumulative total, which would charge several turns to this attempt.
  const previousId = previousStart >= 0 ? events[previousStart].payload.turn_id : null;
  const previousComplete = previousStart >= 0 ? events.findIndex((e, i) => i > previousStart && i < startIdx && e.type === 'event_msg' && e.payload && e.payload.type === 'task_complete' && e.payload.turn_id === previousId) : startIdx;
  for (const e of events.slice(previousStart + 1, previousComplete >= 0 ? previousComplete : previousStart + 1)) {
    if (e.type === 'unreadable') baseline = null;
    const p = e.payload;
    if (e.type === 'event_msg' && p && p.type === 'token_count' && (!p.turn_id || p.turn_id === previousId)) baseline = p.info && p.info.total_token_usage || null;
  }
  let finalUsage = null;
  for (const e of events.slice(startIdx + 1, endIdx)) {
    if (e.type === 'unreadable') finalUsage = null;
    const p = e.payload;
    if (!p || (p.turn_id && p.turn_id !== turnId)) continue;
    if (e.type === 'turn_context' && p) {
      if (p.model) out.model = p.model;
      if (p.effort) out.effort = p.effort;
    } else if (e.type === 'event_msg' && p) {
      if (p.type === 'token_count') {
        finalUsage = p.info && p.info.total_token_usage || null;
      }
    }
  }
  // Cumulative counts need both endpoints after a resume. Only the first turn
  // may use zero as its baseline; absent/reset counters are unknown, not zero.
  if (finalUsage && (baseline || previousStart < 0)) {
    const d = (k) => {
      const before = baseline ? baseline[k] : 0;
      return Number.isFinite(finalUsage[k]) && Number.isFinite(before) && finalUsage[k] >= before ? finalUsage[k] - before : null;
    };
    const total = d('total_tokens');
    const detail = { input: d('input_tokens'), cached_input: d('cached_input_tokens'), output: d('output_tokens'), reasoning_output: d('reasoning_output_tokens') };
    if (total !== null && Object.values(detail).every((n) => n !== null)) {
      out.tokens = total;
      out.detail = detail;
    }
  }
  return out;
}

const pendingDir = (input) => path.join(lib.logDir(input), '.pending', 'codex-completions');

function completionRecord(input, t) {
  const report = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  const agentId = input.agent_id || null;
  const delegation = linkedDelegation(input, t.taskName);
  const turnId = input.turn_id || null;
  // Known-turn identity is independent of callback report content. Legacy
  // events without a turn id retain a report-based fallback.
  const eventId = `codex-${records.shortHash(JSON.stringify([
    input.session_id || null, agentId, turnId,
    ...(turnId ? [] : [input.agent_transcript_path || null, report]),
  ]))}`;
  const task = delegation && delegation.task ? delegation.task : {};
  return {
    ...records.base(input, 'codex'),
    event_id: eventId,
    turn_id: turnId,
    attempt_key: records.shortHash(JSON.stringify([agentId, task.id || null, task.attempt == null ? null : String(task.attempt), task.role || task.type || input.agent_type || null])),
    kind: 'completion',
    agent: input.agent_type || null,
    agent_id: agentId,
    task_name: t.taskName,
    model: delegation ? delegation.model : (input.model || null),
    tier: delegation && delegation.tier != null ? delegation.tier : null,
    tier_source: delegation && delegation.tier != null ? delegation.tier_source : null,
    ...(delegation && delegation.billing ? { billing: delegation.billing } : {}),
    resolved_model: null,
    effort: delegation ? delegation.effort : null,
    resolved_effort: null,
    task,
    duration_ms: null,
    tokens: null,
    tokens_detail: null,
    report_source: report ? 'hook-input' : 'none',
    result: lib.lastFencedJson(report, 'result-json'),
    review: lib.lastFencedJson(report, 'review-json'),
  };
}

function finishPending(input, file, { dryRun = false } = {}) {
  const finish = () => {
    let pending;
    try { pending = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { state: 'waiting' }; }
    if (pending.version !== 1 || !pending.record || !pending.record.event_id) return { state: 'waiting' };
    const original = pending.record;
    const existing = records.readJsonl(path.join(lib.logDir(input), 'completions.jsonl')).find((r) => r.event_id === original.event_id);
    const t = readTranscript(pending.transcript_path, original.turn_id);
    if (!existing && pending.wait_for_complete && (!t.turnFound || !t.complete)) return { state: 'waiting' };
    const record = existing || { ...original, resolved_model: t.model, resolved_effort: t.effort, duration_ms: t.duration_ms, tokens: t.tokens, tokens_detail: t.detail };
    if (record.tier == null && record.resolved_model) {
      record.tier = models.modelToTier(tierMap(), 'codex', record.resolved_model);
      record.tier_source = record.tier ? 'resolved' : null;
    }
    if (dryRun) return { state: existing ? 'present' : 'backfilled', reviews: 0 };
    if (!existing) lib.appendJsonl(input, 'completions.jsonl', record);
    const sess = { ...input, session_id: record.session_id };
    const reviewAdded = record.review ? records.logReview(sess, record, record.review, 'codex') : false;
    // If a concurrent review writer owns the lock, leave the snapshot for a
    // later run rather than losing the completion's separate review record.
    if (record.review && !reviewAdded) {
      const reviewId = records.reviewIdentity(sess, record, record.review, 'codex');
      if (reviewId && !records.readJsonl(path.join(lib.logDir(input), 'reviews.jsonl')).some((r) => r.review_id === reviewId)) return { state: existing ? 'present' : 'backfilled', reviews: 0 };
    }
    fs.unlinkSync(file);
    return { state: existing ? 'present' : 'backfilled', reviews: reviewAdded ? 1 : 0 };
  };
  if (dryRun) return finish();
  return records.withRecordLock(input, `codex-stop:${path.basename(file)}`, finish) || { state: 'waiting' };
}

// Durable snapshots contain only parsed reports and routing/task metadata, not
// tool_input.message or an unbounded raw transcript. They survive marker prune.
function onSubagentStop(input) {
  const t = readTranscript(input.agent_transcript_path, input.turn_id);
  const record = completionRecord(input, t);
  const dir = pendingDir(input);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.event_id}.json`);
  records.withRecordLock(input, `codex-stop:${path.basename(file)}`, () => {
    if (fs.existsSync(file) || records.readJsonl(path.join(lib.logDir(input), 'completions.jsonl')).some((r) => r.event_id === record.event_id)) return;
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, transcript_path: input.agent_transcript_path || null, wait_for_complete: t.turnFound && !t.complete, record }));
      fs.renameSync(temp, file);
    } finally {
      try { fs.unlinkSync(temp); } catch { /* rename consumed it */ }
    }
  });
  if (fs.existsSync(file)) finishPending(input, file);
}

// No sleep/poll loop: later hooks (including wait_agent) and explicit reconcile
// revisit pending stops. Oldest-first touching gives a bounded sweep fairness.
function drainPending(input = {}, { dryRun = false, cap = 20 } = {}) {
  const stats = { checked: 0, backfilled: 0, present: 0, pending: 0, reviews: 0 };
  const dir = pendingDir(input);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^codex-[a-f0-9]+\.json$/.test(f)).map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.mtime - b.mtime);
  } catch { return stats; }
  for (const { file } of files.slice(0, cap)) {
    stats.checked++;
    try {
      const result = finishPending(input, file, { dryRun });
      if (result.state === 'backfilled' || result.state === 'present') stats[result.state]++;
      stats.reviews += result.reviews || 0;
      if (!dryRun && fs.existsSync(file)) { const now = new Date(); fs.utimesSync(file, now, now); }
    } catch { /* retain snapshot for another hook/reconcile */ }
  }
  stats.pending = dryRun ? files.length - stats.backfilled - stats.present : fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  return stats;
}

function normalized(input) {
  const event = input.hook_event_name;
  if (event === 'SubagentStop') return onSubagentStop(input);
  if (event !== 'PostToolUse') return;
  const name = input.tool_name || '';
  if (name === 'Bash' || name === 'PowerShell') return records.logMerges(input, 'codex');
  const tool = bare(name);
  if (tool === 'spawn_agent') return onSpawn(input);
  if (FOLLOWUP_TOOL.test(tool)) return onFollowup(input);
}

// True when this project's .codex/hooks.json calls the agent-team shim.
function projectHooksInstalled(input) {
  try {
    const text = fs.readFileSync(path.join(lib.projectDir(input), '.codex', 'hooks.json'), 'utf8');
    return text.includes('agent-team-hook.js');
  } catch {
    return false;
  }
}

function handle(input) {
  try {
    if (!input || typeof input !== 'object') return;
    // Project hooks win: if the project's hooks file runs the shim, this event
    // is (or will be) logged through it. Skip the plugin copy so a CLI that
    // runs both does not log twice.
    if (process.env.AGENT_TEAM_HOOK_SOURCE !== 'project' && projectHooksInstalled(input)) return;
    records.prunePending(input);
    drainPending(input);
    try { rawLog(input); } catch { /* keep going */ }
    normalized(input);
  } catch { /* hooks must never break a session */ }
}

module.exports = { handle, drainPending };
