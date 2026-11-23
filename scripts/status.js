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
// the real path), checks before it writes that at most the one row line differs,
// and reads the file back. A failed write or rename leaves the file as it was and
// no temp file behind. A read-back that is not what this run wrote exits 11 and is
// NOT rolled back: the difference may be someone else's edit (decision 0029).
// `--file` defaults to STATUS.md in the cwd. One JSON line is printed.
//
// Exit codes: 0 ok   2 bad arguments   3 line 1 is not "# Status"
//   4 no Tasks table (or a column is missing)   5 row missing   6 ID appears twice
//   7 state not in the file's States: legend   8 a value has "|" or a newline
//   9 --check found problems   10 file unreadable   11 write or read-back failed (no rollback)
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
//      or names the slug in its raw text but parses to another milestone (a repeated key), or a
//      line before it is not a JSON object (it could have been the intake line)
//   20 grant: the slug under "## Current milestone" is not the --milestone slug
//   21 set: the temp file path already exists (a file or a symlink); nothing was written or followed
//   22 grant: CLAUDE_PROJECT_DIR names a different project from the cwd's; nothing is granted
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
// (the template's "<slug>" counts as none). An agent that can rewrite milestones.jsonl, or
// the repository's .git, is not stopped (decisions 0026 and 0029).
// The security rows are two roles: "close security review" grants security-review-close;
// "all security reviews" (and the older "security reviews") grants that and
// security-review-task. An older log line's "security-review" reads as both.
// A free-text note after the roles must be in parentheses: "architect (a note)" is read,
// "architect - a note" (or with an em dash) and "architect; a note" exit 17 (unknown role),
// which fails closed.
// `grant --file <other>` reads the block from <other> but still reads the log from the
// project of the cwd, not from the project that holds <other>. The project is found from
// the cwd with no GIT_* variable in git's environment. CLAUDE_PROJECT_DIR cannot move it:
// when it is set and names another project, grant exits 22.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const lib = require('./lib');

const EXIT = { ok: 0, usage: 2, header: 3, table: 4, missing: 5, duplicate: 6, state: 7, value: 8, check: 9, io: 10, verify: 11, malformed: 12, link: 13, notStatusOnly: 14, git: 15, differ: 16, block: 17, noLog: 18, badLog: 19, slug: 20, tmpExists: 21, env: 22 };

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
// The temp file is created exclusively (O_EXCL, which does not follow a symlink either) under a
// random name, so a file or link already at that path is never written through or removed.
function writeAtomic(file, text) {
  const mode = fs.statSync(file).mode & 0o7777;
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let created = false;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    created = true;
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    if (!created && e.code === 'EEXIST') throw new Refusal(EXIT.tmpExists, `the temp path ${tmp} already exists; it was left alone and ${file} is unchanged. Remove it and retry`);
    // A partial write may have made the file even though the call threw; EEXIST is the only case where it is not ours.
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
  // git runs at the caller's cwd. --no-relative below is what stops a subdirectory cwd (with
  // diff.relative set) from hiding the rest of the tree. There is no hop to
  // `rev-parse --show-toplevel`: that follows core.worktree, which can name another repository.
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
    const diff = ['diff', '--no-relative', '--no-renames', '--no-ext-diff', '--ignore-submodules=none'];
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
// A word grants one or more log roles. The two security rows of the grant table in routing.md
// are separate roles, so a grant can cover the close review alone (decisions 0028 and 0029).
// Notes in parentheses are stripped before the lookup, so no word here relies on them.
const SEC_CLOSE = 'security-review-close';
const SEC_TASK = 'security-review-task';
const ROLE_NAMES = {
  'close security review': [SEC_CLOSE],
  'all security reviews': [SEC_CLOSE, SEC_TASK],
  // The word before 1.2.0. It keeps its old meaning: both security rows.
  'security reviews': [SEC_CLOSE, SEC_TASK],
  'architect': ['architect'],
  'coach at close': ['coach'],
  // Deliberately the bare word: the 1.2.0 label is "coach (run for this milestone)", and the
  // note stripper removes the parenthesis before the lookup. Do not "fix" this to the full label.
  'coach': ['coach'],
  'hard-fix escalation': ['hard-fix'],
};
const LOG_ROLES = new Set(Object.values(ROLE_NAMES).flat());
// A log line written before 1.2.0 names one role for both security rows.
const OLD_LOG_ROLES = { 'security-review': [SEC_CLOSE, SEC_TASK] };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Second security review: the template's words to the log's values, ordered narrow to wide.
const SECOND_WORDS = { 'no': 'none', 'not offered': 'none', 'large/high': 'large', 'xlarge/high': 'xlarge' };
const SECOND_ORDER = ['none', 'large', 'xlarge'];

// Drop "(...)" notes, however many.
const stripNotes = (v) => {
  // One pass with a stack of "(" positions in the output: a ")" drops back to its "(", so nested
  // notes cost linear time. An unmatched "(" or ")" stays, and readBlock refuses it.
  const out = []; const opens = [];
  for (const ch of v) {
    if (ch === '(') { opens.push(out.length); out.push(ch); }
    else if (ch === ')' && opens.length) out.length = opens.pop();
    else out.push(ch);
  }
  const s = out.join('');
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
        if (!has(ROLE_NAMES, tok)) throw new Refusal(EXIT.block, `unknown role "${tok}" in the roles line (known: ${Object.keys(ROLE_NAMES).join(', ')}, none)`);
        for (const r of ROLE_NAMES[tok]) roles.add(r);
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
// A line before it that is not a JSON object might have been that line, whatever it mentions: a
// line torn before the slug ends ('{"milestone":"cu') names nothing, and any torn line could have
// gone on to name the slug. Refuse then (decision 0029, residual b). So is a line that parses to
// another milestone (or a non-string one) while its raw text names the slug, as with a repeated
// "milestone" key, where JSON.parse keeps the last value.
function readLog(file, slug) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Refusal(EXIT.badLog, `cannot read ${file}: ${e.code || e.message}`);
  }
  const lines = raw.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line.trim()) continue;
    let o = null;
    try { o = JSON.parse(line); } catch { /* checked below */ }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) {
      throw new Refusal(EXIT.badLog, `line ${n + 1} of ${file} is not a JSON object (torn?) and no line for "${slug}" comes before it; cannot tell whether it is the intake line. Ask the user to repair or remove that line`);
    }
    if (o.milestone !== slug) {
      const odd = o.milestone !== undefined && typeof o.milestone !== 'string' && line.includes(slug);
      if (odd || namesSlug(line, slug)) throw new Refusal(EXIT.badLog, `a line of ${file} names "${slug}" as its milestone but parses to ${JSON.stringify(o.milestone)} (a repeated or non-string milestone key); cannot tell whether it is the intake line`);
      continue;
    }
    if (!Array.isArray(o.xlarge_grant) || o.xlarge_grant.some((r) => typeof r !== 'string' || !(LOG_ROLES.has(r) || has(OLD_LOG_ROLES, r)))) throw new Refusal(EXIT.badLog, `the first line for "${slug}" has no valid xlarge_grant array of ${[...LOG_ROLES].join(', ')}`);
    if (typeof o.second_review !== 'string' || !SECOND_ORDER.includes(o.second_review)) throw new Refusal(EXIT.badLog, `the first line for "${slug}" has no valid second_review (none, large, xlarge)`);
    const roles = new Set(o.xlarge_grant.flatMap((r) => (has(OLD_LOG_ROLES, r) ? OLD_LOG_ROLES[r] : [r])));
    // No intake answer grants flagged task PRs without the close review.
    if (roles.has(SEC_TASK) && !roles.has(SEC_CLOSE)) throw new Refusal(EXIT.badLog, `the first line for "${slug}" grants ${SEC_TASK} without ${SEC_CLOSE}; no intake answer does`);
    return { roles, second: o.second_review, line, n: n + 1 };
  }
  return null;
}

// What `log-event.js milestone` checks before it writes an intake line: the fields `grant` will
// read, by the same tables. Returns a message, or null when `grant` would accept the line.
function intakeProblem(o) {
  if (typeof o.milestone !== 'string' || o.milestone.trim() === '') return '"milestone" must be the slug, a non-empty string';
  if (!Array.isArray(o.xlarge_grant)) return `"xlarge_grant" must be an array of ${[...LOG_ROLES].join(', ')} ([] for none)`;
  for (const r of o.xlarge_grant) {
    if (typeof r === 'string' && has(OLD_LOG_ROLES, r)) return `"${r}" is the name from before 1.2.0; write ${OLD_LOG_ROLES[r].join(' and ')} for all security reviews, or ${SEC_CLOSE} alone for the close review only`;
    if (typeof r !== 'string' || !LOG_ROLES.has(r)) return `unknown role ${JSON.stringify(r)} in "xlarge_grant" (known: ${[...LOG_ROLES].join(', ')})`;
  }
  if (o.xlarge_grant.includes(SEC_TASK) && !o.xlarge_grant.includes(SEC_CLOSE)) return `${SEC_TASK} needs ${SEC_CLOSE}: no intake answer grants flagged task PRs without the close review`;
  if (typeof o.second_review !== 'string' || !SECOND_ORDER.includes(o.second_review)) return '"second_review" must be none, large or xlarge';
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
  // The project is found from the cwd, with no GIT_* variable in git's environment
  // (lib.grantLogRoot; decision 0029, residual d). CLAUDE_PROJECT_DIR may agree with the cwd;
  // it may not move the check to another project's log.
  const root = lib.grantLogRoot(cwd);
  const foreign = lib.foreignProjectDir(cwd);
  if (foreign) {
    return { ok: false, code: EXIT.env, milestone: slug, grant: none, reason: `CLAUDE_PROJECT_DIR (${foreign.env}) is not the project of the cwd (${root}); the log cannot be chosen by the environment. No grant. Run from the project folder; ask the user` };
  }
  const logFile = path.join(root, '.agent-team', 'logs', 'milestones.jsonl');
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
    // Checked before anything is written, so a wrong edit never reaches the file.
    const a = text.split('\n');
    const b = res.text.split('\n');
    const differ = a.length === b.length ? b.filter((l, i) => l !== a[i]).length : -1;
    const wantDiffer = res.text === text ? 0 : 1;
    if (differ !== wantDiffer) throw new Refusal(EXIT.verify, `the edit would change ${differ} lines, not ${wantDiffer}; nothing was written`);
    let back;
    try {
      if (res.text !== text) writeAtomic(file, res.text);
      back = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw new Refusal(EXIT.verify, `write failed: ${e.code || e.message}`);
    }
    // No rollback. A file that is not what this run wrote was changed by a write fault or by
    // someone else, and the two cannot be told apart: restoring would overwrite the other edit.
    if (back !== res.text) throw new Refusal(EXIT.verify, `read-back check failed: ${file} does not hold what this run wrote (a write fault, or an edit by someone else since). It was NOT restored; check ${file}`);
    out(JSON.stringify({ ok: true, code: 0, file, id: o.id, line: res.line + 1, changed: wantDiffer === 1, row: b[res.line].replace(/\r$/, '') }));
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    out(JSON.stringify({ ok: false, code: e.code, reason: e.message }));
    return e.code;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parse, check, applySet, splitCells, startsWithState, EXIT, Refusal, readLog, intakeProblem };
