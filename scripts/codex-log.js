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
function routingFor(input, agentType) {
  const toml = readAgentToml(input, agentType);
  const suffix = ((agentType || '').match(TIER_SUFFIX) || [])[1] || null;
  const map = tierMap();
  const out = { model: 'inherited', model_source: 'inherited', tier: null, tier_source: null, tomlEffort: toml && toml.effort };
  if (toml && toml.model) {
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
  const r = routingFor(input, ti.agent_type);
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

// Facts from the subagent transcript. Every field is null when absent.
function readTranscript(file, turnId) {
  const out = { taskName: null, model: null, effort: null, tokens: null, detail: null, duration_ms: null };
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return out;
  }
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  const pathOf = (p) => (p && (p.agent_path || (p.source && p.source.subagent && p.source.subagent.thread_spawn && p.source.subagent.thread_spawn.agent_path))) || null;
  for (const e of events) {
    if (e.type !== 'session_meta' || !e.payload) continue;
    const p = pathOf(e.payload);
    if (p) { out.taskName = String(p).split('/').filter(Boolean).pop() || null; break; }
  }
  // Start of this turn: the task_started for turn_id, else the last one.
  const starts = [];
  events.forEach((e, i) => {
    if (e.type === 'event_msg' && e.payload && e.payload.type === 'task_started') starts.push(i);
  });
  const own = starts.filter((i) => turnId && events[i].payload.turn_id === turnId);
  const startIdx = own.length ? own[own.length - 1] : (starts.length ? starts[starts.length - 1] : -1);
  let finalUsage = null, baseline = null;
  events.forEach((e, i) => {
    const p = e.payload;
    if (e.type === 'turn_context' && p) {
      if (p.model) out.model = p.model;
      if (p.effort) out.effort = p.effort;
    } else if (e.type === 'event_msg' && p) {
      if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
        finalUsage = p.info.total_token_usage;
        if (i < startIdx) baseline = p.info.total_token_usage;
      } else if (p.type === 'task_complete' && p.duration_ms != null) {
        out.duration_ms = p.duration_ms;
      }
    }
  });
  if (finalUsage) {
    // total_token_usage is cumulative: take this turn's share.
    const d = (k) => (finalUsage[k] || 0) - (baseline && baseline[k] || 0);
    out.tokens = d('total_tokens');
    out.detail = {
      input: d('input_tokens'),
      cached_input: d('cached_input_tokens'),
      output: d('output_tokens'),
      reasoning_output: d('reasoning_output_tokens'),
    };
  }
  return out;
}

function onSubagentStop(input) {
  const report = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  const t = input.agent_transcript_path ? readTranscript(input.agent_transcript_path, input.turn_id)
    : readTranscript('', null);
  const agentId = input.agent_id || null;
  const key = `stop-${agentId || 'none'}-${input.turn_id || 'none'}-${records.shortHash(report || 'none')}`;
  if (!records.claimOnce(input, key)) return;
  const delegation = linkedDelegation(input, t.taskName);
  const resolvedModel = t.model || null;
  const map = tierMap();
  let tier = delegation && delegation.tier != null ? delegation.tier : null;
  let tierSource = delegation && delegation.tier != null ? delegation.tier_source : null;
  if (tier == null && resolvedModel) {
    tier = models.modelToTier(map, 'codex', resolvedModel);
    tierSource = tier ? 'resolved' : null;
  }
  const record = {
    ...records.base(input, 'codex'),
    kind: 'completion',
    agent: input.agent_type || null,
    agent_id: agentId,
    task_name: t.taskName,
    model: delegation ? delegation.model : (input.model || null),
    tier,
    tier_source: tierSource,
    ...(delegation && delegation.billing ? { billing: delegation.billing } : {}),
    resolved_model: resolvedModel,
    effort: delegation ? delegation.effort : null,
    resolved_effort: t.effort || null,
    task: delegation && delegation.task ? delegation.task : {},
    duration_ms: t.duration_ms,
    tokens: t.tokens,
    tokens_detail: t.detail,
    report_source: report ? 'hook-input' : 'none',
    result: lib.lastFencedJson(report, 'result-json'),
    review: lib.lastFencedJson(report, 'review-json'),
  };
  lib.appendJsonl(input, 'completions.jsonl', record);
  if (record.review) records.logReview(input, record, record.review, 'codex');
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
    try { rawLog(input); } catch { /* keep going */ }
    normalized(input);
  } catch { /* hooks must never break a session */ }
}

module.exports = { handle };
