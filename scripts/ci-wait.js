#!/usr/bin/env node
// Wait for, or check, the CI of a pull request (GitHub, via `gh`) or merge
// request (GitLab, via `glab`), with a deadline of its own. One JSON line per
// request goes to stdout; the exit code says what to do next. Design:
// docs/decisions/0011-ci-wait-helper.md and 0012-merge-without-waiting.md.
//
//   node scripts/ci-wait.js <n> [--sha <sha>] [--timeout <s>=540] [--interval <s>=30]
//                           [--grace <s>=120] [--allow-none]
//   node scripts/ci-wait.js --once <n> [<n>...]  [--sha <sha>] [--allow-none]   (up to 20; one check each)
//   node scripts/ci-wait.js --names <n>                           (setup info; read-only)
//   node scripts/ci-wait.js <n> --queue-check --sha <sha>         (gate for an auto-merge queue call)
//   (also: --call-timeout <s>=30, the limit on one gh/glab call)
//
// Exit codes: 0 green, 1 red, 8 pending (deadline reached), 3 none (no CI after
// the grace period), 4 head moved (--sha given, head differs), 2 unknown/error,
// 5 not queueable (--queue-check only).
// --allow-none turns 3 into 0. In --once mode it does so only with a matching
// --sha (whoever passes --sha already waited out the grace period on that
// head); --once --allow-none without --sha still exits 3 on none, because a
// just-pushed head may not have registered its checks yet. With several
// requests, the worst wins, in the order 2 > 4 > 1 > 8 > 3 > 0: a result we
// can't trust or a gate that no longer applies comes first, then a definite
// failure, then "not yet", then "no CI". A code outside that list (or no code
// at all) counts as 2: an unmapped result must never read as green.
//
// --queue-check (decision 0018) is a one-shot read, no waiting, for the call
// that queues an auto-merge (`gh pr merge --auto` / `glab mr merge --auto-merge`).
// Those merge at once when nothing makes them wait, so a queue is safe only
// when the forge itself holds the merge for CI. Exit 0 (queueable) only when
// the head equals --sha (else 4), nothing is red (else 1), and
//   GitHub: the base requires a non-empty list of checks and the head runs (or
//           has queued) every one of them (else 5);
//   GitLab: the project setting "Pipelines must succeed"
//           (only_allow_merge_if_pipeline_succeeds) is on and the MR head has a
//           pipeline (else 5).
// A required set or setting that can't be read is 2 (fail closed, decision
// 0014). Pending CI is fine: that is what the queue waits for. The line is the
// --once line plus `queueable` (true|false) and `queue_reason`. When several
// apply, 2 > 4 > 1 > 5.
//
// Required checks (GitHub): the base's rulesets and classic branch protection
// decide which checks count. `required: [...]` lists them. `required: null`
// with a green/red/pending result means both were read and nothing is
// required, so every check on the head counts. If either can't be read (classic
// protection needs admin rights; a non-admin or fine-grained token gets 403),
// the result is `unknown` (exit 2) with a note naming what failed, never a
// guess from all checks: a required check that hasn't started would be missed.
// A lookup that failed on a timeout or a 5xx is retried on the next poll; a
// 401/403/404 is final. Decision: docs/decisions/0014-ci-wait-fail-closed.md.
//
// Node built-ins only; the forge CLIs are run with argument arrays (no shell),
// so it behaves the same from bash and Windows PowerShell 5.1.
'use strict';

const forgeLib = require('./forge.js');

const DEFAULTS = { timeout: 540, interval: 30, grace: 120, callTimeout: 30 };
const MAX_ONCE = 20;
const EXIT_OF = { green: 0, red: 1, pending: 8, none: 3, unknown: 2 };
const EXIT_MOVED = 4;
const EXIT_NOT_QUEUEABLE = 5;
const WORST_FIRST = [2, 4, 1, 5, 8, 3, 0];

const USAGE = [
  'usage: ci-wait.js <n> [--sha <sha>] [--timeout <s>=540] [--interval <s>=30] [--grace <s>=120] [--allow-none]',
  '       ci-wait.js --once <n> [<n>...] [--sha <sha>] [--allow-none]   (up to 20 requests)',
  '       ci-wait.js --names <n>',
  '       ci-wait.js <n> --queue-check --sha <sha>   (one read; gate for gh pr merge --auto / glab mr merge --auto-merge)',
  '       (--call-timeout <s>=30 limits one gh/glab call)',
  'exit: 0 green, 1 red, 8 pending, 3 none, 4 head moved, 2 unknown/error.',
  '--queue-check exit: 0 queueable, 1 red, 2 unknown (required checks or setting unreadable),',
  '  4 head moved, 5 not queueable (GitHub: no required checks, or a required check the head',
  '  does not run; GitLab: "Pipelines must succeed" is off). --sha is required; it can not be',
  '  combined with --once, --names, --allow-none or --timeout.',
  '--allow-none turns 3 into 0; with --once only when --sha is given and matches.',
  'required: [...] = the checks the base requires; null = none required, all checks',
  'count. Required checks that cannot be read (e.g. 403) give unknown (exit 2).',
].join('\n');

// ---------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const o = { mode: 'wait', prs: [], sha: null, allowNone: false, ...DEFAULTS };
  const numeric = { '--timeout': 'timeout', '--interval': 'interval', '--grace': 'grace', '--call-timeout': 'callTimeout' };
  const MODES = { '--once': 'once', '--names': 'names', '--queue-check': 'queue' };
  const seen = new Set();
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
    // A switch takes no value: `--allow-none=false` must not turn it on.
    if ((MODES[a] || a === '--allow-none') && inline !== null) throw new Error(`${a} takes no value, got '${argv[i]}'`);
    if (a.startsWith('--')) seen.add(a);
    if (MODES[a]) {
      if (o.mode !== 'wait' && o.mode !== MODES[a]) {
        const other = Object.keys(MODES).find((k) => MODES[k] === o.mode);
        throw new Error(`${other} and ${a} can not be combined`);
      }
      o.mode = MODES[a];
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
  if (o.mode === 'queue') {
    for (const f of ['--allow-none', '--timeout']) if (seen.has(f)) throw new Error(`--queue-check and ${f} can not be combined`);
    if (!o.sha) throw new Error('--queue-check needs --sha <head_sha> (the reviewed head)');
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
//   required  { names: [...] | null, note, unreadable }   names null = nothing is
//             required, decide on all checks; unreadable = the required set
//             couldn't be read, so the result is 'unknown' (never green)
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
  // Fail closed: without the required set, a required check that hasn't
  // started yet is invisible, so no reading of the head can be trusted.
  if (required.unreadable) {
    notes.push(required.note);
    return { ci: 'unknown', required: null, failing: [], pending: [], note: notes };
  }
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

// The exit code for one result record. A ci value with no code is unknown (2).
function exitOf(rec) {
  if (rec.sha_matches === false) return EXIT_MOVED;
  return Object.prototype.hasOwnProperty.call(EXIT_OF, rec.ci) ? EXIT_OF[rec.ci] : EXIT_OF.unknown;
}

// The worst of several exit codes, in WORST_FIRST order. An unmapped code, or
// no code at all, is 2: only codes we know may decide the result.
function worst(codes) {
  if (!codes.length || codes.some((c) => !WORST_FIRST.includes(c))) return EXIT_OF.unknown;
  for (const c of WORST_FIRST) if (codes.includes(c)) return c;
  return EXIT_OF.unknown;
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

// The CLI runner for one look. Every call in the look shares what is left
// until `end` (deadline + one interval), each capped at --call-timeout, so a
// slow CLI can't stretch a look past `end` however many calls it makes. With
// no time left the call isn't started and fails as a timeout. end null (--once,
// --names): each call just gets --call-timeout.
function runnerUntil(ctx, end) {
  return (forge, args, cwd) => {
    let ms = ctx.opts.callTimeout * 1000;
    if (end != null) {
      const left = end - ctx.now();
      if (left <= 0) throw Object.assign(new Error('no time left before the deadline'), { code: 'ETIMEDOUT' });
      ms = Math.min(ms, left);
    }
    // At least 1 ms: execFileSync treats a timeout of 0 as "no limit".
    return ctx.run(forge, args, cwd, Math.max(1, Math.ceil(ms)));
  };
}

// Why a required set couldn't be read, for the note.
function unreadableNote(base, r) {
  let why = '';
  if (r.status === 401 || r.status === 403) {
    why = r.source === 'branch protection'
      ? '; permission: reading classic branch protection needs admin rights on the repo'
      : `; permission: this token can't read the ${r.source}`;
  } else if (r.status === 404) why = `; the ${r.source} answered 404, so it may be hidden from this token`;
  return `could not read the required checks of '${base}' (${r.error})${why}; not falling back to all checks`;
}

// The required checks of a base, looked up once per base per invocation. A
// definitive failure (401/403/404) is kept like a result; a transient one
// (timeout, 5xx, garbled output) is not, so the next look asks again.
function requiredFor(ctx, base, run) {
  if (ctx.forge === 'gitlab') return { names: null, note: '' };
  if (ctx.required.has(base)) return ctx.required.get(base);
  const r = forgeLib.requiredChecks(ctx.forge, base, ctx.cwd, ctx.opts.callTimeout * 1000, run);
  let v;
  if (!r.ok) v = { names: null, unreadable: true, retry: !r.definitive, note: unreadableNote(base, r) };
  else if (!r.names.length) v = { names: null, note: `no required checks on '${base}'; decided on all checks` };
  else v = { names: r.names, note: '' };
  if (!v.retry) ctx.required.set(base, v);
  return v;
}

// One look at one request: a status call (plus the required-checks lookup
// until a base's set has been read) and a decision. All of its calls end by
// `end` (null = no deadline). Returns { rec, retry } or { error, notFound };
// retry = the record is 'unknown' only because the required lookup failed
// transiently, so a later look may do better.
function look(ctx, n, startedAt, end) {
  const run = runnerUntil(ctx, end);
  const status = forgeLib.requestStatus(ctx.forge, n, ctx.cwd, ctx.opts.callTimeout * 1000, run);
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
  const required = requiredFor(ctx, status.base, run);
  const d = decide({ forge: ctx.forge, status, required, elapsedS: waited, graceS: ctx.opts.grace, once: ctx.opts.mode !== 'wait' });
  return {
    rec: record(ctx.forge, n, { ...d, head_sha: status.head_sha, sha_matches, waited_s: round1(waited) }),
    retry: required.retry === true,
    status, required,
  };
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
// ceil(timeout / interval) polls (the last one at the deadline), each one
// status call plus, until the base's required set has been read, the
// required-checks lookup (two calls). A lookup that failed transiently is
// retried on the next poll, within the same polls; if it never succeeds the
// result is unknown. All calls of a poll share the time left until
// deadline + interval, and no poll starts once that is used up.
function waitFor(ctx, n) {
  const { timeout, interval } = ctx.opts;
  const t0 = ctx.now();
  const deadline = t0 + timeout * 1000;
  const end = deadline + interval * 1000;
  const polls = Math.max(1, Math.ceil(timeout / interval));
  let last = null;
  let errors = 0;
  let lastError = '';
  for (let k = 1; k <= polls; k++) {
    // A slow look already used up the time; another would only overrun.
    if (k > 1 && ctx.now() >= end) break;
    const startedPoll = ctx.now();
    let r;
    try {
      r = look(ctx, n, t0, end);
    } catch (err) {
      r = { error: `internal error: ${err.message}` };
    }
    if (r.rec) {
      errors = 0;
      lastError = '';
      last = r.rec;
      if (r.rec.ci !== 'pending' && !r.retry) return r.rec;
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

// --queue-check: may an auto-merge be queued on this head? One status call,
// plus the required-checks lookup (GitHub, two calls) or the project settings
// (GitLab, one call); no waiting. Returns { code, rec }: rec is the --once
// record plus queueable and queue_reason.
function queueCheck(ctx, n) {
  const t0 = ctx.now();
  const verdict = (rec, code, reason) => ({
    code,
    rec: {
      ...rec, queueable: code === 0, queue_reason: reason,
      note: [rec.note, code === 0 ? '' : `not queueable: ${reason}`].filter(Boolean).join('; '),
    },
  });
  let r;
  try {
    r = look(ctx, n, t0, null);
  } catch (err) {
    return verdict(unknownRec(ctx, n, t0, `internal error: ${err.message}`), EXIT_OF.unknown, 'internal error');
  }
  if (!r.rec) {
    const why = `${forgeLib.viewCommand(ctx.forge)} failed: ${r.error}`;
    return verdict(unknownRec(ctx, n, t0, why), EXIT_OF.unknown, why);
  }
  const rec = r.rec;
  const ciCode = exitOf(rec);
  if (ciCode === EXIT_MOVED) return verdict(rec, EXIT_MOVED, `head moved: expected ${ctx.opts.sha}, now ${rec.head_sha}`);

  // What stops the queue, worst first: unreadable (2), red (1), not queueable (5).
  let unreadable = null;
  let notQueueable = null;
  if (ciCode === EXIT_OF.unknown) unreadable = (r.required && r.required.unreadable && r.required.note) || 'CI state unknown';
  if (r.status.state && r.status.state !== 'OPEN') notQueueable = `${forgeLib.noun(ctx.forge)} is ${r.status.state}`;
  if (ctx.forge === 'gitlab') {
    const s = forgeLib.repoSettings(ctx.forge, ctx.cwd, ctx.opts.callTimeout * 1000, runnerUntil(ctx, null));
    const setting = 'the project setting "Pipelines must succeed" (only_allow_merge_if_pipeline_succeeds)';
    if (!s.ok) unreadable = unreadable || `could not read ${setting}: ${s.error}`;
    else if (s.only_allow_merge_if_pipeline_succeeds === null) unreadable = unreadable || `could not read ${setting}: not in the project JSON this token sees`;
    else if (!s.only_allow_merge_if_pipeline_succeeds) notQueueable = notQueueable || `${setting} is off, so glab mr merge --auto-merge may merge without a green pipeline`;
    if (rec.ci === 'none') notQueueable = notQueueable || 'no pipeline on the MR head, so the auto-merge has nothing to wait for';
  } else if (!unreadable) {
    const names = r.required.names;
    if (!names || !names.length) {
      notQueueable = notQueueable || `no required checks on '${r.status.base}', so gh pr merge --auto may merge at once without waiting for CI`;
    } else {
      const missing = names.filter((name) => !r.status.checks.some((c) => c.name === name));
      if (missing.length) {
        notQueueable = notQueueable || `required check${missing.length > 1 ? 's' : ''} ${missing.join(', ')} not run by the head, so the auto-merge would never start`;
      }
    }
  }
  if (unreadable) return verdict({ ...rec, ci: 'unknown' }, EXIT_OF.unknown, unreadable);
  if (ciCode === EXIT_OF.red) return verdict(rec, EXIT_OF.red, `CI is red${rec.failing.length ? ` (${rec.failing.join(', ')})` : ''}`);
  if (notQueueable) return verdict(rec, EXIT_NOT_QUEUEABLE, notQueueable);
  const waitsFor = ctx.forge === 'gitlab' ? 'the pipeline' : `the required checks (${r.required.names.join(', ')})`;
  return verdict(rec, 0, `the auto-merge will wait for ${waitsFor}; CI is ${rec.ci}`);
}

// --names: what the head is running, what the base requires, whether the repo
// allows auto-merge. Read-only.
function names(ctx, n) {
  const run = runnerUntil(ctx, null);
  const status = forgeLib.requestStatus(ctx.forge, n, ctx.cwd, ctx.opts.callTimeout * 1000, run);
  if (!status.ok) return { code: 2, line: { pr: n, forge: ctx.forge, ci: 'unknown', note: `${forgeLib.viewCommand(ctx.forge)} failed: ${status.error}` } };
  const notes = [];
  let checks = status.checks.map((c) => c.name);
  let required = null;
  let extra = {};
  if (ctx.forge === 'gitlab') {
    if (status.pipeline && status.pipeline.id != null) {
      const j = forgeLib.pipelineJobNames(status.pipeline.id, ctx.cwd, ctx.opts.callTimeout * 1000, run);
      if (j.ok) checks = j.names; else notes.push(`could not read the pipeline's jobs (${j.error})`);
    } else notes.push('no pipeline on the MR head');
    const s = forgeLib.repoSettings(ctx.forge, ctx.cwd, ctx.opts.callTimeout * 1000, run);
    if (s.ok) extra = { auto_merge_allowed: null, only_allow_merge_if_pipeline_succeeds: s.only_allow_merge_if_pipeline_succeeds };
    else { extra = { auto_merge_allowed: null, only_allow_merge_if_pipeline_succeeds: null }; notes.push(`could not read project settings (${s.error})`); }
  } else {
    const r = forgeLib.requiredChecks(ctx.forge, status.base, ctx.cwd, ctx.opts.callTimeout * 1000, run);
    if (r.ok) required = r.names; else notes.push(`could not read the required checks of '${status.base}' (${r.error})`);
    const s = forgeLib.repoSettings(ctx.forge, ctx.cwd, ctx.opts.callTimeout * 1000, run);
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

  if (opts.mode === 'queue') {
    const r = queueCheck(ctx, opts.prs[0]);
    out(JSON.stringify(r.rec));
    return worst([r.code]);
  }

  const codes = [];
  for (const n of opts.prs) {
    const rec = opts.mode === 'once' ? checkOnce(ctx, n) : waitFor(ctx, n);
    const code = exitOf(rec);
    // --once has no grace period: "none" may just mean the checks of a fresh
    // push haven't registered yet. Only a matching --sha says the caller
    // already waited on this head.
    const allowNone = opts.allowNone && (opts.mode !== 'once' || rec.sha_matches === true);
    if (code === 3 && opts.allowNone && !allowNone) {
      rec.note = [rec.note, '--allow-none needs a matching --sha with --once'].filter(Boolean).join('; ');
    }
    out(JSON.stringify(rec));
    codes.push(code === 3 && allowNone ? 0 : code);
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

module.exports = { main, parseArgs, decide, worst, exitOf, DEFAULTS, MAX_ONCE, EXIT_NOT_QUEUEABLE };
