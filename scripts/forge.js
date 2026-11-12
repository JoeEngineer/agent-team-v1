// Forge layer: the one place that knows how GitHub (`gh`) and GitLab (`glab`)
// differ. The guard and the merge logger parse commands for either CLI and ask
// here for a pull/merge request's base branch and state, normalized:
//
//   { number, state: 'OPEN' | 'MERGED' | 'CLOSED', autoMerge: bool, base }
//
// Self-hosted GitLab works the same as gitlab.com: glab picks the host from the
// repo's remote (or GITLAB_HOST), so nothing here hard-codes a hostname.
// Node built-ins only.
'use strict';

const { execFileSync } = require('child_process');

const FORGES = ['github', 'gitlab'];

// Which forge a project uses. In order:
//   1. AGENT_TEAM_FORGE=github|gitlab
//   2. `git config agent-team.forge` (team-init sets this for a self-hosted host
//      whose name doesn't say "gitlab")
//   3. the origin remote's host: github.com / *github* → github, *gitlab* → gitlab
//   4. github (the plugin's original default)
function detect(cwd, env = process.env) {
  const forced = env && String(env.AGENT_TEAM_FORGE || '').toLowerCase();
  if (FORGES.includes(forced)) return forced;
  const git = (...a) => {
    try {
      return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    } catch { return ''; }
  };
  const configured = git('config', '--get', 'agent-team.forge').toLowerCase();
  if (FORGES.includes(configured)) return configured;
  return forgeOfUrl(git('remote', 'get-url', 'origin')) || 'github';
}

// The forge a remote URL points at, or null when the host doesn't say.
function forgeOfUrl(url) {
  const host = hostOfUrl(url);
  if (!host) return null;
  if (/(^|\.)github\b/.test(host) || host === 'github.com') return 'github';
  if (/gitlab/.test(host)) return 'gitlab';
  return null;
}

// Host of an https://, ssh:// or scp-style (git@host:path) remote URL.
function hostOfUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  const m = s.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i) || s.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)/);
  return m ? m[1].toLowerCase() : null;
}

// Run the forge CLI. Tests point AGENT_TEAM_FAKE_GH / AGENT_TEAM_FAKE_GLAB at a
// Node script: on Windows, execFileSync only finds .exe files on PATH.
function cli(forge, args, cwd, timeout) {
  const fake = forge === 'gitlab' ? process.env.AGENT_TEAM_FAKE_GLAB : process.env.AGENT_TEAM_FAKE_GH;
  const real = forge === 'gitlab' ? 'glab' : 'gh';
  const [bin, binArgs] = fake ? [process.execPath, [fake, ...args]] : [real, args];
  // SIGKILL on timeout so a hung CLI never outlives the call; a status rollup
  // for a big repo can be well over the 1 MB default buffer.
  return execFileSync(bin, binArgs, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
}

// The arguments that look up one request. `target` is a number, URL or branch;
// null means the current branch's request. `repo` is OWNER/REPO (gh) or
// GROUP/PROJECT or a full URL (glab).
function viewArgs(forge, { target, repo }) {
  if (forge === 'gitlab') {
    const a = ['mr', 'view'];
    if (target) a.push(target);
    if (repo) a.push('--repo', repo);
    a.push('--output', 'json');
    return a;
  }
  const a = ['pr', 'view'];
  if (target) a.push(target);
  if (repo) a.push('--repo', repo);
  a.push('--json', 'number,state,autoMergeRequest,baseRefName');
  return a;
}

// GitLab MR JSON → the normalized shape. glab prints the REST API's
// merge request object: state is opened|merged|closed|locked.
function fromGitlab(mr) {
  if (!mr || typeof mr !== 'object') return null;
  const state = { opened: 'OPEN', locked: 'OPEN', merged: 'MERGED', closed: 'CLOSED' }[String(mr.state || '').toLowerCase()] || null;
  return {
    number: mr.iid != null ? mr.iid : null,
    state,
    autoMerge: Boolean(mr.merge_when_pipeline_succeeds || mr.auto_merge_enabled),
    base: typeof mr.target_branch === 'string' ? mr.target_branch : null,
  };
}

function fromGithub(pr) {
  if (!pr || typeof pr !== 'object') return null;
  return {
    number: pr.number != null ? pr.number : null,
    state: typeof pr.state === 'string' ? pr.state.toUpperCase() : null,
    autoMerge: Boolean(pr.autoMergeRequest),
    base: typeof pr.baseRefName === 'string' ? pr.baseRefName : null,
  };
}

// Ask the forge about a request. Returns the normalized shape, or null when the
// CLI is missing, not logged in, the request doesn't exist, or the output isn't
// JSON. Callers decide what null means (the guard blocks; the logger logs
// "unknown").
function requestInfo(forge, ref, cwd, timeout = 20000) {
  try {
    const out = cli(forge, viewArgs(forge, ref), cwd, timeout);
    const parsed = JSON.parse(out);
    return forge === 'gitlab' ? fromGitlab(parsed) : fromGithub(parsed);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CI status (used by scripts/ci-wait.js). Each function takes an optional
// `run` (default: cli) so tests can stand in for gh/glab, and returns
// { ok: true, ... } or { ok: false, error, notFound } - it never throws, and a
// CLI error is never turned into "no checks".
// ---------------------------------------------------------------------------

// A short, single-line reason from a failed CLI call.
function errorText(err) {
  if (err && (err.code === 'ETIMEDOUT' || (err.killed && err.signal))) return 'timed out';
  const raw = (err && ((err.stderr && String(err.stderr).trim()) || (err.stdout && String(err.stdout).trim()) || err.message)) || 'failed';
  const line = String(raw).split(/\r?\n/).find((l) => l.trim()) || 'failed';
  return line.trim().slice(0, 300);
}

// The HTTP status a failed call reports, read from the CLI's own output
// (stderr, then stdout) and never from err.message, which repeats the command
// line: a base named `hotfix-404` or `gh pr view 404` must not read as a 404.
// gh says "... (HTTP 404)"; glab says "404 Not Found" / "404 {message: 404 Not found}".
// null when the output names no status (a timeout, a crash, a login prompt).
function httpStatus(err) {
  if (!err || err instanceof SyntaxError) return null;
  for (const out of [err.stderr, err.stdout]) {
    if (!out) continue;
    const text = String(out);
    const m = /\bHTTP ([1-5]\d\d)\b/.exec(text) || /\b([1-5]\d\d) (?:Not Found|Forbidden|Unauthorized)\b/i.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

const isNotFound = (err) => httpStatus(err) === 404;

const failure = (err) => ({
  ok: false,
  error: err instanceof SyntaxError ? 'output was not JSON' : errorText(err),
  notFound: isNotFound(err),
});

// One CheckRun or StatusContext from `statusCheckRollup` → 'pass' | 'fail' | 'pending'.
// Skipped and neutral runs count as pass; anything we don't recognise is
// 'pending', never 'pass'.
function githubCheckState(c) {
  if (c.__typename === 'StatusContext' || (c.context && !c.name)) {
    const s = String(c.state || '').toUpperCase();
    if (s === 'SUCCESS') return 'pass';
    if (s === 'FAILURE' || s === 'ERROR') return 'fail';
    return 'pending';
  }
  if (String(c.status || '').toUpperCase() !== 'COMPLETED') return 'pending';
  const s = String(c.conclusion || '').toUpperCase();
  if (s === 'SUCCESS' || s === 'SKIPPED' || s === 'NEUTRAL') return 'pass';
  if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) return 'fail';
  return 'pending';
}

// The rollup, one entry per check, the latest run of each name winning (a rerun
// replaces the failed run it retried). Two workflows may use the same job name,
// so the key includes the workflow; both stay visible.
//
// "Latest" is by startedAt. A queued or just-started rerun often has no
// startedAt yet (null, missing, or GitHub's zero time 0001-01-01T00:00:00Z), so
// a missing or zero startedAt counts as newest; otherwise the older SUCCESS it
// replaces would win and report a stale green. A finished run with no startedAt
// falls back to its completedAt. On a tie, a run that hasn't finished wins.
function normalizeRollup(rollup) {
  const latest = new Map();
  (Array.isArray(rollup) ? rollup : []).forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    const name = c.name || c.context;
    if (!name) return;
    const key = `${c.workflowName || ''}\u0000${name}`;
    const state = githubCheckState(c);
    let t = timeOf(c.startedAt);
    if (t === null) t = state === 'pending' ? Infinity : (timeOf(c.completedAt) ?? Infinity);
    const prev = latest.get(key);
    const wins = !prev || t > prev.t || (t === prev.t && (state === 'pending' || prev.entry.state !== 'pending'));
    if (wins) latest.set(key, { t, i, entry: { name, workflow: c.workflowName || null, state } });
  });
  return [...latest.values()].sort((a, b) => a.i - b.i).map((v) => v.entry);
}

// A timestamp in ms, or null when missing, unparseable or GitHub's zero time
// (0001-01-01T00:00:00Z parses to a large negative number).
function timeOf(s) {
  const t = Date.parse(s || '');
  return Number.isFinite(t) && t > 0 ? t : null;
}

const GITLAB_PENDING = ['running', 'pending', 'created', 'waiting_for_resource', 'preparing', 'scheduled', 'manual', 'canceling'];
// head_pipeline.status → 'green' | 'red' | 'pending' | 'none' | 'unknown', plus
// a note for the cases a reader would otherwise have to guess at.
function gitlabPipelineCi(status) {
  const s = String(status || '').toLowerCase().replace(/-/g, '_');
  if (!s || s === 'skipped') return { ci: 'none', note: s ? 'pipeline was skipped' : 'no pipeline on the MR head' };
  if (s === 'success' || s === 'success_with_warnings') return { ci: 'green', note: '' };
  if (s === 'failed' || s === 'canceled') return { ci: 'red', note: '' };
  if (s === 'manual') return { ci: 'pending', note: 'pipeline is waiting for a manual action' };
  if (GITLAB_PENDING.includes(s)) return { ci: 'pending', note: '' };
  return { ci: 'unknown', note: `unrecognised pipeline status '${s}'` };
}

// The state of one request's CI, normalized:
//   { ok, number, state, head_sha, base,
//     checks: [{ name, workflow, state: 'pass'|'fail'|'pending' }]   (GitHub)
//     pipeline: { id, status } | null                                (GitLab) }
// One CLI call. With `{ resolution: true }` it also asks for whether auto-merge
// is queued and when the request was merged, and adds `auto_merge` (bool) and
// `merged_at` (ISO time | null) to the result (used by reconcile-logs.js).
function requestStatus(forge, number, cwd, timeout = 20000, run = cli, { resolution = false } = {}) {
  const gitlab = forge === 'gitlab';
  const args = gitlab
    ? ['mr', 'view', String(number), '--output', 'json']
    : ['pr', 'view', String(number), '--json', 'headRefOid,baseRefName,state,statusCheckRollup' + (resolution ? ',autoMergeRequest,mergedAt' : '')];
  const more = (info, parsed) => (resolution ? { auto_merge: Boolean(info.autoMerge), merged_at: (gitlab ? parsed.merged_at : parsed.mergedAt) || null } : {});
  let parsed;
  try {
    parsed = JSON.parse(run(forge, args, cwd, timeout));
  } catch (err) {
    return failure(err);
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'output was not a JSON object', notFound: false };
  if (gitlab) {
    const hp = parsed.head_pipeline && typeof parsed.head_pipeline === 'object' ? parsed.head_pipeline : null;
    const head = parsed.sha || (parsed.diff_refs && parsed.diff_refs.head_sha) || null;
    if (!head) return { ok: false, error: 'MR JSON has no sha', notFound: false };
    const info = fromGitlab(parsed) || {};
    return {
      ok: true, number: info.number != null ? info.number : Number(number), state: info.state, head_sha: String(head), base: info.base,
      checks: [], pipeline: hp ? { id: hp.id != null ? hp.id : null, status: hp.status != null ? String(hp.status) : null } : null,
      ...more(info, parsed),
    };
  }
  if (typeof parsed.headRefOid !== 'string' || !parsed.headRefOid) return { ok: false, error: 'PR JSON has no headRefOid', notFound: false };
  const info = fromGithub(parsed) || {};
  return {
    ok: true, number: Number(number), state: info.state, head_sha: parsed.headRefOid, base: info.base,
    checks: normalizeRollup(parsed.statusCheckRollup), pipeline: null,
    ...more(info, parsed),
  };
}

// The status checks a base branch requires, from rulesets
// (`rules/branches/<base>`) and classic branch protection
// (`branches/<base>/protection/required_status_checks`). GitHub only. Two CLI
// calls at most. Returns
//   { ok: true, names: [...] }   both sources read; empty = nothing is required
//   { ok: false, source, status, error, definitive }   a source couldn't be read
// Classic protection counts as "none" only on GitHub's own 404 answer for it
// ("Branch not protected" / "Branch not found"); any other 404 may be GitHub
// hiding something from this token, so it is unreadable. `definitive` marks an
// answer that asking again won't change (HTTP 401, 403, 404); a timeout, a 5xx
// or garbled output is not definitive. The caller must not fall back to "all
// checks" on ok: false: a required check that hasn't started would be missed.
function requiredChecks(forge, base, cwd, timeout = 20000, run = cli) {
  if (forge === 'gitlab') return { ok: true, names: [] };
  const b = encodeURIComponent(base);
  const names = new Set();
  const unreadable = (source, err) => {
    const status = httpStatus(err);
    return { ok: false, source, status, error: `${source}: ${failure(err).error}`, definitive: [401, 403, 404].includes(status) };
  };
  try {
    const rules = JSON.parse(run(forge, ['api', `repos/{owner}/{repo}/rules/branches/${b}`], cwd, timeout));
    if (!Array.isArray(rules)) return { ok: false, source: 'rulesets', status: null, error: 'rulesets: output was not a list', definitive: false };
    for (const r of rules) {
      if (!r || r.type !== 'required_status_checks') continue;
      const list = r.parameters && r.parameters.required_status_checks;
      for (const c of Array.isArray(list) ? list : []) if (c && c.context) names.add(String(c.context));
    }
  } catch (err) {
    return unreadable('rulesets', err);
  }
  try {
    const prot = JSON.parse(run(forge, ['api', `repos/{owner}/{repo}/branches/${b}/protection/required_status_checks`], cwd, timeout));
    for (const c of Array.isArray(prot && prot.contexts) ? prot.contexts : []) if (c) names.add(String(c));
    for (const c of Array.isArray(prot && prot.checks) ? prot.checks : []) if (c && c.context) names.add(String(c.context));
  } catch (err) {
    const said = [err && err.stderr, err && err.stdout].filter(Boolean).join('\n');
    if (!(isNotFound(err) && /Branch not (?:protected|found)/i.test(said))) return unreadable('branch protection', err);
  }
  return { ok: true, names: [...names] };
}

// Repo settings that matter for queuing a merge. Read-only; one CLI call.
//   GitHub: { ok, auto_merge_allowed: bool | null }
//   GitLab: { ok, auto_merge_allowed: null, only_allow_merge_if_pipeline_succeeds: bool | null }
// (GitLab's "merge when pipeline succeeds" is available on any MR with a
// pipeline, so there is no repo-level switch to report.)
function repoSettings(forge, cwd, timeout = 20000, run = cli) {
  try {
    if (forge === 'gitlab') {
      const p = JSON.parse(run(forge, ['api', 'projects/:id'], cwd, timeout));
      const only = p && typeof p.only_allow_merge_if_pipeline_succeeds === 'boolean' ? p.only_allow_merge_if_pipeline_succeeds : null;
      return { ok: true, auto_merge_allowed: null, only_allow_merge_if_pipeline_succeeds: only };
    }
    const out = String(run(forge, ['api', 'repos/{owner}/{repo}', '--jq', '.allow_auto_merge'], cwd, timeout)).trim();
    return { ok: true, auto_merge_allowed: out === 'true' ? true : out === 'false' ? false : null };
  } catch (err) {
    return failure(err);
  }
}

// Job names of a GitLab pipeline. One CLI call.
function pipelineJobNames(pipelineId, cwd, timeout = 20000, run = cli) {
  try {
    const jobs = JSON.parse(run('gitlab', ['api', `projects/:id/pipelines/${encodeURIComponent(pipelineId)}/jobs?per_page=100`], cwd, timeout));
    if (!Array.isArray(jobs)) return { ok: false, error: 'jobs output was not a list', notFound: false };
    return { ok: true, names: [...new Set(jobs.map((j) => j && j.name).filter(Boolean).map(String))] };
  } catch (err) {
    return failure(err);
  }
}

// Words for messages: "PR" / "MR", "gh pr view" / "glab mr view".
const noun = (forge) => (forge === 'gitlab' ? 'MR' : 'PR');
const viewCommand = (forge) => (forge === 'gitlab' ? 'glab mr view' : 'gh pr view');

module.exports = {
  FORGES, detect, forgeOfUrl, hostOfUrl, viewArgs, fromGitlab, fromGithub, requestInfo, noun, viewCommand,
  cli, requestStatus, requiredChecks, repoSettings, pipelineJobNames, gitlabPipelineCi, normalizeRollup, githubCheckState, errorText, httpStatus,
};
