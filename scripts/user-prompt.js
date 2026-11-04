#!/usr/bin/env node
// UserPromptSubmit hook (Claude Code only). The user's reply ends a pause the
// Director logged while waiting on them (reason user or usage_limit), so the
// pause gets an exact end time. Writes nothing when no such pause is open.
'use strict';

const lib = require('./lib');
const { closeOpenPause } = require('./records');

if (require.main === module) {
  try {
    const input = lib.readStdin();
    if (input.hook_event_name === 'UserPromptSubmit') closeOpenPause(input, 'user_prompt', { reasons: ['user', 'usage_limit'] });
  } catch (err) {
    try { lib.appendJsonl({}, 'hook-errors.jsonl', { ts: new Date().toISOString(), hook: 'user-prompt', error: String(err && err.stack || err) }); } catch { /* ignore */ }
  }
  process.exit(0);
}
