/**
 * Keeps an idle agent's prompt cache warm by sending it a tiny turn just before the
 * cache would expire.
 *
 * The prompt cache lives 5 minutes from the last request. An agent that sits idle
 * longer -- waiting on Dave, on another agent, on a background job -- pays to WRITE
 * its whole context again on the next turn, at 1.25x input price. Measured on
 * 2026-11-06: 129 such lapses in a day, $209, every one of them idle time. A turn
 * that only READS the cache costs 0.1x input, so a ping is ~8% of a lapse.
 * Doing something is cheaper than doing nothing.
 *
 * But not forever. A ping is only worth it if the idle stretch ends soon; an agent
 * left overnight would ping all night for a turn that never comes. So this is ski
 * rental: keep pinging until the pings have cost as much as one rewrite would
 * (write price / read price, ~12 pings, ~54 min), then let the cache go. That is
 * never worse than twice the cost of knowing the future, whatever the idle-time
 * distribution turns out to be.
 *
 * Timing is measured from when the last REQUEST started, not when its reply was
 * written: the cache clock starts at the read, and a long reply can finish a minute
 * later. Hence 270 s rather than 285 s -- the tick, the paste and the request itself
 * all have to fit in the remaining margin.
 *
 * Which agents: Claude agents on an API (gateway) account, where a lapse is dollars.
 * `config.cacheKeepalive` true/false overrides per agent; the `cache_keepalive`
 * setting 'off' stops it fleet-wide.
 *
 * Safety is inject.js's: never into a busy session or one showing a question. On top
 * of that, never over a half-typed draft (the paste would submit it), and never
 * while someone is using the agent from the chat box.
 */
import { getAgents, getHost, getSetting } from './db.js';
import { deliverWhenSafe, observeIdle } from './inject.js';
import { execOnHost, shellQuote } from './hosts.js';
import { paneTarget } from './tmux.js';
import { listAccounts } from './accounts.js';
import { resolveTranscriptFile } from './transcript.js';
import { ratesFor } from './pricing.js';

const SCOPE = 'keepalive';
export const MARKER = '[maestro keepalive]';
const PING_AFTER_S = 270;
const USER_QUIET_S = 120; // someone sent this agent input recently: leave it alone
const ACCOUNT_TTL_MS = 30 * 60 * 1000;
const FILE_TTL_MS = 60 * 1000;

// A ping need not be wasted: it pays for a turn anyway, so the agent may spend it on
// something quick that was worth doing. It must not start long work or wait.
const PING_TEXT =
  `${MARKER} Automatic, from Maestro, not from Dave: your prompt cache is about to ` +
  'expire and this turn keeps it warm. If something quick and useful is waiting -- ' +
  '`yap new` if you are on yap, a background job you are waiting on -- check it and act ' +
  'on what you find. Do not start long work or wait on anything. If there is nothing, ' +
  'reply with a single "." and stop.';

const accountKinds = new Map(); // hostKey -> { at, kinds: Map<dir, kind> }
const files = new Map(); // agentId -> { at, sessionId, file }
const pings = new Map(); // agentId -> consecutive keep-alives since the last real turn

const hostKey = (host) => (host ? String(host.id) : 'local');

async function accountKind(host, dir) {
  const k = hostKey(host);
  let e = accountKinds.get(k);
  if (!e || Date.now() - e.at > ACCOUNT_TTL_MS) {
    const rows = await listAccounts(host).catch(() => []);
    e = { at: Date.now(), kinds: new Map(rows.map((r) => [r.dir, r.kind])) };
    accountKinds.set(k, e);
  }
  return e.kinds.get(dir) || null;
}

async function eligible(agent, host) {
  const c = agent.config || {};
  if ((c.provider || 'claude') !== 'claude') return false;
  if (c.cacheKeepalive === false) return false;
  if (c.cacheKeepalive === true) return true;
  const dir = c.activeClaudeConfigDir || c.claudeConfigDir;
  return !!dir && (await accountKind(host, dir)) === 'api';
}

async function transcriptFile(agent, host) {
  const e = files.get(agent.id);
  if (e && e.sessionId === agent.claude_session_id && Date.now() - e.at < FILE_TTL_MS) return e.file;
  const file = await resolveTranscriptFile(agent, host).catch(() => null);
  files.set(agent.id, { at: Date.now(), sessionId: agent.claude_session_id, file });
  return file;
}

// Prints one line per recent user/assistant record of the main thread:
// type, timestamp, model, message id, ping marker (K), prompt or tool result (P/T).
const TAIL_PY = `
import json,sys
for l in sys.stdin:
    try: r=json.loads(l)
    except Exception: continue
    t=r.get('type')
    if t not in ('user','assistant') or r.get('isSidechain') or not r.get('timestamp'): continue
    m=r.get('message') or {}
    c=m.get('content')
    if isinstance(c,list):
        tr=any(isinstance(b,dict) and b.get('type')=='tool_result' for b in c)
        tu=any(isinstance(b,dict) and b.get('type')=='tool_use' for b in c)
        th=t=='assistant' and c and all(isinstance(b,dict) and b.get('type') in ('thinking','redacted_thinking') for b in c)
        txt=' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
    else:
        tr=tu=th=False; txt=str(c or '')
    print(t,r['timestamp'],m.get('model') or '-',m.get('id') or '-','K' if txt.lstrip().startswith(${JSON.stringify(MARKER)}) else '-','T' if tr else 'U' if tu else 'H' if th else 'P')
`;

/**
 * When did this agent's last model request start, and was it one of our pings?
 * The request that produced the final reply began at the record just before that
 * reply's first block.
 */
async function lastRequest(host, file) {
  const cmd = `tail -n 120 ${shellQuote(file)} | python3 -c ${shellQuote(TAIL_PY)}`;
  const { stdout } = await execOnHost(host, cmd, { timeout: 15000 });
  const recs = String(stdout).trim().split('\n').filter(Boolean)
    .map((l) => {
      const [type, ts, model, id, k, u] = l.split(' ');
      return { type, ts, model, id, ping: k === 'K', prompt: type === 'user' && u === 'P', toolUse: u === 'U', thinking: u === 'H' };
    });
  let i = recs.length - 1;
  while (i >= 0 && recs[i].type !== 'assistant') i--;
  if (i < 0) return null;
  const reply = recs[i];
  while (i > 0 && recs[i - 1].type === 'assistant' && recs[i - 1].id === reply.id) i--;
  const trigger = i > 0 ? recs[i - 1] : null;
  const startedAt = Date.parse((trigger || recs[i]).ts);
  // What started this TURN (the last prompt, not a tool result). A ping that went on
  // to do real work is still a ping-started turn: it counts toward the cap, or a
  // ping that runs one tool would reset the count and ping all night.
  let j = recs.length - 1;
  while (j >= 0 && !recs[j].prompt) j--;
  const turnWasPing = j >= 0 && recs[j].ping;
  // The lead is mid-turn if the newest record is a user record (a request is in
  // flight), a tool call (a foreground tool is running) or a lone thinking block (the
  // reply is still streaming; blocks are written as they finish). Otherwise its turn
  // ended, even if a background subagent is still at work.
  const end = recs[recs.length - 1];
  const pending = end.type === 'user' || end.toolUse || end.thinking;
  return Number.isFinite(startedAt) ? { startedAt, model: reply.model, turnWasPing, pending } : null;
}

/**
 * Is there something typed in the composer? Claude renders its suggested next prompt
 * there too, but dim (SGR 2); a real draft is not dim, and pasting over it would
 * submit it.
 */
async function hasDraft(agent, host) {
  const { stdout } = await execOnHost(host, `tmux capture-pane -e -p -t ${paneTarget(agent.screen_session)}`);
  const line = String(stdout).split('\n').reverse().find((l) => l.includes('❯'));
  if (!line) return false;
  const after = line.slice(line.indexOf('❯') + 1);
  // Walk to the first visible character, remembering the last SGR code seen.
  const re = /\x1b\[([0-9;]*)m|([\s\u00a0])|(.)/gsu;
  let sgr = '';
  for (let m; (m = re.exec(after)); ) {
    if (m[1] !== undefined) sgr = m[1];
    else if (m[3] !== undefined) return !sgr.split(';').includes('2');
  }
  return false; // nothing visible after the cursor
}

function cap(model) {
  const r = ratesFor(model);
  return r && r.cw5 && r.read ? Math.floor(r.cw5 / r.read) : 12;
}

async function tick() {
  if (getSetting('cache_keepalive') === 'off') return;
  observeIdle(SCOPE);
  const now = Date.now();
  for (const agent of getAgents()) {
    try {
      // Not just 'idle': a lead with a background subagent reads 'running' all along
      // (the subagent keeps its pane changing), and those are the leads that lapse
      // most. Whether the lead's own turn ended comes from the transcript below.
      if (agent.status === 'stopped' || !agent.screen_session) continue;
      const host = agent.host_id ? getHost(agent.host_id) : null;
      if (host && host.status === 'offline') continue;
      if (!(await eligible(agent, host))) continue;
      if (agent.last_user_at && now - Date.parse(agent.last_user_at + (/Z$/.test(agent.last_user_at) ? '' : 'Z')) < USER_QUIET_S * 1000) continue;

      const file = await transcriptFile(agent, host);
      if (!file) continue;
      const last = await lastRequest(host, file);
      if (!last || last.pending) continue;
      if (!last.turnWasPing) pings.set(agent.id, 0);
      const age = (now - last.startedAt) / 1000;
      if (age < PING_AFTER_S) continue;
      // Already lapsed: a ping now would pay the full rewrite for nothing.
      if (age > 300) continue;
      const n = pings.get(agent.id) || 0;
      if (n >= cap(last.model)) continue; // ski rental: bought the skis' worth, stop
      if (await hasDraft(agent, host)) continue;

      // Settled by the transcript: its turn ended 270 s ago and nothing is in flight.
      const out = await deliverWhenSafe(agent, PING_TEXT, { host, scope: SCOPE, settled: true });
      if (out.sent) {
        pings.set(agent.id, n + 1);
        console.log(`keepalive: ${agent.name} ping ${n + 1}/${cap(last.model)} at ${Math.round(age)}s`);
      }
    } catch (err) {
      /* one agent's unreachable host must not stop the others */
    }
  }
}

let timer = null;
let running = false;
export function startCacheKeepalive(intervalMs = 10000) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } finally { running = false; }
  }, intervalMs);
  timer.unref?.();
}

// For tests and one-off checks; not part of the service's interface.
export const _internals = { lastRequest, hasDraft, cap };
