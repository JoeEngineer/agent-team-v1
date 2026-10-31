'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert, eq, ROOT } = require('./helpers');
const { loadMap } = require('../scripts/models');

console.log('agents');

const agentsDir = path.join(ROOT, 'agents');
const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
const routing = fs.readFileSync(path.join(ROOT, 'skills', 'director', 'references', 'routing.md'), 'utf8');

function frontmatter(file) {
  const text = fs.readFileSync(path.join(agentsDir, file), 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

// Default map only: point the override at a path that does not exist.
const { map } = loadMap({ env: { AGENT_TEAM_MODELS: path.join(ROOT, 'no-such-models.json') }, home: path.join(ROOT, 'no-such-home') });
const claudeModel = tier => {
  const e = map[tier] && map[tier].claude;
  return e && typeof e === 'object' ? e.model : e;
};

test('there are agent files to check', () => {
  assert(agentFiles.length >= 5);
});

test('every agent has a tier in small|medium|large', () => {
  for (const f of agentFiles) {
    const t = frontmatter(f).tier;
    assert(['small', 'medium', 'large'].includes(t), `${f}: tier=${t}`);
  }
});

test("every agent's model: equals the default map's claude model for its tier", () => {
  for (const f of agentFiles) {
    const fm = frontmatter(f);
    assert(claudeModel(fm.tier), `${f}: no default claude model for ${fm.tier}`);
    eq(fm.model, claudeModel(fm.tier), f);
  }
});

test('routing.md names no model', () => {
  assert(!/haiku|sonnet|opus|fable|gpt-/i.test(routing));
});

test('routing.md table has a Tier column and no Model column', () => {
  const header = routing.split(/\r?\n/).find(l => /^\| Task type/.test(l));
  assert(header, 'table header not found');
  assert(/\| Tier \|/.test(header));
  assert(!/\| Model \|/.test(header));
});
