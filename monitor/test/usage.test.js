'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readUsage, inputEq, sessionUsage } = require('../lib/usage');

const MODEL = 'claude-opus-5-5';
const line = (id, u) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-29T08:00:00Z',
  message: { id, model: MODEL, usage: u, content: [] } }) + '\n';

test('usage dedupes by message id and resumes after partial line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const file = path.join(dir, 's.jsonl');
  const u1 = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 2 };
  const third = line('m2', { input_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 1 });
  fs.writeFileSync(file, line('m1', u1) + line('m1', u1) + third.slice(0, 30));
  let st = readUsage(file);
  assert.strictEqual(st.turns, 1);
  assert.strictEqual(st.byModel[MODEL].inp, 10);
  assert.strictEqual(st.context, 115);
  fs.appendFileSync(file, third.slice(30));
  st = readUsage(file, st);
  assert.strictEqual(st.turns, 2);
  assert.strictEqual(st.context, 220);
  assert.strictEqual(st.byModel[MODEL].cr, 300);
});

test('inputEq weights', () => {
  assert.strictEqual(inputEq({ inp: 100, cw: 100, cr: 100, out: 100 }), 100 + 125 + 10 + 500);
});

test('sessionUsage reads main and subagent transcripts with descriptions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  fs.writeFileSync(path.join(dir, 'abc.jsonl'), line('a1', { input_tokens: 1, output_tokens: 1 }));
  fs.mkdirSync(path.join(dir, 'abc', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'abc', 'subagents', 'agent-x1.jsonl'), line('b1', { input_tokens: 7, output_tokens: 1 }));
  fs.writeFileSync(path.join(dir, 'abc', 'subagents', 'agent-x1.meta.json'), JSON.stringify({ description: 'Analyst Q-003' }));
  const all = sessionUsage(dir);
  assert.strictEqual(all.abc.main.turns, 1);
  assert.strictEqual(all.abc.subagents['x1'].description, 'Analyst Q-003');
  assert.strictEqual(all.abc.subagents['x1'].byModel[MODEL].inp, 7);
});

test('pricing: missing split and unknown model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const file = path.join(dir, 's.jsonl');
  const synth = JSON.stringify({ type: 'assistant', message: { id: 's1', model: '<synthetic>', usage: { input_tokens: 3, output_tokens: 4 } } }) + '\n';
  fs.writeFileSync(file, line('m1', { input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 0 }) + synth);
  const st = readUsage(file);
  assert.ok(Math.abs(st.cost - 1000 * 5 / 1e6) < 1e-12, String(st.cost)); // no cache_creation split: 5 m rate
  assert.strictEqual(st.unpriced, 7);
  assert.strictEqual(st.byModel[MODEL].cw, 1000);
});

test('pricing: 1h cache writes at their own rate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, line('m1', { input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } }));
  assert.ok(Math.abs(readUsage(file).cost - 1000 * 8 / 1e6) < 1e-12);
});
