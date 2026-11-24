// Tests for scripts/archive-logs.js. All archives go to temp dirs; never the real ~/.agent-team.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { SCRIPTS, tmpProject, bareProject, test, assert, eq } = require('./helpers');

const SCRIPT = path.join(SCRIPTS, 'archive-logs.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-arch-'));

// AGENT_TEAM_PROJECTS_ROOT defaults to an empty folder, so no test reads the real ~/.claude/projects.
function arch(proj, args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: proj, encoding: 'utf8', env: { ...process.env, AGENT_TEAM_ARCHIVE: tmp(), AGENT_TEAM_PROJECTS_ROOT: tmp(), ...env },
  });
}
function project(files = { 'delegations.jsonl': '' }) {
  const p = tmpProject();
  const d = path.join(p, '.agent-team', 'logs');
  fs.mkdirSync(path.join(d, '.pending'), { recursive: true });
  fs.writeFileSync(path.join(d, '.gitkeep'), '');
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
  return p;
}
const rec = (m, v = '0.3.0') => JSON.stringify({ guidance_version: v, task: { milestone: m } });
const destOf = (r) => r.stdout.trim().split('\n').pop();
const logs = (p) => path.join(p, '.agent-team', 'logs');

test('archive: README counts lines with a top-level milestone (reviews, merges, pauses), once each', () => {
  const reviews = [
    JSON.stringify({ guidance_version: '0.4.4', milestone: 'm1', task: { id: 'M1-1' } }),
    JSON.stringify({ guidance_version: '0.4.4', milestone: 'm1', task: { milestone: 'm1' } }),
    JSON.stringify({ guidance_version: '0.4.4', milestone: 'm2' }),
    JSON.stringify({ guidance_version: '0.4.4' }),
  ].join('\n');
  const p = project({ 'reviews.jsonl': reviews, 'delegations.jsonl': [rec('m1'), rec('m2')].join('\n') });
  const r = arch(p, ['m1', '--project', 'proj']);
  eq(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(destOf(r), 'README.md'), 'utf8');
  // Two m1 lines: one top-level only (the old counter missed it), one with both fields (counted once).
  assert(md.includes('`reviews.jsonl`: 4 line(s), 2 for milestone `m1`'), md);
  assert(md.includes('`delegations.jsonl`: 2 line(s), 1 for milestone `m1`'), md);
});

test('archive: run from a git worktree, archives the main checkout\'s logs', () => {
  const p = project({ 'delegations.jsonl': rec('m1') });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: p });
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(tmp(), 'wt');
  git('worktree', 'add', '-q', '-b', 'task/T-2', wt);
  const r = arch(wt, ['m1', '--project', 'proj']);
  eq(r.status, 0, r.stderr);
  assert(fs.existsSync(path.join(destOf(r), 'delegations.jsonl')), 'the main checkout\'s log was copied');
});

test('archive: copies, writes README, leaves originals', () => {
  const content = [rec('m1'), rec('m2', '0.2.1'), 'not json', ''].join('\n');
  const p = project({ 'a.jsonl': content, 'empty.jsonl': '' });
  const r = arch(p, ['m1', '--project', 'proj']);
  eq(r.status, 0, r.stderr);
  const dest = destOf(r);
  assert(/proj[\\/]\d{4}-\d\d-\d\d-m1$/.test(dest), dest);
  eq(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8'), content, 'copy');
  assert(fs.existsSync(path.join(dest, 'empty.jsonl')), 'empty copied');
  assert(!fs.existsSync(path.join(dest, '.gitkeep')), 'gitkeep not copied');
  assert(!fs.existsSync(path.join(dest, '.pending')), 'pending not copied');
  const md = fs.readFileSync(path.join(dest, 'README.md'), 'utf8');
  assert(/^# agent-team logs — milestone m1 \(\d{4}-\d\d-\d\d\)/.test(md), 'title');
  assert(md.includes('Project: proj'), 'project');
  assert(md.includes('0.2.1, 0.3.0'), 'versions');
  assert(md.includes('`a.jsonl`: 3 line(s), 1 for milestone `m1`, 1 malformed'), md);
  assert(md.includes('`empty.jsonl`: 0 line(s)'), 'empty');
  assert(md.includes('Originals left in place.'), 'left');
  assert(md.includes('`.pending/` was not copied'), 'pending note');
  assert(!md.includes(os.tmpdir()), 'no absolute paths');
  eq(fs.readFileSync(path.join(logs(p), 'a.jsonl'), 'utf8'), content, 'original untouched');
});

test('archive: stale .pending removed, fresh kept, logs untouched', () => {
  const p = project();
  const pd = path.join(logs(p), '.pending');
  const old = path.join(pd, 'old');
  const fresh = path.join(pd, 'fresh');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(fresh, '{}');
  const t = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(old, t, t);
  const r = arch(p, ['m', '--project', 'x']);
  eq(r.status, 0, r.stderr);
  assert(!fs.existsSync(old), 'stale deleted');
  assert(fs.existsSync(fresh), 'fresh kept');
  assert(r.stdout.includes('deleted 1 stale, kept 1'), r.stdout);
  assert(fs.existsSync(path.join(logs(p), 'delegations.jsonl')), 'log kept');
});

const leftovers = (root) => fs.readdirSync(path.join(root, 'x')).filter((n) => n.includes('.tmp-'));

test('archive: existing destination refused, nothing changed; --force replaces only the files it writes', () => {
  const content = rec('m') + '\n';
  const p = project({ 'a.jsonl': content });
  const root = tmp();
  const args = ['m', '--project', 'x', '--root', root];
  const first = arch(p, args);
  eq(first.status, 0, first.stderr);
  const dest = destOf(first);
  fs.writeFileSync(path.join(dest, 'marker'), 'x');
  fs.mkdirSync(path.join(dest, 'notes'));
  fs.writeFileSync(path.join(dest, 'notes', 'n.txt'), 'keep');
  fs.writeFileSync(path.join(dest, 'other.jsonl'), 'not ours');
  fs.writeFileSync(path.join(dest, 'a.jsonl'), 'stale copy');
  fs.writeFileSync(path.join(dest, 'README.md'), 'old readme');
  const again = arch(p, args);
  eq(again.status, 1, 'refused');
  assert(/already exists/.test(again.stderr), again.stderr);
  eq(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8'), 'stale copy', 'untouched on refusal');
  eq(leftovers(root).length, 0, 'no temp folder after refusal');
  const forced = arch(p, [...args, '--force']);
  eq(forced.status, 0, forced.stderr);
  eq(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8'), content, 'copied file replaced');
  assert(fs.readFileSync(path.join(dest, 'README.md'), 'utf8').includes('Project: x'), 'README replaced');
  eq(fs.readFileSync(path.join(dest, 'marker'), 'utf8'), 'x', 'unrelated file survives');
  eq(fs.readFileSync(path.join(dest, 'notes', 'n.txt'), 'utf8'), 'keep', 'unrelated folder survives');
  eq(fs.readFileSync(path.join(dest, 'other.jsonl'), 'utf8'), 'not ours', 'unrelated jsonl survives');
  eq(leftovers(root).length, 0, 'no temp folder after --force');
});

test('archive: verify failure (fresh) removes the temp copy and leaves no destination', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n' });
  const root = tmp();
  const args = ['m', '--project', 'x', '--root', root];
  const r = arch(p, args, { AGENT_TEAM_ARCHIVE_TEST_FAIL_VERIFY: '1' });
  eq(r.status, 1, 'failed');
  // Precondition: the failure came from the verify step, which runs after the file was copied.
  assert(/verification failed for a\.jsonl/.test(r.stderr), r.stderr);
  assert(!/at .*\.js:\d+/.test(r.stderr), 'no stack trace');
  eq(fs.readdirSync(path.join(root, 'x')).length, 0, 'no dest and no temp folder');
  eq(fs.readFileSync(path.join(logs(p), 'a.jsonl'), 'utf8'), rec('m') + '\n', 'live log untouched');
  // One step past: a clean retry works.
  const retry = arch(p, args);
  eq(retry.status, 0, retry.stderr);
});

test('archive: verify failure with --force leaves the old archive intact and no temp copy', () => {
  const p = project({ 'a.jsonl': rec('new') + '\n' });
  const root = tmp();
  const args = ['m', '--project', 'x', '--root', root, '--force'];
  const first = arch(p, args);
  eq(first.status, 0, first.stderr);
  const dest = destOf(first);
  fs.writeFileSync(path.join(dest, 'marker'), 'x');
  fs.writeFileSync(path.join(dest, 'a.jsonl'), 'old archive data');
  const readmeBefore = fs.readFileSync(path.join(dest, 'README.md'), 'utf8');
  const r = arch(p, args, { AGENT_TEAM_ARCHIVE_TEST_FAIL_VERIFY: '1' });
  eq(r.status, 1, 'failed');
  assert(/verification failed for a\.jsonl/.test(r.stderr), r.stderr);
  eq(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8'), 'old archive data', 'old copy intact');
  eq(fs.readFileSync(path.join(dest, 'marker'), 'utf8'), 'x', 'unrelated file intact');
  eq(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), readmeBefore, 'old README intact');
  eq(leftovers(root).length, 0, 'no temp folder');
  // One step past: a clean --force retry now replaces the copy.
  const retry = arch(p, args);
  eq(retry.status, 0, retry.stderr);
  eq(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8'), rec('new') + '\n', 'replaced on retry');
});

test('archive: --clear skips a live log that changed after verification, deletes the unchanged ones', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n', 'b.jsonl': rec('m') + '\n' });
  const r = arch(p, ['m', '--project', 'x', '--clear'], { AGENT_TEAM_ARCHIVE_TEST_APPEND_AFTER_VERIFY: 'a.jsonl' });
  eq(r.status, 0, r.stderr);
  // Precondition: the late write really landed in the live log.
  assert(fs.readFileSync(path.join(logs(p), 'a.jsonl'), 'utf8').includes('late write'), 'late write present');
  assert(/Not cleared.*a\.jsonl/.test(r.stdout), r.stdout);
  assert(!fs.existsSync(path.join(logs(p), 'b.jsonl')), 'unchanged log cleared');
  assert(r.stdout.includes('Cleared 1 live log'), r.stdout);
  assert(!fs.readFileSync(path.join(destOf(r), 'a.jsonl'), 'utf8').includes('late write'), 'archive has the verified content');
});

test('archive: --clear unlink error exits non-zero with a message and no stack trace', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n' });
  const root = tmp();
  const r = arch(p, ['m', '--project', 'x', '--root', root, '--clear'], { AGENT_TEAM_ARCHIVE_TEST_UNLINK_FAIL: '1' });
  eq(r.status, 1, 'non-zero');
  assert(/could not delete a\.jsonl: EPERM/.test(r.stderr), r.stderr);
  assert(!/at .*\.js:\d+/.test(r.stderr), 'no stack trace');
  assert(fs.existsSync(path.join(logs(p), 'a.jsonl')), 'live log kept');
  const archived = fs.readdirSync(path.join(root, 'x'));
  eq(archived.length, 1, 'archive complete, no temp folder');
  assert(fs.existsSync(path.join(root, 'x', archived[0], 'a.jsonl')), 'archive has the log');
});

test('archive: stale sweep leaves dotfiles such as .gitkeep in .pending', () => {
  const p = project();
  const pd = path.join(logs(p), '.pending');
  const keep = path.join(pd, '.gitkeep');
  const old = path.join(pd, 'old');
  fs.writeFileSync(keep, '');
  fs.writeFileSync(old, '{}');
  const t = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(keep, t, t);
  fs.utimesSync(old, t, t);
  const r = arch(p, ['m', '--project', 'x']);
  eq(r.status, 0, r.stderr);
  assert(!fs.existsSync(old), 'stale entry deleted (sweep ran)');
  assert(fs.existsSync(keep), '.gitkeep kept');
});

test('archive: --clear deletes live logs after verified copy and says cleared', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n' });
  const r = arch(p, ['m', '--project', 'x', '--clear']);
  eq(r.status, 0, r.stderr);
  assert(!fs.existsSync(path.join(logs(p), 'a.jsonl')), 'live log deleted');
  const dest = destOf(r);
  assert(fs.readFileSync(path.join(dest, 'README.md'), 'utf8').includes('cleared'), 'readme says cleared');
  assert(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8').length > 0, 'archive has data');
});

test('archive: --dry-run writes nothing and deletes nothing', () => {
  const p = project();
  const old = path.join(logs(p), '.pending', 'old');
  fs.writeFileSync(old, '{}');
  const t = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(old, t, t);
  const root = tmp();
  const r = arch(p, ['m', '--project', 'x', '--root', root, '--clear', '--dry-run']);
  eq(r.status, 0, r.stderr);
  eq(fs.readdirSync(root).length, 0, 'root empty');
  assert(fs.existsSync(old), 'stale kept');
  assert(fs.existsSync(path.join(logs(p), 'delegations.jsonl')), 'log kept');
  assert(r.stdout.includes('dry-run'), r.stdout);
});

test('archive: no logs folder, or no jsonl, exits 1 with a message', () => {
  const p = bareProject();
  let r = arch(p, ['m', '--project', 'x']);
  eq(r.status, 1, 'no folder');
  assert(/no \.agent-team\/logs/.test(r.stderr), r.stderr);
  fs.mkdirSync(logs(p), { recursive: true });
  fs.writeFileSync(path.join(logs(p), '.gitkeep'), '');
  const root = tmp();
  r = arch(p, ['m', '--project', 'x', '--root', root]);
  eq(r.status, 1, 'no jsonl');
  assert(/no \.jsonl/.test(r.stderr), r.stderr);
  eq(fs.readdirSync(root).length, 0, 'nothing written');
});

test('archive: project name derived from origin remote (https, ssh, .git, none)', () => {
  const cases = [
    ['https://github.com/Owner/repo-a.git', 'repo-a'],
    ['https://github.com/Owner/repo-b', 'repo-b'],
    ['git@github.com:Owner/repo-c.git', 'repo-c'],
    ['ssh://git@host.example/Owner/repo-d', 'repo-d'],
  ];
  for (const [url, name] of cases) {
    const p = project();
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: p });
    const r = arch(p, ['m']);
    eq(r.status, 0, r.stderr);
    eq(path.basename(path.dirname(destOf(r))), name, url);
  }
  const p = project();
  const r = arch(p, ['m']);
  eq(r.status, 0, r.stderr);
  eq(path.basename(path.dirname(destOf(r))), path.basename(fs.realpathSync(p)), 'folder-name fallback');
});

test('archive: milestone with "/" or spaces rejected, nothing written', () => {
  const p = project();
  for (const bad of ['a/b', 'a b', '..', '']) {
    const root = tmp();
    const r = arch(p, [bad, '--project', 'x', '--root', root]);
    eq(r.status, 1, `rejected "${bad}"`);
    eq(fs.readdirSync(root).length, 0, 'nothing written');
  }
});

test('archive: archive root may be a git repo (files only, no commits)', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n' });
  const root = tmp();
  execFileSync('git', ['init', '-q'], { cwd: root });
  const r = arch(p, ['m', '--project', 'x', '--root', root]);
  eq(r.status, 0, r.stderr);
  const log = spawnSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf8' });
  assert(log.status !== 0 || log.stdout.trim() === '', 'no commits made');
});

test('archive: warns about unresolved auto-merge-queued merges (offline), exit code unchanged; resolved ones are not counted', () => {
  const q = (pr, ts) => JSON.stringify({ ts, pr, outcome: 'auto-merge-queued', milestone: 'm1' });
  const res = JSON.stringify({ ts: 't9', pr: '2', outcome: 'merged', resolves_ts: 't2', milestone: 'm1' });
  const p = project({ 'merges.jsonl': [q('1', 't1'), q('2', 't2'), res].join('\n') });
  const ghRan = path.join(p, 'gh-ran');
  const gh = path.join(p, 'fake-gh.js');
  fs.writeFileSync(gh, "require('fs').writeFileSync(process.env.GH_RAN, 'x'); process.exit(1);");
  const env = { AGENT_TEAM_FAKE_GH: gh, GH_RAN: ghRan };
  const msg = '1 auto-merge-queued merges unresolved; run reconcile-logs.js --merges first';
  const dry = arch(p, ['m1', '--project', 'proj', '--dry-run'], env);
  eq(dry.status, 0, dry.stderr);
  assert(dry.stdout.includes(msg), dry.stdout);
  const r = arch(p, ['m1', '--project', 'proj'], env);
  eq(r.status, 0, r.stderr);
  assert(r.stdout.includes(msg), r.stdout);
  eq(fs.existsSync(ghRan), false, 'the archive never calls the forge');
  const none = arch(project({ 'merges.jsonl': res }), ['m1', '--project', 'proj']);
  assert(!none.stdout.includes('unresolved'), 'nothing unresolved: no warning');
  // An older queued line of a PR with a newer queued line is superseded: only the newer one counts.
  const sup = arch(project({ 'merges.jsonl': [q('5', 'a1'), q('5', 'a2')].join('\n') }), ['m1', '--project', 'proj']);
  assert(sup.stdout.includes('1 auto-merge-queued merges unresolved'), sup.stdout);
});

// --- usage the hooks missed: G18 (turns after the hand-back) and G19 (the Director's own usage) ---

const U = (input, output, cacheRead, cacheWrite) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const SECRET = 'SECRET-TRANSCRIPT-TEXT-do-not-copy';
// An assistant entry of a Director transcript; `text` is what must never reach the logs.
const call = (id, model, usage, ts, text = SECRET) => ({ type: 'assistant', timestamp: ts, message: { id, model, usage, content: [{ type: 'text', text }] } });
const card = (n) => `TASK id=AU-1 type=implement difficulty=easy milestone=m1 attempt=${n}`;

// Each JSON line of a transcript body with the cwd Claude Code records (the archive reads only
// transcripts recorded in this project, FU-18); a line that does not parse is kept as it is.
const withCwd = (body, cwd) => body.split('\n').map((l) => {
  try { const e = JSON.parse(l); return e && typeof e === 'object' && !Array.isArray(e) ? JSON.stringify({ cwd, ...e }) : l; } catch { return l; }
}).join('\n');

// Projects root with a Director transcript per session id, and optional subagent transcripts of the first session.
function usageSetup({ sessions = {}, agents = {}, delegations = [], completions = [] } = {}) {
  const p = project({ 'delegations.jsonl': jl(delegations), 'completions.jsonl': jl(completions) });
  const root = tmp();
  const folder = path.join(root, 'proj-folder');
  fs.mkdirSync(folder, { recursive: true });
  for (const [id, body] of Object.entries(sessions)) fs.writeFileSync(path.join(folder, `${id}.jsonl`), withCwd(body, p));
  for (const [sid, list] of Object.entries(agents)) {
    const dir = path.join(folder, sid, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    for (const [aid, rows] of Object.entries(list)) fs.writeFileSync(path.join(dir, `agent-${aid}.jsonl`), withCwd(jl(rows), p));
  }
  return { p, root, env: { AGENT_TEAM_PROJECTS_ROOT: root } };
}
const del = (sid, extra = {}) => ({ ts: 't', tool: 'claude', session_id: sid, kind: 'subagent', agent: 'agent-team:implementer', agent_id: `ag-${sid}`, task: { id: 'AU-1', milestone: 'm1', attempt: '1' }, ...extra });
const readLive = (p, f) => {
  try { return fs.readFileSync(path.join(logs(p), f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

test('archive G19: one session_usage line per session and model, each message id once, no transcript text, copied into the archive', () => {
  const director = jl([
    { type: 'user', message: { role: 'user', content: SECRET } },
    call('a1', 'claude-fable-5-2', U(10, 20, 1000, 100), '2026-11-01T10:00:00.000Z'),
    call('a1', 'claude-fable-5-2', U(10, 20, 1000, 100), '2026-11-01T10:00:01.000Z'), // the same message id again: counted once
    call('a2', 'claude-fable-5-2', U(1, 2, 3, 4), '2026-11-01T11:00:00.000Z'),
    call('b1', 'claude-sonnet-5-5', U(5, 5, 5, 5), '2026-11-01T09:00:00.000Z'),
    { ...call('c1', 'claude-haiku-4-5', U(9, 9, 9, 9), '2026-11-01T09:30:00.000Z'), isSidechain: true }, // a subagent's call, not the Director's
    call('s1', '<synthetic>', U(0, 0, 0, 0), '2026-11-01T09:31:00.000Z'),
  ]);
  const s = usageSetup({ sessions: { 'dir-1': director }, delegations: [del('dir-1'), del('dir-1', { kind: 'resume', agent_id: 'ag-dir-1' })] });
  const r = arch(s.p, ['m1', '--project', 'proj'], s.env);
  eq(r.status, 0, r.stderr);
  assert(r.stdout.includes('usage: 1 sessions, 0 not found; 2 session_usage lines written'), r.stdout);
  const lines = readLive(s.p, 'sessions.jsonl');
  eq(lines.length, 2, 'one line per model');
  const fable = lines.find((l) => l.model === 'claude-fable-5-2');
  const sonnet = lines.find((l) => l.model === 'claude-sonnet-5-5');
  eq(fable.kind, 'session_usage', 'kind');
  eq(fable.session_id, 'dir-1', 'session id');
  eq(fable.milestone, 'm1', 'milestone');
  eq(fable.calls, 2, 'two message ids');
  eq(JSON.stringify(fable.tokens_by_class), JSON.stringify({ input: 11, output: 22, cache_read: 1003, cache_write: 104 }), 'a1 once, plus a2');
  eq(fable.first, '2026-11-01T10:00:00.000Z', 'first');
  eq(fable.last, '2026-11-01T11:00:00.000Z', 'last');
  eq(sonnet.calls, 1, 'second model');
  eq(JSON.stringify(sonnet.tokens_by_class), JSON.stringify({ input: 5, output: 5, cache_read: 5, cache_write: 5 }), 'sonnet classes');
  const dest = destOf(r);
  const archived = fs.readFileSync(path.join(dest, 'sessions.jsonl'), 'utf8');
  eq(archived, fs.readFileSync(path.join(logs(s.p), 'sessions.jsonl'), 'utf8'), 'the archive holds the lines');
  for (const f of fs.readdirSync(dest)) assert(!fs.readFileSync(path.join(dest, f), 'utf8').includes(SECRET), `no transcript text in ${f}`);
  assert(fs.readFileSync(path.join(dest, 'README.md'), 'utf8').includes('`sessions.jsonl`: 2 line(s)'), 'README counts the file');
});

test('archive G19: a rerun writes nothing; a line is written only for the model whose totals changed; the last line wins', () => {
  const first = [call('a1', 'claude-fable-5-2', U(10, 20, 1000, 100), '2026-11-01T10:00:00.000Z'), call('b1', 'claude-sonnet-5-5', U(5, 5, 5, 5), '2026-11-01T09:00:00.000Z')];
  const s = usageSetup({ sessions: { 'dir-1': jl(first) }, delegations: [del('dir-1')] });
  arch(s.p, ['m1', '--project', 'proj'], s.env);
  eq(readLive(s.p, 'sessions.jsonl').length, 2, 'precondition: two lines after the first run');
  const again = arch(s.p, ['m1', '--project', 'proj', '--force'], s.env);
  eq(again.status, 0, again.stderr);
  assert(again.stdout.includes('0 session_usage lines written'), again.stdout);
  eq(readLive(s.p, 'sessions.jsonl').length, 2, 'unchanged totals: no new line');
  // The session goes on: only the fable totals change.
  fs.appendFileSync(path.join(s.root, 'proj-folder', 'dir-1.jsonl'), jl([call('a3', 'claude-fable-5-2', U(1, 1, 1, 1), '2026-11-01T12:00:00.000Z')]));
  const grown = arch(s.p, ['m1', '--project', 'proj', '--force'], s.env);
  assert(grown.stdout.includes('1 session_usage line written'), grown.stdout);
  const lines = readLive(s.p, 'sessions.jsonl');
  eq(lines.length, 3, 'one new line');
  eq(lines[2].model, 'claude-fable-5-2', 'for the model that changed');
  eq(lines[2].calls, 2, 'its new total');
  eq(lines[2].last, '2026-11-01T12:00:00.000Z', 'its new last call');
  const after = arch(s.p, ['m1', '--project', 'proj', '--force'], s.env);
  assert(after.stdout.includes('0 session_usage lines written'), after.stdout);
  eq(readLive(s.p, 'sessions.jsonl').length, 3, 'one step past: still three');
});

test('archive G19: a missing, a torn and an unreadable transcript are counted and never change the exit code or stop the others', () => {
  const good = jl([call('g1', 'claude-fable-5-2', U(1, 1, 1, 1), '2026-11-01T10:00:00.000Z')]);
  const tornTail = jl([call('t1', 'claude-fable-5-2', U(2, 2, 2, 2), '2026-11-01T10:00:00.000Z')]) + '{"type":"assistant","message":{"id":"t2","usa';
  const s = usageSetup({
    sessions: { 'dir-bad': 'not json at all\n{"half', 'dir-tail': tornTail, 'dir-good': good },
    delegations: [del('dir-missing'), del('dir-bad'), del('dir-tail'), del('dir-good'), del('dir-dir')],
  });
  fs.mkdirSync(path.join(s.root, 'proj-folder', 'dir-dir.jsonl')); // unreadable: a folder where the transcript should be
  const r = arch(s.p, ['m1', '--project', 'proj'], s.env);
  eq(r.status, 0, `exit code unchanged: ${r.stderr}`);
  assert(r.stdout.includes('usage: 5 sessions, 3 not found; 2 session_usage lines written; 1 unreadable transcript line skipped'), r.stdout);
  const ids = readLive(s.p, 'sessions.jsonl').map((l) => l.session_id).sort();
  eq(JSON.stringify(ids), JSON.stringify(['dir-good', 'dir-tail']), 'the readable ones were recorded, the torn tail did not stop its own complete lines');
  assert(fs.existsSync(path.join(destOf(r), 'sessions.jsonl')), 'the archive was still made');
  // recovery: once the missing transcript exists, the next run records it
  fs.writeFileSync(path.join(s.root, 'proj-folder', 'dir-missing.jsonl'), withCwd(good, s.p));
  const next = arch(s.p, ['m1', '--project', 'proj', '--force'], s.env);
  assert(next.stdout.includes('4 not found') === false && next.stdout.includes('2 not found; 1 session_usage line written'), next.stdout);
});

test('archive G19: Codex sessions and Codex agents are skipped with a printed count; other milestones are not read', () => {
  const good = jl([call('g1', 'claude-fable-5-2', U(1, 1, 1, 1), '2026-11-01T10:00:00.000Z')]);
  const s = usageSetup({
    sessions: { 'dir-claude': good, 'dir-other': good },
    delegations: [
      del('dir-claude'),
      del('cx-session', { tool: 'codex', agent_id: 'cx-agent' }),
      del('dir-other', { task: { id: 'AU-9', milestone: 'm2' } }),
    ],
    completions: [{ ts: 't', tool: 'codex', session_id: 'cx-session', kind: 'completion', agent: 'x', agent_id: 'cx-agent', turn: 1, task: { id: 'AU-1', milestone: 'm1' }, tokens_with_cache: 5 }],
  });
  const r = arch(s.p, ['m1', '--project', 'proj'], s.env);
  eq(r.status, 0, r.stderr);
  assert(r.stdout.includes('completions: 0 superseded with the full turn\'s tokens, 0 transcripts not found, 1 Codex agents skipped'), r.stdout);
  assert(r.stdout.includes('usage: 1 sessions, 0 not found, 1 Codex sessions skipped; 1 session_usage line written'), r.stdout);
  eq(JSON.stringify(readLive(s.p, 'sessions.jsonl').map((l) => l.session_id)), JSON.stringify(['dir-claude']), 'only the Claude session of this milestone');
});

test('archive G19/G18: --dry-run reads but writes nothing, not even the archive folder', () => {
  const wake = [
    { type: 'user', isMeta: false, timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: card(1) } },
    { type: 'assistant', timestamp: '2026-11-01T10:00:05.000Z', message: { id: 'w0', model: 'claude-sonnet-5-5', usage: U(10, 20, 100, 5), content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'done' } }] } },
    { type: 'assistant', timestamp: '2026-11-01T10:01:05.000Z', message: { id: 'w1', model: 'claude-sonnet-5-5', usage: U(5, 50, 200, 0), content: [{ type: 'text', text: 'woken' }] } },
  ];
  const comp = { ts: 't', tool: 'claude', session_id: 'dir-1', kind: 'completion', agent: 'agent-team:implementer', agent_id: 'ag-dir-1', turn: 1, task: { id: 'AU-1', milestone: 'm1', attempt: '1' }, tokens_with_cache: 135 };
  const s = usageSetup({
    sessions: { 'dir-1': jl([call('a1', 'claude-fable-5-2', U(1, 1, 1, 1), '2026-11-01T10:00:00.000Z')]) },
    agents: { 'dir-1': { 'ag-dir-1': wake } },
    delegations: [del('dir-1')], completions: [comp],
  });
  const archiveRoot = tmp();
  const before = fs.readFileSync(path.join(logs(s.p), 'completions.jsonl'), 'utf8');
  const dry = arch(s.p, ['m1', '--project', 'proj', '--root', archiveRoot, '--dry-run'], s.env);
  eq(dry.status, 0, dry.stderr);
  assert(dry.stdout.includes('[dry-run] completions: 1 would be superseded'), dry.stdout);
  assert(dry.stdout.includes('[dry-run] usage: 1 sessions, 0 not found; 1 session_usage line would be written'), dry.stdout);
  eq(fs.existsSync(path.join(logs(s.p), 'sessions.jsonl')), false, 'no sessions.jsonl');
  eq(fs.readFileSync(path.join(logs(s.p), 'completions.jsonl'), 'utf8'), before, 'completions.jsonl untouched');
  eq(fs.readdirSync(archiveRoot).length, 0, 'nothing in the archive root');
  // recovery control: the same setup, not dry, writes both
  const real = arch(s.p, ['m1', '--project', 'proj', '--root', archiveRoot], s.env);
  eq(real.status, 0, real.stderr);
  eq(readLive(s.p, 'sessions.jsonl').length, 1, 'a real run writes the session line');
  const cs = readLive(s.p, 'completions.jsonl');
  eq(cs.length, 2, 'and the superseding line');
  eq(cs[1].tokens_with_cache, 390, 'with the full turn (135 + 255)');
  assert(typeof cs[1].reconciled_by === 'string' && cs[1].reconciled_by, 'reconciled_by set');
});

test('archive G18: the superseding line is written before the copy, so the archive holds it; a rerun adds none', () => {
  const nudged = [
    { type: 'user', isMeta: false, timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: card(1) } },
    { type: 'assistant', timestamp: '2026-11-01T10:00:05.000Z', message: { id: 'n0', model: 'claude-sonnet-5-5', usage: U(10, 20, 100, 5), content: [{ type: 'text', text: 'report without the tool' }] } },
    { type: 'user', isMeta: true, timestamp: '2026-11-01T10:00:06.000Z', message: { role: 'user', content: '[handback-send-enforce] Your report has not been delivered.' } },
    { type: 'assistant', timestamp: '2026-11-01T10:00:09.000Z', message: { id: 'n1', model: 'claude-sonnet-5-5', usage: U(7, 30, 150, 0), content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'done' } }] } },
  ];
  const comp = { ts: 't', tool: 'claude', session_id: 'dir-1', kind: 'completion', agent: 'agent-team:implementer', agent_id: 'ag-dir-1', turn: 1, task: { id: 'AU-1', milestone: 'm1', attempt: '1' }, tokens_with_cache: 135, report_source: 'hook-input' };
  const s = usageSetup({ sessions: {}, agents: { 'dir-1': { 'ag-dir-1': nudged } }, delegations: [del('dir-1')], completions: [comp] });
  const r = arch(s.p, ['m1', '--project', 'proj'], s.env);
  eq(r.status, 0, r.stderr);
  assert(r.stdout.includes("completions: 1 superseded with the full turn's tokens, 0 transcripts not found"), r.stdout);
  const archived = fs.readFileSync(path.join(destOf(r), 'completions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  eq(archived.length, 2, 'the archive holds the original and the superseding line');
  eq(archived[1].tokens_with_cache, 322, 'the full turn: 135 + 187');
  eq(archived[1].report_source, 'hook-input', 'the rest of the line is the line it supersedes');
  assert(archived[1].reconciled_by, 'reconciled_by');
  const again = arch(s.p, ['m1', '--project', 'proj', '--force'], s.env);
  assert(again.stdout.includes('completions: 0 superseded'), again.stdout);
  eq(readLive(s.p, 'completions.jsonl').length, 2, 'a rerun adds nothing');
  // a transcript that is not found is counted, and the archive still succeeds
  const gone = usageSetup({ delegations: [del('dir-1')], completions: [comp] });
  const g = arch(gone.p, ['m1', '--project', 'proj'], gone.env);
  eq(g.status, 0, g.stderr);
  assert(g.stdout.includes('completions: 0 superseded with the full turn\'s tokens, 1 transcripts not found'), g.stdout);
});

test('archive FU-24: --clear does not delete a live log that became a link after verification, and exits non-zero', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n', 'b.jsonl': rec('m') + '\n' });
  const r = arch(p, ['m', '--project', 'x', '--clear'], { AGENT_TEAM_ARCHIVE_TEST_LINK_AFTER_VERIFY: 'a.jsonl' });
  // Precondition: the swap happened (a second name for the file) and the content still matched the verified hash.
  eq(fs.lstatSync(path.join(logs(p), 'a.jsonl')).nlink, 2, 'precondition: a.jsonl has another name now');
  eq(r.status, 1, 'non-zero: ' + r.stderr);
  assert(/Not cleared \(now a link.*a\.jsonl/.test(r.stderr), r.stderr);
  assert(fs.existsSync(path.join(logs(p), 'a.jsonl')), 'the linked name is left alone');
  assert(!fs.existsSync(path.join(logs(p), 'b.jsonl')), 'control: an ordinary log is still cleared');
  assert(r.stdout.includes('Cleared 1 live log'), r.stdout);
});

test('archive FU-24: a stale .pending entry with a second name is not deleted, and stderr says so; an ordinary stale one still is', () => {
  const p = project();
  const pend = path.join(logs(p), '.pending');
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const linked = path.join(pend, 'stop-linked');
  const plain = path.join(pend, 'stop-plain');
  fs.writeFileSync(linked, 'x');
  fs.writeFileSync(plain, 'x');
  fs.linkSync(linked, path.join(p, 'elsewhere'));
  for (const f of [linked, plain]) fs.utimesSync(f, old, old);
  eq(fs.lstatSync(linked).nlink, 2, 'precondition: the entry has a second name');
  const r = arch(p, ['m', '--project', 'x']);
  eq(r.status, 0, r.stderr);
  assert(/stale \.pending entry not deleted.*stop-linked/.test(r.stderr), r.stderr);
  assert(fs.existsSync(linked), 'the linked entry is kept');
  assert(!fs.existsSync(plain), 'control: the ordinary stale entry is deleted');
});

test('archive FU-24: the link-after-verify test hook takes a plain file name only', () => {
  for (const bad of ['../a.jsonl', 'sub/a.jsonl', '..']) {
    const p = project({ 'a.jsonl': rec('m') + '\n' });
    const r = arch(p, ['m', '--project', 'x', '--clear'], { AGENT_TEAM_ARCHIVE_TEST_LINK_AFTER_VERIFY: bad });
    eq(r.status, 1, `${bad}: refused`);
    assert(/must be a plain file name/.test(r.stderr), r.stderr);
    assert(fs.existsSync(path.join(logs(p), 'a.jsonl')), `${bad}: nothing deleted`);
  }
});
