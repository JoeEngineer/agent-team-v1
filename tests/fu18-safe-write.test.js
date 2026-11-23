// FU-18: every write under .agent-team/logs/ goes through lib's link-safe helpers.
// A cloned repo can commit links into the logs folder; no write or delete may
// follow one. Junctions stand in for folder symlinks on Windows (they need no
// admin rights); a test that can make neither prints a skip line.
// Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, SCRIPTS, NO_MODELS_FILE, tmpProject, run, test, assert, eq } = require('./helpers');
const lib = require(path.join(SCRIPTS, 'lib.js'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-fu18w-'));
const logsOf = (p) => path.join(p, '.agent-team', 'logs');
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const skip = (why) => console.log(`  skip ${why}`);

// A file symlink, or null when this machine cannot make one (Windows without
// Developer Mode). A folder link: a symlink, else a junction on Windows.
function fileLink(target, at) {
  try { fs.symlinkSync(target, at, 'file'); return 'symlink'; } catch { return null; }
}
function dirLink(target, at) {
  try { fs.symlinkSync(target, at, 'dir'); return 'symlink'; } catch { /* try a junction */ }
  if (process.platform === 'win32') {
    try { fs.symlinkSync(target, at, 'junction'); return 'junction'; } catch { /* neither */ }
  }
  return null;
}

// Runs fn with process.stderr captured; returns { err, stderr }.
function capture(fn) {
  const orig = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  let err = null;
  try { fn(); } catch (e) { err = e; } finally { process.stderr.write = orig; }
  return { err, stderr };
}

// A logs folder of our own, with a victim file outside it.
function fixture() {
  const p = tmpProject();
  const outside = tmp();
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'ORIGINAL\n');
  return { p, logs: logsOf(p), outside, victim };
}

// --- safeAppend -------------------------------------------------------------

test('FU-18 safeAppend: a new file is created and an existing regular file appended (recovery control)', () => {
  const { logs } = fixture();
  const f = path.join(logs, 'completions.jsonl');
  lib.safeAppend(f, 'a\n');
  lib.safeAppend(f, 'b\n');
  eq(fs.readFileSync(f, 'utf8'), 'a\nb\n', 'appended');
  // A missing .agent-team/logs/.pending is created as real folders.
  const deep = path.join(logs, '.pending', 'x', 'y.json');
  lib.safeAppend(deep, '{}');
  assert(fs.lstatSync(path.dirname(deep)).isDirectory(), 'nested folder created');
});

test('FU-18 safeAppend: a symlinked log file is refused; the target is untouched; one stderr line names the path', () => {
  const { logs, victim } = fixture();
  const f = path.join(logs, 'completions.jsonl');
  if (!fileLink(victim, f)) return skip('(file symlinks cannot be made here; the hard-link test covers this check on Windows)');
  assert(fs.lstatSync(f).isSymbolicLink(), 'precondition: the log is a symlink');
  const { err, stderr } = capture(() => lib.safeAppend(f, 'EVIL\n'));
  assert(err && err.code === 'EAGENTTEAMREFUSED', `refused: ${err && err.message}`);
  eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'target untouched');
  eq(stderr.split('\n').filter(Boolean).length, 1, 'one stderr line');
  assert(stderr.includes(f) && stderr.includes('refusing to write'), stderr);
});

test('FU-18 safeAppend: a hard-linked log file (nlink > 1) is refused; the other name is untouched', () => {
  const { logs, victim } = fixture();
  const f = path.join(logs, 'completions.jsonl');
  fs.linkSync(victim, f);
  eq(fs.lstatSync(f).nlink, 2, 'precondition: two names for one file');
  const { err, stderr } = capture(() => lib.safeAppend(f, 'EVIL\n'));
  assert(err && /hard link/.test(err.message), `refused: ${err && err.message}`);
  eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'target untouched');
  assert(stderr.includes(f), stderr);
});

test('FU-18 safeAppend: a path that is a folder (not a regular file) is refused', () => {
  const { logs } = fixture();
  const f = path.join(logs, 'completions.jsonl');
  fs.mkdirSync(f);
  const { err } = capture(() => lib.safeAppend(f, 'x\n'));
  assert(err && /not a regular file/.test(err.message) && err.message.includes(f), `refused: ${err && err.message}`);
});

test('FU-18 safeAppend: a linked logs folder and a linked .agent-team folder are refused; nothing is written in the target', () => {
  for (const which of ['logs', '.agent-team']) {
    const p = tmpProject();
    const outside = tmp();
    const at = which === 'logs' ? logsOf(p) : path.join(p, '.agent-team');
    fs.rmSync(at, { recursive: true, force: true });
    if (which === '.agent-team') fs.mkdirSync(path.join(outside, 'logs'));
    const kind = dirLink(outside, at);
    if (!kind) return skip('(neither folder symlinks nor junctions can be made here)');
    assert(fs.lstatSync(at).isSymbolicLink(), `precondition: ${which} is a ${kind} (lstat sees a link)`);
    const f = path.join(logsOf(p), 'completions.jsonl');
    const { err, stderr } = capture(() => lib.safeAppend(f, 'EVIL\n'));
    assert(err && err.code === 'EAGENTTEAMREFUSED' && err.message.includes(at) && /link or junction/.test(err.message), `${which} refused: ${err && err.message}`);
    assert(stderr.includes(at), stderr);
    const leaked = which === 'logs' ? path.join(outside, 'completions.jsonl') : path.join(outside, 'logs', 'completions.jsonl');
    assert(!fs.existsSync(leaked), `${which}: nothing written through the ${kind}`);
    // safeMkdir refuses the same way, and creates nothing in the target.
    const { err: e2 } = capture(() => lib.safeMkdir(path.join(logsOf(p), '.pending', 'record-locks')));
    assert(e2 && e2.code === 'EAGENTTEAMREFUSED', `${which}: safeMkdir refused`);
    assert(!fs.existsSync(which === 'logs' ? path.join(outside, '.pending') : path.join(outside, 'logs', '.pending')), `${which}: no folder made in the target`);
  }
});

test('FU-18 safeAppend: a hard link swapped in between the check and the open is caught by fstat after the open', () => {
  const { logs, victim } = fixture();
  const f = path.join(logs, 'completions.jsonl');
  fs.writeFileSync(f, ''); // a regular file at check time
  let swapped = false;
  lib.safeWriteHooks.beforeOpen = (file) => {
    if (file !== f) return;
    fs.rmSync(f);
    fs.linkSync(victim, f);
    swapped = true;
  };
  let res;
  try { res = capture(() => lib.safeAppend(f, 'EVIL\n')); } finally { lib.safeWriteHooks.beforeOpen = null; }
  assert(swapped, 'precondition: the swap ran between the lstat and the open');
  assert(res.err && /hard link/.test(res.err.message), `refused after open: ${res.err && res.err.message}`);
  eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'target untouched');
});

test('FU-18 safeAppend: a symlink swapped in between the check and the open is refused by O_NOFOLLOW (POSIX)', () => {
  if (!fs.constants.O_NOFOLLOW) return skip('(no O_NOFOLLOW on this platform; Windows relies on the lstat check)');
  const { logs, victim } = fixture();
  const f = path.join(logs, 'completions.jsonl');
  fs.writeFileSync(f, '');
  let swapped = false;
  lib.safeWriteHooks.beforeOpen = (file) => {
    if (file !== f) return;
    fs.rmSync(f);
    fs.symlinkSync(victim, f);
    swapped = true;
  };
  let res;
  try { res = capture(() => lib.safeAppend(f, 'EVIL\n')); } finally { lib.safeWriteHooks.beforeOpen = null; }
  assert(swapped, 'precondition: the swap ran between the lstat and the open');
  assert(res.err && res.err.code === 'EAGENTTEAMREFUSED', `refused at open: ${res.err && res.err.message}`);
  eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'target untouched');
});

// --- safeWriteNew / tempName / safeReplace ---------------------------------

test('FU-18 safeWriteNew: an existing name (a planted hard link) is not opened; tempName is random', () => {
  const { logs, victim } = fixture();
  const f = path.join(logs, 'x.tmp');
  fs.linkSync(victim, f);
  let code = null;
  try { lib.safeWriteNew(f, 'EVIL'); } catch (e) { code = e.code; }
  eq(code, 'EEXIST', 'exclusive create fails on an existing name');
  eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'target untouched');
  const a = lib.tempName(path.join(logs, 'c.jsonl'));
  const b = lib.tempName(path.join(logs, 'c.jsonl'));
  assert(a !== b && !a.includes(`.${process.pid}.`), `random temp names: ${a} ${b}`);
  // recovery control: a fresh name is written
  const g = path.join(logs, 'new.json');
  lib.safeWriteNew(g, 'ok');
  eq(fs.readFileSync(g, 'utf8'), 'ok', 'written');
});

test('FU-18 safeReplace: replaces a planted link itself, never the file it points to', () => {
  const { logs, victim } = fixture();
  const f = path.join(logs, '.pending', 'hooks-alive.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.linkSync(victim, f);
  lib.safeReplace(f, '{"ok":true}');
  eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'target untouched');
  eq(fs.readFileSync(f, 'utf8'), '{"ok":true}', 'the log name now holds the new content');
  eq(fs.lstatSync(f).nlink, 1, 'and is its own file');
  eq(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp file left');
});

// --- safeListDir ------------------------------------------------------------

test('FU-18 safeListDir: a linked .pending is refused; a missing one is null; a real one is listed', () => {
  const { logs, outside } = fixture();
  eq(lib.safeListDir(path.join(logs, '.pending')), null, 'missing: null');
  fs.mkdirSync(path.join(logs, '.pending'));
  fs.writeFileSync(path.join(logs, '.pending', 'a'), '');
  eq(JSON.stringify(lib.safeListDir(path.join(logs, '.pending'))), '["a"]', 'real folder listed');
  fs.rmSync(path.join(logs, '.pending'), { recursive: true });
  const kind = dirLink(outside, path.join(logs, '.pending'));
  if (!kind) return skip('(neither folder symlinks nor junctions can be made here)');
  const { err } = capture(() => lib.safeListDir(path.join(logs, '.pending')));
  assert(err && err.code === 'EAGENTTEAMREFUSED' && /link or junction/.test(err.message), `linked .pending (${kind}) refused`);
});

// --- tmp files of rewrites and snapshots -----------------------------------

test('FU-18 rewriteJsonl: a link planted at the old pid temp name is not written through', () => {
  const { logs, victim } = fixture();
  const rc = require(path.join(SCRIPTS, 'reconcile-logs.js'));
  const f = path.join(logs, 'completions.jsonl');
  fs.writeFileSync(f, '{"a":1}\n');
  fs.linkSync(victim, `${f}.${process.pid}.tmp`); // the name the old code wrote to
  const read = rc.readLines(f);
  read.lines[0].row.a = 2;
  read.lines[0].changed = true;
  rc.rewriteJsonl(f, read);
  eq(fs.readFileSync(f, 'utf8'), '{"a":2}\n', 'rewritten');
  eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'planted link target untouched');
});

test('FU-18 rewriteJsonl: a log that is a hard link is refused and left as it was', () => {
  const { logs, victim } = fixture();
  const rc = require(path.join(SCRIPTS, 'reconcile-logs.js'));
  fs.writeFileSync(victim, '{"a":1}\n');
  const f = path.join(logs, 'completions.jsonl');
  fs.linkSync(victim, f);
  const read = rc.readLines(f);
  read.lines[0].row.a = 2;
  read.lines[0].changed = true;
  const { err } = capture(() => rc.rewriteJsonl(f, read));
  assert(err && err.code === 'EAGENTTEAMREFUSED', `refused: ${err && err.message}`);
  eq(fs.lstatSync(f).nlink, 2, 'still the same hard link');
  eq(fs.readdirSync(logs).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp file left');
});

test('FU-18 codex onSubagentStop: a link planted at the old pid snapshot temp name is not written through', () => {
  const { p, victim } = fixture();
  const records = require(path.join(SCRIPTS, 'records.js'));
  const codexLog = require(path.join(SCRIPTS, 'codex-log.js'));
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = p;
  try {
    const input = { hook_event_name: 'SubagentStop', session_id: 's-fu18', agent_id: 'a-fu18', turn_id: 'turn-fu18', agent_type: 'implementer', cwd: p, last_assistant_message: 'done' };
    const eventId = `codex-${records.shortHash(JSON.stringify([input.session_id, input.agent_id, input.turn_id]))}`;
    const dir = codexLog.pendingDir(input);
    fs.mkdirSync(dir, { recursive: true });
    fs.linkSync(victim, path.join(dir, `${eventId}.json.${process.pid}.tmp`));
    codexLog.handle(input);
    eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'planted link target untouched');
    const lines = fs.readFileSync(path.join(logsOf(p), 'completions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert(lines.some((l) => l.event_id === eventId), 'recovery control: the completion was written');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});

// --- the exploit from the review, end to end --------------------------------

const reconcileRun = (p, env = {}) => spawnSync('node', [path.join(SCRIPTS, 'reconcile-logs.js')], {
  cwd: p, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: p, AGENT_TEAM_PROJECTS_ROOT: path.join(tmp(), 'none'), AGENT_TEAM_MODELS: NO_MODELS_FILE, ...env },
});

// A v1 Codex snapshot whose report holds a shell command: reconcile appends it to completions.jsonl.
function plantSnapshot(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const record = { ts: 't', tool: 'codex', event_id: 'codex-0123456789ab', kind: 'completion', agent: 'implementer', agent_id: 'a1', task: {}, result: { summary: '$(touch /tmp/pwned)' } };
  const file = path.join(dir, 'codex-0123456789ab.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, transcript_path: null, wait_for_complete: false, record }));
  return file;
}

test('FU-18 exploit: completions.jsonl hard-linked to a dotfile; reconcile does not append the snapshot there; the snapshot is kept', () => {
  const { p, logs, victim } = fixture();
  const snap = plantSnapshot(path.join(logs, '.pending', 'codex-completions'));
  fs.linkSync(victim, path.join(logs, 'completions.jsonl'));
  eq(fs.lstatSync(path.join(logs, 'completions.jsonl')).nlink, 2, 'precondition: the log is a hard link to the victim');
  const r = reconcileRun(p);
  eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'victim untouched');
  assert(fs.existsSync(snap), 'snapshot kept for a later run');
  assert(r.stderr.includes(path.join(logs, 'completions.jsonl')) || r.stderr.includes('completions.jsonl'), `warning names the log: ${r.stderr}`);
  assert(/refusing to write/.test(r.stderr), r.stderr);
  // recovery control: once the link is gone, the same run backfills and removes the snapshot
  fs.rmSync(path.join(logs, 'completions.jsonl'));
  const r2 = reconcileRun(p);
  eq(r2.status, 0, r2.stderr);
  assert(!fs.existsSync(snap), 'snapshot consumed');
  const lines = fs.readFileSync(path.join(logs, 'completions.jsonl'), 'utf8').split('\n').filter(Boolean);
  eq(lines.length, 1, 'one completion line backfilled');
  // one step past: a third run adds nothing
  reconcileRun(p);
  eq(fs.readFileSync(path.join(logs, 'completions.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1, 'idempotent');
});

test('FU-18 drainPending: a linked .pending/codex-completions is not drained; its snapshot is neither appended nor deleted', () => {
  const { p, logs, outside } = fixture();
  const snap = plantSnapshot(outside);
  fs.mkdirSync(path.join(logs, '.pending'), { recursive: true });
  const at = path.join(logs, '.pending', 'codex-completions');
  const kind = dirLink(outside, at);
  if (!kind) return skip('(neither folder symlinks nor junctions can be made here)');
  assert(fs.existsSync(path.join(at, path.basename(snap))), `precondition: the snapshot is reachable through the ${kind}`);
  reconcileRun(p);
  assert(fs.existsSync(snap), 'snapshot in the target not deleted');
  assert(!fs.existsSync(path.join(logs, 'completions.jsonl')), 'nothing appended');
});

// --- hooks never crash on a refusal ----------------------------------------

test('FU-18 hooks: a linked logs folder makes log-delegation exit 0, write nothing in the target, and warn once on stderr', () => {
  const p = tmpProject();
  const outside = tmp();
  fs.rmSync(logsOf(p), { recursive: true, force: true });
  const kind = dirLink(outside, logsOf(p));
  if (!kind) return skip('(neither folder symlinks nor junctions can be made here)');
  const r = run('log-delegation.js', {
    hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 's1', tool_use_id: 'toolu_1', cwd: p,
    tool_input: { subagent_type: 'agent-team:implementer', prompt: 'TASK id=X-1 type=fix difficulty=easy milestone=m attempt=1' },
    tool_response: { agentId: 'ag1', content: [{ type: 'text', text: 'started' }] },
  }, p);
  eq(r.status, 0, `exit 0: ${r.stderr}`);
  eq(fs.readdirSync(outside).length, 0, `nothing written through the ${kind}: ${fs.readdirSync(outside)}`);
  const warn = r.stderr.split('\n').filter((l) => l.includes('refusing to write'));
  eq(warn.length, 1, `one warning line: ${r.stderr}`);
  assert(warn[0].includes(logsOf(p)), warn[0]);
  // recovery control: a real folder is written
  fs.rmSync(logsOf(p), { recursive: true, force: true });
  fs.mkdirSync(logsOf(p));
  const r2 = run('log-delegation.js', {
    hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 's1', tool_use_id: 'toolu_2', cwd: p,
    tool_input: { subagent_type: 'agent-team:implementer', prompt: 'TASK id=X-1 type=fix difficulty=easy milestone=m attempt=1' },
    tool_response: { agentId: 'ag1', content: [{ type: 'text', text: 'started' }] },
  }, p);
  eq(r2.status, 0, r2.stderr);
  assert(fs.existsSync(path.join(logsOf(p), 'delegations.jsonl')), 'delegation logged once the link is gone');
});

test('FU-18 log-event: a hard-linked log is refused with one error line (no stack), exit 1, and no write', () => {
  const { p, logs, victim } = fixture();
  fs.linkSync(victim, path.join(logs, 'notes.jsonl'));
  const r = spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), 'note', '{"text":"x"}'], {
    cwd: p, encoding: 'utf8', timeout: 30000, env: { ...process.env, CLAUDE_PROJECT_DIR: p, CLAUDE_PLUGIN_ROOT: ROOT },
  });
  eq(r.status, 1, `exit 1: ${r.stdout} ${r.stderr}`);
  eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'victim untouched');
  assert(!/\n\s+at /.test(r.stderr), `no stack trace: ${r.stderr}`);
  assert(r.stderr.includes(path.join(logs, 'notes.jsonl')), r.stderr);
});

test('FU-18 session-start: a hard-linked hooks-alive.json is replaced, not written through; the hook still prints its line', () => {
  const { p, logs, victim } = fixture();
  fs.mkdirSync(path.join(logs, '.pending'));
  const marker = path.join(logs, '.pending', 'hooks-alive.json');
  fs.linkSync(victim, marker);
  const r = run('session-start.js', { hook_event_name: 'SessionStart', session_id: 's1', cwd: p }, p);
  eq(r.status, 0, r.stderr);
  assert(r.stdout.includes('agent-team hooks: active'), r.stdout);
  eq(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'victim untouched');
  eq(JSON.parse(fs.readFileSync(marker, 'utf8')).session_id, 's1', 'marker written as its own file');
});

test('FU-18 records: a linked .pending is not pruned (old markers in the target survive); claimOnce refuses', () => {
  const { p, logs, outside } = fixture();
  const old = path.join(outside, 'stop-old-marker');
  fs.writeFileSync(old, '');
  const past = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(old, past, past);
  const kind = dirLink(outside, path.join(logs, '.pending'));
  if (!kind) return skip('(neither folder symlinks nor junctions can be made here)');
  const records = require(path.join(SCRIPTS, 'records.js'));
  const input = { cwd: p };
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = p;
  try {
    assert(fs.existsSync(path.join(logs, '.pending', 'stop-old-marker')), `precondition: the stale marker is reachable through the ${kind}`);
    capture(() => records.prunePending(input));
    assert(fs.existsSync(old), 'stale marker in the target not deleted');
    const { err } = capture(() => { if (records.claimOnce(input, 'stop-new')) throw new Error('claimed'); });
    eq(err, null, 'claimOnce returns false');
    assert(!fs.existsSync(path.join(outside, 'stop-new')), 'no marker made in the target');
    // recovery control: a real .pending is pruned
    fs.rmSync(path.join(logs, '.pending'), { recursive: true, force: true });
    fs.mkdirSync(path.join(logs, '.pending'));
    const mine = path.join(logs, '.pending', 'stop-old-marker');
    fs.writeFileSync(mine, '');
    fs.utimesSync(mine, past, past);
    records.prunePending(input);
    assert(!fs.existsSync(mine), 'stale marker in a real .pending deleted');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});

// --- archive-logs -----------------------------------------------------------

const archive = (p, args = []) => spawnSync('node', [path.join(SCRIPTS, 'archive-logs.js'), 'm1', '--project', 'proj', ...args], {
  cwd: p, encoding: 'utf8', timeout: 60000, env: { ...process.env, AGENT_TEAM_ARCHIVE: tmp(), AGENT_TEAM_PROJECTS_ROOT: tmp() },
});

test('FU-18 archive: a linked .pending is not pruned; files older than 10 minutes in the target survive', () => {
  const { p, logs, outside } = fixture();
  fs.writeFileSync(path.join(logs, 'notes.jsonl'), '{"a":1}\n');
  const old = path.join(outside, 'old.json');
  fs.writeFileSync(old, '{}');
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(old, past, past);
  const kind = dirLink(outside, path.join(logs, '.pending'));
  if (!kind) return skip('(neither folder symlinks nor junctions can be made here)');
  assert(fs.existsSync(path.join(logs, '.pending', 'old.json')), `precondition: the stale file is reachable through the ${kind}`);
  const r = archive(p);
  eq(r.status, 0, r.stderr + r.stdout);
  assert(fs.existsSync(old), 'stale file in the target not deleted');
  assert(/refusing/.test(r.stdout + r.stderr), r.stdout + r.stderr);
  // recovery control: a real .pending is pruned
  fs.rmSync(path.join(logs, '.pending'), { recursive: true, force: true });
  fs.mkdirSync(path.join(logs, '.pending'));
  const mine = path.join(logs, '.pending', 'old.json');
  fs.writeFileSync(mine, '{}');
  fs.utimesSync(mine, past, past);
  eq(archive(p).status, 0, 'second archive');
  assert(!fs.existsSync(mine), 'stale file in a real .pending deleted');
});

test('FU-18 archive --clear: a linked logs folder fails the archive and deletes nothing in the target', () => {
  const p = tmpProject();
  const outside = tmp();
  const victim = path.join(outside, 'precious.jsonl');
  fs.writeFileSync(victim, '{"a":1}\n');
  fs.rmSync(logsOf(p), { recursive: true, force: true });
  const kind = dirLink(outside, logsOf(p));
  if (!kind) return skip('(neither folder symlinks nor junctions can be made here)');
  assert(fs.existsSync(path.join(logsOf(p), 'precious.jsonl')), `precondition: the log is reachable through the ${kind}`);
  const r = archive(p, ['--clear']);
  eq(r.status, 1, r.stdout + r.stderr);
  assert(/refusing/.test(r.stderr), r.stderr);
  eq(fs.readFileSync(victim, 'utf8'), '{"a":1}\n', 'target log not deleted');
});

// --- the grep: no raw write on a log path outside the helper -----------------

// Every raw write call in scripts/ outside lib.js's safe-write block, each with
// the reason it is not a write through a link under .agent-team/logs/. A new
// write call fails this test until it goes through the helper or is listed here.
const ALLOWED = [
  ['archive-logs.js', 'fs.mkdirSync(tmpDest,', 'the archive folder outside the repo'],
  ['archive-logs.js', "fs.writeFileSync(path.join(tmpDest, 'README.md')", 'the archive folder outside the repo'],
  ['archive-logs.js', 'fs.copyFileSync(src, dst)', 'copies into the archive folder outside the repo (src is a regular file: Dirent.isFile)'],
  ['codex-agents.js', 'fs.mkdirSync(out,', '.codex/agents/, not the logs folder'],
  ['codex-agents.js', 'fs.writeFileSync(p, content', '.codex/agents/*.toml, not the logs folder'],
  ['codex-hooks.js', 'fs.mkdirSync(path.dirname(f.file)', '.codex/, not the logs folder'],
  ['codex-hooks.js', 'fs.writeFileSync(f.file, f.text', '.codex/hooks.json and config.toml, not the logs folder'],
  ['status.js', "fs.writeFileSync(tmp, text, { flag: 'wx'", 'STATUS.md temp file: random name, exclusive create, not the logs folder'],
  ['records.js', 'fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }))', 'writes to the fd lib.safeOpenNew returned'],
  ['reconcile-logs.js', "fs.openSync(file, 'r')", 'opens a transcript read-only (transcriptCwd)'],
  ['reconcile-logs.js', 'fs.writeFileSync(fd, ', 'writes to the fd lib.safeOpenNew returned'],
  ['reconcile-logs.js', 'fs.writeSync(fd, ', 'writes to the fd lib.safeOpenNew returned'],
  // Deletes, renames and mtime updates. An unlink or rename acts on the name itself, never on
  // what a link points at; each one below is in a folder already checked with lib.safeListDir,
  // lib.safeMkdir or lib.safeOpenNew, or outside .agent-team/logs/.
  ['archive-logs.js', 'fs.rmSync(tmpDest, { recursive: true, force: true }); // leftover', 'the temp copy under the archive root, outside the repo'],
  ['archive-logs.js', 'fs.renameSync(tmpDest, dest)', 'the archive root, outside the repo'],
  ['archive-logs.js', 'fs.renameSync(path.join(tmpDest, name), path.join(dest, name))', 'the archive root, outside the repo'],
  ['archive-logs.js', 'fs.rmSync(tmpDest, { recursive: true, force: true });', 'the temp copy under the archive root, outside the repo'],
  ['archive-logs.js', 'try { fs.unlinkSync(x.p); removed++; }', 'stale entries listed by lib.safeListDir (real .pending, codex-completions and logs folders), regular files only'],
  ['archive-logs.js', 'fs.unlinkSync(src);', '--clear: a regular .jsonl listed by lib.safeListDir(logDir); unlink removes the name only'],
  ['codex-agents.js', 'fs.unlinkSync(path.join(out, file))', '.codex/agents/*.toml, not the logs folder'],
  ['codex-log.js', 'fs.unlinkSync(file);', 'a finished snapshot in codex-completions, a real folder (lib.safeMkdir / safeListDir)'],
  ['codex-log.js', 'fs.utimesSync(file, now, now)', 'a snapshot that lstat showed to be a regular file with one name, listed by lib.safeListDir'],
  ['reconcile-logs.js', 'rename: (from, to) => fs.renameSync(from, to)', 'rewriteJsonl: the temp file made by lib.safeOpenNew renamed over a log checkLogFile accepted'],
  ['reconcile-logs.js', 'if (created) { try { fs.unlinkSync(tmp); }', 'rewriteJsonl: removes only the temp file it created'],
  ['reconcile-logs.js', "fs.unlinkSync(path.join(logDir, '.pending', key.replace(", 'releases the marker claimOnce just made with lib.safeWriteNew'],
  ['records.js', 'fs.unlinkSync(file);', "takeDuration's start file and withRecordLock's lock file, in folders made by lib.safeMkdir / safeOpenNew"],
  ['records.js', 'fs.unlinkSync(f);', 'prunePending: entries listed by lib.safeListDir, never a folder'],
  ['status.js', 'fs.renameSync(tmp, file)', 'STATUS.md, not the logs folder'],
  ['status.js', 'try { fs.unlinkSync(tmp); }', 'STATUS.md temp file, not the logs folder'],
];
const RAW = /\b(?:appendFileSync|writeFileSync|writeSync|openSync|copyFileSync|createWriteStream|cpSync|mkdirSync|unlinkSync|renameSync|rmSync|rmdirSync|utimesSync|lutimesSync)\s*\(/;

test('FU-18 grep: no raw write, mkdir, unlink, rename, rm or utimes call in scripts/ outside the safe-write helper, except the allow-list', () => {
  const used = new Set();
  const bad = [];
  for (const name of fs.readdirSync(SCRIPTS).filter((n) => n.endsWith('.js')).sort()) {
    let text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    if (name === 'lib.js') {
      const a = text.indexOf('// --- safe writes under .agent-team/logs/ (begin)');
      const b = text.indexOf('// --- safe writes under .agent-team/logs/ (end)');
      assert(a >= 0 && b > a, 'lib.js marks its safe-write block');
      text = text.slice(0, a) + text.slice(b);
    }
    text.split(/\r?\n/).forEach((line, i) => {
      if (!RAW.test(line) || /^\s*\/\//.test(line)) return;
      const hit = ALLOWED.findIndex(([f, needle]) => f === name && line.includes(needle));
      if (hit < 0) bad.push(`${name}:${i + 1}: ${line.trim()}`);
      else used.add(hit);
    });
  }
  eq(bad.join('\n'), '', 'raw writes outside the helper');
  const stale = ALLOWED.filter((_, i) => !used.has(i)).map(([f, n]) => `${f}: ${n}`);
  eq(stale.join('\n'), '', 'allow-list entries that match nothing');
  // and the old pid-named temp files are gone
  for (const name of ['reconcile-logs.js', 'codex-log.js']) {
    assert(!fs.readFileSync(path.join(SCRIPTS, name), 'utf8').includes('${process.pid}.tmp'), `${name}: no pid temp name`);
  }
});

// --- temp files a crashed write left behind -----------------------------------

// A temp name as lib.tempName makes it, with its mtime set `ageMs` back.
function plantTemp(dir, base, ageMs) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${base}.0123456789abcdef.tmp`);
  fs.writeFileSync(f, '{}');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return f;
}

test('FU-18 records: old temp files are pruned from .pending, codex-completions and the logs folder; fresh ones and snapshots stay', () => {
  const { p, logs } = fixture();
  const records = require(path.join(SCRIPTS, 'records.js'));
  const day = 24 * 3600 * 1000;
  const cc = path.join(logs, '.pending', 'codex-completions');
  const old = [
    plantTemp(path.join(logs, '.pending'), 'toolu_1.json', 2 * day),
    plantTemp(cc, 'codex-0123456789ab.json', 2 * day),
    plantTemp(logs, 'completions.jsonl', 2 * day),
  ];
  const fresh = plantTemp(cc, 'codex-aaaaaaaaaaaa.json', 1000);
  const snapshot = path.join(cc, 'codex-0123456789ab.json');
  fs.writeFileSync(snapshot, '{}');
  const past = new Date(Date.now() - 2 * day);
  fs.utimesSync(snapshot, past, past);
  eq(lib.tempName(path.join(cc, 'x.json')).replace(/^.*x\.json/, '').length, '.0123456789abcdef.tmp'.length, 'precondition: the planted names have the shape tempName makes');
  assert(old.every((f) => fs.existsSync(f)), 'precondition: the old temp files exist');
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = p;
  try {
    records.prunePending({ cwd: p });
    for (const f of old) assert(!fs.existsSync(f), `old temp pruned: ${f}`);
    assert(fs.existsSync(fresh), 'a fresh temp file stays (a write may be in flight)');
    assert(fs.existsSync(snapshot), 'an old snapshot is not a temp file: it stays');
    records.prunePending({ cwd: p }); // one step past
    assert(fs.existsSync(fresh) && fs.existsSync(snapshot), 'a second prune removes nothing else');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});

test('FU-18 archive: temp files older than 10 minutes in .pending, codex-completions and the logs folder are deleted; fresh ones and snapshots stay', () => {
  const { p, logs } = fixture();
  fs.writeFileSync(path.join(logs, 'notes.jsonl'), '{"a":1}\n');
  const cc = path.join(logs, '.pending', 'codex-completions');
  const hour = 3600 * 1000;
  const old = [
    plantTemp(path.join(logs, '.pending'), 'hooks-alive.json', hour),
    plantTemp(cc, 'codex-0123456789ab.json', hour),
    plantTemp(logs, 'completions.jsonl', hour),
  ];
  const fresh = plantTemp(cc, 'codex-aaaaaaaaaaaa.json', 1000);
  const snapshot = path.join(cc, 'codex-0123456789ab.json');
  fs.writeFileSync(snapshot, '{}');
  const past = new Date(Date.now() - hour);
  fs.utimesSync(snapshot, past, past);
  assert(old.every((f) => fs.existsSync(f)), 'precondition: the old temp files exist');
  const r = archive(p);
  eq(r.status, 0, r.stderr + r.stdout);
  for (const f of old) assert(!fs.existsSync(f), `old temp deleted: ${f}`);
  assert(fs.existsSync(fresh), 'fresh temp kept');
  assert(fs.existsSync(snapshot), 'a snapshot is not a temp file: kept');
  assert(r.stdout.includes('.pending: deleted 3 stale'), r.stdout);
});
