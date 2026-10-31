// Codex stub handler: logs selected raw fields of delegation-related Codex hook
// events to <project>/.agent-team/logs/codex-events.jsonl. Never throws.
// Never logs tool_input.message (encrypted on Codex).
'use strict';

const lib = require('./lib');

const DELEGATION_TOOL = /spawn_agent$|^send_input$|^resume_agent$|^wait_agent$|^close_agent$/;
const MAX_MESSAGE = 2000;
const MAX_RESPONSE = 500;

function smallResponse(resp) {
  if (resp === undefined || resp === null) return null;
  try {
    const s = typeof resp === 'string' ? resp : JSON.stringify(resp);
    if (s.length <= MAX_RESPONSE) return resp;
    return s.slice(0, MAX_RESPONSE) + '...[truncated]';
  } catch {
    return null;
  }
}

function handle(input) {
  try {
    if (!input || typeof input !== 'object') return;
    const event = input.hook_event_name;
    const name = input.tool_name || '';
    const isTool = (event === 'PreToolUse' || event === 'PostToolUse') && DELEGATION_TOOL.test(name);
    if (!isTool && event !== 'SubagentStart' && event !== 'SubagentStop') return;
    const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.slice(0, MAX_MESSAGE) : null;
    const record = {
      ts: new Date().toISOString(),
      tool: 'codex',
      guidance_version: lib.guidanceVersion(),
      hook_event_name: event,
      tool_name: input.tool_name || null,
      session_id: input.session_id || null,
      turn_id: input.turn_id || null,
      model: input.model || null,
      agent_id: input.agent_id || null,
      agent_type: input.agent_type || null,
      task_name: ti.task_name || null,
      reasoning_effort: ti.reasoning_effort || null,
      tool_response: smallResponse(input.tool_response),
      last_assistant_message: last,
      transcript_path: input.transcript_path || null,
      agent_transcript_path: input.agent_transcript_path || null,
    };
    lib.appendJsonl(input, 'codex-events.jsonl', record);
  } catch { /* hooks must never break a session */ }
}

module.exports = { handle };
