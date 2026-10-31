#!/usr/bin/env node
// Unit checks for the pure helpers in codex-live.js; needs no Codex. Not loaded by tests/run.js.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./codex-live.js');

// exit code: known failures excluded; real failures still count
assert.strictEqual(h.exitCode([]), 0);
assert.strictEqual(h.exitCode([{ ok: true }, { ok: false, known: true }]), 0);
assert.strictEqual(h.exitCode([{ ok: false, known: true }, { ok: false, known: false }]), 1);
assert.strictEqual(h.exitCode([{ ok: false }]), 1);
assert.strictEqual(h.label({ ok: true, known: true }), 'PASS');
assert.strictEqual(h.label({ ok: false, known: true }), 'KNOWN-LIMITATION');
assert.strictEqual(h.label({ ok: false }), 'FAIL');

// version pick
assert.strictEqual(h.pickVersion(['0.2.1', '0.10.0', '0.3.0']), '0.10.0');
assert.strictEqual(h.pickVersion(['0.2.1', '0.10.0'], '0.2.1'), '0.2.1');
assert.strictEqual(h.pickVersion(['0.2.1'], '9.9.9'), '0.2.1');
assert.strictEqual(h.pickVersion([]), null);

// cleanup scoping: refuses anything that is not <base>/<digits>
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cxcheck-'));
const outsider = path.join(base, 'keepme'); fs.mkdirSync(outsider);
assert.strictEqual(h.cleanupTemp(outsider, base), false);          // wrong name
assert.strictEqual(h.cleanupTemp(base, base), false);              // base itself
assert.strictEqual(h.cleanupTemp(path.join(base, '123', '..'), base), false);
assert.ok(fs.existsSync(outsider));
const mine = path.join(base, '4242'); fs.mkdirSync(path.join(mine, 'h'), { recursive: true });
fs.writeFileSync(path.join(mine, 'h', 'auth.json'), 'secret');
assert.strictEqual(h.cleanupTemp(mine, base), true);
assert.ok(!fs.existsSync(mine));                                   // auth.json gone with it
assert.ok(fs.existsSync(outsider));                                // sibling untouched
fs.mkdirSync(mine);                                                // idempotent: second call is a no-op
assert.strictEqual(h.cleanupTemp(mine, base), false);
assert.ok(fs.existsSync(mine));
fs.rmSync(base, { recursive: true, force: true });
console.log('helpers-check: ok');
