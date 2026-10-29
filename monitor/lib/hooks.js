// Claude Code hook events (POSTed by HTTP hooks in the watched project's .claude/settings.json) → SQLite rows and
// live messages. Every payload carries session_id, transcript_path, cwd and hook_event_name; subagent events add
// agent_id and agent_type (https://code.claude.com/docs/en/hooks). Never throws: a bad payload is ignored.
'use strict';
const { clip, toolSummary } = require('./transcript');

const mainId = sid => `${sid}-main`;
// Keep what the tool was asked to do, never what it returned: tool output can hold file contents and secrets.
const stored = ({ tool_response, ...rest }) => rest;

function handleHook(db, p, now = new Date().toISOString()) {
  if (!p || typeof p !== 'object' || !p.session_id || !p.hook_event_name) return [];
  const msgs = [];
  const sid = p.session_id, ev = p.hook_event_name;
  const msg = (type, data) => msgs.push({ type, data, timestamp: now });

  const session = { id: sid, cwd: p.cwd, transcript_path: p.transcript_path, updated_at: now };
  if (ev === 'SessionStart') Object.assign(session, { status: 'active', started_at: now });
  if (ev === 'SessionEnd') Object.assign(session, { status: 'ended', ended_at: now });
  if (!db.getSession(sid)) { // first event from a session that started before the dashboard
    session.status = session.status || 'active';
    session.started_at = session.started_at || now;
  }
  db.upsertSession(session);
  if (!db.getAgent(mainId(sid))) db.upsertAgent({ id: mainId(sid), session_id: sid, type: 'main', status: 'waiting', started_at: now });
  msg('session_updated', db.getSession(sid));

  const setAgent = row => { db.upsertAgent(row); msg('agent_updated', db.getAgent(row.id)); };
  if (ev === 'UserPromptSubmit' || ev === 'PreToolUse') setAgent({ id: mainId(sid), status: 'working' });
  if (ev === 'Stop') setAgent({ id: mainId(sid), status: 'waiting' });
  if (ev === 'SessionEnd') setAgent({ id: mainId(sid), status: 'completed', ended_at: now });
  if (ev === 'SubagentStart' && p.agent_id) {
    setAgent({ id: p.agent_id, session_id: sid, parent_agent_id: mainId(sid), type: 'subagent',
      subagent_type: p.agent_type, status: 'working', started_at: now });
  }
  if (ev === 'SubagentStop' && p.agent_id) {
    setAgent({ id: p.agent_id, session_id: sid, parent_agent_id: mainId(sid), type: 'subagent',
      subagent_type: p.agent_type, status: 'completed', ended_at: now });
  }

  let summary = '';
  if (ev === 'UserPromptSubmit') summary = clip(p.prompt, 200);
  else if (p.tool_name) summary = clip(toolSummary(p.tool_name, p.tool_input || {}), 200);
  else if (ev === 'Notification') summary = clip(p.message, 200);
  const id = db.insertEvent({ session_id: sid, agent_id: p.agent_id || mainId(sid), event_type: ev,
    tool_name: p.tool_name || null, summary, data: JSON.stringify(stored(p)), created_at: now });
  msg('new_event', { id, session_id: sid, event_type: ev, tool_name: p.tool_name || null, summary, created_at: now });

  if (ev === 'PreToolUse' && p.tool_name === 'SendMessage' && p.tool_input?.to) {
    const first = String(p.tool_input.message ?? '').trim().split('\n')[0];
    const task = /\b(Q-\d+)\b/.exec(first)?.[1] || /^\S+\s+\S+\s+(\S+?):/.exec(first)?.[1] || null;
    db.insertHandoff({ from_name: sid, to_name: p.tool_input.to, kind: first.split(/\s/)[0] || 'message', task_id: task,
      first_line: clip(first, 200), created_at: now });
  }
  return msgs;
}

module.exports = { handleHook };
