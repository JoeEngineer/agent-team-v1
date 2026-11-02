#!/usr/bin/env node
// Manually append an event to the team logs.
//   node log-event.js <kind> '<json>'
//   node log-event.js <kind> -              (JSON read from stdin)
//   node log-event.js <kind> --file <path>  (JSON read from a file)
// The stdin and --file forms keep the JSON out of shell quoting.
// kind: decision | escalation | merge | note | milestone | tier_fallback | delegation | review | pause
//   tier_fallback e.g. '{"task":"X-1","from":"large","to":"medium","tool":"claude","reason":"model unavailable"}'
//   delegation   e.g. '{"card":"TASK id=X-1 ... \nWHY ...","tool":"codex","task_name":"x_1_a1","agent":"implementer-medium","model":"gpt-6.1-terra","effort":"medium"}'
//   pause        e.g. '{"reason":"user","note":"intake question"}' (reason: user | runway | usage_limit; optional note, until)
//                Call it before asking the user a question or ending a turn on a user decision, and before a runway wait.
//   review       e.g. '{"card":"TASK id=X-2 reviewed_task=X-1 pr=5 ...","verdict":"approve","agent_id":"..."}'
// `card` is parsed into `task` (task card fields, plus `why` from a WHY line or a `why` field).
// `tool` defaults to AGENT_TEAM_TOOL, else "unknown". Director-written lines carry source "director".
// Writes to <project>/.agent-team/logs/<kind>s.jsonl (pauses.jsonl for pause), adding ts and guidance_version.
// note, escalation and merge lines get `milestone` from the linked task's delegation card when the JSON has none
// (the task is the `task` or `task_id` field); a merge also takes it from a `base` of milestone/<name>.
// merge: `command` is stored without leading `cd …` segments or absolute local paths.
// decision: a duplicate `id` is rejected; `model`/`effort` given as a family name, "unknown" or nothing
//   are filled from the session's resolved settings (the text given is kept as model_given).
// delegation: `kind` is subagent (default), resume or followup (scope added without a review verdict;
//   keeps the attempt). A retry that changes the task's type or difficulty is logged with card_drift and a warning.
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const records = require('./records');

const DELEGATION_KINDS = ['subagent', 'resume', 'followup'];
const PAUSE_REASONS = ['user', 'runway', 'usage_limit'];
const KINDS = new Set(['decision', 'escalation', 'merge', 'note', 'milestone', 'tier_fallback', 'delegation', 'review', 'pause']);

const USAGE = [
  `usage: log-event.js <${[...KINDS].join('|')}> <form>`,
  "  form: '<json>'             JSON as an argument",
  '        -                    JSON on stdin',
  '        --file <path>        JSON from a file',
].join('\n');

// Returns { json, fromArg } with the JSON text, { usage: true } for a bad form,
// or { error } if the file can't be read. Only the argument form may be empty (no JSON).
function jsonSource(args) {
  const [first, second] = args;
  if (first === '-') return { json: fs.readFileSync(0, 'utf8'), fromArg: false };
  if (first === '--file') {
    if (!second) return { usage: true };
    try {
      return { json: fs.readFileSync(second, 'utf8'), fromArg: false };
    } catch (err) {
      return { error: `cannot read ${second}: ${err.code || err.message}` };
    }
  }
  return { json: first, fromArg: true };
}

const lacking = (v) => v == null || v === '' || v === 'unknown' || v === 'inherited';
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Last model/effort in a Codex rollout transcript (its last turn_context).
function lastTurnContext(file) {
  const out = { model: null, effort: null };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('turn_context')) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.type === 'turn_context' && e.payload) {
        if (e.payload.model) out.model = e.payload.model;
        if (e.payload.effort) out.effort = e.payload.effort;
      }
    } catch { /* torn line */ }
  }
  return out;
}

// The Director session's resolved model and effort, from what the hooks saw:
// on Codex, the last turn_context of the session's own transcript (path from the
// latest raw hook event); otherwise the model SessionStart recorded. Nulls when
// nothing is known.
function sessionSettings(tool) {
  const dir = lib.logDir({});
  if (tool !== 'claude') {
    const rows = records.readJsonl(path.join(dir, 'codex-events.jsonl'));
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r.transcript_path) continue;
      const t = lastTurnContext(r.transcript_path);
      if (t.model || t.effort) return { model: t.model || r.model || null, effort: t.effort };
      if (r.model) return { model: r.model, effort: null };
    }
  }
  const marker = readJson(path.join(dir, '.pending', 'hooks-alive.json'));
  return { model: (marker && marker.model) || null, effort: null };
}

// A decision line's model and effort: free text like "GPT-6" (a family name
// the resolved model contains), "unknown" or a missing value is replaced by
// the session's resolved settings; the text given is kept as model_given.
// Returns the fields to merge into the record.
function resolveRouting(data, tool) {
  const needModel = lacking(data.model);
  const needEffort = lacking(data.effort);
  const s = (needModel || needEffort || typeof data.model === 'string') ? sessionSettings(tool) : {};
  const out = {};
  if (needModel) {
    out.model = s.model || null;
    if (s.model) out.model_source = 'session';
  } else if (s.model && data.model !== s.model && norm(s.model).includes(norm(data.model))) {
    out.model = s.model;
    out.model_given = data.model;
    out.model_source = 'session';
  }
  if (needEffort) {
    out.effort = s.effort || null;
    if (s.effort) out.effort_source = 'session';
  }
  return out;
}

// Decision ids must be unique in a logs folder. Returns an error message for
// a duplicate, or null.
function duplicateDecision(data) {
  if (data.id == null || data.id === '') return null;
  const rows = records.readJsonl(path.join(lib.logDir({}), 'decisions.jsonl'));
  const same = rows.find((r) => r.id != null && String(r.id) === String(data.id));
  if (!same) return null;
  const nums = rows.map((r) => Number(r.id)).filter(Number.isInteger);
  const next = nums.length ? String(Math.max(...nums) + 1).padStart(String(data.id).length, '0') : null;
  return `duplicate decision id ${data.id}: already logged${same.ts ? ` at ${same.ts}` : ''}${same.title ? ` ("${same.title}")` : ''}.` +
    `${next ? ` The next free id is ${next}.` : ''} Nothing was written.`;
}

function main(argv) {
  const [kind, ...args] = argv;
  if (!KINDS.has(kind)) {
    console.error(USAGE);
    return 1;
  }
  const src = jsonSource(args);
  if (src.usage) {
    console.error(USAGE);
    return 1;
  }
  if (src.error) {
    console.error(src.error);
    return 1;
  }
  let data = {};
  // An empty argument means no JSON, as before. Empty stdin or file is invalid JSON.
  if (src.json || !src.fromArg) {
    try {
      data = JSON.parse(src.json);
    } catch (err) {
      console.error(`invalid JSON: ${err.message}`);
      return 1;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.error('invalid JSON: expected an object');
    return 1;
  }

  if (kind === 'delegation' || kind === 'review') {
    const { card, why, ...rest } = data;
    const task = { ...(rest.task && typeof rest.task === 'object' ? rest.task : {}), ...lib.parseTaskCard(card) };
    if (why) task.why = why;
    delete rest.task;
    const tool = rest.tool || process.env.AGENT_TEAM_TOOL || 'unknown';
    delete rest.tool;
    if (kind === 'delegation') {
      const dkind = rest.kind || 'subagent';
      if (!DELEGATION_KINDS.includes(dkind)) {
        console.error(`invalid delegation: "kind" must be one of ${DELEGATION_KINDS.map((k) => `"${k}"`).join(', ')}`);
        return 1;
      }
      // A followup adds scope to a task without a review verdict: it keeps the attempt.
      if (dkind === 'followup' && task.id && task.attempt != null) {
        const prior = records.findDelegation({}, (r) => r.task && r.task.id === task.id && r.task.attempt != null);
        if (prior && Number(task.attempt) > Number(prior.task.attempt)) {
          console.error(`agent-team: followup for ${task.id} bumps attempt ${prior.task.attempt} -> ${task.attempt}; a followup keeps the attempt (bump it only after a review verdict or for a fold-in).`);
        }
      }
      const drift = records.cardDrift({}, task, dkind);
      if (drift) console.error(records.driftMessage(task.id, drift));
      lib.appendJsonl({}, 'delegations.jsonl', {
        ...records.base({}, tool),
        ...rest,
        kind: dkind,
        tool,
        task,
        ...(drift ? { card_drift: drift } : {}),
        source: 'director',
      });
    } else {
      // Same shape as records.logReview writes for hook-seen reviews.
      const { agent_id, resolved_model, model, effort, tier, ...review } = rest;
      records.logReview({}, {
        agent_id, task, resolved_model, model, effort, tier,
      }, { ...review, source: 'director' }, tool);
    }
    console.log(`logged ${kind} to .agent-team/logs/${kind}s.jsonl`);
    return 0;
  }

  if (kind === 'pause') {
    if (!PAUSE_REASONS.includes(data.reason)) {
      console.error(`invalid pause: "reason" must be one of ${PAUSE_REASONS.map((r) => `"${r}"`).join(', ')}`);
      return 1;
    }
  }
  if (kind === 'merge' && typeof data.command === 'string') data.command = records.sanitizeCommand(data.command);
  if (kind === 'decision') {
    const dup = duplicateDecision(data);
    if (dup) {
      console.error(dup);
      return 1;
    }
    Object.assign(data, resolveRouting(data, data.tool || process.env.AGENT_TEAM_TOOL || 'unknown'));
  }
  if (kind === 'merge' && !data.milestone) {
    const m = typeof data.base === 'string' && data.base.match(/^milestone\/(.+)$/);
    if (m) data.milestone = m[1];
  }
  if ((kind === 'note' || kind === 'escalation' || kind === 'merge') && !data.milestone) {
    const t = data.task_id || data.task;
    const id = t && typeof t === 'object' ? t.id : t;
    const m = typeof id === 'string' ? records.milestoneFor({}, id, t && typeof t === 'object' ? t : null) : undefined;
    if (m) data.milestone = m;
  }
  const record = { ts: new Date().toISOString(), guidance_version: lib.guidanceVersion(), ...data };
  lib.appendJsonl({}, `${kind}s.jsonl`, record);
  console.log(`logged ${kind} to .agent-team/logs/${kind}s.jsonl`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
