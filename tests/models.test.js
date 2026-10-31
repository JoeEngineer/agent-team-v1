'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, assert, eq: strictEq, ROOT, SCRIPTS } = require('./helpers');
// Deep-equal via JSON (key order matters; fine for these shapes).
const eq = (a, b, msg) => strictEq(JSON.stringify(a), JSON.stringify(b), msg);
const M = require(path.join(SCRIPTS, 'models.js'));

console.log('models');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-models-'));
const DEF = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'models.json'), 'utf8'));
const MISSING = path.join(tmp(), 'nope.json');

test('shorthand and object entries normalise the same', () => {
  const a = { small: { claude: 'haiku' } };
  const b = { small: { claude: { model: 'haiku' } } };
  eq(M.entry(a, 'claude', 'small'), { tier: 'small', model: 'haiku', billing: null, enabled: true, auto: true });
  eq(M.entry(a, 'claude', 'small'), M.entry(b, 'claude', 'small'));
});

test('default models resolve for each tool and standard tier', () => {
  const want = { claude: ['haiku', 'sonnet', 'opus'], codex: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'] };
  for (const tool of Object.keys(want)) {
    ['small', 'medium', 'large'].forEach((t, i) => eq(M.autoTier(DEF, tool, t).model, want[tool][i]));
  }
  const x = M.entry(DEF, 'claude', 'xlarge');
  eq([x.model, x.billing, x.enabled, x.auto], ['fable', 'credits', false, false]);
  eq(M.entry(DEF, 'codex', 'xlarge').model, 'gpt-6-astra');
});

test('xlarge never auto, even when enabled', () => {
  const m = { large: { claude: 'opus' }, xlarge: { enabled: true, claude: 'fable' } };
  eq(M.entry(m, 'claude', 'xlarge').enabled, true);
  eq(M.autoTier(m, 'claude', 'xlarge'), null);
  eq(M.ladderUp(m, 'claude', 'large'), null);
  eq(M.ladderUp(m, 'claude', 'small').tier, 'large');
});

test('disabled or credits standard tiers are not auto and are skipped', () => {
  const m = {
    small: { claude: 'haiku' },
    medium: { claude: { model: 'sonnet', enabled: false } },
    large: { claude: { model: 'opus', billing: 'credits' } },
  };
  eq(M.autoTier(m, 'claude', 'medium'), null);
  eq(M.autoTier(m, 'claude', 'large'), null);
  eq(M.ladderUp(m, 'claude', 'small'), null);
  const t = { small: { claude: 'haiku' }, medium: { enabled: false, claude: 'sonnet' }, large: { claude: 'opus' } };
  eq(M.autoTier(t, 'claude', 'medium'), null);
  eq(M.ladderUp(t, 'claude', 'small').tier, 'large');
  eq(M.fallbackDown(t, 'claude', 'large').tier, 'small');
});

test('ladderUp(large) is null on defaults', () => {
  eq(M.ladderUp(DEF, 'claude', 'large'), null);
  eq(M.ladderUp(DEF, 'codex', 'medium').model, 'gpt-6.1-sol');
});

test('fallbackDown goes one lower, null at small, never higher', () => {
  eq(M.fallbackDown(DEF, 'claude', 'large').tier, 'medium');
  eq(M.fallbackDown(DEF, 'claude', 'medium').tier, 'small');
  eq(M.fallbackDown(DEF, 'claude', 'small'), null);
  eq(M.fallbackDown(DEF, 'claude', 'xlarge').tier, 'large');
  const gap = { medium: { claude: 'sonnet' }, large: { claude: 'opus' } };
  eq(M.fallbackDown(gap, 'claude', 'medium'), null);
});

test('tool with no entries is absent', () => {
  const m = { small: { claude: 'haiku' }, medium: { claude: 'sonnet' } };
  eq(M.tools(m), ['claude']);
  eq(M.entry(m, 'codex', 'small'), null);
  eq(M.tools(DEF).sort(), ['claude', 'codex']);
});

test('override order env, user, default; override replaces whole map', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.agent-team'));
  const userFile = path.join(home, '.agent-team', 'models.json');
  fs.writeFileSync(userFile, JSON.stringify({ small: { claude: 'user-small' } }));
  const envFile = path.join(tmp(), 'm.json');
  fs.writeFileSync(envFile, JSON.stringify({ small: { claude: 'env-small' } }));

  let r = M.loadMap({ env: { AGENT_TEAM_MODELS: envFile }, home });
  eq([r.source, r.path, r.map.small.claude], ['env', envFile, 'env-small']);
  r = M.loadMap({ env: {}, home });
  eq([r.source, r.map.small.claude], ['user', 'user-small']);
  eq(M.entry(r.map, 'claude', 'medium'), null);
  eq(M.entry(r.map, 'codex', 'small'), null);
  r = M.loadMap({ env: {}, home: tmp() });
  eq(r.source, 'default');
  eq(r.error, undefined);
  eq(M.entry(r.map, 'claude', 'medium').model, 'sonnet');
});

test('AGENT_TEAM_MODELS pointing at a missing file uses default and skips user file', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.agent-team'));
  fs.writeFileSync(path.join(home, '.agent-team', 'models.json'), JSON.stringify({ small: { claude: 'user-small' } }));
  const r = M.loadMap({ env: { AGENT_TEAM_MODELS: MISSING }, home });
  eq(r.source, 'default');
  eq(r.error, undefined);
  eq(r.map.small.claude, 'haiku');
});

test('invalid override gives default plus error, no throw', () => {
  const bad = path.join(tmp(), 'bad.json');
  fs.writeFileSync(bad, '{not json');
  let r = M.loadMap({ env: { AGENT_TEAM_MODELS: bad }, home: tmp() });
  eq(r.source, 'default');
  assert(r.error && r.error.includes(bad), 'error reported');
  eq(r.map.small.claude, 'haiku');
  const home = tmp();
  fs.mkdirSync(path.join(home, '.agent-team'));
  fs.writeFileSync(path.join(home, '.agent-team', 'models.json'), '[1]');
  r = M.loadMap({ env: {}, home });
  eq(r.source, 'default');
  assert(r.error, 'non-object reported');
});

test('modelToTier: alias, full id, unknown', () => {
  eq(M.modelToTier(DEF, 'claude', 'sonnet'), 'medium');
  eq(M.modelToTier(DEF, 'claude', 'claude-sonnet-5-5'), 'medium');
  eq(M.modelToTier(DEF, 'claude', 'claude-opus-4'), 'large');
  eq(M.modelToTier(DEF, 'codex', 'gpt-6.1-terra-2026'), 'medium');
  eq(M.modelToTier(DEF, 'codex', 'gpt-6-luna'), 'small');
  eq(M.modelToTier(DEF, 'claude', 'mystery'), null);
  eq(M.modelToTier(DEF, 'claude', 'sonnetx'), null);
  eq(M.modelToTier(DEF, 'claude', ''), null);
  eq(M.modelToTier(DEF, 'nobody', 'sonnet'), null);
});

const cli = (args, envFile = MISSING) => spawnSync('node', [path.join(SCRIPTS, 'models.js'), ...args], {
  encoding: 'utf8', env: { ...process.env, AGENT_TEAM_MODELS: envFile },
});

test('CLI show reports tiers and differs_from_default', () => {
  const r = cli(['show']);
  eq(r.status, 0);
  let j = JSON.parse(r.stdout);
  eq(j.source, 'default');
  eq(j.tiers.medium.claude, { model: 'sonnet', billing: null, enabled: true, auto: true, differs_from_default: false });
  eq(j.tiers.xlarge.claude.auto, false);
  const f = path.join(tmp(), 'o.json');
  fs.writeFileSync(f, JSON.stringify({ small: { claude: 'x' } }));
  j = JSON.parse(cli(['show', '--tool', 'claude'], f).stdout);
  eq(j.source, 'env');
  eq(j.tiers.small.claude.differs_from_default, true);
  eq(j.tiers.medium.claude, undefined);
  eq(j.tiers.small.codex, undefined);
});

test('CLI resolve succeeds and fails with exit 1', () => {
  let r = cli(['resolve', 'large', '--tool', 'codex']);
  eq(r.status, 0);
  eq(JSON.parse(r.stdout).model, 'gpt-6.1-sol');
  eq(JSON.parse(cli(['resolve', 'small']).stdout).model, 'haiku');
  r = cli(['resolve', 'huge']);
  eq(r.status, 1);
  assert(r.stderr.includes('unknown tier'), 'unknown tier message');
  r = cli(['resolve', 'small', '--tool', 'gemini']);
  eq(r.status, 1);
  assert(r.stderr.includes('gemini'), 'tool message');
});
