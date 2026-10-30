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

module.exports = {
  PLUGIN_ROOT, readStdin, projectDir, logDir, appendJsonl, guidanceVersion,
  agentDefaults, parseTaskCard, responseText, lastFencedJson, usageFrom,
};
