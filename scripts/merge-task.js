#!/usr/bin/env node
// Merge one reviewed task request (GitHub PR via `gh`, GitLab MR via `glab`)
// into its milestone branch: the CI gate, the merge, the comment and the log
// line, in one call. Design: docs/decisions/0019-merge-task-script.md.
//
//   node scripts/merge-task.js <n> --sha <head_sha> --task <ID> [--attempt <a>=1]
//                              [--allow-none] [--names] [--wait <s>]
//
//   --sha         the head the reviewer approved (`head_sha` of its review-json).
//                 Required: only a reviewed head is merged or queued.
//   --allow-none  the reviewer reported `ci: none` and its own test run passed.
//   --names       also print what `ci-wait.js --names` prints (first task
//                 request whose CI has run); it never changes the result.
//   --wait <s>    when CI is pending and the request can't be queued, wait up to
//                 <s> seconds for CI and then merge. For a background command.
//
// What it does, in order, stopping at the first step that says no:
//   1. the request is open, its base is `milestone/*` and not protected, and its
//      head is --sha;
//   2. the gate, `ci-wait.js --once --sha`: green (or none with --allow-none)
//      merges; pending tries to queue auto-merge behind `ci-wait.js
//      --queue-check` (decision 0018), and with --wait waits when it can't;
//   3. the merge, pinned to --sha (`--match-head-commit` / glab `--sha`), and a
//      look at the forge to see what happened;
//   4. the comment, and a line in .agent-team/logs/merges.jsonl.
//
// Output: one JSON line per step that has something to say, the last one being
// the result: { pr, forge, state, head_sha, base, ci, failing, note, next }.
// `next` says what the Director does now. Exit codes:
//   0 merged or queued   1 red          2 unknown (can't tell; ask the user)
//   3 none (no CI)       4 head moved   7 the merge command failed
//   8 waiting (pending)  9 refused (not open, wrong base, bad arguments)
//
// Node built-ins only; gh/glab run with argument arrays (no shell), so the one
// command line works from bash and from Windows PowerShell 5.1.
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const forgeLib = require('./forge');
const ciWait = require('./ci-wait');

const EXIT = { merged: 0, queued: 0, red: 1, unknown: 2, none: 3, head_moved: 4, failed: 7, waiting: 8, refused: 9 };
const STATE_OF_GATE = { 1: 'red', 2: 'unknown', 3: 'none', 4: 'head_moved', 8: 'waiting' };
const CALL_MS = 60000;
const MAX_WAIT_S = 3600;

const USAGE = [
  'usage: merge-task.js <n> --sha <head_sha> --task <ID> [--attempt <a>=1] [--allow-none] [--names] [--wait <s>]',
  'exit: 0 merged or queued, 1 red, 2 unknown, 3 none, 4 head moved, 7 merge failed, 8 waiting, 9 refused.',
].join('\n');

function parseArgs(argv) {
  const opts = { pr: null, sha: null, task: null, attempt: '1', allowNone: false, names: false, wait: 0 };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sha') opts.sha = value(++i, a);
    else if (a === '--task') opts.task = value(++i, a);
    else if (a === '--attempt') opts.attempt = value(++i, a);
    else if (a === '--wait') opts.wait = Number(value(++i, a));
    else if (a === '--allow-none') opts.allowNone = true;
    else if (a === '--names') opts.names = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (opts.pr === null) opts.pr = a;
    else throw new Error(`one request per call (got ${opts.pr} and ${a})`);
  }
  if (!opts.pr || !/^\d+$/.test(opts.pr)) throw new Error('the request number is required (digits only)');
  if (!opts.sha || !/^[0-9a-f]{7,40}$/i.test(opts.sha)) throw new Error('--sha <head_sha> is required: the head the reviewer approved (7 to 40 hex digits)');
  if (!opts.task || !/^[\w.-]+$/.test(opts.task)) throw new Error('--task <ID> is required (letters, digits, . _ -)');
  if (!/^\d+$/.test(opts.attempt)) throw new Error('--attempt must be a number');
  if (!Number.isFinite(opts.wait) || opts.wait < 0 || opts.wait > MAX_WAIT_S) throw new Error(`--wait must be 0 to ${MAX_WAIT_S} seconds`);
  return opts;
}

const protectedBranches = (env) => String((env && env.AGENT_TEAM_PROTECTED_BRANCHES) || 'main,master')
  .split(',').map((s) => s.trim()).filter(Boolean);

// The merge and comment commands of each forge, as argument arrays.
function mergeArgs(forge, n, sha, auto) {
  return forge === 'gitlab'
    ? ['mr', 'merge', n, ...(auto ? ['--auto-merge'] : []), '--squash', '--remove-source-branch', '--yes', '--sha', sha]
    : ['pr', 'merge', n, ...(auto ? ['--auto'] : []), '--squash', '--delete-branch', '--match-head-commit', sha];
}
const commentArgs = (forge, n, text) => (forge === 'gitlab' ? ['mr', 'note', n, '-m', text] : ['pr', 'comment', n, '-b', text]);
const cancelCommand = (forge, n) => (forge === 'gitlab'
  ? `glab api -X POST projects/:id/merge_requests/${n}/cancel_merge_when_pipeline_succeeds`
  : `gh pr merge ${n} --disable-auto`);

// What the Director does after each state. Kept here, not in the Director's
// instructions: it is read only when it applies.
function nextStep(state, c) {
  const noun = forgeLib.noun(c.forge);
  const rerun = `node "<plugin root>/scripts/merge-task.js" ${c.pr} --sha ${c.sha} --task ${c.task} --attempt ${c.attempt}${c.allowNone ? ' --allow-none' : ''}`;
  switch (state) {
    case 'merged':
      return c.already
        ? `${noun} ${c.pr} was already merged. If STATUS.md has it as queued, run reconcile-logs.js --merges; then set it to merged.`
        : `Set the task to merged in STATUS.md. In a separate call: git pull, then the next task.`;
    case 'queued':
      return `Auto-merge is on; the forge merges when CI passes. Set the state to queued in STATUS.md and move on. ` +
        `Before any push to this ${noun}, cancel first: ${cancelCommand(c.forge, c.pr)}. ` +
        `Check it with reconcile-logs.js --merges before the next merge, at the end of the wave and before the milestone ${noun}.`;
    case 'waiting':
      return c.waited
        ? `CI is still pending after the extra wait. Tell the user, keep the state waiting CI in STATUS.md, and don't start another wait.`
        : `CI is pending and the ${noun} can't be queued (${c.queueReason || 'not queueable'}). Set the state to waiting CI in STATUS.md with that reason. ` +
          `Claude: run \`${rerun} --wait 1800\` as a background command. Codex: send the same reviewer a followup ("wait again and report ci", kind=followup, same attempt), then run this command again on its report.`;
    case 'red':
      return `CI is red${c.failing && c.failing.length ? ` (${c.failing.join(', ')})` : ''}. Don't merge. Send the task back to the implementer with the failing check names. ` +
        `If the reviewer approved and explained why the failure isn't this ${noun}'s fault, ask the user instead.`;
    case 'head_moved':
      return `The ${noun} head is now ${c.head || 'another commit'}, not the reviewed ${c.sha}. Send the reviewer the new commits only (git diff ${c.sha}..${c.head || '<new head>'}) and act on that review. Never merge a head no review approved.`;
    case 'none':
      return c.allowNone
        ? `No CI was found and --allow-none didn't apply (${c.note || 'see note'}). Ask the user.`
        : `The ${noun} has no CI. If the reviewer reported ci: none with tests_passed: true, run this again with --allow-none; if tests_passed isn't true, send the reviewer a followup to run the tests. If the reviewer reported green, the checks it saw are gone: ask the user.`;
    case 'unknown':
      return `The CI state can't be read (${c.note || 'no reason given'}). Don't merge, don't queue and don't wait: ask the user.`;
    case 'failed':
      return `The merge command failed and the ${noun} is not merged (${c.note || 'no reason given'}). If a branch rule refused it, don't look for a way around it: tell the user.`;
    default:
      return `Nothing was merged (${c.note || state}). Ask the user.`;
  }
}

// Session fields for the log line, from the marker the SessionStart hook leaves.
function sessionMarker(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lib.logPath({ cwd }), '.pending', 'hooks-alive.json'), 'utf8'));
  } catch {
    return {};
  }
}

function main(argv, deps = {}) {
  const out = deps.out || ((l) => process.stdout.write(`${l}\n`));
  const errOut = deps.err || ((l) => process.stderr.write(`${l}\n`));
  const env = deps.env || process.env;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    errOut(`merge-task: ${e.message}\n${USAGE}`);
    return EXIT.refused;
  }
  const cwd = deps.cwd || process.cwd();
  const forge = deps.forge || forgeLib.detect(cwd, env);
  const run = deps.run || forgeLib.cli;
  const noun = forgeLib.noun(forge);
  const ctx = { pr: opts.pr, forge, sha: opts.sha, task: opts.task, attempt: opts.attempt, allowNone: opts.allowNone };
  let base = null;

  const finish = (state, fields = {}) => {
    const c = { ...ctx, ...fields };
    out(JSON.stringify({
      pr: Number(opts.pr), forge, state, head_sha: c.head || null, base, ci: c.ci || null,
      failing: c.failing || [], note: c.note || '', next: nextStep(state, c),
    }));
    return EXIT[state];
  };
  // Run ci-wait in this process and return { code, rec } (rec: its last JSON line).
  const gate = (args) => {
    let rec = null;
    const code = ciWait.main(args, {
      cwd, forge, run, env, now: deps.now, sleep: deps.sleep, err: errOut,
      out: (l) => { try { rec = JSON.parse(l); } catch { /* not JSON: ignore */ } },
    });
    return { code, rec: rec || {} };
  };
  const look = () => forgeLib.requestStatus(forge, opts.pr, cwd, CALL_MS, run, { resolution: true });

  // 1. The request: open, into a milestone branch, at the reviewed head.
  const before = look();
  if (!before.ok) return finish('unknown', { note: `${forgeLib.viewCommand(forge)} failed: ${before.error}` });
  base = before.base || null;
  if (before.state === 'MERGED') return finish('merged', { already: true, head: before.head_sha, note: 'already merged; nothing was run' });
  if (before.state !== 'OPEN') return finish('refused', { head: before.head_sha, note: `${noun} ${opts.pr} is ${String(before.state || 'in an unknown state').toLowerCase()}, not open` });
  if (!base) return finish('refused', { note: `could not read the base branch of ${noun} ${opts.pr}` });
  if (protectedBranches(env).includes(base)) return finish('refused', { note: `${noun} ${opts.pr} targets protected branch "${base}"; only the user merges into it` });
  if (!base.startsWith('milestone/')) return finish('refused', { note: `${noun} ${opts.pr} targets "${base}"; this command merges task requests into milestone/* only` });
  const head = String(before.head_sha || '');
  if (!head.toLowerCase().startsWith(opts.sha.toLowerCase())) return finish('head_moved', { head, note: `head moved: expected ${opts.sha}, now ${head}` });
  ctx.head = head;

  if (opts.names) {
    const n = gate(['--names', opts.pr]);
    out(JSON.stringify({ names: n.rec }));
  }

  // 2. The gate. `head` is the full SHA, so the merge below is pinned exactly.
  const noneFlag = opts.allowNone ? ['--allow-none'] : [];
  const fromGate = (g, extra = {}) => finish(STATE_OF_GATE[g.code] || 'unknown', {
    ci: g.rec.ci, failing: g.rec.failing, note: g.rec.note || g.rec.queue_reason || '', head: g.rec.head_sha || head, ...extra,
  });
  let g = gate(['--once', opts.pr, '--sha', head, ...noneFlag]);
  let auto = false;
  let gateName = 'ci-wait';
  if (g.code === 8) {
    const q = gate([opts.pr, '--queue-check', '--sha', head]);
    if (q.code === 0) {
      auto = true;
      gateName = 'ci-wait-queue';
      g = q;
    } else if (q.code === ciWait.EXIT_NOT_QUEUEABLE) {
      const queueReason = q.rec.queue_reason || q.rec.note || 'not queueable';
      if (!opts.wait) return finish('waiting', { ci: 'pending', queueReason, note: queueReason });
      g = gate([opts.pr, '--sha', head, '--timeout', String(opts.wait), ...noneFlag]);
      if (g.code !== 0) return fromGate(g, g.code === 8 ? { waited: true } : {});
    } else {
      return fromGate(q);
    }
  } else if (g.code !== 0) {
    return fromGate(g);
  }

  // 3. The merge, then ask the forge what happened (never guess from output).
  let mergeError = null;
  try {
    run(forge, mergeArgs(forge, opts.pr, head, auto), cwd, CALL_MS);
  } catch (e) {
    mergeError = forgeLib.errorText(e);
  }
  const after = look();
  const state = !after.ok ? null
    : after.state === 'MERGED' ? 'merged'
      : after.state === 'OPEN' && after.auto_merge ? 'queued' : 'failed';
  const outcome = { merged: 'merged', queued: 'auto-merge-queued', failed: 'not-merged' }[state] || 'unknown';

  // 4. The comment (best effort) and the log line.
  let commentNote = '';
  if (state === 'merged' || state === 'queued') {
    const text = state === 'merged'
      ? `Merged by the Director after reviewer approval (task ${opts.task}, attempt ${opts.attempt}).`
      : `Auto-merge queued by the Director after reviewer approval of ${head.slice(0, 12)} (task ${opts.task}, attempt ${opts.attempt}); it merges when CI passes.`;
    try {
      run(forge, commentArgs(forge, opts.pr, text), cwd, CALL_MS);
    } catch (e) {
      commentNote = `the comment was not posted (${forgeLib.errorText(e)})`;
    }
  }
  try {
    const input = { cwd };
    if (lib.inUse(input)) {
      const marker = sessionMarker(cwd);
      const milestone = base.match(/^milestone\/(.+)$/);
      lib.appendJsonl(input, 'merges.jsonl', {
        ts: new Date((deps.now || Date.now)()).toISOString(),
        tool: env.AGENT_TEAM_TOOL || marker.tool || 'unknown',
        session_id: marker.session_id || null,
        guidance_version: lib.guidanceVersion(),
        command: `merge-task.js ${opts.pr} --sha ${opts.sha} --task ${opts.task} --attempt ${opts.attempt}${opts.allowNone ? ' --allow-none' : ''}${opts.wait ? ` --wait ${opts.wait}` : ''}`,
        pr: String(opts.pr),
        task: opts.task,
        attempt: Number(opts.attempt),
        ...(milestone ? { milestone: milestone[1] } : {}),
        outcome,
        outcome_source: after.ok ? forgeLib.viewCommand(forge) : 'none',
        ...(forge === 'gitlab' ? { forge: 'gitlab' } : {}),
        ...(auto ? { auto: true } : {}),
        match_head: head,
        gate: gateName,
        ci: g.rec.ci || null,
        via: 'merge-task',
        chained: true,
      });
    }
  } catch (e) {
    errOut(`merge-task: could not write merges.jsonl (${e.message}); log the merge with log-event.js merge`);
  }

  const notes = [mergeError && state !== 'merged' && state !== 'queued' ? mergeError : '', commentNote,
    state === 'queued' && !auto ? 'the forge queued the merge instead of merging at once' : ''].filter(Boolean).join('; ');
  if (!state) return finish('unknown', { ci: g.rec.ci, note: `the merge command ran, but ${forgeLib.viewCommand(forge)} failed afterwards (${after.error}); check the ${noun} before doing anything else` });
  return finish(state, { ci: g.rec.ci, note: notes, head });
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`merge-task: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = EXIT.unknown;
  }
}

module.exports = { main, parseArgs, mergeArgs, commentArgs, nextStep, EXIT };
