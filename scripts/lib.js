// Shared helpers for agent-team hooks. No dependencies; Node 18+.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
}

function logDir(input) {
  const dir = path.join(projectDir(input), '.agent-team', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendJsonl(input, file, record) {
  fs.appendFileSync(path.join(logDir(input), file), JSON.stringify(record) + '\n', 'utf8');
}

function guidanceVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    return manifest.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Minimal YAML frontmatter reader: flat `key: value` pairs only.
function readFrontmatter(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

// Find an agent definition: plugin agents, then project, then user.
function agentDefaults(input, subagentType) {
  if (!subagentType) return { found: false };
  const name = subagentType.includes(':') ? subagentType.split(':').pop() : subagentType;
  const candidates = [];
  if (subagentType.startsWith('agent-team:') || !subagentType.includes(':')) {
    candidates.push(path.join(PLUGIN_ROOT, 'agents', `${name}.md`));
  }
  candidates.push(path.join(projectDir(input), '.claude', 'agents', `${name}.md`));
  candidates.push(path.join(os.homedir(), '.claude', 'agents', `${name}.md`));
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const fm = readFrontmatter(file);
      return { found: true, file, model: fm.model, effort: fm.effort };
    }
  }
  return { found: false };
}

// Parse the TASK / WHY lines at the top of a delegation prompt.
function parseTaskCard(prompt) {
  const card = {};
  if (typeof prompt !== 'string') return card;
  const taskLine = prompt.match(/^\s*TASK\s+(.+)$/m);
  if (taskLine) {
    for (const pair of taskLine[1].trim().split(/\s+/)) {
      const i = pair.indexOf('=');
      if (i > 0) card[pair.slice(0, i)] = pair.slice(i + 1);
    }
    if (card.attempt && /^\d+$/.test(card.attempt)) card.attempt = Number(card.attempt);
  }
  const why = prompt.match(/^\s*WHY\s+(.+)$/m);
  if (why) card.why = why[1].trim();
  return card;
}

// Pull plain text out of whatever shape a tool response has.
function responseText(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  if (Array.isArray(resp)) return resp.map(responseText).join('\n');
  if (typeof resp === 'object') {
    if (typeof resp.text === 'string') return resp.text;
    for (const key of ['content', 'result', 'output', 'message']) {
      if (resp[key] != null) return responseText(resp[key]);
    }
    return JSON.stringify(resp);
  }
  return String(resp);
}

// Last ```<tag> {...}``` block in the text, parsed; null if absent or invalid.
function lastFencedJson(text, tag) {
  if (!text) return null;
  const re = new RegExp('```' + tag + '\\s*\\r?\\n([\\s\\S]*?)```', 'g');
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (!last) return null;
  try {
    return JSON.parse(last.trim());
  } catch {
    return { _unparsed: last.trim().slice(0, 500) };
  }
}

// Best-effort usage numbers from a subagent tool response.
function usageFrom(resp) {
  if (!resp || typeof resp !== 'object') return {};
  const u = resp.usage || {};
  const out = {};
  const tokens = resp.totalTokens ?? resp.total_tokens ??
    (u.input_tokens != null ? (u.input_tokens || 0) + (u.output_tokens || 0) +
      (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : undefined);
  if (tokens != null) out.tokens = tokens;
  const ms = resp.totalDurationMs ?? resp.duration_ms;
  if (ms != null) out.duration_ms = ms;
  if (resp.totalToolUseCount != null) out.tool_uses = resp.totalToolUseCount;
  return out;
}

// Read a heredoc delimiter word starting at cmd[i], dropping quotes and
// backslashes (`EOF`, `'EOF'`, `"EOF"`, `\EOF`). Returns { word, end }.
function heredocWord(cmd, i) {
  let word = '', q = null;
  for (; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { if (c === q) q = null; else word += c; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '\\') continue;
    if (/[\s;&|<>()]/.test(c)) break;
    word += c;
  }
  return { word, end: i };
}

// True when position i is inside an unclosed `$((` … `))` (or `((` … `))`) on
// its line, where `<<` is a bit shift, not a heredoc. Treating a shift as a
// heredoc would skip every following line, so a guard must not guess that way.
function inArithmetic(cmd, i) {
  const before = cmd.slice(cmd.lastIndexOf('\n', i - 1) + 1, i);
  const opens = (before.match(/\(\(/g) || []).length;
  const closes = (before.match(/\)\)/g) || []).length;
  return opens > closes;
}

// Split a command line into segments on && || ; | and newlines, then tokenize
// each segment with basic single/double quote handling. Newlines inside quotes
// stay in the token, and heredoc bodies (after `<<WORD`, `<<'WORD'`, `<<-WORD`)
// are skipped, so text in a commit message isn't read as a command.
function segments(cmd) {
  const out = [];
  let cur = [], tok = '', quote = null, hasTok = false;
  const heredocs = []; // delimiters waiting for the end of the current line
  const pushTok = () => { if (hasTok) cur.push(tok); tok = ''; hasTok = false; };
  const pushSeg = () => { pushTok(); if (cur.length) out.push(cur); cur = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null; else tok += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; hasTok = true; continue; }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<' && cmd[i - 1] !== '<' && !inArithmetic(cmd, i)) {
      pushTok();
      let j = i + 2;
      const strip = cmd[j] === '-';
      if (strip) j++;
      while (cmd[j] === ' ' || cmd[j] === '\t') j++;
      const { word, end } = heredocWord(cmd, j);
      if (word) heredocs.push({ word, strip });
      i = end - 1;
      continue;
    }
    if (c === '\n' && heredocs.length) {
      pushSeg();
      // Skip each pending heredoc body, line by line, up to its closing line.
      let pos = i + 1;
      for (const { word, strip } of heredocs) {
        while (pos < cmd.length) {
          let nl = cmd.indexOf('\n', pos);
          if (nl < 0) nl = cmd.length;
          let line = cmd.slice(pos, nl).replace(/\r$/, '');
          if (strip) line = line.replace(/^\t+/, '');
          pos = nl + 1;
          if (line === word) break;
        }
      }
      heredocs.length = 0;
      i = pos - 1;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&') { pushSeg(); continue; }
    if (/\s/.test(c)) { pushTok(); continue; }
    tok += c; hasTok = true;
  }
  pushSeg();
  return out;
}

// Arguments after `gh` in a token list, or null if the segment isn't a gh call.
function ghParts(tokens) {
  const gi = tokens.findIndex((t) => t === 'gh' || t === 'gh.exe' || /[\\/]gh(\.exe)?$/.test(t));
  if (gi < 0) return null;
  return tokens.slice(gi + 1);
}

// For the args after `gh pr merge`: the PR (number, URL or branch; null means
// the current branch's PR) and the --repo value, if any.
function prMergeTarget(args) {
  const valueFlags = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '--match-head-commit', '-A', '--author-email']);
  let target = null;
  let repo = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.has(a)) {
      if (a === '-R' || a === '--repo') repo = args[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--repo=')) { repo = a.slice(7); continue; }
    if (a.startsWith('-')) continue;
    if (!target) target = a;
  }
  return { target, repo };
}

// Every `gh pr merge` in a command line, as { target, repo, args }.
function findPrMerges(cmd) {
  const out = [];
  for (const seg of segments(cmd || '')) {
    const gh = ghParts(seg);
    if (gh && gh[0] === 'pr' && gh[1] === 'merge') out.push({ ...prMergeTarget(gh.slice(2)), args: gh.slice(2) });
  }
  return out;
}

// Which tool sent this hook event: 'claude' (default) or 'codex'.
const CODEX_ONLY_TOOLS = new Set(['send_input', 'resume_agent', 'wait_agent', 'close_agent', 'list_agents', 'apply_patch']);
function detectTool(input, env = process.env) {
  const forced = env && env.AGENT_TEAM_TOOL;
  if (forced === 'claude' || forced === 'codex') return forced;
  if (!input || typeof input !== 'object') return 'claude';
  const name = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!name.startsWith('mcp__') && (/^collaboration/.test(name) || /^spawn_agent$/.test(name) || CODEX_ONLY_TOOLS.has(name))) return 'codex';
  if (input.turn_id !== undefined && input.turn_id !== null) return 'codex';
  return 'claude';
}

module.exports = {
  detectTool, PLUGIN_ROOT, readStdin, projectDir, logDir, appendJsonl, guidanceVersion,
  agentDefaults, parseTaskCard, responseText, lastFencedJson, usageFrom,
  segments, ghParts, prMergeTarget, findPrMerges,
};
