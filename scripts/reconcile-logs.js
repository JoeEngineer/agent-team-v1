#!/usr/bin/env node
// Backfills completion and review records the SubagentStop hook missed, by
// reading the subagent transcripts. Usage: node scripts/reconcile-logs.js [--dry-run] [--merges]
//
// Claude Code subagent transcripts live at
//   <projects root>/<project folder>/<session id>/subagents/agent-<agent id>.jsonl
// The project folder name depends on where the session ran (worktrees differ
// from the project dir), so every project folder is searched for the session.
// The projects root is ~/.claude/projects, or AGENT_TEAM_PROJECTS_ROOT (tests).
// Read-only on the transcripts: only .agent-team/logs of the project is written.
// It may rewrite completions.jsonl/reviews.jsonl to add `stale_of` to lines whose
// content belongs to another attempt; every other line is kept byte for byte.
// --merges runs only the auto-merge step: for each `auto-merge-queued` line in
// merges.jsonl, ask the forge and append a resolution line (see
// records.resolveQueuedMerges). A plain run does it too, after the rest.
// It also appends a superseding completion line for a turn whose transcript has
// more tokens than the last completion line of that agent and turn (a wake-up
// after the hand-back, or the enforce-nudge turn, ran after the line was
// written): see supersedeShortTurns. Each transcript is read once per run.
// Exit code 1 when a log could not be rewritten (the log is then left as it was).
// Idempotent: a backfilled turn carries the same dedupe markers the hook uses,
// and a turn whose result/review already appears in completions.jsonl is skipped.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const { claimOnce, shortHash, logReview, isAmbiguous, appendOnce, resolveQueuedMerges } = require('./records');
const { readMeta, completionRecord, completionTask } = require('./log-delegation');
const { drainPending, readTranscript, turnIds, fillFromTranscript, transcriptRecord, pendingDir: codexPendingDir } = require('./codex-log');

// A SendMessage turn on an existing agent: a retry (resume) or a scope addition (followup).
const isResume = (d) => d.kind === 'resume' || d.kind === 'followup';

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

// A real prompt: a string or a text part, not a tool result. These two helpers
// and scanTranscript mirror readSubagentTranscript in log-delegation.js (which
// reads one turn per call), but take every turn in ONE read of the file.
// tests/reconcile.test.js checks that the two agree turn by turn.
const isPrompt = (content) =>
  typeof content === 'string' ? content.trim() !== ''
    : Array.isArray(content) && content.some((c) => c && c.type === 'text' && c.text) &&
      !content.some((c) => c && c.type === 'tool_result');
// A plain prompt starts a turn; a SendMessage resume is an isMeta entry that carries a TASK card. A wake-up
// notification or the enforce nudge carries no TASK line, so it stays inside the turn it interrupts.
const startsTurn = (e, content) =>
  e.type === 'user' && isPrompt(content) && (!e.isMeta || /\bTASK id=/.test(lib.responseText(content)));

const noClasses = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

// Reads the transcript once and returns one snapshot per turn: { turn, task,
// tokens, classes, handback, lastText, first, last, model, lastId, prompt }. A
// message id's usage counts once in the whole file. A file with no turn start
// gives one snapshot with turn 0.
function scanTranscript(file) {
  const snaps = [];
  let prompt = '', model = null, lastId = null, lastMsgId = null;
  const seen = new Set();
  let cur = { turn: 0, task: {}, tokens: 0, classes: noClasses(), handback: null, lastText: '', first: null, last: null };
  const snap = () => ({ ...cur, classes: { ...cur.classes }, model, lastId, prompt });
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message || {};
    if (e.type === 'user' && !prompt) prompt = lib.responseText(m.content);
    if (startsTurn(e, m.content)) {
      if (cur.turn > 0) snaps.push(snap());
      cur = { turn: cur.turn + 1, task: lib.parseTaskCard(lib.responseText(m.content)), tokens: 0, classes: noClasses(), handback: null, lastText: '', first: e.timestamp ? Date.parse(e.timestamp) : null, last: null };
      lastMsgId = null;
    }
    if (e.type !== 'assistant') continue;
    if (e.timestamp) cur.last = Date.parse(e.timestamp);
    lastId = m.id || e.uuid || lastId;
    if (m.model) model = m.model;
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && c.type === 'tool_use' && c.name === 'SubagentHandback' && c.input) cur.handback = lib.responseText(c.input.message);
      }
    }
    if (m.id && !seen.has(m.id) && m.usage) {
      seen.add(m.id);
      const u = m.usage;
      cur.classes.input += u.input_tokens || 0;
      cur.classes.output += u.output_tokens || 0;
      cur.classes.cache_read += u.cache_read_input_tokens || 0;
      cur.classes.cache_write += u.cache_creation_input_tokens || 0;
      cur.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    const text = Array.isArray(m.content)
      ? m.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
      : typeof m.content === 'string' ? m.content : '';
    if (text) {
      cur.lastText = m.id && m.id === lastMsgId ? `${cur.lastText}\n${text}` : text;
      lastMsgId = m.id || null;
    }
  }
  snaps.push(snap());
  return { turn: cur.turn, turns: snaps };
}

// Reads each transcript path at most once per run; `reads` counts the real file reads.
function transcriptCache() {
  const scans = new Map();
  const cache = {
    reads: 0,
    // null when the file cannot be read.
    get(file) {
      if (scans.has(file)) return scans.get(file);
      cache.reads++;
      let scan = null;
      try { scan = scanTranscript(file); } catch { scan = null; }
      scans.set(file, scan);
      return scan;
    },
  };
  return cache;
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
// A review field the hook's own value replaced sits under `review_shadowed`.
const rowHasReview = (row, review) =>
  !!review && Object.keys(review).every((key) => {
    const shadowed = row.review_shadowed && key in row.review_shadowed;
    return JSON.stringify(shadowed ? row.review_shadowed[key] : row[key]) === JSON.stringify(review[key]);
  });
const rowMatches = (row, probe) => (isReviewRow(row) ? rowHasReview(row, probe.review) : hasContent(row) && sameContent(row, probe));

// Test seams: runs just before each pre-rename check, and the rename itself.
const hooks = { beforeRename: null, rename: (from, to) => fs.renameSync(from, to) };

// A jsonl file as raw lines, so a rewrite keeps every line it doesn't change
// byte for byte (including lines that are not valid JSON). `row` is the parsed
// object or null; `buf` is the whole file as read.
function readLines(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { buf: Buffer.alloc(0), lines: [] }; }
  const lines = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0x0a) continue;
    if (i === buf.length && start === i) break; // nothing after the last newline
    const raw = buf.subarray(start, i);
    let row = null;
    try { const v = JSON.parse(raw.toString('utf8')); if (v && typeof v === 'object') row = v; } catch { /* kept as is */ }
    lines.push({ raw, row, changed: false, hadNl: i < buf.length });
    start = i + 1;
  }
  return { buf, lines };
}

// Rewrites `file` from the lines read, re-serialising only the lines flagged
// `changed`. Just before the rename the file is read again: bytes a hook
// appended since the first read are carried over (a few rounds, then it gives
// up). A hook append landing between that last check and the rename can still
// be lost; the window is a few microseconds. On any failure the temp file is
// removed and the error is thrown, leaving the log as it was.
function rewriteJsonl(file, read) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const parts = [];
    for (const l of read.lines) {
      let raw = l.raw;
      if (l.changed) raw = Buffer.from(JSON.stringify(l.row) + (raw[raw.length - 1] === 0x0d ? '\r' : ''), 'utf8');
      parts.push(raw, Buffer.from(l.hadNl ? '\n' : ''));
    }
    fs.writeFileSync(tmp, Buffer.concat(parts));
    let handled = read.buf.length;
    for (let round = 0; ; round++) {
      if (hooks.beforeRename) hooks.beforeRename(file, round);
      const now = fs.readFileSync(file);
      if (now.length < handled || !now.subarray(0, handled).equals(read.buf)) {
        throw new Error(`${path.basename(file)} was changed by something else while it was being rewritten`);
      }
      if (now.length === handled) break;
      if (round >= 5) throw new Error(`${path.basename(file)} kept growing while it was being rewritten`);
      fs.appendFileSync(tmp, now.subarray(handled));
      read.buf = now;
      handled = now.length;
    }
    hooks.rename(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* not created, or already gone */ }
    throw err;
  }
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

// Codex turns by turn_id. The child transcripts are known from the raw
// SubagentStart/SubagentStop rows in codex-events.jsonl. Two jobs:
//  1. fill stub completions (`stub: true`, the transcript lacked the turn when
//     the stop hook ran) from their transcript turn;
//  2. add a completion for each child turn that has none (its stop never
//     reached the hook, e.g. a turn cut off by a usage limit). Only turns at or
//     after the agent's first known turn count, so inherited (forked) parent
//     turns are never logged. The last turn is left alone while it may still
//     be running (no task_complete and no interruption).
// Backfilled lines carry `reconciled_by`; a turn with no report keeps
// `report_source: "missing"`.
function backfillCodexTurns(input, { dryRun = false } = {}) {
  const stats = { filled: 0, added: 0, running: 0, reviews: 0, errors: [] };
  const logDir = lib.logDir(input);
  const agents = new Map();
  for (const e of readJsonl(path.join(logDir, 'codex-events.jsonl'))) {
    if (!e.agent_id || (e.hook_event_name !== 'SubagentStop' && e.hook_event_name !== 'SubagentStart')) continue;
    const a = agents.get(e.agent_id) || { agent_id: e.agent_id, agent_type: null, session_id: null, transcript: null, turns: new Set() };
    a.agent_type = a.agent_type || e.agent_type || null;
    a.session_id = a.session_id || e.session_id || null;
    a.transcript = e.agent_transcript_path || a.transcript;
    if (e.turn_id) a.turns.add(e.turn_id);
    agents.set(e.agent_id, a);
  }
  if (!agents.size) return stats;
  const pending = new Set();
  try {
    const dir = codexPendingDir(input);
    for (const f of fs.readdirSync(dir)) {
      try { const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (p.record && p.record.turn_id) pending.add(`${p.record.agent_id}|${p.record.turn_id}`); } catch { /* torn snapshot */ }
    }
  } catch { /* no snapshots */ }
  const version = lib.guidanceVersion();
  const file = path.join(logDir, 'completions.jsonl');
  const read = readLines(file);
  const has = new Set(read.lines.filter((l) => l.row && l.row.turn_id).map((l) => `${l.row.agent_id}|${l.row.turn_id}`));
  const eventIds = new Set(read.lines.filter((l) => l.row && l.row.event_id).map((l) => l.row.event_id));
  // An unfinished turn counts as cut off once a later turn has started.
  const settle = (a, turnId, t) => {
    if (t.complete || t.interrupted) return t;
    const ids = turnIds(a.transcript);
    const i = ids.indexOf(turnId);
    return i >= 0 && i < ids.length - 1 ? { ...t, interrupted: 'no_task_complete' } : null;
  };
  const reviews = [];

  // 1. Stubs.
  for (const l of read.lines) {
    const r = l.row;
    if (!r || r.tool !== 'codex' || !r.stub || !r.turn_id) continue;
    const a = agents.get(r.agent_id);
    if (!a || !a.transcript) continue;
    const t0 = readTranscript(a.transcript, r.turn_id);
    const t = t0.turnFound ? settle(a, r.turn_id, t0) : null;
    if (!t) continue;
    const filled = fillFromTranscript(r, t);
    filled.reconciled_by = version;
    if (filled.review && !r.review) reviews.push(filled);
    l.row = filled;
    l.changed = true;
    stats.filled++;
  }
  if (stats.filled && !dryRun) {
    try { rewriteJsonl(file, read); } catch (err) {
      stats.errors.push(`could not rewrite completions.jsonl: ${err && err.message || err}`);
      reviews.length = 0;
    }
  }

  // 2. Turns with no line.
  for (const a of agents.values()) {
    if (!a.transcript) continue;
    const ids = turnIds(a.transcript);
    const known = (id) => a.turns.has(id) || has.has(`${a.agent_id}|${id}`) || pending.has(`${a.agent_id}|${id}`);
    const anchor = ids.findIndex(known);
    if (anchor < 0) continue;
    for (const id of ids.slice(anchor)) {
      if (has.has(`${a.agent_id}|${id}`) || pending.has(`${a.agent_id}|${id}`)) continue;
      const t = settle(a, id, readTranscript(a.transcript, id));
      if (!t) { stats.running++; continue; }
      const record = transcriptRecord(a, id, t);
      if (eventIds.has(record.event_id)) continue;
      record.reconciled_by = version;
      stats.added++;
      if (dryRun) continue;
      if (appendOnce(input, 'completions.jsonl', 'event_id', record) && record.review) reviews.push(record);
    }
  }
  if (!dryRun) {
    for (const r of reviews) if (lib.isReviewDelegation(r.agent, r.task) && logReview({ ...input, session_id: r.session_id }, r, r.review, 'codex')) stats.reviews++;
  }
  return stats;
}

// G18. A turn can run on after its completion line was written: the agent is
// woken by a background-task notification after it handed back, or the
// handback-enforce nudge sends it round again. Both stay inside the same
// transcript turn (neither carries a TASK line), so the turn's tokens in the
// transcript exceed the last line for that agent and turn. For each carded
// Claude agent, append ONE line that copies that last line and carries the
// full turn's tokens, with `reconciled_by` set. It is a completion line, not a
// review: reviews.jsonl is not touched, and readers take the last line per
// agent_id and turn. A rerun finds the totals equal and adds nothing. Lines
// marked stale_of are ignored. Codex agents are counted and skipped.
// Returns { checked, superseded, notFound, codex, errors }. Writes only to
// <logDir>/completions.jsonl, and nothing with dryRun. `scans` is a
// transcriptCache shared with the caller, so no transcript is read twice.
function supersedeShortTurns({ logDir, root, dryRun = false, scans = transcriptCache() }) {
  const out = { checked: 0, superseded: 0, notFound: 0, codex: 0, errors: [] };
  const agents = new Map();
  const entry = (id) => {
    if (!agents.has(id)) agents.set(id, { id, carded: false, session: null, tool: 'claude', last: new Map() });
    return agents.get(id);
  };
  for (const d of readJsonl(path.join(logDir, 'delegations.jsonl'))) {
    if (!d.agent_id || (d.kind !== 'subagent' && !isResume(d))) continue;
    const a = entry(d.agent_id);
    if (d.task && d.task.id) a.carded = true;
    a.session = d.session_id || a.session;
    if (d.tool && d.tool !== 'claude') a.tool = d.tool;
  }
  for (const c of readJsonl(path.join(logDir, 'completions.jsonl'))) {
    if (!c.agent_id) continue;
    const a = entry(c.agent_id);
    if (c.task && c.task.id) a.carded = true;
    a.session = a.session || c.session_id;
    if (c.tool && c.tool !== 'claude') a.tool = c.tool;
    if (c.stale_of == null && Number.isInteger(c.turn) && c.turn > 0) a.last.set(c.turn, c); // the last line of a turn wins
  }
  const file = path.join(logDir, 'completions.jsonl');
  const version = lib.guidanceVersion();
  for (const a of agents.values()) {
    if (!a.carded) continue;
    if (a.tool !== 'claude') { out.codex++; continue; }
    if (!a.last.size) continue; // no completion line to supersede (a missing turn is the backfill's job)
    out.checked++;
    const tPath = findTranscript(root, a.session, a.id);
    const scan = tPath && scans.get(tPath);
    if (!scan) { out.notFound++; continue; }
    for (const [turn, line] of [...a.last].sort((x, y) => x[0] - y[0])) {
      const t = scan.turns[turn - 1];
      if (!t || t.turn !== turn || !(t.tokens > (line.tokens_with_cache || 0))) continue;
      out.superseded++;
      if (dryRun) continue;
      const record = { ...line, ts: new Date().toISOString(), tokens_with_cache: t.tokens, tokens_by_class: { ...t.classes }, reconciled_by: version };
      try { fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8'); } catch (err) {
        out.superseded--;
        out.errors.push(`could not append to completions.jsonl: ${err && err.message || err}`);
      }
    }
  }
  return out;
}

function reconcile({ dryRun = false } = {}) {
  const input = {};
  const scans = transcriptCache();
  const logDir = lib.logDir(input);
  const root = projectsRoot();
  // Codex snapshots already identify their transcript and frozen delegation.
  // Process them even on Codex-only installs with no ~/.claude/projects.
  const codex = drainPending(input, { dryRun, cap: Infinity });
  codex.turns = backfillCodexTurns(input, { dryRun });
  const stats = { checked: 0, backfilled: 0, present: 0, notFound: 0, skipped: 0, reviews: 0, stale: 0, superseded: 0, reads: 0, rewritten: [], errors: [], codex };
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
    if (!d.agent_id || (d.kind !== 'subagent' && !isResume(d))) continue;
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
    const resumed = a.dels.some((d) => isResume(d));
    if (done && !resumed) { stats.checked++; stats.present++; continue; }
    stats.checked++;
    const tPath = findTranscript(root, a.session, a.id);
    const scan = tPath && scans.get(tPath);
    if (!scan) { stats.notFound++; continue; }
    const meta = readMeta(tPath);
    // Content match against lines that existed before this run only. The turn-keyed marker stops reruns; matching lines appended in this run would drop a turn with an identical report.
    const known = [...a.comps, ...a.dels.filter((d) => d.kind === 'subagent')].filter(hasContent);
    const agentType = (a.delegation && a.delegation.agent) || (a.comps.find((c) => c.agent) || {}).agent || meta.agentType || null;
    let added = 0;
    const turnInfos = [];
    for (let turn = 1; turn <= Math.max(scan.turn, 1); turn++) {
      const t = scan.turns[turn - 1];
      const source = [['handback', t.handback], ['text', t.lastText]].find(([, v]) => v && hasBlock(v));
      if (!source) continue; // no report block in this turn: nothing to backfill
      const [, report] = source;
      // Turn 1 is the original delegation, later turns are its SendMessage resumes.
      const taskDel = [a.delegation, ...a.dels.filter((d) => isResume(d))][turn - 1] || a.delegation;
      // The same reading as the completion line gets, so the content match below compares like with like.
      const probe = { result: lib.lastFencedJson(report, 'result-json'), review: lib.reviewFor(report, agentType, completionTask(taskDel, t)) };
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
      if (record.review && !isAmbiguous(record.review) && lib.isReviewDelegation(agentType, record.task)) { logReview(sess, record, record.review); stats.reviews++; }
    }
    if (a.dels.some((d) => isResume(d))) {
      for (const file of ['completions.jsonl', 'reviews.jsonl']) {
        const full = path.join(logDir, file);
        const read = readLines(full);
        const rows = read.lines.map((l) => l.row).filter(Boolean);
        const was = new Set(rows.filter((r) => r.stale_of != null));
        const n = markStale(rows, a.id, turnInfos);
        if (!n) continue;
        for (const l of read.lines) l.changed = !!l.row && l.row.stale_of != null && !was.has(l.row);
        if (!dryRun) {
          try { rewriteJsonl(full, read); } catch (err) {
            stats.errors.push(`could not rewrite ${file}: ${err && err.message || err}`);
            continue;
          }
          if (!stats.rewritten.includes(file)) stats.rewritten.push(file);
        }
        stats.stale += n;
      }
    }
    if (added) stats.backfilled += added; else stats.present++;
  }
  // After the backfill, so a line written above is already in the log; the
  // transcripts read above are not read again.
  const sup = supersedeShortTurns({ logDir, root, dryRun, scans });
  stats.superseded = sup.superseded;
  stats.errors.push(...sup.errors);
  stats.reads = scans.reads;
  return stats;
}

// Resolve queued auto-merges against the forge (one short line per PR).
// explain (--merges): with nothing to resolve, say why, so "nothing queued"
// and "no log at all" don't both look like empty output.
function reconcileMerges({ dryRun = false, explain = false } = {}) {
  const r = resolveQueuedMerges({}, { dryRun });
  const pre = dryRun ? '[dry run] ' : '';
  for (const l of r.lines) console.log(`${pre}${l}`);
  if (explain && !r.open) {
    if (!r.exists) {
      console.log(`${pre}no merges.jsonl at ${r.file}; hooks may be off`);
      console.error('reconcile-logs: no merge has been logged in this project; if merges were made, check that the agent-team hooks are on (the SessionStart line says "agent-team hooks: active")');
    } else console.log(`${pre}no queued merges (${r.total} merge line${r.total === 1 ? '' : 's'} in ${r.file})`);
  }
  return r;
}

// Returns the exit code: 1 when a log could not be rewritten.
function main(argv) {
  const dryRun = argv.includes('--dry-run');
  // --merges: only the auto-merge step (fast: no transcripts are read).
  if (argv.includes('--merges')) { reconcileMerges({ dryRun, explain: true }); return 0; }
  const s = reconcile({ dryRun });
  if (s.codex.checked) {
    console.log(`${dryRun ? '[dry run] ' : ''}Codex: ${s.codex.backfilled} ${dryRun ? 'would be backfilled' : 'completions backfilled'}, ${s.codex.present} already present, ${s.codex.pending} pending`);
  }
  const ct = s.codex.turns;
  if (ct.filled || ct.added || ct.running) {
    console.log(`${dryRun ? '[dry run] ' : ''}Codex turns by turn_id: ${ct.filled} stub lines filled, ${ct.added} missing turns added, ${ct.running} still running`);
  }
  s.errors.push(...ct.errors);
  if (s.noRoot) {
    console.log(`No Claude Code projects folder found (${s.noRoot}); nothing to reconcile for Claude Code.`);
    reconcileMerges({ dryRun });
    return 0;
  }
  console.log(`${dryRun ? '[dry run] ' : ''}checked ${s.checked} agents: ` +
    `${s.backfilled} ${dryRun ? 'would be backfilled' : 'completions backfilled'}, ` +
    `${s.present} already present, ${s.notFound} transcript not found` +
    (s.skipped ? `, ${s.skipped} non-Claude skipped` : ''));
  if (s.superseded) {
    console.log(`${dryRun ? '[dry run] ' : ''}${s.superseded} completion line${s.superseded === 1 ? '' : 's'} ${dryRun ? 'would be ' : ''}superseded with the full turn's tokens (the turn ran on after its line was written)`);
  }
  if (s.stale) {
    console.log(dryRun
      ? `[dry run] ${s.stale} lines would be marked stale_of (content belongs to another attempt)`
      : `${s.stale} lines marked stale_of (content belongs to another attempt) in ${s.rewritten.join(', ')}; all other lines kept as they were`);
  }
  reconcileMerges({ dryRun });
  for (const e of s.errors) console.error(`reconcile-logs: ${e}`);
  return s.errors.length ? 1 : 0;
}

module.exports = { reconcile, supersedeShortTurns, transcriptCache, scanTranscript, findTranscript, projectsRoot, main, hooks };

if (require.main === module) {
  let code = 0;
  try { code = main(process.argv.slice(2)); } catch (err) { console.error(`reconcile-logs: ${err && err.message || err}`); code = 1; }
  process.exit(code);
}
