// Transcript parser for the live CI harness (tests/live/ci-wait-live.js).
// Reads the Director's own transcript only (not subagents) and works out how many
// turns (API calls) and context tokens it spent, and which of those turns were
// about CI. Pure: no I/O, Node built-ins only. Unit tests: tests/ci-turns.test.js.
//
// Two transcript shapes:
//   Claude stream-json (`claude -p --output-format stream-json --verbose`):
//     one JSON object per line. `assistant` lines carry message.id, message.content
//     (text / tool_use blocks) and message.usage. A message split over several lines
//     repeats the same id. Subagent lines carry parent_tool_use_id. A finished
//     background task shows up as `{"type":"system","subtype":"task_notification"}`.
//   Codex rollout (`<CODEX_HOME>/sessions/**/rollout-*.jsonl`):
//     `response_item` lines with function_call / custom_tool_call / local_shell_call,
//     and `event_msg` token_count lines whose last_token_usage is one model call.
'use strict';

// What counts as "about CI". Order matters only for the label in `kinds`.
const CI_PATTERNS = [
  ['pr-checks', /\bgh(?:\.exe)?\s+pr\s+checks\b/],
  ['run-watch-view', /\bgh(?:\.exe)?\s+run\s+(?:watch|view)\b/],
  ['ci-wait', /\bci-wait\.js\b/],
  ['glab-ci', /\bglab(?:\.exe)?\s+ci\b/],
  ['head-pipeline', /\bhead_pipeline\b/],
  ['status-check-rollup', /\bstatusCheckRollup\b/],
  ['reconcile-merges', /\breconcile-logs\.js\b[^\n]*--merges\b/],
  ['merge-auto', /\b(?:gh(?:\.exe)?\s+pr|glab(?:\.exe)?\s+mr)\b[^\n]*?\bmerge\b[^\n]*--auto(?:-merge)?(?![\w-])/],
  ['disable-auto', /--disable-auto\b/],
];
// A blocking watch: `gh pr checks --watch`, `gh run watch`, any --watch flag.
const WATCH = /--watch\b|\bgh(?:\.exe)?\s+run\s+watch\b/;
// A command that does not block the call. sh/bash: a lone `&` ending a line, alone or
// followed by `echo $!` / `disown` (so also `nohup cmd &`). PowerShell: Start-Job,
// Start-ThreadJob, and Start-Process unless it has -Wait. Judged on the whole command
// text, so a script that backgrounds one line and runs another in the foreground counts
// as background.
const AMP_BACKGROUND = /(?:^|[^&>])&\s*(?:(?:;\s*)?(?:echo\b[^\n]*|disown\b[^\n]*))?$/m;
const PS_JOB = /\b(?:Start-Job|Start-ThreadJob)\b/i;
const PS_START_PROCESS = /\bStart-Process\b/i;
function isBackgroundCommand(cmd) {
  const c = String(cmd || '');
  if (AMP_BACKGROUND.test(c) || PS_JOB.test(c)) return true;
  return PS_START_PROCESS.test(c) && !/-Wait\b/i.test(c);
}

// Tools that run a shell command. Monitor runs one and streams its output back as
// notifications, so it never blocks the call: always background.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const COMMAND_TOOLS = new Set([...SHELL_TOOLS, 'Monitor']);
const ALWAYS_BACKGROUND = new Set(['Monitor']);

// Which CI patterns a command matches (labels). Empty when it is not about CI.
function ciKinds(cmd) {
  const v = codeView(cmd);
  return CI_PATTERNS.filter(([, re]) => re.test(v)).map(([k]) => k);
}
const isWatch = (cmd) => WATCH.test(codeView(cmd));

// The command as it runs: text that is only data is removed first, so a PR number or a script
// name inside it cannot count. Removed: heredoc bodies and PowerShell here-strings (unless an
// interpreter reads them: bash, sh, pwsh, node, python, Invoke-Expression, iex), the value of
// --body/-b/--message/-m/--title/--notes, the script of the sed segment, the arguments of
// .Replace(...) and -replace, and the own arguments of echo/printf/Write-Host/Write-Output up to
// the next ; && || | or line break (a $(...), `...` or (...) sub-expression inside them runs, so it
// is kept). A Codex exec call wraps the command in a JS string, so a literal \n there is a line
// break and \" is a quote. When in doubt the text stays: an over-count is cosmetic, an
// under-count hides a real CI call.
const STR = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*')`;
const OPT_VALUE = new RegExp(String.raw`(--body|--message|--title|--notes|--description|-b|-m|-t)(\s+|=)${STR}`, 'g');
const SED_SCRIPT = new RegExp(String.raw`(\bsed\b[^\n;&|]*?\s)${STR}`, 'g');
const PS_REPLACE_METHOD = new RegExp(String.raw`\.Replace\(\s*${STR}\s*(?:,\s*${STR}\s*)?\)`, 'gi');
const PS_REPLACE_OP = new RegExp(String.raw`(-i?c?replace\s+)${STR}(?:\s*,\s*${STR})?`, 'gi');
const INTERPRETER_BEFORE = /(?<![\w.-])(?:bash|sh|zsh|pwsh|powershell|node|python3?|Invoke-Expression|iex)\b/i;
// An interpreter that reads a here-string elsewhere in the call: Invoke-Expression/iex, pwsh, a pipe
// into a shell, `bash -c $c`, or a script block built from it (& ([scriptblock]::Create($c))).
// Known gap: `& $c`-style calls through some other variable or alias are not recognised, so a
// here-string run that way is dropped as data (an under-count); say so rather than guess.
const INTERPRETER_AFTER = /\bInvoke-Expression\b|\biex\b|\bpwsh\b|\bpowershell\b|\|\s*(?:node|python3?|bash|sh|zsh)\b|\b(?:bash|sh|zsh)\s+-c\b|\[scriptblock\]::Create\b/i;
// An interpreter that a heredoc is piped into on its opening line: `cat <<EOF | bash`.
const INTERPRETER_PIPED = /\|\s*(?:bash|sh|zsh|pwsh|powershell|node|python3?)\b/i;
const PRINT_CMD = /(^|[;&|\n{(]|["'`])[ \t]*(?:echo|printf|Write-Host|Write-Output)\b/gi;
// Index of the ")" that closes the "(" at i (quotes respected); s.length when there is none.
function closeParen(s, i) {
  let depth = 0; let q = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\' && q === '"') j++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return s.length;
}
// Replace each print command's own arguments by the sub-expressions that run inside them.
function stripPrint(s) {
  const re = new RegExp(PRINT_CMD.source, 'gi');
  let out = ''; let last = 0; let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[1].length;
    const kept = [];
    let j = m.index + m[0].length; let q = null;
    while (j < s.length) {
      const c = s[j];
      if (q === "'") { if (c === "'") q = null; j++; continue; }
      if (c === '$' && s[j + 1] === '(') { const e = closeParen(s, j + 1); kept.push(s.slice(j + 2, e)); j = e + 1; continue; }
      if (c === '`') { const e = s.indexOf('`', j + 1); if (e < 0) { j++; continue; } kept.push(s.slice(j + 1, e)); j = e + 1; continue; }
      if (q === '"') { if (c === '\\') j++; else if (c === '"') q = null; j++; continue; }
      if (c === '"' || c === "'") { q = c; j++; continue; }
      if (c === '(') { const e = closeParen(s, j); kept.push(s.slice(j + 1, e)); j = e + 1; continue; }
      if (c === ';' || c === '|' || c === '&' || c === '\n') break;
      j++;
    }
    out += s.slice(last, start) + kept.join('\n');
    last = j; re.lastIndex = Math.max(j, m.index + 1);
  }
  return out + s.slice(last);
}
function codeView(cmd) {
  // A Codex exec call wraps the command in a JS string, so a line break there is the two characters
  // backslash and n (or \r\n, or a lone \r). Turn each into a real line break. In a real bash or
  // PowerShell command the same two characters can be text (a literal \n in a sed or printf
  // argument); treating that as a line break only splits more, which is the safe direction: inside
  // quotes the text stays quoted and is still dropped as text, outside quotes it can only over-count.
  let s = String(cmd || '').replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\\"/g, '"');
  // heredoc body: kept when the line that opens it runs an interpreter (bash <<EOF, cat <<EOF | bash)
  s = s.replace(/(<<-?[ \t]*(['"]?)(\w+)\2([^\n]*)\n)[\s\S]*?(\n[ \t]*\3(?!\w))/g, (all, head, q, tag, rest, tail, off, str) => {
    const pre = str.slice(str.lastIndexOf('\n', off) + 1, off);
    return INTERPRETER_BEFORE.test(pre) || INTERPRETER_PIPED.test(rest) ? all : head + tail;
  });
  // PowerShell here-string: kept when an interpreter reads it elsewhere in the call
  s = s.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, (all, q, off, str) => (INTERPRETER_AFTER.test(str.slice(0, off) + str.slice(off + all.length)) ? all : "@''@"));
  s = s.replace(OPT_VALUE, '$1$2""').replace(SED_SCRIPT, '$1""').replace(PS_REPLACE_METHOD, '.Replace()').replace(PS_REPLACE_OP, '$1""');
  return stripPrint(s);
}
// The pieces of a command that run one after the other.
const segmentsOf = (view) => view.split(/&&|\|\||[;|\n]/);

// Flags that take no value, so a number after them is a PR number (ci-wait.js --once 12, --names 12).
const BOOL_FLAGS = new Set(['--names', '--allow-none', '--auto', '--auto-merge', '--squash', '--merge', '--rebase', '--delete-branch', '--admin',
  '--once', '--watch', '--fail-fast', '--required', '--web', '--disable-auto', '--no-delete-branch']);
// PR numbers a command names, taken only from the segments that are about CI (a segment that
// matches one of CI_PATTERNS): `gh pr checks|merge|view|status 12`, `glab mr merge|view|checks 12`,
// `ci-wait.js 12 13`. A `gh pr create --body "...#4, #5"`, a `gh pr view 43 --json title,body`, a
// sed or .Replace edit of STATUS.md or a heredoc names none, even when the same call also runs
// a CI command.
function prNumbers(cmd) {
  const out = new Set();
  for (const seg of segmentsOf(codeView(cmd))) {
    if (!CI_PATTERNS.some(([, re]) => re.test(seg))) continue;
    const re = /\bgh(?:\.exe)?\s+pr\s+(?:checks|merge|view|status)\b|\bglab(?:\.exe)?\s+mr\s+(?:merge|view|checks)\b|\bci-wait\.js\b/g;
    let m;
    while ((m = re.exec(seg))) {
      // The command ends at a closing quote that sits in code (cmd:"gh pr checks 12",).
      const rest = seg.slice(m.index + m[0].length).split(/["'`](?=[,)}\]])/)[0];
      // Tokens may sit inside quotes or code (a Codex exec call wraps the command in JS).
      const toks = rest.trim().split(/\s+/).map((t) => t.replace(/^["'`]+|["'`,);]+$/g, '')).filter(Boolean);
      toks.forEach((t, i) => {
        const num = /^#?(\d{1,7})$/.exec(t);
        if (!num) return;
        const prev = toks[i - 1];
        // A flag's value (--json x, --deadline 540) is not a PR number; a boolean flag's follower is.
        if (prev && /^-/.test(prev) && !prev.includes('=') && !BOOL_FLAGS.has(prev)) return;
        out.add(num[1]);
      });
    }
  }
  return [...out];
}

// The command text of one tool call, whatever the tool: Claude's Bash/PowerShell
// `command`, Codex's exec_command `cmd`, a shell tool's argv array, or (custom tools)
// the raw input. Returns { command, background }.
function commandOf(name, input) {
  let o = input;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { /* raw text */ } }
  if (o && typeof o === 'object') {
    let c = o.command != null ? o.command : o.cmd != null ? o.cmd : o.code != null ? o.code : null;
    if (Array.isArray(c)) c = c.join(' ');
    if (c == null) c = JSON.stringify(o);
    const bg = o.run_in_background === true;
    return { command: String(c), background: bg || ALWAYS_BACKGROUND.has(name) || isBackgroundCommand(c) };
  }
  const c = String(o == null ? '' : o);
  return { command: c, background: ALWAYS_BACKGROUND.has(name) || isBackgroundCommand(c) };
}

const ctxTokens = (u) => !u ? 0 : (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

function toObjects(input) {
  if (Array.isArray(input)) return input;
  const out = [];
  for (const line of String(input || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* not JSON (a stray stderr line) */ }
  }
  return out;
}

// `milestone-json {"status":"complete","pr":12,"ci":"green"}` in a text, or null.
// Only a JSON object with status complete|incomplete counts (the prompt's own
// "complete|incomplete" template does not parse).
function milestoneJsonIn(text) {
  let found = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('milestone-json');
    if (i < 0) continue;
    const a = line.indexOf('{', i);
    const b = line.lastIndexOf('}');
    if (a < 0 || b < a) continue;
    try {
      const j = JSON.parse(line.slice(a, b + 1));
      if (j && (j.status === 'complete' || j.status === 'incomplete')) found = j;
    } catch { /* not valid JSON */ }
  }
  return found;
}

// The Director's own message text in one stream object (not a subagent's, not a tool result).
function directorText(o) {
  if (!o || typeof o !== 'object') return '';
  if (o.type === 'assistant' && !o.parent_tool_use_id && !o.isSidechain && o.message && Array.isArray(o.message.content)) {
    return o.message.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  // codex exec --json: {"type":"item.completed","item":{"type":"agent_message","text":...}}
  if (o.type === 'item.completed' && o.item && o.item.type === 'agent_message') return String(o.item.text || '');
  // older codex exec --json: {"msg":{"type":"agent_message","message":...}}
  if (o.msg && o.msg.type === 'agent_message') return String(o.msg.message || '');
  // rollout: {"type":"event_msg","payload":{"type":"agent_message","message":...}}
  if (o.type === 'event_msg' && o.payload && o.payload.type === 'agent_message') return String(o.payload.message || '');
  return '';
}
const milestoneJsonInEvent = (o) => milestoneJsonIn(directorText(o));

const HOOKS_RE = /agent-team hooks: active \(([^,)]+),\s*([^)]+)\)/;
function hooksActiveIn(text) {
  const m = HOOKS_RE.exec(String(text || ''));
  return m ? { line: m[0], tool: m[1].trim(), version: m[2].trim() } : null;
}

// ---- shared summary over a list of turns ----
// turn: { index, id, tokens, tools: [{ name, command, background, kinds, prs, watch }],
//         notified: [{ taskId, toolUseId, ci, prs }], ci: boolean, prs: [..] }
// A CI turn whose only CI kind is `reconcile-logs.js --merges` (a checkpoint, not a look at CI).
// A turn with no tool detail (a hand-made one) is not reconcile-only: when in doubt it is a CI read.
function isReconcileOnly(t) {
  const kinds = ((t && t.tools) || []).flatMap((x) => x.kinds || []);
  return kinds.length > 0 && kinds.every((k) => k === 'reconcile-merges') && !((t.notified || []).some((n) => n.ci));
}
function summarize(turns) {
  const sum = (list) => list.reduce((a, t) => a + t.tokens, 0);
  const ciTurns = turns.filter((t) => t.ci);
  const byPr = {};
  const unattributed = { turns: 0, contextTokens: 0 };
  // The turns that name no PR, split: reconcile checkpoints, and other CI reads whose PR could not be read.
  const noPr = { reconcile: { turns: 0, contextTokens: 0 }, reads: { turns: 0, contextTokens: 0 } };
  for (const t of ciTurns) {
    if (!t.prs.length) {
      unattributed.turns++; unattributed.contextTokens += t.tokens;
      const g = isReconcileOnly(t) ? noPr.reconcile : noPr.reads;
      g.turns++; g.contextTokens += t.tokens;
      continue;
    }
    for (const pr of t.prs) {
      const e = byPr[pr] || (byPr[pr] = { turns: 0, contextTokens: 0 });
      e.turns++;
      e.contextTokens += t.tokens;
    }
  }
  const watches = turns.flatMap((t) => t.tools.filter((x) => x.watch));
  return {
    turnCount: turns.length,
    contextTokens: sum(turns),
    ci: { turns: ciTurns.length, contextTokens: sum(ciTurns), byPr, unattributed, noPr,
      startedByNotification: ciTurns.filter((t) => t.notified.length).length },
    watch: { foreground: watches.filter((x) => !x.background).length, background: watches.filter((x) => x.background).length },
  };
}

function toolFrom(name, input, idInfo) {
  const { command, background } = commandOf(name, input);
  const kinds = ciKinds(command);
  return { name, id: idInfo || null, command: command.slice(0, 400), background, kinds, prs: kinds.length ? prNumbers(command) : [], watch: isWatch(command) };
}

// ---- Claude stream-json ----
function parseClaudeStream(input) {
  const objs = toObjects(input);
  const turns = [];
  const byMsg = new Map();
  const toolUses = new Map();     // tool_use id -> tool record
  const taskToTool = new Map();   // background task id -> tool_use id
  let pending = [];               // notifications since the last turn
  let idle = false;               // a `result` event was seen and no assistant turn since
  const meta = { hooksActive: null, plugins: null, model: null, resultEvents: 0, sessionId: null };

  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    if (o.session_id && !meta.sessionId) meta.sessionId = o.session_id;
    if (o.type === 'system') {
      if (o.subtype === 'init') { meta.plugins = o.plugins || meta.plugins; meta.model = meta.model || o.model || null; }
      else if (o.subtype === 'hook_response' && o.hook_event === 'SessionStart') meta.hooksActive = meta.hooksActive || hooksActiveIn(o.output || o.stdout);
      else if (o.subtype === 'task_started' && o.task_id && o.tool_use_id) taskToTool.set(o.task_id, o.tool_use_id);
      else if (o.subtype === 'task_notification') pending.push({ taskId: o.task_id || null, toolUseId: o.tool_use_id || null, summary: String(o.summary || '') });
      continue;
    }
    if (o.type === 'result') { meta.resultEvents++; idle = true; continue; }
    if (o.type === 'user' && o.message && !o.parent_tool_use_id) {
      const content = Array.isArray(o.message.content) ? o.message.content : [{ type: 'text', text: String(o.message.content || '') }];
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          const m = /running in background with ID: (\S+?)[.\s]/.exec(text);
          if (m && b.tool_use_id && !taskToTool.has(m[1])) taskToTool.set(m[1], b.tool_use_id);
        } else if (b.type === 'text' && /<task-notification>/.test(b.text || '')) {
          const g = (tag) => { const r = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(b.text); return r ? r[1].trim() : null; };
          pending.push({ taskId: g('task-id'), toolUseId: g('tool-use-id'), summary: g('summary') || '' });
        }
      }
      continue;
    }
    if (o.type !== 'assistant' || o.parent_tool_use_id || o.isSidechain || !o.message || !o.message.id) continue;
    const id = o.message.id;
    let turn = byMsg.get(id);
    if (!turn) {
      turn = { index: turns.length, id, tokens: 0, tools: [], notified: [], ci: false, prs: [] };
      if (idle && pending.length) turn.notified = pending.map((n) => ({ ...n }));
      pending = [];
      idle = false;
      turns.push(turn);
      byMsg.set(id, turn);
    }
    // A split message repeats its usage on each line: keep the largest, never add.
    turn.tokens = Math.max(turn.tokens, ctxTokens(o.message.usage));
    for (const b of Array.isArray(o.message.content) ? o.message.content : []) {
      if (!b || b.type !== 'tool_use' || toolUses.has(b.id)) continue;
      // Only shell tools and Monitor run commands. Other tools (Agent, Read, ...) are kept as
      // plain records and count only when they poll a CI background task (matched below).
      const rec = COMMAND_TOOLS.has(b.name)
        ? toolFrom(b.name, b.input, b.id)
        : { name: b.name, id: b.id, command: JSON.stringify(b.input || '').slice(0, 400), background: false, kinds: [], prs: [], watch: false };
      rec.turn = turn.index;
      toolUses.set(b.id, rec);
      turn.tools.push(rec);
    }
  }

  // Background tasks started by CI commands, and anything that polls them.
  const ciTaskIds = new Set();
  for (const [taskId, toolUseId] of taskToTool) {
    const rec = toolUses.get(toolUseId);
    if (rec && rec.kinds.length) ciTaskIds.add(taskId);
  }
  for (const t of turns) {
    for (const rec of t.tools) {
      if (COMMAND_TOOLS.has(rec.name)) continue;
      for (const id of ciTaskIds) if ((rec.command || '').includes(id)) { rec.kinds = ['poll-background-ci']; break; }
    }
    for (const n of t.notified) {
      const src = toolUses.get(n.toolUseId || taskToTool.get(n.taskId));
      n.ci = !!(src && src.kinds.length) || ciKinds(n.summary).length > 0;
      n.prs = src ? src.prs : [];
    }
    t.ci = t.tools.some((x) => x.kinds.length) || t.notified.some((n) => n.ci);
    t.prs = [...new Set([...t.tools.filter((x) => x.kinds.length).flatMap((x) => x.prs), ...t.notified.filter((n) => n.ci).flatMap((n) => n.prs)])];
  }
  return { turns, meta, ...summarize(turns), milestoneJson: lastMilestone(objs) };
}

function lastMilestone(objs) {
  let j = null;
  for (const o of objs) { const x = milestoneJsonInEvent(o); if (x) j = x; }
  return j;
}

// ---- Codex rollout ----
function codexTool(p) {
  if (p.type === 'function_call') return toolFrom(p.name || 'function_call', p.arguments, p.call_id);
  if (p.type === 'custom_tool_call') return toolFrom(p.name || 'custom_tool_call', p.input, p.call_id);
  if (p.type === 'local_shell_call') return toolFrom('local_shell', { command: p.action && p.action.command }, p.call_id);
  return null;
}

function parseCodexRollout(input) {
  const objs = toObjects(input);
  const turns = [];
  let pending = [];
  let lastTotal = null;
  const meta = { hooksActive: null, source: null, model: null, sessionId: null };
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    const p = o.payload || {};
    if (o.type === 'session_meta') { meta.source = p.source != null ? p.source : null; meta.sessionId = p.id || null; continue; }
    if (o.type === 'turn_context' && p.model) meta.model = meta.model || p.model;
    if (o.type === 'response_item') {
      const t = codexTool(p);
      if (t) pending.push(t);
      continue;
    }
    if (o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.last_token_usage) {
      // The same count can be emitted twice; a repeat has the same running total.
      const total = JSON.stringify(p.info.total_token_usage || p.info.last_token_usage);
      if (total === lastTotal) continue;
      lastTotal = total;
      const u = p.info.last_token_usage;
      // input_tokens already includes the cached part on Codex.
      const turn = { index: turns.length, id: `t${turns.length}`, tokens: u.input_tokens || 0, tools: pending, notified: [], ci: false, prs: [] };
      pending = [];
      turn.ci = turn.tools.some((x) => x.kinds.length);
      turn.prs = [...new Set(turn.tools.filter((x) => x.kinds.length).flatMap((x) => x.prs))];
      turns.push(turn);
    }
  }
  meta.hooksActive = hooksActiveIn(JSON.stringify(objs));
  return { turns, meta, ...summarize(turns), milestoneJson: lastMilestone(objs) };
}

// Is this rollout the Director's (not a subagent's)? A subagent's session_meta source
// is an object with a `subagent` key.
function isDirectorRollout(objs) {
  const meta = toObjects(objs).find((o) => o && o.type === 'session_meta');
  if (!meta) return false;
  const s = meta.payload && meta.payload.source;
  return !(s && typeof s === 'object' && ('subagent' in s));
}

module.exports = {
  CI_PATTERNS, codeView, isReconcileOnly, isBackgroundCommand, ciKinds, isWatch, prNumbers, commandOf, ctxTokens, toObjects,
  milestoneJsonIn, milestoneJsonInEvent, directorText, hooksActiveIn,
  summarize, parseClaudeStream, parseCodexRollout, isDirectorRollout,
};
