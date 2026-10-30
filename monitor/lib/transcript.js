// Transcript parsing shared by the live monitor and the hook ingest: turns Claude Code transcript lines into
// display events, names tasks from prompts, and summarises tool calls. Moved out of server.js on 2026-10-29.
'use strict';
const path = require('path');
const os = require('os');

const PROJECT_DIR = path.resolve(process.env.PROJECT_DIR || path.join(os.homedir(), 'Desktop/shopify-shop-demo'));
function clip(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

const FILLER = /^(hey|hi|hello|good morning|okay|okey|ok|yeah|yes|yep|so|alright|right|now|and|also|then|please|pls|can you|could you|would you|i want you to|i want to|lets|let's)\b[\s,.!]*/i;

// A short task name from a free-form prompt: drop filler openers, keep the first clause, cap at ~60 chars.
function taskName(text) {
  const all = clip(text, 400);
  if (all.startsWith('/')) return all.split(' ')[0];
  let t = all;
  for (let i = 0; i < 6 && FILLER.test(t); i++) t = t.replace(FILLER, '');
  if (!t.replace(/[\s.,!?]/g, '')) t = all; // the whole prompt was filler ("hey good morning"): keep it
  t = t.split(/(?<=[.?!])\s|\n/)[0].replace(/[.?!,]+$/, '');
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '') + '…';
  return t ? t[0].toUpperCase() + t.slice(1) : 'Untitled task';
}

const humanise = id => id.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());

function toolSummary(name, input = {}) {
  if (name === 'Bash') return input.description || input.command;
  if (name === 'Skill') return input.skill + (input.args ? ' ' + input.args : '');
  if (name === 'Agent') return input.description;
  if (name === 'SendMessage') return 'to ' + input.to;
  for (const k of ['file_path', 'url', 'query', 'pattern', 'element', 'prompt']) {
    if (input[k]) return k === 'file_path' ? path.relative(PROJECT_DIR, input[k]) || input[k] : input[k];
  }
  if (name.includes('browser_run_code')) return clip(input.code, 80);
  return JSON.stringify(input);
}

function toolLabel(name) {
  const m = /^mcp__plugin_playwright_playwright__browser_(.+)$/.exec(name);
  if (m) return 'Browser ' + m[1].replace(/_unsafe$/, '').replace(/_/g, ' ');
  return name.replace(/^mcp__claude_ai_/, '').replace(/^mcp__/, '').replace(/__/g, ' ');
}

// A background agent finishing. Notifications carry the tool-use id, the agent's task id, or both;
// "waiting on its own background work" is an interim stop, not the end.
function notification(raw, ts) {
  if (/waiting on its own background work/.test(raw)) return [];
  const toolId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(raw)?.[1], agentId = /<task-id>([^<]+)<\/task-id>/.exec(raw)?.[1];
  return toolId || agentId ? [{ ts, kind: 'result', toolId, agentId }] : [];
}

// Turn one transcript line into zero or more display events.
function toEvents(o) {
  if (o.isSidechain) return [];
  const ts = o.timestamp, base = o.uuid || ts;
  if (o.type === 'ai-title') return [{ kind: 'title', text: o.aiTitle }];
  if (o.type === 'attachment' && o.attachment?.type === 'queued_command') { // a notification that arrived mid-turn
    const raw = String(o.attachment.prompt || '');
    return notification(raw, ts);
  }
  if (o.type === 'user') {
    const kind = o.origin?.kind;
    const c = o.message?.content;
    if (kind === 'human') {
      const t = textOf(c).split('\n').filter(l => !l.startsWith('<')).join('\n').trim();
      return t ? [{ id: base, ts, kind: 'prompt', text: clip(t, 1200) }] : [];
    }
    if (kind === 'peer') {
      const raw = textOf(c);
      const sock = /from="([^"]+)"/.exec(raw)?.[1];
      const from = /from-name="([^"]+)"/.exec(raw)?.[1] || sock || '?';
      const body = raw.replace(/^[\s\S]*?<cross-session-message[^>]*>/, '').replace(/<\/cross-session-message>[\s\S]*$/, '');
      return [{ id: base, ts, kind: 'recv', peer: from, sock, text: clip(body, 1200) }];
    }
    if (kind === 'task-notification') {
      const raw = textOf(c);
      const out = [{ id: base, ts, kind: 'task', text: clip(/<summary>([\s\S]*?)<\/summary>/.exec(raw)?.[1] || raw, 300) }];
      return out.concat(notification(raw, ts));
    }
    if (Array.isArray(c)) {
      const out = [];
      c.forEach((b, i) => {
        if (b.type !== 'tool_result') return;
        // internal: closes a spawned agent, unless it only says a background agent was launched (then note its id)
        const txt = String(textOf(b.content) || b.content);
        if (/^Async agent launched/.test(txt)) out.push({ ts, kind: 'launched', toolId: b.tool_use_id, agentId: /agentId: (\w+)/.exec(txt)?.[1] });
        else out.push({ ts, kind: 'result', toolId: b.tool_use_id });
        if (b.is_error) out.push({ id: base + ':' + i, ts, kind: 'error', text: clip(textOf(b.content) || b.content, 300) });
      });
      return out;
    }
    return [];
  }
  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    const out = [];
    o.message.content.forEach((b, i) => {
      const id = base + ':' + i;
      if (b.type === 'text' && b.text.trim()) out.push({ id, ts, kind: 'say', text: clip(b.text, 1200) });
      else if (b.type === 'tool_use' && b.name === 'SendMessage') {
        out.push({ id, ts, kind: 'send', peer: b.input?.to, text: clip(b.input?.message, 1200),
          first: clip(String(b.input?.message ?? '').trim().split('\n')[0], 200) });
      } else if (b.type === 'tool_use' && b.name === 'Agent') {
        out.push({ id, ts, kind: 'spawn', toolId: b.id, text: clip(b.input?.description || 'Agent', 80),
          model: b.input?.model || '', type: b.input?.subagent_type || '', prompt: clip(b.input?.prompt, 400) });
      } else if (b.type === 'tool_use') {
        out.push({ id, ts, kind: 'tool', tool: toolLabel(b.name), text: clip(toolSummary(b.name, b.input), 200) });
      }
    });
    return out;
  }
  return [];
}

module.exports = { clip, textOf, taskName, humanise, toolSummary, toolLabel, notification, toEvents };
