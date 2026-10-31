#!/usr/bin/env node
// Archive the project's .agent-team/logs/*.jsonl to a per-milestone folder outside the repo.
// Usage: node scripts/archive-logs.js <milestone> [--project <name>] [--root <dir>] [--clear] [--force] [--dry-run]
// Dependency-free; works the same from Claude and Codex (no hook input).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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

  const logDir = path.join(projectDir, '.agent-team', 'logs');
  if (!fs.existsSync(logDir) || !fs.statSync(logDir).isDirectory()) fail('no .agent-team/logs folder found');
  const files = fs.readdirSync(logDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name).sort();
  if (!files.length) fail('no .jsonl files in .agent-team/logs');

  if (fs.existsSync(dest) && !o.force) fail(`destination already exists (use --force to overwrite): ${dest}`);

  const pendingDir = path.join(logDir, '.pending');
  const now = Date.now();
  const pending = fs.existsSync(pendingDir)
    ? fs.readdirSync(pendingDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
        const p = path.join(pendingDir, e.name);
        return { p, stale: now - fs.statSync(p).mtimeMs > STALE_MS };
      })
    : [];
  const stale = pending.filter((x) => x.stale);

  if (o.dryRun) {
    console.log(`[dry-run] would copy ${files.length} file(s) to ${dest}`);
    for (const f of files) console.log(`  ${f}`);
    console.log(`[dry-run] would delete ${stale.length} stale .pending entries (keeping ${pending.length - stale.length} fresh)`);
    if (o.clear) console.log('[dry-run] would delete the live logs after verification');
    console.log(dest);
    return;
  }

  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const versions = new Set();
  const rows = [];
  try {
    for (const f of files) {
      const src = path.join(logDir, f);
      const dst = path.join(dest, f);
      fs.copyFileSync(src, dst);
      if (fs.statSync(src).size !== fs.statSync(dst).size || sha256(src) !== sha256(dst)) {
        throw new Error(`verification failed for ${f}`);
      }
      let lines = 0, inMilestone = 0, malformed = 0;
      for (const line of fs.readFileSync(dst, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        lines++;
        try {
          const rec = JSON.parse(line);
          if (rec && rec.guidance_version) versions.add(String(rec.guidance_version));
          if (rec && rec.task && rec.task.milestone === o.milestone) inMilestone++;
        } catch { malformed++; }
      }
      rows.push({ f, lines, inMilestone, malformed });
    }
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    fail(`${err.message}; partial copy removed`);
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
  fs.writeFileSync(path.join(dest, 'README.md'), readme);

  let removed = 0;
  for (const x of stale) {
    try { fs.unlinkSync(x.p); removed++; } catch { /* ignore */ }
  }
  let cleared = 0;
  if (o.clear) {
    for (const f of files) { fs.unlinkSync(path.join(logDir, f)); cleared++; }
  }

  console.log(`Archived ${files.length} file(s).`);
  console.log(`.pending: deleted ${removed} stale, kept ${pending.length - removed}.`);
  if (o.clear) console.log(`Cleared ${cleared} live log file(s).`);
  console.log(dest);
}

main();
