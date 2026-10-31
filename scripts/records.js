// Tool-neutral helpers for writing delegation, review and merge records.
// Shared by the Claude logger (log-delegation.js) and the Codex logger.
// No main and no side effects on require.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const lib = require('./lib');

function base(input, tool = 'claude') {
  return {
    ts: new Date().toISOString(),
    tool,
    session_id: input.session_id,
    guidance_version: lib.guidanceVersion(),
  };
}

function startFile(input) {
  const dir = path.join(lib.logDir(input), '.pending');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(input.tool_use_id || 'unknown').replace(/[^\w-]/g, '_')}.json`);
}

function takeDuration(input) {
  try {
    const file = startFile(input);
    const { started } = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    return Date.now() - started;
  } catch {
    return undefined;
  }
}

// Create a marker file once; false if it already exists. Used to log an event
// once when several hooks see it.
function claimOnce(input, key) {
  const dir = path.join(lib.logDir(input), '.pending');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, String(key).replace(/[^\w-]/g, '_')), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

// Best-effort sweep of old .pending entries: dedupe markers (stop-*, review-*)
// and leaked start files (toolu_*.json) older than maxAgeMs. Looks at no more
// than `cap` entries per run, skips anything else (dotfiles, other tasks'
// files) and swallows every error.
const PRUNABLE = /^(stop-|review-|toolu_.*\.json$)/;
function prunePending(input, { maxAgeMs = 24 * 3600 * 1000, cap = 200 } = {}) {
  try {
    const dir = path.join(lib.logDir(input), '.pending');
    const now = Date.now();
    let seen = 0;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || !PRUNABLE.test(name)) continue;
      if (++seen > cap) break;
      try {
        const f = path.join(dir, name);
        if (now - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f);
      } catch { /* best effort */ }
    }
  } catch { /* no .pending yet */ }
}

const shortHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

// A review can be seen twice (PostToolUse for a foreground subagent, then
// SubagentStop). Log it once per agent id and verdict content, so a re-review
// by the same (resumed) reviewer is still logged.
function logReview(input, record, review, tool = 'claude') {
  if (record.agent_id && !claimOnce(input, `review-${record.agent_id}-${shortHash(JSON.stringify(review))}`)) return;
  lib.appendJsonl(input, 'reviews.jsonl', {
    ...base(input, tool),
    agent_id: record.agent_id || null,
    task_id: record.task.reviewed_task || record.task.id,
    pr: record.task.pr,
    attempt: record.task.attempt,
    reviewer_model: record.resolved_model || record.model,
    reviewer_effort: record.effort,
    reviewer_tier: record.tier === undefined ? null : record.tier,
    ...review,
  });
}

// The last delegations.jsonl record for which predicate(record) is true, or
// null (missing file, corrupt line, no match).
function findDelegation(input, predicate) {
  try {
    const lines = fs.readFileSync(path.join(lib.logDir(input), 'delegations.jsonl'), 'utf8').trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = JSON.parse(lines[i]);
      if (predicate(rec)) return rec;
    }
  } catch { /* none yet */ }
  return null;
}

// Ask GitHub what happened to the PR instead of guessing from command output:
// the Director often chains a merge with other commands whose output mentions
// "error" or "failed". Returns null if gh can't answer.
function prState(input, { target, repo }) {
  const args = ['pr', 'view'];
  if (target) args.push(target);
  if (repo) args.push('--repo', repo);
  args.push('--json', 'number,state,autoMergeRequest');
  // Tests point AGENT_TEAM_FAKE_GH at a Node script: on Windows, execFileSync
  // only finds gh.exe on PATH, so a fake `gh` script there would be skipped.
  const fake = process.env.AGENT_TEAM_FAKE_GH;
  const [bin, binArgs] = fake ? [process.execPath, [fake, ...args]] : ['gh', args];
  try {
    const out = execFileSync(bin, binArgs, {
      cwd: input.cwd || lib.projectDir(input),
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 7000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function mergeOutcome(state) {
  if (!state) return 'unknown';
  if (state.state === 'MERGED') return 'merged';
  if (state.state === 'OPEN' && state.autoMergeRequest) return 'auto-merge-queued';
  return 'not-merged';
}

function logMerges(input, tool = 'claude') {
  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!/\bgh\s+pr\s+merge\b/.test(cmd)) return;
  // Only real `gh pr merge` segments count, not the words inside a quoted string.
  for (const m of lib.findPrMerges(cmd)) {
    const state = prState(input, m);
    lib.appendJsonl(input, 'merges.jsonl', {
      ...base(input, tool),
      command: cmd.slice(0, 300),
      pr: state && state.number != null ? String(state.number) : m.target,
      outcome: mergeOutcome(state),
      outcome_source: state ? 'gh pr view' : 'none',
      chained: lib.segments(cmd).length > 1,
    });
  }
}

module.exports = {
  base, startFile, takeDuration, claimOnce, prunePending, shortHash, logReview,
  findDelegation, prState, mergeOutcome, logMerges,
};
