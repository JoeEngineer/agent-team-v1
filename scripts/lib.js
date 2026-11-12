// Shared helpers for agent-team hooks. No dependencies; Node 18+.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Claude sets CLAUDE_PROJECT_DIR. Codex does not, and its hooks run from the
// session cwd (possibly a subfolder), so use the git root of that cwd.
// The git lookup costs a process spawn (~60 ms), so the answer is remembered per
// cwd for the life of this process: a hook run is short, and a folder does not
// become a repo mid-run.
const GIT_ROOTS = new Map();
function projectDir(input) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const cwd = (input && typeof input.cwd === 'string' && input.cwd) || process.cwd();
  if (GIT_ROOTS.has(cwd)) return GIT_ROOTS.get(cwd);
  let found = cwd;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    if (top) found = top;
  } catch { /* not a git folder, or git missing */ }
  GIT_ROOTS.set(cwd, found);
  return found;
}

// The logs folder path, without creating it. Use this for reads and checks, so
// looking for a log never leaves a folder behind.
function logPath(input) {
  return path.join(projectDir(input), '.agent-team', 'logs');
}

function logDir(input) {
  const dir = logPath(input);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Does this project use agent-team? True when it has an .agent-team folder
// (team-init, or an earlier log line), or its own settings turn the plugin on
// (.claude/settings*.json), or its Codex hooks call the shim. The plugin can be
// installed for every project of a user; the logger uses this to stay out of
// the ones that never set it up.
function inUse(input) {
  const root = projectDir(input);
  if (fs.existsSync(path.join(root, '.agent-team'))) return true;
  const mentions = (rel, needle) => {
    try { return fs.readFileSync(path.join(root, ...rel), 'utf8').includes(needle); } catch { return false; }
  };
  return mentions(['.claude', 'settings.json'], 'agent-team@') ||
    mentions(['.claude', 'settings.local.json'], 'agent-team@') ||
    mentions(['.codex', 'hooks.json'], 'agent-team-hook.js');
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
      return { found: true, file, model: fm.model, effort: fm.effort, tier: fm.tier };
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

// End of the word that starts at cmd[i]: the target of a redirection (`out.txt`,
// `/dev/null`, `$null`, `"a b"`, `1`, `-`). Stops before a character that
// starts something else (`;` `&` `|` `<` `>` `(` `)` a backtick or whitespace),
// so a command after the redirection is still read.
// A backslash does not escape the next character here, on purpose: PowerShell
// reads `\` literally, so in `>a\;gh pr merge 5` it runs the merge after the
// `;`. Bash would write to a file named `a;gh` instead, so for bash this reads
// one command too many, which is the safe side for a guard.
function skipRedirectTarget(cmd, i) {
  let q = null;
  for (; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (/[\s;&|<>()`]/.test(c)) break;
  }
  return i;
}

// Split a command line into segments on && || ; | and newlines, then tokenize
// each segment with basic single/double quote handling. Newlines inside quotes
// stay in the token, and heredoc bodies (after `<<WORD`, `<<'WORD'`, `<<-WORD`)
// are skipped, so text in a commit message isn't read as a command.
// Outside quotes: `(` `)` and a backtick also end a segment (subshells, `$(…)`,
// command substitution), a backslash or backtick before a newline joins the two
// lines, `>` ends a token (`main>out.txt`), and the braces of a block
// (`{git push}`) are dropped while `HEAD@{1}` and `${x}` keep theirs.
// Output redirections are not arguments and do not end a segment: `>f`, `>>f`,
// `N>f`, `N>&M`, `>&N`, `>&f`, `>|f`, `&>f`, `&>>f` (and PowerShell's `*>&1`)
// are dropped along with their target, so `gh pr merge --squash 2>&1` has no
// number, and `2>&1` is not a `2` followed by a `&` break and a `1`.
// A word glued to the front of `>` is read the same way by every shell only
// when it is a lone 1-6 (a stream number in bash, PowerShell 5.1 and cmd) or
// fully quoted (`"7">f`: an argument everywhere). A word glued to `&>` is
// always an argument (`5&>f`: bash's `&>` takes no number; PowerShell can't
// parse it; cmd splits at `&`). Any other glued word is read two ways. Bash
// reads 0, 7-9 or a multi-digit number as a file descriptor and any other word
// as an argument. PowerShell keeps the whole `7>out` or `main>out` as one
// argument, or `7>` plus `out` when a space follows, but reads `*>` as a
// stream. Such a segment keeps the reading above (bash's, but `*>` dropped) and
// also gets a non-enumerable `readings` property, { sh, ps }, with each shell's
// token list, so a guard can check both. cmd's own reading (the last digit of
// `a12>f` is a handle) only differs from bash's in segments that already have
// `readings`.
// Not read: `$(…)` inside a double-quoted string.
function segments(cmd) {
  const out = [];
  // cur: the reading returned; sh / ps: bash's and PowerShell's, which differ
  // from cur only after a glued word read two ways (split).
  let cur = [], sh = [], ps = [], split = false;
  let tok = '', quote = null, hasTok = false, bare = false;
  const heredocs = []; // delimiters waiting for the end of the current line
  const pushTok = () => { if (hasTok) { cur.push(tok); sh.push(tok); ps.push(tok); } tok = ''; hasTok = false; bare = false; };
  const pushSeg = () => {
    pushTok();
    if (cur.length) {
      if (split) Object.defineProperty(cur, 'readings', { value: { sh, ps }, enumerable: false });
      out.push(cur);
    }
    cur = []; sh = []; ps = []; split = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null; else tok += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; hasTok = true; continue; }
    if (c === '\\' || c === '`') {
      // Line continuation (sh: backslash, PowerShell: backtick).
      const nl = cmd[i + 1] === '\n' ? 1 : (cmd[i + 1] === '\r' && cmd[i + 2] === '\n' ? 2 : 0);
      if (nl) { i += nl; continue; }
      if (c === '`') { pushSeg(); continue; }
    }
    if (c === '(' || c === ')') { pushSeg(); continue; }
    if (c === '>' || (c === '&' && cmd[i + 1] === '>')) {
      // A redirection: the operator, then its target, dropped. What a word glued
      // to the front means depends on the shell (see above).
      let j = i + (c === '&' ? 2 : 1);
      if (cmd[j] === '>') j++;
      if (cmd[j] === '&' || cmd[j] === '|') j++;
      const op = cmd.slice(i, j);
      let k = j;
      while (cmd[k] === ' ' || cmd[k] === '\t') k++;
      const end = skipRedirectTarget(cmd, k);
      if (!hasTok || c === '&' || !bare) {
        pushTok(); // nothing glued, `&>` (no number), or a quoted word (an argument)
      } else if (/^[1-6]$/.test(tok)) {
        tok = ''; hasTok = false; bare = false; // a stream number in every shell
      } else {
        const fd = /^\d+$/.test(tok);
        const star = tok === '*';
        if (!fd && !star) cur.push(tok);
        if (!fd) sh.push(tok);
        if (!star) {
          if (k === j) ps.push(tok + cmd.slice(i, end));
          else ps.push(tok + op, cmd.slice(k, end).replace(/["']/g, ''));
        }
        split = true;
        tok = ''; hasTok = false; bare = false;
      }
      i = end - 1;
      continue;
    }
    if (c === '{' && !hasTok) continue;
    if (c === '}' && !tok.includes('{')) continue;
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
    tok += c; hasTok = true; bare = true;
  }
  pushSeg();
  return out;
}

// Command strings a segment hands to another shell: the script after `sh -c`
// (bash, zsh, …), everything after `powershell -Command` / `cmd /c`, and the
// arguments of `eval` / `Invoke-Expression`.
const SH_BIN = /^(?:.*[\\/])?(?:sh|bash|zsh|dash|ksh)(?:\.exe)?$/i;
const PS_BIN = /^(?:.*[\\/])?(?:pwsh|powershell|cmd)(?:\.exe)?$/i;
const EVAL = /^(?:eval|iex|invoke-expression)$/i;
function nestedCommands(tokens) {
  const out = [];
  tokens.forEach((t, i) => {
    if (SH_BIN.test(t)) {
      const j = tokens.findIndex((x, k) => k > i && /^-[A-Za-z]*c$/.test(x));
      if (j > 0 && tokens[j + 1]) out.push(tokens[j + 1]);
    } else if (PS_BIN.test(t)) {
      const j = tokens.findIndex((x, k) => k > i && /^(?:-c|-com[a-z]*|\/c|\/k)$/i.test(x));
      if (j > 0 && j + 1 < tokens.length) out.push(tokens.slice(j + 1).join(' '));
    } else if (EVAL.test(t) && i + 1 < tokens.length) {
      out.push(tokens.slice(i + 1).join(' '));
    }
  });
  return out;
}

// segments(cmd), plus the segments of any command string passed to another
// shell (see nestedCommands), a few levels deep.
function allSegments(cmd, depth = 0) {
  const out = [];
  for (const seg of segments(cmd || '')) {
    out.push(seg);
    if (depth < 3) for (const inner of nestedCommands(seg)) out.push(...allSegments(inner, depth + 1));
  }
  return out;
}

// A parent command's flags may come before the subcommand: `gh pr -R o/r merge 5`
// and `glab mr -R g/p merge 5` are valid. Move flags that sit before the command
// words to just after them, so [0] and [1] are always the command words and the
// subcommand's parser still sees the flags. `api` takes no subcommand.
function commandWords(args) {
  const words = [];
  const flags = [];
  let i = 0;
  while (i < args.length && words.length < 2) {
    const a = args[i];
    if (a.length > 1 && a.startsWith('-')) {
      flags.push(a);
      // -R/--repo (alone or ending a short cluster such as -hR) takes the next token.
      if ((a === '--repo' || /^-[A-Za-z]*R$/.test(a)) && i + 1 < args.length) flags.push(args[++i]);
      i++;
      continue;
    }
    words.push(a);
    i++;
    if (a === 'api') break;
  }
  return [...words, ...flags, ...args.slice(i)];
}

// Arguments after `gh` in a token list, or null if the segment isn't a gh call.
function ghParts(tokens) {
  const gi = tokens.findIndex((t) => t === 'gh' || t === 'gh.exe' || /[\\/]gh(\.exe)?$/.test(t));
  if (gi < 0) return null;
  return commandWords(tokens.slice(gi + 1));
}

// For the args of a merge command: the first positional is the target (null
// means the current branch's request) and -R/--repo is the repo. Handles
// `-R x`, `-Rx`, `-R=x`, `--repo x`, `--repo=x` and short clusters (`-sR x`).
// shortValue / longValue name the flags that take a value, so their values
// aren't mistaken for the target.
function mergeTarget(args, shortValue, longValue) {
  let target = null;
  let repo = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      if (!longValue.has(name)) continue;
      const value = eq < 0 ? args[++i] : a.slice(eq + 1);
      if (name === '--repo') repo = value;
      continue;
    }
    if (a.length > 1 && a.startsWith('-')) {
      for (let j = 1; j < a.length; j++) {
        if (!shortValue.has(a[j])) continue;
        const value = a.slice(j + 1).replace(/^=/, '') || args[++i];
        if (a[j] === 'R') repo = value;
        break;
      }
      continue;
    }
    if (!target) target = a;
  }
  return { target, repo };
}

// For the args after `gh pr merge`: the PR (number, URL or branch) and --repo.
function prMergeTarget(args) {
  return mergeTarget(args, new Set(['R', 'b', 'F', 't', 'A']),
    new Set(['--repo', '--body', '--body-file', '--subject', '--match-head-commit', '--author-email']));
}

// Every `gh pr merge` in a command line, as { target, repo, args }.
function findPrMerges(cmd) {
  const out = [];
  for (const seg of allSegments(cmd)) {
    const gh = ghParts(seg);
    if (gh && gh[0] === 'pr' && gh[1] === 'merge') out.push({ ...prMergeTarget(gh.slice(2)), args: gh.slice(2) });
  }
  return out;
}

// Arguments after `glab` in a token list, or null if the segment isn't a glab call.
function glabParts(tokens) {
  const gi = tokens.findIndex((t) => t === 'glab' || t === 'glab.exe' || /[\\/]glab(\.exe)?$/.test(t));
  if (gi < 0) return null;
  return commandWords(tokens.slice(gi + 1));
}

// glab's subcommand aliases: `glab merge-request` = `glab mr`; `mr accept` = `mr merge`.
const isGlabMr = (t) => t === 'mr' || t === 'merge-request';
const isGlabMerge = (t) => t === 'merge' || t === 'accept';

// For the args after `glab mr merge`: the MR (IID, URL or branch) and --repo.
function mrMergeTarget(args) {
  return mergeTarget(args, new Set(['R', 'm']), new Set(['--repo', '--message', '--squash-message', '--sha']));
}

// Every merge of a pull or merge request in a command line, either forge:
// { forge: 'github' | 'gitlab', target, repo, args }.
function findMerges(cmd) {
  const out = [];
  for (const seg of allSegments(cmd)) out.push(...segmentMerges(seg));
  return out;
}

// The merges in one segment's tokens, as findMerges returns them.
function segmentMerges(seg) {
  const out = [];
  const gh = ghParts(seg);
  if (gh && gh[0] === 'pr' && gh[1] === 'merge') out.push({ forge: 'github', ...prMergeTarget(gh.slice(2)), args: gh.slice(2) });
  const gl = glabParts(seg);
  if (gl && isGlabMr(gl[0]) && isGlabMerge(gl[1])) out.push({ forge: 'gitlab', ...mrMergeTarget(gl.slice(2)), args: gl.slice(2) });
  return out;
}

// For a segment that bash and PowerShell read differently (segments' `readings`):
// null when every reading merges the same requests (forge, target, repo), else
// { sh, ps }, a description of what each shell would merge, such as
// "PR (current branch)" or "PR 7>out". A guard can't tell which shell runs the
// command, so a disagreement means it can't tell which request to check.
function ambiguousMerge(seg) {
  const r = seg && seg.readings;
  if (!r) return null;
  const key = (tokens) => JSON.stringify(segmentMerges(tokens).map((m) => [m.forge, m.target, m.repo]));
  const keys = new Set([key(seg), key(r.sh), key(r.ps)]);
  if (keys.size === 1) return null;
  const noun = (f) => (f === 'gitlab' ? 'MR' : 'PR');
  const show = (tokens) => segmentMerges(tokens)
    .map((m) => `${noun(m.forge)} ${m.target === null ? '(current branch)' : m.target}${m.repo ? ` in ${m.repo}` : ''}`)
    .join(', ') || 'no merge';
  return { sh: show(r.sh), ps: show(r.ps) };
}

// Which tool sent this hook event: 'claude' (default) or 'codex'.
const CODEX_ONLY_TOOLS = new Set(['send_input', 'resume_agent', 'followup_task', 'wait_agent', 'close_agent', 'list_agents', 'apply_patch']);
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
  detectTool, PLUGIN_ROOT, readStdin, projectDir, logPath, logDir, inUse, appendJsonl, guidanceVersion,
  agentDefaults, parseTaskCard, responseText, lastFencedJson, usageFrom,
  segments, allSegments, ghParts, prMergeTarget, findPrMerges,
  glabParts, isGlabMr, isGlabMerge, mrMergeTarget, findMerges, segmentMerges, ambiguousMerge,
};
