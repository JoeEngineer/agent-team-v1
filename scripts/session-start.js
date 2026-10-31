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
      }) + '\n', 'utf8');
    } catch { /* marker is best effort */ }
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `agent-team hooks: active (${tool}, ${version})`,
    },
  }));
} catch { /* never fail a session start */ }
process.exit(0);
