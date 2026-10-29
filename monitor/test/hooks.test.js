'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../lib/db');
const { handleHook } = require('../lib/hooks');

const freshDb = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hk-')), 'd.sqlite'));
const base = { session_id: 's1', cwd: '/p', transcript_path: '/p/s1.jsonl' };

test('SubagentStart then SubagentStop gives a completed child agent', () => {
  const db = freshDb();
  handleHook(db, { ...base, hook_event_name: 'SessionStart' });
  handleHook(db, { ...base, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'analyst' });
  let a = db.getAgent('a1');
  assert.strictEqual(a.status, 'working');
  assert.strictEqual(a.parent_agent_id, 's1-main');
  assert.strictEqual(a.subagent_type, 'analyst');
  const msgs = handleHook(db, { ...base, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'analyst' });
  a = db.getAgent('a1');
  assert.strictEqual(a.status, 'completed');
  assert.ok(a.ended_at);
  assert.ok(msgs.some(m => m.type === 'agent_updated'));
});

test('SendMessage PreToolUse records a handoff with the first line', () => {
  const db = freshDb();
  handleHook(db, { ...base, hook_event_name: 'PreToolUse', tool_name: 'SendMessage',
    tool_input: { to: 'shopify-shop-demo-07', message: 'BROWSER TASK Q-003: hero text\nWhere: ...' } });
  const h = db.handoffsSince('2000-01-01');
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].to_name, 'shopify-shop-demo-07');
  assert.strictEqual(h[0].first_line, 'BROWSER TASK Q-003: hero text');
  assert.strictEqual(h[0].task_id, 'Q-003');
});

test('tool events are stored with a summary and the full payload', () => {
  const db = freshDb();
  const msgs = handleHook(db, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'ls', description: 'List files' } });
  const ev = db.recentEvents(5, 's1')[0];
  assert.strictEqual(ev.tool_name, 'Bash');
  assert.strictEqual(ev.summary, 'List files');
  assert.strictEqual(JSON.parse(ev.data).tool_input.command, 'ls');
  assert.ok(msgs.some(m => m.type === 'new_event'));
});

test('Stop sets the main agent waiting and SessionEnd ends the session', () => {
  const db = freshDb();
  handleHook(db, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  assert.strictEqual(db.getAgent('s1-main').status, 'working');
  handleHook(db, { ...base, hook_event_name: 'Stop' });
  assert.strictEqual(db.getAgent('s1-main').status, 'waiting');
  handleHook(db, { ...base, hook_event_name: 'SessionEnd' });
  assert.strictEqual(db.getSession('s1').status, 'ended');
});

test('bad payload does not throw', () => {
  const db = freshDb();
  assert.deepStrictEqual(handleHook(db, {}), []);
  assert.deepStrictEqual(handleHook(db, null), []);
});
