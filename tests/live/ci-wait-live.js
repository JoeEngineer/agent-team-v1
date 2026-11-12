#!/usr/bin/env node
// Opt-in live harness: runs a small fixed milestone with a headless Director (Claude or
// Codex) against a real GitHub repo whose CI takes about two minutes, then measures from the
// Director's own transcript how many turns and context tokens went to CI. NOT part of
// `node tests/run.js` (run.js only loads tests/*.test.js). See tests/live/README.md.
// Node built-ins only; talks to GitHub through the `gh` CLI.
//
// Exit codes: 0 the run finished and the report was written (missed targets do NOT change it);
//             1 harness error; 2 bad arguments or the read-only preflight failed.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const L = require('./ci-wait-lib.js');
const T = require('./ci-turns.js');
const CX = require('./ci-wait-codex.js');

const WIN = process.platform === 'win32';
const FIXTURE = path.join(__dirname, 'fixtures', 'ci-sample');
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
// Polling pace and the probe's green-and-still-open grace; tests shorten both.
const POLL_MS = Number(process.env.CI_WAIT_LIVE_POLL_MS) || 15000;
const GRACE_MS = Number(process.env.CI_WAIT_LIVE_GRACE_MS) || 120000;
const fwd = (p) => p.replace(/\\/g, '/');

// ---- process helpers ----
function run(cmd, args, opts) {
  const base = { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 };
  // claude and codex are .cmd shims on Windows: one command line through the shell
  // (an args array with shell:true is deprecated in new Node versions).
  if (WIN && (cmd === 'claude' || cmd === 'codex')) return spawnSync(CX.shellLine(cmd, args), Object.assign({ shell: true }, base, opts));
  return spawnSync(cmd, args, Object.assign(base, opts));
}
const git = (cwd, args, o) => run('git', args, Object.assign({ cwd }, o));
const ok = (r) => r && r.status === 0;
function killTree(child) {
  if (!child || child.killed || child.exitCode != null) return;
  try {
    if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    else child.kill('SIGKILL');
  } catch (e) { /* already gone */ }
}

// ---- the run's shared state (read by cleanup, also from the signal handler) ----
const S = { opts: null, run: null, tmp: null, base: null, child: null, secrets: [], defaultBranch: 'main', cleanedRemote: false, cleanedTemp: false, interrupted: false };
const redact = (t) => L.redact(t, S.secrets);
function log(m) { console.log(redact(m)); }

// CI_WAIT_LIVE_FAKE_GH (a node script) stands in for gh in tests/ci-wait-live.test.js.
function gh(args, o) { return process.env.CI_WAIT_LIVE_FAKE_GH ? run('node', [process.env.CI_WAIT_LIVE_FAKE_GH, ...args], o) : run('gh', args, o); }
function ghJson(args, o) {
  const r = gh(args, o);
  if (!ok(r)) return { error: ((r && (r.stderr || r.stdout)) || 'gh failed').trim().slice(0, 300), status: r && r.status };
  try { return { data: JSON.parse(r.stdout) }; } catch (e) { return { error: `not JSON: ${String(r.stdout).slice(0, 100)}` }; }
}

// ---- preflight (read-only) ----
function preflight(opts) {
  const auth = gh(['auth', 'status']);
  const repoR = ghJson(['api', `repos/${opts.repo}`]);
  const actR = ghJson(['api', `repos/${opts.repo}/actions/permissions`]);
  const rulesR = ghJson(['api', `repos/${opts.repo}/rules/branches/milestone%2Fpreflight-probe`]);
  return L.evaluatePreflight({
    authOk: ok(auth), repo: repoR.data || null, repoError: repoR.error,
    actions: actR.data || null, actionsError: actR.error,
    rules: rulesR.data || null, rulesError: rulesR.error, seedOnly: opts.seedOnly,
  }, opts.repo);
}
function printPreflight(pf) {
  log('\nPreflight (read-only)');
  for (const c of pf.checks) log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? '  -- ' + c.detail : ''}`);
  if (pf.ok) return;
  log('\nThe repo is not ready. Nothing was changed. What to do:');
  for (const p of pf.problems) log(`\n* ${p.message}${p.steps ? '\n' + p.steps.split('\n').map((x) => '    ' + x).join('\n') : ''}`);
  log('\nThe harness never changes repo settings or rules; do these in the GitHub UI, then run it again.');
}

// ---- GitHub: PRs, checks, listing ----
function prChecks(opts, pr) {
  const r = gh(['pr', 'checks', String(pr), '--repo', opts.repo, '--json', 'name,bucket,state,startedAt,completedAt']);
  try { return JSON.parse(r.stdout || '[]'); } catch (e) { return []; }
}
// Waits until every check on the PR has finished. Returns { state: pass|fail|none|timeout, checks, seconds }.
async function waitForChecks(opts, pr, { timeoutMs, noChecksMs }) {
  const t0 = Date.now();
  for (;;) {
    if (S.interrupted) return { state: 'timeout', checks: [], seconds: 0 };
    const checks = prChecks(opts, pr);
    const finished = checks.length > 0 && checks.every((c) => ['pass', 'fail', 'skipping', 'cancel'].includes(c.bucket));
    if (finished) return { state: checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel') ? 'fail' : 'pass', checks, seconds: Math.round((Date.now() - t0) / 1000) };
    const el = Date.now() - t0;
    if (!checks.length && el > noChecksMs) return { state: 'none', checks, seconds: Math.round(el / 1000) };
    if (el > timeoutMs) return { state: 'timeout', checks, seconds: Math.round(el / 1000) };
    await sleepMs(POLL_MS);
  }
}
function listOpen(opts) {
  const prs = ghJson(['pr', 'list', '--repo', opts.repo, '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,baseRefName']);
  const issues = ghJson(['issue', 'list', '--repo', opts.repo, '--state', 'open', '--limit', '200', '--json', 'number,title,body']);
  const br = gh(['api', `repos/${opts.repo}/branches`, '--paginate', '--jq', '.[].name']);
  return {
    error: prs.error || issues.error || (ok(br) ? null : 'branch listing failed'),
    listing: { prs: prs.data || [], issues: issues.data || [], branches: ok(br) ? br.stdout.split(/\r?\n/).filter(Boolean) : [] },
  };
}

// ---- cleanup: only this run's own PRs, issues and branches ----
function cleanupRemote(opts, runPrefix, { dryRun } = {}) {
  const { error, listing } = listOpen(opts);
  if (error) { log(`cleanup: could not list the repo (${error})`); return { ok: false, error }; }
  const sel = L.selectCleanup(listing, runPrefix, S.defaultBranch);
  if (sel.refused) { log(`cleanup refused: ${sel.refused}`); return { ok: false, error: sel.refused }; }
  log(`cleanup ${dryRun ? '(dry run) would handle' : 'handling'} for ${runPrefix}: ${sel.prs.length} PR(s), ${sel.issues.length} issue(s), ${sel.branches.length} branch(es)`);
  if (dryRun) { log(JSON.stringify(sel)); return { ok: true, sel, dryRun: true }; }
  let failed = 0;
  for (const n of sel.prs) if (!ok(gh(['pr', 'close', String(n), '--repo', opts.repo]))) failed++;
  for (const n of sel.issues) if (!ok(gh(['issue', 'close', String(n), '--repo', opts.repo, '--reason', 'not planned']))) failed++;
  for (const b of sel.branches) {
    const ref = b.split('/').map(encodeURIComponent).join('/');
    const r = gh(['api', '-X', 'DELETE', `repos/${opts.repo}/git/refs/heads/${ref}`]);
    if (!ok(r) && !/Reference does not exist|404/.test(`${r.stderr}${r.stdout}`)) failed++;
  }
  if (failed) log(`cleanup incomplete: ${failed} item(s) failed. Retry with: node tests/live/ci-wait-live.js --repo ${opts.repo} --cleanup-run ${runPrefix}`);
  return { ok: failed === 0, sel, failed };
}
// The first of tmp, tmp/h and tmp/p that exists and is a link (symlink or Windows junction) or not
// a directory, else null. A recursive delete does not follow links, but nothing may be deleted
// "through" one either, so a folder with a link in it is never touched.
function linkInTemp(t) {
  for (const p of [t, path.join(t, 'h'), path.join(t, 'p')]) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT' && p !== t) continue; return p; }
    if (st.isSymbolicLink() || !st.isDirectory()) return p;
  }
  return null;
}
// Removes <base>/<digits> (this process's own folder) and the copied Codex auth. Idempotent.
function cleanupTemp() {
  if (S.cleanedTemp || !S.tmp) return;
  const t = path.resolve(S.tmp);
  if (path.resolve(path.dirname(t)) !== path.resolve(S.base) || !/^\d+$/.test(path.basename(t))) return;
  if (!L.deletableTemp(t, S.base, [], L.expectedTempBase())) { log(`cleanup refused: ${t} is not under the expected temp base ${L.expectedTempBase()}`); return; }
  const bad = linkInTemp(t);
  if (bad) { S.cleanedTemp = true; log(`cleanup refused: ${bad} is a link or not a directory; ${t} left alone, delete it by hand`); return; }
  S.cleanedTemp = true;
  try { fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { log(`cleanup incomplete: ${t}`); }
  try { fs.rmdirSync(S.base); } catch (e) { /* not empty or gone */ }
  if (S.runFile && !fs.existsSync(t)) try { fs.rmSync(S.runFile, { force: true }); } catch (e) { /* ignore */ }
}
const outDirOf = (opts) => (opts.outDir ? path.resolve(opts.outDir) : path.join(os.tmpdir(), 'agent-team-ci-wait-live'));
// Read before any remote action: a run whose recorded pid is alive (or unknown, so it cannot be told)
// may still be in flight, so --cleanup-run refuses everything unless --force. null when fine or no run file.
function liveRunRefusal(opts, runPrefix) {
  const file = path.join(outDirOf(opts), L.runFileName(runPrefix));
  let rec = null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }   // no run file: nothing to protect
  // A file that is there but cannot be read as a run record is treated like an unknown pid.
  try { rec = JSON.parse(text); } catch (e) { rec = null; }
  if (opts.force) return null;
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return `the run file for ${runPrefix} is not valid JSON, so it cannot be told whether the run is still in flight`;
  if (rec.run !== runPrefix) return null;
  const st = L.pidState(rec.pid);
  if (st === 'alive') return `process ${rec.pid} (recorded for ${runPrefix}) is still alive, so the run may still be in flight`;
  if (st === 'unknown') return `the run file for ${runPrefix} has no valid pid (${JSON.stringify(rec.pid)}), so it cannot be told whether the run is still in flight`;
  return null;
}
// --cleanup-run: also delete the run's temp folder (it may hold a copied Codex auth.json) when the
// run file written at its start says where it was. Refuses anything that is not <base>/<digits>
// holding only h/ and p/.
function cleanupRecordedTemp(opts, runPrefix, { dryRun } = {}) {
  const file = path.join(outDirOf(opts), L.runFileName(runPrefix));
  let rec = null;
  let unreadable = false;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { unreadable = !!e && e.code !== 'ENOENT'; }
  if (!rec && unreadable) { log(`run file ${file} is not valid JSON: its temp folder, if any, was left alone and must be deleted by hand`); return { ok: true, found: true, unreadable: true }; }
  if (!rec) { log(`no run file for ${runPrefix} in ${outDirOf(opts)} (pass --out-dir if the run used one): its temp folder, if any, must be deleted by hand`); return { ok: true, found: false }; }
  if (rec.run !== runPrefix) { log(`run file ${file} is for another run; temp folder left alone`); return { ok: false, found: true }; }
  if (!fs.existsSync(rec.tmp)) { log(`temp folder ${rec.tmp} is already gone`); if (!dryRun) fs.rmSync(file, { force: true }); return { ok: true, found: true, gone: true }; }
  let entries = [];
  try { entries = fs.readdirSync(rec.tmp); } catch (e) { /* unreadable: refused below */ }
  if (!L.deletableTemp(rec.tmp, rec.base, entries, L.expectedTempBase())) { log(`refusing to delete ${rec.tmp}: it is not a harness temp folder (<${L.expectedTempBase()}>/<pid> holding only h and p; the run file must record that base)`); return { ok: false, found: true, refused: true }; }
  const bad = linkInTemp(path.resolve(rec.tmp));
  if (bad) { log(`refusing to delete ${rec.tmp}: ${bad} is a link or not a directory`); return { ok: false, found: true, refused: true }; }
  if (dryRun) { log(`(dry run) would delete the temp folder ${rec.tmp}`); return { ok: true, found: true, dryRun: true }; }
  try { fs.rmSync(rec.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { log(`could not delete ${rec.tmp}: ${e.message}`); return { ok: false, found: true }; }
  try { fs.rmdirSync(rec.base); } catch (e) { /* not empty or gone */ }
  if (fs.existsSync(rec.tmp)) { log(`temp folder ${rec.tmp} is still there`); return { ok: false, found: true }; }
  fs.rmSync(file, { force: true });
  log(`deleted the temp folder ${rec.tmp}`);
  return { ok: true, found: true, deleted: true };
}
function cleanupAll() {
  killTree(S.child);
  if (S.opts && S.opts.keep) {
    // Kept for inspection, but never leave credentials behind.
    // Only when tmp, h and p are real directories: never delete through a link.
    if (S.tmp && !linkInTemp(path.resolve(S.tmp))) try { fs.rmSync(path.join(S.tmp, 'h', 'auth.json'), { force: true }); } catch (e) { /* ignore */ }
    if (S.run) log(`--keep: left the temp folder ${S.tmp} and the GitHub items. Clean up later with: node tests/live/ci-wait-live.js --repo ${S.opts.repo} --cleanup-run ${S.run}${S.opts.outDir ? ` --out-dir ${S.opts.outDir}` : ''}`);
    return { ok: true, kept: true };
  }
  let res = { ok: true };
  if (S.run && S.opts && !S.cleanedRemote) { S.cleanedRemote = true; res = cleanupRemote(S.opts, S.run); }
  cleanupTemp();
  return res;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    S.interrupted = true;
    try { cleanupAll(); } catch (e) { log(`cleanup error: ${e.message}`); }
    log(`interrupted (${sig}); cleaned up`);
    process.exit(130);
  });
}

// ---- seeding ----
function copyFixture(dest) {
  fs.cpSync(FIXTURE, dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, '.agent-team', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.agent-team', 'logs', '.gitkeep'), '');
}
function setupClone(opts, clone) {
  let r = gh(['repo', 'clone', opts.repo, clone], { timeout: 180000 });
  if (!ok(r)) throw new Error(`clone failed: ${(r.stderr || '').trim().slice(0, 200)}`);
  git(clone, ['config', 'user.name', 'agent-team live harness']);
  git(clone, ['config', 'user.email', 'live@example.invalid']);
  // Pushes use the gh login, whatever the global git credential setup is.
  git(clone, ['config', '--replace-all', 'credential.helper', '']);
  git(clone, ['config', '--add', 'credential.helper', '!gh auth git-credential']);
  git(clone, ['config', 'core.autocrlf', 'false']);
  const head = gh(['api', `repos/${opts.repo}`, '--jq', '.default_branch']);
  if (ok(head) && head.stdout.trim()) S.defaultBranch = head.stdout.trim();
}
// Pushes the fixture on a branch that is not milestone/*, opens a PR so the workflow runs on
// that commit, waits for the check, then (unless seedOnly) pushes the same commit as the
// milestone branch. A milestone ruleset that requires sample-ci would refuse a first push of
// untested files, but accepts a commit whose check already passed.
async function seed(opts, clone, extraPaths) {
  const seedBranch = `${S.run}-seed`;
  const out = { branch: seedBranch };
  let r = git(clone, ['checkout', '-q', '-b', seedBranch, `origin/${S.defaultBranch}`]);
  if (!ok(r)) throw new Error(`checkout failed: ${r.stderr}`);
  copyFixture(clone);
  git(clone, ['add', '--', '.']);
  for (const p of extraPaths || []) git(clone, ['add', '-f', '--', p]);
  r = git(clone, ['commit', '-q', '-m', `${S.run}: seed the ci-sample fixture`]);
  if (!ok(r)) throw new Error(`commit failed: ${(r.stderr || r.stdout).trim()}`);
  out.sha = git(clone, ['rev-parse', 'HEAD']).stdout.trim();
  r = git(clone, ['push', '-q', 'origin', `${seedBranch}:refs/heads/${seedBranch}`], { timeout: 180000 });
  if (!ok(r)) throw new Error(`push of the seed branch failed: ${(r.stderr || '').trim().slice(0, 300)}`);
  r = gh(['pr', 'create', '--repo', opts.repo, '--base', S.defaultBranch, '--head', seedBranch, '--title', `${S.run} seed`,
    '--body', 'Seeds the ci-sample fixture so the sample-ci check runs once. Opened by the live CI harness; it closes this PR itself.']);
  if (!ok(r)) throw new Error(`seed PR failed: ${(r.stderr || '').trim().slice(0, 300)}`);
  const m = /\/pull\/(\d+)/.exec(r.stdout);
  if (!m) throw new Error(`could not read the seed PR number from: ${r.stdout}`);
  out.pr = Number(m[1]);
  log(`seed PR #${out.pr} opened; waiting for sample-ci (about 2 minutes)...`);
  const w = await waitForChecks(opts, out.pr, { timeoutMs: 12 * 60000, noChecksMs: 4 * 60000 });
  out.check = { state: w.state, seconds: w.seconds, names: w.checks.map((c) => c.name) };
  const dur = w.checks.map((c) => (Date.parse(c.completedAt) - Date.parse(c.startedAt)) / 1000).filter((n) => Number.isFinite(n) && n > 0);
  if (dur.length) out.check.durationSeconds = Math.round(Math.max(...dur));
  if (w.state === 'none') throw new Error('the seed PR got no checks after 4 minutes. Is Actions enabled, and is the workflow file on the branch?');
  if (w.state === 'timeout') throw new Error('the seed PR checks did not finish in 12 minutes');
  if (w.state === 'fail') throw new Error(`the seed PR check failed (${JSON.stringify(w.checks.map((c) => [c.name, c.bucket]))}); see the PR in GitHub before the cleanup closes it`);
  if (!w.checks.some((c) => c.name === L.CHECK_NAME)) throw new Error(`no check named ${L.CHECK_NAME} ran (saw: ${w.checks.map((c) => c.name).join(', ')})`);
  if (!opts.seedOnly) {
    const br = `milestone/${S.run}`;
    r = git(clone, ['push', '-q', 'origin', `HEAD:refs/heads/${br}`], { timeout: 180000 });
    if (!ok(r)) throw new Error(`push of ${br} failed: ${(r.stderr || '').trim().slice(0, 400)}`);
    git(clone, ['checkout', '-q', '-B', br, 'HEAD']);
    git(clone, ['branch', '--set-upstream-to', `origin/${br}`, br]);
    out.milestoneBranch = br;
  }
  gh(['pr', 'close', String(out.pr), '--repo', opts.repo]);
  return out;
}

// ---- the Director ----
function runDirector({ cmd, args, prompt, env, cwd, timeoutMs, onEvent }) {
  return new Promise((resolve) => {
    const child = WIN ? spawn(CX.shellLine(cmd, args), { cwd, env, shell: true, windowsHide: true }) : spawn(cmd, args, { cwd, env, windowsHide: true });
    S.child = child;
    const lines = [];
    let buf = '';
    let err = '';
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (!line) continue;
        lines.push(line);
        let obj = null; try { obj = JSON.parse(line); } catch (e) { /* not JSON */ }
        if (obj) onEvent(obj, Date.now());
      }
    });
    child.stderr.on('data', (d) => { if (err.length < 200000) err += d; });
    child.on('error', (e) => { err += `\nspawn error: ${e.message}`; });
    child.on('close', (code, signal) => { clearTimeout(t); S.child = null; resolve({ code, signal, timedOut, lines, stderr: err }); });
    child.stdin.on('error', () => { /* the child may exit first */ });
    child.stdin.end(prompt);
  });
}
const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

// ---- logs and PRs after the run ----
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
function collectLogs(opts, clone, plugin) {
  const logs = path.join(clone, '.agent-team', 'logs');
  const out = { reconcile: null };
  const recon = path.join(plugin, 'scripts', 'reconcile-logs.js');
  if (fs.existsSync(recon) && /--merges/.test(fs.readFileSync(recon, 'utf8'))) {
    const r = run('node', [recon, '--merges'], { cwd: clone, env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: clone }), timeout: 120000 });
    out.reconcile = { status: r.status, output: redact(`${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 1500)) };
  }
  out.reviews = readJsonl(path.join(logs, 'reviews.jsonl'));
  out.merges = readJsonl(path.join(logs, 'merges.jsonl'));
  return out;
}
function milestonePr(opts, reported) {
  const r = ghJson(['pr', 'list', '--repo', opts.repo, '--state', 'all', '--head', `milestone/${S.run}`, '--json', 'number,state,baseRefName,title', '--limit', '20']);
  const list = (r.data || []).filter((p) => p.baseRefName === S.defaultBranch);
  return (reported && list.find((p) => Number(p.number) === Number(reported.pr))) || list[0] || null;
}

// ---- --probe-auto-head ----
async function probeAutoHead(opts, clone) {
  const out = { ran: true };
  const br = `${S.run}-probe`;
  const base = `milestone/${S.run}`;
  const push = (n) => {
    fs.mkdirSync(path.join(clone, 'probe'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'probe', `${n}.txt`), `probe ${n}\n`);
    git(clone, ['add', '--', `probe/${n}.txt`]);
    const c = git(clone, ['commit', '-q', '-m', `${S.run} probe ${n}`]);
    if (!ok(c)) throw new Error(`probe commit failed: ${c.stderr}`);
    const p = git(clone, ['push', '-q', 'origin', `${br}:refs/heads/${br}`], { timeout: 180000 });
    if (!ok(p)) throw new Error(`probe push failed: ${(p.stderr || '').trim().slice(0, 300)}`);
    return git(clone, ['rev-parse', 'HEAD']).stdout.trim();
  };
  try {
    git(clone, ['fetch', '-q', 'origin']);
    let r = git(clone, ['checkout', '-q', '-B', br, `origin/${base}`]);
    if (!ok(r)) throw new Error(`could not branch from ${base}: ${r.stderr}`);
    out.sha1 = push('a');
    r = gh(['pr', 'create', '--repo', opts.repo, '--base', base, '--head', br, '--title', `${S.run} probe: auto-merge head check`, '--body', 'Throwaway PR from the live CI harness.']);
    const m = ok(r) && /\/pull\/(\d+)/.exec(r.stdout);
    if (!m) throw new Error(`probe PR failed: ${(r.stderr || '').trim().slice(0, 300)}`);
    const pr = Number(m[1]);
    out.pr = pr;
    r = gh(['pr', 'merge', String(pr), '--repo', opts.repo, '--auto', '--squash', '--match-head-commit', out.sha1]);
    if (!ok(r)) { out.result = 'inconclusive'; out.reason = `could not queue auto-merge: ${(r.stderr || r.stdout).trim().slice(0, 300)}`; return out; }
    const q1 = ghJson(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'autoMergeRequest,state']);
    out.queued = !!(q1.data && q1.data.autoMergeRequest);
    out.sha2 = push('b');
    // Give GitHub a moment to react to the push, then watch.
    await sleepMs(Math.min(10000, POLL_MS));
    const t0 = Date.now();
    let checksDoneAt = null;
    for (;;) {
      if (S.interrupted) break;
      const v = ghJson(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'state,autoMergeRequest,headRefOid,mergedAt']);
      const d = v.data || {};
      out.state = d.state; out.autoMergeAfterPush = !!d.autoMergeRequest; out.headAtEnd = d.headRefOid;
      if (d.state === 'MERGED' || d.state === 'CLOSED') break;
      const c = prChecks(opts, pr);
      if (c.length && c.every((x) => ['pass', 'fail', 'skipping', 'cancel'].includes(x.bucket)) && checksDoneAt == null) checksDoneAt = Date.now();
      if (checksDoneAt != null && Date.now() - checksDoneAt > GRACE_MS) break;    // green for 2 minutes and still open
      if (Date.now() - t0 > 12 * 60000) { out.timedOut = true; break; }
      await sleepMs(POLL_MS);
    }
    out.mergedAnyway = out.state === 'MERGED';
    out.mergedWithMovedHead = out.state === 'MERGED' && out.headAtEnd !== out.sha1;
    out.result = out.timedOut && out.state === 'OPEN' ? 'inconclusive' : out.mergedWithMovedHead ? 'merged-anyway' : out.state === 'MERGED' ? 'merged-at-queued-head' : 'held';
  } catch (e) {
    out.result = 'error'; out.reason = e.message;
  }
  return out;
}

// ---- main ----
async function main() {
  const parsed = L.parseArgs(process.argv.slice(2));
  if (parsed.error) { log(`${parsed.error}\n\n${L.USAGE}`); return 2; }
  const opts = parsed.opts;
  S.opts = opts;
  if (!ok(gh(['--version'])) || !ok(run('git', ['--version']))) { log('gh and git must be on PATH'); return 2; }

  if (opts.cleanupRun) {
    const head = gh(['api', `repos/${opts.repo}`, '--jq', '.default_branch']);
    if (ok(head) && head.stdout.trim()) S.defaultBranch = head.stdout.trim();
    const live = liveRunRefusal(opts, opts.cleanupRun);
    if (live) { log(`refusing to clean up ${opts.cleanupRun}: ${live}. Nothing was closed or deleted. Stop the run first, or pass --force if that pid is not the harness any more`); return 1; }
    const r = cleanupRemote(opts, opts.cleanupRun, { dryRun: opts.dryRun });
    const t = cleanupRecordedTemp(opts, opts.cleanupRun, { dryRun: opts.dryRun });
    return r.ok && t.ok ? 0 : 1;
  }

  // Read-only: report whether the repo is ready and stop. Starts no run, no clone, no PR.
  if (opts.preflightOnly) {
    const only = preflight(Object.assign({}, opts, { seedOnly: opts.seedOnly || opts.smoke }));
    printPreflight(only);
    log(only.ok ? '\nThe repo is ready for a run.' : '');
    return only.ok ? 0 : 2;
  }

  // Plugin under test and tool checks.
  let plugin = null; let pluginInfo = null;
  if (!opts.seedOnly) {
    plugin = path.resolve(opts.plugin);
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch (e) { /* below */ }
    if (!version) { log(`--plugin ${plugin} is not a plugin checkout (no .claude-plugin/plugin.json)`); return 2; }
    const c = git(plugin, ['rev-parse', '--short', 'HEAD']);
    pluginInfo = { path: plugin, version, commit: ok(c) ? c.stdout.trim() : null };
    if (!ok(run(opts.tool, ['--version']))) { log(`${opts.tool} is not on PATH`); return 2; }
    if (opts.tool === 'codex') {
      const auth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
      if (!fs.existsSync(auth)) { log(`no Codex auth found (${auth})`); return 2; }
      S.realAuth = auth;
    }
  }

  // --smoke checks the plumbing only, so like --seed-only it does not need auto-merge or the ruleset.
  const pf = preflight(Object.assign({}, opts, { seedOnly: opts.seedOnly || opts.smoke }));
  printPreflight(pf);
  if (!pf.ok) return 2;

  S.run = L.runPrefix(opts.tool, new Date());
  S.base = L.expectedTempBase();
  S.tmp = path.join(S.base, String(process.pid));
  const clone = path.join(S.tmp, 'p');
  const home = path.join(S.tmp, 'h');
  fs.mkdirSync(S.tmp, { recursive: true });
  // Say where the temp folder is before anything is put in it, so --cleanup-run can find it
  // even if this process is killed hard.
  const runDir = outDirOf(opts);
  fs.mkdirSync(runDir, { recursive: true });
  S.runFile = path.join(runDir, L.runFileName(S.run));
  fs.writeFileSync(S.runFile, JSON.stringify({ run: S.run, repo: opts.repo, tmp: S.tmp, base: S.base, pid: process.pid, startedAt: new Date().toISOString() }));
  const report = { harness: 'ci-wait-live', schema: 1, smoke: opts.smoke, label: opts.label || null, tool: opts.tool, repo: opts.repo, run: S.run, plugin: pluginInfo,
    startedAt: new Date().toISOString(), preflight: pf.checks, errors: [], warnings: [] };
  const outDir = runDir;
  const jsonPath = path.join(outDir, `ci-wait-${S.run}${opts.label ? '-' + opts.label : ''}.json`);
  const writeReport = () => fs.writeFileSync(jsonPath, redact(JSON.stringify(report, null, 2)));
  log(`\nrun ${S.run}  (temp ${S.tmp})`);

  try {
    setupClone(opts, clone);
    const env = Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1' });
    delete env.AGENT_TEAM_TOOL;
    let extra = [];
    if (opts.tool === 'codex' && !opts.seedOnly) {
      env.CODEX_HOME = fwd(home);
      try { S.secrets.push(...L.secretsFromJson(fs.readFileSync(S.realAuth, 'utf8'))); } catch (e) { /* none */ }
      const inst = await CX.install({ plugin, home, clone, env, run, realAuth: S.realAuth });
      report.codexInstall = inst;
      if (!inst.ok) throw new Error(`Codex install failed at: ${inst.steps.filter((x) => !x.ok).map((x) => `${x.name} (${x.detail})`).join('; ')}`);
      extra = ['.codex/hooks.json', '.codex/agent-team-hook.js'];
    }
    report.seed = await seed(opts, clone, extra);
    report.defaultBranch = S.defaultBranch;
    if (opts.seedOnly) {
      log(`\nseed-only: ${L.CHECK_NAME} ran green in ${report.seed.check.seconds}s on PR #${report.seed.pr} (job ${report.seed.check.durationSeconds || '?'}s).`);
      log(`Now add ${L.CHECK_NAME} as a required check for milestone/* (steps below), then run the harness without --seed-only.\n${L.rulesetSteps(opts.repo)}`);
    } else {
      // ---- Director ----
      const prompt = opts.smoke ? L.smokePrompt() : L.directorPrompt(opts.tool, S.run);
      const events = { milestone: null, milestoneAtMs: null, assistants: 0, hooks: null, pluginSeen: null, abort: null };
      const t0 = Date.now();
      let lastBeat = t0;
      const onEvent = (o, now) => {
        const mj = T.milestoneJsonInEvent(o);
        if (mj) { events.milestone = mj; events.milestoneAtMs = now; }
        if (o.type === 'system' && o.subtype === 'init' && Array.isArray(o.plugins)) {
          const p = o.plugins.find((x) => x.name === 'agent-team');
          events.pluginSeen = p || null;
          if (!p || !samePath(p.path, plugin)) { events.abort = `Claude loaded a different agent-team plugin (${p ? p.path : 'none'}) than --plugin ${plugin}`; killTree(S.child); }
        }
        if (o.type === 'system' && o.subtype === 'hook_response' && o.hook_event === 'SessionStart') events.hooks = events.hooks || T.hooksActiveIn(o.output || o.stdout);
        if (o.type === 'assistant' && !o.parent_tool_use_id) {
          events.assistants++;
          if (opts.tool === 'claude' && events.assistants === 1 && !events.hooks) { events.abort = 'the "agent-team hooks: active" line did not appear before the first model turn'; killTree(S.child); }
        }
        if (now - lastBeat > 120000) { lastBeat = now; log(`  director running ${Math.round((now - t0) / 60000)} min, ${events.assistants} messages so far`); }
      };
      let d;
      if (opts.tool === 'claude') {
        const args = ['-p', '--plugin-dir', plugin, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
        if (opts.model) args.push('--model', opts.model);
        log('starting the Claude Director (headless)...');
        d = await runDirector({ cmd: 'claude', args, prompt, env, cwd: clone, timeoutMs: opts.timeoutMin * 60000, onEvent });
      } else {
        log('starting the Codex Director (headless)...');
        d = await runDirector({ cmd: 'codex', args: CX.execArgs({ clone, model: opts.model }), prompt, env, cwd: clone, timeoutMs: opts.timeoutMin * 60000, onEvent });
      }
      report.director = { exitCode: d.code, signal: d.signal, timedOut: d.timedOut, seconds: Math.round((Date.now() - t0) / 1000), stderrTail: redact(d.stderr.slice(-800)) };
      if (events.abort) { report.errors.push(events.abort); }
      if (d.timedOut) report.errors.push(`the Director did not finish in ${opts.timeoutMin} minutes and was stopped`);
      else if (d.code !== 0 && !events.abort) report.errors.push(`the Director exited with code ${d.code}`);
      const transcriptPath = path.join(outDir, `ci-wait-${S.run}${opts.label ? '-' + opts.label : ''}.transcript.jsonl`);

      // ---- metrics from the Director's own transcript ----
      let parsed2; let transcriptText;
      if (opts.tool === 'claude') {
        transcriptText = d.lines.join('\n');
        parsed2 = T.parseClaudeStream(transcriptText);
      } else {
        const ro = CX.directorRollout(home);
        if (!ro) { report.errors.push('no Director rollout found in the temp CODEX_HOME'); parsed2 = T.parseCodexRollout(''); transcriptText = d.lines.join('\n'); }
        else { transcriptText = ro.text; parsed2 = T.parseCodexRollout(ro.text); report.codexRollout = path.basename(ro.file); }
        parsed2.meta.hooksActive = parsed2.meta.hooksActive || T.hooksActiveIn(d.lines.join('\n'));
      }
      fs.writeFileSync(transcriptPath, redact(transcriptText));
      report.transcript = transcriptPath;
      const hk = parsed2.meta.hooksActive;
      report.hooks = { line: hk ? hk.line : null, active: !!hk, versionMatchesPlugin: hk ? hk.version === pluginInfo.version : null };
      if (!hk) report.errors.push('the "agent-team hooks: active" line was not in the Director transcript: the guard and logs were not running');
      else if (hk.version !== pluginInfo.version) report.errors.push(`hooks reported version ${hk.version}, but the plugin under test is ${pluginInfo.version}`);
      const milestone = events.milestone || parsed2.milestoneJson;
      const turnsOut = parsed2.turns.map((t) => ({ i: t.index, tokens: t.tokens, ci: t.ci, prs: t.prs, notified: t.notified.length, tools: t.tools.map((x) => ({ name: x.name, kinds: x.kinds, bg: x.background, watch: x.watch, cmd: redact(x.command.slice(0, 160)) })) }));
      report.metrics = { turns: parsed2.turnCount, contextTokens: parsed2.contextTokens, ci: parsed2.ci, watch: parsed2.watch, ciShare: parsed2.contextTokens ? +(parsed2.ci.contextTokens / parsed2.contextTokens).toFixed(3) : 0 };
      report.turns = turnsOut;

      // ---- GitHub state and logs ----
      const taskPrsR = ghJson(['pr', 'list', '--repo', opts.repo, '--state', 'all', '--base', `milestone/${S.run}`, '--json', 'number,title,state,mergedAt,headRefName', '--limit', '100']);
      const taskPrs = (taskPrsR.data || []).filter((p) => !/probe|seed/.test(p.headRefName));
      report.taskPrs = taskPrs.map((p) => ({ number: p.number, state: p.state, title: p.title }));
      const mp = milestonePr(opts, milestone);
      let rollup = [];
      if (mp) {
        const v = ghJson(['pr', 'view', String(mp.number), '--repo', opts.repo, '--json', 'statusCheckRollup,headRefOid,state']);
        rollup = (v.data && v.data.statusCheckRollup) || [];
        report.milestonePr = { number: mp.number, state: mp.state, headSha: v.data && v.data.headRefOid };
      } else report.warnings.push('no milestone PR (milestone/<run> -> main) was found');
      const logs = collectLogs(opts, clone, plugin);
      report.reconcile = logs.reconcile;
      report.reviews = L.reviewStats(logs.reviews);
      report.merges = L.mergesStats(logs.merges);
      report.merges.unresolvedStates = report.merges.unresolved.map((pr) => {
        const v = ghJson(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'state,mergedAt']);
        return { pr, ghState: v.data ? v.data.state : `unknown (${v.error})` };
      });
      report.milestone = L.milestoneTiming(milestone, events.milestoneAtMs, rollup);
      report.milestone.reportedAt = events.milestoneAtMs ? new Date(events.milestoneAtMs).toISOString() : null;
      report.milestone.checksFinishedAt = report.milestone.checks.finishedAtMs ? new Date(report.milestone.checks.finishedAtMs).toISOString() : null;
      if (!milestone) report.warnings.push('the Director printed no milestone-json line');

      // The milestone PR is the one the harness found for milestone/<run>, or the one the Director reported.
      const milestonePrs = [mp && mp.number, milestone && milestone.pr].filter((x) => x != null && x !== 0 && x !== '0').map(String);
      const breakdown = L.ciBreakdown(parsed2.turns, { taskPrs: taskPrs.map((p) => String(p.number)), milestonePrs: [...new Set(milestonePrs)] });
      report.metrics.ci.milestonePr = breakdown.milestonePr;
      report.metrics.ci.otherPr = breakdown.otherPr;
      report.metrics.ci.taskPrs = breakdown.taskPrs;
      report.metrics.ci.total = breakdown.total;
      report.metrics.ci.milestonePrNumbers = breakdown.milestonePrNumbers;
      report.targets = L.evaluateTargets({ summary: parsed2, taskPrs: taskPrs.map((p) => String(p.number)), reviews: report.reviews, milestone: report.milestone, breakdown });

      if (opts.probeAutoHead) {
        log('probing auto-merge head matching on a throwaway PR...');
        report.probeAutoHead = await probeAutoHead(opts, clone);
      }
    }
  } catch (e) {
    report.errors.push(e.message);
  }

  report.endedAt = new Date().toISOString();
  writeReport();
  report.cleanup = cleanupAll();
  writeReport();
  printSummary(report, jsonPath);
  return report.errors.length ? 1 : 0;
}

function printSummary(r, jsonPath) {
  log(`\n=== ci-wait live run: ${r.run}  label=${r.label || "-"}  tool=${r.tool}  plugin=${r.plugin ? `${r.plugin.version}@${r.plugin.commit}` : '-'} ===`);
  if (r.metrics) {
    log('\nTargets');
    log(L.renderTable(r.targets));
    const m = r.metrics;
    log('\nMetrics (Director transcript only)');
    log(`  turns: ${m.turns}   context tokens: ${m.contextTokens}`);
    log(`  CI-related turns: ${m.ci.turns} (${m.ci.contextTokens} tokens, ${(m.ciShare * 100).toFixed(1)}% of context), started by a background notification: ${m.ci.startedByNotification}`);
    log(`  per PR: ${Object.entries(m.ci.byPr).map(([pr, v]) => `#${pr}: ${v.turns} turn(s)/${v.contextTokens} tok`).join(', ') || '(none)'}; not tied to a PR: ${m.ci.unattributed.turns}`);
    log(`  --watch: ${m.watch.foreground} foreground, ${m.watch.background} background`);
    log(`  review ci values: ${JSON.stringify(r.reviews.byCi)}; pending: ${r.reviews.pending.length}`);
    log(`  merges.jsonl: ${r.merges.total} lines, ${r.merges.queued} queued, ${r.merges.unresolved.length} unresolved ${JSON.stringify(r.merges.unresolvedStates)}`);
    log(`  milestone-json: ${r.milestone.reported ? JSON.stringify(r.milestone.reported) : '(none)'}  ${r.milestone.detail}`);
    if (r.probeAutoHead) log(`  probe auto-merge head: ${r.probeAutoHead.result || (r.probeAutoHead.ran === false ? 'not run' : '?')} ${JSON.stringify(r.probeAutoHead)}`);
  }
  for (const w of r.warnings) log(`warning: ${w}`);
  for (const e of r.errors) log(`ERROR: ${e}`);
  log(`\nJSON: ${jsonPath}`);
  log('Missed targets do not change the exit code; harness errors do.');
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    log(`harness error: ${redact((e && e.stack) || e)}`);
    try { cleanupAll(); } catch (x) { /* best effort */ }
    process.exitCode = 1;
  });
} else {
  module.exports = { probeAutoHead, S };   // for tests/ci-wait-live.test.js
}
