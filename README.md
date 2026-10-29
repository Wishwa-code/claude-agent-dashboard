# Claude agent dashboard

A local, read-mostly dashboard for the Claude Code sessions working on one project (by default the Polek Shopify project, `~/Desktop/shopify-shop-demo`). It shows:

- **Pipeline:** who handed work to whom (You → Queue → Analysts → Browser agent), with each session's current task, step, activity, task history and context size.
- **Queue:** every task from the `/queue` agent, with its stage, the agent on it, waiting time and tokens, plus its request, work order and result. Approvals have Approve/Reject/answer buttons; the same approval can be answered in the queue chat, and the first answer wins.
- **Tokens:** context per session, amber over 200k and red over 400k ("safe to /clear: state is in the queue"); tokens per session, per subagent and per queue task.
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

It never reads `~/.claude/sessions/*.key` or credentials. It listens on 127.0.0.1 only, accepts only `localhost`/`127.0.0.1` Host headers, and records answers only with the page's per-run token from the same origin.

## Settings (environment variables)

| Variable | Default |
|---|---|
| `PORT` | `4020` |
| `PROJECT_DIR` | `~/Desktop/shopify-shop-demo` |
| `PIPELINE_STATE` | `~/.local/state/polek-dev` |
| `PIPELINE_PY` | `~/Desktop/shopify-shop-demo/claude/scripts/pipeline/pipeline.py` |
| `DASHBOARD_DB` | `~/.local/state/claude-dashboard/dashboard.sqlite` |

## Develop

- Node 22, no npm packages.
- Run `npm test` (node:test) to test the server and `python3 -m unittest claude/scripts/pipeline/test_pipeline.py` (in the shop repo) to test the queue store.
- To measure where tokens went: `python3 -I tools/token-report.py ~/.claude/projects/<project-dir-name>`.

Code:

| File | What it does |
|---|---|
| `monitor/server.js` | HTTP routes, the session snapshot and the tokens view |
| `monitor/lib/transcript.js` | Transcript parser |
| `monitor/lib/usage.js` | Token usage |
| `monitor/lib/db.js` | SQLite store |
| `monitor/lib/hooks.js` | Hook events |
| `monitor/lib/sse.js` | Live stream |
| `monitor/lib/pipeline.js` | Queue reader and answers |
| `monitor/index.html` | The page |

The design and plan are in `docs/superpowers/`, and progress is in `PROGRESS.md`. `reference/` holds the CCAM design doc this borrows from.
