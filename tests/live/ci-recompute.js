#!/usr/bin/env node
// Recompute the Director-transcript metrics of a finished live run with the current parser.
//   node tests/live/ci-recompute.js <transcript.jsonl> [--report <run report .json>] [--task-prs 36,37] [--milestone-prs 42]
// Task PR and milestone PR numbers come from the run report next to the transcript
// (<name>.transcript.jsonl -> <name>.json) unless given. Read-only: prints JSON to stdout.
'use strict';
const fs = require('fs');
const T = require('./ci-turns.js');
const L = require('./ci-wait-lib.js');

// text: the saved transcript (Claude stream-json, or a Codex rollout).
function recompute(text, { taskPrs, milestonePrs } = {}) {
  const objs = T.toObjects(text);
  const codex = objs.some((o) => o && o.type === 'session_meta');
  const parsed = codex ? T.parseCodexRollout(objs) : T.parseClaudeStream(objs);
  const task = (taskPrs || []).map(String);
  const breakdown = L.ciBreakdown(parsed.turns, { taskPrs: task, milestonePrs: (milestonePrs || []).map(String) });
  return {
    tool: codex ? 'codex' : 'claude',
    turns: parsed.turnCount, contextTokens: parsed.contextTokens,
    ci: parsed.ci, watch: parsed.watch,
    ciShare: parsed.contextTokens ? +(parsed.ci.contextTokens / parsed.contextTokens).toFixed(3) : 0,
    breakdown, milestoneJson: parsed.milestoneJson,
    ciTurns: parsed.turns.filter((t) => t.ci).map((t) => ({
      i: t.index, tokens: t.tokens, prs: t.prs, notified: t.notified.length,
      tools: t.tools.filter((x) => x.kinds.length).map((x) => ({ name: x.name, kinds: x.kinds, bg: x.background, watch: x.watch, cmd: x.command.slice(0, 200) })),
    })),
    targets: L.evaluateTargets({ summary: parsed, taskPrs: task, reviews: { pending: [], total: 0 }, milestone: { reported: null }, breakdown })
      .filter((x) => x.id === 'no-foreground-watch' || x.id === 'ci-turns-per-task-pr'),
  };
}

function main(argv) {
  const a = { file: null, report: null, task: null, ms: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') a.report = argv[++i];
    else if (argv[i] === '--task-prs') a.task = String(argv[++i] || '').split(',').filter(Boolean);
    else if (argv[i] === '--milestone-prs') a.ms = String(argv[++i] || '').split(',').filter(Boolean);
    else if (!a.file && !/^--/.test(argv[i])) a.file = argv[i];
    else { process.stderr.write(`unknown argument: ${argv[i]}\n`); return 2; }
  }
  if (!a.file) { process.stderr.write('usage: node tests/live/ci-recompute.js <transcript.jsonl> [--report <report.json>] [--task-prs 1,2] [--milestone-prs 3]\n'); return 2; }
  let text;
  try { text = fs.readFileSync(a.file, 'utf8'); } catch (e) { process.stderr.write(`cannot read ${a.file}: ${e.message}\n`); return 2; }
  const rp = a.report || a.file.replace(/\.transcript\.jsonl$/, '.json');
  let rep = null;
  if (!a.task || !a.ms) { try { rep = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (e) { /* flags or nothing */ } }
  const taskPrs = a.task || (rep && rep.taskPrs ? rep.taskPrs.map((p) => String(p.number)) : []);
  const ms = a.ms || (rep ? [...new Set([rep.milestonePr && rep.milestonePr.number, rep.milestone && rep.milestone.reported && rep.milestone.reported.pr]
    .filter((x) => x != null && x !== 0 && x !== '0').map(String))] : []);
  process.stdout.write(JSON.stringify(recompute(text, { taskPrs, milestonePrs: ms }), null, 2) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { recompute, main };
