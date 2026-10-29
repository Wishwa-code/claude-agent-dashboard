# Multiple queues, names, cost per task and flow view: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any number of `/queue` tabs work side by side on one store. Every dashboard box has a human name. Every task, session and subagent shows an API-equivalent dollar cost. The flow view shows status, hand-off history and a per-task timeline.

**Architecture:**
- `pipeline.py` (shop repo) gains a queue registry (`queues.json`, locked with `fcntl`) and a `queue` field on each task's `queued` row. Every listing command can filter by queue.
- The dashboard reads the registry to label sessions. It prices each transcript turn from one table in `lib/pricing.js`, and computes timeline segments server-side from the ledger's stage rows.
- The page stays one file with custom SVG and no dependencies.

**Tech Stack:** Python 3 stdlib with `unittest` (shop repo). Node 22 built-ins with `node:test`, plus inline JS/CSS in `monitor/index.html` (dashboard repo). Screenshots come from the `puppeteer-core` already installed in `shopify-shop-demo/claude/scripts/visual-check/`.

**Spec:** `docs/superpowers/specs/2026-10-29-multi-queue-cost-and-flow-design.md`

## Global Constraints

- Keep every existing `pipeline.py` command working, cloud ones included, and keep first-answer-wins (spec §4).
- Old tasks without `queue` are shown under **"Earlier (before queues)"**, not as Queue 1. A queue is shown only if it was registered (spec §9.7; this overrides §4 "count as Queue 1").
- Never read `~/.claude/sessions/*.key`. The dashboard stays read-only apart from answers, and listens on 127.0.0.1 only.
- Labels: `Queue <n>`, `Browser agent`, `Session <k>`. The Claude name goes underneath in small text. "Other sessions" becomes **"Other tabs"**.
- `Session k` numbers persist in `~/.local/state/claude-dashboard/labels.json` and reset at local midnight.
- Cost note, verbatim: "API-equivalent cost at list prices (platform.claude.com pricing, read 2026-10-29). On a Pro/Max plan this is not what you pay."
- Cloud-analysed tasks show a "cloud" chip and the text "analysis ran in the cloud, not counted".
- Prices in USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-29. Sonnet 5.5 cache read is **0.10** (footnote 2: 0.05× input). Two rows extend the spec table because they appear in local transcripts:

  | prefix | in | out | cw5m | cw1h | cr |
  |---|---|---|---|---|---|
  | claude-opus-5-5 | 4 | 20 | 5 | 8 | 0.20 |
  | claude-opus-5 | 5 | 25 | 6.25 | 10 | 0.50 |
  | claude-sonnet-5-5 | 2 | 10 | 2.50 | 4 | 0.10 |
  | claude-sonnet-5 | 2 | 10 | 2.50 | 4 | 0.20 |
  | claude-haiku-5-5 (prompt ≤ 100k) | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 |
  | claude-haiku-5-5 (prompt > 100k) | 0.50 | 2.50 | 0.625 | 1 | 0.05 |
  | claude-fable-5-1 | 10 | 50 | 12.50 | 20 | 0.25 |
- No graph library. No new npm dependencies.
- The flow view must not scroll sideways at 390 px, and must respect `prefers-reduced-motion`.
- Commit on branch `feat/multi-queue` in both repos. Never commit `.env*`, `CLAUDE.local.md` or `claude/history/`. Run a secret scan before each shop-repo commit.

## Review Focus

1. **The same tab runs `/queue` twice** (for example after `/clear`). `queue-start` for a session id that already owns a live queue must return that queue's number, not register a second queue. Test: `test_queue_start_same_session_reuses_number`.
2. **A dead pid whose session file is left behind** (VS Code crash). Liveness must check the pid, not only that the file exists, so the queue shows as an orphan. Test: `test_orphan_when_pid_dead`.
3. **A chat answer from Queue 1 for Queue 2's task.** `answer --queue 1` must refuse with exit 4 and write nothing. A dashboard answer (no `--queue`) must still work. Test: `test_answer_refuses_other_queue`.
4. **A transcript turn with no `cache_creation` split** (older Claude Code) or an unknown model (`<synthetic>`). Cost uses the 5 m rate, and an unknown model adds to `unpriced` tokens, never NaN. Test: `pricing: missing split and unknown model`.
5. **A task with only a `queued` row, or one still open**: its last timeline segment ends at "now", and it is never negative. Test: `stageSegments open task ends at now`.

---

### Task 1: Queue registry, ownership and orphans in `pipeline.py`

**Files:**
- Modify: `~/Desktop/shopify-shop-demo/claude/scripts/pipeline/pipeline.py`
- Test: `~/Desktop/shopify-shop-demo/claude/scripts/pipeline/test_pipeline.py`

**Interfaces:**
- Produces (CLI):
  - `queue-start <name> [--continue N] [--session-id ID]` prints `N`. Without `--session-id`, it finds the newest live `<SESSIONS>/*.json` whose `name` equals `<name>`, and exits 2 if there is none. Writes `roles/queue-<n>` (`name\nts\n`).
  - `queue-end <n>`
  - `queues` prints one line per queue: `Queue <n>  live|closed|ended  open: <k>  <name>`.
  - `orphans` prints `Queue <n>: <k> unfinished (<ids>)` lines, or `none`.
  - `new … --queue N`
  - `status [--queue N]`
  - `next-ready [--queue N]`
  - `browser-busy` prints the id of any task in `with-browser` across all queues, or `none`.
  - `answer <id> --by chat --queue N -- …` exits 4 with `Q-014 belongs to Queue 2` when the owner differs.
  - `answer` without `--queue` is unchanged.
- Produces (files):
  - `queues.json`: `[{"n":1,"session":"<sessionId>","name":"shopify-shop-demo-47","started":ts,"last_seen":ts,"ended":null|ts}]`
  - A `"queue": N` key on the `queued` row.
  - `tasks()` entries gain `"queue": N|None`.
- Env: `CLAUDE_SESSIONS` overrides `~/.claude/sessions` (for tests).

- [ ] **Step 1: Write the failing tests** in `PipelineTest`. Helper `fake_session(name, sid, pid=os.getpid())` writes `<sessions>/<pid>.json` with `{"pid", "sessionId", "name", "updatedAt"}`. Set `CLAUDE_SESSIONS` in `self.env`.
  - `test_queue_start_numbers_and_registry`: two sessions → `queue-start a` prints `1`, `queue-start b` prints `2`. `queues.json` has `n` 1 and 2 with the right `session` ids, and `roles/queue-1` exists.
  - `test_queue_start_same_session_reuses_number`: `queue-start a` twice → both print `1`, and the registry has one entry.
  - `test_queue_start_unknown_name_fails`: exit code 2.
  - `test_new_with_queue_and_filtered_status`: `new t1 --queue 1`, `new t2 --queue 2` → `status --queue 1` lists Q-001 and not Q-002. `next-ready --queue 2` after `log Q-002 ready` → `Q-002`, and `next-ready --queue 1` → `none`.
  - `test_orphan_when_pid_dead`: register queue 1 with a session file whose pid is 999999 (dead), plus `new x --queue 1` → `orphans` contains `Queue 1: 1 unfinished (Q-001)`. A live queue with open tasks is not listed.
  - `test_continue_rebinds_session`: queue 1 is orphaned; a new session `c` runs `queue-start c --continue 1` → prints `1`, registry entry 1 has `session` = c's id, and `orphans` → `none`.
  - `test_answer_refuses_other_queue`: `new x --queue 2` then `answer Q-001 --by chat --queue 1 -- yes` → exit 4, `belongs to Queue 2` in the output, no `answer.json`. `answer Q-001 --by dashboard -- yes` → exit 0.
  - `test_browser_busy_across_queues`: Q-001 (queue 1) logged `with-browser` → `browser-busy` prints `Q-001`; after `log Q-001 browser-done` it prints `none`.
  - `test_old_task_has_no_queue`: `new x` (no `--queue`) → the ledger's queued row has no `queue` key, and `status --queue 1` doesn't list it.

- [ ] **Step 2: Run** `python3 -m unittest claude/scripts/pipeline/test_pipeline.py -v` (shop repo root). Expected: the 9 new tests FAIL (unknown command or argument). The old tests pass.

- [ ] **Step 3: Implement.**
  - `QUEUES = os.path.join(STATE, "queues.json")` and `SESSIONS = os.environ.get("CLAUDE_SESSIONS") or ~/.claude/sessions`.
  - `read_queues()`, and `write_queues(qs)` under `fcntl.flock` on `queues.json.lock`, done as read-modify-write in one locked section: `with_queues(fn)`.
  - `live_session_ids() -> dict[sessionId, name]`: read only `^\d+\.json$` files and keep those whose pid is alive (`os.kill(pid, 0)`, where `PermissionError` counts as alive).
  - `cmd_queue_start`, `cmd_queue_end`, `cmd_queues`, `cmd_orphans`, `cmd_browser_busy`.
  - The `--queue` argument on `new`, `status`, `next-ready` and `answer`.
  - Update the module docstring's command list.

- [ ] **Step 4: Run** the same command. Expected: all tests pass (old + 9 new).

- [ ] **Step 5: Commit** on `feat/multi-queue` in the shop repo, after a secret scan of the staged diff:

  ```bash
  git add claude/scripts/pipeline/pipeline.py claude/scripts/pipeline/test_pipeline.py
  git commit -m "Pipeline: numbered queues, task ownership, orphans"
  ```

### Task 2: `/queue` and `/browser-agent` skills

**Files:**
- Modify: `~/Desktop/shopify-shop-demo/.claude/skills/queue/SKILL.md`
- Modify: `~/Desktop/shopify-shop-demo/.claude/skills/browser-agent/SKILL.md`
- Modify: `~/Desktop/shopify-shop-demo/claude/CLAUDE.md` ("Task queue" section: one line on multiple queues)

**Interfaces:**
- Consumes: the Task 1 CLI.

- [ ] **Step 1: Edit the `/queue` Start section.**
  1. `ListAgents` → name.
  2. `pl orphans`. If it lists queues, ask "Queue N has K unfinished tasks. Continue Queue N, or start a new Queue M?" (M = highest + 1). With none, don't ask.
  3. `pl queue-start <name> [--continue N]` → N.
  4. If continuing: for each of that queue's `browser-done` tasks, read `result.md`, run `pl log <id> done --by queue`, and report it.
  5. First chat line: "This is Queue N. Browser agent: … Open: K."

  Throughout the skill:
  - Every `pl new`, `status` and `next-ready` gets `--queue N`. Chat answers use `pl answer <id> --by chat --queue N -- …`; exit 4 means "Q-014 belongs to Queue 2", so tell the user and don't record it.
  - Chat lines are prefixed `QN `, for example `Q1 QUEUED Q-012: …`.
  - Before sending to the browser: `pl browser-busy` must print `none`.
  - A bare "yes" applies only to this queue's open approvals.
  - End of role: `pl queue-end N`.

- [ ] **Step 2: Edit `/browser-agent`.** In step 7, after replying: write the reply to `tasks/<id>/result.md` and run `pl log <id> browser-done --by web-worker`. This survives a closed queue tab. Nothing else changes.

- [ ] **Step 3: Check** with `grep -n "queue-start\|--queue\|browser-busy\|queue-end" .claude/skills/queue/SKILL.md` (at least 5 hits) and `grep -n "browser-done" .claude/skills/browser-agent/SKILL.md` (1 hit).

- [ ] **Step 4: Commit** (secret scan first): `git commit -m "Queue skill: numbered queues; browser agent writes results to the store"`

### Task 3: Display names on the dashboard

**Files:**
- Create: `monitor/lib/labels.js`
- Modify: `monitor/lib/pipeline.js` (`queue` on tasks)
- Modify: `monitor/server.js` (`snapshot()`, `tokensView()`)
- Modify: `monitor/index.html` (`display()`, boxes, cards, "Other tabs")
- Test: `monitor/test/labels.test.js`, `monitor/test/api.test.js`

**Interfaces:**
- Produces:
  - `readQueues(stateDir) -> [{n, session, name, ended}]`
  - `createLabeller(file, now = () => new Date()) -> { label(session: {id, name}, ctx: {queues, browserAgentName}) -> {label, kind: 'queue'|'browser'|'session', queue?: n} }`. Session numbers persist to `file` as `{day: 'YYYY-MM-DD', next, ids: {sessionId: k}}`, and the counter resets when the local date changes.
  - `readTasks()` rows gain `queue: n|null`.
  - `/api/sessions` sessions gain `label`, `kind`, `queue`. The top level gains `queues: [{n, sessionId, name, live, open}]`.
  - `/api/tokens` sessions gain `label`.

- [ ] **Step 1: Write the failing tests.**
  - `labels.test.js`:
    - `queue label from registry` (session id in queues → `Queue 2`, kind `queue`, queue 2).
    - `browser agent by name`.
    - `session numbers are stable and persisted` (ids a, b → Session 1, 2; a new labeller on the same file still gives a → Session 1).
    - `numbers reset at local midnight` (a `now` stub on the next day → the first new id is Session 1).
  - `api.test.js`: `tasks carry their queue`. In `before`, also run `pl new 'Footer' --queue 1`; expect Q-002 `queue === 1` and Q-001 `queue === null`.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL (module missing, `queue` undefined).
- [ ] **Step 3: Implement.**
  - `lib/labels.js` as above.
  - `readTasks` takes `queue` from the row with `stage === 'queued'`.
  - In `snapshot()`, call the labeller after names are resolved. Build `queues` from `readQueues` + `liveSessions()` + the open-task count per queue.
  - `LABELS_FILE` env defaults to `~/.local/state/claude-dashboard/labels.json`.
  - In `index.html`:
    - `display(name)` returns `byName[name]?.label || name`.
    - Every place that shows a role label (flow box `n1`, agent card `h3`, chips, Tokens rows) shows the label, with the Claude name in `.n0`/`.sn` small text.
    - `roleOf` keeps working for the browser agent; queue sessions are recognised by `kind === 'queue'`.
    - The heading reads `OTHER TABS`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit:** `git commit -m "Dashboard: Queue N / Browser agent / Session k labels"`

### Task 4: Pricing and cost

**Files:**
- Create: `monitor/lib/pricing.js`
- Modify: `monitor/lib/usage.js` (`addLine` prices each turn)
- Modify: `monitor/lib/pipeline.js` (`cloud: true` when `tasks/<id>/cloud.json` exists)
- Modify: `monitor/server.js` (`tokensView` adds `cost`, `unpriced`)
- Modify: `monitor/index.html` (Tokens tab, queue cards)
- Test: `monitor/test/pricing.test.js`, `monitor/test/usage.test.js`

**Interfaces:**
- Produces:
  - `PRICES` (the Global Constraints table, keyed by prefix; Haiku has `{tiers: [{upTo: 100000, …}, {…}]}`), plus `SOURCE = {url, read: '2026-10-29'}`.
  - `priceFor(model) -> row|null`: longest matching prefix wins.
  - `turnCost(model, {inp, cw5, cw1h, cr, out}) -> number|null` (USD; null for an unknown model).
  - The usage state gains `cost` (USD) and `unpriced` (tokens of unknown-model turns).
  - `byModel` rows keep `inp, cw, cr, out` (cw = cw5 + cw1h) so `inputEq` is unchanged.
  - `/api/tokens`: sessions, subagents and tasks gain `cost` and `unpriced`. Tasks gain `cloud: bool`, and sessions gain `subagentsCost`. The top level gains `pricing: SOURCE`.

- [ ] **Step 1: Write the failing tests** (`pricing.test.js`).
  - `opus 5.5 with 1h split`: `turnCost('claude-opus-5-5', {inp:2, cw5:0, cw1h:25535, cr:25459, out:234})` ≈ `(2*4 + 25535*8 + 25459*0.20 + 234*20)/1e6` (within 1e-9). This is a real line from this machine's transcript.
  - `prefix: sonnet-5 vs sonnet-5-5`: cr prices are 0.20 and 0.10.
  - `haiku tier by prompt size`: 100000 prompt tokens → low tier; 100001 → high tier.
  - `pricing: missing split and unknown model`: in `usage.test.js`, a line with `cache_creation_input_tokens: 1000` and no `cache_creation` object prices at the 5 m rate; a `<synthetic>` line adds its tokens to `unpriced` and leaves `cost` finite.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - `lib/pricing.js`.
  - In `addLine`, read `u.cache_creation?.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. Without a split, all of `cache_creation_input_tokens` is 5 m.
  - `tokensView` sums cost like `inputEq`. `cloud` comes from `readTasks` (task ids in the ledger), so tasks with no subagent rows still appear when cloud.
  - `index.html`:
    - `money(x)` gives `$0.42`, `<$0.01`, or `no price` when only unpriced tokens exist.
    - Show it next to token counts on session rows, subagent rows, task rows and queue cards.
    - Put the verbatim note under the Tokens tab heading.
    - Cloud tasks get `<span class="where cloud">cloud</span>` plus "analysis ran in the cloud, not counted".
- [ ] **Step 4: Run** `npm test`. Expected: all pass. Then `curl -s localhost:<port>/api/tokens | python3 -m json.tool | grep -m3 cost` against a test server on the real transcripts shows non-zero costs.
- [ ] **Step 5: Commit:** `git commit -m "Cost per task, session and subagent at API list prices"`

### Task 5: Flow view (status, one box per queue, hand-off history)

**Files:**
- Modify: `monitor/index.html` (`visible`, `computeLayout`, `nodeContent`, `updateFlow`, CSS)

**Interfaces:**
- Consumes: `data.queues`, `session.kind/queue/label` (Task 3), and `qtasks[].queue/stage/stages` (Task 3).
- Produces: node keys
  - `q:<n>` (queue box, bound to its session name when live);
  - `sp:<id>` analysts, attributed to the spawning queue's session;
  - `cloud:<n>` (a small node beside queue n when that queue has `in-cloud` tasks, showing the count).

  Edges `q:<n>`→`cloud:<n>` are dashed. The state class on `.node` is one of `working | waiting | idle | closed`.

- [ ] **Step 1: Implement.**
  - **Queue column:** one box per registered, non-ended queue, plus ended ones that still have open tasks (shown as closed/orphan: "Queue 1 · closed, 2 unfinished"). The Analysts column lists every queue's spawns. Keep the order queue n, then spawn time.
  - **States:**
    - `working` when the session is busy: green border, plus a pulse animation (`@keyframes pulse` on box-shadow, off under reduced motion).
    - `waiting` when that queue owns an `awaiting-approval` task without an answer, or the session status is neither busy nor idle: amber border and tinted fill.
    - `idle`: grey.
    - `closed`: faded.
  - **Badge:** the current task id and `dur()` since its last stage row. For a queue, use its newest open task. For the browser agent, use the `with-browser` task.
  - **Edges:** stroke width `1 + 3 * min(count, 12) / 12` (1–4 px). A dot (`circle r=3`) sits at the Bezier point t = 0.92, with a `<title>` and a small `hhmm(last)` text label when not narrow. Keep `launch()` for new hand-offs.
- [ ] **Step 2: Verify** with a headless screenshot script `tools/shot.js` (uses `puppeteer-core` from `~/Desktop/shopify-shop-demo/claude/scripts/visual-check/node_modules`, and the same Chrome path as `check.js`). Run it against a test server (`PORT=4031`, `PIPELINE_STATE` = a temp copy of the real state with a 2-queue registry) at 1280 and 390 px. It prints `scrollWidth <= clientWidth` for `document.documentElement`. Expected: `no sideways scroll` at both widths. Look at both PNGs: two queue boxes, a cloud node when present, and visible state colours.
- [ ] **Step 3: Commit:** `git commit -m "Flow view: one box per queue, states, hand-off weight and last-time dots"`

### Task 6: Task timeline

**Files:**
- Modify: `monitor/lib/pipeline.js` (`stageSegments`)
- Modify: `monitor/index.html` (timeline section under the diagram)
- Test: `monitor/test/pipeline.test.js` (new)

**Interfaces:**
- Produces:
  - `stageSegments(task, nowMs) -> [{stage, group, start: ms, end: ms}]`.
    - `group` is one of `queued | analysing | waiting | ready | browser | done | stopped`.
    - Consecutive stage rows become segments, and each segment ends at the next row's `ts`.
    - An open task's last segment ends at `nowMs`. A closed task's terminal stage is a zero-length marker.
    - Group mapping: `in-cloud` and `analysing` → `analysing`; `awaiting-approval` → `waiting`; `with-browser` and `browser-done` → `browser`; `cancelled|blocked|failed` → `stopped`.
  - `readTasks(stateDir, nowMs = Date.now())` rows gain `segments`.

- [ ] **Step 1: Write the failing tests** (`pipeline.test.js`).
  - `stageSegments maps groups and joins rows`: rows queued 10:00, in-cloud 10:01, awaiting-approval 10:05, ready 10:07, with-browser 10:08, browser-done 10:12, done 10:12 → groups `[queued, analysing, waiting, ready, browser, browser, done]`. The first segment is 60000 ms long.
  - `stageSegments open task ends at now`: a single `queued` row and now = row + 5 min → one segment with end − start = 300000 and end ≥ start.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (`stageSegments` is not a function).
- [ ] **Step 3: Implement** `stageSegments` and the page section `<section class="card" id="timeline">`.
  - Rows are tasks with activity in the last 24 h, grouped under headings `Queue N` and then "Earlier (before queues)", newest first.
  - Each row is a grid: `id + title | bar | duration + cost`. The bar is absolutely positioned segments on a shared axis from the earliest row start to now.
  - Colours: queued `--ink-3`, analysing `--s0`, waiting `--warning`, ready `--line-2`, browser `--s6`, done `--good`, stopped `--critical`.
  - Each segment's `title` gives the stage and duration.
  - Clicking a row adds `.hl` to `q:<n>`, to `sp:*` nodes whose name ends with the task id, and to the browser agent box, plus the edges between them. Other nodes get `.dim`. Clicking again clears it.
  - At ≤ 640 px the grid becomes one column, with the bar full width under the title and the axis labels reduced to start/now.
- [ ] **Step 4: Run** `npm test` and the Task 5 screenshot script. Expected: tests pass, `no sideways scroll` at 390 and 1280 px, and the timeline is visible in both PNGs.
- [ ] **Step 5: Commit:** `git commit -m "Task timeline grouped by queue, with click-to-highlight path"`

### Task 7: Docs and progress

**Files:**
- Modify: `README.md` and `PROGRESS.md` (dashboard repo)
- Modify: spec status line → "built 2026-10-29"

- [ ] **Step 1:** Add a dated log entry to `PROGRESS.md`: what was built, test counts from both suites, and what still needs a real two-tab dry run with the user.
- [ ] **Step 2:** Run both suites one last time:
  - `npm test` (dashboard);
  - `python3 -m unittest claude/scripts/pipeline/test_pipeline.py` (shop).

  Expected: all pass.
- [ ] **Step 3: Commit:** `git commit -m "Docs: multi-queue, cost and flow view"`
