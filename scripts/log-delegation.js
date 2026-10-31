#!/usr/bin/env node
// Logs delegations (subagents, sessions, bridges), their results, reviewer
// verdicts and merges to <project>/.agent-team/logs/*.jsonl.
// Never blocks: any error is swallowed and the hook exits 0.
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const models = require('./models');
const { base, startFile, takeDuration, claimOnce, prunePending, shortHash, logReview, findDelegation: findDelegationBy, logMerges } = require('./records');

// Loaded once per hook run; loadMap never throws, but stay safe anyway.
let MAP = null;
function tierMap() {
  if (!MAP) {
    try { MAP = models.loadMap().map; } catch { MAP = {}; }
  }
  return MAP;
}

// tier, tier_source and (when the map entry has one) billing for a model.
// source: 'override' | 'agent-file' | 'inherited' (use the resolved model; tier_source is then "resolved").
// Never throws: any failure gives tier null.
function tierFields({ model, source, agentTier, resolved }) {
  try {
    const map = tierMap();
    let tier = null;
    let tierSource = null;
    if (source === 'override') {
      tier = models.modelToTier(map, 'claude', model);
      tierSource = tier ? 'override' : null;
    } else if (source === 'agent-file') {
      tier = (models.TIERS.includes(agentTier) && agentTier) || models.modelToTier(map, 'claude', model);
      tierSource = tier ? 'agent-file' : null;
    } else {
      tier = models.modelToTier(map, 'claude', resolved);
      tierSource = tier ? 'resolved' : null;
    }
    const out = { tier: tier || null, tier_source: tierSource };
    const e = tier && models.entry(map, 'claude', tier);
    if (e && e.billing) out.billing = e.billing;
    return out;
  } catch {
    return { tier: null, tier_source: null };
  }
}

function agentTierOf(input, type) {
  try { return lib.agentDefaults(input, type).tier; } catch { return undefined; }
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const SESSION_START = 'mcp__ccd_session__start_session';
const SESSION_SETTINGS = new Set([
  'mcp__ccd_session_mgmt__set_session_model',
  'mcp__ccd_session_mgmt__set_session_effort',
]);
const isBridge = (t) => /^mcp__(codex-bridge|antigravity-bridge)__/.test(t) && !/check_runway|_check$/.test(t);
const isShell = (t) => t === 'Bash' || t === 'PowerShell';

// The delegation record for this agent, to pick up the routing the Director chose.
function findDelegation(input, agentId) {
  if (!agentId) return null;
  return findDelegationBy(input, (rec) => rec.agent_id === agentId);
}

function onPre(input) {
  if (!input.tool_use_id) return;
  fs.writeFileSync(startFile(input), JSON.stringify({ started: Date.now() }));
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

function onPostSubagent(input) {
  const ti = input.tool_input || {};
  const resp = input.tool_response;
  const r = resp && typeof resp === 'object' ? resp : {};
  const text = lib.responseText(resp);
  // Claude Code may run a subagent in the background even when the call didn't
  // ask for it; the response then only confirms the launch.
  const background = !!ti.run_in_background || r.isAsync === true || r.status === 'async_launched';
  const elapsed = takeDuration(input);
  const routing = resolveRouting(input, ti);
  const record = {
    ...base(input),
    kind: 'subagent',
    agent: ti.subagent_type || 'general-purpose',
    agent_id: r.agentId || null,
    tool_use_id: input.tool_use_id || null,
    ...routing,
    ...tierFields({ model: routing.model, source: routing.model_source, agentTier: agentTierOf(input, ti.subagent_type), resolved: r.resolvedModel }),
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
  takeDuration(input); // release the start file; sessions log no duration
  const ti = input.tool_input || {};
  const text = lib.responseText(input.tool_response);
  const sessionId = (text.match(/local_[\w-]+/) || [])[0] || null;
  lib.appendJsonl(input, 'delegations.jsonl', {
    ...base(input),
    kind: 'session',
    agent: 'session',
    model: ti.model || 'default',
    model_source: ti.model ? 'override' : 'default',
    ...tierFields({ model: ti.model, source: ti.model ? 'override' : 'inherited', resolved: null }),
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

// SendMessage to an existing agent with a task card is a new attempt of that
// task (warm context). Log it as a delegation so attempts aren't lost.
function onPostSendMessage(input) {
  const ti = input.tool_input || {};
  const message = typeof ti.message === 'string' ? ti.message : lib.responseText(ti.message);
  const task = lib.parseTaskCard(message);
  if (!task.id) return;
  const agentId = ti.to || ti.recipient || null;
  const prior = findDelegation(input, agentId) || {};
  lib.appendJsonl(input, 'delegations.jsonl', {
    ...base(input),
    kind: 'resume',
    agent: prior.agent || null,
    agent_id: agentId,
    tool_use_id: input.tool_use_id || null,
    model: prior.model || 'unknown',
    ...(prior.tier != null ? { tier: prior.tier, tier_source: prior.tier_source, ...(prior.billing ? { billing: prior.billing } : {}) }
      : tierFields({ source: 'inherited', resolved: prior.resolved_model })),
    model_source: prior.model ? 'prior-delegation' : 'unknown',
    resolved_model: prior.resolved_model || null,
    effort: prior.effort || 'unknown',
    effort_source: prior.effort ? 'prior-delegation' : 'unknown',
    description: ti.summary,
    task,
  });
}

// A real prompt: a string or a text part, not a tool result.
const isPrompt = (content) =>
  typeof content === 'string' ? content.trim() !== ''
    : Array.isArray(content) && content.some((c) => c && c.type === 'text' && c.text) &&
      !content.some((c) => c && c.type === 'tool_result');

// Does this user entry start a new turn? A plain prompt does. A SendMessage
// resume is written by Claude Code as an isMeta entry carrying a TASK card;
// other isMeta entries (system reminders, coordinator chatter) do not.
const startsTurn = (e, content) =>
  e.type === 'user' && isPrompt(content) &&
  (!e.isMeta || /\bTASK id=/.test(lib.responseText(content)));

const sleepMs = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Read a subagent transcript: task card from its first prompt, model, tokens
// (each API message counted once), wall time, and the final report. The report
// is the SubagentHandback tool's message when the agent used it, else the last
// assistant text, both from the latest turn only.
function readSubagentTranscript(file, upToTurn) {
  const out = { prompt: '', model: null, tokens: 0, first: null, last: null, lastText: '', handback: null, lastId: null, turn: 0, task: {}, classes: { input: 0, output: 0, cache_read: 0, cache_write: 0 } };
  const seen = new Set();
  let lastMsgId = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message || {};
    if (e.type === 'user' && !out.prompt) out.prompt = lib.responseText(m.content);
    // A new prompt (not a tool result; isMeta or not) starts a new turn, e.g. a
    // SendMessage resume. Report, tokens and wall time cover the latest turn
    // only, so a lagging transcript can't hand back attempt 1's report for
    // attempt 2, and attempt 2's tokens and duration don't include attempt 1's.
    if (startsTurn(e, m.content)) {
      if (upToTurn && out.turn >= upToTurn) break; // reconcile reads one turn at a time
      out.turn++;
      out.task = lib.parseTaskCard(lib.responseText(m.content));
      out.handback = null;
      out.lastText = '';
      lastMsgId = null;
      out.tokens = 0;
      out.classes = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      out.first = e.timestamp ? Date.parse(e.timestamp) : null;
      out.last = null;
    }
    if (e.type !== 'assistant') continue;
    if (e.timestamp) out.last = Date.parse(e.timestamp);
    out.lastId = m.id || e.uuid || out.lastId;
    if (m.model) out.model = m.model;
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && c.type === 'tool_use' && c.name === 'SubagentHandback' && c.input) {
          out.handback = lib.responseText(c.input.message);
        }
      }
    }
    if (m.id && !seen.has(m.id) && m.usage) {
      seen.add(m.id);
      const u = m.usage;
      out.classes.input += u.input_tokens || 0;
      out.classes.output += u.output_tokens || 0;
      out.classes.cache_read += u.cache_read_input_tokens || 0;
      out.classes.cache_write += u.cache_creation_input_tokens || 0;
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

// SubagentStop: fires when any subagent finishes (foreground or background).
// Writes one completions.jsonl line with the result, linked by agent_id.
function onSubagentStop(input) {
  const tPath = input.agent_transcript_path;
  if (!tPath || !fs.existsSync(tPath)) return;
  const meta = readMeta(tPath);
  const agentId = input.agent_id || (path.basename(tPath).match(/^agent-(.+)\.jsonl$/) || [])[1] || null;
  const agentType = input.agent_type || meta.agentType || null;
  const delegation = findDelegation(input, agentId);
  const hasBlock = (v) => /```(result|review)-json/.test(v);
  // The final report. `last_assistant_message` in the hook input is complete
  // when present; the transcript file can lag the live session (seen in
  // 2.1.314), and handback-ending agents often have no hook-input message, so
  // the transcript is the fallback. Prefer a source with a JSON block.
  const choose = () => {
    const t = readSubagentTranscript(tPath);
    const sources = [
      ['hook-input', typeof input.last_assistant_message === 'string' ? input.last_assistant_message : null],
      ['handback', t.handback],
      ['text', t.lastText],
    ].filter(([, v]) => v);
    const [reportSource, report] = sources.find(([, v]) => hasBlock(v)) || sources[0] || ['none', ''];
    return { t, reportSource, report };
  };
  let { t, reportSource, report } = choose();
  // Role agents (agent-team:*) always report a result-json/review-json block,
  // and a review task expects one; if it's missing the transcript probably
  // lags, so re-read it up to 4 x 500 ms. Other agents may end without a block
  // and shouldn't pay the wait on every stop. The delay is overridable for tests.
  const expectBlock = (agentType && agentType.startsWith('agent-team:')) ||
    (delegation && delegation.task && delegation.task.type === 'review');
  if (expectBlock && !hasBlock(report)) {
    // AGENT_TEAM_STOP_RETRY_MS is a test-only override of the 500 ms retry
    // delay. It is clamped to 1000 ms so a large value can't block the hook.
    const env = process.env.AGENT_TEAM_STOP_RETRY_MS;
    const delay = env !== undefined && env !== '' && Number(env) >= 0 ? Math.min(Number(env), 1000) : 500;
    for (let i = 0; i < 4 && !hasBlock(report); i++) {
      sleepMs(delay);
      ({ t, reportSource, report } = choose());
    }
  }
  // A resume whose prompt is in the file but has no assistant entry yet, and no
  // hook-input report: nothing of attempt 2 to log. Don't claim its marker.
  if (!report && t.turn > 1 && !t.last) return;
  // SubagentStop can fire more than once for the same finish. The key has the
  // turn and the report: a resumed agent's new attempt is still logged, and a
  // stale read of an earlier attempt's report can't claim the new marker.
  // Claimed only after the final choice, so a fenceless first read doesn't
  // shadow a later read with the block (different report, different key).
  if (agentId && !claimOnce(input, `stop-${agentId}-${t.turn}-${shortHash(report || t.lastId || t.last || 'none')}`)) return;
  const record = completionRecord(input, { agentType, agentId, meta, delegation, t, reportSource, report });
  lib.appendJsonl(input, 'completions.jsonl', record);
  if (record.review) logReview(input, record, record.review);
}

// Task card for a completion: the delegation's, with the attempt taken from
// the turn's own TASK line. With no attempt= on that line (malformed card) the
// delegation's attempt stays, which may be stale.
function completionTask(delegation, t) {
  const turnTask = t.task || {};
  const task = delegation ? { ...delegation.task } : lib.parseTaskCard(t.prompt);
  if (turnTask.attempt != null && Number(turnTask.attempt) !== Number(task.attempt)) task.attempt = turnTask.attempt;
  return task;
}

// The completions.jsonl line for one finished turn. Shared with
// scripts/reconcile-logs.js so a backfilled line has the same shape.
function completionRecord(input, { agentType, agentId, meta, delegation, t, reportSource, report }) {
  const routing = delegation || resolveRouting(input, { subagent_type: agentType });
  return {
    ...base(input),
    kind: 'completion',
    agent: agentType,
    agent_id: agentId,
    tool_use_id: meta.toolUseId || null,
    model: routing.model,
    ...(delegation && delegation.tier != null
      ? { tier: delegation.tier, tier_source: delegation.tier_source, ...(delegation.billing ? { billing: delegation.billing } : {}) }
      : tierFields({ model: routing.model, source: routing.model_source, agentTier: agentTierOf(input, agentType), resolved: t.model })),
    resolved_model: t.model,
    effort: routing.effort,
    // The effort Claude Code actually ran the subagent at, when the hook says.
    resolved_effort: (input.effort && input.effort.level) || null,
    // The attempt comes from the turn being logged (the TASK line that opened
    // it), not from the latest delegation, so a stale verdict is never stamped
    // with a newer attempt number.
    task: completionTask(delegation, t),
    // Latest turn only (a resumed agent's attempt 2 doesn't include attempt 1).
    // From the transcript, so they can miss the final message if the file lags.
    duration_ms: t.first && t.last ? t.last - t.first : null,
    // Includes cache reads/writes, so it's larger than Claude Code's own
    // `tokens` total on the delegation line. Compare like with like.
    tokens_with_cache: t.tokens || null,
    // The same tokens split by class, so cost can be priced.
    tokens_by_class: t.tokens ? { ...t.classes } : null,
    report_source: reportSource,
    result: lib.lastFencedJson(report, 'result-json'),
    review: lib.lastFencedJson(report, 'review-json'),
  };
}

function main() {
  const input = lib.readStdin();
  if (lib.detectTool(input) === 'codex') return require('./codex-log').handle(input);
  prunePending(input);
  const event = input.hook_event_name;
  const tool = input.tool_name || '';
  if (event === 'PreToolUse') return onPre(input);
  if (event === 'SubagentStop') return onSubagentStop(input);
  if (event !== 'PostToolUse') return;
  if (SUBAGENT_TOOLS.has(tool)) return onPostSubagent(input);
  if (tool === SESSION_START) return onPostSession(input);
  if (SESSION_SETTINGS.has(tool)) return onPostSessionSetting(input);
  if (isBridge(tool)) return onPostBridge(input);
  if (isShell(tool)) return logMerges(input, 'claude');
  if (tool === 'SendMessage') return onPostSendMessage(input);
}

module.exports = { readSubagentTranscript, readMeta, completionRecord };

// Only run as the hook; reconcile-logs.js requires this file for the helpers.
if (require.main === module) {
  try {
    main();
  } catch (err) {
    try {
      const input = {};
      lib.appendJsonl(input, 'hook-errors.jsonl', { ts: new Date().toISOString(), error: String(err && err.stack || err) });
    } catch { /* ignore */ }
  }
  process.exit(0);
}
