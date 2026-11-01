#!/usr/bin/env node
// Backfills completion and review records the SubagentStop hook missed, by
// reading the subagent transcripts. Usage: node scripts/reconcile-logs.js [--dry-run]
//
// Claude Code subagent transcripts live at
//   <projects root>/<project folder>/<session id>/subagents/agent-<agent id>.jsonl
// The project folder name depends on where the session ran (worktrees differ
// from the project dir), so every project folder is searched for the session.
// The projects root is ~/.claude/projects, or AGENT_TEAM_PROJECTS_ROOT (tests).
// Read-only on the transcripts: only .agent-team/logs of the project is written.
// Idempotent: a backfilled turn carries the same dedupe markers the hook uses,
// and a turn whose result/review already appears in completions.jsonl is skipped.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const { claimOnce, shortHash, logReview } = require('./records');
const { readSubagentTranscript, readMeta, completionRecord } = require('./log-delegation');
const { drainPending } = require('./codex-log');

const hasBlock = (v) => /```(result|review)-json/.test(v);

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter((r) => r && typeof r === 'object');
  } catch {
    return [];
  }
}

function projectsRoot() {
  return process.env.AGENT_TEAM_PROJECTS_ROOT || path.join(os.homedir(), '.claude', 'projects');
}

function findTranscript(root, sessionId, agentId) {
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return null; }
  const file = `agent-${agentId}.jsonl`;
  for (const d of dirs) {
    let sessions;
    if (sessionId) sessions = [sessionId];
    else { try { sessions = fs.readdirSync(path.join(root, d)); } catch { continue; } }
    for (const s of sessions) {
      const p = path.join(root, d, s, 'subagents', file);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Same sanitising as records.claimOnce, to look at a marker without claiming it.
const markerExists = (logDir, key) =>
  fs.existsSync(path.join(logDir, '.pending', String(key).replace(/[^\w-]/g, '_')));

const hasContent = (r) => !!(r && (r.result || r.review));
const sameContent = (a, b) =>
  JSON.stringify(a.result || null) === JSON.stringify(b.result || null) &&
  JSON.stringify(a.review || null) === JSON.stringify(b.review || null);

const attemptOf = (k) => String((k.task && k.task.attempt) || k.attempt || '');

// A reviews.jsonl row spreads the review's fields (it has `verdict`, no `review`
// key), so it matches a review when every field of the review is equal on the row.
const isReviewRow = (row) => row.verdict !== undefined && row.review === undefined;
const rowHasReview = (row, review) =>
  !!review && Object.keys(review).every((key) => JSON.stringify(row[key]) === JSON.stringify(review[key]));
const rowMatches = (row, probe) => (isReviewRow(row) ? rowHasReview(row, probe.review) : hasContent(row) && sameContent(row, probe));

function rewriteJsonl(file, rows) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// Mark lines of this agent whose content belongs to another attempt: the 0.3.0
// hook wrote turn n's report under attempt n+1. `stale_of` is the attempt the
// content really belongs to (the first turn with that content). Readers drop
// lines that have it. Lines written by reconcile are never marked. Mutates the
// rows and returns how many it marked.
function markStale(rows, agentId, turnInfos) {
  let marked = 0;
  for (const row of rows) {
    if (row.agent_id !== agentId || row.stale_of != null || row.reconciled_by) continue;
    if (!isReviewRow(row) && !hasContent(row)) continue;
    const att = attemptOf(row);
    if (turnInfos.some((ti) => ti.attempt === att && rowMatches(row, ti.probe))) continue;
    const other = turnInfos.find((ti) => rowMatches(row, ti.probe));
    if (other) { row.stale_of = other.attempt; marked++; }
  }
  return marked;
}

function reconcile({ dryRun = false } = {}) {
  const input = {};
  const logDir = lib.logDir(input);
  const root = projectsRoot();
  // Codex snapshots already identify their transcript and frozen delegation.
  // Process them even on Codex-only installs with no ~/.claude/projects.
  const codex = drainPending(input, { dryRun, cap: Infinity });
  const stats = { checked: 0, backfilled: 0, present: 0, notFound: 0, skipped: 0, reviews: 0, stale: 0, codex };
  const delegations = readJsonl(path.join(logDir, 'delegations.jsonl'));
  const completions = readJsonl(path.join(logDir, 'completions.jsonl'));
  if (!fs.existsSync(root)) return { ...stats, noRoot: root };

  // One entry per agent id, with whatever the logs know about it.
  const agents = new Map();
  const entry = (id) => {
    if (!agents.has(id)) agents.set(id, { id, delegation: null, dels: [], comps: [], session: null, tool: 'claude' });
    return agents.get(id);
  };
  for (const d of delegations) {
    if (!d.agent_id || (d.kind !== 'subagent' && d.kind !== 'resume')) continue;
    const a = entry(d.agent_id);
    a.dels.push(d);
    if (d.kind === 'subagent' || !a.delegation) a.delegation = d;
    a.session = d.session_id || a.session;
    if (d.tool && d.tool !== 'claude') a.tool = d.tool;
  }
  for (const c of completions) {
    if (!c.agent_id) continue;
    const a = entry(c.agent_id);
    a.comps.push(c);
    a.session = a.session || c.session_id;
    if (c.tool && c.tool !== 'claude') a.tool = c.tool;
  }

  for (const a of agents.values()) {
    // Codex records carry no Claude transcript to read (its hook has the report).
    if (a.tool !== 'claude') { stats.skipped++; continue; }
    // Nothing to do when it has a result/review and was never resumed.
    const done = a.comps.some(hasContent) || a.dels.some((d) => d.kind === 'subagent' && hasContent(d));
    const resumed = a.dels.some((d) => d.kind === 'resume');
    if (done && !resumed) { stats.checked++; stats.present++; continue; }
    stats.checked++;
    const tPath = findTranscript(root, a.session, a.id);
    if (!tPath) { stats.notFound++; continue; }
    const meta = readMeta(tPath);
    // Content match against lines that existed before this run only. The turn-keyed marker stops reruns; matching lines appended in this run would drop a turn with an identical report.
    const known = [...a.comps, ...a.dels.filter((d) => d.kind === 'subagent')].filter(hasContent);
    const agentType = (a.delegation && a.delegation.agent) || (a.comps.find((c) => c.agent) || {}).agent || meta.agentType || null;
    let added = 0;
    const turnInfos = [];
    const turns = readSubagentTranscript(tPath).turn;
    for (let turn = 1; turn <= Math.max(turns, 1); turn++) {
      const t = readSubagentTranscript(tPath, turn);
      const source = [['handback', t.handback], ['text', t.lastText]].find(([, v]) => v && hasBlock(v));
      if (!source) continue; // no report block in this turn: nothing to backfill
      const [, report] = source;
      const probe = { result: lib.lastFencedJson(report, 'result-json'), review: lib.lastFencedJson(report, 'review-json') };
      // Turn 1 is the original delegation, later turns are its SendMessage resumes.
      const taskDel = [a.delegation, ...a.dels.filter((d) => d.kind === 'resume')][turn - 1] || a.delegation;
      // A match counts only on the same attempt: a stale line (turn n's report under attempt n+1) must not hide turn n+1.
      const att = String(t.task.attempt || (taskDel && taskDel.task && taskDel.task.attempt) || '');
      turnInfos.push({ attempt: att, probe });
      if (known.some((k) => sameContent(k, probe) && attemptOf(k) === att)) continue;
      const key = `stop-${a.id}-${t.turn}-${shortHash(report)}`;
      if (markerExists(logDir, key)) continue;
      added++;
      if (dryRun) continue;
      if (!claimOnce(input, key)) { added--; continue; }
      const sess = { session_id: a.session || undefined };
      const record = completionRecord(sess, { agentType, agentId: a.id, meta, delegation: taskDel, t, reportSource: 'reconcile', report });
      // Keep the version of the run being backfilled, and say which version wrote the line.
      record.guidance_version = (taskDel && taskDel.guidance_version) || record.guidance_version;
      record.reconciled_by = lib.guidanceVersion();
      lib.appendJsonl(input, 'completions.jsonl', record);
      if (record.review) { logReview(sess, record, record.review); stats.reviews++; }
    }
    if (a.dels.some((d) => d.kind === 'resume')) {
      for (const file of ['completions.jsonl', 'reviews.jsonl']) {
        const full = path.join(logDir, file);
        const rows = readJsonl(full);
        const n = markStale(rows, a.id, turnInfos);
        if (!n) continue;
        stats.stale += n;
        if (!dryRun) rewriteJsonl(full, rows);
      }
    }
    if (added) stats.backfilled += added; else stats.present++;
  }
  return stats;
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const s = reconcile({ dryRun });
  if (s.codex.checked) {
    console.log(`${dryRun ? '[dry run] ' : ''}Codex: ${s.codex.backfilled} ${dryRun ? 'would be backfilled' : 'completions backfilled'}, ${s.codex.present} already present, ${s.codex.pending} pending`);
  }
  if (s.noRoot) {
    console.log(`No Claude Code projects folder found (${s.noRoot}); nothing to reconcile for Claude Code.`);
    return;
  }
  console.log(`${dryRun ? '[dry run] ' : ''}checked ${s.checked} agents: ` +
    `${s.backfilled} ${dryRun ? 'would be backfilled' : 'completions backfilled'}, ` +
    `${s.present} already present, ${s.notFound} transcript not found` +
    (s.skipped ? `, ${s.skipped} non-Claude skipped` : ''));
}

module.exports = { reconcile, findTranscript };

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) { console.log(`reconcile-logs: ${err && err.message || err}`); }
  process.exit(0);
}
