# Claude Agent Dashboard: progress log

Read this first. It records the goal, the decisions made so far, and what to do next, so that any agent or session can continue the work.

- **Owner:** Wishwa (wishwa-code)
- **Started:** 2026-10-29
- **This folder** `~/Desktop/claude-agent-dashboard/` is the project's own git repo (branch `main`, local only so far, no GitHub remote yet).
- **Code:** `monitor/server.js` + `monitor/index.html`. Run with `node monitor/server.js`, served at http://localhost:4020. Set `PROJECT_DIR` to watch a project other than the default `~/Desktop/shopify-shop-demo`.
- Moved here on 2026-10-29 from `shopify-shop-demo/claude/scripts/agent-monitor/`. Its earlier history is in that repo's commit 7158acb.

## 1. What the dashboard is for (requirements)

It shows live how work moves through the Polek agent pipeline, which is described in `shopify-shop-demo/claude/CLAUDE.md` under "Agent pipeline":

    You → Intake (/intake) → Dispatcher (/dispatcher) → Planners (Sonnet subagents) → Web worker (/browser-agent)

Must have:
1. **Who handed work to whom**: you → session, session → session, session → subagent, drawn as a live diagram.
2. **Per session:** current task, current step (tool), busy/idle/closed, role (intake / dispatcher / web-worker), activity over the last 3 h, and task history.
3. **Pipeline tasks:** stages from the ledger `~/.local/state/polek-dev/pipeline.jsonl`, which `claude/scripts/pipeline/pipeline.py` writes.
4. **Message protocol:** messages whose first line is `PIPELINE <TYPE> <id>: …` or `BROWSER TASK|ACK|QUESTION|RESULT <id>`. The Messages tab shows only that first line.
5. **Cost:** tokens and an approximate cost per task, session and subagent. A planner that does almost nothing still uses about 42k tokens, so the user needs to see which tasks are expensive.
6. **Local and read-only:** listen on 127.0.0.1 only, never read `~/.claude/sessions/*.key`, never block Claude Code.

## 2. Current state (v1, 2026-10-25)

- It polls `/api/sessions`, which re-reads every time: `~/.claude/sessions/<pid>.json` (live sessions) and the tail of each transcript in `~/.claude/projects/<project>/*.jsonl`.
- **Weakness:** both sources are undocumented internals of Claude Code, so they can change with any update. It has no stored history (everything is rebuilt from transcript tails, up to 24 MB each), no token or cost data, and no push updates.
- It has no dependencies (only Node built-ins). Keep it that way unless there's a reason to change.

## 3. References

Official Anthropic docs:
- Hooks reference: https://code.claude.com/docs/en/hooks
  - Lists 30+ events.
  - Common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id`. Subagent events add `agent_id` and `agent_type`.
  - **HTTP hooks** (`"type":"http","url":…`) POST the event JSON directly. Command hooks can be `async: true`.
- Hooks guide: https://docs.anthropic.com/en/docs/claude-code/hooks-guide
- OpenTelemetry monitoring (`claude_code.token.usage`, `claude_code.cost.usage`, …): https://code.claude.com/docs/en/monitoring-usage
- Agent SDK observability: https://code.claude.com/docs/en/agent-sdk/observability

The open-source reference this builds on:
- **hoangsonww/Claude-Code-Agent-Monitor** ("CCAM"): https://github.com/hoangsonww/Claude-Code-Agent-Monitor. MIT, about 1.1k stars, last pushed 2026-10-23. It's a large project: Express + React/Vite + SQLite + WebSocket, with Claude, Codex and Cursor support, 14 plugins, i18n and a desktop app.
  - `reference/ccam-ARCHITECTURE.md`: their full design doc (3k lines). The useful parts:
    - "Data Flow" (line ~226)
    - "Database Design" (~916)
    - "WebSocket Protocol" (~1133)
    - "Hook Integration" (~1217)
    - "Import Pipeline" (~1286)
  - `reference/ccam-hook-handler.js`: their fail-safe hook forwarder.

Other similar projects (not reviewed yet): disler/claude-code-hooks-multi-agent-observability, simple10/agents-observe, claude-code-kanban.

## 4. Concepts to take from CCAM

| CCAM concept | Why we want it |
| --- | --- |
| Hooks → a small forwarder → `POST /api/hooks/event` | This is the documented interface, so it replaces our reliance on the internal files |
| The forwarder always exits 0, with a 3 s HTTP timeout and a 5 s safety net | It never slows down or blocks Claude Code |
| SQLite (WAL) tables `sessions`, `agents` (with `parent_agent_id`), `events`, `token_usage` | History survives restarts. `parent_agent_id` gives the subagent tree |
| Live hooks and the transcript import share **one parser** | A backfill and the live data give identical numbers |
| Token usage taken from transcript `message.usage`, per session and model | Gives us requirement 5, cost |
| Push updates (WebSocket envelope `{type, data, timestamp}`) | No polling. For us, SSE is enough and needs no dependency |
| Agent states `working / waiting / completed / error` plus `awaiting_input_since` | A clearer status than busy/idle |

What we won't copy: Codex/Cursor support, plugins/marketplace, i18n, the desktop app, the companion "Tabby", remote sources, or webhooks. Those are out of scope.

## 5. Recommended approach (decision pending: confirm with the user)

**Evolve our own monitor using CCAM's architecture. Don't fork CCAM.** CCAM is far bigger than we need, and it installs hooks into the global `~/.claude/settings.json`. Our pipeline-specific views (roles, ledger, PIPELINE/BROWSER messages, the handoff diagram) don't exist in CCAM in any case.

Optional quick look: run CCAM once on port 4820 to see its UI and decide which views are worth copying, then remove its hooks again.

Planned phases:
- [x] **P1: Ingest.** Add HTTP hooks to `shopify-shop-demo/.claude/settings.json` (project-level, so other projects are not affected) for these events:
  - `SessionStart`, `SessionEnd`
  - `UserPromptSubmit`
  - `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
  - `SubagentStart`, `SubagentStop`
  - `Stop`, `Notification`

  Each hook POSTs to `http://127.0.0.1:4020/api/hooks/event`. Check first that a connection failure is silent (the HTTP hooks docs say non-2xx/timeout is non-blocking by default).
- [x] **P2: Store.** Use `node:sqlite` (built into Node 22, so no dependency; it works on this machine with Node v22.18.0 and prints an experimental warning). Tables follow CCAM's `sessions / agents / events / token_usage`, plus our `handoffs` (from → to, kind, task id, first line).
- [x] **P3: Shared parser and backfill.** Move the current `toEvents()` transcript parser into a module that both the hook path and a one-off import use. Add token usage from `message.usage`.
- [x] **P4: Push.** An SSE endpoint `/api/stream`, so `index.html` updates on events instead of polling.
- [x] **P5: Views.** Keep the handoff diagram. Add cost per task, session and subagent, a subagent tree from `parent_agent_id`, and the pipeline stage timeline.
- [x] **P6: Fallback.** Keep the transcript reader for sessions that started before the hooks existed. Phase it out later.

## 6. Open questions for the user

- ~~Where should the code live?~~ Decided 2026-10-29: in this repo.
- ~~Run CCAM once?~~ Not wanted (2026-10-29). CCAM is a code reference only. Its full source is cloned in `vendor/ccam/` (git-ignored, commit 3cb22ae, read only, never run). Don't run it natively: on every start it writes its hooks into the global `~/.claude/settings.json`, and it needs Node 22.22+ while this machine has 22.18.
- Should this repo get a private GitHub remote?
- Cost figures: are approximate prices per model enough? (The official docs say telemetry cost is an approximation.)

## 7. Log

- **2026-10-29:** Researched the official docs and open-source dashboards. Picked CCAM as the reference. Saved its architecture doc and hook forwarder in `reference/`. Wrote the requirements and the recommended approach. No code changes yet.
- **2026-10-29:** Moved the monitor code here and made this folder a git repo. `PROJECT_DIR` now comes from an env var instead of the code's own path. Tested on port 4029: 3 sessions and 2 links returned, page 200. Updated the shop repo's `claude/CLAUDE.md` to point here.
- **2026-10-29:** Spike S1 passed: Claude Code HTTP hooks to a port with nothing listening show no error and add no delay. With a listener, the events arrive. The dashboard hooks use `type: "http"`.
- **2026-10-29:** The analyst agent works. On a test run it asked instead of guessing on an unclear task, and wrote a work order with an approval question for an amber one. Its startup context is 17k (the general-purpose planners used about 41k). Spike S3 passed: continuing an analyst costs 5.4k on its first turn against 22.2k for a fresh one, so reuse stays.
- **2026-10-29: built on branch `feat/task-queue`** (both repos, not merged yet).
  - **Dashboard:** hooks → SQLite → SSE; Queue tab with approvals; Tokens tab with context warnings; `/api/tasks`, `/api/tokens`, `/api/tasks/:id/answer` (origin + per-run token + Host check). `npm test`: 18/18.
  - **Polek repo:**
    - `pipeline.py` v2: Q-ids, task folders, `ask`/`answer`/`wait-answer`/`next-ready`; 10 tests.
    - `analyst` agent and context pack.
    - `/queue` skill (Intake and Dispatcher retired).
    - Browser agent runs each work order in a fresh subagent.
    - HTTP hooks.
  - **Still to verify, with the user:**
    - spike S2: can a subagent drive the logged-in browser? Needs a live `/browser-agent`;
    - a dry run of `/queue`;
    - one real approved task end to end.
  - **On hold:** the agreement checker (Lighthouse + visual-check after each task); stage `checking` is reserved for it.
