# Claude agent dashboard

A local, read-mostly dashboard for the Claude Code sessions working on one project (by default the Polek Shopify project, `~/Desktop/shopify-shop-demo`). It shows:

- **Pipeline:** who handed work to whom (You → Queues → Analysts → Browser agent), with each session's current task, step, activity, task history and context size. Every box has a human name (Queue 1, Queue 2, Browser agent, Session 3) with Claude's own name underneath, and a state: working (green), waiting for you (amber), idle, closed. A **task timeline** below shows each task's stages over the last 24 hours by queue; click a row to light up its path in the diagram.
- **Queue:** every task from the `/queue` agent, with its stage, the agent on it, waiting time and tokens, plus its request, work order and result. Approvals have Approve/Reject/answer buttons; the same approval can be answered in the queue chat, and the first answer wins.
- **Tokens:** context per session, amber over 200k and red over 400k ("safe to /clear: state is in the queue"); tokens and **API-equivalent cost** (list prices in `monitor/lib/pricing.js`, not your Pro/Max bill) per session, per subagent and per queue task. Tasks analysed in the cloud are marked: their cloud tokens are not counted.
- **Messages:** the first line of every message the agents sent each other.

## Run it

```bash
claude-dashboard            # start if needed, open http://localhost:4020
claude-dashboard status     # or: stop, restart
```

In any Claude chat, `/dashboard` does the same. It runs detached; the log is `~/.local/state/claude-dashboard/monitor.log`.

## Where the data comes from

| Source | What | Written by |
|---|---|---|
| `POST /api/hooks/event` | Live hook events: sessions, subagents, tool calls, messages | HTTP hooks in the project's `.claude/settings.json` (silent when the dashboard is off) |
| `~/.local/state/claude-dashboard/dashboard.sqlite` | Stored hook events (SQLite, WAL) | this server |
| `~/.claude/sessions/<pid>.json`, `~/.claude/projects/<project>/*.jsonl` and `*/subagents/` | Live sessions, transcripts, token usage | Claude Code |
| `~/.local/state/polek-dev/pipeline.jsonl` and `tasks/<id>/` | The task queue | `shopify-shop-demo/claude/scripts/pipeline/pipeline.py` |
| `~/.local/state/polek-dev/queues.json` | Numbered queues and their Claude session ids | `pipeline.py queue-start` |
| `~/.local/state/claude-dashboard/labels.json` | "Session k" numbers for the day | this server |

It never reads `~/.claude/sessions/*.key` or credentials. It listens on 127.0.0.1 only, accepts only `localhost`/`127.0.0.1` Host headers, and records answers only with the page's per-run token from the same origin.

## Settings (environment variables)

| Variable | Default |
|---|---|
| `PORT` | `4020` |
| `PROJECT_DIR` | `~/Desktop/shopify-shop-demo` |
| `PIPELINE_STATE` | `~/.local/state/polek-dev` |
| `PIPELINE_PY` | `~/Desktop/shopify-shop-demo/claude/scripts/pipeline/pipeline.py` |
| `DASHBOARD_DB` | `~/.local/state/claude-dashboard/dashboard.sqlite` |
| `LABELS_FILE` | `~/.local/state/claude-dashboard/labels.json` |

## Develop

- Node 22, no npm packages.
- Run `npm test` (node:test) to test the server and `python3 -m unittest claude/scripts/pipeline/test_pipeline.py` (in the shop repo) to test the queue store.
- Screenshots with a sideways-scroll check: `node tools/shot.js [url] [out-prefix]` (1280 and 390 px; uses `puppeteer-core` from the shop repo's `claude/scripts/visual-check/`).
- To measure where tokens went: `python3 -I tools/token-report.py ~/.claude/projects/<project-dir-name>`.

Code:

| File | What it does |
|---|---|
| `monitor/server.js` | HTTP routes, the session snapshot and the tokens view |
| `monitor/lib/transcript.js` | Transcript parser |
| `monitor/lib/usage.js` | Token usage and cost per transcript |
| `monitor/lib/pricing.js` | API list prices per model (source and date inside) |
| `monitor/lib/labels.js` | Queue N / Browser agent / Session k names |
| `monitor/lib/db.js` | SQLite store |
| `monitor/lib/hooks.js` | Hook events |
| `monitor/lib/sse.js` | Live stream |
| `monitor/lib/pipeline.js` | Queue reader, timeline segments and answers |
| `monitor/index.html` | The page |

The design and plan are in `docs/superpowers/`, and progress is in `PROGRESS.md`. `reference/` holds the CCAM design doc this borrows from.
