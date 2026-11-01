#!/usr/bin/env node
// Manually append an event to the team logs.
//   node log-event.js <kind> '<json>'
//   node log-event.js <kind> -              (JSON read from stdin)
//   node log-event.js <kind> --file <path>  (JSON read from a file)
// The stdin and --file forms keep the JSON out of shell quoting.
// kind: decision | escalation | merge | note | milestone | tier_fallback | delegation | review | pause
//   tier_fallback e.g. '{"task":"X-1","from":"large","to":"medium","tool":"claude","reason":"model unavailable"}'
//   delegation   e.g. '{"card":"TASK id=X-1 ... \nWHY ...","tool":"codex","task_name":"x_1_a1","agent":"implementer-medium","model":"gpt-6.1-terra","effort":"medium"}'
//   pause        e.g. '{"reason":"user","note":"intake question"}' (reason: user | runway; optional note, until)
//                Call it before asking the user a question or ending a turn on a user decision, and before a runway wait.
//   review       e.g. '{"card":"TASK id=X-2 reviewed_task=X-1 pr=5 ...","verdict":"approve","agent_id":"..."}'
// `card` is parsed into `task` (task card fields, plus `why` from a WHY line or a `why` field).
// `tool` defaults to AGENT_TEAM_TOOL, else "unknown". Director-written lines carry source "director".
// Writes to <project>/.agent-team/logs/<kind>s.jsonl (pauses.jsonl for pause), adding ts and guidance_version.
// note and escalation lines get `milestone` from the linked task's delegation card when the JSON has none
// (the task is the `task` or `task_id` field).
'use strict';

const fs = require('fs');
const lib = require('./lib');
const records = require('./records');

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
      lib.appendJsonl({}, 'delegations.jsonl', {
        ...records.base({}, tool),
        kind: 'subagent',
        ...rest,
        tool,
        task,
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
    if (data.reason !== 'user' && data.reason !== 'runway') {
      console.error('invalid pause: "reason" must be "user" or "runway"');
      return 1;
    }
  }
  if ((kind === 'note' || kind === 'escalation') && !data.milestone) {
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
