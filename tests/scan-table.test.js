// The scan-state table in agents/security-reviewer.md ("Scan status") against
// decision 0024: shape, row order, and the worked matrix. The matrix is parsed
// from the decision record, so the record and the test cannot drift apart.
'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert, eq, ROOT } = require('./helpers');

console.log('scan table');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const ROLE = read('agents/security-reviewer.md');
const DECISION = read('docs/decisions/0024-scan-state-table.md');

const VALUES = ['green', 'red', 'none', 'unknown'];
// 0024's order, pinned as literals.
const EXPECTED_ROWS = [
  ['Any failed, even with a moved head or others skipped or unreadable', 'red'],
  ['The head moved', 'unknown'],
  ['The diff removes or disables a scanner job the base has (deletion, an `if:` that never runs, or a dropped trigger)', 'unknown'],
  ['Base and head both have no scanner jobs', 'none'],
  ['Checks unreadable, or any still pending after the wait', 'unknown'],
  ['Any unscanned without cause', 'unknown'],
  ['All unscanned with cause', 'none'],
  ['All the rest passed', 'green'],
  ['Anything else', 'unknown'],
];

// The rows of the table that follows "5. Report `scan`" in a text.
function tableRows(src) {
  const at = src.indexOf('5. Report `scan` from the first row that matches:');
  assert(at >= 0, 'step 5 line not found');
  const lines = src.slice(at).split('\n').slice(1);
  const rows = [];
  let started = false;
  for (const line of lines) {
    if (!line.startsWith('|')) {
      if (started) break;
      continue;
    }
    started = true;
    rows.push(line.split('|').slice(1, -1).map((c) => c.trim()));
  }
  // rows[0] is the header, rows[1] the separator.
  assert(rows.length > 2, 'scan table not found');
  return rows.slice(2);
}

// Reference evaluator, ported from decision 0024. It is hard-coded, so it stays
// tied to the role file only because the role file's rows are pinned to
// EXPECTED_ROWS (and the evaluator's row count is asserted equal to it).
const UNSCANNED = ['skip', 'missing', 'noscan', 'unconfirmed'];
function scanState({ head, jobs, readable, removed, states }) {
  const s = states === '-' ? [] : states.split(',');
  const cause = (x) => x.endsWith('+cause');
  const unscanned = (x) => UNSCANNED.includes(x.replace('+cause', ''));
  if (s.includes('fail')) return ['red', 1];
  if (head === 'moved') return ['unknown', 2];
  if (removed === 'yes') return ['unknown', 3];
  if (jobs === 'none') return ['none', 4];
  if (readable === 'no' || s.includes('pending')) return ['unknown', 5];
  if (s.some((x) => unscanned(x) && !cause(x))) return ['unknown', 6];
  if (s.length > 0 && s.every((x) => unscanned(x) && cause(x))) return ['none', 7];
  const rest = s.filter((x) => !(unscanned(x) && cause(x)));
  if (rest.length > 0 && rest.every((x) => x === 'pass')) return ['green', 8];
  return ['unknown', 9];
}

function matrix() {
  const at = DECISION.indexOf('## Worked matrix');
  assert(at >= 0, 'worked matrix not found in 0024');
  return DECISION.slice(at).split('\n').filter((l) => /^\| M\d+ \|/.test(l)).map((l) => {
    const [id, head, jobs, readable, removed, states, scan, row] = l.split('|').slice(1, -1).map((c) => c.trim());
    return { id, head, jobs, readable, removed, states, scan, row: Number(row) };
  });
}

const rows = tableRows(ROLE);

// The whole "Scan status" section of the role file, from its heading to the
// blank line before "## Coverage", against the fenced text in 0024.
function section(src) {
  const a = src.indexOf('## Scan status\n');
  const b = src.indexOf('## Coverage');
  assert(a >= 0 && b > a, 'Scan status section not found');
  return src.slice(a, b);
}

test('scan table: the Scan status section equals the replacement text in 0024 byte for byte', () => {
  const m = DECISION.match(/```markdown\n(## Scan status\n[\s\S]*?\n\n)```/);
  assert(m, 'replacement text not found in 0024');
  assert(section(ROLE) === m[1], 'the Scan status section differs from 0024');
});

test('scan table: the evaluator has as many rows as EXPECTED_ROWS', () => {
  const top = Math.max(...matrix().map((c) => scanState(c)[1]));
  eq(top, EXPECTED_ROWS.length, 'highest row the evaluator returns');
});

test('scan table: red is the first row and the head moved row comes after it', () => {
  assert(rows[0][1] === '`red`', `first row is ${rows[0].join(' | ')}`);
  const moved = rows.findIndex((r) => r[0] === 'The head moved');
  assert(moved > 0, 'head moved row missing or first');
});

test('scan table: each row has exactly one of green, red, none, unknown', () => {
  eq(rows.length, 9, 'row count');
  for (const r of rows) {
    eq(r.length, 2, `row has two cells: ${r.join(' | ')}`);
    const v = r[1].match(/^`(.+)`$/);
    assert(v && VALUES.includes(v[1]), `row value is not one of ${VALUES}: ${r[1]}`);
  }
});

test('scan table: the row order and values equal 0024, and Anything else is last', () => {
  eq(JSON.stringify(rows.map((r) => [r[0], r[1].replace(/`/g, '')])), JSON.stringify(EXPECTED_ROWS), 'rows of the role file');
  eq(JSON.stringify(tableRows(DECISION).map((r) => [r[0], r[1].replace(/`/g, '')])), JSON.stringify(EXPECTED_ROWS), 'rows of the decision record');
  eq(rows[rows.length - 1][0], 'Anything else', 'last row');
});

test('scan table: the worked matrix has 31 cases and every case resolves by first match', () => {
  const cases = matrix();
  eq(cases.length, 31, 'matrix cases parsed from 0024');
  const hit = new Set();
  for (const c of cases) {
    const [scan, row] = scanState(c);
    eq(scan, c.scan, `${c.id} value`);
    eq(row, c.row, `${c.id} row`);
    // The value the role file's table gives for that row is the expected one.
    eq(rows[row - 1][1].replace(/`/g, ''), c.scan, `${c.id}: role file row ${row}`);
    hit.add(row);
  }
  eq([...hit].sort().join(), '1,2,3,4,5,6,7,8,9', 'every row is hit by a case');
});
