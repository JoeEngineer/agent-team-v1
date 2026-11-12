'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lib = require('../src/index.js');

test('index loads and is an object', () => {
  assert.strictEqual(typeof lib, 'object');
});
