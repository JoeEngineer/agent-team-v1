#!/usr/bin/env node
// Wait for, or check, the CI of a pull request (GitHub, via `gh`) or merge
// request (GitLab, via `glab`), with a deadline of its own. One JSON line per
// request goes to stdout; the exit code says what to do next. Design:
// docs/decisions/0011-ci-wait-helper.md and 0012-merge-without-waiting.md.
//
//   node scripts/ci-wait.js <n> [--sha <sha>] [--timeout <s>=540] [--interval <s>=30]
//                           [--grace <s>=120] [--allow-none]
//   node scripts/ci-wait.js --once <n> [<n>...]  [--sha <sha>]   (up to 20; one check each)
//   node scripts/ci-wait.js --names <n>                           (setup info; read-only)
//   (also: --call-timeout <s>=30, the limit on one gh/glab call)
//
// Exit codes: 0 green, 1 red, 8 pending (deadline reached), 3 none (no CI after
// the grace period), 4 head moved (--sha given, head differs), 2 unknown/error.
// --allow-none turns 3 into 0. With several requests, the worst wins, in the
// order 2 > 4 > 1 > 8 > 3 > 0: a result we can't trust or a gate that no longer
// applies comes first, then a definite failure, then "not yet", then "no CI".
//
// Node built-ins only; the forge CLIs are run with argument arrays (no shell),
// so it behaves the same from bash and Windows PowerShell 5.1.
'use strict';

const forgeLib = require('./forge.js');

const DEFAULTS = { timeout: 540, interval: 30, grace: 120, callTimeout: 30 };
const MAX_ONCE = 20;
const EXIT_OF = { green: 0, red: 1, pending: 8, none: 3, unknown: 2 };
const EXIT_MOVED = 4;
const WORST_FIRST = [2, 4, 1, 8, 3, 0];

const USAGE = [
  'usage: ci-wait.js <n> [--sha <sha>] [--timeout <s>=540] [--interval <s>=30] [--grace <s>=120] [--allow-none]',
  '       ci-wait.js --once <n> [<n>...] [--sha <sha>] [--allow-none]   (up to 20 requests)',
  '       ci-wait.js --names <n>',
  '       (--call-timeout <s>=30 limits one gh/glab call)',
].join('\n');

// ---------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const o = { mode: 'wait', prs: [], sha: null, allowNone: false, ...DEFAULTS };
  const numeric = { '--timeout': 'timeout', '--interval': 'interval', '--grace': 'grace', '--call-timeout': 'callTimeout' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    const value = () => {
      if (inline !== null) return inline;
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--once') {
      if (o.mode === 'names') throw new Error('--once and --names can not be combined');
      o.mode = 'once';
    } else if (a === '--names') {
      if (o.mode === 'once') throw new Error('--once and --names can not be combined');
      o.mode = 'names';
    } else if (a === '--allow-none') o.allowNone = true;
    else if (a === '--sha') {
      const v = value();
      if (!/^[0-9a-f]{7,40}$/i.test(v)) throw new Error(`--sha needs 7 to 40 hex characters, got '${v}'`);
      o.sha = v.toLowerCase();
    } else if (numeric[a]) {
      const v = value();
      const n = Number(v);
      if (v === '' || !Number.isFinite(n) || n < 0 || ((a === '--interval' || a === '--call-timeout') && n === 0)) {
        throw new Error(`${a} needs a number of seconds${a === '--interval' || a === '--call-timeout' ? ' above 0' : ''}, got '${v}'`);
      }
      o[numeric[a]] = n;
    } else if (/^\d+$/.test(a) && Number(a) > 0) {
      if (!o.prs.includes(Number(a))) o.prs.push(Number(a));
    } else throw new Error(`unknown argument '${argv[i]}'`);
  }
  if (o.mode === 'once') {
    if (o.prs.length < 1 || o.prs.length > MAX_ONCE) throw new Error(`--once needs 1 to ${MAX_ONCE} request numbers`);
  } else if (o.prs.length !== 1) throw new Error('give exactly one request number');
  if (o.sha && o.prs.length > 1) throw new Error('--sha applies to one request; run --once once per request');
  return o;
}

// ---------------------------------------------------------------------------
// Decisions

// What to report for a head's checks. Pure: no clock, no CLI.
//   status    the forge's normalized status (forge.requestStatus)
//   required  { names: [...] | null, note }   names null = decide on all checks
//   elapsedS  seconds since we started looking; graceS how long "no CI yet" may last
//   once      a single look: nothing will change while we wait, so no grace
// Returns { ci, required, failing, pending, note: [string] }.
function decide({ forge, status, required, elapsedS, graceS, once }) {
  const notes = [];
  if (status.state && status.state !== 'OPEN') notes.push(`${forgeLib.noun(forge)} is ${status.state}`);

  const noCi = (what) => {
    if (once) { notes.push(`no ${what} on the head (--once does not wait for CI to start)`); return 'none'; }
    if (elapsedS >= graceS) { notes.push(`no ${what} on the head after the ${graceS}s grace period`); return 'none'; }
    notes.push(`no ${what} yet; allowing ${graceS}s for CI to start`);
    return 'pending';
  };

  if (forge === 'gitlab') {
    const p = status.pipeline;
    const m = forgeLib.gitlabPipelineCi(p && p.status);
    const label = p && p.id != null ? `pipeline #${p.id}` : 'pipeline';
    let ci = m.ci;
    if (ci === 'none') {
      if (p && p.status) notes.push(m.note);
      ci = noCi('pipeline');
    } else if (m.note) notes.push(m.note);
    return {
      ci, required: null, note: notes,
      failing: ci === 'red' ? [label] : [], pending: ci === 'pending' && p ? [label] : [],
    };
  }

  const checks = status.checks;
  if (required.names) {
    const failing = new Set();
    const pending = new Set();
    const missing = [];
    for (const name of required.names) {
      const found = checks.filter((c) => c.name === name);
      if (!found.length) { missing.push(name); continue; }
      for (const c of found) {
        if (c.state === 'fail') failing.add(name);
        else if (c.state === 'pending') pending.add(name);
      }
    }
    for (const m of missing) pending.add(m);
    if (missing.length) notes.push(`required check${missing.length > 1 ? 's' : ''} not on the head: ${missing.join(', ')}`);
    const ci = failing.size ? 'red' : pending.size ? 'pending' : 'green';
    return { ci, required: required.names, failing: [...failing], pending: [...pending], note: notes };
  }

  if (required.note) notes.push(required.note);
  if (!checks.length) return { ci: noCi('checks'), required: null, failing: [], pending: [], note: notes };
  const names = (state) => [...new Set(checks.filter((c) => c.state === state).map((c) => c.name))];
  const failing = names('fail');
  const pending = names('pending');
  const ci = failing.length ? 'red' : pending.length ? 'pending' : 'green';
  return { ci, required: null, failing, pending, note: notes };
}

function headMatches(head, want) {
  return String(head).toLowerCase().startsWith(want);
}

// The exit code for one result record.
function exitOf(rec) {
  if (rec.sha_matches === false) return EXIT_MOVED;
  return EXIT_OF[rec.ci];
}

// The worst of several exit codes, in WORST_FIRST order.
function worst(codes) {
  for (const c of WORST_FIRST) if (codes.includes(c)) return c;
  return 0;
}

// ---------------------------------------------------------------------------
// One request

function record(forge, pr, f) {
  return {
    pr, forge, ci: f.ci, head_sha: f.head_sha || null, sha_matches: f.sha_matches === undefined ? null : f.sha_matches,
    required: f.required || null, failing: f.failing || [], pending: f.pending || [],
    waited_s: f.waited_s, note: (f.note || []).filter(Boolean).join('; '),
  };
}

// Forge calls need a time limit that never lets a hung CLI outlive the
// deadline by more than one interval.
function limitMs(ctx, deadline) {
  let ms = ctx.opts.callTimeout * 1000;
  if (deadline != null) ms = Math.min(ms, Math.max(1000, deadline + ctx.opts.interval * 1000 - ctx.now()));
  return Math.round(ms);
}

// The required checks of a base, looked up once per base per invocation.
function requiredFor(ctx, base, deadline) {
  if (ctx.forge === 'gitlab') return { names: null, note: '' };
  if (ctx.required.has(base)) return ctx.required.get(base);
  const r = forgeLib.requiredChecks(ctx.forge, base, ctx.cwd, limitMs(ctx, deadline), ctx.run);
  let v;
  if (!r.ok) v = { names: null, note: `could not read the required checks of '${base}' (${r.error}); decided on all checks` };
  else if (!r.names.length) v = { names: null, note: `no required checks on '${base}'; decided on all checks` };
  else v = { names: r.names, note: '' };
  ctx.required.set(base, v);
  return v;
}

// One look at one request: a status call (plus the required-checks lookup the
// first time a base is seen) and a decision. Returns { rec } or { error, notFound }.
function look(ctx, n, startedAt, deadline) {
  const status = forgeLib.requestStatus(ctx.forge, n, ctx.cwd, limitMs(ctx, deadline), ctx.run);
  if (!status.ok) return { error: status.error, notFound: status.notFound };
  const waited = (ctx.now() - startedAt) / 1000;
  const moved = ctx.opts.sha ? !headMatches(status.head_sha, ctx.opts.sha) : false;
  const sha_matches = ctx.opts.sha ? !moved : null;
  if (moved) {
    return {
      rec: record(ctx.forge, n, {
        ci: 'unknown', head_sha: status.head_sha, sha_matches, waited_s: round1(waited),
        note: [`head moved: expected ${ctx.opts.sha}, now ${status.head_sha}`],
      }),
    };
  }
  const required = requiredFor(ctx, status.base, deadline);
  const d = decide({ forge: ctx.forge, status, required, elapsedS: waited, graceS: ctx.opts.grace, once: ctx.opts.mode === 'once' });
  return { rec: record(ctx.forge, n, { ...d, head_sha: status.head_sha, sha_matches, waited_s: round1(waited) }) };
}

const round1 = (x) => Math.round(x * 10) / 10;

const unknownRec = (ctx, n, startedAt, why) =>
  record(ctx.forge, n, { ci: 'unknown', waited_s: round1((ctx.now() - startedAt) / 1000), note: [why] });

function checkOnce(ctx, n) {
  const t0 = ctx.now();
  try {
    const r = look(ctx, n, t0, null);
    return r.rec || unknownRec(ctx, n, t0, `${forgeLib.viewCommand(ctx.forge)} failed: ${r.error}`);
  } catch (err) {
    return unknownRec(ctx, n, t0, `internal error: ${err.message}`);
  }
}

// Poll until the result is final or the deadline is reached. At most
// ceil(timeout / interval) status calls (the last one at the deadline), plus the
// required-checks lookup (two calls) the first time.
function waitFor(ctx, n) {
  const { timeout, interval } = ctx.opts;
  const t0 = ctx.now();
  const deadline = t0 + timeout * 1000;
  const polls = Math.max(1, Math.ceil(timeout / interval));
  let last = null;
  let errors = 0;
  let lastError = '';
  for (let k = 1; k <= polls; k++) {
    const startedPoll = ctx.now();
    let r;
    try {
      r = look(ctx, n, t0, deadline);
    } catch (err) {
      r = { error: `internal error: ${err.message}` };
    }
    if (r.rec) {
      errors = 0;
      lastError = '';
      last = r.rec;
      if (r.rec.ci !== 'pending') return r.rec;
    } else {
      errors++;
      lastError = r.error;
      // A missing request or a broken CLI won't fix itself; a blip might.
      if (k === 1 || r.notFound || errors >= 3) {
        return unknownRec(ctx, n, t0, `${forgeLib.viewCommand(ctx.forge)} failed: ${r.error}${errors >= 3 ? ` (${errors} failures in a row)` : ''}`);
      }
    }
    if (k === polls) break;
    // The last poll lands on the deadline, so the wait ends when it says it will.
    const next = k === polls - 1 ? Math.max(startedPoll + interval * 1000, deadline) : startedPoll + interval * 1000;
    ctx.sleep(Math.max(0, next - ctx.now()));
  }
  // The last look failed: what we saw before may be stale, so don't report it.
  if (lastError) return unknownRec(ctx, n, t0, `${forgeLib.viewCommand(ctx.forge)} failed on the last check: ${lastError}`);
  return { ...last, waited_s: round1((ctx.now() - t0) / 1000), note: [last.note, `deadline reached after ${round1((ctx.now() - t0) / 1000)}s`].filter(Boolean).join('; ') };
}

// --names: what the head is running, what the base requires, whether the repo
// allows auto-merge. Read-only.
function names(ctx, n) {
  const status = forgeLib.requestStatus(ctx.forge, n, ctx.cwd, limitMs(ctx, null), ctx.run);
  if (!status.ok) return { code: 2, line: { pr: n, forge: ctx.forge, ci: 'unknown', note: `${forgeLib.viewCommand(ctx.forge)} failed: ${status.error}` } };
  const notes = [];
  let checks = status.checks.map((c) => c.name);
  let required = null;
  let extra = {};
  if (ctx.forge === 'gitlab') {
    if (status.pipeline && status.pipeline.id != null) {
      const j = forgeLib.pipelineJobNames(status.pipeline.id, ctx.cwd, limitMs(ctx, null), ctx.run);
      if (j.ok) checks = j.names; else notes.push(`could not read the pipeline's jobs (${j.error})`);
    } else notes.push('no pipeline on the MR head');
    const s = forgeLib.repoSettings(ctx.forge, ctx.cwd, limitMs(ctx, null), ctx.run);
    if (s.ok) extra = { auto_merge_allowed: null, only_allow_merge_if_pipeline_succeeds: s.only_allow_merge_if_pipeline_succeeds };
    else { extra = { auto_merge_allowed: null, only_allow_merge_if_pipeline_succeeds: null }; notes.push(`could not read project settings (${s.error})`); }
  } else {
    const r = forgeLib.requiredChecks(ctx.forge, status.base, ctx.cwd, limitMs(ctx, null), ctx.run);
    if (r.ok) required = r.names; else notes.push(`could not read the required checks of '${status.base}' (${r.error})`);
    const s = forgeLib.repoSettings(ctx.forge, ctx.cwd, limitMs(ctx, null), ctx.run);
    extra = { auto_merge_allowed: s.ok ? s.auto_merge_allowed : null };
    if (!s.ok) notes.push(`could not read the repo settings (${s.error})`);
    else if (s.auto_merge_allowed === null) notes.push('auto_merge_allowed is not visible to this account');
  }
  return {
    code: 0,
    line: { pr: n, forge: ctx.forge, head_sha: status.head_sha, base: status.base, checks, required, ...extra, note: notes.join('; ') },
  };
}

// ---------------------------------------------------------------------------
// Entry point. `deps` lets tests inject the CLI runner, the clock, the sleep and
// the output. Returns the exit code. Everything is synchronous (the forge calls
// already block), so the sleep is too.

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main(argv, deps = {}) {
  const out = deps.out || ((l) => process.stdout.write(`${l}\n`));
  const errOut = deps.err || ((l) => process.stderr.write(`${l}\n`));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    errOut(`ci-wait: ${e.message}\n${USAGE}`);
    return 2;
  }
  const cwd = deps.cwd || process.cwd();
  const ctx = {
    opts, cwd,
    forge: deps.forge || forgeLib.detect(cwd, deps.env || process.env),
    run: deps.run || forgeLib.cli,
    now: deps.now || Date.now,
    sleep: deps.sleep || sleepSync,
    required: new Map(),
  };

  if (opts.mode === 'names') {
    let r;
    try {
      r = names(ctx, opts.prs[0]);
    } catch (e) {
      r = { code: 2, line: { pr: opts.prs[0], forge: ctx.forge, ci: 'unknown', note: `internal error: ${e.message}` } };
    }
    out(JSON.stringify(r.line));
    return r.code;
  }

  const codes = [];
  for (const n of opts.prs) {
    const rec = opts.mode === 'once' ? checkOnce(ctx, n) : waitFor(ctx, n);
    out(JSON.stringify(rec));
    const code = exitOf(rec);
    codes.push(code === 3 && opts.allowNone ? 0 : code);
  }
  return worst(codes);
}

if (require.main === module) {
  // exitCode, not exit(): lets stdout drain when it is a pipe.
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`ci-wait: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 2;
  }
}

module.exports = { main, parseArgs, decide, worst, exitOf, DEFAULTS, MAX_ONCE };
