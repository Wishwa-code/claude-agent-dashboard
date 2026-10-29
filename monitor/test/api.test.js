'use strict';
// Starts the real server on a random port against temporary state, and talks to it over HTTP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PIPELINE_PY = process.env.PIPELINE_PY ||
  path.join(os.homedir(), 'Desktop/shopify-shop-demo/claude/scripts/pipeline/pipeline.py');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'api-state-'));
const port = 4100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
let server, token;

const pl = (...args) => execFileSync('python3', [PIPELINE_PY, ...args], { env: { ...process.env, PIPELINE_STATE: state } }).toString().trim();

test.before(async () => {
  pl('new', 'Hero text');
  pl('ask', 'Q-001', '--question', 'Use custom CSS for the hero?');
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), PIPELINE_STATE: state, PIPELINE_PY,
      DASHBOARD_DB: path.join(state, 'd.sqlite'), PROJECT_DIR: state }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const html = await (await fetch(base + '/')).text(); token = /name="dash-token" content="([^"]+)"/.exec(html)?.[1]; break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
});
test.after(() => server.kill());

const answer = (value, headers = {}, tok = token) => fetch(`${base}/api/tasks/Q-001/answer`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${port}`, ...headers },
  body: JSON.stringify({ value, token: tok }) });
const answerFile = path.join(state, 'tasks', 'Q-001', 'answer.json');

test('page carries a per-run token', () => assert.match(token || '', /^[0-9a-f]{32}$/));

test('tasks lists stage and question', async () => {
  const tasks = await (await fetch(base + '/api/tasks')).json();
  const t = tasks.find(x => x.id === 'Q-001');
  assert.strictEqual(t.stage, 'awaiting-approval');
  assert.strictEqual(t.question, 'Use custom CSS for the hero?');
  assert.strictEqual(t.answer, null);
});

test('answer endpoint rejects foreign origin', async () => {
  const r = await answer('approve', { origin: 'http://evil.example' });
  assert.strictEqual(r.status, 403);
  assert.ok(!fs.existsSync(answerFile));
});

test('answer endpoint rejects missing token', async () => {
  const r = await answer('approve', {}, null); // null, not undefined: undefined would pick up the default (real) token
  assert.strictEqual(r.status, 403);
  assert.ok(!fs.existsSync(answerFile));
});

test('answer endpoint approves', async () => {
  const r = await answer('approve');
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).ok, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(answerFile)).by, 'dashboard');
});

test('answer endpoint reports already answered', async () => {
  const body = await (await answer('reject')).json();
  assert.strictEqual(body.ok, false);
  assert.match(body.message, /already answered/);
});

test('task file endpoint serves only known files', async () => {
  assert.strictEqual((await fetch(`${base}/api/tasks/Q-001/file/request`)).status, 200);
  assert.strictEqual((await fetch(`${base}/api/tasks/Q-001/file/..%2F..%2Fetc`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/tasks/..%2Fx/file/request`)).status, 404);
});

test('tokens endpoint answers', async () => {
  const r = await fetch(base + '/api/tokens');
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.sessions) && Array.isArray(j.tasks));
});
