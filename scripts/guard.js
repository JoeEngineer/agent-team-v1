#!/usr/bin/env node
// PreToolUse guard for Bash/PowerShell commands. Blocks actions the Director is
// not authorized to take on its own:
//   - merging a PR whose base is a protected branch (default: main, master)
//   - `gh pr merge --admin`
//   - force-pushes, pushes to protected branches, deleting protected/milestone branches
//     (also `--mirror`, `--prune`, and `--all` while a protected branch exists locally)
//   - changing branch protection / rulesets; deleting, archiving or editing the repo
//   - the same merges, branch moves and rule changes done through `gh api` (REST or GraphQL)
// Commands inside a subshell, `$(…)`, `sh -c`, `powershell -Command`, `cmd /c` and
// `eval` are checked too. `$(…)` inside a double-quoted string is not.
//   - creating or deleting releases
//   - `git add -A` / `git add .` while unignored agent worktrees exist
// This is a guardrail against mistakes, not a sandbox: a determined command can evade
// simple parsing. Server-side branch protection is the real enforcement.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib');

const PROTECTED = (process.env.AGENT_TEAM_PROTECTED_BRANCHES || 'main,master')
  .split(',').map((s) => s.trim()).filter(Boolean);
const isProtected = (b) => PROTECTED.includes(b);

// Block by printing a PreToolUse "deny" decision as JSON and exiting 0.
// Claude Code and Codex both honour this. Don't use exit code 2: Codex 0.166
// ignores it and runs the command anyway (see docs/codex-mapping.md).
function block(reason) {
  const message =
    `agent-team guard blocked this command: ${reason}\n` +
    'This needs the user. Ask them to run it or to change the rule in the project\'s instructions file (CLAUDE.md / AGENTS.md) or guard settings.';
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

function checkGitPush(args, cwd) {
  const flags = args.filter((a) => a.startsWith('-'));
  const positional = args.filter((a) => !a.startsWith('-'));
  if (flags.some((f) => /^(-f|--force|--force-with-lease|--force-if-includes)(=|$)/.test(f) || /^-[a-zA-Z]*f/.test(f))) {
    block('force-push');
  }
  if (flags.includes('--mirror')) block('`git push --mirror` overwrites and deletes branches on the remote');
  if (flags.includes('--prune')) block('`git push --prune` deletes branches on the remote');
  if (flags.includes('--all') || flags.includes('--branches')) {
    const local = PROTECTED.find((b) => hasLocalBranch(b, cwd));
    if (local) block(`\`git push --all\` would push protected branch "${local}"`);
  }
  const deleting = flags.some((f) => f === '-d' || f === '--delete');
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
  const all = args.some((a) => a === '-A' || a === '--all' || a === '.' || a === ':/' || /^-[a-zA-Z]*A/.test(a));
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

function checkGhPrMerge(args, cwd) {
  if (args.includes('--admin')) block('`gh pr merge --admin` bypasses branch protection');
  const { target, repo } = lib.prMergeTarget(args);
  requireUnprotectedBase(target, repo, cwd);
}

// Ask GitHub for the PR's base branch; block when it is protected or unknown.
function requireUnprotectedBase(target, repo, cwd) {
  const viewArgs = ['pr', 'view'];
  if (target) viewArgs.push(target);
  if (repo) viewArgs.push('--repo', repo);
  viewArgs.push('--json', 'baseRefName', '-q', '.baseRefName');
  let base;
  try {
    base = execFileSync('gh', viewArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim();
  } catch {
    block(`could not confirm the base branch of PR ${target || '(current branch)'} — refusing to merge blind`);
  }
  if (!base) block('could not confirm the PR\'s base branch');
  if (isProtected(base)) block(`PR ${target || '(current branch)'} targets protected branch "${base}"; only the user merges into it`);
}

// The HTTP method of a `gh api` call: `-X PUT`, `-XPUT`, `--method PUT`,
// `--method=PUT`. Null when none is given.
function apiMethod(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--method') return (args[i + 1] || '').toUpperCase();
    if (a.startsWith('--method=')) return a.slice('--method='.length).toUpperCase();
    if (/^-X./.test(a)) return a.slice(2).replace(/^=/, '').toUpperCase();
  }
  return null;
}

// GraphQL mutations that do what the REST checks below block.
const GRAPHQL_MUTATIONS = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|updateRef|deleteRef|(?:create|update|delete)BranchProtectionRule|(?:create|update|delete)RepositoryRuleset)\b/;

// `gh api` calls that write: the same actions as the git/gh checks, done
// through the REST or GraphQL API.
function checkGhApi(args, cwd) {
  const method = apiMethod(args);
  const hasBody = args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF][^-]/.test(a));
  if (method ? method === 'GET' : !hasBody) return;
  const joined = args.join(' ');
  if (/protection|rulesets/.test(joined)) block('changing branch protection or rulesets');

  const graphql = args.includes('graphql') && joined.match(GRAPHQL_MUTATIONS);
  if (graphql) block(`GraphQL mutation \`${graphql[1]}\` (merge with \`gh pr merge\` so the base branch can be checked)`);

  const merge = joined.match(/(?:^|[\s/])repos\/([^/\s]+)\/([^/\s]+)\/pulls\/(\d+)\/merge(?=[\s?]|$)/);
  if (merge) {
    const placeholder = /[{:]/.test(merge[1] + merge[2]); // {owner}/{repo}: the current repo
    requireUnprotectedBase(merge[3], placeholder ? null : `${merge[1]}/${merge[2]}`, cwd);
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
    const base = args.map((a) => /(?:^|[=fF])base=(.+)$/.exec(a)).find(Boolean);
    if (base && isProtected(base[1])) block(`merging into protected branch "${base[1]}" through the API`);
  }
}

function checkSegment(tokens, cwd) {
  const git = gitParts(tokens);
  if (git && git.sub === 'push') checkGitPush(git.args, git.dir || cwd);
  if (git && git.sub === 'add') checkGitAdd(git.args, git.dir || cwd);

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
  if (typeof cmd !== 'string' || !/\b(git|gh)(\.exe)?\b/.test(cmd)) return;
  const cwd = input.cwd || lib.projectDir(input);
  for (const seg of lib.allSegments(cmd)) checkSegment(seg, cwd);
}

main();
process.exit(0);
