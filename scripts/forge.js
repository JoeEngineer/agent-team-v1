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
  return execFileSync(bin, binArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
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

// Words for messages: "PR" / "MR", "gh pr view" / "glab mr view".
const noun = (forge) => (forge === 'gitlab' ? 'MR' : 'PR');
const viewCommand = (forge) => (forge === 'gitlab' ? 'glab mr view' : 'gh pr view');

module.exports = { FORGES, detect, forgeOfUrl, hostOfUrl, viewArgs, fromGitlab, fromGithub, requestInfo, noun, viewCommand };
