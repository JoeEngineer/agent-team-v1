// Tests for scripts/archive-logs.js. All archives go to temp dirs; never the real ~/.agent-team.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { SCRIPTS, tmpProject, test, assert, eq } = require('./helpers');

const SCRIPT = path.join(SCRIPTS, 'archive-logs.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-arch-'));

function arch(proj, args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: proj, encoding: 'utf8', env: { ...process.env, AGENT_TEAM_ARCHIVE: tmp(), ...env },
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

test('archive: existing destination refused, nothing changed; --force overwrites', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n' });
  const root = tmp();
  const args = ['m', '--project', 'x', '--root', root];
  const first = arch(p, args);
  eq(first.status, 0, first.stderr);
  const dest = destOf(first);
  fs.writeFileSync(path.join(dest, 'marker'), 'x');
  const again = arch(p, args);
  eq(again.status, 1, 'refused');
  assert(/already exists/.test(again.stderr), again.stderr);
  assert(fs.existsSync(path.join(dest, 'marker')), 'untouched on refusal');
  const forced = arch(p, [...args, '--force']);
  eq(forced.status, 0, forced.stderr);
  assert(!fs.existsSync(path.join(dest, 'marker')), 'replaced');
  assert(fs.existsSync(path.join(dest, 'a.jsonl')), 'recopied');
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
  const p = tmpProject();
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
