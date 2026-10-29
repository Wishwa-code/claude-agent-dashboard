# Two (or more) queues, clear names, cost per task, and a better flow view: design

- **Date:** 2026-10-29
- **Status:** approved by the user 2026-10-29
- **Builds on:** `2026-10-29-task-queue-and-dashboard-design.md` (v1, built and merged the same day).
- **Repos:**
  - this repo holds the dashboard;
  - `~/Desktop/shopify-shop-demo` holds `claude/scripts/pipeline/pipeline.py`, the `/queue` and `/browser-agent` skills, and `.claude/agents/analyst.md`.

> **Read the current code first.** After v1 was merged, another session changed the queue to "cloud first" (commit `f72594c` in the shop repo):
> - `pipeline.py` gained `cloud-start`, `wait-cloud`, `cloud-collect` and `place`, a stage `in-cloud`, and per-task files `cloud.json`, `cloud-prompt.md` and `reply.md`;
> - the `/queue` skill runs analysis in claude.ai/code cloud sessions by default.
>
> Everything below extends that. Don't undo it.

## 1. Intent

1. **Separate lines of work.** The user often switches between unrelated tasks and then goes back to the earlier one. They want each line of work in its own queue tab, so that tab's context only holds that work, and each queue stays small, which also keeps tokens down.
2. **Recognise every box on the dashboard at a glance.** Today, tabs without a role show under "Other sessions" with Claude Code's own names (`shopify-shop-demo-47`), which change when VS Code restarts.
3. **See what each task cost in money,** not only in tokens.
4. **A clearer, nicer flow view** of who is working on what, and of how each task moved through the pipeline.

## 2. Decisions made with the user

- **Every `/queue` in a new tab starts a new queue,** numbered Queue 1, Queue 2, … The number stays with it.
- **A queue whose tab closed with unfinished tasks.** The next `/queue` finds it (open tasks, no live session) and asks: "Queue 1 has 2 unfinished tasks. Continue Queue 1, or start a new Queue 3?" With no such queue, it starts a new one without asking.
- **Each task belongs to the queue that took it.** Only that queue runs its analysis (cloud or local), asks for and records its approvals, sends it to the browser agent and gets its result. A bare "yes" in a queue's chat can only answer that queue's open questions.
- **One browser agent serves every queue,** one work order at a time, first come first served. It replies to whichever queue sent the task, and it also writes the result into the store (as it already did for Q-002 when the sending tab had closed).
- **Display names** are by role, with a number fixed for the day: **Queue 1**, **Queue 2**, **Browser agent**, then **Session 1**, **Session 2** for tabs without a role. The Claude Code name goes underneath, in small text.
- **Cost:** shown as **API-equivalent dollars** per task, per session and per subagent, with a plain note saying it isn't the user's bill. Claude Code on Pro/Max is a flat subscription with usage limits; this is from the researcher's own knowledge, and the builder confirms it on claude.com/pricing.
- **Tasks analysed in the cloud** are marked "analysed in cloud". Their cloud tokens aren't in local transcripts, so the cost only counts the local parts (the queue's share and the browser worker). The label says so, so a low number doesn't mislead.
- **Flow view:**
  - Keep the custom SVG. No graph library: the layout is small and fixed, so a library adds weight without solving anything.
  - Add the three improvements below, plus the task timeline.

## 3. Goals, non-goals, anti-goals

**Goals**
- Any number of queues (practically 1–3) run side by side on one store, with no task handled twice.
- An orphaned queue is never lost: its tasks show on the dashboard with its number, and the next `/queue` offers to continue it.
- Every dashboard box and every task row shows a human label.
- Cost per task, session and subagent, with prices from one table that cites its source and date.
- The flow view shows status at a glance, hand-off history and a per-task timeline.

**Non-goals**
- The agreement checker (still on hold).
- Real billing data from Anthropic's API.
- Counting the tokens of cloud sessions.
- A graph library (Cytoscape, ELK, D3).

**Anti-goals: count as failure even if it works**
- Two queues act on the same task: both send it to the browser, or both answer its approval.
- An approval typed in one queue's chat lands on another queue's task.
- The cost figure is presented as real money without the "API-equivalent, not your bill" note.
- Hidden numbers from cloud-analysed tasks look like cheap tasks without a label.
- The new flow view is slower, or breaks at phone width, or scrolls sideways.

## 4. The queue store (`pipeline.py`, shop repo)

- **Queue identity.**
  - `pl role queue <session-name>` → `pl queue-start <session-name> [--continue N]`. It prints the queue number.
  - It keeps a registry at `~/.local/state/polek-dev/queues.json`, a list of `{n, session, started, last_seen}`, and writes `roles/queue-<n>`.
  - `pl queue-end <n>` marks a queue ended. A queue with open tasks and no live session is an **orphan**.
  - Use `ListAgents` names, or `~/.claude/sessions/*.json` liveness, which the dashboard already reads. Don't read `*.key` files.
- **Ownership.**
  - `pl new` takes `--queue <n>` and writes `"queue": n` on the `queued` row.
  - `status`, `next-ready` and the queue skill's open-approval checks take `--queue <n>` and only list that queue's tasks.
  - Old tasks without `queue` count as Queue 1.
- **Orphans.** `pl orphans` lists queues with open tasks whose session isn't live. `/queue` start calls it and asks the user, as in §2.
- **One browser task at a time across all queues.** Before sending, the queue checks that no task from **any** queue is `with-browser`. If two queues send at once anyway, the browser agent answers the later one with `BROWSER ACK <id>: queued behind <id>` and runs it next. That's already in its skill.
- **Results land in the store.** After forwarding `BROWSER RESULT`, the browser agent also writes `tasks/<id>/result.md` and logs `browser-done`. The owning queue logs `done`. This survives a closed queue tab.
- Keep every existing command, including the cloud ones, working, and keep the first-answer-wins rule.

## 5. Skills (shop repo)

- **`/queue`:**
  - Start registers with `queue-start` (or `--continue N` after the orphan question).
  - It passes `--queue <n>` everywhere, and its chat messages start `Q1 QUEUED Q-012: …` so the user sees which queue is talking.
  - Its first chat line says "This is Queue N".
- **`/browser-agent`:** add the store write in §4. Nothing else changes.

## 6. Dashboard (this repo)

### 6.1 Names

- `snapshot()` gives every session a `label`:
  - `Queue <n>` from `queues.json`;
  - `Browser agent` from `roles/web-worker`;
  - otherwise `Session <k>`, where `k` is fixed by first-seen order for the day and stored in memory per session id.
- The page shows the label everywhere the Claude name shows today (flow boxes, agent cards, messages, tokens), with the Claude name in small text underneath.
- The "Other sessions" heading becomes "Other tabs".

### 6.2 Cost

- `monitor/lib/pricing.js` holds US dollars per million tokens. Source: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-29.

  | Model | Input | Output | Cache write 5 m | Cache write 1 h | Cache read |
  |---|---|---|---|---|---|
  | claude-opus-5-5 | 4 | 20 | 5 | 8 | 0.20 |
  | claude-sonnet-5-5 | 2 | 10 | 2.50 | 4 | 0.10 (check the footnote on that cell; the claude-api skill says 0.20) |
  | claude-haiku-5-5, prompt ≤ 100k | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 |
  | claude-haiku-5-5, prompt > 100k | 0.50 | 2.50 | 0.625 | 1 | 0.05 |
  | claude-fable-5-1 | 10 | 50 | 12.50 | 20 | 0.25 |

- **Match the model id by prefix.** An unknown model shows tokens only, with "no price".
- **Cache writes:** if `message.usage.cache_creation` splits 5 m and 1 h (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`), price each at its own rate. Otherwise use the 5 m rate. The builder checks a real transcript line.
- **Haiku's two tiers** are picked per turn, from that turn's input + cache read + cache write.
- `usage.js` keeps per-model, per-tier totals so the cost can be computed. `/api/tokens` adds `cost` per session, subagent and task.
- The page shows `$0.42` next to the token counts, plus a one-line note on the Tokens tab: "API-equivalent cost at list prices (source, date). On a Pro/Max plan this is not what you pay."
- **Task cost** = the subagents tagged with the task id (as today: `Analyst Q-003`, `Browser worker Q-003`). A task with `cloud.json` shows a "cloud" chip and "analysis ran in the cloud, not counted".

### 6.3 Flow view

1. **Status at a glance.**
   - Box border and fill by state: working (green pulse; respect reduced motion), waiting for you (amber), idle (grey), closed (faded).
   - A badge shows the current task id and how long it has run.
   - One box per queue in the Queue column, each with its own analysts. Cloud analyses show as a small cloud node beside the queue.
2. **Hand-off history.**
   - Edge width grows with the hand-off count over 24 h (1–4 px).
   - A small tick or dot stays at the latest hand-off, labelled with its time.
   - Keep the travelling dot for new hand-offs.
3. **Task timeline under the diagram.**
   - One row per task from the last 24 h, newest on top, grouped by queue.
   - A horizontal bar split into stage segments: queued, analysing or in-cloud, waiting for you, ready, browser, done. Colours come from the existing tokens (`--good`, `--warning`, `--ink-3`, …), and the time axis is shared.
   - On the right: duration and cost.
   - Hover shows each segment's time. Clicking a row highlights that task's path in the diagram (queue → analyst → browser agent).
   - At phone width, rows stack and the axis compresses. No sideways scroll.

## 7. Left to the builder

- The exact SVG styling, animation timing, the timeline's time-axis scale, and the file layout (for example `monitor/lib/labels.js`, or a separate `timeline.js` inlined into the page).
- `queues.json` locking: use the same exclusive-create trick as task ids, or an `fcntl` lock.
- How `/queue` shows its number in VS Code (the first message is enough).

## 8. Order of work (suggested)

1. `pipeline.py`: queues, ownership and orphans, with tests.
2. Skill updates.
3. Names on the dashboard.
4. Pricing and cost, with tests against a sample transcript.
5. Flow view and timeline, checked with a headless screenshot at 1280 and 390 px.
6. Docs and `PROGRESS.md`.

## 9. Settled after the builder check (2026-10-29)

1. **Where the dashboard reads a task's queue and stage times.**
   - `pipeline.jsonl` is append-only, with one row per stage change, each with its `ts`.
   - `monitor/lib/pipeline.js` `readTasks()` already returns `stages[]` with times. The timeline uses those.
   - The queue number comes from the `queue` field on the task's `queued` row.
   - Nothing new is needed in the ledger beyond that field.
2. **Matching a queue to a live tab (Claude's call).**
   - `queues.json` stores the Claude **session id** (`sessionId` in `~/.claude/sessions/<pid>.json`) and the name, not the name alone.
   - A queue is live if a live session file with that id exists (and its pid is alive).
   - `--continue N` rebinds queue N to the new tab's session id.
   - The queue skill gets its own session id from the newest `~/.claude/sessions/*.json` whose `name` matches its `ListAgents` name.
3. **A result whose queue tab has closed (Claude's call).**
   - Only `with-browser` occupies the browser. `browser-done` frees it.
   - The browser agent writes `result.md` and logs `browser-done`, as it did for Q-002.
   - When `/queue` continues an orphaned queue, it first closes that queue's `browser-done` tasks (`log done`) and reports their results to the user.
   - Until then the dashboard shows them as "finished in browser, queue closed".
4. **Approvals (Claude's call).**
   - Answers are keyed by task id, as today.
   - A queue only records chat answers for tasks whose `queue` is its own number, and refuses others ("Q-014 belongs to Queue 2").
   - Dashboard answers need no queue check: they go to the store, and the owning queue's `wait-answer` wakes up.
5. **Sonnet cache-read price (Claude's call).** The official pricing page wins over the skill's copy. The builder reads that cell's footnote while building and uses whatever the page says applies. The table records the date and URL.
6. **"Session k" numbers (Claude's call).** Keep them in `~/.local/state/claude-dashboard/labels.json`, so a dashboard restart doesn't renumber. Reset at local midnight.
7. **Old tasks with no queue (Claude's call).** Show them under "Earlier (before queues)", not as Queue 1. No queue is shown unless it was registered.
