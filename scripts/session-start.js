#!/usr/bin/env node
// SessionStart hook: tells the model (and the user) that agent-team hooks are
// running, and leaves a marker file the Director can check as a fallback.
// Never throws; always exits 0.
'use strict';

const fs = require('fs');
const path = require('path');

try {
  const lib = require('./lib');
  const input = lib.readStdin();
  const tool = lib.detectTool(input);
  const version = lib.guidanceVersion();

  const root = path.join(lib.projectDir(input), '.agent-team');
  // Only write the marker where agent-team is already in use.
  if (fs.existsSync(root)) {
    try {
      const pending = path.join(root, 'logs', '.pending');
      fs.mkdirSync(pending, { recursive: true });
      fs.writeFileSync(path.join(pending, 'hooks-alive.json'), JSON.stringify({
        ts: new Date().toISOString(),
        tool,
        guidance_version: version,
        session_id: (input && input.session_id) || null,
        // The session's resolved model, when the tool passes it. log-event.js
        // uses it to fill decision lines (see sessionSettings there).
        model: (input && typeof input.model === 'string' && input.model) || null,
      }) + '\n', 'utf8');
    } catch { /* marker is best effort */ }
  }

  // On GitLab, tell the Director which CLI to use. GitHub stays the silent default.
  let forgeNote = '';
  try {
    if (require('./forge').detect(lib.projectDir(input)) === 'gitlab') {
      forgeNote = '\nagent-team forge: gitlab (use `glab`, not `gh`; see the Director\'s references/gitlab.md)';
    }
  } catch { /* detection is best effort */ }

  // After a compaction the Director's SKILL.md is re-attached, but the
  // reference files it had read are not (decision 0020). Say so, once, where
  // agent-team is in use.
  let compactNote = '';
  if (input && input.source === 'compact' && fs.existsSync(root)) {
    compactNote = '\nagent-team: context was compacted. If you are the Director, re-read STATUS.md and the references/ file for your next step (merging.md before any merge) before you act.';
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `agent-team hooks: active (${tool}, ${version})${forgeNote}${compactNote}`,
    },
  }));
} catch { /* never fail a session start */ }
process.exit(0);
