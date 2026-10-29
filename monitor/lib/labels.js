// Human names for dashboard boxes (2026-10-29): "Queue <n>" from the queue registry, "Browser agent" from its role
// file, otherwise "Session <k>". Claude Code's own names (shopify-shop-demo-47) change when VS Code restarts, so they
// only show underneath, in small text. Session numbers are kept in a file, so a dashboard restart doesn't renumber, and
// start again from 1 each local day.
'use strict';
const fs = require('fs');
const path = require('path');

// queues.json, written by pipeline.py queue-start: [{n, session, name, started, last_seen, ended}].
function readQueues(stateDir) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(stateDir, 'queues.json'), 'utf8'));
    return Array.isArray(q) ? q : [];
  } catch { return []; }
}

const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function createLabeller(file, now = () => new Date()) {
  let st = null;
  const load = () => {
    const today = localDay(now());
    if (st?.day === today) return st;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    st = saved?.day === today && saved.ids ? saved : { day: today, next: 1, ids: {} };
    return st;
  };
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(st));
      fs.renameSync(file + '.tmp', file);
    } catch { /* numbers then only last until restart */ }
  };
  return {
    label(session, { queues = [], browserAgentName = '', legacyQueueName = '' } = {}) {
      const q = queues.find(x => x.session === session.id);
      if (q) return { label: `Queue ${q.n}`, kind: 'queue', queue: q.n };
      if (legacyQueueName && session.name === legacyQueueName) return { label: 'Queue', kind: 'queue', queue: null }; // before numbered queues
      if (browserAgentName && session.name === browserAgentName) return { label: 'Browser agent', kind: 'browser' };
      const s = load();
      if (!s.ids[session.id]) { s.ids[session.id] = s.next++; save(); }
      return { label: `Session ${s.ids[session.id]}`, kind: 'session' };
    },
  };
}

module.exports = { readQueues, createLabeller };
