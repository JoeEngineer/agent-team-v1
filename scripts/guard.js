#!/usr/bin/env node
// PreToolUse guard for Bash/PowerShell commands. Blocks (exit 2) actions the
// Director is not authorized to take on its own:
//   - merging a PR whose base is a protected branch (default: main, master)
//   - `gh pr merge --admin`
//   - force-pushes, pushes to protected branches, deleting protected/milestone branches
//   - changing branch protection / rulesets; deleting, archiving or editing the repo
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

function block(reason) {
  process.stderr.write(
    `agent-team guard blocked this command: ${reason}\n` +
    'This needs the user. Ask them to run it or to change the rule in the project\'s CLAUDE.md / guard settings.\n'
  );
  process.exit(2);
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

function checkGitPush(args, cwd) {
  const flags = args.filter((a) => a.startsWith('-'));
  const positional = args.filter((a) => !a.startsWith('-'));
  if (flags.some((f) => /^(-f|--force|--force-with-lease|--force-if-includes)(=|$)/.test(f) || /^-[a-zA-Z]*f/.test(f))) {
    block('force-push');
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
// as gitlinks. Block it only while that folder exists and isn't ignored.
function checkGitAdd(args, cwd) {
  const all = args.some((a) => a === '-A' || a === '--all' || a === '.' || a === ':/' || /^-[a-zA-Z]*A/.test(a));
  if (!all) return;
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let top;
  try { top = git('rev-parse', '--show-toplevel'); } catch { return; }
  const wt = path.join(top, '.claude', 'worktrees');
  if (!fs.existsSync(wt)) return;
  try {
    git('-C', top, 'check-ignore', '-q', '.claude/worktrees/');
    return; // ignored, so -A can't pick it up
  } catch { /* not ignored */ }
  block('`git add -A` / `git add .` while `.claude/worktrees/` exists and isn\'t in .gitignore — it would commit agent worktrees. Stage explicit paths, or add `.claude/worktrees/` to .gitignore');
}

function checkGhPrMerge(args, cwd) {
  if (args.includes('--admin')) block('`gh pr merge --admin` bypasses branch protection');
  const { target, repo } = lib.prMergeTarget(args);
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

function checkGhApi(args) {
  const joined = args.join(' ');
  if (!/protection|rulesets/.test(joined)) return;
  const mIdx = args.findIndex((a) => a === '-X' || a === '--method');
  const method = mIdx >= 0 ? (args[mIdx + 1] || '').toUpperCase()
    : (args.find((a) => a.startsWith('--method=')) || '').split('=')[1]?.toUpperCase();
  const hasBody = args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a));
  if ((method && method !== 'GET') || (!method && hasBody)) block('changing branch protection or rulesets');
}

function checkSegment(tokens, cwd) {
  const git = gitParts(tokens);
  if (git && git.sub === 'push') checkGitPush(git.args, git.dir || cwd);
  if (git && git.sub === 'add') checkGitAdd(git.args, git.dir || cwd);

  const gh = lib.ghParts(tokens);
  if (!gh) return;
  const [g0, g1] = gh;
  if (g0 === 'pr' && g1 === 'merge') checkGhPrMerge(gh.slice(2), cwd);
  if (g0 === 'api') checkGhApi(gh.slice(1));
  if (g0 === 'repo' && ['delete', 'archive', 'edit', 'rename'].includes(g1)) block(`\`gh repo ${g1}\``);
  if (g0 === 'release' && ['create', 'delete', 'edit'].includes(g1)) block(`\`gh release ${g1}\` (publishing)`);
}

function main() {
  const input = lib.readStdin();
  if (input.hook_event_name && input.hook_event_name !== 'PreToolUse') return;
  const cmd = input.tool_input && input.tool_input.command;
  if (typeof cmd !== 'string' || !/\b(git|gh)(\.exe)?\b/.test(cmd)) return;
  const cwd = input.cwd || lib.projectDir(input);
  for (const seg of lib.segments(cmd)) checkSegment(seg, cwd);
}

main();
process.exit(0);
