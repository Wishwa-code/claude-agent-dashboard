# Task Queue, Analysts and Dashboard v2: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user queues tasks in one chat. Analysts turn each task into an approved, exact work order. One browser agent carries the work orders out. A live dashboard shows the queue, approvals, tokens and context size.

**Architecture:**
- **Pipeline:** Claude Code skills and agent definitions in the Polek repo.
  - A queue agent (`/queue`) records tasks with `pipeline.py` and starts background analyst subagents.
  - The browser agent runs each work order in a fresh subagent.
- **Dashboard:** this repo's zero-dependency Node server.
  - It takes in Claude Code HTTP hooks, keeps sessions, events and tokens in `node:sqlite`, and pushes updates by SSE.
  - It reads the pipeline ledger, and writes approvals through `pipeline.py`.

**Tech Stack:**
- Python 3 (stdlib, `unittest`) for `pipeline.py`.
- Node 22.18 (`node:sqlite`, `node:test`, `http`; no npm packages) for the dashboard.
- Claude Code skills, agents and hooks.

**Spec:** `docs/superpowers/specs/2026-10-29-task-queue-and-dashboard-design.md` (this repo). Read it before starting any task.

**Two repos:**
- `D` = `~/Desktop/claude-agent-dashboard` (dashboard, branch `main`).
- `P` = `~/Desktop/shopify-shop-demo` (Polek project: skills, agents, `pipeline.py`, hooks, branch `main`).
- Paths below start with `D/` or `P/`. Commit in the repo the files belong to.
- In `P`, **only stage the files this plan names**: `P` has unrelated uncommitted work (`docs/enterprise-demo-settings.md`, two `.docx` files, and the staged agent-monitor deletion, which goes in with Task 3's commit).

## Global Constraints

- Before every commit, run the secret scan: `git diff --cached | grep -inE 'shpat_|sk-ant|BEGIN [A-Z ]*PRIVATE'` must print nothing, and also grep for the storefront password from `P/claude/CLAUDE.local.md` (never write it into any file). Never commit `.env*`, `claude/CLAUDE.local.md`, `claude/history/`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use git user `wishwa-code <wishwakankanamge129@gmail.com>` in `D`.
- Dashboard: zero npm dependencies. Listen on `127.0.0.1` only. Never read `~/.claude/sessions/*.key` or `~/.claude/.credentials*`. Port `4020` (env `PORT`).
- Dashboard database: `~/.local/state/claude-dashboard/dashboard.sqlite` (env `DASHBOARD_DB` overrides it, for tests), WAL mode.
- Pipeline state: `~/.local/state/polek-dev/` (env `PIPELINE_STATE` overrides it, for tests). Ledger `pipeline.jsonl` (append-only, one JSON row per line, each row < 4 KB), task folders `tasks/<id>/`.
- Stages: `queued → analysing → awaiting-approval → ready → with-browser → browser-done → (checking, reserved, unused) → done`, or `cancelled | blocked | failed`. Closed: `done, cancelled, failed`, plus the legacy `reported`.
- Task ids: `Q-001`, `Q-002`, … (3 digits minimum, then growing).
- Context warning: amber over **200,000** context tokens, red over **400,000**. Context = `input + cache_read + cache_creation` of a session's latest turn.
- Input-equivalent tokens: `input×1 + cache_write×1.25 + cache_read×0.1 + output×5`.
- Analysts: model `sonnet`, at most **3** running at once, reused for at most **3** tasks or until over **100k** context.
- Hooks go only in `P/.claude/settings.json`, alongside the existing heartbeat hooks, which must stay.
- When the dashboard is off, nothing in Claude Code may be slowed, error or block.

## Review Focus

1. **Dashboard off while sessions run.** Hooks must be silent and add no noticeable delay. This is pinned by Spike S1 and the Task 6 check.
2. **The same approval answered in chat and on the dashboard.** The first answer wins. The second gets "already answered by X" and changes nothing. Pinned by `test_answer_first_wins` (Task 1) and `answer endpoint reports already answered` (Task 7).
3. **A request to the answer endpoint from another website** (different `Origin`, or no page token). It must get a 403 and write nothing. Pinned by `answer endpoint rejects foreign origin` (Task 7).
4. **A ledger with old rows** (slug ids, old stage names like `reported`). The new commands still work, Q-ids start at `Q-001`, and old tasks count as closed or show as they are. Pinned by `test_legacy_rows` (Task 1).
5. **A transcript with a half-written last line, or the same message on several lines** (streaming). Tokens must be counted once per `message.id`, and the cut line read later. Pinned by `usage dedupes by message id and resumes after partial line` (Task 5).

---

### Task 0: Spikes (decide before building)

These three are checks, not code. Record each result as a dated line in `D/PROGRESS.md` under "## 7. Log", then commit `D/PROGRESS.md`.

**S1: HTTP hooks with nothing listening.**
- [ ] In a scratch project (`mkdir /tmp/hookspike && cd /tmp/hookspike`), add a `.claude/settings.json` with one `PostToolUse` HTTP hook to `http://127.0.0.1:4999/x` (nothing listens there) and `timeout: 2`.
- [ ] Run `claude -p "run: echo hi" --allowedTools Bash` there and time it with `time`. Do the same without the hook.
- [ ] **Pass:** no error text in the output, and less than 0.5 s extra.
  - If it fails, Task 6 uses an `async: true` command-hook forwarder (`D/hooks/forward.js`, modelled on `D/reference/ccam-hook-handler.js`: read stdin, POST with a 3 s timeout, always exit 0) instead of `type: "http"`.

**S2: Can a subagent drive the logged-in browser?** This needs the browser-agent session, so ask the user to run it there:
- [ ] Give this prompt to the browser agent: "Spawn a general-purpose subagent, model sonnet, that calls `browser_tabs` list and then navigates to https://admin.shopify.com/store/polek-emarket and reports the page title. Then do the same with a second subagent."
- [ ] **Pass:** both subagents report the admin page title, with no login page and no "browser already in use".
  - If it fails, Task 4 uses the fallback: the browser agent works directly, as today.

**S3: Does a continued analyst cost less than a fresh one?** Run this after Task 2 exists:
- [ ] Spawn the `analyst` agent with a small test task and note its first-turn cost.
- [ ] Continue the same analyst with `SendMessage` with a second small task.
- [ ] Measure both with `python3 -I D/tools/token-report.py ~/.claude/projects/-home-wishwa-Desktop-shopify-shop-demo` (subagent rows, startup column).
- [ ] **Pass:** the continued task's input-equivalent cost is lower than a fresh analyst's.
  - If it isn't, the queue skill (Task 3) drops reuse and always spawns fresh.

---

### Task 1: `pipeline.py` v2 (queue store)

**Files:**
- Modify: `P/claude/scripts/pipeline/pipeline.py` (whole file; keep `role`, `whois`, `status`)
- Create: `P/claude/scripts/pipeline/test_pipeline.py`

**Interfaces:**
- Produces this CLI, which later tasks call. `--by` takes any string.
  - `new "<title>" [--request TEXT]` prints the new id.
    - It appends `{"ts","id","stage":"queued","by":"queue","title"}`.
    - It writes `tasks/<id>/request.md` (the request text, or the title if there's none).
  - `log <id> <stage> --by <who> [--note T] [--title T]` appends a stage row.
  - `ask <id> --question T [--by who]` appends to `tasks/<id>/questions.json` (a list of `{"q","asked"}`) and logs `awaiting-approval`.
  - `answer <id> <value...> --by chat|dashboard`:
    - If no answer exists yet, it writes `tasks/<id>/answer.json` as `{"value","by","ts"}` with an exclusive create (`open(..., "x")`), appends `{"ts","id","event":"answer","value","by"}`, prints `answered`, and exits 0.
    - If an answer already exists, it prints `already answered by <by>: <value>` and exits 3.
    - The value is clipped to 2000 chars.
  - `wait-answer <id> [--timeout SECONDS]` polls `answer.json` every 2 s, prints `<by>: <value>` and exits 0. On timeout it exits 1. Without a timeout it waits forever.
  - `assign <id> <agent>` appends `{"ts","id","event":"assign","agent"}`.
  - `next-ready` prints the oldest task whose current stage is `ready`, or `none`.
  - `role` accepts `queue`, `intake`, `dispatcher`, `web-worker`.
- A task's current stage is the `stage` of its last row that has a `stage` key. Rows with `event` don't change the stage.
- `STATE = os.environ.get("PIPELINE_STATE") or ~/.local/state/polek-dev`.

- [ ] **Step 1: Write the failing tests** in `test_pipeline.py` (`unittest`; each test sets `PIPELINE_STATE` to a fresh `tempfile.mkdtemp()` and runs the script with `subprocess.run([sys.executable, PIPELINE, ...])`):
  - `test_new_ids_count_up`: two `new` calls print `Q-001` then `Q-002`; `tasks/Q-001/request.md` exists.
  - `test_legacy_rows`:
    - Pre-write a ledger row `{"ts":"2026-10-25T10:00:00+05:30","id":"hero-text","stage":"reported","by":"intake","title":"Hero"}`.
    - `new` prints `Q-001`.
    - `status` doesn't list `hero-text`, and prints `open: 1`.
  - `test_answer_first_wins`: `answer Q-001 approve --by dashboard` exits 0 and prints `answered`; `answer Q-001 reject --by chat` exits 3 with output containing `already answered by dashboard: approve`; `answer.json` still says `approve`.
  - `test_wait_answer_returns_when_answered`:
    - Start `wait-answer Q-001 --timeout 10` with `Popen`.
    - After 1 s, run `answer Q-001 yes --by chat`.
    - The waiter exits 0 within 5 s and prints `chat: yes`.
  - `test_wait_answer_times_out`: `wait-answer Q-001 --timeout 1` exits 1.
  - `test_next_ready`:
    - Two tasks. Log Q-002 `ready`, then Q-001 `ready`.
    - `next-ready` prints `Q-002` (ordered by when each became ready).
    - After `log Q-002 with-browser`, it prints `Q-001`.
  - `test_event_rows_do_not_change_stage`: after `log Q-001 analysing` and then `assign Q-001 analyst-1`, `status` shows Q-001 as `analysing`.
- [ ] **Step 2: Run:** `cd P && python3 -m unittest claude/scripts/pipeline/test_pipeline.py -v`. Expected: the tests fail (unknown commands).
- [ ] **Step 3: Implement the interface above in `pipeline.py`.**
  - Keep the docstring's usage block up to date.
  - Write each ledger row with a single `f.write()` on a file opened with `"a"`.
  - Next id = 1 + the highest `Q-(\d+)` number in the ledger.
- [ ] **Step 4: Run the tests again.** Expected: all pass. Also run `python3 P/claude/scripts/pipeline/pipeline.py status` against the real state, which must not crash.
- [ ] **Step 5: Commit in P:** `git add claude/scripts/pipeline/pipeline.py claude/scripts/pipeline/test_pipeline.py` → `"pipeline.py v2: Q ids, task folders, approvals, wait-answer"`.

---

### Task 2: Analyst agent and context pack

**Files:**
- Create: `P/.claude/agents/analyst.md`
- Create: `P/claude/scripts/pipeline/context-pack.md`

**Interfaces:**
- Produces: the agent type `analyst`, which the queue skill calls with `Agent(subagent_type: "analyst", run_in_background: true, description: "Analyst <id>")`.
- Its prompt input is `Task <id>`, the path to `request.md`, and an optional extra list of docs.
- Its output contract: it writes `tasks/<id>/workorder.md`, then returns at most 250 words starting with one of these lines:
  - `READY <id>`
  - `NEEDS-APPROVAL <id>`, followed by numbered questions, each naming the amber step and its options
  - `UNCLEAR <id>: <question>`
  - `REFUSED <id>: <red rule>`

- [ ] **Step 1: Write `analyst.md`.**
  - Frontmatter:
    - `name: analyst`
    - a `description` (it plans one Polek store task; read-only)
    - `model: sonnet`
    - `tools: Read, Grep, Glob, Bash, WebFetch, Write, mcp__claude_ai_Shopify__search_docs_chunks`
  - The body covers spec §4.2:
    - Read the context pack first, then only the sections it lists.
    - Bash only for read-only commands, plus `pipeline.py ask`. Write only to `tasks/<id>/workorder.md`.
    - Classify each step green, amber or red against `docs/design-framework.md`, and check the framework's known speed and mobile risks.
    - Use the Enterprise trial theme `198818234534` unless the task says otherwise.
    - The work-order format is the `BROWSER TASK` body from `P/.claude/skills/dispatcher/SKILL.md` §4: `Where / Do / Done when / Approved by user`, plus `Verify` and `Undo`.
    - Never change the store, the theme or the browser.
- [ ] **Step 2: Write `context-pack.md`.**
  - A short list of which files and sections to read per kind of task: theme editor setting, layout or design, custom CSS/Liquid (amber), admin or store setting.
  - Pinned for every task: `docs/design-framework.md`, its green/amber/red table and its speed-risk list.
  - Keep it under 60 lines.
- [ ] **Step 3: Verify.**
  - In a Claude session in P, spawn `analyst` on a harmless made-up task, "Q-TEST: change the announcement bar text to 'Free delivery in Colombo'", after `PIPELINE_STATE=/tmp/pq python3 claude/scripts/pipeline/pipeline.py new "test"` (the analyst must be told to use that state dir).
  - **Pass:** `workorder.md` is written, the reply starts with `READY` or `NEEDS-APPROVAL`, and the transcript shows no tool calls that write anything else.
  - Then run Spike S3.
- [ ] **Step 4: Commit in P:** `git add .claude/agents/analyst.md claude/scripts/pipeline/context-pack.md` → `"Analyst agent and context pack"`.

---

### Task 3: Queue skill, and retiring Intake and Dispatcher

**Files:**
- Create: `P/.claude/skills/queue/SKILL.md`
- Modify: `P/.claude/skills/intake/SKILL.md` and `P/.claude/skills/dispatcher/SKILL.md`. Replace each body with a one-line pointer: "Retired 2026-10-29: use `/queue`." Keep the frontmatter, with `description` saying it's retired.
- Modify: `P/claude/CLAUDE.md`, the "Agent pipeline" section and the "Agent monitor" line.

**Interfaces:**
- Consumes: the Task 1 CLI, the Task 2 `analyst` and its output contract, and the browser-agent `BROWSER TASK/ACK/QUESTION/RESULT` messages (unchanged).
- Produces: the messages the dashboard shows. First lines:
  - `QUEUED <id>: <title>`
  - `APPROVAL <id>: <question>`
  - `DONE <id>: done|partial|blocked <summary>`

- [ ] **Step 1: Write `queue/SKILL.md`.** It covers spec §4.1 and §8 items 2–5:
  - **Start:** `ListAgents` → `pipeline.py role queue <name>`; `whois web-worker`; one-line ready message.
  - **Each user message:** split it into tasks; `new` with `--request` (the user's words, verbatim); reply `QUEUED …`; never wait.
  - **Skipping the analyst:** only when all three hold (§8.4): a single setting and value, the setting is already in `enterprise-demo-settings.md`, and it's green. Otherwise analyse.
  - **Analysts:**
    - Background `Agent(subagent_type "analyst", description "Analyst <id>")`.
    - Before spawning, `assign` and `log analysing`.
    - Reuse an idle analyst with `SendMessage` while it has done fewer than 3 tasks and reports under 100k context. Skip reuse if Spike S3 failed.
    - At most 3 running at once; extra tasks stay `queued` until one finishes.
  - **Analyst replies:**
    - `READY` → `log ready`.
    - `NEEDS-APPROVAL` → for each question, `ask`; post `APPROVAL <id>: …` in chat; start `pipeline.py wait-answer <id>` with `run_in_background`.
    - `UNCLEAR` → treat it like an approval question.
    - `REFUSED` → `log blocked` and tell the user.
  - **Answers:**
    - In chat with one open approval, a bare yes/no applies to it. With several open, ask for the id; never guess. Record the answer with `answer … --by chat`. (Exit 3 means the dashboard answered first; say so.)
    - When `wait-answer` wakes the agent, read the value:
      - approve → add `Approved by user: …` to `workorder.md`, then `log ready`;
      - reject → `log cancelled`;
      - text → apply it; if it changes the plan, `SendMessage` the analyst.
  - **The browser:** when no task is `with-browser`, take `next-ready`, send `BROWSER TASK <id>: …` with the `workorder.md` body, then `log with-browser`.
    - On `BROWSER RESULT`: write `result.md`, then `log browser-done`, then `log done` (or `blocked`/`failed`), then post `DONE …` in two lines, then send the next ready task.
  - **Staying small:** never paste work orders or analyst output into chat beyond their first lines. If the dashboard or `/context` shows this session over 200k, tell the user once that it's safe to `/clear` and run `/queue` again.
  - **Rules:** first lines at most ~80 chars; never mark amber approved yourself; run the `cloud-check` skill only when the user starts a new piece of work outside the queue.
- [ ] **Step 2: Retire `intake` and `dispatcher`, and update `CLAUDE.md`.**
  - Agent pipeline: You → Queue (`/queue`) → Analysts (subagent `analyst`) → Browser agent.
  - Add the token note: about 93% of tokens came from long sessions (2026-10-29).
  - Monitor line: `/dashboard` or `claude-dashboard`.
- [ ] **Step 3: Verify with a dry run.**
  - Ask the user to run `/queue` in a new tab and give two harmless tasks in one message, one trivial and one needing an analyst. The browser agent doesn't need to be running.
  - **Pass:**
    - both are recorded with Q-ids and get `QUEUED` replies at once;
    - the analyst runs in the background while the queue tab still answers;
    - an approval question reaches chat;
    - "approve Q-00x" moves the task to `ready`.
- [ ] **Step 4: Commit in P:** `git add .claude/skills/queue .claude/skills/intake/SKILL.md .claude/skills/dispatcher/SKILL.md claude/CLAUDE.md claude/scripts/agent-monitor` (the last one stages the earlier deletion) → `"Queue skill replaces intake and dispatcher; monitor moved out"`.

---

### Task 4: Browser agent runs each work order in a fresh subagent

**Files:**
- Modify: `P/.claude/skills/browser-agent/SKILL.md`, the section "For each task" only.

**Interfaces:**
- Consumes: `BROWSER TASK <id>` messages (unchanged), and the Spike S2 result.
- Produces: `BROWSER RESULT` replies (unchanged format).

- [ ] **Step 1 (Spike S2 passed): edit the skill.**
  - After the ACK and the scope check, spawn one `Agent(subagent_type "general-purpose", model "sonnet", description "Browser worker <id>")` in the foreground.
  - Its prompt is the work order, plus the skill's own steps 3–5 (editor tips, save, `visual-check`, record in `enterprise-demo-settings.md`). It must return the RESULT text in at most 200 words, with absolute screenshot paths, and must not paste screenshots.
  - While the worker runs, this session calls no browser tools. Only one worker at a time.
  - Forward its text as `BROWSER RESULT`.
  - **If S2 failed:** add only the line "After each RESULT, if this session's context is over 200k, tell the user it is safe to /clear and re-run /browser-agent."
- [ ] **Step 2: Verify.**
  - The user sends one harmless real task through `/queue`, for example an announcement bar text change on the Enterprise trial theme, which they approve.
  - **Pass:** the change is saved, `enterprise-demo-settings.md` has a new entry, and the browser-agent session's context grew by less than 15k for the task (check with `/context`, or the dashboard after Task 5).
- [ ] **Step 3: Commit in P:** `git add .claude/skills/browser-agent/SKILL.md` → `"Browser agent: one fresh worker subagent per work order"`.

---

### Task 5: Dashboard data layer: SQLite, transcript usage, shared parser

**Files:**
- Create: `D/package.json` (`{"name":"claude-agent-dashboard","private":true,"scripts":{"test":"node --test monitor/test/"}}`)
- Create: `D/monitor/lib/db.js`
- Create: `D/monitor/lib/usage.js`
- Create: `D/monitor/lib/transcript.js` (moved from `server.js`: `clip`, `textOf`, `taskName`, `toolSummary`, `toolLabel`, `notification`, `toEvents`, `readTranscript`)
- Modify: `D/monitor/server.js` to import from `lib/transcript.js` (no behaviour change)
- Create: `D/monitor/test/db.test.js`, `D/monitor/test/usage.test.js`

**Interfaces:**
- `db.js`:
  - `openDb(file: string): Db` creates the tables `sessions(id PK, name, cwd, status, model, started_at, ended_at, updated_at, transcript_path)`, `agents(id PK, session_id, parent_agent_id, type, subagent_type, name, status, started_at, ended_at)`, `events(id INTEGER PK, session_id, agent_id, event_type, tool_name, summary, data, created_at)` and `handoffs(id INTEGER PK, from_name, to_name, kind, task_id, first_line, created_at)`.
  - It indexes `events(session_id, created_at)` and `events(created_at)`, and sets `PRAGMA journal_mode=WAL`.
  - `Db` methods:
    - `upsertSession(row)`, `upsertAgent(row)`
    - `insertEvent(row): number`
    - `insertHandoff(row)`
    - `recentEvents(limit: number, sessionId?: string): Row[]`
    - `close()`
- `usage.js`:
  - `readUsage(file: string, state?: UsageState): UsageState` reads incrementally from `state.offset`. `UsageState = {offset, partial, seen: Set<string>, byModel: {[model]: {inp, cw, cr, out}}, turns, context, lastTs}`, and `context` is the latest turn's input + cache read + cache creation.
  - `inputEq({inp, cw, cr, out}): number` uses the Global Constraints weights.
  - `sessionUsage(projectDir: string): {[sessionId]: {main: UsageState, subagents: {[agentId]: UsageState & {description}}}}` reads `<id>.jsonl` and `<id>/subagents/agent-*.jsonl` plus `.meta.json` (`description`). It caches states between calls, so only new bytes are read.

- [ ] **Step 1: Write the failing tests.**
  - `usage dedupes by message id and resumes after partial line`:
    - Write a temp jsonl with two assistant lines that share `message.id` `m1` (usage `input 10, cache_read 100, cache_creation 5, output 2`), plus half of a third line (`m2`).
    - `readUsage` gives `turns 1`, `byModel[model].inp 10`, `context 115`.
    - Append the rest of the `m2` line (usage input 20, cache_read 200), then call `readUsage(file, state)` again: `turns 2`, `context 220`.
  - `inputEq weights`: `inputEq({inp:100,cw:100,cr:100,out:100}) === 100+125+10+500`.
  - `db round trip`: `openDb(tmp)`, `upsertSession({id:'s1',name:'a'})`, two `insertEvent` calls; `recentEvents(10,'s1').length === 2`, newest first; `PRAGMA journal_mode` returns `wal`.
- [ ] **Step 2: Run `cd D && npm test`.** Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `db.js` and `usage.js`; move the transcript functions into `lib/transcript.js` and import them in `server.js`.** Use `const { DatabaseSync } = require('node:sqlite')`.
- [ ] **Step 4: Run `npm test`.** Expected: PASS. Then run `PORT=4029 node monitor/server.js` and check that `curl -s localhost:4029/api/sessions` still returns sessions (no regression).
- [ ] **Step 5: Commit in D:** `"Dashboard data layer: sqlite, transcript usage, shared parser"`.

---

### Task 6: Hook ingest and live stream

**Files:**
- Create: `D/monitor/lib/hooks.js`, `D/monitor/lib/sse.js`, `D/monitor/test/hooks.test.js`
- Modify: `D/monitor/server.js` (routes)
- Modify: `P/.claude/settings.json` (add hooks; keep the heartbeat hooks)

**Interfaces:**
- `hooks.js` exports `handleHook(db: Db, payload: object, now?: string): Message[]`. `Message = {type: 'session_updated'|'agent_updated'|'new_event', data, timestamp}`. The behaviour per `hook_event_name`:
  - `SessionStart`: upsert the session as `active`, with `transcript_path` and `cwd`.
  - `SessionEnd`: set the session `ended`.
  - `UserPromptSubmit`: record the event, with the first 200 chars of the prompt as the summary.
  - `PreToolUse`, `PostToolUse` and `PostToolUseFailure`: record the event with `tool_name` and a summary from `transcript.js`'s `toolSummary`. For `SendMessage` it also inserts a handoff: `to` = `tool_input.to`, `first_line` = the first line of `tool_input.message`.
  - `SubagentStart` and `SubagentStop`: upsert the agent (`id` = `agent_id`, `parent` = `session_id`'s main agent, `subagent_type` = `agent_type`), set to `working` or `completed`.
  - `Stop`: set the main agent to `waiting`.
  - `Notification`: record the event.
  - Unknown events are recorded as they come. Each payload is stored in full in `events.data`.
- `sse.js` exports `createStream(): {handler(req,res), broadcast(msg)}`. The handler sends `text/event-stream`, a `: ping` every 25 s, and each broadcast as `data: <json>\n\n`.
- New routes:
  - `POST /api/hooks/event` (body max 1 MB) → `handleHook`, then `broadcast` each message, then `200 {}`. It always answers 200, even on errors (log them).
  - `GET /api/stream`.

- [ ] **Step 1: Write the failing tests** in `hooks.test.js`:
  - `SubagentStart then SubagentStop gives a completed child agent`
  - `SendMessage PreToolUse records a handoff with the first line`
  - `bad payload does not throw` (`handleHook(db, {})` returns `[]`)
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement `hooks.js`, `sse.js` and the routes in `server.js`.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Add hooks to `P/.claude/settings.json`.**
  - Add the events from spec §5.1 as `{"type":"http","url":"http://127.0.0.1:4020/api/hooks/event","timeout":2}`, or as the `async` forwarder if S1 failed.
  - Add them as new entries next to the existing `UserPromptSubmit`/`PostToolUse` heartbeat entries, without changing those.
  - Validate with `python3 -c 'import json;json.load(open("P/.claude/settings.json"))'`.
- [ ] **Step 6: Verify both states.**
  - With the dashboard running (`claude-dashboard restart`), use any tool in a P session. `curl -sN localhost:4020/api/stream` shows `new_event` within 2 s.
  - Then `claude-dashboard stop`, use a tool in P: no hook error is shown, and there's no noticeable delay.
- [ ] **Step 7: Commit in D** (`"Hook ingest and SSE stream"`) **and in P** (`git add .claude/settings.json` → `"Hooks to agent dashboard"`).

---

### Task 7: Queue, tokens and approvals API

**Files:**
- Create: `D/monitor/lib/pipeline.js` (the `readLedger` moved from `server.js`, extended), `D/monitor/test/api.test.js`
- Modify: `D/monitor/server.js`

**Interfaces:**
- `pipeline.js`:
  - `readTasks(stateDir: string): Task[]`. `Task = {id, title, stage, stages:[{ts,stage,by,note}], agent, question: string|null, answer: {value,by,ts}|null, files: {request, workorder, result}}` (file paths, where they exist). Newest activity first. It understands legacy rows.
  - `answerTask(stateDir: string, id: string, value: string): {ok: boolean, message: string}`. It runs `python3 <PIPELINE_PY> answer <id> <value> --by dashboard` with `PIPELINE_STATE=stateDir`. `PIPELINE_PY` comes from env `PIPELINE_PY`, default `~/Desktop/shopify-shop-demo/claude/scripts/pipeline/pipeline.py`. Exit 3 → `{ok:false, message:<stdout>}`.
- Routes:
  - `GET /api/tasks` → `readTasks`.
  - `GET /api/tokens` → per session: name, live, context, `inputEq` total, per model, and subagents (description, `inputEq`, turns). Per task: the sum over agents whose description ends with the task id (`Analyst Q-003`, `Browser worker Q-003`).
  - `POST /api/tasks/:id/answer` with JSON `{value, token}`:
    - It requires `Origin` to be `http://localhost:<PORT>` or `http://127.0.0.1:<PORT>`, and `token` to equal a random per-server-start token the server puts in the page as `<meta name="dash-token">`.
    - Otherwise 403 and nothing written.
    - It answers `{ok, message}` and broadcasts `task_updated`.
  - `GET /api/sessions` keeps working.

- [ ] **Step 1: Write the failing tests** in `api.test.js`. Start the server on a random port with `PIPELINE_STATE` set to a temp dir, a seeded task `Q-001` at `awaiting-approval`, and `DASHBOARD_DB` set to a temp file.
  - `answer endpoint rejects foreign origin`: `Origin: http://evil.example` → 403; no `answer.json` exists.
  - `answer endpoint rejects missing token` → 403.
  - `answer endpoint approves`: the right origin and token → `{ok:true}`; `answer.json.by === 'dashboard'`.
  - `answer endpoint reports already answered`: a second call → `{ok:false}`, and the message contains `already answered`.
  - `tasks lists stage and question`: `GET /api/tasks` gives Q-001, with `stage` `awaiting-approval` and the seeded question.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement it.** For the test to read the per-run token, the server serves `/` with it injected. Read the meta tag from the `GET /` HTML.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit in D:** `"Queue, tokens and approvals API"`.

---

### Task 8: Dashboard views: Queue, Tokens, context warnings, live updates

**Files:**
- Modify: `D/monitor/index.html`

**Interfaces:**
- Consumes `/api/tasks`, `/api/tokens`, `/api/stream`, `POST /api/tasks/:id/answer`, and the `dash-token` meta tag.

- [ ] **Step 1: Add the Queue tab** (next to the existing tabs, built with `setTab`):
  - One row per task: id, title, stage chip, agent, waiting time, and tokens (`inputEq`, shown as `k`/`M`).
  - At `awaiting-approval` it shows the question, **Approve** and **Reject** buttons, and a text box for "answer". When answered, the row shows "answered in chat" or "answered on dashboard" (from `answer.by`).
  - Links show the work order and result text in a side panel (served by a new `GET /api/tasks/:id/file/:name` with `name` limited to `request|workorder|result`; add it to `server.js`).
- [ ] **Step 2: Add the Tokens tab:**
  - Sessions sorted by `inputEq`, each with a context bar: amber over 200k and red over 400k, with the label "safe to /clear: state is in the queue".
  - Subagents nested under their session; per-task totals.
  - Show the approximate cost only if the `D/monitor/lib/pricing.js` table exists. Fill that table from the `claude-api` skill (never from memory), as `{modelPrefix: {inp, cw, cr, out}}` per million tokens. Otherwise show only tokens.
- [ ] **Step 3: Live updates.**
  - Open `new EventSource('/api/stream')`. On `task_updated` or `new_event`, re-fetch the affected API (debounced 500 ms).
  - Keep `poll()` as a fallback at 10 s instead of the current interval, so the page stays correct if the stream drops.
- [ ] **Step 4: Verify.**
  - `claude-dashboard restart`.
  - With `PIPELINE_STATE` unchanged, create a test task: `python3 P/claude/scripts/pipeline/pipeline.py new "dashboard test"`, then `ask Q-00x --question "Approve test?"`.
  - Open http://localhost:4020 → Queue: the buttons show. Click Approve: the row says "answered on dashboard" within 2 s, and `answer` from the CLI then exits 3.
  - Then `log Q-00x cancelled --by queue` to close it.
  - Tokens tab: the long Polek sessions show red context bars.
  - Take screenshots at 1280 px and 390 px (`claude/scripts/visual-check` style, or the browser), with no sideways scroll at 390 px.
- [ ] **Step 5: Commit in D:** `"Dashboard: queue, tokens, context warnings, live updates"`.

---

### Task 9: Docs and progress

**Files:**
- Modify: `D/PROGRESS.md` (tick phases P1–P5 and add pipeline items, then a log entry)
- Create: `D/README.md` (what it is, `claude-dashboard`, `npm test`, the env vars `PORT`, `PROJECT_DIR`, `PIPELINE_STATE`, `PIPELINE_PY` and `DASHBOARD_DB`, and the data sources)
- Modify: the memory note `~/.claude/projects/-home-wishwa-Desktop-shopify-shop-demo/memory/agent-dashboard-project.md` (mention `/queue` and `/dashboard`)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run `cd D && npm test` and `cd P && python3 -m unittest claude/scripts/pipeline/test_pipeline.py`.** Both must pass.
- [ ] **Step 3: Commit in D:** `"Docs: README and progress"`.
