"""Where did the tokens go? Reads Claude Code transcripts for one project (main sessions + subagents)."""
import json, os, sys, glob, collections

ROOT = sys.argv[1]
# Input-equivalent weights (relative to the base input price): cache write 1.25x, cache read 0.1x, output 5x.
W = dict(inp=1.0, cw=1.25, cr=0.1, out=5.0)


def usage(path):
    seen, tot, turns, first = set(), collections.Counter(), 0, None
    tools = collections.Counter()      # tool_use counts by name
    result_chars = collections.Counter()  # size of tool results by tool name
    id2tool, model = {}, ''
    with open(path, errors='replace') as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            m = o.get('message') or {}
            if o.get('type') == 'assistant':
                for b in m.get('content') or []:
                    if isinstance(b, dict) and b.get('type') == 'tool_use':
                        id2tool[b['id']] = b['name']
                mid = m.get('id')
                if mid in seen or not m.get('usage'):
                    continue
                seen.add(mid)
                u = m['usage']
                model = m.get('model') or model
                row = collections.Counter(inp=u.get('input_tokens', 0), cw=u.get('cache_creation_input_tokens', 0),
                                          cr=u.get('cache_read_input_tokens', 0), out=u.get('output_tokens', 0))
                if first is None:
                    first = row
                tot += row
                turns += 1
            elif o.get('type') == 'user' and isinstance(m.get('content'), list):
                for b in m['content']:
                    if isinstance(b, dict) and b.get('type') == 'tool_result':
                        name = id2tool.get(b.get('tool_use_id'), '?')
                        c = b.get('content')
                        n = len(c) if isinstance(c, str) else len(json.dumps(c))
                        tools[name] += 1
                        result_chars[name] += n
    return tot, turns, first, tools, result_chars, model


def eq(c):
    return sum(c[k] * W[k] for k in W)


def short(name):
    return name.replace('mcp__plugin_playwright_playwright__', 'pw:').replace('mcp__claude_ai_', '')


rows = []
for main in glob.glob(os.path.join(ROOT, '*.jsonl')):
    sid = os.path.basename(main)[:-6]
    tot, turns, first, tools, rc, model = usage(main)
    rows.append(('main', sid[:8], '', model, tot, turns, first, tools, rc, os.path.getmtime(main)))
    for sub in glob.glob(os.path.join(ROOT, sid, 'subagents', '*.jsonl')):
        meta = sub[:-6] + '.meta.json'
        desc = ''
        try:
            mj = json.load(open(meta))
            desc = mj.get('description') or mj.get('agentType') or ''
        except Exception:
            pass
        tot, turns, first, tools, rc, model = usage(sub)
        rows.append(('sub', sid[:8], desc, model, tot, turns, first, tools, rc, os.path.getmtime(sub)))

grand = sum(eq(r[4]) for r in rows)
print(f'{len(rows)} transcripts, total input-equivalent tokens: {grand/1e6:.1f}M\n')
print('kind  session   eq-tok(M) turns  startup-eq(k)  model                 description')
for r in sorted(rows, key=lambda r: -eq(r[4]))[:30]:
    start = eq(r[6]) / 1e3 if r[6] else 0
    print(f'{r[0]:5} {r[1]}  {eq(r[4])/1e6:8.2f} {r[5]:5}  {start:12.1f}  {r[3][:20]:20}  {r[2][:50]}')

subs = [r for r in rows if r[0] == 'sub']
if subs:
    st = [eq(r[6]) for r in subs if r[6]]
    print(f'\nsubagents: {len(subs)}, total {sum(eq(r[4]) for r in subs)/1e6:.1f}M eq, '
          f'median first-turn {sorted(st)[len(st)//2]/1e3:.1f}k eq, median turns {sorted(r[5] for r in subs)[len(subs)//2]}')
    pl = [r for r in subs if r[2].lower().startswith(('planner', 'reviewer'))]
    if pl:
        print(f'planners/reviewers: {len(pl)}, total {sum(eq(r[4]) for r in pl)/1e6:.2f}M eq, '
              f'avg {sum(eq(r[4]) for r in pl)/len(pl)/1e3:.0f}k eq each')

rc = collections.Counter(); tc = collections.Counter()
for r in rows:
    rc += r[8]; tc += r[7]
print('\nTool results by size (chars ~ 4 per token), top 12:')
for name, n in rc.most_common(12):
    print(f'  {short(name)[:45]:45} calls {tc[name]:5}  chars {n/1e6:6.2f}M  avg {n/max(tc[name],1)/1e3:5.1f}k')
