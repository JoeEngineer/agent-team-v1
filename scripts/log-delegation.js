#!/usr/bin/env node
// Logs delegations (subagents, sessions, bridges), their results, reviewer
// verdicts and merges to <project>/.agent-team/logs/*.jsonl.
// Never blocks: any error is swallowed and the hook exits 0.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const lib = require('./lib');
const models = require('./models');

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
    tool: 'claude',
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

const shortHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

// A review can be seen twice (PostToolUse for a foreground subagent, then
// SubagentStop). Log it once per agent id and verdict content, so a re-review
// by the same (resumed) reviewer is still logged.
function logReview(input, record, review) {
  if (record.agent_id && !claimOnce(input, `review-${record.agent_id}-a${record.task.attempt || 0}-${shortHash(JSON.stringify(review))}`)) return;
  lib.appendJsonl(input, 'reviews.jsonl', {
    ...base(input),
    agent_id: record.agent_id || null,
    task_id: record.task.reviewed_task || record.task.id,
    pr: record.task.pr,
    attempt: record.task.attempt,
    reviewer_model: record.resolved_model || record.model,
    reviewer_effort: record.effort,
    reviewer_tier: record.tier === undefined ? null : record.tier,
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

// Ask GitHub what happened to the PR instead of guessing from command output:
// the Director often chains a merge with other commands whose output mentions
// "error" or "failed". Returns null if gh can't answer.
function prState(input, { target, repo }) {
  const args = ['pr', 'view'];
  if (target) args.push(target);
  if (repo) args.push('--repo', repo);
  args.push('--json', 'number,state,autoMergeRequest');
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

function onPostShell(input) {
  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!/\bgh\s+pr\s+merge\b/.test(cmd)) return;
  // Only real `gh pr merge` segments count, not the words inside a quoted string.
  for (const m of lib.findPrMerges(cmd)) {
    const state = prState(input, m);
    lib.appendJsonl(input, 'merges.jsonl', {
      ...base(input),
      command: cmd.slice(0, 300),
      pr: state && state.number != null ? String(state.number) : m.target,
      outcome: mergeOutcome(state),
      outcome_source: state ? 'gh pr view' : 'none',
      chained: lib.segments(cmd).length > 1,
    });
  }
  try { backfillCompletions(input); } catch { /* never block a merge */ }
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

const isToolResults = (content) =>
  Array.isArray(content) && content.length > 0 && content.every((c) => c && c.type === 'tool_result');

const RESUME_PREFIX = /^\s*The coordinator sent a message while you were working:/;

// Does this user entry start a new turn? A plain prompt does. A SendMessage
// resume is written by Claude Code as an isMeta entry ("The coordinator sent a
// message while you were working: ... TASK id=..."); other isMeta entries
// (system reminders) do not. Tool results never do. Returns the entry text or null.
function turnStartText(e, m) {
  if (e.type !== 'user' || isToolResults(m.content)) return null;
  const text = lib.responseText(m.content);
  if (!e.isMeta) return text;
  return RESUME_PREFIX.test(text) && /\bTASK id=/.test(text) ? text : null;
}

const newTurn = (n, text, e) => ({
  turn: n, task: lib.parseTaskCard(text),
  handback: null, lastText: '', lastId: null, lastMsgId: null,
  tokens: 0, classes: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  first: e && e.timestamp ? Date.parse(e.timestamp) : null, last: null,
});

// Read a subagent transcript: task card from its first prompt, model, and per
// turn (a first prompt, then each SendMessage resume): tokens (each API message
// counted once, split by class), wall time, and the final report. The report
// is the SubagentHandback tool's message when the agent used it, else the last
// assistant text. The result has every turn in `turns`; the top-level report,
// token and time fields are the latest turn's, so a lagging transcript can't
// hand back attempt 1's report for attempt 2, and attempt 2's tokens and
// duration don't include attempt 1's.
function readSubagentTranscript(file) {
  const out = { prompt: '', model: null, turns: [] };
  const seen = new Set();
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message || {};
    if (e.type === 'user' && !out.prompt) out.prompt = lib.responseText(m.content);
    const start = turnStartText(e, m);
    if (start !== null) {
      cur = newTurn(out.turns.length + 1, start, e);
      out.turns.push(cur);
    }
    if (e.type !== 'assistant') continue;
    if (!cur) { cur = newTurn(1, '', null); out.turns.push(cur); }
    if (e.timestamp) cur.last = Date.parse(e.timestamp);
    cur.lastId = m.id || e.uuid || cur.lastId;
    if (m.model) out.model = m.model;
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && c.type === 'tool_use' && c.name === 'SubagentHandback' && c.input) {
          cur.handback = lib.responseText(c.input.message);
        }
      }
    }
    if (m.id && !seen.has(m.id) && m.usage) {
      seen.add(m.id);
      const u = m.usage;
      const k = cur.classes;
      k.input += u.input_tokens || 0;
      k.output += u.output_tokens || 0;
      k.cache_read += u.cache_read_input_tokens || 0;
      k.cache_write += u.cache_creation_input_tokens || 0;
      cur.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) +
        (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    const text = Array.isArray(m.content)
      ? m.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
      : typeof m.content === 'string' ? m.content : '';
    if (text) {
      // One API message can be split across entries; keep its text together.
      cur.lastText = m.id && m.id === cur.lastMsgId ? `${cur.lastText}\n${text}` : text;
      cur.lastMsgId = m.id || null;
    }
  }
  const latest = out.turns[out.turns.length - 1] || newTurn(1, '', null);
  return { ...out, ...latest, turns: out.turns };
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

// Task card for a completion: the delegation's, with the attempt (and task id
// when the delegation has none) taken from the turn's own TASK line.
function completionTask(delegation, t) {
  const turnTask = t.task || {};
  const task = delegation ? { ...delegation.task } : lib.parseTaskCard(t.prompt);
  // No attempt= on the turn's TASK line is the malformed-card case: we keep the
  // delegation's attempt, which may be stale (e.g. a later resume's number).
  if (turnTask.attempt != null) task.attempt = turnTask.attempt;
  return task;
}

// Backfill at merge time. The transcript lags at SubagentStop, so a completion
// line can have result/review null. By merge time the transcript has caught up:
// re-read it and append a corrected line (report_source "backfill"). Append
// only; existing lines are never rewritten. Only the latest line per agent and
// turn is considered, and nothing is appended unless a value was recovered, so
// running it again is a no-op.
function backfillCompletions(input) {
  const file = path.join(lib.logDir(input), 'completions.jsonl');
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return; }
  const latest = new Map();
  for (const l of lines) {
    let rec;
    try { rec = JSON.parse(l); } catch { continue; }
    if (rec.kind === 'completion' && rec.agent_id && rec.transcript_path && rec.turn) latest.set(`${rec.agent_id}#${rec.turn}`, rec);
  }
  for (const rec of latest.values()) {
    // Missing means neither block was captured. Which block to recover is
    // decided by what the transcript holds, not by the agent name.
    if (rec.result || rec.review) continue;
    let t;
    try { t = readSubagentTranscript(rec.transcript_path).turns[rec.turn - 1]; } catch { continue; }
    if (!t) continue;
    const report = [t.handback, t.lastText].filter(Boolean).find((v) => /```(result|review)-json/.test(v));
    if (!report) continue;
    const result = lib.lastFencedJson(report, 'result-json');
    const review = lib.lastFencedJson(report, 'review-json');
    if (!result && !review) continue;
    const fixed = {
      ...rec, ...base(input),
      duration_ms: t.first && t.last ? t.last - t.first : rec.duration_ms,
      tokens_with_cache: t.tokens || rec.tokens_with_cache,
      tokens_by_class: t.tokens ? { ...t.classes } : rec.tokens_by_class,
      report_source: 'backfill', result, review,
    };
    // Review first: if it throws, nothing is appended (the merge hook swallows it).
    if (review) logReview(input, fixed, review);
    lib.appendJsonl(input, 'completions.jsonl', fixed);
  }
}

// SubagentStop: fires when any subagent finishes (foreground or background).
// Writes one completions.jsonl line with the result, linked by agent_id.
function onSubagentStop(input) {
  const tPath = input.agent_transcript_path;
  if (!tPath || !fs.existsSync(tPath)) return;
  const t = readSubagentTranscript(tPath);
  const meta = readMeta(tPath);
  const agentId = input.agent_id || (path.basename(tPath).match(/^agent-(.+)\.jsonl$/) || [])[1] || null;
  // The final report. `last_assistant_message` in the hook input is complete
  // when the hook runs; the transcript file can lag one message behind (seen
  // live in 2.1.314), so it's the fallback. Prefer a source with a JSON block.
  const sources = [
    ['hook-input', typeof input.last_assistant_message === 'string' ? input.last_assistant_message : null],
    ['handback', t.handback],
    ['text', t.lastText],
  ].filter(([, v]) => v);
  const hasBlock = (v) => /```(result|review)-json/.test(v);
  const [reportSource, report] = sources.find(([, v]) => hasBlock(v)) || sources[0] || ['none', ''];
  // SubagentStop can fire more than once for the same finish. A resumed agent
  // finishes again with a new report, so it's still logged.
  if (agentId && !claimOnce(input, `stop-${agentId}-t${t.turn || 1}-${shortHash(report || t.lastId || t.last || 'none')}`)) return;
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
    turn: t.turn || 1,
    transcript_path: tPath,
    report_source: reportSource,
    result: lib.lastFencedJson(report, 'result-json'),
    review: lib.lastFencedJson(report, 'review-json'),
  };
  lib.appendJsonl(input, 'completions.jsonl', record);
  if (record.review) logReview(input, record, record.review);
}

function main() {
  const input = lib.readStdin();
  if (lib.detectTool(input) === 'codex') return require('./codex-log').handle(input);
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
  if (tool === 'SendMessage') return onPostSendMessage(input);
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
