#!/usr/bin/env node
// Manually append an event to the team logs.
//   node log-event.js <kind> '<json>'
// kind: decision | escalation | merge | note | milestone
// Writes to <project>/.agent-team/logs/<kind>s.jsonl, adding ts and guidance_version.
'use strict';

const lib = require('./lib');

const KINDS = new Set(['decision', 'escalation', 'merge', 'note', 'milestone']);
const [kind, json] = process.argv.slice(2);

if (!KINDS.has(kind)) {
  console.error(`usage: log-event.js <${[...KINDS].join('|')}> '<json>'`);
  process.exit(1);
}

let data = {};
if (json) {
  try {
    data = JSON.parse(json);
  } catch (err) {
    console.error(`invalid JSON: ${err.message}`);
    process.exit(1);
  }
}

const record = { ts: new Date().toISOString(), guidance_version: lib.guidanceVersion(), ...data };
lib.appendJsonl({}, `${kind}s.jsonl`, record);
console.log(`logged ${kind} to .agent-team/logs/${kind}s.jsonl`);
