#!/usr/bin/env node
// Logs delegations (subagents, sessions, bridges), their results, reviewer
// verdicts and merges to <project>/.agent-team/logs/*.jsonl.
// Never blocks: any error is swallowed and the hook exits 0.
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const SESSION_START = 'mcp__ccd_session__start_session';
const SESSION_SETTINGS = new Set([
  'mcp__ccd_session_mgmt__set_session_model',
  'mcp__ccd_session_mgmt__set_session_effort',
]);
const isBridge = (t) => /^mcp__(codex-bridge|antigravity-bridge)__/.test(t) && !/check_runway|_check$/.test(t);
const isShell = (t) => t === 'Bash' || t === 'PowerShell';

function startFile(input) {
  const dir = path.join(lib.logDir(input), '.pending');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(input.tool_use_id || 'unknown').replace(/[^\w-]/g, '_')}.json`);
}

function onPre(input) {
  if (!input.tool_use_id) return;
  fs.writeFileSync(startFile(input), JSON.stringify({ started: Date.now() }));
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

function base(input) {
  return {
    ts: new Date().toISOString(),
    session_id: input.session_id,
    guidance_version: lib.guidanceVersion(),
  };
}

function resolveRouting(input, ti) {
  const defaults = lib.agentDefaults(input, ti.subagent_type);
  const pick = (field) => {
    if (ti[field]) return { value: ti[field], source: 'override' };
    const d = defaults[field];
    if (d && d !== 'inherit') return { value: d, source: 'agent-file' };
    return { value: 'inherited', source: 'inherited' };
  };
  const model = pick('model');
  const effort = pick('effort');
  return {
    model: model.value, model_source: model.source,
    effort: effort.value, effort_source: effort.source,
  };
}

// A review can be seen twice (PostToolUse for a foreground subagent, then
// SubagentStop). Log it once per agent id.
function claimReview(input, agentId) {
  if (!agentId) return true;
  const dir = path.join(lib.logDir(input), '.pending');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, `review-${String(agentId).replace(/[^\w-]/g, '_')}`), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function logReview(input, record, review) {
  if (!claimReview(input, record.agent_id)) return;
  lib.appendJsonl(input, 'reviews.jsonl', {
    ...base(input),
    agent_id: record.agent_id || null,
    task_id: record.task.reviewed_task || record.task.id,
    pr: record.task.pr,
    attempt: record.task.attempt,
    reviewer_model: record.resolved_model || record.model,
    reviewer_effort: record.effort,
    ...review,
  });
}

function onPostSubagent(input) {
  const ti = input.tool_input || {};
  const resp = input.tool_response;
  const r = resp && typeof resp === 'object' ? resp : {};
  const text = lib.responseText(resp);
  // Claude Code may run a subagent in the background even when the call didn't
  // ask for it; the response then only confirms the launch.
  const background = !!ti.run_in_background || r.isAsync === true || r.status === 'async_launched';
  const elapsed = takeDuration(input);
  const record = {
    ...base(input),
    kind: 'subagent',
    agent: ti.subagent_type || 'general-purpose',
    agent_id: r.agentId || null,
    tool_use_id: input.tool_use_id || null,
    ...resolveRouting(input, ti),
    resolved_model: r.resolvedModel || null,
    isolation: ti.isolation || null,
    background,
    description: ti.description,
    task: lib.parseTaskCard(ti.prompt),
  };
  if (background) {
    // Result, duration and tokens arrive later in completions.jsonl (same agent_id).
    record.launch_ms = elapsed;
  } else {
    record.duration_ms = elapsed;
    Object.assign(record, lib.usageFrom(resp));
    record.result = lib.lastFencedJson(text, 'result-json');
    const review = lib.lastFencedJson(text, 'review-json');
    if (review) {
      record.review = review;
      logReview(input, record, review);
    }
  }
  lib.appendJsonl(input, 'delegations.jsonl', record);
}

function onPostSession(input) {
  const ti = input.tool_input || {};
  const text = lib.responseText(input.tool_response);
  const sessionId = (text.match(/local_[\w-]+/) || [])[0] || null;
  lib.appendJsonl(input, 'delegations.jsonl', {
    ...base(input),
    kind: 'session',
    agent: 'session',
    model: ti.model || 'default',
    model_source: ti.model ? 'override' : 'default',
    effort: ti.effort || 'default',
    effort_source: ti.effort ? 'override' : 'default',
    title: ti.title,
    initiation: ti.initiation,
    context: ti.context,
    worktree: ti.use_worktree,
    target: ti.target || 'local',
    child_session: sessionId,
    task: lib.parseTaskCard(ti.prompt || ti.brief),
  });
}

function onPostSessionSetting(input) {
  const ti = input.tool_input || {};
  lib.appendJsonl(input, 'delegations.jsonl', {
    ...base(input),
    kind: 'session-setting',
    tool: input.tool_name,
    target_session: ti.session_id || ti.id || ti.session,
    model: ti.model,
    effort: ti.effort || ti.level,
  });
}

function onPostBridge(input) {
  const ti = input.tool_input || {};
  const text = lib.responseText(input.tool_response);
  lib.appendJsonl(input, 'delegations.jsonl', {
    ...base(input),
    kind: 'bridge',
    agent: input.tool_name.replace(/^mcp__/, '').replace(/__.*/, ''),
    model: ti.model || 'default',
    effort: ti.effort || ti.reasoning_effort || 'default',
    task: lib.parseTaskCard(ti.prompt || ti.task || ti.instructions),
    duration_ms: takeDuration(input),
    result: lib.lastFencedJson(text, 'result-json'),
  });
}

function onPostShell(input) {
  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!/\bgh\s+pr\s+merge\b/.test(cmd)) return;
  const text = lib.responseText(input.tool_response);
  const failed = /\b(error|failed|not mergeable|denied)\b/i.test(text);
  lib.appendJsonl(input, 'merges.jsonl', {
    ...base(input),
    command: cmd.slice(0, 300),
    pr: (cmd.match(/gh\s+pr\s+merge\s+(\S+)/) || [])[1] || null,
    outcome: failed ? 'failed' : 'merged',
  });
}

// Read a subagent transcript: task card from its first prompt, model, tokens
// (each API message counted once), wall time, and the final assistant text.
function readSubagentTranscript(file) {
  const out = { prompt: '', model: null, tokens: 0, first: null, last: null, lastText: '' };
  const seen = new Set();
  let lastMsgId = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message || {};
    if (e.type === 'user' && !out.prompt) {
      out.prompt = lib.responseText(m.content);
      if (e.timestamp) out.first = Date.parse(e.timestamp);
    }
    if (e.type !== 'assistant') continue;
    if (e.timestamp) out.last = Date.parse(e.timestamp);
    if (m.model) out.model = m.model;
    if (m.id && !seen.has(m.id) && m.usage) {
      seen.add(m.id);
      const u = m.usage;
      out.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) +
        (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    const text = Array.isArray(m.content)
      ? m.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
      : typeof m.content === 'string' ? m.content : '';
    if (text) {
      // One API message can be split across entries; keep its text together.
      out.lastText = m.id && m.id === lastMsgId ? `${out.lastText}\n${text}` : text;
      lastMsgId = m.id || null;
    }
  }
  return out;
}

function readMeta(transcriptPath) {
  try {
    return JSON.parse(fs.readFileSync(transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

// The delegation record for this agent, to pick up the routing the Director chose.
function findDelegation(input, agentId) {
  if (!agentId) return null;
  try {
    const lines = fs.readFileSync(path.join(lib.logDir(input), 'delegations.jsonl'), 'utf8').trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = JSON.parse(lines[i]);
      if (rec.agent_id === agentId) return rec;
    }
  } catch { /* none yet */ }
  return null;
}

// SubagentStop: fires when any subagent finishes (foreground or background).
// Writes one completions.jsonl line with the result, linked by agent_id.
function onSubagentStop(input) {
  const tPath = input.agent_transcript_path;
  if (!tPath || !fs.existsSync(tPath)) return;
  const t = readSubagentTranscript(tPath);
  const meta = readMeta(tPath);
  const agentId = input.agent_id || (path.basename(tPath).match(/^agent-(.+)\.jsonl$/) || [])[1] || null;
  const agentType = input.agent_type || meta.agentType || null;
  const delegation = findDelegation(input, agentId);
  const routing = delegation || resolveRouting(input, { subagent_type: agentType });
  const record = {
    ...base(input),
    kind: 'completion',
    agent: agentType,
    agent_id: agentId,
    tool_use_id: meta.toolUseId || null,
    model: routing.model,
    resolved_model: t.model,
    effort: routing.effort,
    task: delegation ? delegation.task : lib.parseTaskCard(t.prompt),
    duration_ms: t.first && t.last ? t.last - t.first : null,
    // Includes cache reads/writes, so it's larger than Claude Code's own
    // `tokens` total on the delegation line. Compare like with like.
    tokens_with_cache: t.tokens || null,
    result: lib.lastFencedJson(t.lastText, 'result-json'),
    review: lib.lastFencedJson(t.lastText, 'review-json'),
  };
  lib.appendJsonl(input, 'completions.jsonl', record);
  if (record.review) logReview(input, record, record.review);
}

function main() {
  const input = lib.readStdin();
  const event = input.hook_event_name;
  const tool = input.tool_name || '';
  if (event === 'PreToolUse') return onPre(input);
  if (event === 'SubagentStop') return onSubagentStop(input);
  if (event !== 'PostToolUse') return;
  if (SUBAGENT_TOOLS.has(tool)) return onPostSubagent(input);
  if (tool === SESSION_START) return onPostSession(input);
  if (SESSION_SETTINGS.has(tool)) return onPostSessionSetting(input);
  if (isBridge(tool)) return onPostBridge(input);
  if (isShell(tool)) return onPostShell(input);
}

try {
  main();
} catch (err) {
  try {
    const input = {};
    lib.appendJsonl(input, 'hook-errors.jsonl', { ts: new Date().toISOString(), error: String(err && err.stack || err) });
  } catch { /* ignore */ }
}
process.exit(0);
