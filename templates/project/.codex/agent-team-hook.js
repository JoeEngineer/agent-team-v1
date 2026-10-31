// agent-team hook shim for the Codex CLI. Generated into .codex/ by
// scripts/codex-hooks.js; commit it. The Codex CLI does not run plugin hooks, so
// .codex/hooks.json calls this file, which finds the installed agent-team plugin
// and runs one of its hook scripts. Usage: node agent-team-hook.js <script>
// (guard | log-delegation | session-start). See docs/decisions/0006.
// Fails open: if the plugin is missing, warn on stderr and exit 0.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = new Set(['guard', 'log-delegation', 'session-start']);
const WARNING = 'agent-team plugin not found; guard and logging off; GitHub rulesets still apply';

const isPluginRoot = (dir) => {
  try { return fs.statSync(path.join(dir, 'scripts', 'log-delegation.js')).isFile(); } catch { return false; }
};

// Numeric version compare ("1.10.0" > "1.9.0"); a release beats its own
// prerelease; an unparseable folder name sorts lowest.
function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(v);
  return m ? { n: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] || null } : null;
}
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return x ? 1 : (y ? -1 : 0);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const subdirs = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
};

// AGENT_TEAM_PLUGIN_ROOT, then the highest version in the Codex plugin cache:
// <CODEX_HOME or ~/.codex>/plugins/cache/<marketplace>/agent-team/<version>/
function findPluginRoot() {
  const forced = process.env.AGENT_TEAM_PLUGIN_ROOT;
  if (forced && isPluginRoot(forced)) return forced;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const cache = path.join(home, 'plugins', 'cache');
  let best = null;
  for (const market of subdirs(cache).sort()) {
    const pluginDir = path.join(cache, market, 'agent-team');
    for (const version of subdirs(pluginDir)) {
      const dir = path.join(pluginDir, version);
      if (!isPluginRoot(dir)) continue;
      if (!best || compareVersions(version, best.version) > 0) best = { version, dir };
    }
  }
  return best && best.dir;
}

function readStdin() {
  try { return fs.readFileSync(0); } catch { return Buffer.alloc(0); }
}

function write(fd, buf) {
  try { fs.writeSync(fd, buf); } catch { /* closed pipe: nothing to do */ }
}

function main() {
  // Last argument: `node file.js guard` and `node -e "require(...)" guard` both end with it.
  const name = process.argv[process.argv.length - 1];
  if (!SCRIPTS.has(name)) { write(2, `agent-team-hook: unknown script "${name}"\n`); return 0; }
  const pluginRoot = findPluginRoot();
  if (!pluginRoot) { write(2, WARNING + '\n'); return 0; }
  // This file lives in <project>/.codex/, so the project root is one level up.
  const project = path.resolve(__dirname, '..');
  const r = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', `${name}.js`)], {
    input: readStdin(),
    env: {
      AGENT_TEAM_TOOL: 'codex', // only Codex calls this file; an explicit value still wins
      ...process.env,
      AGENT_TEAM_HOOK_SOURCE: 'project',
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) { write(2, WARNING + '\n'); return 0; }
  if (r.stdout && r.stdout.length) write(1, r.stdout);
  if (r.stderr && r.stderr.length) write(2, r.stderr);
  return r.status == null ? 0 : r.status;
}

let code = 0;
try { code = main(); } catch { code = 0; }
process.exitCode = code;
