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

function logReview(input, record, review) {
  lib.appendJsonl(input, 'reviews.jsonl', {
    ...base(input),
    task_id: record.task.reviewed_task || record.task.id,
    pr: record.task.pr,
    attempt: record.task.attempt,
    reviewer_model: record.model,
    reviewer_effort: record.effort,
    ...review,
  });
}

function onPostSubagent(input) {
  const ti = input.tool_input || {};
  const resp = input.tool_response;
  const text = lib.responseText(resp);
  const background = !!ti.run_in_background;
  const record = {
    ...base(input),
    kind: 'subagent',
    agent: ti.subagent_type || 'general-purpose',
    ...resolveRouting(input, ti),
    isolation: ti.isolation || null,
    background,
    description: ti.description,
    task: lib.parseTaskCard(ti.prompt),
    duration_ms: takeDuration(input),
    ...lib.usageFrom(resp),
  };
  if (!background) {
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

// SubagentStop: catches results of background subagents. Best effort — reads
// the subagent's transcript if the hook input gives a path to it.
function onSubagentStop(input) {
  const tPath = input.agent_transcript_path || input.transcript_path;
  if (!tPath || !input.agent_transcript_path) return;
  let lastText = '';
  try {
    const lines = fs.readFileSync(tPath, 'utf8').trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && !lastText; i--) {
      const entry = JSON.parse(lines[i]);
      const msg = entry.message || entry;
      if ((entry.type === 'assistant' || msg.role === 'assistant') && msg.content) {
        lastText = lib.responseText(msg.content);
      }
    }
  } catch {
    return;
  }
  const result = lib.lastFencedJson(lastText, 'result-json');
  const review = lib.lastFencedJson(lastText, 'review-json');
  if (!result && !review) return;
  lib.appendJsonl(input, 'completions.jsonl', {
    ...base(input),
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    result,
    review,
  });
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
