// Keeps the root plugin.json (Agent Plugins schema, read by Codex) in sync with
// the Claude Code manifests under .claude-plugin/. Node built-ins only.
'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert, eq, ROOT } = require('./helpers');

// Top-level keys the Agent Plugins 1.0.0 schema allows (additionalProperties: false).
const ALLOWED_KEYS = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
const ALLOWED_AUTHOR_KEYS = ['name', 'email', 'url'];
const SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
// Name pattern and length limit from the schema.
const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

console.log('manifest');

test('plugin.json, .claude-plugin/plugin.json and marketplace.json parse as JSON', () => {
  for (const rel of ['plugin.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
    const value = readJson(rel);
    assert(value && typeof value === 'object', `${rel} did not parse to an object`);
  }
});

test('root plugin.json name and version match .claude-plugin/plugin.json', () => {
  const root = readJson('plugin.json');
  const claude = readJson('.claude-plugin/plugin.json');
  eq(root.name, claude.name, 'name');
  eq(root.version, claude.version, 'version');
});

test('root plugin.json has the exact Agent Plugins $schema', () => {
  eq(readJson('plugin.json').$schema, SCHEMA_ID, '$schema');
});

test('root plugin.json has no keys outside the schema allow-list', () => {
  const extra = Object.keys(readJson('plugin.json')).filter((k) => !ALLOWED_KEYS.includes(k));
  eq(JSON.stringify(extra), '[]', 'keys not allowed by the schema');
});

test('root plugin.json author has only schema-allowed fields', () => {
  const author = readJson('plugin.json').author;
  assert(author && typeof author === 'object', 'author must be an object');
  const extra = Object.keys(author).filter((k) => !ALLOWED_AUTHOR_KEYS.includes(k));
  eq(JSON.stringify(extra), '[]', 'author keys not allowed by the schema');
  assert(typeof author.name === 'string' && author.name.length > 0, 'author.name must be a non-empty string');
});

test('root plugin.json name matches the schema name pattern and length', () => {
  const name = readJson('plugin.json').name;
  assert(name.length >= 1 && name.length <= 64, `name length ${name.length} outside 1..64`);
  assert(NAME_PATTERN.test(name), `name "${name}" does not match the schema pattern`);
});

test('marketplace.json lists a plugin whose name equals the manifest name', () => {
  const name = readJson('plugin.json').name;
  const plugins = readJson('.claude-plugin/marketplace.json').plugins || [];
  const match = plugins.find((p) => p.name === name);
  assert(match, `no plugin named "${name}" in .claude-plugin/marketplace.json`);
});
