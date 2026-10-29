'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stageSegments } = require('../lib/pipeline');

const at = hm => `2026-10-29T${hm}:00+05:30`;
const task = (rows, stage) => ({ stage, stages: rows.map(([hm, st]) => ({ ts: at(hm), stage: st })) });

test('stageSegments maps groups and joins rows', () => {
  const t = task([['10:00', 'queued'], ['10:01', 'in-cloud'], ['10:05', 'awaiting-approval'], ['10:07', 'ready'],
    ['10:08', 'with-browser'], ['10:12', 'browser-done'], ['10:12', 'done']], 'done');
  const segs = stageSegments(t, Date.parse(at('11:00')));
  assert.deepStrictEqual(segs.map(s => s.group), ['queued', 'analysing', 'waiting', 'ready', 'browser', 'browser', 'done']);
  assert.strictEqual(segs[0].end - segs[0].start, 60000);
  const last = segs[segs.length - 1];
  assert.strictEqual(last.end, last.start); // a closed task's last stage is a marker, not a bar to "now"
});

test('stageSegments open task ends at now', () => {
  const now = Date.parse(at('10:05'));
  const segs = stageSegments(task([['10:00', 'queued']], 'queued'), now);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].end - segs[0].start, 300000);
});

test('stageSegments: stopped stages and a clock behind the ledger never go negative', () => {
  const segs = stageSegments(task([['10:00', 'queued'], ['10:03', 'blocked']], 'blocked'), Date.parse(at('09:00')));
  assert.deepStrictEqual(segs.map(s => s.group), ['queued', 'stopped']);
  for (const s of segs) assert.ok(s.end >= s.start);
});
