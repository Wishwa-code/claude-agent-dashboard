// Agent monitor: a local dashboard showing how work flows between you and the Claude Code sessions in this project
// (2026-10-25).
//
//   node monitor/server.js     then open http://localhost:4020
//   PROJECT_DIR=/path/to/project node monitor/server.js     to watch another project (default: the Polek shop project)
//
// Reads ~/.claude/sessions/<pid>.json (live sessions: name, busy/idle) and the tail of each session's transcript in
// ~/.claude/projects/<project>/. Never reads the *.key files. Listens on 127.0.0.1 only.
//
// A "task" is one piece of work a session was given: a prompt from you, a "BROWSER TASK <id>" from another session,
// or any other free-form message from a session. Tool calls, replies and messages sent are steps of the current task.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const PORT = Number(process.env.PORT || 4020);
const PROJECT_DIR = path.resolve(process.env.PROJECT_DIR || path.join(os.homedir(), 'Desktop/shopify-shop-demo'));
const TRANSCRIPTS = path.join(os.homedir(), '.claude/projects', PROJECT_DIR.replace(/[^A-Za-z0-9]/g, '-'));
const SESSIONS = path.join(os.homedir(), '.claude/sessions');
const STATE = process.env.PIPELINE_STATE || path.join(os.homedir(), '.local/state/polek-dev'); // override only for testing
const BROWSER_AGENT_FILE = path.join(STATE, 'browser-agent');
const ROLES = ['intake', 'dispatcher', 'web-worker']; // registered by claude/scripts/pipeline/pipeline.py
const LEDGER = path.join(STATE, 'pipeline.jsonl');
const FIRST_READ = 24 * 1024 * 1024; // only the tail of a transcript is read on first sight (they reach 85 MB)
const MAX_EVENTS = 300;
const MAX_TASKS = 80;
const RECENT_HOURS = 24; // closed sessions stay listed this long after their last write
const BUCKET_MIN = 10, BUCKETS = 18; // activity strip: 18 x 10 min = last 3 hours

const cache = new Map(); // transcript path -> parsed state, read incrementally
const knownSocks = {}; // "uds:<socket>" -> session name, learnt from received messages (sockets of closed sessions)
const sentText = {}; // first 120 chars of a received message -> sender name (names closed sessions from their sends)
const colorSlot = {}; // session id -> categorical slot, fixed once given so a colour follows its session
let nextSlot = 0;

const { clip, taskName, humanise, toolSummary, toolLabel, toEvents } = require('./lib/transcript');

function newTask(c, e, name, from) {
  const t = { id: e.id, name, from, prompt: e.text, start: e.ts, end: e.ts, steps: 0, tools: {}, step: null,
    result: '', handoffs: [], replies: [] };
  c.tasks.push(t);
  if (c.tasks.length > MAX_TASKS) c.tasks.shift();
  return t;
}

// Fold an event into the session's task list.
function addToTasks(c, e) {
  if (e.kind === 'prompt') return newTask(c, e, taskName(e.text), 'you');
  if (e.kind === 'recv') {
    const task = /^BROWSER TASK\s+(\S+)/.exec(e.text);
    if (task) return newTask(c, e, humanise(task[1].replace(/:$/, '')), e.peer);
    const reply = /^BROWSER (RESULT|ACK|QUESTION)\s+(\S+)/.exec(e.text);
    if (!reply) return newTask(c, e, 'Message: ' + taskName(e.text), e.peer);
  }
  let t = c.tasks[c.tasks.length - 1];
  if (!t) t = newTask(c, { ...e, text: '' }, 'Earlier work (started before the monitor\'s window)', '?');
  t.end = e.ts || t.end;
  if (e.kind === 'recv') t.replies.push({ from: e.peer, ts: e.ts, text: clip(e.text, 300) });
  if (e.kind === 'spawn') { t.steps++; t.tools.Agent = (t.tools.Agent || 0) + 1; t.step = { tool: 'Agent', text: e.text, ts: e.ts }; }
  if (e.kind === 'tool' || e.kind === 'send') {
    t.steps++;
    const key = e.kind === 'send' ? 'SendMessage' : e.tool;
    t.tools[key] = (t.tools[key] || 0) + 1;
    t.step = { tool: e.kind === 'send' ? 'Message' : e.tool, text: e.kind === 'send' ? 'to ' + e.peer : e.text, ts: e.ts };
  }
  if (e.kind === 'send') {
    const h = /^BROWSER TASK\s+(\S+)/.exec(e.text);
    t.handoffs.push({ to: e.peer, ts: e.ts, name: h ? humanise(h[1].replace(/:$/, '')) : taskName(e.text) });
  }
  if (e.kind === 'say') t.result = e.text;
}

// Read new bytes of a transcript since last time.
function readTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let c = cache.get(file);
  if (!c || st.size < c.offset) {
    c = { offset: Math.max(0, st.size - FIRST_READ), events: [], sends: [], tasks: [], buckets: {}, spawns: {}, title: '', partial: '',
      skipFirst: st.size > FIRST_READ };
    cache.set(file, c);
  }
  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - c.offset);
    fs.readSync(fd, buf, 0, buf.length, c.offset);
    fs.closeSync(fd);
    c.offset = st.size;
    const lines = (c.partial + buf.toString('utf8')).split('\n');
    c.partial = lines.pop();
    if (c.skipFirst) { lines.shift(); c.skipFirst = false; } // first line after a seek is cut off
    for (const line of lines) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      for (const e of toEvents(o)) {
        if (e.kind === 'title') { c.title = e.text; continue; }
        if (e.kind === 'launched') { if (c.spawns[e.toolId]) c.spawns[e.toolId].agentId = e.agentId; continue; }
        if (e.kind === 'result') {
          const sp = c.spawns[e.toolId] || Object.values(c.spawns).find(x => e.agentId && x.agentId === e.agentId);
          if (sp && !sp.end) sp.end = e.ts;
          continue;
        }
        if (e.kind === 'spawn') c.spawns[e.toolId] = { id: e.toolId, name: e.text, model: e.model, start: e.ts, end: null };
        c.events.push(e);
        if (e.kind === 'send') c.sends.push(e); // kept apart: busy sessions push messages out of the event window
        addToTasks(c, e);
        if (e.ts) {
          const b = Math.floor(Date.parse(e.ts) / 60000 / BUCKET_MIN);
          c.buckets[b] = (c.buckets[b] || 0) + 1;
        }
        if (e.sock && e.peer !== e.sock) knownSocks[e.sock] = e.peer;
        if (e.kind === 'recv' && !e.peer.startsWith('uds:')) sentText[e.text.slice(0, 120)] = e.peer;
      }
    }
    if (c.events.length > MAX_EVENTS) c.events = c.events.slice(-MAX_EVENTS);
    if (c.sends.length > 200) c.sends = c.sends.slice(-200);
  }
  return { mtime: st.mtimeMs, ...c };
}

// Pipeline tasks from the ledger written by claude/scripts/pipeline/pipeline.py, newest first.
function readLedger(cutoff) {
  let rows = [];
  try { rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const tasks = {};
  for (const r of rows) {
    const t = tasks[r.id] || (tasks[r.id] = { id: r.id, title: '', planners: null, stages: [] });
    if (r.title) t.title = r.title;
    if (r.planners !== undefined) t.planners = r.planners;
    t.stages.push({ ts: r.ts, stage: r.stage, by: r.by, note: r.note || '' });
  }
  return Object.values(tasks).filter(t => Date.parse(t.stages[t.stages.length - 1].ts) >= cutoff)
    .sort((a, b) => b.stages[b.stages.length - 1].ts.localeCompare(a.stages[a.stages.length - 1].ts));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function liveSessions() {
  const out = [];
  for (const f of fs.readdirSync(SESSIONS)) {
    if (!/^\d+\.json$/.test(f)) continue; // skip *.key files
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'));
      if (s.cwd === PROJECT_DIR && alive(s.pid)) out.push(s);
    } catch { /* file being rewritten */ }
  }
  return out;
}

function snapshot() {
  const firstLine = f => { try { return fs.readFileSync(f, 'utf8').split('\n')[0].trim(); } catch { return ''; } };
  const roles = {};
  for (const r of ROLES) roles[r] = firstLine(path.join(STATE, 'roles', r));
  if (!roles['web-worker']) roles['web-worker'] = firstLine(BROWSER_AGENT_FILE);
  const browserAgent = roles['web-worker'];
  const live = liveSessions();
  const byId = new Map(live.map(s => [s.sessionId, s]));
  const found = [];
  const cutoff = Date.now() - RECENT_HOURS * 3600e3;
  for (const f of fs.readdirSync(TRANSCRIPTS)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    const s = byId.get(id);
    const file = path.join(TRANSCRIPTS, f);
    if (!s && fs.statSync(file).mtimeMs < cutoff) continue;
    const t = readTranscript(file);
    if (t) found.push({ id, s, t });
  }
  // Names are resolved only after every transcript was read, so names learnt anywhere apply everywhere.
  // A session gets a new name when VS Code restarts, and a closed session's name is gone. Its earlier names are
  // recovered from sessions that received its messages, and all of them map to its current name.
  for (const s of live) knownSocks['uds:' + s.messagingSocketPath] = s.name;
  const alias = {};
  for (const f of found) {
    const names = new Set(f.t.sends.map(e => sentText[e.text.slice(0, 120)]).filter(Boolean));
    f.name = f.s?.name || [...names].pop() || '(closed) ' + f.id.slice(0, 8);
    for (const n of names) alias[n] = f.name;
  }
  const peerName = p => {
    const n = p?.startsWith('uds:') ? knownSocks[p] || p : p;
    return alias[n] || n;
  };

  const today = ts => ts && Date.parse(ts) >= cutoff; // links cover the same 24 h as closed sessions
  const nowBucket = Math.floor(Date.now() / 60000 / BUCKET_MIN);
  const links = {};
  const link = (from, to, ts, label) => {
    const k = from + '\u0000' + to;
    const l = links[k] || (links[k] = { from, to, count: 0, last: '', label: '' });
    l.count++;
    if (!l.last || ts > l.last) { l.last = ts; l.label = label; }
  };

  const sessions = found.map(({ id, s, t, name }) => {
    if (colorSlot[id] === undefined) colorSlot[id] = nextSlot++ % 8;
    const status = s ? s.status || 'idle' : 'closed';
    const tasks = t.tasks.map(k => ({ ...k, from: peerName(k.from),
      handoffs: k.handoffs.map(h => ({ ...h, to: peerName(h.to) })) }));
    if (tasks.length) tasks[tasks.length - 1].running = status === 'busy';
    for (const k of tasks) if (k.from === 'you' && today(k.start)) link('you', name, k.start, k.name);
    for (const e of t.sends) if (today(e.ts)) {
      const h = /^BROWSER (TASK|RESULT|ACK|QUESTION)\s+(\S+)/.exec(e.text);
      link(name, peerName(e.peer), e.ts, h ? `${h[1].toLowerCase()} ${humanise(h[2].replace(/:$/, ''))}` : taskName(e.text));
    }
    return {
      id, name, live: !!s, status, pid: s?.pid, slot: colorSlot[id], browserAgent: !!s && s.name === browserAgent,
      role: s ? ROLES.find(r => roles[r] === name) || '' : '',
      spawns: Object.values(t.spawns).filter(sp => Date.parse(sp.start) >= Date.now() - 3 * 3600e3),
      title: t.title, updated: Math.max(t.mtime, s?.statusUpdatedAt || 0), statusSince: s?.statusUpdatedAt,
      activity: Array.from({ length: BUCKETS }, (_, i) => t.buckets[nowBucket - BUCKETS + 1 + i] || 0),
      tasks: tasks.slice(-40),
      events: t.events.slice(-150).map(({ sock, ...e }) => (e.peer ? { ...e, peer: peerName(e.peer) } : e)),
      sends: t.sends.filter(e => today(e.ts)).slice(-60).map(e => ({ ...e, peer: peerName(e.peer) })),
    };
  });
  sessions.sort((a, b) => (b.live - a.live) || (a.slot - b.slot)); // stable order, so boxes don't jump around
  return { now: Date.now(), browserAgent, roles, pipeline: readLedger(cutoff), bucketMin: BUCKET_MIN, sessions, links: Object.values(links) };
}

http.createServer((req, res) => {
  if (req.url === '/api/sessions') {
    try {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
    } catch (e) {
      res.writeHead(500); res.end(String(e.stack || e));
    }
  } else if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  } else {
    res.writeHead(404); res.end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Agent monitor on http://localhost:${PORT}`));
