// Token usage from Claude Code transcripts (main sessions and their subagents), read incrementally.
//
// Each assistant message's `message.usage` is counted once per `message.id` (a streamed message is written on
// several lines with the same id). "Context" is input + cache read + cache creation of the latest turn: the
// amount the session re-sends on every turn. "cost" is the API-equivalent price of every turn (lib/pricing.js);
// turns of a model with no price add their tokens to "unpriced" instead.
'use strict';
const fs = require('fs');
const path = require('path');
const { turnCost } = require('./pricing');

const CHUNK = 8 * 1024 * 1024;
const WEIGHTS = { inp: 1, cw: 1.25, cr: 0.1, out: 5 }; // relative to the base input price

const inputEq = u => u.inp * WEIGHTS.inp + u.cw * WEIGHTS.cw + u.cr * WEIGHTS.cr + u.out * WEIGHTS.out;

function emptyState() {
  return { offset: 0, partial: '', seen: new Set(), byModel: {}, turns: 0, context: 0, lastTs: '', cost: 0, unpriced: 0 };
}

function addLine(st, line) {
  if (!line.includes('"usage"')) return; // cheap skip: most lines are tool results
  let o;
  try { o = JSON.parse(line); } catch { return; }
  const m = o.message;
  if (o.type !== 'assistant' || !m?.usage || st.seen.has(m.id)) return;
  st.seen.add(m.id);
  const u = m.usage;
  const row = { inp: u.input_tokens || 0, cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0,
    out: u.output_tokens || 0 };
  const t = st.byModel[m.model || '?'] || (st.byModel[m.model || '?'] = { inp: 0, cw: 0, cr: 0, out: 0 });
  for (const k in row) t[k] += row[k];
  // Cache writes split into 5 m and 1 h when the transcript says so; older lines have no split: all 5 m.
  const split = u.cache_creation || {};
  const cw1h = split.ephemeral_1h_input_tokens || 0;
  const cw5 = split.ephemeral_5m_input_tokens ?? row.cw - cw1h;
  const c = turnCost(m.model, { inp: row.inp, cw5, cw1h, cr: row.cr, out: row.out });
  if (c === null) st.unpriced += row.inp + row.cw + row.cr + row.out;
  else st.cost += c;
  st.turns++;
  st.context = row.inp + row.cw + row.cr;
  if (o.timestamp) st.lastTs = o.timestamp;
}

// Read the bytes added since `state.offset`. A file that shrank (rewritten) is read again from the start.
function readUsage(file, state) {
  let st = state || emptyState();
  let size;
  try { size = fs.statSync(file).size; } catch { return st; }
  if (size < st.offset) st = emptyState();
  if (size === st.offset) return st;
  const fd = fs.openSync(file, 'r');
  try {
    while (st.offset < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - st.offset));
      const n = fs.readSync(fd, buf, 0, buf.length, st.offset);
      if (!n) break;
      st.offset += n;
      const lines = (st.partial + buf.toString('utf8', 0, n)).split('\n');
      st.partial = lines.pop(); // a cut-off last line is finished on a later read
      for (const l of lines) if (l) addLine(st, l);
    }
  } finally { fs.closeSync(fd); }
  return st;
}

const total = byModel => Object.values(byModel).reduce((a, u) => {
  for (const k in a) a[k] += u[k];
  return a;
}, { inp: 0, cw: 0, cr: 0, out: 0 });

const cache = new Map(); // transcript path -> UsageState

// { [sessionId]: { main: UsageState, subagents: { [agentId]: UsageState & { description } } } }
function sessionUsage(projectDir, onlyIds) {
  const out = {};
  let files;
  try { files = fs.readdirSync(projectDir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    if (onlyIds && !onlyIds.has(id)) continue;
    const file = path.join(projectDir, f);
    const main = readUsage(file, cache.get(file));
    cache.set(file, main);
    const subagents = {};
    const subDir = path.join(projectDir, id, 'subagents');
    let subs = [];
    try { subs = fs.readdirSync(subDir); } catch { /* no subagents */ }
    for (const s of subs) {
      const m = /^agent-(.+)\.jsonl$/.exec(s);
      if (!m) continue;
      const sf = path.join(subDir, s);
      const st = readUsage(sf, cache.get(sf));
      cache.set(sf, st);
      if (st.description === undefined) {
        try { const meta = JSON.parse(fs.readFileSync(path.join(subDir, `agent-${m[1]}.meta.json`), 'utf8')); st.description = meta.description || ''; st.agentType = meta.agentType || ''; }
        catch { st.description = ''; st.agentType = ''; }
      }
      subagents[m[1]] = st;
    }
    out[id] = { main, subagents };
  }
  return out;
}

module.exports = { readUsage, inputEq, sessionUsage, total, WEIGHTS };
