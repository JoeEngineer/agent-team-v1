#!/usr/bin/env node
// Safe editor and checker for the task table in a project's STATUS.md.
// No dependencies; Node 18+.
//
//   node status.js set <ID> --state <s> [--attempt <a>] [--pr <n>] [--tier <t>] [--note <text>] [--file <path>]
//   node status.js --check [--file <path>]
//   node status.js --check --since <sha> [--head <sha>]
//   node status.js grant --milestone <slug> [--file <path>]
//
// `set` changes only the named cells of the one row under "## Tasks" whose ID
// cell equals <ID> (string comparison; no pattern is built from an argument).
// `--state` writes the bare state; `--note` appends ": <note>" to it.
// It writes through a temp file and a rename, keeps the file's line endings
// and the file's mode, refuses a symlink (a rename would replace the link; pass
// the real path), reads the file back and confirms that at most the one row
// line differs. A failed write or rename leaves the file as it was and no temp
// file behind.
// `--file` defaults to STATUS.md in the cwd. One JSON line is printed.
//
// Exit codes: 0 ok   2 bad arguments   3 line 1 is not "# Status"
//   4 no Tasks table (or a column is missing)   5 row missing   6 ID appears twice
//   7 state not in the file's States: legend   8 a value has "|" or a newline
//   9 --check found problems   10 file unreadable   11 write or read-back failed
//   12 a row under "## Tasks" is malformed (wrong cell count; run --check)
//   13 the file is a symlink (set only)
//   14 --since: the head differs from <sha> in more than an unchanged-mode edit of STATUS.md,
//      or --check fails at the head, or <sha> is not an ancestor of the head
//   15 --since: git failed (unknown commit, no repository, git missing)
//   16 grant: the STATUS.md block and the intake log line disagree (use the narrower; ask the user)
//   17 grant: STATUS.md is unreadable for the grant (unknown role or tier word, a repeated line,
//      two "## xlarge grant" or "## Current milestone" headings, two bold slug lines)
//   18 grant: the block grants something and the log has no line for the milestone
//   19 grant: the log is unreadable, or its first line for the milestone is torn, has bad fields,
//      or names the slug in its raw text but parses to another milestone (a repeated key)
//   20 grant: the slug under "## Current milestone" is not the --milestone slug
//
// `--check --since <sha>` decides whether the head (default HEAD) differs from the
// reviewed commit <sha> only in STATUS.md: `git diff --no-renames --ignore-submodules=none
// --name-status` must list nothing or exactly "M STATUS.md" with the same file mode on both
// sides, <sha> must be an ancestor of the head, and --check must pass on STATUS.md as
// committed at the head. Both SHAs must be full 40-hex. git runs through execFileSync with
// an argv array, never a shell, as `git --no-replace-objects -c core.commitGraph=false`, with
// every GIT_* variable removed from its environment. Prints
// {"status_only":bool,"since":..,"head":..,"reason":..}; exit 0 only when true.
// The local repo's object store and config are otherwise trusted (decision 0026).
//
// `grant` prints the effective xlarge grant: the roles in both the "## xlarge grant"
// block of STATUS.md and the FIRST line for the milestone in .agent-team/logs/milestones.jsonl
// (the main checkout's logs when run in a git worktree), and the lower of the two
// second-review tiers. First line wins because the intake answer is fixed for the
// milestone (decision 0026). --milestone is required and is the Director's own slug; the
// file under check never picks it. A different slug under "## Current milestone" exits 20
// (the template's "<slug>" counts as none). An agent that can rewrite milestones.jsonl is
// not stopped.
// A free-text note after the roles must be in parentheses: "architect (a note)" is read,
// "architect - a note" (or with an em dash) and "architect; a note" exit 17 (unknown role),
// which fails closed.
// `grant --file <other>` reads the block from <other> but still reads the log from the
// logRoot of the cwd (CLAUDE_PROJECT_DIR when set), not from the project that holds <other>.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib');

const EXIT = { ok: 0, usage: 2, header: 3, table: 4, missing: 5, duplicate: 6, state: 7, value: 8, check: 9, io: 10, verify: 11, malformed: 12, link: 13, notStatusOnly: 14, git: 15, differ: 16, block: 17, noLog: 18, badLog: 19, slug: 20 };

class Refusal extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

// Split a table line into raw cells. A "|" preceded by a backslash stays in its cell.
function splitCells(line) {
  const body = line.replace(/\s+$/, '');
  if (!body.startsWith('|') || body.length < 2 || !body.endsWith('|')) return null;
  const inner = body.slice(1, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

// Lines without their "\r", plus the "\r" each one had.
function splitLines(text) {
  return text.split('\n').map((l) => (l.endsWith('\r') ? { t: l.slice(0, -1), cr: '\r' } : { t: l, cr: '' }));
}
const joinLines = (lines) => lines.map((l) => l.t + l.cr).join('\n');

// Parse the file: legend states, and the Tasks table (header, rows with line indexes).
function parse(text) {
  const lines = splitLines(text);
  const problems = [];
  const fatal = (code, msg) => { throw new Refusal(code, msg); };
  if (lines[0].t !== '# Status') fatal(EXIT.header, 'line 1 is not "# Status"');

  const legendLine = lines.find((l) => l.t.startsWith('States:'));
  const legend = legendLine ? [...legendLine.t.matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [];

  const heads = lines.map((l, i) => (l.t.trim() === '## Tasks' ? i : -1)).filter((i) => i >= 0);
  if (heads.length !== 1) fatal(EXIT.table, heads.length ? 'more than one "## Tasks" heading' : 'no "## Tasks" heading');
  const blocks = [];
  for (let i = heads[0] + 1; i < lines.length && !lines[i].t.startsWith('## '); i++) {
    if (lines[i].t.startsWith('|') && !lines[i - 1].t.startsWith('|')) blocks.push(i);
  }
  if (blocks.length === 0) fatal(EXIT.table, 'no table under "## Tasks"');
  if (blocks.length > 1) fatal(EXIT.table, 'more than one table under "## Tasks"');
  const start = blocks[0];
  const header = splitCells(lines[start].t);
  const sep = start + 1 < lines.length ? splitCells(lines[start + 1].t) : null;
  if (!header || !sep || !sep.every((c) => /^\s*:?-+:?\s*$/.test(c))) fatal(EXIT.table, 'the Tasks table has no header and separator rows');
  if (sep.length !== header.length) problems.push('the separator row has a different cell count from the header');
  const names = header.map((c) => c.trim());
  const rows = [];
  for (let j = start + 2; j < lines.length && lines[j].t.startsWith('|'); j++) {
    rows.push({ line: j, cells: splitCells(lines[j].t) });
  }
  return { lines, legend, legendFound: !!legendLine, names, rows, problems };
}

const col = (names, name) => names.findIndex((n) => n === name);
const tierCol = (names) => names.findIndex((n) => n.startsWith('Tier'));

// True when the cell starts with a legend state, followed by the end or a non-word character.
function startsWithState(cell, legend) {
  const v = cell.trim();
  return legend.some((s) => v.startsWith(s) && (v.length === s.length || !/[A-Za-z0-9]/.test(v[s.length])));
}

function check(text) {
  const t = parse(text);
  const problems = [...t.problems];
  if (!t.legendFound || !t.legend.length) problems.push('no States: legend with backticked values');
  const iId = col(t.names, 'ID');
  const iState = col(t.names, 'State');
  if (iId < 0) problems.push('the table has no ID column');
  if (iState < 0) problems.push('the table has no State column');
  const seen = new Set();
  for (const r of t.rows) {
    const at = `line ${r.line + 1}`;
    if (!r.cells || r.cells.length !== t.names.length) {
      problems.push(`${at}: ${r.cells ? r.cells.length : 'unreadable'} cells, header has ${t.names.length}`);
      continue;
    }
    if (iId >= 0) {
      const id = r.cells[iId].trim();
      if (!id) problems.push(`${at}: empty ID`);
      else if (seen.has(id)) problems.push(`${at}: duplicate ID ${id}`);
      seen.add(id);
    }
    if (iState >= 0 && !startsWithState(r.cells[iState], t.legend)) problems.push(`${at}: State "${r.cells[iState].trim()}" is not a legend state`);
  }
  return problems;
}

// Returns { text, line }. Throws Refusal.
function applySet(text, id, vals) {
  if (typeof id !== 'string' || id.trim() === '') throw new Refusal(EXIT.usage, 'the ID is empty');
  for (const [k, v] of Object.entries({ id, ...vals })) {
    if (/[|\r\n]/.test(v)) throw new Refusal(EXIT.value, `the ${k} value contains "|" or a newline`);
  }
  const t = parse(text);
  const iId = col(t.names, 'ID');
  if (iId < 0) throw new Refusal(EXIT.table, 'the table has no ID column');
  const want = { state: col(t.names, 'State'), attempt: col(t.names, 'Attempt'), pr: col(t.names, 'PR'), tier: tierCol(t.names) };
  for (const k of Object.keys(vals)) {
    if (k !== 'note' && want[k] < 0) throw new Refusal(EXIT.table, `the table has no column for --${k}`);
  }
  // A row with the wrong cell count cannot be matched by ID, so it could hide the row or a duplicate.
  const bad = t.rows.find((r) => !r.cells || r.cells.length !== t.names.length);
  if (bad) throw new Refusal(EXIT.malformed, `row malformed: line ${bad.line + 1} has ${bad.cells ? bad.cells.length : 'unreadable'} cells, header has ${t.names.length}; run --check`);
  const hits = t.rows.filter((r) => r.cells[iId].trim() === id);
  if (hits.length === 0) throw new Refusal(EXIT.missing, `no row with ID ${id}`);
  if (hits.length > 1) throw new Refusal(EXIT.duplicate, `ID ${id} appears ${hits.length} times`);
  if (vals.state !== undefined) {
    if (!t.legend.length) throw new Refusal(EXIT.state, 'the file has no States: legend');
    if (!t.legend.includes(vals.state)) throw new Refusal(EXIT.state, `state "${vals.state}" is not in the States: legend (${t.legend.join(', ')})`);
  }
  const row = hits[0];
  const cells = row.cells.slice();
  const put = (idx, v) => { cells[idx] = ` ${v} `; };
  if (vals.state !== undefined) put(want.state, vals.note ? `${vals.state}: ${vals.note}` : vals.state);
  for (const k of ['attempt', 'pr', 'tier']) if (vals[k] !== undefined) put(want[k], vals[k]);
  const old = t.lines[row.line];
  const trail = old.t.slice(old.t.replace(/\s+$/, '').length);
  const lines = t.lines.slice();
  lines[row.line] = { t: `|${cells.join('|')}|${trail}`, cr: old.cr };
  return { text: joinLines(lines), line: row.line };
}

// Replace the file's content through a temp file in the same directory. The original mode is kept.
function writeAtomic(file, text) {
  const mode = fs.statSync(file).mode & 0o7777;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ }
    throw e;
  }
}

// ---- --check --since ----

const FULL_SHA = /^[0-9a-f]{40}$/;

// git sees none of the caller's GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
// GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG*, GIT_REPLACE_REF_BASE,
// GIT_NAMESPACE, GIT_CEILING_DIRECTORIES, ...), so the repo is the one at cwd. Replace refs and the
// commit-graph cache are off: either can make a commit SHA read as a different tree.
const GIT_PRE = ['--no-replace-objects', '-c', 'core.commitGraph=false'];
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
function git(cwd, args) {
  const argv = [...GIT_PRE, ...args];
  return execFileSync('git', argv, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
}
const gitMsg = (e) => String((e.stderr && e.stderr.toString().trim()) || e.message).split('\n')[0];

// Returns { status_only, reason?, code }. `since` and `head` are full SHAs already validated.
function statusOnly(cwd, since, head) {
  const fail = (reason, code = EXIT.notStatusOnly) => ({ status_only: false, reason, code });
  try {
    for (const sha of [since, head]) git(cwd, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch (e) { return fail(`git cannot find the commit: ${gitMsg(e)}`, EXIT.git); }
  try {
    git(cwd, ['merge-base', '--is-ancestor', since, head]);
  } catch (e) {
    if (e.status === 1) return fail(`${since} is not an ancestor of ${head}`);
    return fail(`git merge-base failed: ${gitMsg(e)}`, EXIT.git);
  }
  let names; let raw;
  try {
    // --ignore-submodules=none: a gitlink bump must show even when .gitmodules or config says ignore.
    const diff = ['diff', '--no-renames', '--no-ext-diff', '--ignore-submodules=none'];
    names = git(cwd, [...diff, '--name-status', '-z', since, head, '--']).split('\0').filter((x) => x !== '');
    raw = git(cwd, [...diff, '--raw', '-z', since, head, '--']).split('\0').filter((x) => x !== '');
  } catch (e) { return fail(`git diff failed: ${gitMsg(e)}`, EXIT.git); }
  if (names.length !== 0) {
    if (names.length !== 2 || names[0] !== 'M' || names[1] !== 'STATUS.md') {
      const shown = [];
      for (let i = 0; i < names.length; i += 2) shown.push(`${names[i]} ${names[i + 1]}`);
      return fail(`the diff is not only "M STATUS.md": ${shown.join('; ')}`);
    }
    // name-status says M for a mode change too; the raw line carries both modes.
    const m = /^:(\d+) (\d+) \S+ \S+ M$/.exec(raw[0] || '');
    if (raw.length !== 2 || !m || raw[1] !== 'STATUS.md') return fail(`unexpected raw diff: ${raw.join(' ')}`);
    if (m[1] !== m[2]) return fail(`STATUS.md changed mode from ${m[1]} to ${m[2]}`);
    if (!/^100(644|755)$/.test(m[2])) return fail(`STATUS.md is not a regular file (mode ${m[2]})`);
  }
  let text;
  try { text = git(cwd, ['cat-file', 'blob', `${head}:STATUS.md`]); } catch (e) { return fail(`STATUS.md cannot be read at the head: ${gitMsg(e)}`); }
  let problems;
  try { problems = check(text); } catch (e) { if (!(e instanceof Refusal)) throw e; problems = [e.message]; }
  if (problems.length) return fail(`--check fails at the head: ${problems.join('; ')}`);
  return { status_only: true, code: 0 };
}

// ---- grant ----

// The one place the question's words meet the log's names.
const ROLE_NAMES = {
  'security reviews': 'security-review',
  'architect': 'architect',
  'coach at close': 'coach',
  'hard-fix escalation': 'hard-fix',
};
const LOG_ROLES = new Set(Object.values(ROLE_NAMES));
// Second security review: the template's words to the log's values, ordered narrow to wide.
const SECOND_WORDS = { 'no': 'none', 'not offered': 'none', 'large/high': 'large', 'xlarge/high': 'xlarge' };
const SECOND_ORDER = ['none', 'large', 'xlarge'];

// Drop "(...)" notes, however many.
const stripNotes = (v) => {
  let s = v;
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(/\([^()]*\)/g, ''); }
  return s.replace(/\s+/g, ' ').trim().replace(/\.$/, '').trim();
};
const isPlaceholder = (v) => /^<[^>]*>$/.test(v.trim());

// { found, roles: Set of log names, second: 'none'|'large'|'xlarge' }. Throws Refusal(block).
function readBlock(text) {
  const lines = splitLines(text).map((l) => l.t);
  const heads = lines.map((l, i) => (l.trim() === '## xlarge grant' ? i : -1)).filter((i) => i >= 0);
  if (heads.length > 1) throw new Refusal(EXIT.block, 'more than one "## xlarge grant" heading');
  if (!heads.length) return { found: false, roles: new Set(), second: 'none' };
  const body = [];
  for (let i = heads[0] + 1; i < lines.length && !lines[i].startsWith('## '); i++) body.push(lines[i]);
  const one = (label) => {
    const item = (l) => l.trim().replace(/^[-*]\s+/, '');
    const hits = body.filter((l) => item(l).toLowerCase().startsWith(`${label.toLowerCase()}:`));
    if (hits.length > 1) throw new Refusal(EXIT.block, `"${label}" appears ${hits.length} times in the block`);
    return hits.length ? item(hits[0]).slice(label.length + 1).trim() : null;
  };
  const rolesRaw = one('Granted roles');
  const secondRaw = one('Second security review');
  const roles = new Set();
  if (rolesRaw !== null && !isPlaceholder(rolesRaw)) {
    const v = stripNotes(rolesRaw).toLowerCase();
    if (/[()]/.test(v)) throw new Refusal(EXIT.block, `unbalanced parenthesis in the roles line: ${rolesRaw}`);
    if (v !== 'none' && v !== '') {
      for (const tok of v.split(',').map((x) => x.trim())) {
        if (!Object.prototype.hasOwnProperty.call(ROLE_NAMES, tok)) throw new Refusal(EXIT.block, `unknown role "${tok}" in the roles line (known: ${Object.keys(ROLE_NAMES).join(', ')}, none)`);
        roles.add(ROLE_NAMES[tok]);
      }
    }
  }
  let second = 'none';
  if (secondRaw !== null && !isPlaceholder(secondRaw)) {
    const v = stripNotes(secondRaw).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SECOND_WORDS, v)) throw new Refusal(EXIT.block, `unknown second security review "${v}" (known: ${Object.keys(SECOND_WORDS).join(', ')})`);
    second = SECOND_WORDS[v];
  }
  return { found: true, roles, second };
}

// The bold slug under "## Current milestone", or null when there is no heading, no bold line,
// or only the template's "<slug>". Two headings or two bold lines throw Refusal(block): the
// file must not be able to offer a choice of slugs.
function currentSlug(text) {
  const lines = splitLines(text).map((l) => l.t);
  const heads = lines.map((l, i) => (l.trim().toLowerCase() === '## current milestone' ? i : -1)).filter((i) => i >= 0);
  if (heads.length > 1) throw new Refusal(EXIT.block, `"## Current milestone" appears ${heads.length} times in STATUS.md`);
  if (!heads.length) return null;
  const slugs = [];
  for (let j = heads[0] + 1; j < lines.length && !lines[j].startsWith('## '); j++) {
    const m = /^\*\*([^*]+)\*\*/.exec(lines[j].trim());
    if (m) slugs.push(m[1].trim());
  }
  if (slugs.length > 1) throw new Refusal(EXIT.block, `${slugs.length} bold slug lines under "## Current milestone" (${slugs.join(', ')})`);
  return slugs.length && !isPlaceholder(slugs[0]) ? slugs[0] : null;
}

// True when the raw line has a "milestone" key whose string value is the slug, however either is
// escaped. The JSON string literals are read left to right; a key is a literal followed by ":".
function namesSlug(line, slug) {
  const lits = [...line.matchAll(/"(?:[^"\\]|\\.)*"/g)];
  const dec = (m) => { try { return JSON.parse(m[0]); } catch { return null; } };
  for (let i = 0; i + 1 < lits.length; i++) {
    const a = lits[i]; const b = lits[i + 1];
    const gap = line.slice(a.index + a[0].length, b.index);
    if (/^\s*:\s*$/.test(gap) && dec(a) === 'milestone' && dec(b) === slug) return true;
  }
  return false;
}

// The first line whose `milestone` equals the slug (string comparison), as { roles, second }, or null.
// A line that does not parse but mentions the slug might have been that line: refuse then. So is a
// line that parses to another milestone (or a non-string one) while its raw text names the slug,
// as with a repeated "milestone" key, where JSON.parse keeps the last value.
function readLog(file, slug) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Refusal(EXIT.badLog, `cannot read ${file}: ${e.code || e.message}`);
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o = null;
    try { o = JSON.parse(line); } catch { /* checked below */ }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) {
      if (line.includes(slug)) throw new Refusal(EXIT.badLog, `a line of ${file} that mentions "${slug}" is not valid JSON (torn?); cannot tell whether it is the intake line`);
      continue;
    }
    if (o.milestone !== slug) {
      const odd = o.milestone !== undefined && typeof o.milestone !== 'string' && line.includes(slug);
      if (odd || namesSlug(line, slug)) throw new Refusal(EXIT.badLog, `a line of ${file} names "${slug}" as its milestone but parses to ${JSON.stringify(o.milestone)} (a repeated or non-string milestone key); cannot tell whether it is the intake line`);
      continue;
    }
    if (!Array.isArray(o.xlarge_grant) || o.xlarge_grant.some((r) => typeof r !== 'string' || !LOG_ROLES.has(r))) throw new Refusal(EXIT.badLog, `the first line for "${slug}" has no valid xlarge_grant array of ${[...LOG_ROLES].join(', ')}`);
    if (typeof o.second_review !== 'string' || !SECOND_ORDER.includes(o.second_review)) throw new Refusal(EXIT.badLog, `the first line for "${slug}" has no valid second_review (none, large, xlarge)`);
    return { roles: new Set(o.xlarge_grant), second: o.second_review };
  }
  return null;
}

// `slug` is the Director's own (the card's milestone=, or the milestone/<slug> branch), never
// STATUS.md's: the file under check cannot pick which log line it is checked against.
function grant(text, slug, cwd) {
  const block = readBlock(text);
  const statusSlug = currentSlug(text);
  const none = { roles: [], second_review: 'none' };
  if (statusSlug !== null && statusSlug !== slug) {
    return { ok: false, code: EXIT.slug, milestone: slug, status_milestone: statusSlug, grant: none, reason: `STATUS.md names milestone "${statusSlug}" under "## Current milestone" but --milestone is "${slug}"; no grant. Check which milestone is current; ask the user` };
  }
  const logFile = path.join(lib.logRoot({ cwd }), '.agent-team', 'logs', 'milestones.jsonl');
  const log = readLog(logFile, slug);
  const view = (g) => (g ? { roles: [...g.roles].sort(), second_review: g.second } : null);
  const base = { milestone: slug, block: view(block.found ? block : null), log: view(log) };
  const wantsSomething = block.roles.size > 0 || block.second !== 'none';
  if (!log && wantsSomething) {
    return { ok: false, code: EXIT.noLog, ...base, grant: none, reason: `the STATUS.md block grants roles or a second review but ${logFile} has no line for "${slug}"; the block is not trusted alone. Use no grant; ask the user` };
  }
  const lg = log || { roles: new Set(), second: 'none' };
  const roles = [...block.roles].filter((r) => lg.roles.has(r)).sort();
  const second = SECOND_ORDER[Math.min(SECOND_ORDER.indexOf(block.second), SECOND_ORDER.indexOf(lg.second))];
  const eff = { roles, second_review: second };
  const same = block.roles.size === lg.roles.size && roles.length === block.roles.size && block.second === lg.second;
  if (!same) return { ok: false, code: EXIT.differ, ...base, grant: eff, reason: 'the STATUS.md block and the intake log line differ; use the narrower; ask the user' };
  return { ok: true, code: 0, ...base, grant: eff };
}

function parseArgs(argv) {
  const o = { vals: {} };
  const flags = { '--state': 'state', '--attempt': 'attempt', '--pr': 'pr', '--tier': 'tier', '--note': 'note' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--since' || a === '--head' || a === '--milestone') {
      if (i + 1 >= argv.length) throw new Refusal(EXIT.usage, `${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else if (a === '--file') {
      if (i + 1 >= argv.length) throw new Refusal(EXIT.usage, '--file needs a value');
      o.file = argv[++i];
    } else if (flags[a]) {
      if (i + 1 >= argv.length) throw new Refusal(EXIT.usage, `${a} needs a value`);
      o.vals[flags[a]] = argv[++i];
    } else if (a.startsWith('--')) throw new Refusal(EXIT.usage, `unknown option ${a}`);
    else rest.push(a);
  }
  if (o.since !== undefined || o.head !== undefined) {
    if (!o.check || o.since === undefined) throw new Refusal(EXIT.usage, '--head goes with --check --since <sha>');
    if (rest.length || Object.keys(o.vals).length || o.file !== undefined || o.milestone !== undefined) throw new Refusal(EXIT.usage, '--check --since takes only --head');
    if (!FULL_SHA.test(o.since)) throw new Refusal(EXIT.usage, '--since needs a full 40-hex SHA (not a short SHA or a branch name)');
    if (o.head !== undefined && !FULL_SHA.test(o.head)) throw new Refusal(EXIT.usage, '--head needs a full 40-hex SHA');
    return o;
  }
  if (rest[0] === 'grant') {
    const use = 'usage: status.js grant --milestone <slug> [--file <path>]; the slug is the Director\'s own (the card\'s milestone=, or the milestone/<slug> branch), not read from STATUS.md';
    if (o.check || rest.length !== 1 || Object.keys(o.vals).length) throw new Refusal(EXIT.usage, use);
    if (o.milestone === undefined) throw new Refusal(EXIT.usage, `--milestone is required. ${use}`);
    if (o.milestone.trim() === '') throw new Refusal(EXIT.usage, '--milestone is empty');
    o.grant = true;
    return o;
  }
  if (o.milestone !== undefined) throw new Refusal(EXIT.usage, '--milestone goes with grant');
  if (o.check) {
    if (rest.length || Object.keys(o.vals).length) throw new Refusal(EXIT.usage, '--check takes only --file');
    return o;
  }
  if (rest[0] !== 'set' || rest.length !== 2) throw new Refusal(EXIT.usage, 'usage: status.js set <ID> --state <s> [--attempt <a>] [--pr <n>] [--tier <t>] [--note <text>] [--file <path>] | status.js --check [--file <path>] | status.js --check --since <sha> [--head <sha>] | status.js grant --milestone <slug> [--file <path>]');
  o.id = rest[1];
  if (!Object.keys(o.vals).length) throw new Refusal(EXIT.usage, 'set needs at least one of --state, --attempt, --pr, --tier');
  if (o.vals.note !== undefined && o.vals.state === undefined) throw new Refusal(EXIT.usage, '--note needs --state');
  return o;
}

function main(argv, deps = {}) {
  const out = deps.out || ((s) => console.log(s));
  const cwd = deps.cwd || process.cwd();
  try {
    const o = parseArgs(argv);
    if (o.since !== undefined) {
      let head = o.head;
      if (head === undefined) {
        try { head = git(cwd, ['rev-parse', '--verify', 'HEAD']).trim(); } catch (e) { throw new Refusal(EXIT.git, `git cannot resolve HEAD: ${gitMsg(e)}`); }
        if (!FULL_SHA.test(head)) throw new Refusal(EXIT.git, `git rev-parse HEAD gave "${head}"`);
      }
      const r = statusOnly(cwd, o.since, head);
      out(JSON.stringify({ status_only: r.status_only, since: o.since, head, ...(r.status_only ? {} : { reason: r.reason }) }));
      return r.code;
    }
    const file = path.resolve(cwd, o.file || 'STATUS.md');
    if (!o.check && !o.grant) {
      let st = null;
      try { st = fs.lstatSync(file); } catch { /* the read below reports it */ }
      if (st && st.isSymbolicLink()) throw new Refusal(EXIT.link, `${file} is a symlink; set would replace the link with a regular file. Pass the real path with --file`);
    }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Refusal(EXIT.io, `cannot read ${file}: ${e.code || e.message}`); }
    if (o.grant) {
      const g = grant(text, o.milestone, cwd);
      out(JSON.stringify(g));
      return g.code;
    }
    if (o.check) {
      let problems;
      try { problems = check(text); } catch (e) { if (!(e instanceof Refusal)) throw e; problems = [e.message]; }
      out(JSON.stringify({ ok: problems.length === 0, code: problems.length ? EXIT.check : 0, file, problems }));
      return problems.length ? EXIT.check : 0;
    }
    const res = applySet(text, o.id, o.vals);
    let back;
    try {
      if (res.text !== text) writeAtomic(file, res.text);
      back = fs.readFileSync(file, 'utf8');
    } catch (e) { throw new Refusal(EXIT.verify, `write failed: ${e.code || e.message}`); }
    const a = text.split('\n');
    const b = back.split('\n');
    const differ = a.length === b.length ? b.filter((l, i) => l !== a[i]).length : -1;
    const wantDiffer = res.text === text ? 0 : 1;
    if (back !== res.text || differ !== wantDiffer) {
      let restored = true;
      try { writeAtomic(file, text); } catch { restored = false; }
      throw new Refusal(EXIT.verify, `read-back check failed (${differ} lines differ); ` + (restored ? 'the original was restored' : `the original could NOT be restored, check ${file}`));
    }
    out(JSON.stringify({ ok: true, code: 0, file, id: o.id, line: res.line + 1, changed: wantDiffer === 1, row: b[res.line].replace(/\r$/, '') }));
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    out(JSON.stringify({ ok: false, code: e.code, reason: e.message }));
    return e.code;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parse, check, applySet, splitCells, startsWithState, EXIT };
