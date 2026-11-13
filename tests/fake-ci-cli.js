// A stand-in for `gh` / `glab` that plays back a sequence of responses, used by
// tests/ci-wait.test.js two ways:
//   - in process: new Playback(routes).runner() is the `run` that ci-wait's
//     forge calls use, and records every call;
//   - as a script: AGENT_TEAM_FAKE_GH / AGENT_TEAM_FAKE_GLAB point at this file,
//     with FAKE_CI_ROUTES (a JSON file), FAKE_CI_STATE (counters, same folder) and
//     optionally FAKE_CI_LOG / FAKE_CI_PID set.
//
// routes: { <key>: response | [response, ...] }. A list plays in order and the
// last entry repeats. A response is a string (stdout), { err: 'stderr text' } (the
// call fails), { hang: true } (the call never returns; with a timeout it is
// killed), or { sleep: ms, then: response } (as a script: wait ms, then answer;
// in process the wait is skipped). Keys: view:<n> (falls back to view), rules, protection, repo, project,
// jobs. A call with no route fails loudly, so a test can't pass on a typo.
'use strict';

const fs = require('fs');

function keyOf(args) {
  const [a, b, c] = args;
  if ((a === 'pr' || a === 'mr') && b === 'view') return `view:${c}`;
  if (a === 'api') {
    if (/\/rules\/branches\//.test(b)) return 'rules';
    if (/\/protection\/required_status_checks$/.test(b)) return 'protection';
    if (/^projects\/:id\/pipelines\/.+\/jobs/.test(b)) return 'jobs';
    if (b === 'projects/:id') return 'project';
    if (b === 'repos/{owner}/{repo}') return 'repo';
  }
  return `unrouted:${args.join(' ')}`;
}

class Playback {
  constructor(routes, counts = {}) {
    this.routes = routes;
    this.counts = counts;
    this.calls = []; // { forge, key, args, timeout }
  }

  // The response for the next call with these arguments.
  next(args) {
    let key = keyOf(args);
    if (!(key in this.routes) && key.startsWith('view:')) key = 'view';
    if (!(key in this.routes)) return { err: `fake CLI: no route for ${keyOf(args)}` };
    const r = this.routes[key];
    if (!Array.isArray(r)) return r;
    const i = this.counts[key] || 0;
    this.counts[key] = i + 1;
    return r[Math.min(i, r.length - 1)];
  }

  // A `run(forge, args, cwd, timeout)` like forge.cli: returns stdout or throws
  // the way execFileSync does.
  runner() {
    return (forge, args, cwd, timeout) => {
      this.calls.push({ forge, key: keyOf(args), args, timeout });
      let r = this.next(args);
      if (r && r.sleep !== undefined) r = r.then;
      if (r && r.hang) {
        const e = new Error(`spawnSync gh ETIMEDOUT`);
        e.code = 'ETIMEDOUT'; e.killed = true; e.signal = 'SIGKILL';
        throw e;
      }
      if (r && r.err !== undefined) {
        const e = new Error(`Command failed: gh ${args.join(' ')}\n${r.err}`);
        e.status = 1; e.stderr = r.err; e.stdout = '';
        throw e;
      }
      return typeof r === 'string' ? r : '';
    };
  }

  count(key) { return this.calls.filter((c) => c.key === key || (key === 'view' && c.key.startsWith('view:'))).length; }
}

if (require.main === module) {
  const routes = JSON.parse(fs.readFileSync(process.env.FAKE_CI_ROUTES, 'utf8'));
  const stateFile = process.env.FAKE_CI_STATE;
  const counts = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const args = process.argv.slice(2);
  if (process.env.FAKE_CI_LOG) fs.appendFileSync(process.env.FAKE_CI_LOG, `${JSON.stringify(args)}\n`);
  let r = new Playback(routes, counts).next(args);
  fs.writeFileSync(stateFile, JSON.stringify(counts));
  if (r && r.sleep !== undefined) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, r.sleep);
    r = r.then;
  }
  if (r && r.hang) {
    if (process.env.FAKE_CI_PID) fs.appendFileSync(process.env.FAKE_CI_PID, `${process.pid}\n`);
    setInterval(() => {}, 1000);
  } else if (r && r.err !== undefined) {
    process.stderr.write(`${r.err}\n`);
    process.exit(1);
  } else {
    process.stdout.write(typeof r === 'string' ? r : '');
  }
}

module.exports = { Playback, keyOf };
