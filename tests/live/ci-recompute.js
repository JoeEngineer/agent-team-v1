#!/usr/bin/env node
// Recompute the Director-transcript metrics of a finished live run with the current parser.
//   node tests/live/ci-recompute.js <transcript.jsonl> [--report <run report .json>] [--task-prs 36,37] [--milestone-prs 42]
//   node tests/live/ci-recompute.js <transcript.jsonl> --compare <run report .json>
// Task PR and milestone PR numbers come from the run report next to the transcript
// (<name>.transcript.jsonl -> <name>.json), from --report, or from the --compare report, unless
// given. --compare prints only the differences between the recomputed numbers and the ones the
// run report recorded at the time. Read-only: prints JSON to stdout.
'use strict';
const fs = require('fs');
const T = require('./ci-turns.js');
const L = require('./ci-wait-lib.js');

const CHECKED_TARGETS = ['no-foreground-watch', 'ci-turns-per-task-pr'];

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
      .filter((x) => CHECKED_TARGETS.includes(x.id)),
  };
}

// The differences between a recompute() result and what the run report recorded:
// [{ field, original, recomputed }]. Only the numbers the transcript decides (turns, tokens, CI
// turns, watches, per-PR counts) and the two targets it decides. A report without a field is
// reported as `original: null` (not an error).
function compare(r, report) {
  const rep = report && typeof report === 'object' ? report : {};
  const m = rep.metrics || {};
  const mci = m.ci || {};
  const diffs = [];
  const chk = (field, original, recomputed) => {
    if (original !== recomputed) diffs.push({ field, original: original === undefined ? null : original, recomputed });
  };
  chk('turns', m.turns, r.turns);
  chk('contextTokens', m.contextTokens, r.contextTokens);
  chk('ci.turns', mci.turns, r.ci.turns);
  chk('ci.contextTokens', mci.contextTokens, r.ci.contextTokens);
  chk('ci.startedByNotification', mci.startedByNotification, r.ci.startedByNotification);
  chk('ci.unattributed.turns', mci.unattributed && mci.unattributed.turns, r.ci.unattributed.turns);
  chk('ci.unattributed.contextTokens', mci.unattributed && mci.unattributed.contextTokens, r.ci.unattributed.contextTokens);
  chk('watch.foreground', m.watch && m.watch.foreground, r.watch.foreground);
  chk('watch.background', m.watch && m.watch.background, r.watch.background);
  const oldBy = mci.byPr || {};
  for (const pr of [...new Set([...Object.keys(oldBy), ...Object.keys(r.ci.byPr)])].sort((a, b) => a - b)) {
    chk(`ci.byPr.${pr}.turns`, oldBy[pr] ? oldBy[pr].turns : 0, r.ci.byPr[pr] ? r.ci.byPr[pr].turns : 0);
  }
  for (const id of CHECKED_TARGETS) {
    const was = (rep.targets || []).find((t) => t && t.id === id);
    const now = r.targets.find((t) => t.id === id);
    chk(`target ${id}`, was ? was.result : undefined, now ? now.result : undefined);
  }
  return diffs;
}

function main(argv) {
  const a = { file: null, report: null, task: null, ms: null, compare: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') a.report = argv[++i];
    else if (argv[i] === '--compare') a.compare = argv[++i];
    else if (argv[i] === '--task-prs') a.task = String(argv[++i] || '').split(',').filter(Boolean);
    else if (argv[i] === '--milestone-prs') a.ms = String(argv[++i] || '').split(',').filter(Boolean);
    else if (!a.file && !/^--/.test(argv[i])) a.file = argv[i];
    else { process.stderr.write(`unknown argument: ${argv[i]}\n`); return 2; }
  }
  if (!a.file || a.report === undefined || a.compare === undefined || a.report === '' || a.compare === '') {
    process.stderr.write('usage: node tests/live/ci-recompute.js <transcript.jsonl> [--report <report.json>] [--compare <report.json>] [--task-prs 1,2] [--milestone-prs 3]\n');
    return 2;
  }
  let text;
  try { text = fs.readFileSync(a.file, 'utf8'); } catch (e) { process.stderr.write(`cannot read ${a.file}: ${e.message}\n`); return 2; }
  const rp = a.report || a.compare || a.file.replace(/\.transcript\.jsonl$/, '.json');
  let rep = null;
  try { rep = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (e) {
    if (a.compare) { process.stderr.write(`cannot read the run report ${rp}: ${e.message}\n`); return 2; }
    /* otherwise: flags or nothing */
  }
  const taskPrs = a.task || (rep && rep.taskPrs ? rep.taskPrs.map((p) => String(p.number)) : []);
  const ms = a.ms || (rep ? [...new Set([rep.milestonePr && rep.milestonePr.number, rep.milestone && rep.milestone.reported && rep.milestone.reported.pr]
    .filter((x) => x != null && x !== 0 && x !== '0').map(String))] : []);
  const r = recompute(text, { taskPrs, milestonePrs: ms });
  if (a.compare) {
    const differences = compare(r, rep);
    process.stdout.write(JSON.stringify({ compare: { report: a.compare, same: differences.length === 0, differences } }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { recompute, compare, main };
