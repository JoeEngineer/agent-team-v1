#!/usr/bin/env node
// Tier -> model map: loader, resolvers and a small CLI. Node built-ins only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TIERS = ['small', 'medium', 'large', 'xlarge'];
const DEFAULT_PATH = path.join(__dirname, '..', 'config', 'models.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function isMap(m) {
  return m && typeof m === 'object' && !Array.isArray(m);
}

function loadMap({ env = process.env, home = os.homedir() } = {}) {
  const def = () => readJson(DEFAULT_PATH);
  const tryFile = (p, source) => {
    try {
      const map = readJson(p);
      if (!isMap(map)) throw new Error('top level must be an object');
      return { map, source, path: p };
    } catch (e) {
      return { map: def(), source: 'default', path: DEFAULT_PATH, error: `${p}: ${e.message}` };
    }
  };
  if (env.AGENT_TEAM_MODELS) {
    if (fs.existsSync(env.AGENT_TEAM_MODELS)) return tryFile(env.AGENT_TEAM_MODELS, 'env');
    return { map: def(), source: 'default', path: DEFAULT_PATH };
  }
  const userPath = path.join(home, '.agent-team', 'models.json');
  if (fs.existsSync(userPath)) return tryFile(userPath, 'user');
  return { map: def(), source: 'default', path: DEFAULT_PATH };
}

function entry(map, tool, tier) {
  const tierObj = map && map[tier];
  if (!TIERS.includes(tier) || !isMap(tierObj)) return null;
  let raw = tierObj[tool];
  if (typeof raw === 'string') raw = { model: raw };
  if (!isMap(raw) || typeof raw.model !== 'string' || !raw.model) return null;
  const billing = raw.billing || null;
  const enabled = tierObj.enabled !== false && raw.enabled !== false;
  const auto = tier !== 'xlarge' && enabled && billing !== 'credits';
  return { tier, model: raw.model, billing, enabled, auto };
}

function autoTier(map, tool, tier) {
  const e = entry(map, tool, tier);
  return e && e.auto ? e : null;
}

function ladderUp(map, tool, tier) {
  const i = TIERS.indexOf(tier);
  if (i < 0) return null;
  for (let j = i + 1; j < TIERS.length; j++) {
    const e = autoTier(map, tool, TIERS[j]);
    if (e) return e;
  }
  return null;
}

function fallbackDown(map, tool, tier) {
  const i = TIERS.indexOf(tier);
  for (let j = i - 1; j >= 0; j--) {
    const e = autoTier(map, tool, TIERS[j]);
    if (e) return e;
  }
  return null;
}

function tools(map) {
  const out = [];
  for (const t of TIERS) {
    if (!isMap(map && map[t])) continue;
    for (const k of Object.keys(map[t])) {
      if (k === 'enabled' || k.startsWith('_')) continue;
      if (!out.includes(k) && entry(map, k, t)) out.push(k);
    }
  }
  return out;
}

function modelToTier(map, tool, model) {
  if (typeof model !== 'string' || !model) return null;
  const m = model.toLowerCase();
  for (const t of TIERS) {
    const e = entry(map, tool, t);
    if (e && e.model.toLowerCase() === m) return t;
  }
  for (const t of TIERS) {
    const e = entry(map, tool, t);
    if (!e) continue;
    const alias = e.model.toLowerCase().replace(/[.\-]/g, '\\$&');
    if (new RegExp(`(^|-)${alias}(-|$)`).test(m)) return t;
  }
  return null;
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  let tool = 'claude';
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--tool') tool = rest[++i];
    else pos.push(rest[i]);
  }
  const loaded = loadMap();
  const base = { source: loaded.source, path: loaded.path };
  if (loaded.error) base.error = loaded.error;
  if (cmd === 'show') {
    const defMap = readJson(DEFAULT_PATH);
    const toolList = argv.includes('--tool') ? [tool] : tools(loaded.map);
    const tiers = {};
    for (const t of TIERS) {
      tiers[t] = {};
      for (const tl of toolList) {
        const e = entry(loaded.map, tl, t);
        if (!e) continue;
        const d = entry(defMap, tl, t);
        tiers[t][tl] = {
          model: e.model, billing: e.billing, enabled: e.enabled, auto: e.auto,
          differs_from_default: JSON.stringify(e) !== JSON.stringify(d),
        };
      }
    }
    console.log(JSON.stringify({ ...base, tiers }, null, 2));
    return 0;
  }
  if (cmd === 'resolve') {
    const tier = pos[0];
    if (!TIERS.includes(tier)) {
      console.error(`unknown tier "${tier}" (expected ${TIERS.join(', ')})`);
      return 1;
    }
    const e = entry(loaded.map, tool, tier);
    if (!e) {
      console.error(`tool "${tool}" has no ${tier} entry in the model map`);
      return 1;
    }
    console.log(JSON.stringify(e));
    return 0;
  }
  console.error('usage: models.js show [--tool t] | resolve <tier> [--tool t]');
  return 1;
}

module.exports = { TIERS, loadMap, entry, autoTier, ladderUp, fallbackDown, tools, modelToTier };

if (require.main === module) process.exitCode = cli(process.argv.slice(2));
