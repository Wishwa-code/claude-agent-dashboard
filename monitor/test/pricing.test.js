'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { priceFor, turnCost, SOURCE } = require('../lib/pricing');

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('opus 5.5 with 1h split (a real line from this machine)', () => {
  near(turnCost('claude-opus-5-5', { inp: 2, cw5: 0, cw1h: 25535, cr: 25459, out: 234 }),
    (2 * 4 + 25535 * 8 + 25459 * 0.20 + 234 * 20) / 1e6);
});

test('prefix: sonnet-5 vs sonnet-5-5', () => {
  assert.strictEqual(priceFor('claude-sonnet-5-5').cr, 0.10);
  assert.strictEqual(priceFor('claude-sonnet-5').cr, 0.20);
  assert.strictEqual(priceFor('claude-sonnet-5-5-20261001').cr, 0.10);
});

test('haiku tier by prompt size', () => {
  near(turnCost('claude-haiku-5-5', { inp: 100000, cw5: 0, cw1h: 0, cr: 0, out: 0 }), 100000 * 0.10 / 1e6);
  near(turnCost('claude-haiku-5-5', { inp: 100000, cw5: 0, cw1h: 0, cr: 1, out: 0 }), (100000 * 0.50 + 0.05) / 1e6);
});

test('unknown model has no price', () => {
  assert.strictEqual(priceFor('<synthetic>'), null);
  assert.strictEqual(turnCost('<synthetic>', { inp: 5, cw5: 0, cw1h: 0, cr: 0, out: 5 }), null);
});

test('source is cited with its date', () => {
  assert.strictEqual(SOURCE.read, '2026-10-29');
  assert.match(SOURCE.url, /^https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/pricing$/);
});
