#!/usr/bin/env node
// Archive the project's .agent-team/logs/*.jsonl to a per-milestone folder outside the repo.
// Usage: node scripts/archive-logs.js <milestone> [--project <name>] [--root <dir>] [--clear] [--force] [--dry-run]
// Dependency-free; works the same from Claude and Codex (no hook input).
// Before the copy it captures usage the hooks missed, read-only on the Claude Code
// transcripts (~/.claude/projects, or AGENT_TEAM_PROJECTS_ROOT): superseding
// completion lines for turns that ran on after the hand-back (reconcile-logs.js,
// supersedeShortTurns), and one `session_usage` line per Director session and model in
// sessions.jsonl. A transcript that is missing or unreadable is counted, never an error.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const lib = require('./lib');
const { readJsonl, unresolvedQueued } = require('./records');
const { spawnSync } = require('child_process');

const STALE_MS = 10 * 60 * 1000;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(msg) {
  console.error(`archive-logs: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const o = { milestone: null, project: null, root: null, clear: false, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clear') o.clear = true;
    else if (a === '--force') o.force = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--project' || a === '--root') {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else if (o.milestone === null) o.milestone = a;
    else fail(`unexpected argument ${a}`);
  }
  return o;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function repoNameFromRemote(url) {
  if (!url) return '';
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = cleaned.match(/[^/:\\]+$/);
  return m ? m[0] : '';
}

function localDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// How many `auto-merge-queued` lines in merges.jsonl still need the forge's
// answer (see records.unresolvedQueued: superseded older lines don't count).
// Offline: reads the file only.
function unresolvedCount(logDir) {
  return unresolvedQueued(readJsonl(path.join(logDir, 'merges.jsonl'))).length;
}

// The Director's transcript: <projects root>/<project folder>/<session id>.jsonl.
// The session id comes from a log line, so only a plain string id is looked up.
// The search covers every project folder, not only this project's: a worktree
// run is stored under its own folder, whose name this script cannot derive.
// So a transcript is used only when `belongs` accepts it: its recorded cwd is
// this project or one of its worktrees (reconcile-logs.belongsTo).
function findSessionTranscript(root, sessionId, belongs) {
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) return null;
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    try { if (fs.statSync(p).isFile() && belongs(p)) return p; } catch { /* not in this project folder */ }
  }
  return null;
}

// One read of a Director transcript: usage per model, each message id counted
// once, from assistant entries only. Nothing of the transcript's text is kept.
// A line that does not parse (a torn last line while the session is running)
// is skipped and counted. Returns null when the file cannot be read or holds
// no readable line at all. Else { bad, models: Map(model -> { calls, classes, first, last }) }.
function readSessionUsage(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const models = new Map();
  const seen = new Set();
  let ok = 0, bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { bad++; continue; }
    if (!e || typeof e !== 'object') { bad++; continue; }
    ok++;
    const m = e.message;
    if (e.type !== 'assistant' || e.isSidechain === true || !m || !m.id || !m.usage || seen.has(m.id)) continue;
    const model = m.model || 'unknown';
    if (model === '<synthetic>') continue; // not an API call
    seen.add(m.id);
    let u = models.get(model);
    if (!u) models.set(model, u = { calls: 0, classes: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, first: null, last: null });
    u.calls++;
    u.classes.input += m.usage.input_tokens || 0;
    u.classes.output += m.usage.output_tokens || 0;
    u.classes.cache_read += m.usage.cache_read_input_tokens || 0;
    u.classes.cache_write += m.usage.cache_creation_input_tokens || 0;
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (!Number.isNaN(at)) {
      if (u.first === null || at < Date.parse(u.first)) u.first = e.timestamp;
      if (u.last === null || at > Date.parse(u.last)) u.last = e.timestamp;
    }
  }
  return ok ? { bad, models } : null;
}

const sameUsage = (a, b) => a && a.calls === b.calls && ['input', 'output', 'cache_read', 'cache_write']
  .every((k) => ((a.tokens_by_class || {})[k] || 0) === b.classes[k]);

// G19: one `session_usage` line per Director session and model, for each
// session id on the milestone's delegation lines, appended to sessions.jsonl.
// A line is written only when the totals differ from the last line for that
// session and model, so a rerun adds nothing; readers take the last line.
// Codex sessions are counted and skipped. A transcript that is missing or
// unreadable is counted and never stops the others. Nothing is written with
// dryRun. Each transcript is read once.
function recordSessionUsage({ logDir, milestone, root, dryRun, version, belongs }) {
  if (!belongs) { const rc = require('./reconcile-logs'); belongs = rc.belongsTo(rc.projectOfLogs(logDir)); }
  const out = { sessions: 0, notFound: 0, codex: 0, written: 0, bad: 0, errors: [] };
  const claude = new Set();
  const codex = new Set();
  for (const d of readJsonl(path.join(logDir, 'delegations.jsonl'))) {
    if (!d.session_id || !d.task || d.task.milestone !== milestone) continue;
    (!d.tool || d.tool === 'claude' ? claude : codex).add(String(d.session_id));
  }
  for (const s of claude) codex.delete(s);
  out.codex = codex.size;
  const file = path.join(logDir, 'sessions.jsonl');
  const last = new Map(); // `${session}|${model}` -> last session_usage line
  for (const r of readJsonl(file)) if (r.kind === 'session_usage') last.set(`${r.session_id}|${r.model}`, r);
  for (const sessionId of [...claude].sort()) {
    out.sessions++;
    const tPath = findSessionTranscript(root, sessionId, belongs);
    const usage = tPath && readSessionUsage(tPath);
    if (!usage) { out.notFound++; continue; }
    out.bad += usage.bad;
    for (const [model, u] of [...usage.models].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (sameUsage(last.get(`${sessionId}|${model}`), u)) continue;
      out.written++;
      if (dryRun) continue;
      const record = {
        ts: new Date().toISOString(), guidance_version: version, kind: 'session_usage', tool: 'claude',
        session_id: sessionId, milestone, model, calls: u.calls, tokens_by_class: { ...u.classes }, first: u.first, last: u.last,
      };
      try { lib.safeAppend(file, JSON.stringify(record) + '\n'); } catch (err) {
        out.written--;
        out.errors.push(`could not append to sessions.jsonl: ${err && err.message || err}`);
      }
    }
  }
  return out;
}

// The two steps that capture usage the hooks missed. They run before the copy,
// so the archive holds their lines. Neither can fail the archive: an error is
// printed and the archive goes on.
function captureUsage({ logDir, milestone, dryRun }) {
  const pre = dryRun ? '[dry-run] ' : '';
  let reconcile, version = 'unknown', root;
  try {
    reconcile = require('./reconcile-logs');
    version = lib.guidanceVersion();
    root = reconcile.projectsRoot();
  } catch (err) {
    console.log(`${pre}usage not captured: ${err && err.message || err}`);
    return;
  }
  try {
    const c = reconcile.supersedeShortTurns({ logDir, root, dryRun });
    console.log(`${pre}completions: ${c.superseded} ${dryRun ? 'would be ' : ''}superseded with the full turn's tokens, ${c.notFound} transcripts not found` +
      (c.codex ? `, ${c.codex} Codex agents skipped` : ''));
    for (const e of c.errors) console.log(`${pre}completions: ${e}`);
  } catch (err) {
    console.log(`${pre}completions: not reconciled: ${err && err.message || err}`);
  }
  try {
    const s = recordSessionUsage({ logDir, milestone, root, dryRun, version });
    console.log(`${pre}usage: ${s.sessions} sessions, ${s.notFound} not found` +
      (s.codex ? `, ${s.codex} Codex sessions skipped` : '') +
      `; ${s.written} session_usage line${s.written === 1 ? '' : 's'} ${dryRun ? 'would be written' : 'written'}` +
      (s.bad ? `; ${s.bad} unreadable transcript line${s.bad === 1 ? '' : 's'} skipped` : ''));
    for (const e of s.errors) console.log(`${pre}usage: ${e}`);
  } catch (err) {
    console.log(`${pre}usage: not captured: ${err && err.message || err}`);
  }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.milestone) fail('usage: archive-logs.js <milestone> [--project <name>] [--root <dir>] [--clear] [--force] [--dry-run]');
  if (!SLUG.test(o.milestone)) {
    fail(`milestone "${o.milestone}" must be a slug (letters, digits, ".", "_", "-"; no "/" or spaces)`);
  }

  const top = git(['rev-parse', '--show-toplevel'], process.cwd());
  const projectDir = top || process.cwd();
  const project = o.project || repoNameFromRemote(git(['remote', 'get-url', 'origin'], projectDir)) || path.basename(projectDir);
  if (!SLUG.test(project)) fail(`project name "${project}" is not a safe folder name`);

  const root = path.resolve(o.root || process.env.AGENT_TEAM_ARCHIVE || path.join(os.homedir(), '.agent-team', 'archive'));
  const date = localDate();
  const dest = path.join(root, project, `${date}-${o.milestone}`);

  // Run from a git worktree, archive the main checkout's logs: that is where
  // every session and agent of the project writes (lib.logRoot).
  // A linked .agent-team or logs folder fails the run: --clear would delete
  // files in the folder it points at (lib.safeListDir refuses it).
  const logDir = path.join(lib.mainCheckout(projectDir) || projectDir, '.agent-team', 'logs');
  const listLogs = () => {
    let entries;
    try { entries = lib.safeListDir(logDir, { withFileTypes: true }); } catch (err) { fail(err.message); }
    if (!entries) fail('no .agent-team/logs folder found');
    return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name).sort();
  };
  if (!listLogs().length) fail('no .jsonl files in .agent-team/logs');

  if (fs.existsSync(dest) && !o.force) fail(`destination already exists (use --force to overwrite): ${dest}`);

  // Usage the hooks missed (turns after the hand-back, the Director's own
  // tokens) goes into the logs first, so the copy below holds it.
  captureUsage({ logDir, milestone: o.milestone, dryRun: o.dryRun });
  const files = listLogs();

  // Counted before anything is cleared. Archiving stays offline; resolving is reconcile-logs.js's job.
  const unresolved = unresolvedCount(logDir);
  const unresolvedNote = unresolved ? `${unresolved} auto-merge-queued merges unresolved; run reconcile-logs.js --merges first` : '';

  // A linked .pending is not listed, so nothing in the folder it points at is
  // deleted; the run goes on and says so.
  const pendingDir = path.join(logDir, '.pending');
  const now = Date.now();
  let pendingEntries = null;
  try { pendingEntries = lib.safeListDir(pendingDir, { withFileTypes: true }); } catch (err) {
    console.log(`.pending: not pruned (${err.message})`);
  }
  const entry = (dir) => (e) => {
    const p = path.join(dir, e.name);
    return { p, stale: now - fs.lstatSync(p).mtimeMs > STALE_MS };
  };
  const pending = (pendingEntries || []).filter((e) => e.isFile() && !e.name.startsWith('.')).map(entry(pendingDir)); // skip dotfiles (.gitkeep)
  // Temp files a crashed write left (lib.TEMP_FILE): in .pending/codex-completions
  // and in the logs folder. Same age rule; snapshots and logs themselves stay.
  const temps = (dir) => {
    let list = null;
    try { list = lib.safeListDir(dir, { withFileTypes: true }); } catch (err) { console.log(`.pending: not pruned (${err.message})`); }
    return (list || []).filter((e) => e.isFile() && lib.TEMP_FILE.test(e.name)).map(entry(dir));
  };
  if (pendingEntries) {
    for (const sub of ['codex-completions']) {
      pending.push(...temps(path.join(pendingDir, sub)));
    }
  }
  pending.push(...temps(logDir));
  const stale = pending.filter((x) => x.stale);

  if (o.dryRun) {
    console.log(`[dry-run] would copy ${files.length} file(s) to ${dest}`);
    for (const f of files) console.log(`  ${f}`);
    console.log(`[dry-run] would delete ${stale.length} stale .pending entries (keeping ${pending.length - stale.length} fresh)`);
    if (o.clear) console.log('[dry-run] would delete the live logs after verification');
    if (unresolvedNote) console.log(unresolvedNote);
    console.log(dest);
    return;
  }

  // Build the archive in a temp sibling folder and verify it there. A failure removes only the
  // temp folder; an existing archive is never deleted (--force overwrites just the files we write).
  const tmpDest = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmpDest, { recursive: true, force: true }); // leftover from a crashed run with a reused pid
  fs.mkdirSync(tmpDest, { recursive: true });

  const versions = new Set();
  const rows = [];
  const verified = new Map(); // file name -> sha256 at verification time
  try {
    for (const f of files) {
      const src = path.join(logDir, f);
      const dst = path.join(tmpDest, f);
      fs.copyFileSync(src, dst);
      const srcHash = sha256(src);
      // Test hook: AGENT_TEAM_ARCHIVE_TEST_FAIL_VERIFY=1 (set only by tests/archive-logs.test.js)
      // makes verification fail after the copy, so the cleanup path can be tested deterministically.
      const hooked = process.env.AGENT_TEAM_ARCHIVE_TEST_FAIL_VERIFY === '1';
      if (hooked || fs.statSync(src).size !== fs.statSync(dst).size || srcHash !== sha256(dst)) {
        throw new Error(`verification failed for ${f}`);
      }
      verified.set(f, srcHash);
      let lines = 0, inMilestone = 0, malformed = 0;
      for (const line of fs.readFileSync(dst, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        lines++;
        try {
          const rec = JSON.parse(line);
          if (rec && rec.guidance_version) versions.add(String(rec.guidance_version));
          // Delegation and completion lines carry it on the task card; review,
          // merge, note and pause lines carry a top-level `milestone`.
          if (rec && ((rec.task && rec.task.milestone === o.milestone) || rec.milestone === o.milestone)) inMilestone++;
        } catch { malformed++; }
      }
      rows.push({ f, lines, inMilestone, malformed });
    }

    const readme = [
      `# agent-team logs — milestone ${o.milestone} (${date})`,
      '',
      `Project: ${project}`,
      `guidance_version seen: ${versions.size ? [...versions].sort().join(', ') : 'none'}`,
      '',
      ...rows.map((r) => `- \`${r.f}\`: ${r.lines} line(s), ${r.inMilestone} for milestone \`${o.milestone}\`` +
        (r.malformed ? `, ${r.malformed} malformed` : '')),
      '',
      `Copied from the project's \`.agent-team/logs/\`. ${o.clear ? 'Originals cleared after the copy was verified.' : 'Originals left in place.'}`,
      '`.pending/` was not copied.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDest, 'README.md'), readme);

    if (!fs.existsSync(dest)) {
      fs.renameSync(tmpDest, dest);
    } else if (o.force) {
      // Overwrite only the files we wrote; anything else already in dest stays.
      for (const name of [...files, 'README.md']) fs.renameSync(path.join(tmpDest, name), path.join(dest, name));
      fs.rmSync(tmpDest, { recursive: true, force: true });
    } else {
      throw new Error(`destination already exists (use --force to overwrite): ${dest}`);
    }
  } catch (err) {
    fs.rmSync(tmpDest, { recursive: true, force: true });
    fail(`${err.message}; temp copy removed, existing archive left untouched`);
  }

  let removed = 0;
  for (const x of stale) {
    try {
      // Listed a moment ago: a name that is a link now, or has a second name, is left alone and said so.
      lib.checkLogFile(x.p);
      fs.unlinkSync(x.p);
      removed++;
    } catch (err) {
      if (err && err.code === lib.REFUSED) console.error(`archive-logs: stale .pending entry not deleted (a link, or a file with another name): ${x.p}`);
      /* anything else: best effort */
    }
  }
  let cleared = 0;
  const skipped = [];
  const linked = [];
  if (o.clear) {
    // Test hooks, set only by tests/archive-logs.test.js: AGENT_TEAM_ARCHIVE_TEST_APPEND_AFTER_VERIFY=<file>
    // appends to that live log after verification; AGENT_TEAM_ARCHIVE_TEST_UNLINK_FAIL=1 makes the delete throw.
    const appendTo = process.env.AGENT_TEAM_ARCHIVE_TEST_APPEND_AFTER_VERIFY;
    if (appendTo) lib.safeAppend(path.join(logDir, appendTo), 'late write\n');
    // AGENT_TEAM_ARCHIVE_TEST_LINK_AFTER_VERIFY=<file> gives that log a second name after verification (same content).
    const linkIt = process.env.AGENT_TEAM_ARCHIVE_TEST_LINK_AFTER_VERIFY;
    if (linkIt && (path.basename(linkIt) !== linkIt || linkIt === '.' || linkIt === '..')) fail('AGENT_TEAM_ARCHIVE_TEST_LINK_AFTER_VERIFY must be a plain file name');
    if (linkIt) fs.linkSync(path.join(logDir, linkIt), path.join(logDir, `${linkIt}.second-name`));
    for (const f of files) {
      const src = path.join(logDir, f);
      let unchanged = false;
      try { unchanged = sha256(src) === verified.get(f); } catch { unchanged = false; }
      if (!unchanged) { skipped.push(f); continue; } // changed or gone since verification: keep it
      // The name must still be a plain file with one name: a link made since the check is not deleted through.
      try { lib.checkLogFile(src); } catch (err) {
        if (!err || err.code !== lib.REFUSED) throw err;
        linked.push(f);
        continue;
      }
      try {
        if (process.env.AGENT_TEAM_ARCHIVE_TEST_UNLINK_FAIL === '1') throw Object.assign(new Error('test'), { code: 'EPERM' });
        fs.unlinkSync(src);
        cleared++;
      } catch (err) {
        fail(`could not delete ${f}: ${err.code || err.message}; archive is complete at ${dest}`);
      }
    }
  }

  console.log(`Archived ${files.length} file(s).`);
  console.log(`.pending: deleted ${removed} stale, kept ${pending.length - removed}.`);
  if (o.clear) console.log(`Cleared ${cleared} live log file(s).`);
  for (const f of skipped) console.log(`Not cleared (changed since the copy was verified): ${f}`);
  for (const f of linked) console.error(`Not cleared (now a link, or a file with another name): ${f}`);
  if (linked.length) process.exitCode = 1;
  if (unresolvedNote) console.log(unresolvedNote);
  console.log(dest);
}

main();
