// A test file run on its own (node tests/x.test.js) exits 1 when a test fails
// and 0 when all pass. Spawns fixtures under tests/fixtures/.
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { test, eq, assert } = require('./helpers');

console.log('standalone-exit');

const runAlone = (f) => spawnSync('node', [path.join(__dirname, 'fixtures', f)], { encoding: 'utf8', timeout: 30000 });

test('a file run alone with a failing test exits 1', () => {
  const r = runAlone('exit-fail.js');
  assert(/FAIL fails/.test(r.stdout), 'precondition: the failing test ran and reported FAIL');
  eq(r.status, 1, 'exit code');
});

test('a file run alone with only passing tests exits 0', () => {
  const r = runAlone('exit-pass.js');
  assert(/ok   passes/.test(r.stdout), 'precondition: the test ran');
  eq(r.status, 0, 'exit code');
});
