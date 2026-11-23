// Shared helpers for agent-team hooks. No dependencies; Node 18+.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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
// The git top level of `cwd`, or `cwd` itself outside a repository. git runs
// without the caller's GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG*, ...),
// so the environment cannot name another repository as this folder's project
// (decision 0029, residual d). Only the one trailing newline is cut: a folder
// name may end in a space.
function gitRoot(cwd) {
  if (GIT_ROOTS.has(cwd)) return GIT_ROOTS.get(cwd);
  let found = cwd;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).replace(/\r?\n$/, '');
    if (top) found = top;
  } catch { /* not a git folder, or git missing */ }
  GIT_ROOTS.set(cwd, found);
  return found;
}
function projectDir(input) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  return gitRoot((input && typeof input.cwd === 'string' && input.cwd) || process.cwd());
}

// Where the xlarge grant's intake line lives for the project that holds `dir`:
// the git top level of `dir` (GIT_* ignored, CLAUDE_PROJECT_DIR not consulted),
// or the main checkout when that is a linked worktree. `status.js grant` reads
// there and `log-event.js milestone` writes there, so the two cannot disagree.
function grantLogRoot(dir) {
  const top = gitRoot(dir);
  return mainCheckout(top) || top;
}
function samePath(a, b) {
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const [x, y] = [real(a), real(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
// CLAUDE_PROJECT_DIR may agree with the cwd's project; it may not move the grant
// check or the intake line to another project. Returns null when it is unset or
// agrees, else { env, root } for the message.
function foreignProjectDir(cwd) {
  const env = process.env.CLAUDE_PROJECT_DIR;
  const root = grantLogRoot(cwd);
  return env && !samePath(grantLogRoot(env), root) ? { env, root } : null;
}

// The main checkout of a linked git worktree, or null when `dir` is the main
// checkout or not the root of a checkout. Read from git's own files, with no
// process spawn, because the logger asks on every hook call: in a linked
// worktree `.git` is a file naming the worktree's git folder, and that
// folder's `commondir` file points at the main checkout's `.git`. (A
// submodule's `.git` is a file too, but its git folder has no `commondir`.)
const MAIN_CHECKOUTS = new Map();
function mainCheckout(dir) {
  if (MAIN_CHECKOUTS.has(dir)) return MAIN_CHECKOUTS.get(dir);
  let found = null;
  try {
    const dotGit = path.join(dir, '.git');
    const m = fs.statSync(dotGit).isFile() && /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (m) {
      const gitDir = path.resolve(dir, m[1].trim());
      const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
      if (path.basename(common) === '.git' && path.resolve(path.dirname(common)) !== path.resolve(dir)) found = path.dirname(common);
    }
  } catch { /* not a linked worktree */ }
  MAIN_CHECKOUTS.set(dir, found);
  return found;
}

// The folder that holds `.agent-team/`: the project folder, or the main
// checkout when the project folder is a linked git worktree. A worktree is
// removed when its task ends, and `.agent-team/logs/` is ignored, so lines
// written inside one would be deleted with it. Every session and agent of a
// project therefore writes to the main checkout's logs.
function logRoot(input) {
  const root = projectDir(input);
  return mainCheckout(root) || root;
}

// The logs folder path, without creating it. Use this for reads and checks, so
// looking for a log never leaves a folder behind.
function logPath(input) {
  return path.join(logRoot(input), '.agent-team', 'logs');
}

// The logs folder path, created if missing. Throws (see safeMkdir) when
// `.agent-team` or `logs` is a link or junction.
function logDir(input) {
  return safeMkdir(logPath(input));
}

// --- safe writes under .agent-team/logs/ (begin) ---
// A cloned repo can commit anything under .agent-team/logs/, links included:
// `completions.jsonl` -> `~/.bashrc`, or `.pending` -> a folder of the user's.
// Every write, folder creation, listing for deletion and temp file under the
// logs folder goes through these helpers, so none of them follows a link.
// tests/fu18-safe-write.test.js greps scripts/ for raw writes outside this block.
//
// The checks: `.agent-team` and every folder below it down to the file's own
// folder must be a real folder (lstat: not a symlink, not a junction); the
// file, when it exists, must be a regular file with one name (not a link, not
// a hard link). The open uses O_NOFOLLOW where the platform has it (not
// Windows), and fstat after the open catches a hard link made since the check.
// Accepted: on Windows a file symlink swapped in between the lstat and the open
// is followed. Making one there takes write access to the logs folder and, on
// Windows, the symlink privilege; a committed link is always caught.
//
// A refusal prints one line to stderr naming the path (once per path per
// process) and throws an Error with code EAGENTTEAMREFUSED. Hooks catch it
// and carry on without the write.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const REFUSED = 'EAGENTTEAMREFUSED';
const warnedRefusals = new Set();
// Test seam: runs between the checks and the open of safeAppend.
const safeWriteHooks = { beforeOpen: null };

function refuse(file, why) {
  const err = new Error(`refusing to write ${file}: ${why}`);
  err.code = REFUSED;
  err.path = file;
  if (!warnedRefusals.has(err.message)) {
    warnedRefusals.add(err.message);
    try { process.stderr.write(`agent-team: ${err.message}\n`); } catch { /* stderr closed */ }
  }
  throw err;
}

// `.agent-team` and each folder below it, down to `dir`; [dir] for a path with
// no `.agent-team` component.
function guardedDirs(dir) {
  const parts = path.resolve(dir).split(path.sep);
  const i = parts.lastIndexOf('.agent-team');
  if (i < 0) return [path.resolve(dir)];
  const out = [];
  for (let j = i; j < parts.length; j++) out.push(parts.slice(0, j + 1).join(path.sep) || path.sep);
  return out;
}

// 'missing', or 'ok' for a real folder; refuses a link, a junction or a file.
function dirState(d) {
  let st;
  try { st = fs.lstatSync(d); } catch (e) { if (e && e.code === 'ENOENT') return 'missing'; throw e; }
  if (st.isSymbolicLink()) refuse(d, 'the folder is a link or junction');
  if (!st.isDirectory()) refuse(d, 'not a folder');
  return 'ok';
}

// Create `dir` and the guarded folders above it, one level at a time, each a
// real folder. Returns dir.
function safeMkdir(dir) {
  const chain = guardedDirs(dir);
  for (const [n, d] of chain.entries()) {
    if (dirState(d) === 'ok') continue;
    if (n === 0) fs.mkdirSync(path.dirname(d), { recursive: true }); // the project folder, outside .agent-team
    try { fs.mkdirSync(d); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
    if (dirState(d) !== 'ok') refuse(d, 'the folder vanished while it was created');
  }
  return dir;
}

// The entries of a folder under the logs folder, to drain or prune it; null
// when it (or a folder above it) is missing. Refuses a linked folder.
function safeListDir(dir, opts) {
  for (const d of guardedDirs(dir)) if (dirState(d) === 'missing') return null;
  return fs.readdirSync(dir, opts);
}

function checkFile(file, st) {
  if (st.isSymbolicLink()) refuse(file, 'the file is a link');
  if (!st.isFile()) refuse(file, 'not a regular file');
  if (st.nlink > 1) refuse(file, 'the file has another hard link');
}

// Refuse an existing log that is a link, not a regular file, or hard-linked;
// also check the folders above it. A missing file passes.
function checkLogFile(file) {
  for (const d of guardedDirs(path.dirname(file))) dirState(d);
  let st = null;
  try { st = fs.lstatSync(file); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  if (st) checkFile(file, st);
}

// Append `data` to a log, creating it if missing.
function safeAppend(file, data) {
  safeMkdir(path.dirname(file));
  checkLogFile(file);
  if (safeWriteHooks.beforeOpen) safeWriteHooks.beforeOpen(file);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | O_NOFOLLOW, 0o666);
  } catch (e) {
    if (e && (e.code === 'ELOOP' || e.code === 'EMLINK')) refuse(file, 'the file is a link');
    throw e;
  }
  try {
    checkFile(file, fs.fstatSync(fd));
    fs.writeFileSync(fd, data, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Create `file` exclusively (it must not exist: EEXIST otherwise) and return
// the open fd. O_EXCL never follows a link at the name.
function safeOpenNew(file) {
  safeMkdir(path.dirname(file));
  return fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o666);
}

// Create `file` exclusively with `data`. Throws EEXIST when the name exists.
function safeWriteNew(file, data) {
  const fd = safeOpenNew(file);
  try { fs.writeFileSync(fd, data, 'utf8'); } finally { fs.closeSync(fd); }
}

// A temp name next to `file` that no committed file can already hold.
function tempName(file) {
  return `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
}
// A name tempName made. A process that dies between the create and the rename
// leaves one behind; records.prunePending and archive-logs sweep old ones.
const TEMP_FILE = /\.[0-9a-f]{16}\.tmp$/;

// Replace `file` with `data`: a new temp file, renamed over it. A rename
// replaces a link at the name; it never writes to what the link points at.
function safeReplace(file, data) {
  const tmp = tempName(file);
  safeWriteNew(tmp, data);
  try { fs.renameSync(tmp, file); } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}
// --- safe writes under .agent-team/logs/ (end) ---

// Does this project use agent-team? True when it has an .agent-team folder
// (team-init, or an earlier log line), or its own settings turn the plugin on
// (.claude/settings*.json), or its Codex hooks call the shim; or when it is a
// git worktree of a checkout where one of those holds (a worktree has no
// ignored files, so a project that ignores `.agent-team/` shows no sign of it
// there). The plugin can be installed for every project of a user; the hooks
// use this to stay out of the ones that never set it up.
function inUse(input) {
  const usedAt = (root) => {
    if (fs.existsSync(path.join(root, '.agent-team'))) return true;
    const mentions = (rel, needle) => {
      try { return fs.readFileSync(path.join(root, ...rel), 'utf8').includes(needle); } catch { return false; }
    };
    return mentions(['.claude', 'settings.json'], 'agent-team@') ||
      mentions(['.claude', 'settings.local.json'], 'agent-team@') ||
      mentions(['.codex', 'hooks.json'], 'agent-team-hook.js');
  };
  const root = projectDir(input);
  if (usedAt(root)) return true;
  const main = mainCheckout(root);
  return !!main && usedAt(main);
}

// Should the guard and the SessionStart line act in this project? The plugin is
// enabled per project: a user-level install does nothing in a project that was
// never set up (team-init). True when the hook came from the project's own
// hooks (the Codex shim), or the project is in use.
function enabledHere(input) {
  return process.env.AGENT_TEAM_HOOK_SOURCE === 'project' || inUse(input);
}

// Append one JSON line to a log. Throws on a refused path (see safeAppend).
function appendJsonl(input, file, record) {
  safeAppend(path.join(logPath(input), file), JSON.stringify(record) + '\n');
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
    if (card.flags !== undefined) {
      // Empty items drop (`flags=`, `a,`), and a repeated flag counts once, in first-seen order.
      const flags = [...new Set(card.flags.split(',').map((f) => f.trim()).filter(Boolean))];
      if (flags.length) card.flags = flags; else delete card.flags;
    }
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

// The review in a reply, taken only when it is unambiguous. Logged verdicts
// decide whether a milestone can close, so a `review-json` fence quoted in a
// diff, a nested fence or a `>` quote must never be read as the verdict.
//
// A review block counts when it is a top-level fence (the fence line at column
// 0, backticks, not inside another fence of any length, not in a `>` quote)
// and the last non-blank content of the reply. Fences follow CommonMark: a
// fence opens with three or more backticks or tildes (up to three spaces of
// indent) and closes on a line of the same character, at least as long, with
// nothing after it; an unterminated fence runs to the end of the reply.
//
// Returns:
//   null                              no review-json fence anywhere in the reply
//   the parsed JSON, or { _unparsed } the one qualifying block
//   { _ambiguous: true, count }       review-json fences were there but none
//                                     qualifies, or two or more are top-level;
//                                     count is the top-level blocks found
// HTML blocks (CommonMark start conditions 1-6) are raw text, not markdown, so a
// fence inside one is never the reply's own: <pre|script|style|textarea>, <!-- -->,
// <? ?>, <!X >, <![CDATA[ ]]> run to their end marker; block tags such as
// <details> and <div> run to a blank line, and while a <details> or <div> is
// still open (more opened than closed) every line is skipped, since a renderer
// shows that content as part of the quote.
// One pass over the text, one line at a time: no regex runs across the text.
const HTML_BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_STARTS = [
  [/^<(pre|script|style|textarea)(\s|>|$)/i, /<\/(pre|script|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<![A-Za-z]/, />/],
  [/^<!\[CDATA\[/, /\]\]>/],
  [new RegExp('^</?(' + HTML_BLOCK_TAGS + ')(\\s|/?>|$)', 'i'), null],
];
const countMatches = (line, re) => (line.match(re) || []).length;
function reviewJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const mentioned = text.includes('```review-json') || text.includes('~~~review-json');
  if (!mentioned) return null;
  const n = text.length;
  let fence = null;         // the open fence: { ch, len, review, bodyStart }
  const blocks = [];        // closed top-level review blocks: { body, closeLine }
  let lineNo = 0;
  let lastContent = -1;     // the last line with anything but blanks on it
  let html = null;          // the open HTML block: { end } (end null: runs to a blank line)
  let depth = 0;            // <details>/<div> opened and not yet closed
  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  while (pos < n) {
    let end = pos;
    while (end < n) { const c = text.charCodeAt(end); if (c === 10 || c === 13) break; end++; }
    const line = text.slice(pos, end);
    let next = end;
    if (next < n) next += text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? 2 : 1;
    // Indent in columns (a tab goes to the next multiple of 4) and the first non-blank character.
    let col = 0, i = 0;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === ' ') col++;
      else if (c === '\t') col += 4 - (col % 4);
      else break;
    }
    if (i < line.length) {
      lastContent = lineNo;
      const ch = line[i];
      let run = 0;
      if (ch === '`' || ch === '~') { while (i + run < line.length && line[i + run] === ch) run++; }
      const rest = line.slice(i);
      if (!fence && html && html.end) {
        if (html.end.test(rest)) html = null;
      } else if (!fence && !html && col <= 3 && ch === '<' && HTML_STARTS.some(([start]) => start.test(rest))) {
        const [, end] = HTML_STARTS.find(([start]) => start.test(rest));
        if (!end || !end.test(rest.slice(1))) html = { end };
      }
      if (!fence && (html || depth > 0)) {
        // Raw HTML: not scanned for fences.
      } else if (fence) {
        // CommonMark's closing rule: same character, at least as long, nothing else on the line.
        if (col <= 3 && run >= fence.len && ch === fence.ch && line.slice(i + run).trim() === '') {
          if (fence.review) blocks.push({ body: text.slice(fence.bodyStart, pos), closeLine: lineNo });
          fence = null;
        }
      } else if (col <= 3 && run >= 3) {
        const info = line.slice(i + run).trim();
        // A backtick fence's info string can't hold a backtick (that is inline code).
        if (ch !== '`' || !info.includes('`')) {
          fence = { ch, len: run, review: col === 0 && ch === '`' && info === 'review-json', bodyStart: next };
        }
      }
    }
    if (i < line.length && !fence && (html || depth > 0 || /^<\/?(details|div)/i.test(line.slice(i)))) {
      depth = Math.max(0, depth + countMatches(line, /<(details|div)(\s[^>]*)?>/gi) - countMatches(line, /<\/(details|div)\s*>/gi));
    }
    if (i >= line.length && html && !html.end) html = null;
    pos = next;
    lineNo++;
  }
  // A `>` quote starts with ">" and an indent of four columns fails the column
  // test, so neither opens a fence: a fence quoted there is not the reply's own.
  // An unterminated fence is never a block; its lines count as content.
  if (blocks.length === 1 && blocks[0].closeLine === lastContent) {
    const body = blocks[0].body.trim();
    try {
      return JSON.parse(body);
    } catch {
      return { _unparsed: body.slice(0, 500) };
    }
  }
  return { _ambiguous: true, count: blocks.length };
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
// `N>f`, `N>&M`, `>&N`, `>&f`, `>|f`, `&>f`, `&>>f` are dropped along with
// their target, so `gh pr merge --squash 2>&1` has no number, and `2>&1` is not
// a `2` followed by a `&` break and a `1`.
//
// Words glued to a redirection, and the invariant a guard relies on: a word
// written right before a redirection operator, with no space (`2>&1`, `7>f`,
// `""5>f`, `5&>f`, `main>f`), is dropped as a stream number only when its raw
// text is exactly one digit 1-6 and the operator starts with `>`. That is the
// one glued form every supported shell reads the same way: a file descriptor
// in bash, a stream in PowerShell 5.1 (`N>f`, `N>>f`, `N>&1`; its other `N>&M`
// and `N>|` forms don't parse, so nothing runs), a handle in cmd. Every other
// glued word is read differently by some shell, or depends on rules this
// parser doesn't model (quotes, escapes, variables, globs). Bash takes any
// unquoted digit string as a file descriptor but a quoted, escaped or variable
// word as an argument, `5\>f` as the argument `5>f`, and `*` as a glob;
// PowerShell takes only 1-6 and `*`; cmd takes the last digit. Such a word is recorded in the
// returned array's non-enumerable `unsure` list, and so is a redirection target
// whose raw text ends in a backslash or has one before a quote (`>out\ 5`:
// bash escapes the space and merges the current branch, PowerShell merges PR 5).
// A guard must refuse a command whose `unsure` list is not empty instead of
// checking any reading of it. The segments still hold bash's reading (an
// unquoted glued number dropped as a file descriptor, any other glued word kept
// as an argument) for callers such as the merge logger that only describe a
// command that already ran.
// Not read: `$(…)` inside a double-quoted string.
function segments(cmd) {
  const out = [];
  const unsure = []; // { text, why } for each redirection the shells read differently
  let cur = [], tok = '', quote = null, hasTok = false;
  // Where the current raw word starts in cmd (-1: between words). The glued-word
  // check reads the raw text, quotes and backslashes included, so `""5`, `5""`,
  // `\5` and `{5` never pass for the digit 5.
  let wordStart = -1;
  const heredocs = []; // delimiters waiting for the end of the current line
  const pushTok = () => { if (hasTok) cur.push(tok); tok = ''; hasTok = false; wordStart = -1; };
  const pushSeg = () => { pushTok(); if (cur.length) out.push(cur); cur = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null; else tok += c;
      continue;
    }
    if (c === '\\' || c === '`') {
      // Line continuation (sh: backslash, PowerShell: backtick).
      const nl = cmd[i + 1] === '\n' ? 1 : (cmd[i + 1] === '\r' && cmd[i + 2] === '\n' ? 2 : 0);
      if (nl) { i += nl; continue; }
      if (c === '`') { pushSeg(); continue; }
    }
    if (wordStart < 0 && !/[\s;&|()>]/.test(c)) wordStart = i;
    if (c === '"' || c === "'") { quote = c; hasTok = true; continue; }
    if (c === '(' || c === ')') { pushSeg(); continue; }
    if (c === '>' || (c === '&' && cmd[i + 1] === '>')) {
      // A redirection: the operator, then its target, dropped.
      let j = i + (c === '&' ? 2 : 1);
      if (cmd[j] === '>') j++;
      if (cmd[j] === '&' || cmd[j] === '|') j++;
      const op = cmd.slice(i, j);
      let k = j;
      while (cmd[k] === ' ' || cmd[k] === '\t') k++;
      const end = skipRedirectTarget(cmd, k);
      const glued = wordStart < 0 ? '' : cmd.slice(wordStart, i);
      if (glued && !(c === '>' && /^[1-6]$/.test(glued))) unsure.push({ text: glued + op, why: 'glued' });
      // Bash's reading: an unquoted number before `>` is a file descriptor;
      // `&>` takes none, so a word before it is an argument.
      if (c === '>' && /^\d+$/.test(glued)) { tok = ''; hasTok = false; }
      pushTok();
      const target = cmd.slice(k, end);
      if (/\\(?:["']|$)/.test(target)) unsure.push({ text: op + target, why: 'escape' });
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
    tok += c; hasTok = true;
  }
  pushSeg();
  Object.defineProperty(out, 'unsure', { value: unsure, enumerable: false });
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
// shell (see nestedCommands), a few levels deep. The `unsure` list (see
// segments) covers the nested commands too.
function allSegments(cmd, depth = 0) {
  const out = [];
  const segs = segments(cmd || '');
  const unsure = [...segs.unsure];
  for (const seg of segs) {
    out.push(seg);
    if (depth < 3) {
      for (const inner of nestedCommands(seg)) {
        const nested = allSegments(inner, depth + 1);
        out.push(...nested);
        unsure.push(...nested.unsure);
      }
    }
  }
  Object.defineProperty(out, 'unsure', { value: unsure, enumerable: false });
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

// Agents and card types that report a review-json block instead of result-json.
const REVIEWER_AGENT_TYPES = ['agent-team:reviewer', 'agent-team:security-reviewer'];
const REVIEW_TASK_TYPES = ['review', 'security-review'];

// Is this delegation a review? A reviewer agent (Claude's `agent-team:reviewer`
// and `agent-team:security-reviewer`, or Codex's `reviewer-<tier>` and
// `security-reviewer-<tier>`), or a card whose type is a review type.
const CODEX_REVIEWER = /^(?:security-)?reviewer-[a-z]+$/;
function isReviewDelegation(agentType, task) {
  return REVIEWER_AGENT_TYPES.includes(agentType) || (typeof agentType === 'string' && CODEX_REVIEWER.test(agentType)) ||
    !!(task && REVIEW_TASK_TYPES.includes(task.type));
}

// The review in a reply, for this delegation. Only a review delegation gets the
// `_ambiguous` marker: any other agent may quote a review-json fence (in a diff,
// a test, a decision) without having written a review, so there it is no review.
function reviewFor(text, agentType, task) {
  const review = reviewJson(text);
  return review && review._ambiguous && !isReviewDelegation(agentType, task) ? null : review;
}

module.exports = {
  REVIEWER_AGENT_TYPES, REVIEW_TASK_TYPES, isReviewDelegation, reviewFor,
  detectTool, PLUGIN_ROOT, readStdin, projectDir, gitRoot, grantLogRoot, foreignProjectDir, logPath, logDir, logRoot, mainCheckout, inUse, enabledHere, appendJsonl, guidanceVersion,
  safeAppend, safeWriteNew, safeOpenNew, safeReplace, safeMkdir, safeListDir, checkLogFile, tempName, TEMP_FILE, safeWriteHooks, REFUSED,
  agentDefaults, parseTaskCard, responseText, lastFencedJson, reviewJson, usageFrom,
  segments, allSegments, ghParts, prMergeTarget, findPrMerges,
  glabParts, isGlabMr, isGlabMerge, mrMergeTarget, findMerges, segmentMerges,
};
