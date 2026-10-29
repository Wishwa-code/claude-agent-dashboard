'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../lib/db');

test('db round trip', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'd.sqlite'));
  db.upsertSession({ id: 's1', name: 'a' });
  db.insertEvent({ session_id: 's1', event_type: 'PreToolUse', created_at: '2026-10-29T08:00:00Z' });
  db.insertEvent({ session_id: 's1', event_type: 'PostToolUse', created_at: '2026-10-29T08:00:01Z' });
  const ev = db.recentEvents(10, 's1');
  assert.strictEqual(ev.length, 2);
  assert.strictEqual(ev[0].event_type, 'PostToolUse');
  assert.strictEqual(db.journalMode(), 'wal');
  db.close();
});

test('upsertSession keeps fields it was not given', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'd.sqlite'));
  db.upsertSession({ id: 's1', name: 'a', cwd: '/p' });
  db.upsertSession({ id: 's1', status: 'ended' });
  const s = db.getSession('s1');
  assert.strictEqual(s.cwd, '/p');
  assert.strictEqual(s.status, 'ended');
  db.close();
});
