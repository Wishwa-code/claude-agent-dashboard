'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLabeller, readQueues } = require('../lib/labels');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'labels-'));
const day = d => () => new Date(`2026-10-${d}T10:00:00`);
const queues = [{ n: 1, session: 'q1', name: 'tab-1' }, { n: 2, session: 'q2', name: 'tab-2' }];

test('readQueues reads the registry, empty when missing', () => {
  const dir = tmp();
  assert.deepStrictEqual(readQueues(dir), []);
  fs.writeFileSync(path.join(dir, 'queues.json'), JSON.stringify(queues));
  assert.strictEqual(readQueues(dir)[1].n, 2);
});

test('queue label from registry', () => {
  const l = createLabeller(path.join(tmp(), 'labels.json'), day(29));
  assert.deepStrictEqual(l.label({ id: 'q2', name: 'tab-2' }, { queues, browserAgentName: 'b' }),
    { label: 'Queue 2', kind: 'queue', queue: 2 });
});

test('browser agent by name', () => {
  const l = createLabeller(path.join(tmp(), 'labels.json'), day(29));
  assert.deepStrictEqual(l.label({ id: 'x', name: 'tab-b' }, { queues, browserAgentName: 'tab-b' }),
    { label: 'Browser agent', kind: 'browser' });
});

test('session numbers are stable and persisted', () => {
  const file = path.join(tmp(), 'labels.json');
  const ctx = { queues: [], browserAgentName: '' };
  const l = createLabeller(file, day(29));
  assert.strictEqual(l.label({ id: 'a', name: 'n-a' }, ctx).label, 'Session 1');
  assert.strictEqual(l.label({ id: 'b', name: 'n-b' }, ctx).label, 'Session 2');
  assert.strictEqual(l.label({ id: 'a', name: 'n-a' }, ctx).label, 'Session 1');
  const again = createLabeller(file, day(29));
  assert.strictEqual(again.label({ id: 'b', name: 'n-b' }, ctx).label, 'Session 2');
  assert.strictEqual(again.label({ id: 'c', name: 'n-c' }, ctx).label, 'Session 3');
});

test('numbers reset at local midnight', () => {
  const file = path.join(tmp(), 'labels.json');
  const ctx = { queues: [], browserAgentName: '' };
  createLabeller(file, day(29)).label({ id: 'a', name: 'n-a' }, ctx);
  const next = createLabeller(file, day(30));
  assert.strictEqual(next.label({ id: 'z', name: 'n-z' }, ctx).label, 'Session 1');
});
