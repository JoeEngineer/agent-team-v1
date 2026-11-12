// Tool-neutral helpers for writing delegation, review and merge records.
// Shared by the Claude logger (log-delegation.js) and the Codex logger.
// No main and no side effects on require.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./lib');
const forge = require('./forge');

function base(input, tool = 'claude') {
  return {
    ts: new Date().toISOString(),
    tool,
    session_id: input.session_id,
    guidance_version: lib.guidanceVersion(),
  };
}

function startFile(input) {
  const dir = path.join(lib.logDir(input), '.pending');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(input.tool_use_id || 'unknown').replace(/[^\w-]/g, '_')}.json`);
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

// Best-effort sweep of old .pending entries: dedupe markers (stop-*, resume-*, review-*)
// and leaked start files (toolu_*.json) older than maxAgeMs. Looks at no more
// than `cap` entries per run, skips anything else (dotfiles, other tasks'
// files) and swallows every error.
const PRUNABLE = /^(stop-|resume-|review-|toolu_.*\.json$)/;
function prunePending(input, { maxAgeMs = 24 * 3600 * 1000, cap = 200 } = {}) {
  try {
    const dir = path.join(lib.logPath(input), '.pending');
    const now = Date.now();
    let seen = 0;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || !PRUNABLE.test(name)) continue;
      if (++seen > cap) break;
      try {
        const f = path.join(dir, name);
        if (now - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f);
      } catch { /* best effort */ }
    }
  } catch { /* no .pending yet */ }
}

const shortHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
      try {
        const r = JSON.parse(line);
        return r && typeof r === 'object' ? [r] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

// Serialize writes of one durable event. Unlike claimOnce, a lock is released
// after writing, so a process that dies before appending cannot consume the
// event forever. Recover a dead process's lock on a later hook/reconcile run.
function withRecordLock(input, id, fn) {
  const dir = path.join(lib.logDir(input), '.pending', 'record-locks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${shortHash(id)}.lock`);
  let fd;
  try {
    try { fd = fs.openSync(file, 'wx'); } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let dead = false;
      try {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
        }
      } catch {
        // The owner may still be writing its pid. Only reap a torn lock after
        // a generous grace period, never while another fresh hook is starting.
        dead = Date.now() - fs.statSync(file).mtimeMs > 5 * 60 * 1000;
      }
      if (!dead) return false;
      fs.unlinkSync(file);
      try { fd = fs.openSync(file, 'wx'); } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
      }
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return fn();
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.unlinkSync(file);
    }
  }
}

// The JSONL record, rather than an expiring marker, is the durable receipt.
function appendOnce(input, file, idField, record) {
  return withRecordLock(input, `${file}:${record[idField]}`, () => {
    if (readJsonl(path.join(lib.logDir(input), file)).some((r) => r[idField] === record[idField])) return false;
    lib.appendJsonl(input, file, record);
    return true;
  });
}

// The milestone for a line about a task: the task's own card, else the card of
// the latest delegation for the task id (a review's card may not carry it).
// Returns undefined when neither has one.
function milestoneFor(input, taskId, task) {
  if (task && task.milestone) return task.milestone;
  if (!taskId) return undefined;
  const d = findDelegation(input, (r) => r.task && r.task.id === taskId && r.task.milestone);
  return d ? d.task.milestone : undefined;
}

function reviewIdentity(input, record, review, tool = 'claude') {
  const task = record.task || {};
  const identity = task.id || record.turn_id;
  return record.agent_id && identity ? `review-${shortHash(JSON.stringify([
    tool, record.session_id || input.session_id || null, record.agent_id,
    task.id || null, task.reviewed_task || null, task.attempt == null ? null : String(task.attempt),
    task.role || task.type || record.agent || null, record.turn_id || null, review,
  ]))}` : null;
}

const milestoneField = (m) => (m ? { milestone: m } : {});

// A reviews.jsonl row: the hook's own fields plus the review block's. A field
// the hook has a value for always wins; the block's different value for it is
// kept under `review_shadowed` instead. The block may fill a field the hook has
// no value for (a Director-written line passes `pr` or `milestone` this way),
// but never the row's identity (`review_id`, `ts`, `tool`, `guidance_version`).
const HOOK_ONLY = ['review_id', 'ts', 'tool', 'guidance_version', 'reconciled_by', 'review_shadowed'];
function withReview(known, review) {
  const row = { ...known };
  const shadowed = {};
  for (const [key, value] of Object.entries(review && typeof review === 'object' ? review : {})) {
    if (known[key] == null && !HOOK_ONLY.includes(key)) row[key] = value;
    else if (JSON.stringify(known[key]) !== JSON.stringify(value)) shadowed[key] = value;
  }
  if (Object.keys(shadowed).length) row.review_shadowed = shadowed;
  return row;
}

// Task identity matters: a resumed reviewer may issue the same verdict for a
// new attempt, or reuse its thread for a new task whose attempt resets to one.
function logReview(input, record, review, tool = 'claude') {
  const task = record.task || {};
  const identity = task.id || record.turn_id;
  const reviewId = reviewIdentity(input, record, review, tool);
  if (record.agent_id && !identity && !claimOnce(input, `review-${record.agent_id}-${shortHash(JSON.stringify(review))}`)) return false;
  // The review block is written by a model. Its fields are the review's content;
  // the fields below are what the hook knows, and the block must not replace them.
  const known = {
    ...base(input, tool),
    // A backfilled line keeps the run's version and says which version wrote it.
    ...(record.reconciled_by ? { guidance_version: record.guidance_version, reconciled_by: record.reconciled_by } : {}),
    ...(reviewId ? { review_id: reviewId } : {}),
    ...(record.turn_id ? { turn_id: record.turn_id } : {}),
    agent_id: record.agent_id || null,
    task_id: task.reviewed_task || task.id,
    review_task_id: task.id,
    role: task.role || task.type || record.agent || null,
    pr: task.pr,
    attempt: task.attempt,
    ...milestoneField(milestoneFor(input, task.reviewed_task || task.id, task)),
    reviewer_model: tool === 'codex' && record.resolved_model !== undefined ? record.resolved_model : (record.resolved_model || record.model),
    reviewer_effort: tool === 'codex' && record.resolved_effort !== undefined ? record.resolved_effort : (record.resolved_effort || record.effort),
    requested_model: record.model ?? null,
    requested_effort: record.effort ?? null,
    reviewer_tier: record.tier === undefined ? null : record.tier,
  };
  const row = withReview(known, review);
  if (reviewId) return appendOnce(input, 'reviews.jsonl', 'review_id', row);
  lib.appendJsonl(input, 'reviews.jsonl', row);
  return true;
}

// The last delegations.jsonl record for which predicate(record) is true, or
// null (missing file, corrupt line, no match).
function findDelegation(input, predicate) {
  // readJsonl skips a torn or corrupt line, so one bad line can't hide the
  // records written before it.
  const rows = readJsonl(path.join(lib.logPath(input), 'delegations.jsonl'));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) return rows[i];
  }
  return null;
}

// A retry keeps the task's attempt-1 `type` and `difficulty`. For a new
// delegation line's task card, compare with the first earlier delegation of the
// same task id (followup lines are scope additions and are not compared, nor
// compared against). Returns { type: {from, to}, difficulty: {from, to} } with
// only the fields that changed, or null.
function cardDrift(input, task, kind) {
  if (kind === 'followup' || !task || !task.id) return null;
  let first = null;
  try {
    for (const line of fs.readFileSync(path.join(lib.logDir(input), 'delegations.jsonl'), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec && rec.kind !== 'followup' && rec.task && rec.task.id === task.id && (rec.task.type || rec.task.difficulty)) { first = rec.task; break; }
    }
  } catch { /* no delegations yet */ }
  if (!first) return null;
  const drift = {};
  for (const f of ['type', 'difficulty']) {
    if (first[f] && task[f] && first[f] !== task[f]) drift[f] = { from: first[f], to: task[f] };
  }
  return Object.keys(drift).length ? drift : null;
}

const driftMessage = (id, drift) => `agent-team: task ${id} changed ${Object.entries(drift).map(([f, d]) => `${f} ${d.from} -> ${d.to}`).join(' and ')} since its first delegation. ` +
  'A retry keeps the attempt-1 type and difficulty; record new scope as kind "followup" or a new task id.';

// Ask the forge what happened to the request instead of guessing from command
// output: the Director often chains a merge with other commands whose output
// mentions "error" or "failed". Returns forge.requestInfo's normalized shape,
// or null if gh/glab can't answer.
function prState(input, { forge: which = 'github', target, repo }) {
  return forge.requestInfo(which, { target, repo }, input.cwd || lib.projectDir(input), 7000);
}

function mergeOutcome(state) {
  if (!state) return 'unknown';
  if (state.state === 'MERGED') return 'merged';
  if (state.state === 'OPEN' && state.autoMerge) return 'auto-merge-queued';
  return 'not-merged';
}

// "milestone/<name>" base branch -> "<name>"; any other base has no milestone.
function milestoneOfBase(state) {
  const m = state && typeof state.base === 'string' && state.base.match(/^milestone\/(.+)$/);
  return m ? m[1] : undefined;
}

// A shell command fit for a shared log: leading directory changes (`cd x;`,
// `cd x &&`, Set-Location, pushd) are dropped, and any absolute local path
// left (C:\..., /Users/..., /home/..., ~/...) becomes <path>. Archives can then
// be shared without local paths or usernames.
const LEADING_CD = /^\s*(?:cd|chdir|pushd|set-location|sl)\b(?:[^;&|\n"']|"[^"]*"|'[^']*')*(?:;|&&|\n)\s*/i;
const PATH_START = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|/)`;
const ABS_PATH = new RegExp(
  String.raw`"${PATH_START}[^"]*"|'${PATH_START}[^']*'|(?<=^|[\s=])${PATH_START}[^\s"';&|]*`, 'g');
function sanitizeCommand(cmd) {
  let out = String(cmd || '');
  for (let prev = null; prev !== out;) { prev = out; out = out.replace(LEADING_CD, ''); }
  return out.replace(ABS_PATH, '<path>');
}

// A boolean flag the way gh and glab (both pflag) read it: `--x`, or `--x=<v>`
// where 0/f/false (any case) is off and anything else on; the last one wins.
const PFLAG_FALSE = /^(?:0|f|false)$/i;
function boolFlag(args, name) {
  let on = false;
  for (const a of args || []) {
    if (a === name) on = true;
    else if (a.startsWith(`${name}=`)) on = !PFLAG_FALSE.test(a.slice(name.length + 1));
  }
  return on;
}

// Flags of an auto-merge command: gh --auto; glab --auto-merge or
// --when-pipeline-succeeds (each also as `=true`, not `=false`).
function isAutoMerge(m) {
  return m.forge === 'gitlab'
    ? boolFlag(m.args, '--auto-merge') || boolFlag(m.args, '--when-pipeline-succeeds')
    : boolFlag(m.args, '--auto');
}

// The commit the merge is pinned to: gh --match-head-commit, glab --sha.
function matchHead(m) {
  const flag = m.forge === 'gitlab' ? '--sha' : '--match-head-commit';
  const args = m.args || [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1] || null;
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1) || null;
  }
  return null;
}

// Split a command on its top-level joiners (&&, ||, ;, |, newline), outside
// quotes. Each piece keeps the joiner that preceded it. A PowerShell guard
// (`if ($LASTEXITCODE -eq 0) {`) is stripped from the piece it opens and counts as '&&'.
function joinedPieces(cmd) {
  const pieces = [];
  let cur = '', joiner = null, quote = null;
  const push = (next) => { pieces.push({ text: cur, joiner }); cur = ''; joiner = next; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '&' && cmd[i + 1] === '&') { push('&&'); i++; continue; }
    if (c === '|' && cmd[i + 1] === '|') { push('||'); i++; continue; }
    if (c === '|') { push('|'); continue; }
    if (c === ';' || c === '\n') { push(';'); continue; }
    cur += c;
  }
  push(null);
  return pieces.map((pc) => {
    const guard = /^\s*\}?\s*if\s*\(\s*\$LASTEXITCODE\s+-eq\s+0\s*\)\s*\{\s*/i.exec(pc.text);
    const text = pc.text.replace(/^\s*\}\s*/, '');
    return guard ? { text: pc.text.slice(guard[0].length), joiner: '&&' } : { text, joiner: pc.joiner };
  }).filter((pc) => pc.text.trim());
}

// 'ci-wait' | 'ci-wait-queue' | 'gh-checks' when the piece's own command is a
// CI gate, else null: node <...ci-wait.js> (or ci-wait itself) or gh pr checks,
// not a word in an argument (`cat scripts/ci-wait.js`). 'ci-wait-queue' is
// `ci-wait.js --queue-check`: it gates an auto-merge queue call, and its exit 0
// does not mean CI is green (pending passes), so it never gates a direct merge.
function gateOf(text) {
  const seg = lib.segments(text)[0];
  if (!seg) return null;
  const isNode = /^(?:.*[/\x5c])?node(?:\.exe)?$/i.test(seg[0]);
  const ciWait = /(?:^|[/\x5c])ci-wait(?:\.js)?$/;
  // `ci-wait.js --names` only lists check names; it checks nothing, so it is never a gate.
  if (((isNode && seg[1] && ciWait.test(seg[1])) || ciWait.test(seg[0])) && !seg.includes('--names')) {
    return seg.includes('--queue-check') ? 'ci-wait-queue' : 'ci-wait';
  }
  if (/^(?:.*[/\x5c])?gh(?:\.exe)?$/.test(seg[0])) {
    const gh = lib.ghParts(seg);
    if (gh && gh[0] === 'pr' && gh[1] === 'checks') return 'gh-checks';
  }
  return null;
}

// Per merge in lib.findMerges order: the CI gate that ran before it in the same
// command and that the merge depends on ('&&' or PowerShell's
// `if ($LASTEXITCODE -eq 0)`; ';' and '||' do not gate), or null.
function mergeGates(cmd) {
  const gates = [];
  let gate = null;
  for (const pc of joinedPieces(cmd)) {
    if (pc.joiner !== '&&') gate = null;
    const own = gateOf(pc.text);
    const n = lib.findMerges(pc.text).length;
    for (let i = 0; i < n; i++) gates.push(gate);
    if (own) gate = own;
  }
  // A heredoc or odd quoting can make the pieces disagree with findMerges: then no gate.
  const total = lib.findMerges(cmd).length;
  return gates.length === total ? gates : new Array(total).fill(null);
}

const forgeOf = (r) => r.forge || 'github';
// The unresolved queued lines that still need an answer: the latest queued line
// of each PR (an older one is superseded and resolved without the forge).
function unresolvedQueued(rows) {
  const latest = new Map();
  for (const r of rows) if (r.outcome === 'auto-merge-queued') latest.set(`${forgeOf(r)}:${r.pr}`, r);
  return openQueued(rows).filter((r) => latest.get(`${forgeOf(r)}:${r.pr}`) === r);
}
// The id a resolution of queued line q carries: forge, PR and ts, so two PRs
// queued in the same millisecond are told apart.
const resolutionKey = (q) => `${forgeOf(q)}:${q.pr}:${q.ts}`;
// merges.jsonl rows that queued an auto-merge and that no later line resolves:
// no line has their resolution_id (or, for a line written without one, the
// same forge and PR and `resolves_ts` equal to their ts).
function openQueued(rows) {
  const resolved = new Set();
  for (const r of rows) {
    if (r.resolution_id) resolved.add(r.resolution_id);
    else if (r.resolves_ts) resolved.add(`${forgeOf(r)}:${r.pr}:${r.resolves_ts}`);
  }
  return rows.filter((r) => r.outcome === 'auto-merge-queued' && !resolved.has(resolutionKey(r)));
}

// Does the head the forge reports match the pinned one? The pin may be a
// prefix; with either side unknown there is nothing to compare.
const sameHead = (pinned, head) => !pinned || !head || String(head).toLowerCase().startsWith(String(pinned).toLowerCase());

// CI state of a requestStatus result as text: "CI red (build, unit)", "CI pending".
function ciText(st) {
  const { ci, failing } = ciOf(st);
  return ci === 'red' ? `CI red${failing.length ? ` (${failing.join(', ')})` : ''}` : `CI ${ci === 'none' ? 'has no checks' : ci}`;
}

// What happened to queued line q, from a requestStatus(..., { resolution: true })
// result of its request: { fields, text, warn } for the resolution line, or
// null while auto-merge is still on. warn: a merge at another head than the
// reviewed match_head (decision 0012, risk B2).
function resolutionOf(q, st, label) {
  const outcome_source = forge.viewCommand(forgeOf(q));
  if (st.state === 'MERGED') {
    if (!sameHead(q.match_head, st.head_sha)) {
      return {
        fields: { outcome: 'merged', merged_at: st.merged_at, outcome_source, head_moved: true, merged_head: st.head_sha },
        text: `WARNING: ${label} merged at ${st.head_sha}, not the reviewed ${q.match_head}: check it`,
        warn: true,
      };
    }
    return { fields: { outcome: 'merged', merged_at: st.merged_at, outcome_source }, text: `${label}: merged${st.merged_at ? ` at ${st.merged_at}` : ''}` };
  }
  if (st.state === 'CLOSED') return { fields: { outcome: 'closed', merged_at: null, outcome_source }, text: `${label}: closed without merging` };
  if (!st.auto_merge) return { fields: { outcome: 'auto-merge-cancelled', merged_at: null, outcome_source }, text: `${label}: auto-merge was cancelled; ${ciText(st)}` };
  return null;
}

// glab has no flag to cancel "merge when pipeline succeeds": it is an API call.
// -> [{ forge, target, repo }] for each POST `glab api ... merge_requests/<n>/cancel_merge_when_pipeline_succeeds`.
// repo: the project path when the endpoint names one, null for `:id` (the current repo).
function glabCancels(cmd) {
  const out = [];
  for (const seg of lib.allSegments(cmd)) {
    const gl = lib.glabParts(seg);
    if (!gl || gl[0] !== 'api') continue;
    const post = gl.some((t, i) => /^(?:-X|--method)$/i.test(t) && /^POST$/i.test(gl[i + 1] || '')) ||
      gl.some((t) => /^(?:-X|--method=)POST$/i.test(t));
    if (!post) continue;
    for (const t of gl) {
      const m = /merge_requests\/(\d+)\/cancel_merge_when_pipeline_succeeds/.exec(t);
      if (!m) continue;
      const p = /(?:^|\/)projects\/([^/?\s]+)\/merge_requests\//.exec(t);
      let repo = p && !/^[:{]/.test(p[1]) ? p[1] : null;
      if (repo) { try { repo = decodeURIComponent(repo); } catch { /* keep as is */ } }
      out.push({ forge: 'gitlab', target: m[1], repo });
    }
  }
  return out;
}

// Log every merge in a shell command to merges.jsonl, asking the forge what
// happened. Returns the text for the Director (warnings), or undefined; the
// same text also goes to stderr.
function logMerges(input, tool = 'claude') {
  const cmd = (input.tool_input && input.tool_input.command) || '';
  // Cheap pre-check only; flags may sit between the words (`glab mr -R g/p merge`).
  if (!/\b(?:gh|glab)(?:\.exe)?\b[\s\S]*(?:\b(?:merge|accept)\b|cancel_merge_when_pipeline_succeeds)/.test(cmd)) return undefined;
  const chained = lib.segments(cmd).length > 1;
  const gates = mergeGates(cmd);
  const cwd = input.cwd || lib.projectDir(input);
  const warnings = [];
  const mergesFile = () => path.join(lib.logDir(input), 'merges.jsonl');
  const mineOf = (which, pr) => (r) => forgeOf(r) === which && String(r.pr) === String(pr);

  // A cancel of a queued auto-merge (`gh pr merge --disable-auto`, glab's
  // cancel_merge_when_pipeline_succeeds call). The command may have failed, so
  // ask the forge before writing anything: only a request that is open with
  // auto-merge off is logged as cancelled. A merged or closed one gets that
  // resolution instead; one still queued, or a forge that can't answer, leaves
  // the queued line open and warns (a push now could be auto-merged unreviewed).
  const cancelled = (m, target) => {
    const which = m.forge;
    const st = forge.requestStatus(which, target, cwd, 7000, undefined, { resolution: true, repo: m.repo || null });
    const pr = st.ok && st.number != null ? st.number : target;
    const noun = forge.noun(which);
    const label = `${noun} ${pr == null ? '(current branch)' : pr}`;
    const what = which === 'gitlab' ? 'the glab cancel_merge_when_pipeline_succeeds call' : '`gh pr merge --disable-auto`';
    const check = which === 'gitlab'
      ? `glab mr view ${pr == null ? '' : `${pr} `}--output json (merge_when_pipeline_succeeds)`
      : `gh pr view ${pr == null ? '' : `${pr} `}--json autoMergeRequest`;
    const known = st.ok && ['OPEN', 'MERGED', 'CLOSED'].includes(st.state);
    if (!known || (st.state === 'OPEN' && st.auto_merge)) {
      const why = !st.ok ? `${forge.viewCommand(which)} couldn't answer (${st.error})`
        : !known ? `${forge.viewCommand(which)} reported state ${st.state}`
          : `${forge.viewCommand(which)} says auto-merge is still on`;
      warnings.push(`agent-team: WARNING: auto-merge may still be on for ${label}. ${what} ran, but ${why}. ` +
        `Do not push to this ${noun} until \`${check}\` shows auto-merge off; the queued line in merges.jsonl stays open.`);
      return;
    }
    const rows = readJsonl(mergesFile());
    const mine = mineOf(which, pr);
    const open = openQueued(rows).filter(mine);
    // The latest open queued line; failing that the latest queued line, so a
    // reconcile that already resolved it makes this cancellation a no-op (same id).
    const all = rows.filter((r) => r.outcome === 'auto-merge-queued' && mine(r));
    const q = open.length ? open[open.length - 1] : (all.length ? all[all.length - 1] : null);
    const common = {
      ...base(input, tool),
      command: sanitizeCommand(cmd).slice(0, 300),
      pr: pr == null ? null : String(pr),
      ...milestoneField((q && q.milestone) || milestoneOfBase(st)),
    };
    const tail = {
      resolves_ts: q ? q.ts : null,
      ...(q ? { resolution_id: resolutionKey(q) } : {}),
      ...(which === 'gitlab' ? { forge: 'gitlab' } : {}),
      chained,
    };
    if (st.state === 'OPEN') {
      const rec = { ...common, outcome: 'auto-merge-cancelled', cancelled_by: 'director', outcome_source: forge.viewCommand(which), ...tail };
      // Same id as reconcile's resolution of this queued line, written under the
      // same lock: whichever writer comes second adds nothing.
      if (q) appendOnce(input, 'merges.jsonl', 'resolution_id', rec);
      else lib.appendJsonl(input, 'merges.jsonl', rec);
      return;
    }
    // Merged or closed before the cancel: nothing was queued to cancel. Resolve
    // the queued line with what happened; with no queued line there is nothing
    // to write (the merge itself was logged when it ran).
    if (!q) return;
    const res = resolutionOf(q, st, label);
    appendOnce(input, 'merges.jsonl', 'resolution_id', { ...common, ...res.fields, note: 'checked after a cancel', ...tail });
    if (res.warn) warnings.push(`agent-team: ${res.text}`);
  };

  // Only real `gh pr merge` / `glab mr merge` segments count, not the words
  // inside a quoted string.
  lib.findMerges(cmd).forEach((m, i) => {
    // `gh pr merge N --disable-auto` cancels a queued merge; it is not a merge.
    if (m.forge === 'github' && boolFlag(m.args, '--disable-auto')) return cancelled(m, m.target);
    const state = prState(input, m);
    const auto = isAutoMerge(m);
    const outcome = mergeOutcome(state);
    const pr = state && state.number != null ? String(state.number) : m.target;
    let head = auto ? matchHead(m) : null;
    let carried = null;
    // A plain merge attempt on a PR whose auto-merge is still queued logs the
    // queue again. Keep the reviewed head the queue is pinned to, so this line
    // superseding the queued one doesn't lose reconcile's head-moved check.
    if (!auto && outcome === 'auto-merge-queued') {
      const pinned = openQueued(readJsonl(mergesFile())).filter((r) => mineOf(m.forge, pr)(r) && r.match_head);
      if (pinned.length) { head = pinned[pinned.length - 1].match_head; carried = pinned[pinned.length - 1].ts; }
    }
    // --queue-check passes on pending CI: it gates a queue call, never a direct merge.
    let gate = gates[i];
    let ignored = null;
    if (gate === 'ci-wait-queue' && !auto) {
      ignored = gate;
      gate = null;
      if (outcome === 'merged') {
        warnings.push(`agent-team: WARNING: ${forge.noun(m.forge)} ${pr} was merged directly after \`ci-wait.js --queue-check\`, which passes on pending CI; it is not a green gate. ` +
          'Check its CI now. Gate a direct merge with `ci-wait.js <n> --once --sha <head_sha>`.');
      }
    }
    lib.appendJsonl(input, 'merges.jsonl', {
      ...base(input, tool),
      command: sanitizeCommand(cmd).slice(0, 300),
      pr,
      ...milestoneField(milestoneOfBase(state)),
      outcome,
      outcome_source: state ? forge.viewCommand(m.forge) : 'none',
      ...(m.forge === 'gitlab' ? { forge: 'gitlab' } : {}),
      ...(auto ? { auto: true } : {}),
      ...(head ? { match_head: head } : {}),
      ...(carried ? { match_head_from_ts: carried } : {}),
      ...(gate ? { gate } : {}),
      ...(ignored ? { gate_ignored: ignored } : {}),
      chained,
    });
  });
  for (const c of glabCancels(cmd)) cancelled(c, c.target);
  if (!warnings.length) return undefined;
  const text = warnings.join('\n');
  process.stderr.write(`${text}\n`);
  return text;
}

// ---------------------------------------------------------------------------
// Resolving queued auto-merges. An `auto-merge-queued` line in merges.jsonl says
// only that the merge was queued. resolveQueuedMerges appends a line saying what
// happened afterwards; the queued line is never rewritten.
// ---------------------------------------------------------------------------

const MAX_RESOLVE_PRS = 50;

// CI state of a requestStatus result: { ci: 'pending'|'green'|'red'|'none'|'unknown', failing: [names] }.
function ciOf(status) {
  if (status.pipeline) return { ci: forge.gitlabPipelineCi(status.pipeline.status).ci, failing: [] };
  if (!status.checks.length) return { ci: 'none', failing: [] };
  const failing = status.checks.filter((c) => c.state === 'fail').map((c) => c.name);
  if (failing.length) return { ci: 'red', failing };
  return { ci: status.checks.some((c) => c.state === 'pending') ? 'pending' : 'green', failing: [] };
}

// Appends a resolution line for each `auto-merge-queued` line whose outcome is
// now known. Returns { lines: [string], resolved, skipped, calls, file, exists,
// total, open }: file is merges.jsonl's path, exists whether it is there, total
// its line count and open the number of PRs with an unresolved queued line. At
// most one forge call per PR whose latest queued line is unresolved, at most
// `limit` PRs per run, oldest first. `run` stands in for the gh/glab runner (tests).
function resolveQueuedMerges(input, { dryRun = false, run, limit = MAX_RESOLVE_PRS } = {}) {
  const file = path.join(lib.logPath(input), 'merges.jsonl');
  const rows = readJsonl(file);
  const out = { lines: [], resolved: 0, skipped: 0, calls: 0, file, exists: fs.existsSync(file), total: rows.length, open: 0 };
  const cwd = input.cwd || lib.projectDir(input);
  const version = lib.guidanceVersion();
  const append = (q, fields) => {
    const rec = {
      ts: new Date().toISOString(),
      tool: q.tool || 'claude',
      guidance_version: q.guidance_version || version,
      reconciled_by: version,
      pr: q.pr,
      ...milestoneField(q.milestone),
      ...(forgeOf(q) === 'gitlab' ? { forge: 'gitlab' } : {}),
      ...fields,
      resolves_ts: q.ts,
      resolution_id: resolutionKey(q),
    };
    return dryRun ? true : appendOnce(input, 'merges.jsonl', 'resolution_id', rec);
  };

  // Group by PR, oldest group first: the PR's latest queued line (resolved or
  // not) and its older unresolved ones. An older unresolved line is superseded.
  const latest = new Map();
  for (const r of rows) if (r.outcome === 'auto-merge-queued') latest.set(`${forgeOf(r)}:${r.pr}`, r);
  const groups = new Map();
  for (const q of openQueued(rows)) {
    const key = `${forgeOf(q)}:${q.pr}`;
    if (!groups.has(key)) groups.set(key, { old: [], last: null });
    if (latest.get(key) === q) groups.get(key).last = q; else groups.get(key).old.push(q);
  }
  out.open = groups.size;
  let budget = limit;
  for (const { old, last: q } of groups.values()) {
    const first = q || old[0];
    const label = `${forge.noun(forgeOf(first))} ${first.pr}`;
    // Older queued lines of a PR that has a newer one: superseded, no forge call.
    for (const o of old) {
      if (append(o, { outcome: 'auto-merge-cancelled', merged_at: null, outcome_source: 'none', note: 'superseded' })) out.resolved++;
      out.lines.push(`${label}: earlier queued line (${o.ts}) superseded by a newer one`);
    }
    if (!q) continue;
    const cli = forgeOf(q);
    // A plain merge of the same PR after the queue: it is already logged as a
    // merge line, so this resolution carries superseded_by_ts and is not counted again.
    const direct = rows.find((r) => r.ts > q.ts && r.outcome === 'merged' && !r.resolves_ts && forgeOf(r) === cli && String(r.pr) === String(q.pr));
    if (direct) {
      if (append(q, { outcome: 'merged', merged_at: null, outcome_source: 'none', note: 'merged directly', superseded_by_ts: direct.ts })) out.resolved++;
      out.lines.push(`${label}: merged directly (line ${direct.ts})`);
      continue;
    }
    if (budget <= 0) { out.skipped++; continue; }
    budget--;
    out.calls++;
    const st = forge.requestStatus(cli, q.pr, cwd, 20000, run, { resolution: true });
    if (!st.ok || !['OPEN', 'MERGED', 'CLOSED'].includes(st.state)) {
      out.lines.push(`${label}: unknown (${cli === 'gitlab' ? 'glab' : 'gh'} couldn't answer)`);
      continue;
    }
    // Merged (at the reviewed head or not), closed, or auto-merge off. The
    // cancelled line also gives the CI state, so a red PR can be sent back
    // without another CI turn.
    const res = resolutionOf(q, st, label);
    if (res) {
      if (append(q, res.fields)) out.resolved++;
      out.lines.push(res.text);
    } else {
      const moved = !sameHead(q.match_head, st.head_sha);
      out.lines.push(`${label}: still queued, ${ciText(st)}${moved ? '; head moved since queued: disable auto-merge now' : ''}`);
    }
  }
  if (out.skipped) out.lines.push(`${out.skipped} more PR(s) skipped (limit ${limit} per run); run again`);
  return out;
}

// Why an attempt after the first exists. A followup is not an attempt (kind=followup).
const ATTEMPT_REASONS = ['sendback', 'escalation', 'fold-in', 'retry'];
const known = (v) => v != null && v !== '' && !['inherited', 'unknown', 'default'].includes(String(v));

// Compare a task card's requested tier= and effort= with the settings that run:
// the spawn's own for a new agent, the original agent's for a resume (a resume
// can't change them). Also checks reason=. Returns { fields, messages }: fields
// (tier_mismatch / effort_mismatch: {card, ran}) go on the delegation line,
// messages go to the Director.
function cardSettings(task, ran, kind) {
  const fields = {};
  const messages = [];
  if (!task || typeof task !== 'object') return { fields, messages };
  const resumed = kind === 'resume' || kind === 'followup';
  for (const f of ['tier', 'effort']) {
    if (!task[f] || !known(ran[f]) || String(task[f]) === String(ran[f])) continue;
    fields[`${f}_mismatch`] = { card: task[f], ran: ran[f] };
    messages.push(resumed
      ? `agent-team: task ${task.id || '?'} card says ${f} ${task[f]} but a resume keeps the agent's ${f} ${ran[f]}. To change tier or effort, spawn a new agent.`
      : `agent-team: task card says ${f} ${task[f]} but the spawn ran ${f} ${ran[f]}`);
  }
  if (task.reason && !ATTEMPT_REASONS.includes(task.reason)) {
    messages.push(`agent-team: task ${task.id || '?'} has reason=${task.reason}; use one of ${ATTEMPT_REASONS.join(', ')}.`);
  }
  if (task.reason === 'escalation' && kind === 'resume' && !fields.tier_mismatch && !fields.effort_mismatch) {
    messages.push(`agent-team: task ${task.id || '?'} is an escalation sent as a resume, which keeps the original model and effort. Spawn a new agent with the new settings, and put them on the card (tier=, effort=).`);
  }
  return { fields, messages };
}

// A role-agent delegation without a TASK line is logged without task fields,
// and the Coach can't use it.
const UNCARDED_MESSAGE = 'agent-team: this delegation has no TASK line, so it is logged without task fields and the Coach can\'t count it. ' +
  'Start every delegation prompt with a task card, including side work such as plugin fixes (use milestone=none outside a milestone).';

// Close the latest open pause in pauses.jsonl: append a `resume` line with the
// pause's start, duration and what ended it. `reasons` limits which pauses this
// caller may close (null: any). Returns the resume line, or null when there is
// no open pause (or another hook is closing it).
function closeOpenPause(input, closedBy, { reasons = null, note } = {}) {
  // logPath, not logDir: checking for a pause must not create the logs folder
  // (the prompt hook runs this in every project the plugin is enabled for).
  const file = path.join(lib.logPath(input), 'pauses.jsonl');
  if (!fs.existsSync(file)) return null;
  const done = withRecordLock(input, 'pause-close', () => {
    const rows = readJsonl(file);
    const last = rows[rows.length - 1];
    if (!last || last.kind === 'resume' || !last.reason) return null;
    if (reasons && !reasons.includes(last.reason)) return null;
    const now = new Date();
    const started = Date.parse(last.ts);
    const rec = {
      ts: now.toISOString(),
      guidance_version: lib.guidanceVersion(),
      kind: 'resume',
      reason: last.reason,
      paused_ts: last.ts || null,
      duration_ms: Number.isFinite(started) ? Math.max(0, now.getTime() - started) : null,
      closed_by: closedBy,
      ...milestoneField(last.milestone),
      ...(note ? { note } : {}),
    };
    lib.appendJsonl(input, 'pauses.jsonl', rec);
    return rec;
  });
  return done || null;
}

module.exports = {
  base, startFile, takeDuration, claimOnce, prunePending, shortHash, logReview,
  readJsonl, withRecordLock, appendOnce, reviewIdentity, findDelegation, milestoneFor, milestoneOfBase, prState, mergeOutcome, logMerges,
  cardDrift, driftMessage, sanitizeCommand, resolveQueuedMerges, openQueued, unresolvedQueued,
  ATTEMPT_REASONS, cardSettings, UNCARDED_MESSAGE, closeOpenPause,
};
