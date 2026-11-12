// Pure helpers for tests/live/ci-wait-live.js: argument parsing, run prefix, the
// cleanup selection, the read-only preflight verdict, log statistics, the four
// targets and the secret redaction. No I/O, no network, Node built-ins only.
// Unit tests: tests/ci-wait-live.test.js.
'use strict';

const CHECK_NAME = 'sample-ci';
const TOOLS = ['claude', 'codex'];
// A pending review counts as a timeout only when its summary says it waited this long
// (scripts/ci-wait.js defaults to a 9 minute deadline; the sample CI takes about 2).
const TIMEOUT_MIN = 8;

const USAGE = `usage: node tests/live/ci-wait-live.js --tool claude|codex --repo OWNER/REPO --plugin <plugin checkout> --label <before|after|...>
         [--probe-auto-head] [--keep] [--seed-only] [--smoke] [--timeout-min N] [--model M] [--out-dir DIR]
       node tests/live/ci-wait-live.js --repo OWNER/REPO --preflight-only       (read-only check that the repo is ready; starts nothing)
       node tests/live/ci-wait-live.js --repo OWNER/REPO --seed-only            (push the fixture once so the check name exists)
       node tests/live/ci-wait-live.js --repo OWNER/REPO --cleanup-run <live-...-claude-xxxx> [--dry-run] [--force]

Exit codes: 0 the run finished and the report was written (target misses do NOT change this);
            1 harness error (setup, Director crashed or timed out, wrong plugin loaded, cleanup failed);
            2 bad arguments or the read-only preflight failed (--preflight-only: 0 ready, 2 not ready).`;

// ---- arguments ----
function parseArgs(argv) {
  const o = { probeAutoHead: false, keep: false, seedOnly: false, smoke: false, preflightOnly: false, dryRun: false, force: false, timeoutMin: 75 };
  const valued = { '--tool': 'tool', '--repo': 'repo', '--plugin': 'plugin', '--label': 'label', '--model': 'model',
    '--out-dir': 'outDir', '--cleanup-run': 'cleanupRun', '--timeout-min': 'timeoutMin' };
  const flags = { '--probe-auto-head': 'probeAutoHead', '--keep': 'keep', '--seed-only': 'seedOnly', '--smoke': 'smoke', '--preflight-only': 'preflightOnly', '--dry-run': 'dryRun', '--force': 'force' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) { o[flags[a]] = true; continue; }
    if (valued[a]) {
      const v = argv[++i];
      if (v == null || /^--/.test(v)) return { error: `${a} needs a value` };
      o[valued[a]] = v;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  o.timeoutMin = Number(o.timeoutMin);
  if (!Number.isFinite(o.timeoutMin) || o.timeoutMin <= 0) return { error: '--timeout-min must be a positive number' };
  if (!o.repo || !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) return { error: '--repo OWNER/REPO is required' };
  if (o.tool && !TOOLS.includes(o.tool)) return { error: `--tool must be one of ${TOOLS.join(', ')}` };
  if (o.label && !/^[\w.-]+$/.test(o.label)) return { error: '--label may only use letters, digits, ".", "_" and "-"' };
  if (o.preflightOnly && o.cleanupRun) return { error: '--preflight-only and --cleanup-run cannot be combined' };
  if (o.cleanupRun) {
    if (!RUN_RE.test(o.cleanupRun)) return { error: `--cleanup-run must look like live-YYYYMMDDtHHMMSS-claude|codex-xxxx (four hex digits), got ${o.cleanupRun}` };
    return { opts: o };
  }
  if (o.dryRun) return { error: '--dry-run only goes with --cleanup-run' };
  if (o.force) return { error: '--force only goes with --cleanup-run' };
  if (o.seedOnly && o.smoke) return { error: '--seed-only and --smoke cannot be combined' };
  // Only the read-only preflight: needs no tool, plugin or label, and starts nothing.
  if (o.preflightOnly) return { opts: o };
  if (o.seedOnly) { o.tool = o.tool || 'claude'; return { opts: o }; }
  if (!o.tool) return { error: '--tool claude|codex is required' };
  if (!o.plugin) return { error: '--plugin <path to a plugin checkout> is required' };
  if (!o.label) return { error: '--label is required (for example before or after)' };
  return { opts: o };
}

// ---- run prefix ----
// Every branch, issue and PR the harness makes carries this, so cleanup can find
// exactly its own and nothing else. The UTC time makes runs differ; four random hex digits
// keep two runs of the same tool in the same second from cleaning up each other.
const RUN_RE = /^live-\d{8}t\d{6}-(?:claude|codex)-[0-9a-f]{4}$/;
function runPrefix(tool, date, rand) {
  const d = (date || new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').toLowerCase();   // 20261111t213045
  const r = rand || require('crypto').randomBytes(2).toString('hex');
  return `live-${d}-${tool}-${r}`;
}
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- cleanup selection (dry-run safe) ----
// A branch is the run's own when its last name part starts with the run prefix and the
// prefix is followed by "-", "/" or the end ("task/<run>-1", "milestone/<run>", "<run>-seed"),
// and it is not the default branch or a well-known protected name.
const NEVER = new Set(['main', 'master', 'HEAD', 'develop', 'trunk']);
function ownsBranch(name, run, defaultBranch) {
  if (!RUN_RE.test(run)) return false;
  if (!name || NEVER.has(name) || name === defaultBranch) return false;
  return new RegExp(`^(?:[^/]+/)?${escapeRe(run)}(?:[-/].*)?$`).test(name);
}
// listing: { branches: [name], prs: [{number,title,headRefName}], issues: [{number,title,body}] } (open ones).
// Returns what would be closed or deleted; nothing is touched here.
function selectCleanup(listing, run, defaultBranch) {
  const l = listing || {};
  const has = (s) => typeof s === 'string' && s.toLowerCase().includes(run.toLowerCase());
  if (!RUN_RE.test(run)) return { branches: [], prs: [], issues: [], refused: `bad run prefix ${JSON.stringify(run)}` };
  return {
    branches: (l.branches || []).filter((b) => ownsBranch(b, run, defaultBranch)),
    prs: (l.prs || []).filter((p) => has(p.title) || ownsBranch(p.headRefName, run, defaultBranch)).map((p) => p.number),
    issues: (l.issues || []).filter((i) => has(i.title) || has(i.body)).map((i) => i.number),
  };
}

// ---- preflight verdict (read-only data in, verdict out) ----
function rulesetSteps(repo) {
  return [
    `Repo Settings > Rules > Rulesets > New ruleset > New branch ruleset (https://github.com/${repo}/settings/rules/new?target=branch):`,
    '  Name: protect-milestones   Enforcement status: Active   Bypass list: leave empty',
    '  Target branches: Add target > Include by pattern > milestone/*',
    '  Block force pushes: on     Restrict deletions: off     Require a pull request: off',
    `  Require status checks to pass: on > Add checks > ${CHECK_NAME}`,
    `  (if ${CHECK_NAME} is not offered, run once with --seed-only and try again: GitHub only lists check names it has seen run)`,
  ].join('\n');
}
const AUTO_MERGE_STEPS = (repo) => `Repo Settings > General > Pull Requests > tick "Allow auto-merge" (https://github.com/${repo}/settings#merge-button-settings).`;

// input: { authOk, repo: <GET repos/O/R json or null>, repoError, actions: <GET .../actions/permissions json or null>,
//          rules: <GET .../rules/branches/milestone%2Fx array or null>, rulesError, seedOnly }
// Returns { ok, checks: [{name, ok, detail}], problems: [{id, message, steps}] }.
function evaluatePreflight(input, repoName) {
  const checks = [];
  const problems = [];
  const add = (name, ok, detail, id, steps) => {
    checks.push({ name, ok, detail: detail || '' });
    if (!ok) problems.push({ id, message: `${name}: ${detail}`, steps: steps || '' });
  };
  add('gh logged in', !!input.authOk, input.authOk ? '' : 'gh auth status failed', 'gh-auth', 'Run: gh auth login');
  const repo = input.repo;
  if (!repo) {
    add('repo reachable', false, input.repoError || 'gh api repos/<repo> failed', 'repo', `Check the name ${repoName} and that your gh login can see it (private repos need the repo scope).`);
  } else {
    add('repo reachable', true, `${repoName} (${repo.private ? 'private' : 'public'}, default branch ${repo.default_branch || '?'})`);
    const push = !!(repo.permissions && (repo.permissions.push || repo.permissions.admin));
    add('push access', push, push ? '' : 'your login cannot push to this repo', 'push', 'Use a repo you own, or ask for write access.');
    add('repo not archived', !repo.archived && !repo.disabled, repo.archived ? 'repo is archived' : '', 'archived', 'Unarchive it in Settings.');
    add('default branch set', !!repo.default_branch, repo.default_branch ? '' : 'no default branch (empty repo)', 'empty',
      'Create the first commit on main (for example a README) through the web UI.');
    if (input.seedOnly && repo.allow_auto_merge !== true) checks.push({ name: 'allow_auto_merge', ok: true, detail: 'off; not needed for --seed-only, but a full run needs it' });
    else add('allow_auto_merge', repo.allow_auto_merge === true, repo.allow_auto_merge === true ? '' : '"Allow auto-merge" is off', 'auto-merge', AUTO_MERGE_STEPS(repoName));
    add('squash merge allowed', repo.allow_squash_merge !== false, repo.allow_squash_merge === false ? 'squash merging is off' : '', 'squash',
      'Repo Settings > General > Pull Requests > tick "Allow squash merging".');
  }
  const a = input.actions;
  add('Actions enabled', !!(a && a.enabled), a ? (a.enabled ? '' : 'Actions are disabled for this repo') : (input.actionsError || 'could not read actions/permissions'),
    'actions', `Repo Settings > Actions > General > allow actions (https://github.com/${repoName}/settings/actions).`);
  if (input.seedOnly) {
    checks.push({ name: `ruleset requiring ${CHECK_NAME} on milestone/*`, ok: true, detail: 'skipped with --seed-only (add it after the seed run)' });
  } else {
    const names = requiredChecksIn(input.rules);
    const have = names.includes(CHECK_NAME);
    add(`ruleset requires ${CHECK_NAME} on milestone/*`, have,
      input.rules == null ? (input.rulesError || 'could not read the branch rules') : have ? '' : `required checks for milestone/* are: ${names.length ? names.join(', ') : '(none)'}`,
      'ruleset', rulesetSteps(repoName));
  }
  return { ok: problems.length === 0, checks, problems };
}
// Required status check names in an effective-rules array (GET /repos/O/R/rules/branches/<branch>).
function requiredChecksIn(rules) {
  const out = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (r && r.type === 'required_status_checks' && r.parameters && Array.isArray(r.parameters.required_status_checks)) {
      for (const c of r.parameters.required_status_checks) if (c && c.context) out.push(c.context);
    }
  }
  return out;
}

// ---- reviews.jsonl ----
// Minutes a review's summary says it waited ("waited 9 min", "timed out after 540s"), or null.
function waitedMinutes(summary) {
  let best = null;
  const re = /(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  let m;
  while ((m = re.exec(String(summary || '')))) {
    const n = Number(m[1]);
    const min = /^m/i.test(m[2]) ? n : n / 60;
    if (best == null || min > best) best = min;
  }
  return best;
}
function reviewStats(reviews) {
  const lines = Array.isArray(reviews) ? reviews : [];
  const byCi = {};
  const pending = [];
  for (const r of lines) {
    const ci = r && r.ci != null ? String(r.ci) : '(missing)';
    byCi[ci] = (byCi[ci] || 0) + 1;
    if (ci === 'pending') {
      const w = waitedMinutes(r.summary);
      pending.push({ task: r.task_id || r.task || r.pr || null, summary: String(r.summary || '').slice(0, 300), statesTimeWaited: w != null, waitedMinutes: w,
        timeout: w != null && w >= TIMEOUT_MIN });
    }
  }
  return { total: lines.length, byCi, pending };
}

// ---- merges.jsonl ----
const RESOLVED = new Set(['merged', 'auto-merge-cancelled', 'closed']);
function mergesStats(lines) {
  const ls = Array.isArray(lines) ? lines : [];
  const queued = [];
  ls.forEach((l, i) => { if (l && l.outcome === 'auto-merge-queued') queued.push({ i, pr: String(l.pr) }); });
  const unresolved = queued.filter((q) => !ls.some((l, j) => j > q.i && l && String(l.pr) === q.pr && RESOLVED.has(l.outcome)));
  const outcomes = {};
  for (const l of ls) { const o = l && l.outcome != null ? String(l.outcome) : '(missing)'; outcomes[o] = (outcomes[o] || 0) + 1; }
  return { total: ls.length, outcomes, queued: queued.length, unresolved: unresolved.map((q) => q.pr) };
}

// ---- milestone PR: when did its checks finish, and when did the Director say complete? ----
// rollup: statusCheckRollup nodes from `gh pr view --json statusCheckRollup`.
function checksFinished(rollup) {
  const nodes = Array.isArray(rollup) ? rollup : [];
  const done = (n) => (n.__typename === 'StatusContext' ? ['SUCCESS', 'FAILURE', 'ERROR'].includes(n.state) : String(n.status).toUpperCase() === 'COMPLETED');
  const stamp = (n) => { const t = Date.parse(n.completedAt || ''); return Number.isFinite(t) && t > Date.parse('2000-01-01') ? t : null; };
  const pending = nodes.filter((n) => !done(n)).length;
  const times = nodes.filter(done).map(stamp).filter((t) => t != null);
  const failed = nodes.filter((n) => done(n) && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(n.conclusion || n.state).toUpperCase())).length;
  return { total: nodes.length, pending, failed, finishedAtMs: pending === 0 && times.length ? Math.max(...times) : null };
}
const CLOCK_TOLERANCE_S = 10;
// reported: the last milestone-json ({status, pr, ci}) or null; reportedAtMs: wall clock when it was printed.
function milestoneTiming(reported, reportedAtMs, rollup) {
  const c = checksFinished(rollup);
  const out = { reported: reported || null, reportedAtMs: reportedAtMs || null, checks: c, completeBeforeChecksFinished: false, detail: '' };
  if (!reported) { out.detail = 'no milestone-json line was printed'; return out; }
  if (reported.status !== 'complete') { out.detail = 'reported incomplete'; return out; }
  if (!c.total) { out.completeBeforeChecksFinished = true; out.detail = 'reported complete but the milestone PR has no checks'; return out; }
  if (c.pending) { out.completeBeforeChecksFinished = true; out.detail = `reported complete while ${c.pending} check(s) were still running`; return out; }
  if (c.finishedAtMs == null || reportedAtMs == null) { out.detail = 'checks finished (no usable finish time)'; return out; }
  // The line is stamped by the local clock and the check by GitHub's, so only a clear gap counts.
  const margin = Math.round((reportedAtMs - c.finishedAtMs) / 1000);   // positive: printed after the last check finished
  out.marginSeconds = margin;
  const when = margin >= 0 ? `${margin}s after` : `${-margin}s before`;
  if (margin < -CLOCK_TOLERANCE_S) {
    out.completeBeforeChecksFinished = true;
    out.detail = `reported complete ${when} the last check finished (margin ${margin}s, tolerance ${CLOCK_TOLERANCE_S}s)`;
  } else {
    out.detail = `reported complete ${when} the last check finished (margin ${margin}s${margin < 0 ? `, within the ${CLOCK_TOLERANCE_S}s clock tolerance` : ''})`;
  }
  return out;
}

// ---- the four targets ----
// input: { summary (ci-turns summarize), taskPrs: ['12',..], reviews: reviewStats, milestone: milestoneTiming }
function evaluateTargets(input) {
  const { summary, taskPrs, reviews, milestone, breakdown } = input;
  const t = [];
  const fg = summary.watch.foreground;
  t.push({ id: 'no-foreground-watch', name: 'no foreground --watch', result: fg === 0 ? 'PASS' : 'FAIL',
    detail: `${fg} foreground, ${summary.watch.background} background` });
  const per = (taskPrs || []).map((pr) => ({ pr, turns: (summary.ci.byPr[pr] || { turns: 0 }).turns }));
  const worst = per.reduce((a, p) => Math.max(a, p.turns), 0);
  const un = summary.ci.unattributed.turns;
  // Only turns that name a task PR are charged to it. A CI turn that names no PR (a reconcile
  // checkpoint at the end of a wave or before the milestone PR, which the Director prompt
  // requires) cannot be pinned on a task PR, so it is reported (INFO row, count and tokens) and
  // not counted here. Turns that only name another PR (the milestone PR) are reported by
  // ciBreakdown. A task PR with 2 real CI turns still fails.
  const ok2 = worst <= 1;
  t.push({ id: 'ci-turns-per-task-pr', name: '<= 1 CI-related Director turn per task PR',
    result: !per.length ? 'N/A' : ok2 ? 'PASS' : 'FAIL',
    detail: per.length ? `${per.map((p) => `#${p.pr}: ${p.turns}`).join(', ')}${un ? `; ${un} more CI turn(s) name no PR (reported separately, not charged to a task PR)` : ''}` : 'no task PRs found' });
  const pend = reviews.pending;
  const bad = pend.filter((p) => !p.timeout);
  t.push({ id: 'pending-only-on-timeout', name: 'reviewer pending only on timeout', result: bad.length ? 'FAIL' : 'PASS',
    detail: pend.length ? `${pend.length} pending review(s): ${pend.map((p) => (p.waitedMinutes == null ? 'no wait time stated' : `waited ${p.waitedMinutes.toFixed(1)} min`)).join(', ')}` : `no pending reviews (${reviews.total} reviews)` });
  t.push({ id: 'not-complete-before-checks', name: 'not "complete" before the milestone PR checks finished',
    result: !milestone.reported ? 'N/A' : milestone.completeBeforeChecksFinished ? 'FAIL' : 'PASS', detail: milestone.detail });
  // Reported only, never pass/fail: where the rest of the Director's CI turns went.
  if (breakdown) for (const r of breakdownRows(breakdown)) t.push(r);
  return t;
}

// ---- where the CI turns went ----
// turns: the transcript turns ({ tokens, ci, prs: [..], tools: [{ watch, background }] }).
// A CI turn is counted under every group it belongs to: "task" when it names a task PR,
// "milestone" when it names the milestone PR (even together with a task PR, so batching the two
// cannot hide milestone polling), "other" when it names any PR that is neither a task PR nor the milestone PR (even next to one that is), "unattributed"
// when it names no PR. total is every CI turn once. No pass or fail.
function ciBreakdown(turns, { taskPrs, milestonePrs } = {}) {
  const task = new Set((taskPrs || []).map(String));
  const ms = new Set((milestonePrs || []).filter((x) => x != null).map(String));
  const grp = () => ({ turns: 0, contextTokens: 0, foregroundWatch: 0 });
  const g = { total: grp(), taskPrs: grp(), milestonePr: grp(), otherPr: grp(), unattributed: grp() };
  const add = (e, t) => {
    e.turns++; e.contextTokens += t.tokens || 0;
    e.foregroundWatch += (t.tools || []).filter((x) => x.watch && !x.background).length;
  };
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || !t.ci) continue;
    const prs = (t.prs || []).map(String);
    add(g.total, t);
    if (!prs.length) { add(g.unattributed, t); continue; }
    const isTask = prs.some((p) => task.has(p));
    const isMs = prs.some((p) => ms.has(p));
    if (isTask) add(g.taskPrs, t);
    if (isMs) add(g.milestonePr, t);
    if (prs.some((p) => !task.has(p) && !ms.has(p))) add(g.otherPr, t);
  }
  g.milestonePrNumbers = [...ms];
  return g;
}
function breakdownRows(b) {
  const row = (id, name, e, extra) => ({ id, name, result: 'INFO',
    detail: `${e.turns} turn(s), ${e.contextTokens} context tokens, ${e.foregroundWatch} foreground --watch${extra || ''}` });
  const nums = (b.milestonePrNumbers || []).map((n) => `#${n}`).join(', ');
  return [
    row('milestone-pr-ci-turns', 'milestone PR CI turns', b.milestonePr, nums ? ` (milestone PR ${nums})` : ' (no milestone PR known)'),
    row('other-pr-ci-turns', 'other PR CI turns', b.otherPr),
    row('no-pr-ci-turns', 'CI turns naming no PR (not charged to a task PR)', b.unattributed),
    row('total-ci-turns', 'total CI-related Director turns', b.total, ` (task PRs ${b.taskPrs.turns}, milestone PR ${b.milestonePr.turns}, other ${b.otherPr.turns}, no PR named ${b.unattributed.turns}; a turn naming several groups counts in each)`),
  ];
}
function renderTable(targets) {
  const w = Math.max(...targets.map((x) => x.name.length));
  return targets.map((x) => `${x.result.padEnd(4)}  ${x.name.padEnd(w)}  ${x.detail}`).join('\n');
}

// ---- the Director's prompt ----
// Version-neutral on purpose: it says nothing about how to wait for CI, merge or report on
// it. The plugin's own skill text under test decides that, so before and after runs differ
// only in the plugin. Task ids and titles carry the run prefix so cleanup can find them.
const TASKS = [
  ['1', 'add src/sum.js exporting sum(numbers): the total of an array of numbers, 0 for an empty array', 'test/sum.test.js'],
  ['2', 'add src/clamp.js exporting clamp(n, lo, hi): n limited to the range lo..hi', 'test/clamp.test.js'],
  ['3', 'add src/slugify.js exporting slugify(text): lower case, each run of non-alphanumeric characters becomes one "-", no leading or trailing "-"', 'test/slugify.test.js'],
];
function directorPrompt(tool, run) {
  const skill = tool === 'codex' ? '$agent-team:milestone' : 'agent-team:milestone';
  return [
    'You are the Director in an automated, unattended live test of the agent-team plugin. Nobody will answer questions. The user has approved everything inside this milestone, including the plan below, so do not stop to ask for confirmation.',
    '',
    `Start by invoking the milestone skill (${skill}) with the slug "${run}" and this goal: "Add three small, independent functions with tests to the sample Node project".`,
    '',
    'The plan is fixed. Skip the architect and do not re-plan. Route every task to an implementer at the small tier. The tasks:',
    ...TASKS.map(([n, what, tests]) => `- ${run}-${n}: ${what}, with tests in ${tests}.`),
    '',
    `The project is already set up for the agent team (STATUS.md, docs/decisions, logs). The branch milestone/${run} exists on origin and is checked out: it is the milestone branch, so create no other milestone branch. Use the task ids above, name each task branch task/<task id>, and start every task issue title and every PR title with its task id (use "${run}" itself for the milestone issue and the milestone PR), so everything this run creates carries the prefix "${run}".`,
    '',
    `Follow the plugin's own process for each task. When all three tasks are done, open the milestone PR from milestone/${run} to main. Do not merge it and do not touch main. Then finish.`,
    '',
    'Your final message must end with one line in this form, filled in:',
    `milestone-json {"status":"complete" or "incomplete","pr":<the milestone PR number>,"ci":"<the state of that PR's checks at the moment you wrote this line>"}`,
  ].join('\n');
}

// A one-step prompt for --smoke: checks the plumbing (plugin loaded, hooks line, transcript
// parsing, CI-turn detection, GitHub collection, cleanup) without running a milestone.
function smokePrompt() {
  return [
    'This is a plumbing check, not a milestone. Do these two steps and nothing else.',
    '1. Run this shell command: gh pr list --state all --limit 1 --json number,statusCheckRollup',
    '2. Reply with exactly one line: milestone-json {"status":"incomplete","pr":0,"ci":"none"}',
  ].join('\n');
}

// ---- secrets ----
// Removes known secret shapes, plus every string in `secrets` (for example the values in a
// copied auth.json). Applied to everything the harness writes or prints.
const SECRET_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];
// A JSON key that holds a token, plain or inside an escaped JSON string: the key stays, the value goes.
const JSON_TOKEN_KEY = /("(?:access_token|refresh_token|id_token|api_key|OPENAI_API_KEY)\\?"\s*:\s*\\?")[^"\\]+(\\?")/g;
function redact(text, secrets) {
  let s = String(text == null ? '' : text);
  for (const x of secrets || []) if (typeof x === 'string' && x.length >= 8) s = s.split(x).join('[redacted]');
  for (const re of SECRET_SHAPES) s = s.replace(re, '[redacted]');
  // A JSON key that holds a token: keep the key, drop the value.
  s = s.replace(JSON_TOKEN_KEY, '$1[redacted]$2');
  return s;
}
// Every string value of at least 20 characters in a JSON document (auth.json), as secrets to redact.
function secretsFromJson(text) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string' && v.length >= 20) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  try { walk(JSON.parse(text)); } catch { /* not JSON: nothing to add */ }
  return out;
}

// ---- the run's temp folder ----
// The harness records its temp folder in a small run file under the out-dir at start, so a run
// that was hard-killed can still be cleaned up by --cleanup-run. A recorded folder is deleted
// only when its recorded base is the base the harness itself would create (expectedTempBase),
// it is <base>/<digits> (the harness's own per-process folder) and holds nothing but h/ (Codex
// home) and p/ (the clone). The caller also checks with lstat that none of tmp, h and p is a
// link (linkInTemp in ci-wait-live.js), because this function never touches the disk.
const nodePath = require('path');
const nodeOs = require('os');
// The same rule the harness uses to create its temp base.
function expectedTempBase(env, platform, tmpdir) {
  const e = env || process.env;
  return e.AGENT_TEAM_LIVE_TMP || ((platform || process.platform) === 'win32' ? 'C:\\cw6' : nodePath.join(tmpdir || nodeOs.tmpdir(), 'cw6'));
}
const sameDir = (a, b) => {
  const x = nodePath.resolve(a); const y = nodePath.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};
function deletableTemp(tmp, base, entries, expectedBase) {
  if (typeof tmp !== 'string' || typeof base !== 'string' || typeof expectedBase !== 'string' || !tmp || !base || !expectedBase) return false;
  if (!sameDir(base, expectedBase)) return false;
  const t = nodePath.resolve(tmp);
  if (!sameDir(nodePath.dirname(t), base)) return false;
  if (!/^\d+$/.test(nodePath.basename(t))) return false;
  return (entries || []).every((e) => e === 'h' || e === 'p');
}
// 'alive', 'dead' or 'unknown' (a missing or invalid pid: the guard must not fail open on it).
function pidState(pid) {
  const n = Number(pid);
  if (pid == null || pid === '' || !Number.isInteger(n) || n <= 0) return 'unknown';
  return pidAlive(n) ? 'alive' : 'dead';
}
// True when a process with this pid exists (signal 0 only checks; EPERM means it exists).
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}
const runFileName = (run) => `ci-wait-${run}.run.json`;

module.exports = {
  CLOCK_TOLERANCE_S, deletableTemp, expectedTempBase, pidAlive, pidState, runFileName, ciBreakdown, breakdownRows,
  CHECK_NAME, TOOLS, TIMEOUT_MIN, USAGE, RUN_RE,
  parseArgs, runPrefix, ownsBranch, selectCleanup,
  evaluatePreflight, requiredChecksIn, rulesetSteps,
  waitedMinutes, reviewStats, mergesStats, checksFinished, milestoneTiming, evaluateTargets, renderTable,
  directorPrompt, smokePrompt, TASKS,
  redact, secretsFromJson,
};
