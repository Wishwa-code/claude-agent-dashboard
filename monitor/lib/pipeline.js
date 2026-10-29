// The Polek task queue as the dashboard sees it. The source of truth is pipeline.jsonl plus the task folders, written by
// shopify-shop-demo/claude/scripts/pipeline/pipeline.py. The dashboard only reads them, and records answers through
// that same script so the first-answer-wins rule lives in one place.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PIPELINE_PY = process.env.PIPELINE_PY ||
  path.join(os.homedir(), 'Desktop/shopify-shop-demo/claude/scripts/pipeline/pipeline.py');
const FILES = ['request', 'workorder', 'reply', 'result'];
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

function readRows(stateDir) {
  try {
    return fs.readFileSync(path.join(stateDir, 'pipeline.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Tasks with stage history, where they run (cloud, or local and why), the agent on it, the open question and the answer; newest activity first.
function readTasks(stateDir) {
  const tasks = {};
  for (const r of readRows(stateDir)) {
    if (!r.id) continue;
    const t = tasks[r.id] || (tasks[r.id] = { id: r.id, title: '', stage: null, stages: [], agent: null, last: r.ts,
      planners: null, runsOn: null, reason: null, cloudUrl: null, cloudLanded: false });
    if (r.title) t.title = r.title;
    if (r.planners !== undefined) t.planners = r.planners;
    if (r.stage) { t.stage = r.stage; t.stages.push({ ts: r.ts, stage: r.stage, by: r.by, note: r.note || '' }); }
    if (r.event === 'assign') t.agent = r.agent;
    if (r.event === 'place') { t.runsOn = r.runs_on; t.reason = r.reason || null; } // cloud first; local needs a reason
    if (r.event === 'cloud-session' && /^https:\/\/claude\.ai\/code\//.test(r.url || '')) t.cloudUrl = r.url;
    if (r.event === 'cloud-landed') t.cloudLanded = true;
    if (r.ts > t.last) t.last = r.ts;
  }
  for (const t of Object.values(tasks)) {
    const dir = path.join(stateDir, 'tasks', t.id);
    const qs = readJson(path.join(dir, 'questions.json'));
    t.questions = Array.isArray(qs) ? qs.map(q => q.q) : []; // open questions; answered ones move into answer.json
    t.question = t.questions.length ? t.questions[t.questions.length - 1] : null;
    t.answer = readJson(path.join(dir, 'answer.json'));
    t.files = {};
    for (const f of FILES) if (fs.existsSync(path.join(dir, f + '.md'))) t.files[f] = true;
  }
  return Object.values(tasks).sort((a, b) => String(b.last).localeCompare(String(a.last)));
}

// One of the task's own files (request, workorder, result), or null. Ids and names are checked, so no path escapes.
function taskFile(stateDir, id, name) {
  if (!ID.test(id) || !FILES.includes(name)) return null;
  try { return fs.readFileSync(path.join(stateDir, 'tasks', id, name + '.md'), 'utf8'); } catch { return null; }
}

// Record the user's answer from the dashboard. Resolves {ok, message}; ok is false when chat answered first.
function answerTask(stateDir, id, value) {
  return new Promise(resolve => {
    if (!ID.test(id)) return resolve({ ok: false, message: 'bad task id' });
    const v = String(value ?? '').trim();
    if (!v) return resolve({ ok: false, message: 'empty answer' });
    execFile('python3', [PIPELINE_PY, 'answer', id, '--by', 'dashboard', '--', v], // "--": an answer like "--help" stays an answer
      { env: { ...process.env, PIPELINE_STATE: stateDir }, timeout: 10000 }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (!err) return resolve({ ok: true, message: out });
        resolve({ ok: false, message: out || String(stderr || err.message).trim() });
      });
  });
}

module.exports = { readRows, readTasks, taskFile, answerTask, PIPELINE_PY };
