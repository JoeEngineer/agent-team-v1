#!/usr/bin/env node
// Dependency-free test runner. Loads every tests/*.test.js in sorted order and
// exits 1 if any test fails or any test file throws while loading. Run: node tests/run.js
'use strict';

const fs = require('fs');
const path = require('path');
const { counts } = require('./helpers');

// Codex transcripts are opened only inside the Codex sessions folder (codex-log.inCodexSessions).
// The tests keep theirs in the temp folder, so that is the folder here; tests that check the rule set their own.
if (!process.env.AGENT_TEAM_CODEX_SESSIONS) process.env.AGENT_TEAM_CODEX_SESSIONS = require('fs').realpathSync.native(require('os').tmpdir());

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();

for (const file of files) {
  console.log(file);
  try {
    require(path.join(__dirname, file));
  } catch (err) {
    counts.failed++;
    console.log(`  FAIL (file failed to load)\n       ${err.stack || err.message}`);
  }
}

console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
process.exit(counts.failed ? 1 : 0);
