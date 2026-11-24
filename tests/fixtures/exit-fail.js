// Fixture for tests/standalone-exit.test.js: one passing and one failing test, run alone.
'use strict';
const { test, assert } = require('../helpers');
test('passes', () => assert(true, 'x'));
test('fails', () => assert(false, 'deliberate'));
