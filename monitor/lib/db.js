// SQLite store for hook events (node:sqlite, built into Node 22; no npm packages). Modelled on CCAM's
// sessions / agents / events tables (reference/ccam-ARCHITECTURE.md "Database Design"), plus handoffs between sessions.
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, status TEXT, model TEXT,
  started_at TEXT, ended_at TEXT, updated_at TEXT, transcript_path TEXT);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, session_id TEXT, parent_agent_id TEXT, type TEXT,
  subagent_type TEXT, name TEXT, status TEXT, started_at TEXT, ended_at TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, session_id TEXT, agent_id TEXT, event_type TEXT,
  tool_name TEXT, summary TEXT, data TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS handoffs (id INTEGER PRIMARY KEY, from_name TEXT, to_name TEXT, kind TEXT, task_id TEXT,
  first_line TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_events_session_created ON events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
`;

const COLS = {
  sessions: ['id', 'name', 'cwd', 'status', 'model', 'started_at', 'ended_at', 'updated_at', 'transcript_path'],
  agents: ['id', 'session_id', 'parent_agent_id', 'type', 'subagent_type', 'name', 'status', 'started_at', 'ended_at'],
};

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);

  // Insert or update one row; only the fields given are changed, the rest keep their stored values.
  const upsert = (table, row) => {
    const cols = COLS[table].filter(c => row[c] !== undefined);
    const sets = cols.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(', ');
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
      ON CONFLICT(id) DO ${sets ? 'UPDATE SET ' + sets : 'NOTHING'}`).run(...cols.map(c => row[c]));
  };
  const insEvent = db.prepare(`INSERT INTO events (session_id, agent_id, event_type, tool_name, summary, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insHandoff = db.prepare(`INSERT INTO handoffs (from_name, to_name, kind, task_id, first_line, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);

  return {
    upsertSession: row => upsert('sessions', row),
    upsertAgent: row => upsert('agents', row),
    getSession: id => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id),
    getAgent: id => db.prepare('SELECT * FROM agents WHERE id = ?').get(id),
    insertEvent: r => Number(insEvent.run(r.session_id ?? null, r.agent_id ?? null, r.event_type ?? null,
      r.tool_name ?? null, r.summary ?? null, r.data ?? null, r.created_at ?? new Date().toISOString()).lastInsertRowid),
    insertHandoff: r => insHandoff.run(r.from_name ?? null, r.to_name ?? null, r.kind ?? null, r.task_id ?? null,
      r.first_line ?? null, r.created_at ?? new Date().toISOString()),
    recentEvents: (limit, sessionId) => sessionId
      ? db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(sessionId, limit)
      : db.prepare('SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?').all(limit),
    agentsOf: sessionId => db.prepare('SELECT * FROM agents WHERE session_id = ? ORDER BY started_at').all(sessionId),
    handoffsSince: ts => db.prepare('SELECT * FROM handoffs WHERE created_at >= ? ORDER BY created_at').all(ts),
    journalMode: () => db.prepare('PRAGMA journal_mode').get().journal_mode,
    close: () => db.close(),
  };
}

module.exports = { openDb };
