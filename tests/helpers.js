// Shared helpers for the test files in this folder. Each tests/*.test.js does
// `const { ... } = require('./helpers')` and registers tests with test(), which
// is picked up by tests/run.js. Node built-ins only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

// Shared pass/fail counters. run.js reads these for the final total and exit code.
const counts = { passed: 0, failed: 0 };

// A models.json path that is guaranteed not to exist, so no test reads a real
// user-level ~/.agent-team/models.json. Callers can still override via `env`.
const NO_MODELS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-no-models-')), 'models.json');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-test-'));
  execFileSync('git', ['init', '-q', '-b', 'task/T-1'], { cwd: dir });
  return dir;
}

function run(script, input, projectDir, env = {}) {
  return spawnSync('node', [path.join(SCRIPTS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE, ...env },
  });
}

// A fake `gh` (a Node script the logger runs via AGENT_TEAM_FAKE_GH, so it
// works on Windows too) that prints FAKE_GH_OUT, exits FAKE_GH_EXIT, and
// records its arguments in FAKE_GH_ARGS.
const FAKE_GH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-bin-')), 'fake-gh.js');
fs.writeFileSync(FAKE_GH,
  "if (process.env.FAKE_GH_ARGS) require('fs').appendFileSync(process.env.FAKE_GH_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n');\n" +
  "process.stdout.write(process.env.FAKE_GH_OUT || '');\n" +
  "process.exit(Number(process.env.FAKE_GH_EXIT || 0));\n");
const fakeGh = (out, exit = 0, extra = {}) => ({ AGENT_TEAM_FAKE_GH: FAKE_GH, FAKE_GH_OUT: out, FAKE_GH_EXIT: String(exit), ...extra });

function readLog(projectDir, file) {
  const p = path.join(projectDir, '.agent-team', 'logs', file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function test(name, fn) {
  try {
    fn();
    counts.passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    counts.failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

module.exports = {
  ROOT, SCRIPTS, NO_MODELS_FILE, counts,
  tmpProject, run, FAKE_GH, fakeGh, readLog, test, assert, eq,
};
