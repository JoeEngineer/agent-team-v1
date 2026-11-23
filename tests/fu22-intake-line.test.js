// FU-22 (decision 0029): the intake line of the xlarge grant is written once per slug, by
// `log-event.js milestone`, in the log `status.js grant` reads; and the environment cannot move
// either of them to another project.
// Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, SCRIPTS, NO_MODELS_FILE, test, assert, eq } = require('./helpers');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-fu22-'));
let n = 0;
const project = () => { const d = path.join(DIR, `p${n++}`); fs.mkdirSync(d); return d; };
const logFile = (p) => path.join(p, '.agent-team', 'logs', 'milestones.jsonl');
const raw = (p) => (fs.existsSync(logFile(p)) ? fs.readFileSync(logFile(p), 'utf8') : null);
const rows = (p) => (raw(p) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const deq = (a, b, m) => eq(JSON.stringify(a), JSON.stringify(b), m);

// The caller's CLAUDE_PROJECT_DIR and GIT_* are dropped, then `env` is added: each test names its own.
function baseEnv(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k) && k !== 'CLAUDE_PROJECT_DIR' && k !== 'NODE_OPTIONS'));
  return { ...clean, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE, CLAUDE_CODE_SESSION_ID: 'sess-fu22', ...env };
}
function intake(cwd, data, env = {}) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), 'milestone', '-'], { cwd, input: typeof data === 'string' ? data : JSON.stringify(data), encoding: 'utf8', timeout: 20000, env: baseEnv(env) });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
function grant(cwd, slug, env = {}) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'status.js'), 'grant', '--milestone', slug], { cwd, encoding: 'utf8', timeout: 20000, env: baseEnv(env) });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch { /* checked by the caller */ }
  return { code: r.status, json, out: r.stdout };
}
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: 20000 });
  assert(r.status === 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function repo() {
  const d = project();
  g(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
  g(d, 'add', 'a.txt');
  g(d, 'commit', '-q', '-m', 'x');
  return d;
}

const CLOSE = ['security-review-close'];
const ALL = ['security-review-close', 'security-review-task'];
const line = (slug, roles, second = 'none') => ({ milestone: slug, xlarge_grant: roles, second_review: second, map_source: 'default' });
const STATUS = (slug, roles, second) => `# Status\n\n## Current milestone\n\n**${slug}**: a goal\n\n## xlarge grant\n\n- Granted roles: ${roles}\n- Second security review: ${second}\n`;

test('FU-22 milestone: a valid intake line is written, and status.js grant reads it back', () => {
  const p = project();
  const r = intake(p, line('m1', [...ALL, 'architect'], 'large'));
  eq(r.status, 0, r.err);
  assert(/logged milestone/.test(r.out), r.out);
  const [row] = rows(p);
  eq(rows(p).length, 1, 'one line');
  deq([row.milestone, row.xlarge_grant, row.second_review, row.map_source], ['m1', [...ALL, 'architect'], 'large', 'default'], 'the fields as given');
  assert(row.ts && row.session_id === 'sess-fu22' && row.guidance_version, `ts, session and guidance version are added: ${JSON.stringify(row)}`);
  fs.writeFileSync(path.join(p, 'STATUS.md'), STATUS('m1', 'all security reviews, architect', 'large/high'));
  const gr = grant(p, 'm1');
  eq(gr.code, 0, gr.out);
  deq(gr.json.grant, { roles: ['architect', ...ALL], second_review: 'large' }, 'the writer and the reader agree');
});

// Residual a of decision 0026: an agent guesses the slug and logs a wide line before intake.
test('FU-22 milestone: a second line for a slug that grants something else is refused; the first is printed', () => {
  const p = project();
  eq(intake(p, line('next', [...ALL, 'architect', 'coach', 'hard-fix'], 'xlarge')).status, 0, 'the line that got there first');
  const before = raw(p);
  const r = intake(p, line('next', CLOSE));
  eq(r.status, 1, `the Director's own intake line is refused: ${r.out}${r.err}`);
  eq(raw(p), before, 'nothing was written');
  assert(r.err.includes(before.trim()), `the first line is printed for the user: ${r.err}`);
  assert(/Write no grant; show the user that line and ask/.test(r.err), r.err);
  assert(!/\n\s+at /.test(r.err), `no stack trace: ${r.err}`);
  // Another slug is not affected, and a narrower or wider second line is refused alike.
  eq(intake(p, line('other', CLOSE)).status, 0, 'another slug');
  eq(intake(p, line('other', ALL)).status, 1, 'wider');
  eq(intake(p, line('other', [])).status, 1, 'narrower');
  eq(intake(p, line('other', CLOSE, 'large')).status, 1, 'another second review');
  eq(rows(p).length, 2, 'two slugs, two lines');
});

test('FU-22 milestone: the same grant again writes nothing and exits 0 (a lost reply, a resumed session)', () => {
  const p = project();
  eq(intake(p, line('m1', ['architect', ...ALL], 'large')).status, 0, 'first');
  const before = raw(p);
  const r = intake(p, { ...line('m1', ['security-review-task', 'architect', 'security-review-close', 'architect'], 'large'), map_source: 'user' });
  eq(r.status, 0, r.err);
  assert(/already has this intake line.*nothing written/.test(r.out), r.out);
  eq(raw(p), before, 'nothing was written');
});

test('FU-22 milestone: a line status.js grant would not accept is refused before anything is written', () => {
  const bad = {
    'unknown role': line('m1', ['architect', 'bogus']),
    'the name from before 1.2.0': line('m1', ['security-review']),
    'task PRs without the close review': line('m1', ['security-review-task']),
    'a role that is not a string': line('m1', [1]),
    'roles not an array': line('m1', 'architect'),
    'no roles field': { milestone: 'm1', second_review: 'none' },
    'bad second review': line('m1', [], 'huge'),
    'no second review': { milestone: 'm1', xlarge_grant: [] },
    'empty slug': line(' ', []),
    'no slug': { xlarge_grant: [], second_review: 'none' },
    'slug not a string': line(['m1'], []),
    'no body': {},
  };
  for (const [label, data] of Object.entries(bad)) {
    const p = project();
    const r = intake(p, data);
    eq(r.status, 1, `${label}: ${r.out}${r.err}`);
    assert(/invalid milestone line: .*Nothing was written/.test(r.err), `${label}: ${r.err}`);
    eq(raw(p), null, `${label}: no log file`);
  }
  // The message for the older name gives the two new names.
  const old = intake(project(), line('m1', ['security-review']));
  assert(old.err.includes('security-review-close and security-review-task'), old.err);
  // Controls: the lines grant accepts.
  for (const roles of [[], CLOSE, ALL, ['architect', 'coach', 'hard-fix']]) eq(intake(project(), line('m1', roles)).status, 0, `accepted: ${roles}`);
});

test('FU-22 milestone: a log grant cannot read is not appended to', () => {
  const p = project();
  fs.mkdirSync(path.dirname(logFile(p)), { recursive: true });
  fs.writeFileSync(logFile(p), '{"milestone":"m\n');
  const r = intake(p, line('m1', CLOSE));
  eq(r.status, 1, `${r.out}${r.err}`);
  assert(/cannot tell whether "m1" already has an intake line/.test(r.err) && /ask the user/.test(r.err), r.err);
  eq(raw(p), '{"milestone":"m\n', 'nothing was written');
});

// The lost race: another writer's line lands between this run's check and its append. The seam
// lib.safeWriteHooks.beforeOpen runs at exactly that point.
test('FU-22 milestone: a line that lands between the check and the append wins, and this run is told', () => {
  const p = project();
  const rival = JSON.stringify({ ts: 't', ...line('m1', [...ALL, 'hard-fix'], 'xlarge') });
  const pre = path.join(DIR, `preload${n++}.js`);
  fs.writeFileSync(pre, `const lib = require(${JSON.stringify(path.join(SCRIPTS, 'lib.js'))});\nlet done = false;\nlib.safeWriteHooks.beforeOpen = (f) => { if (done || !f.endsWith('milestones.jsonl')) return; done = true; require('fs').appendFileSync(f, ${JSON.stringify(`${rival}\n`)}); };\n`);
  const r = intake(p, line('m1', CLOSE), { NODE_OPTIONS: `--require ${JSON.stringify(pre.replace(/\\/g, '/'))}` });
  eq(rows(p).length, 2, `precondition: both lines were appended: ${r.out}${r.err}`);
  deq(rows(p)[0].xlarge_grant, [...ALL, 'hard-fix'], 'precondition: the rival line is first');
  eq(r.status, 1, `this run lost and says so: ${r.out}${r.err}`);
  assert(r.err.includes(rival) && /written at the same moment/.test(r.err), r.err);
  // grant reads the first line; the loser's line is inert.
  fs.writeFileSync(path.join(p, 'STATUS.md'), STATUS('m1', 'close security review', 'no'));
  const gr = grant(p, 'm1');
  eq(gr.code, 16, gr.out);
  deq(gr.json.log.roles, ['hard-fix', ...ALL], 'the first line is the one read');
});

// ---- residual d: the environment cannot move the log ----

test('FU-22 lib.projectDir: GIT_DIR and GIT_WORK_TREE in the caller env do not move the project', () => {
  const mine = repo();
  const other = repo();
  const env = { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other };
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: mine, encoding: 'utf8', env: { ...GIT_ENV, ...env } }).stdout.trim();
  eq(fs.realpathSync.native(top), fs.realpathSync.native(other), 'precondition: plain git in mine follows GIT_DIR to other');
  const script = `const lib = require(${JSON.stringify(path.join(SCRIPTS, 'lib.js'))}); console.log(JSON.stringify([lib.projectDir({}), lib.logRoot({}), lib.grantLogRoot(process.cwd())]));`;
  const r = spawnSync('node', ['-e', script], { cwd: mine, encoding: 'utf8', env: baseEnv(env), timeout: 20000 });
  eq(r.status, 0, r.stderr);
  for (const [i, d] of JSON.parse(r.stdout).entries()) eq(fs.realpathSync.native(d), fs.realpathSync.native(mine), `path ${i} is the cwd's repository`);
  // The logger follows: an intake line from mine lands in mine.
  eq(intake(mine, line('m1', CLOSE), env).status, 0, 'intake with the env set');
  eq(rows(mine).length, 1, 'written in mine');
  eq(raw(other), null, 'nothing in other');
  // A subfolder of the repository is still the repository (the lookup itself still runs).
  fs.mkdirSync(path.join(mine, 'sub'));
  eq(intake(path.join(mine, 'sub'), line('m2', CLOSE), env).status, 0, 'from a subfolder');
  eq(rows(mine).length, 2, 'the subfolder writes to the top level log');
});

test('FU-22 milestone: CLAUDE_PROJECT_DIR naming another project is refused; one that agrees is fine', () => {
  const mine = repo();
  const other = repo();
  const r = intake(mine, line('m1', CLOSE), { CLAUDE_PROJECT_DIR: other });
  eq(r.status, 1, `${r.out}${r.err}`);
  assert(/CLAUDE_PROJECT_DIR .* is not the project of the cwd/.test(r.err) && /Nothing was written/.test(r.err), r.err);
  eq(raw(mine), null, 'nothing in mine');
  eq(raw(other), null, 'nothing in other');
  fs.mkdirSync(path.join(mine, 'sub'));
  eq(intake(mine, line('m1', CLOSE), { CLAUDE_PROJECT_DIR: mine }).status, 0, 'the same project');
  eq(intake(mine, line('m2', CLOSE), { CLAUDE_PROJECT_DIR: path.join(mine, 'sub') }).status, 0, 'a subfolder of the project');
  eq(rows(mine).length, 2, 'both in the project log, which is where grant reads');
  eq(fs.existsSync(path.join(mine, 'sub', '.agent-team')), false, 'no log folder inside the subfolder');
});

test('FU-22 milestone: from a linked worktree the line goes to the main checkout, where grant reads it', () => {
  const main = repo();
  const wt = path.join(DIR, `wt${n++}`);
  g(main, 'worktree', 'add', '-q', '-b', 'wtb', wt);
  eq(intake(wt, line('m1', ['architect'])).status, 0, 'intake from the worktree');
  eq(rows(main).length, 1, 'in the main checkout');
  eq(fs.existsSync(path.join(wt, '.agent-team')), false, 'not in the worktree');
  fs.writeFileSync(path.join(wt, 'STATUS.md'), STATUS('m1', 'architect', 'no'));
  eq(grant(wt, 'm1').code, 0, 'grant from the worktree reads it');
});
