/**
 * What an agent's own model use has cost: tokens from its transcripts x pricing.js.
 *
 * Plan usage (usage.js) answers "how much of the SHARED plan or key is left"; this
 * answers "what did I spend", which nothing showed an agent before. Same source the
 * cost reports use: Claude Code writes `message.usage` on every assistant record,
 * and pricing.js turns that into dollars (an unpriced model stays null).
 *
 * Which files are "this agent's": the transcripts in its current transcript's
 * directory whose `agentName` is the agent's name (Maestro starts Claude with
 * --name), minus sessions pinned by other agents, plus each kept session's
 * subagent transcripts (<session>/subagents/*.jsonl) -- a subagent's tokens are
 * the lead's spend. Every content block of one reply repeats the reply's usage, so
 * a reply counts once (message id + request id).
 *
 * Runs on the agent's host, script on stdin, reading only usage fields: transcript
 * text never leaves the host. Cached, because a heavy agent has hundreds of MB.
 *
 * Claude agents only for now; Codex and Antigravity report `supported: false`.
 */
import { execOnHostWithInput, shellQuote } from './hosts.js';
import { getPinnedSessionIdsOnHost } from './db.js';
import { resolveTranscriptFile } from './transcript.js';
import { costOf } from './pricing.js';
import { accountKindFor } from './planUsage.js';

const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // agent id -> { at, value }

const SCRIPT = String.raw`
import json, os, sys, glob, time, calendar
d, name, current, month_start, siblings = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), set(filter(None, sys.argv[5].split(',')))
now = time.time()
starts = {"day": now - 86400, "week": now - 7 * 86400, "month": month_start}
oldest = min(starts.values())
def sid(p): return os.path.basename(p)[:-6]
def agent_name(p):
    try:
        with open(p, 'rb') as f:
            for i, line in enumerate(f):
                if b'"agentName"' in line:
                    try: return json.loads(line).get("agentName")
                    except Exception: pass
                if i > 400: break
    except Exception: pass
    return None
mains = []
for p in glob.glob(os.path.join(d, "*.jsonl")):
    try:
        if os.path.getmtime(p) < oldest and p != current: continue
    except OSError: continue
    if sid(p) in siblings and p != current: continue
    if p == current or agent_name(p) == name: mains.append(p)
files = []
for p in mains:
    files.append((p, p == current))
    for s in glob.glob(os.path.join(d, sid(p), "subagents", "*.jsonl")):
        files.append((s, p == current))
out = {k: {} for k in list(starts) + ["session"]}
seen = set()
def ts(s):
    try: return calendar.timegm(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception: return None
for p, is_current in files:
    try: mt = os.path.getmtime(p)
    except OSError: continue
    if mt < oldest and not is_current: continue
    with open(p, 'rb') as f:
        for line in f:
            if b'"usage"' not in line or b'"assistant"' not in line: continue
            try: r = json.loads(line)
            except Exception: continue
            m = r.get("message") or {}
            u = m.get("usage")
            if r.get("type") != "assistant" or not u: continue
            key = (m.get("id"), r.get("requestId"))
            if key in seen: continue
            seen.add(key)
            t = ts(r.get("timestamp") or "")
            cc = u.get("cache_creation") or {}
            cw1h = cc.get("ephemeral_1h_input_tokens") or 0
            cw5 = (u.get("cache_creation_input_tokens") or 0) - cw1h
            b = {"in": u.get("input_tokens") or 0, "out": u.get("output_tokens") or 0,
                 "cw5": max(cw5, 0), "cw1h": cw1h, "read": u.get("cache_read_input_tokens") or 0}
            model = m.get("model") or "?"
            wins = [k for k, s in starts.items() if t is not None and t >= s]
            if is_current: wins.append("session")
            for w in wins:
                acc = out[w].setdefault(model, {"in": 0, "out": 0, "cw5": 0, "cw1h": 0, "read": 0, "replies": 0})
                for k2 in b: acc[k2] += b[k2]
                acc["replies"] += 1
print(json.dumps({"windows": out, "sessions": len(mains), "files": len(files)}))
`;

function price(byModel) {
  let usd = 0, usdMax = 0, unpricedTokens = 0;
  const models = {};
  for (const [model, t] of Object.entries(byModel)) {
    if (model === '<synthetic>') continue;
    const c = costOf(model, t);
    const tokens = t.in + t.out + t.cw5 + t.cw1h + t.read;
    if (c.priced) { usd += c.usd; usdMax += c.usdMax; } else unpricedTokens += tokens;
    models[model] = { usd: c.usd == null ? null : Math.round(c.usd * 100) / 100, tokens, replies: t.replies };
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return { usd: r2(usd), ...(usdMax > usd + 0.005 ? { usdMax: r2(usdMax) } : {}), unpricedTokens, models };
}

export async function tokenSpendForAgent(agent, host, { force = false } = {}) {
  const provider = (agent.config || {}).provider || 'claude';
  if (provider !== 'claude') return { supported: false, reason: `${provider} transcripts are not metered yet` };
  const c = cache.get(agent.id);
  if (!force && c && Date.now() - c.at < TTL_MS) return c.value;

  const file = await resolveTranscriptFile(agent, host).catch(() => null);
  if (!file) return { supported: true, ok: false, reason: 'no transcript found for this agent' };
  const dir = file.replace(/\/[^/]*$/, '');
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  const siblings = (getPinnedSessionIdsOnHost(agent.id, agent.host_id) || []).join(',');
  const cmd = `python3 - ${[dir, agent.name, file, String(monthStart), siblings || ','].map(shellQuote).join(' ')}`;
  let raw;
  try {
    const { stdout } = await execOnHostWithInput(host, cmd, SCRIPT, { timeout: 90000 });
    raw = JSON.parse(String(stdout).trim().split('\n').pop());
  } catch (e) {
    return { supported: true, ok: false, reason: `could not read transcripts: ${e.message}` };
  }

  const account = await accountKindFor(host, (agent.config || {}).claudeConfigDir || '');
  const basis = account && account.kind === 'oauth'
    ? 'api-equivalent: this account is a flat-rate subscription, so these dollars are what the same tokens would cost on the API, not a bill'
    : 'estimated bill: tokens x list price (pricing.js); the gateway\'s own figure is in `maestro-usage`';
  const value = {
    supported: true, ok: true,
    account: account ? account.kind : null,
    basis,
    session: price(raw.windows.session),
    last24h: price(raw.windows.day),
    last7d: price(raw.windows.week),
    monthToDate: price(raw.windows.month),
    sessionsCounted: raw.sessions,
    checkedAt: new Date().toISOString(),
  };
  cache.set(agent.id, { at: Date.now(), value });
  return value;
}
