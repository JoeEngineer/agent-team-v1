#!/usr/bin/env node
// PreToolUse guard for Bash/PowerShell commands. Blocks actions the Director is
// not authorized to take on its own:
//   - merging a PR whose base is a protected branch (default: main, master),
//     typed as `gh pr merge` or run through scripts/merge-task.js
//   - `gh pr merge --admin` (also `--admin=<any value>`)
//   - force-pushes, pushes to protected branches, deleting protected/milestone branches
//     (also `--mirror`, `--prune`, and `--all` while a protected branch exists locally)
//   - changing branch protection / rulesets; deleting, archiving or editing the repo
//   - the same merges, branch moves and rule changes done through `gh api` (REST or GraphQL)
//   - the GitLab equivalents: `glab mr merge` into a protected branch, and merges,
//     branch deletes, protected-branch / push-rule / approval-rule changes, project
//     edits and releases done through `glab api` or `glab repo` / `glab release`
// Commands inside a subshell, `$(…)`, `sh -c`, `powershell -Command`, `cmd /c` and
// `eval` are checked too. `$(…)` inside a double-quoted string is not.
//   - creating or deleting releases
//   - `git add -A` / `git add .` while unignored agent worktrees exist
//   - a redirection that bash, PowerShell and cmd read differently (`7>out`,
//     `""5>out`, `5&>out`, `>out\ 5`), in any command that runs git, gh or glab
// This is a guardrail against mistakes, not a sandbox: a determined command can evade
// simple parsing. Server-side branch protection is the real enforcement.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib');
const forge = require('./forge');

const PROTECTED = (process.env.AGENT_TEAM_PROTECTED_BRANCHES || 'main,master')
  .split(',').map((s) => s.trim()).filter(Boolean);
const isProtected = (b) => PROTECTED.includes(b);

// Block by printing a PreToolUse "deny" decision as JSON and exiting 0.
// Claude Code and Codex both honour this. Don't use exit code 2: Codex 0.166
// ignores it and runs the command anyway (see docs/codex-mapping.md).
// `fix` replaces the "needs the user" line when the agent can fix the command itself.
function block(reason, fix) {
  const message =
    `agent-team guard blocked this command: ${reason}\n` +
    (fix || 'This needs the user. Ask them to run it or to change the rule in the project\'s instructions file (CLAUDE.md / AGENTS.md) or guard settings.');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    },
  }));
  // Also on stderr, for anyone reading hook logs.
  process.stderr.write(message + '\n');
  process.exit(0);
}

// For `git [-C dir] [-c k=v] <sub> args...` return { sub, args, dir }.
function gitParts(tokens) {
  const gi = tokens.findIndex((t) => t === 'git' || t === 'git.exe' || /[\\/]git(\.exe)?$/.test(t));
  if (gi < 0) return null;
  let i = gi + 1, dir = null;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '-C') dir = tokens[i + 1];
    if (tokens[i] === '-C' || tokens[i] === '-c') i++;
    i++;
  }
  return { sub: tokens[i], args: tokens.slice(i + 1), dir };
}

function currentBranch(cwd) {
  try {
    // symbolic-ref also works on a branch with no commits yet; fails on detached HEAD.
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function hasLocalBranch(name, cwd) {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// git accepts any unambiguous prefix of a long option (`git push --mirr` is
// --mirror, `--del` is --delete) and `--opt=value`. True when a long flag may be
// `option`: it is `--` plus at least one letter and, without its `=value`, a
// prefix of `option`. A prefix shared with another option is ambiguous to git,
// which then refuses to run, so treating it as `option` only refuses a command
// git would refuse anyway.
function longFlagIs(flag, option) {
  if (!/^--[^-=]/.test(flag)) return false;
  const name = flag.split('=')[0];
  return option.startsWith(name);
}
const anyLongFlag = (flags, ...options) => flags.some((f) => options.some((o) => longFlagIs(f, o)));
// A short-option cluster containing `letter` (`-vd` is -v -d).
const shortHas = (flags, letter) => flags.some((f) => /^-[a-zA-Z]+$/.test(f) && f.slice(1).includes(letter));

function checkGitPush(args, cwd) {
  const flags = args.filter((a) => a.startsWith('-'));
  const positional = args.filter((a) => !a.startsWith('-'));
  if (anyLongFlag(flags, '--force', '--force-with-lease', '--force-if-includes') || flags.some((f) => /^-[a-zA-Z]*f/.test(f))) {
    block('force-push');
  }
  if (anyLongFlag(flags, '--mirror')) block('`git push --mirror` overwrites and deletes branches on the remote');
  if (anyLongFlag(flags, '--prune')) block('`git push --prune` deletes branches on the remote');
  if (anyLongFlag(flags, '--all', '--branches')) {
    const local = PROTECTED.find((b) => hasLocalBranch(b, cwd));
    if (local) block(`\`git push --all\` would push protected branch "${local}"`);
  }
  const deleting = anyLongFlag(flags, '--delete') || shortHas(flags, 'd');
  const refspecs = positional.slice(1); // first positional is the remote
  for (const spec of refspecs) {
    if (spec.startsWith('+')) block(`force refspec "${spec}"`);
    const target = spec.includes(':') ? spec.split(':').pop() : spec;
    let name = target.replace(/^refs\/heads\//, '');
    if (name === 'HEAD' || name === '@') name = currentBranch(cwd) || name;
    if (spec.startsWith(':') || deleting) {
      if (isProtected(name) || name.startsWith('milestone/')) block(`deleting branch "${name}"`);
    }
    if (isProtected(name)) block(`push to protected branch "${name}"`);
  }
  if (refspecs.length === 0 && !flags.includes('--tags')) {
    const branch = currentBranch(cwd);
    if (branch && isProtected(branch)) block(`push while on protected branch "${branch}"`);
  }
}

// `git add -A` / `git add .` would commit agent worktrees under .claude/worktrees/
// or .agent-team/worktrees/ as gitlinks. Block it only while that folder exists and isn't ignored.
function checkGitAdd(args, cwd) {
  // -A in a cluster; --all, its alias --no-ignore-removal, or an abbreviation
  // of either; or a pathspec for the whole tree: `.`, `./`, `.\`, `:/`, `:/.`,
  // `:(top)`, or `*` (PowerShell passes it to git unexpanded, and git's
  // pathspec `*` matches every path).
  const all = args.some((a) => /^-[a-zA-Z]*A/.test(a) || longFlagIs(a, '--all') || (a.length > 4 && longFlagIs(a, '--no-ignore-removal')) ||
    /^(?:\.[\\/]*|:[\\/]\.?|:\(top\)[\\/.]*|\*)$/.test(a));
  if (!all) return;
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let top;
  try { top = git('rev-parse', '--show-toplevel'); } catch { return; }
  for (const rel of ['.claude/worktrees', '.agent-team/worktrees']) {
    if (!fs.existsSync(path.join(top, ...rel.split('/')))) continue;
    try {
      git('-C', top, 'check-ignore', '-q', rel + '/');
      continue; // ignored, so -A can't pick it up
    } catch { /* not ignored */ }
    block(`\`git add -A\` / \`git add .\` while \`${rel}/\` exists and isn't in .gitignore — it would commit agent worktrees. Stage explicit paths, or add \`${rel}/\` to .gitignore`);
  }
}

// gh parses flags with pflag, so a boolean flag also takes a value glued on
// with `=` (`--admin=true`, `--admin=1`). Any `=` form counts as the flag, even
// `=false`: the guard refuses rather than parse the value.
const isAdminFlag = (a) => /^--admin(?:=|$)/.test(a);

function checkGhPrMerge(args, cwd) {
  if (args.some(isAdminFlag)) block('`gh pr merge --admin` bypasses branch protection');
  const { target, repo } = lib.prMergeTarget(args);
  requireUnprotectedBase('github', target, repo, cwd);
}

// `glab mr merge` has no flag that bypasses protection (no --admin), so only
// the target branch is checked.
function checkGlabMrMerge(args, cwd) {
  const { target, repo } = lib.mrMergeTarget(args);
  requireUnprotectedBase('gitlab', target, repo, cwd);
}

// The guard hook times out after 30 s (hooks/hooks.json), and a hook that times
// out does not block: the command runs unguarded. So every forge lookup in one
// guard run shares LOOKUP_BUDGET_MS (20 s), each call limited to
// min(LOOKUP_MS, time left), and a lookup with under MIN_LOOKUP_MS left is not
// started: the command is denied instead. AGENT_TEAM_GUARD_BUDGET_MS can only
// lower the budget (tests); it never raises it.
const LOOKUP_MS = 20000;
const LOOKUP_BUDGET_MS = Math.min(20000, Number(process.env.AGENT_TEAM_GUARD_BUDGET_MS) || 20000);
const MIN_LOOKUP_MS = 500;
const lookupDeadline = Date.now() + LOOKUP_BUDGET_MS;

// Ask the forge for the request's base (target) branch; block when it is
// protected or unknown, or when there is no time left to ask (fail closed).
function requireUnprotectedBase(which, target, repo, cwd) {
  const what = `${forge.noun(which)} ${target || '(current branch)'}`;
  const left = lookupDeadline - Date.now();
  const check = which === 'gitlab'
    ? ['glab mr view', target, repo ? `--repo ${repo}` : '', '--output json'].filter(Boolean).join(' ') + ' (target_branch)'
    : ['gh pr view', target, repo ? `--repo ${repo}` : '', '--json baseRefName'].filter(Boolean).join(' ');
  if (left < MIN_LOOKUP_MS) {
    block(`couldn't confirm the base of ${what} in time (the guard's ${Math.round(LOOKUP_BUDGET_MS / 100) / 10} s for forge lookups ran out before this one)`,
      `Retry the command, or check the base with \`${check}\`.`);
  }
  const info = forge.requestInfo(which, { target, repo }, cwd, Math.min(LOOKUP_MS, left));
  // The lookup itself failed: the CLI is missing or logged out, the request
  // doesn't exist, or the network dropped. Still a block (fail closed); the
  // message says that one retry is not a way around the guard, because a live
  // unattended run stopped a whole milestone on a single failed lookup.
  if (!info) {
    block(`could not confirm the base branch of ${what} — refusing to merge blind`,
      `The lookup failed; that can be a network or login hiccup. Check it with \`${check}\`. If that answers and the base is not a protected branch, run the same command again once: a retry is not a way around the guard. If it still can't be confirmed, this needs the user.`);
  }
  if (!info.base) block(`could not confirm the base branch of ${what}`);
  if (isProtected(info.base)) block(`${what} targets protected branch "${info.base}"; only the user merges into it`);
}

// Flags of `gh api` / `glab api` that take a value.
const API_SHORT_VALUE = new Set(['X', 'f', 'F', 'H', 'p', 'q', 't']);
const API_LONG_VALUE = new Set(['--method', '--field', '--raw-field', '--header', '--input', '--preview', '--jq', '--template', '--hostname', '--cache']);

// Parse a `gh api` / `glab api` call the way the CLI does: the last -X/--method
// wins, short flags may be grouped (`-iX PUT`, `-XPUT`, `-X=PUT`), and -f/-F
// values are collected as fields. method is null when none is given, and ''
// when -X has no value (treated as a write). Query parameters in the endpoint
// (`?branch=main`) are returned as fields too. `endpoint` is the positional
// arguments only (the path, or `graphql`), so a field's text, such as a
// comment body that mentions protected_branches, isn't read as a path.
function apiArgs(args) {
  let method = null;
  let input = false;
  const fields = [];
  const query = [];
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let flag = null;
    let value;
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      flag = eq < 0 ? a : a.slice(0, eq);
      if (!API_LONG_VALUE.has(flag)) continue;
      value = eq < 0 ? args[++i] : a.slice(eq + 1);
    } else if (a.length > 1 && a.startsWith('-')) {
      for (let j = 1; j < a.length; j++) {
        if (!API_SHORT_VALUE.has(a[j])) continue;
        flag = '-' + a[j];
        value = a.slice(j + 1).replace(/^=/, '') || args[++i];
        break;
      }
      if (!flag) continue;
    } else {
      positionals.push(a);
      const q = a.indexOf('?');
      if (q >= 0) {
        try { for (const [k, v] of new URLSearchParams(a.slice(q + 1))) query.push(`${k}=${v}`); } catch { /* not a URL */ }
      }
      continue;
    }
    value = value === undefined ? '' : value;
    if (flag === '-X' || flag === '--method') method = value.toUpperCase();
    else if (flag === '-f' || flag === '-F' || flag === '--field' || flag === '--raw-field') fields.push(value);
    else if (flag === '--input') input = true;
  }
  return { method, hasBody: fields.length > 0 || input, fields: [...fields, ...query], positionals, endpoint: positionals.join(' ') };
}

// The value of a named field (`branch`, `base`) in a parsed api call.
function apiField(api, name) {
  const prefix = name + '=';
  const f = api.fields.find((v) => v.startsWith(prefix));
  return f === undefined ? null : f.slice(prefix.length);
}

// True when an api call only reads: GET, or no method and no body.
const apiReads = (api) => (api.method === null ? !api.hasBody : api.method === 'GET');

// GraphQL mutations that do what the REST checks below block.
const GRAPHQL_MUTATIONS = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|updateRef|deleteRef|(?:create|update|delete)BranchProtectionRule|(?:create|update|delete)RepositoryRuleset)\b/;

// `gh api` calls that write: the same actions as the git/gh checks, done
// through the REST or GraphQL API.
function checkGhApi(args, cwd) {
  const api = apiArgs(args);
  if (apiReads(api)) return;
  const { method } = api;
  const joined = api.endpoint; // path checks read the endpoint, not field text
  if (/protection|rulesets/.test(joined)) block('changing branch protection or rulesets');

  const graphql = api.positionals.includes('graphql') && args.join(' ').match(GRAPHQL_MUTATIONS);
  if (graphql) block(`GraphQL mutation \`${graphql[1]}\` (merge with \`gh pr merge\` so the base branch can be checked)`);

  const merge = joined.match(/(?:^|[\s/])repos\/([^/\s]+)\/([^/\s]+)\/pulls\/(\d+)\/merge(?=[\s?]|$)/);
  if (merge) {
    const placeholder = /[{:]/.test(merge[1] + merge[2]); // {owner}/{repo}: the current repo
    requireUnprotectedBase('github', merge[3], placeholder ? null : `${merge[1]}/${merge[2]}`, cwd);
  }

  const ref = joined.match(/git\/refs\/heads\/(\S+)/);
  if (ref) {
    const name = ref[1];
    if (method === 'DELETE' && (isProtected(name) || name.startsWith('milestone/'))) block(`deleting branch "${name}" through the API`);
    if (isProtected(name)) block(`moving protected branch "${name}" through the API`);
  }

  const rename = joined.match(/branches\/([^/\s]+)\/rename/);
  if (rename && isProtected(rename[1])) block(`renaming protected branch "${rename[1]}"`);

  if (/(?:^|[\s/])repos\/[^/\s]+\/[^/\s]+\/merges(?=[\s?]|$)/.test(joined)) {
    const base = apiField(api, 'base');
    if (base !== null && isProtected(base)) block(`merging into protected branch "${base}" through the API`);
  }
}

// GraphQL mutations that do on GitLab what the REST checks below block.
const GITLAB_MUTATIONS = /\b(mergeRequestAccept|mergeRequestSetAutoMerge|commitCreate|branchDelete|branchRule(?:Create|Update|Delete)|branchProtection\w*|projectSettingsUpdate|projectUpdate|projectDelete|releaseCreate|releaseDelete|releaseUpdate)\b/;

// A `glab api` project path's :id as a --repo value: `:id`/`:fullpath`
// placeholders mean the current repo (null); a URL-encoded path is decoded.
function glabRepoOf(id) {
  if (/^[:{]/.test(id)) return null;
  try { return decodeURIComponent(id); } catch { return id; }
}

// `glab api` calls that write. Same idea as checkGhApi, with GitLab's endpoints.
function checkGlabApi(args, cwd) {
  const api = apiArgs(args);
  if (apiReads(api)) return;
  const { method } = api;
  const joined = api.endpoint; // path checks read the endpoint, not field text
  if (/protected_branches|protected_tags|push_rule|approval_rules|approval_settings|merge_request_approval_setting/.test(joined)) {
    block('changing protected branches, push rules or approval rules');
  }

  const graphql = api.positionals.includes('graphql') && args.join(' ').match(GITLAB_MUTATIONS);
  if (graphql) block(`GraphQL mutation \`${graphql[1]}\` (merge with \`glab mr merge\` so the target branch can be checked)`);

  const P = String.raw`(?:^|[\s/])projects\/([^/\s?]+)`;
  const merge = joined.match(new RegExp(P + String.raw`\/merge_requests\/(\d+)\/(?:merge|merge_when_pipeline_succeeds)(?=[\s?]|$)`));
  if (merge) requireUnprotectedBase('gitlab', merge[2], glabRepoOf(merge[1]), cwd);

  const branch = joined.match(new RegExp(P + String.raw`\/repository\/branches\/([^\s?]+)`));
  if (branch) {
    let name = branch[2];
    try { name = decodeURIComponent(name); } catch { /* keep as is */ }
    if (method === 'DELETE' && (isProtected(name) || name.startsWith('milestone/'))) block(`deleting branch "${name}" through the API`);
  }
  if (method === 'DELETE' && new RegExp(P + String.raw`\/repository\/merged_branches`).test(joined)) block('deleting merged branches through the API');

  // Commits and file edits through the API name their branch in a field or
  // in the endpoint's query string.
  const target = apiField(api, 'branch');
  if (target !== null && isProtected(target)) block(`writing to protected branch "${target}" through the API`);

  if (new RegExp(P + String.raw`\/releases(?=[\s/?]|$)`).test(joined)) block('creating or changing a release through the API');
  if (new RegExp(P + String.raw`\/(?:transfer|archive|unarchive)(?=[\s?]|$)`).test(joined)) block('transferring or archiving the project');
  if (new RegExp(P + String.raw`\/?(?=[\s?]|$)`).test(joined) && (method === 'PUT' || method === 'DELETE')) {
    block(`${method === 'DELETE' ? 'deleting' : 'editing'} the project through the API`);
  }
}

// `node <...>/merge-task.js <n> ...` merges request <n> itself (decision 0019).
// The script refuses a protected base too; the guard checks it the same way it
// checks a typed `gh pr merge` / `glab mr merge`, so every merge path is covered.
const MERGE_TASK = /(?:^|[\\/])merge-task(?:\.js)?$/;
function checkMergeTask(tokens, cwd) {
  const at = tokens.findIndex((t) => MERGE_TASK.test(t));
  if (at < 0) return;
  // Only when the script is what runs: first in the segment, or right after
  // `node`. `git log scripts/merge-task.js -n 5` names the file and merges nothing.
  if (at > 0 && !/(?:^|[\\/])node(?:\.exe)?$/i.test(tokens[at - 1])) return;
  const target = tokens.slice(at + 1).find((t) => /^\d+$/.test(t));
  if (!target) return; // the script itself refuses a call with no request number
  requireUnprotectedBase(forge.detect(cwd), target, null, cwd);
}

function checkSegment(tokens, cwd) {
  checkMergeTask(tokens, cwd);
  const git = gitParts(tokens);
  if (git && git.sub === 'push') checkGitPush(git.args, git.dir || cwd);
  if (git && git.sub === 'add') checkGitAdd(git.args, git.dir || cwd);

  const gl = lib.glabParts(tokens);
  if (gl) {
    const [l0, l1] = gl;
    if (lib.isGlabMr(l0) && lib.isGlabMerge(l1)) checkGlabMrMerge(gl.slice(2), cwd);
    if (l0 === 'api') checkGlabApi(gl.slice(1), cwd);
    if ((l0 === 'repo' || l0 === 'project') && ['delete', 'transfer', 'update', 'edit'].includes(l1)) block(`\`glab ${l0} ${l1}\``);
    if (l0 === 'release' && ['create', 'delete', 'upload', 'update'].includes(l1)) block(`\`glab release ${l1}\` (publishing)`);
  }

  const gh = lib.ghParts(tokens);
  if (!gh) return;
  const [g0, g1] = gh;
  if (g0 === 'pr' && g1 === 'merge') checkGhPrMerge(gh.slice(2), cwd);
  if (g0 === 'api') checkGhApi(gh.slice(1), cwd);
  if (g0 === 'repo' && ['delete', 'archive', 'edit', 'rename'].includes(g1)) block(`\`gh repo ${g1}\``);
  if (g0 === 'release' && ['create', 'delete', 'edit'].includes(g1)) block(`\`gh release ${g1}\` (publishing)`);
}

function main() {
  const input = lib.readStdin();
  if (input.hook_event_name && input.hook_event_name !== 'PreToolUse') return;
  const cmd = input.tool_input && input.tool_input.command;
  if (typeof cmd !== 'string' || !/\b(git|gh|glab)(\.exe)?\b|merge-task/.test(cmd)) return;
  const cwd = input.cwd || lib.projectDir(input);
  const segs = lib.allSegments(cmd);
  // A redirection the shells read differently (see lib.segments) means the
  // guard can't know which request, branch or endpoint the command names, so
  // it refuses before any lookup instead of checking one reading.
  if (segs.unsure.length) {
    const { text, why } = segs.unsure[0];
    block(why === 'glued'
      ? `in \`${text}\` the word glued to the front of the redirection is a stream number to one shell and part of an argument to another, so the guard can't tell what this command merges or pushes`
      : `the backslash in the redirection target \`${text}\` escapes the next character in bash but not in PowerShell, so the guard can't tell what this command merges or pushes`,
    'Rewrite it and run it again: put a space before each redirection (`gh pr merge 5 >out.txt`), glue only a stream number 1-6 to it (`2>&1`, `2>/dev/null`), and quote file names that need a backslash.');
  }
  for (const seg of segs) checkSegment(seg, cwd);
}

main();
process.exit(0);
