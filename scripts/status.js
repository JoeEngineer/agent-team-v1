#!/usr/bin/env node
// Safe editor and checker for the task table in a project's STATUS.md.
// No dependencies; Node 18+.
//
//   node status.js set <ID> --state <s> [--attempt <a>] [--pr <n>] [--tier <t>] [--note <text>] [--file <path>]
//   node status.js --check [--file <path>]
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
'use strict';

const fs = require('fs');
const path = require('path');

const EXIT = { ok: 0, usage: 2, header: 3, table: 4, missing: 5, duplicate: 6, state: 7, value: 8, check: 9, io: 10, verify: 11, malformed: 12, link: 13 };

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

function parseArgs(argv) {
  const o = { vals: {} };
  const flags = { '--state': 'state', '--attempt': 'attempt', '--pr': 'pr', '--tier': 'tier', '--note': 'note' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--file') {
      if (i + 1 >= argv.length) throw new Refusal(EXIT.usage, '--file needs a value');
      o.file = argv[++i];
    } else if (flags[a]) {
      if (i + 1 >= argv.length) throw new Refusal(EXIT.usage, `${a} needs a value`);
      o.vals[flags[a]] = argv[++i];
    } else if (a.startsWith('--')) throw new Refusal(EXIT.usage, `unknown option ${a}`);
    else rest.push(a);
  }
  if (o.check) {
    if (rest.length || Object.keys(o.vals).length) throw new Refusal(EXIT.usage, '--check takes only --file');
    return o;
  }
  if (rest[0] !== 'set' || rest.length !== 2) throw new Refusal(EXIT.usage, 'usage: status.js set <ID> --state <s> [--attempt <a>] [--pr <n>] [--tier <t>] [--note <text>] [--file <path>] | status.js --check [--file <path>]');
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
    const file = path.resolve(cwd, o.file || 'STATUS.md');
    if (!o.check) {
      let st = null;
      try { st = fs.lstatSync(file); } catch { /* the read below reports it */ }
      if (st && st.isSymbolicLink()) throw new Refusal(EXIT.link, `${file} is a symlink; set would replace the link with a regular file. Pass the real path with --file`);
    }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Refusal(EXIT.io, `cannot read ${file}: ${e.code || e.message}`); }
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
