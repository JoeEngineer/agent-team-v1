#!/usr/bin/env node
// Manually append an event to the team logs.
//   node log-event.js <kind> '<json>'
// kind: decision | escalation | merge | note | milestone | tier_fallback | delegation | review
//   tier_fallback e.g. '{"task":"X-1","from":"large","to":"medium","tool":"claude","reason":"model unavailable"}'
//   delegation   e.g. '{"card":"TASK id=X-1 ... \nWHY ...","tool":"codex","task_name":"x_1_a1","agent":"implementer-medium","model":"gpt-6.1-terra","effort":"medium"}'
//   review       e.g. '{"card":"TASK id=X-2 reviewed_task=X-1 pr=5 ...","verdict":"approve","agent_id":"..."}'
// `card` is parsed into `task` (task card fields, plus `why` from a WHY line or a `why` field).
// `tool` defaults to AGENT_TEAM_TOOL, else "unknown". Director-written lines carry source "director".
// Writes to <project>/.agent-team/logs/<kind>s.jsonl, adding ts and guidance_version.
'use strict';

const lib = require('./lib');
const records = require('./records');

const KINDS = new Set(['decision', 'escalation', 'merge', 'note', 'milestone', 'tier_fallback', 'delegation', 'review']);

function main(argv) {
  const [kind, json] = argv;
  if (!KINDS.has(kind)) {
    console.error(`usage: log-event.js <${[...KINDS].join('|')}> '<json>'`);
    return 1;
  }
  let data = {};
  if (json) {
    try {
      data = JSON.parse(json);
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

  const record = { ts: new Date().toISOString(), guidance_version: lib.guidanceVersion(), ...data };
  lib.appendJsonl({}, `${kind}s.jsonl`, record);
  console.log(`logged ${kind} to .agent-team/logs/${kind}s.jsonl`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
