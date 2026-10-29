# Task queue, analysts and dashboard v2: design

- **Date:** 2026-10-29
- **Status:** draft after builder check, waiting for the user's approval
- **Repos involved:**
  - this repo (`~/Desktop/claude-agent-dashboard`) holds the dashboard;
  - `~/Desktop/shopify-shop-demo` (the Polek Shopify project) holds the skills, agent definition and `pipeline.py`.

## 1. Intent

The user gives Claude tasks for the Polek Shopify store. Most of them are theme-editor and admin work done in the one logged-in browser. They want to:

1. **Hand over many tasks without waiting.** They type tasks one after another into one chat and keep working.
2. **Get every task done correctly.** Each task is worked out precisely by an analyst, and approved by the user where needed, before the browser is touched.
3. **Spend only the tokens a task needs.** This is the problem that started this redesign: the agents use too many tokens.
4. **See it all on a dashboard:** the queue, the stages, who is working on what, tokens per task, and approvals.

### What a measurement showed (2026-10-29, 31 transcripts of this project)

- Total spend: about 186M input-equivalent tokens. Weights relative to plain input tokens: cache write 1.25×, cache read 0.1×, output 5×.
- **About 93% came from long-running main sessions.** The four largest ran 500–670 turns, with context at a median of about 400k tokens and up to 850k–960k. Every turn re-sends the whole context.
- **Subagents used only about 7%.** That's 18 of them, each costing about 41k tokens to start, at a median of 34 turns.
- Screenshots and large file reads stay in a session's context for every later turn.
- **Conclusion:** keep the long-lived agents' context small. Do the work in short-lived, fresh-context workers that hand back short summaries. Extra agents in the middle are affordable if they're short-lived and lean.
- The measuring script is in this repo at `tools/token-report.py` (copied from the session scratchpad).

## 2. Goals, non-goals, anti-goals

**Goals**
- The user hands tasks to one queue agent and never waits for one to finish before giving the next.
- Each task is analysed into an exact work order, checked against `docs/design-framework.md` and its known speed risks, and approved by the user wherever the framework requires it, before any browser work.
- At most one session drives the browser, and browser tasks run one at a time.
- Token use per task, per agent and per session is visible, and sessions whose context grows too big are flagged.
- Approvals can be answered either in the queue agent's chat or with dashboard buttons. Whichever comes first wins, and the other place shows it as answered.
- The dashboard starts with one command (`/dashboard` or `claude-dashboard`; done 2026-10-29).

**Non-goals (for now)**
- **The agreement checker.** This would run Lighthouse (LCP ≤ 2.5 s, INP ≤ 200 ms via a TBT proxy, CLS ≤ 0.1) and `visual-check` automatically after each task. The user put it on hold for a later stage, but the design must leave room for a `checking` stage between `browser-done` and `done`.
- Codex/Cursor support, multiple users, remote machines, alerts and webhooks, plugins, i18n, a desktop app: all CCAM features we don't need.
- Running the CCAM reference repo itself.

**Anti-goals: count as failure even if it works**
- The new pipeline uses more tokens per task than the old Intake → Dispatcher → planners chain.
- Any agent makes an amber change without the user's approval, or makes a red change at all (`design-framework.md`).
- Two sessions drive the browser or save the theme at the same time.
- The hooks or dashboard slow down or block Claude Code. The dashboard being off must not break any session.
- The dashboard exposes secrets, or reads `~/.claude/sessions/*.key` or `~/.claude/.credentials*`.

## 3. Constraints

- **The browser:** the Playwright MCP's logged-in profile can be open in one session only. That session is the **browser agent**.
- **A session cannot `/clear` itself.** So "clear memory between tasks" is done by doing each task's work in a **subagent**. The subagent starts fresh, and only the work order and a short result enter the long-lived session's context. Subagents get the parent's MCP tools, including Playwright.
  - The builder must verify this early (a spike): that a subagent of the browser-owning session can drive the same logged-in browser.
  - If it can't, the fallback is the browser agent doing the work itself. The dashboard then shows a "/clear me" warning at the threshold (§5.6), and the user runs `/clear` when idle. The queue file keeps all state, so nothing is lost.
- **Agents can't watch for events without spending tokens.** Waiting for an answer is done with a background command (`run_in_background`) that exits when the answer arrives. Claude Code then wakes the agent with a notification, and no polling turns are spent.
- **Project rules still apply.** Every new task starts with `cloud-check`. Before any commit, run the secret scan. Never print the storefront password.
- **Node v22.18 is on the machine.** The dashboard keeps zero npm dependencies: it uses `node:sqlite` (built in; prints an experimental warning, which is fine), `http`, and SSE rather than WebSocket.

## 4. The pipeline (decided with the user)

```
You ──tasks──▶ Queue agent ──(spawns / reuses)──▶ Analyst(s) ──draft work order + questions──▶ Queue agent
                    │  ▲                                                                          │
                    │  └──── approvals: chat tab  or  dashboard buttons (first wins) ◀────────────┤
                    │                                                                             ▼
                    └────────── one ready work order at a time ──────────▶ Browser agent ──▶ result ──▶ Queue agent ──▶ You
```

### 4.1 Queue agent (replaces Intake and Dispatcher)

The user's chat tab: skill `queue` (`/queue`) in `shopify-shop-demo/.claude/skills/queue/`.

**For each message from the user:**
1. Split it into tasks if it holds several.
2. Record each task in the queue store (`pipeline.py new …`), with a title and the user's words verbatim.
3. Reply in one line ("Queued Q-012 Hero text…").
4. Never wait. Analysis runs in the background.

**Choosing who analyses** (the queue agent decides, keeping the count as low as possible):
- **Trivial, exact tasks** (one named setting and value, nothing to judge): the queue agent writes the work order itself. No analyst.
- **Otherwise:** an analyst subagent running in the background (`Agent`, `run_in_background`). The queue agent reuses an idle analyst with `SendMessage` before spawning a new one.
  - An analyst is retired after 3 tasks, or when it reports its context is over 100k (builder may tune both).
  - At most 3 analysts run at once (builder may tune).
  - When the queue has more unanalysed tasks than idle analysts, it spawns up to that cap.

**When an analyst returns** a draft work order and, if needed, approval questions:
- **No questions:** mark it `ready`.
- **Questions:** post them in chat (first line `APPROVAL <id>: <question>`), record them in the store (stage `awaiting-approval`; the dashboard shows buttons), and start a background `pipeline.py wait-answer <id>` that wakes the queue agent when an answer is recorded from either place.
  - Answers given in chat are recorded by the queue agent itself (`pipeline.py answer`).
  - With the answers in hand, the queue agent finishes the work order. It inserts "Approved by user: …" itself; there's no need to wake the analyst again unless an answer changes the plan.
  - A rejected task goes to `cancelled`.

**Feeding the browser agent:**
- It sends one `ready` work order at a time, in queue order (`BROWSER TASK <id>` format, as today), and the next one only after the previous `BROWSER RESULT`.
- When a result arrives, it records it and tells the user in two lines (first line `DONE <id>: done|partial|blocked …`).

**Keeping itself small:**
- Its context holds only the task list lines, one-line summaries and the current approvals. Long analyst output goes to files (§4.4); it doesn't read it into chat.
- If its own context passes the warning threshold, it tells the user once that it's safe to `/clear` and re-run `/queue`. All state is in the store.

### 4.2 Analyst (new agent definition)

Defined in `shopify-shop-demo/.claude/agents/analyst.md`, so it's a named agent type with its own short system prompt.

- **Model:** Sonnet.
- **Tools:** read-only only: Read, Grep, Glob, Bash for read-only commands, WebFetch, and the Shopify docs tools. No browser, no Edit/Write except its own work-order file, no store writes. Keeping the tool list short also cuts its ~41k startup cost. The builder should measure the startup cost before and after.
- **Gets:** the task (id, the user's words), and the path of a **context pack**. That's a short file listing which docs or sections apply, so it reads only those instead of everything.
  - Default pack: the relevant parts of `docs/design-framework.md`, `docs/enterprise-demo-settings.md` and `docs/performance-baseline-2026-10-23.md`, plus the browser-agent rules (Enterprise trial theme `198818234534` unless the task says otherwise).
- **Does:**
  1. Work out the exact steps: section, block, setting, value; the theme's own options before custom code.
  2. Classify each step green, amber or red.
  3. Check each step against the known speed and mobile risks in the framework.
  4. Write how to verify, and how to undo.
- **Returns:** at most about 250 words, with the full work order written to the task's folder (§4.4).
  - Amber steps become approval questions.
  - Red steps are refused, with the reason.
  - If the task is unclear, it returns a question for the user instead of guessing.
- It never changes anything.

### 4.3 Browser agent (existing skill `browser-agent`, updated)

It keeps everything in today's skill: registration, scope rules, the editor tips, verifying with `visual-check`, writing to `enterprise-demo-settings.md`, and the RESULT format.

**Change:** for each work order it spawns one fresh **browser-worker subagent** that does the steps and returns the RESULT text. The browser agent then forwards that text and records it. This keeps screenshots and page snapshots out of the long-lived session. (This depends on the spike in §3; if the spike fails, use the fallback described there.)

It also accepts tasks sent directly through `browser-task`, as today.

### 4.4 Queue store: `pipeline.py`, extended

- Same file and format: append-only `~/.local/state/polek-dev/pipeline.jsonl`, one JSON row per stage change.
- New stages, replacing the old list:
  - `queued` → `analysing` → (`awaiting-approval` →) `ready` → `with-browser` → `browser-done` → (`checking`, reserved for later) → `done`
  - or `cancelled`, `blocked` or `failed`.
- Per task, a folder `~/.local/state/polek-dev/tasks/<id>/` holding `request.md` (the user's words), `workorder.md`, `questions.json` / answers and `result.md`.
- New commands:
  - `new` (exists; prints the id)
  - `answer <id> <approve|reject|text> --by chat|dashboard`
  - `wait-answer <id>` (blocks until an answer exists; meant for `run_in_background`)
  - `next-ready`
  - `assign <id> <agent>`
- Ids are short and readable (`Q-001`, …). Old ledger rows stay readable by the dashboard.
- **Writes from two places** (the queue agent and the dashboard server): each is an atomic append of one line under 4 KB (`O_APPEND`), which is safe. The dashboard writes answers only.

### 4.5 Retiring the old chain

- The `intake` and `dispatcher` skills are replaced by `queue`. Delete them, or leave a one-line pointer to `/queue` (builder's call).
- Update `claude/CLAUDE.md` → "Agent pipeline" to describe the new chain.
- `browser-task` stays, for ad-hoc work sent straight to the browser agent.

## 5. Dashboard v2 (this repo, `monitor/`)

It evolves today's `monitor/server.js` + `index.html`. It doesn't fork CCAM, but borrows CCAM's architecture (`reference/ccam-ARCHITECTURE.md`).

### 5.1 Ingest: hooks

- **Project-level** HTTP hooks in `shopify-shop-demo/.claude/settings.json`, posting to `http://127.0.0.1:4020/api/hooks/event`, for:
  - `SessionStart`, `SessionEnd`
  - `UserPromptSubmit`
  - `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
  - `SubagentStart`, `SubagentStop`
  - `Stop`, `Notification`
- They sit alongside the existing heartbeat hooks; don't replace those.
- They must be silent and fast when the dashboard is off. The builder verifies this first. If HTTP hooks show errors or delay with no listener, use a tiny `async: true` command hook forwarder instead, modelled on `reference/ccam-hook-handler.js`: always exit 0, 3 s timeout.
- The server stores the raw event and answers at once.

### 5.2 Store: SQLite

- One database at `~/.local/state/claude-dashboard/dashboard.sqlite`, using `node:sqlite` in WAL mode.
- Tables, modelled on CCAM:
  - `sessions`
  - `agents` (with `parent_agent_id`, so subagents form a tree)
  - `events`
  - `token_usage` (per session or agent and model)
  - `handoffs` (from, to, kind, task id, first line)
- Pipeline tasks are **not** copied into SQLite. `pipeline.jsonl` and the task folders stay the source of truth, and the server reads them.

### 5.3 One transcript parser

- Move the current `toEvents()` logic into a module used both for live updates and for a backfill of transcripts that predate the hooks.
- Add token usage from `message.usage`, de-duplicated by `message.id`, including subagent transcripts in `<session>/subagents/*.jsonl` and their `.meta.json` descriptions. The measuring script shows the method.
- Context size = input + cache read + cache creation of the latest turn.

### 5.4 Live updates

- `GET /api/stream` (SSE) pushes `{type, data, timestamp}` messages.
- The page loads once from the REST endpoints, then updates from the stream. Polling remains only as a fallback.

### 5.5 Approvals from the dashboard

- `POST /api/tasks/<id>/answer` with `approve`, `reject` or a text answer. It runs `pipeline.py answer … --by dashboard`, which wakes the queue agent's `wait-answer`.
- Only from localhost: check the `Origin`/`Host` headers, plus a per-run token embedded in the page, against requests from other sites.
- Once answered, the buttons turn into "answered in chat / on dashboard".

### 5.6 Views

Keep today's handoff diagram and session panels. Add:

- **Queue:** every task, with its stage, the agent on it, how long it has waited, approval buttons, tokens so far, and links to its work order and result.
- **Tokens:** per task (all agents that worked on it), per session and per subagent. Show raw and input-equivalent totals, plus an approximate cost. Pricing per model goes in one small table, approximate.
- **Context warning:** any live session over **200k** context tokens is flagged amber, and over 400k red, with the hint "safe to /clear: state is in the queue". Builder may tune the thresholds.

## 6. Left to the builder

- File and module layout inside `monitor/`, the visual design of the new views, the SQLite column details, the SSE message names.
- The reuse limits and caps marked "builder may tune".
- Whether `intake`/`dispatcher` are deleted or left as pointers.
- Exact context-pack contents per kind of task.
- Order of work. The suggested order:
  1. the spikes in §3 and §5.1;
  2. the store and `pipeline.py`;
  3. the analyst and queue skill;
  4. the browser-agent change;
  5. dashboard ingest and tokens;
  6. dashboard queue and approvals.

## 7. Calls made by Claude (not discussed with the user)

- Subagents as the way to "clear memory between tasks" (§3, §4.3).
- The queue agent analyses trivial tasks itself; analyst caps and limits as above.
- Sonnet and a short read-only tool list for analysts.
- SSE rather than WebSocket, `node:sqlite`, zero dependencies.
- Context thresholds of 200k and 400k.
- The queue store stays as `pipeline.jsonl` plus task folders.

## 8. Settled after the builder check (2026-10-29)

1. **Browser ownership.**
   - While a browser-worker subagent runs, the browser agent itself never calls browser tools, so one user at a time.
   - Each worker closes nothing that would log the profile out, and only one worker runs at a time.
   - The spike must show two workers in a row working on the same logged-in profile.
   - If the spike fails, the fallback is built in full, and it's small: the browser agent does the work itself, as today, plus the dashboard's context warning.
2. **Messaging between sessions.**
   - Queue agent → browser agent uses the existing `SendMessage` with `BROWSER TASK`, finding the browser agent's name with `pipeline.py whois web-worker` and confirming it with `ListAgents`.
   - The browser agent's replies (`BROWSER ACK/QUESTION/RESULT`) arrive in the queue agent as cross-session messages. Like a background-agent completion, these wake the session, so no waiting is needed.
   - Each `wait-answer` is its own background command, and several may run at once. The queue agent never blocks in the foreground.
3. **Analyst reuse.**
   - A finished subagent can be continued with `SendMessage` to its agent id; the Agent tool documents this.
   - The spike also measures what a continued analyst costs compared with a fresh one. If continuing isn't cheaper, drop reuse and spawn fresh.
4. **Skipping the analyst.**
   - The queue agent may skip the analyst only when every step is green, it is one named setting with one value, and the setting is already listed in `enterprise-demo-settings.md`.
   - In any doubt, or with any possible amber step, it sends the task to an analyst. Green/amber/red is always judged against `design-framework.md`.
5. **Approvals in chat.**
   - With one open approval, a bare "yes" or "no" applies to it.
   - With more than one open, the queue agent asks the user to name the id (for example "approve Q-012"), and never guesses.
6. **Hook scope.**
   - Project-level only, in `shopify-shop-demo/.claude/settings.json`.
   - Cloud sessions can't reach localhost and aren't monitored.
   - The dashboard repo itself isn't monitored, but `PROJECT_DIR` makes that possible later.
7. **Old ledger.**
   - `pipeline.py status` showed no open tasks on 2026-10-29, so nothing is still running through the old chain. `intake` and `dispatcher` can be retired.
   - The dashboard still shows old rows under their old stage names.
