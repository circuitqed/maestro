/**
 * Lets an agent clear its own context: `maestro-clear "resume prompt"`.
 *
 * Every lead is told to keep its context small -- write STATUS.md, then /clear at a
 * task boundary -- because the whole context is re-read on every turn and rewritten
 * after every idle gap. But /clear is a slash command typed into the composer, and an
 * agent cannot type into its own composer. em-sim agents asked em-sim-main to send it;
 * lab-platform had nobody to ask and reached 875k tokens, $4.38 per cache rewrite.
 * The improvised workaround -- a detached `sleep 20; tmux send-keys /clear` -- fires
 * mid-turn if the turn runs long, and types into whatever prompt happens to be up.
 *
 * So the request is queued here and carried out only when it is safe:
 *   1. the caller's own turn has ENDED after it asked (transcript, not pane: a lead
 *      with a background subagent reads busy for hours),
 *   2. nothing is typed in its composer and no question is showing,
 * then `/clear` is typed, and the resume prompt is sent once the fresh session is up.
 * A request nobody could carry out within 30 minutes is dropped, not left to fire
 * into some later, unrelated moment.
 */
import { getAgent, getHost, logActivity } from './db.js';
import { deliverWhenSafe } from './inject.js';
import { execOnHost } from './hosts.js';
import { paneTarget, capturePane } from './tmux.js';
import { turnState, hasDraft } from './cacheKeepalive.js';
import { isQuestionWidget } from './agentMonitor.js';

const EXPIRE_MS = 30 * 60 * 1000;
const RESUME_DELAY_MS = 4000;
export const MAX_RESUME = 2000;
export const DEFAULT_RESUME =
  'Your context was cleared at your own request (maestro-clear). Read your project CLAUDE.md/AGENTS.md ' +
  'and STATUS.md, then continue where STATUS.md says you left off.';

const pending = new Map(); // agentId -> { at, resume }

export function requestClear(agentId, resume) {
  const text = String(resume || '').trim() || DEFAULT_RESUME;
  pending.set(agentId, { at: Date.now(), resume: text.slice(0, MAX_RESUME) });
  return { queued: true, expiresInMin: EXPIRE_MS / 60000 };
}

export function cancelClear(agentId) {
  return pending.delete(agentId);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt(agentId, req) {
  const agent = getAgent(agentId);
  if (!agent || agent.status === 'stopped' || !agent.screen_session) return 'gone';
  const host = agent.host_id ? getHost(agent.host_id) : null;
  if (host && host.status === 'offline') return 'wait';

  // 1. Its turn ended after it asked -- the reply it gave after calling us is in.
  const t = await turnState(agent, host);
  if (!t || t.pending || !(t.endedAt > req.at)) return 'wait';
  // 2. Nothing typed, no question up.
  if (await hasDraft(agent, host)) return 'wait';
  const pane = await capturePane(agent.screen_session, host).catch(() => '');
  if (isQuestionWidget(pane)) return 'wait';

  // Typed as keys, not pasted: a bracketed paste of "/clear" is text in the
  // composer, not necessarily the command.
  const target = paneTarget(agent.screen_session);
  await execOnHost(host, `tmux send-keys -t ${target} -l /clear && sleep 0.5 && tmux send-keys -t ${target} Enter`);
  await sleep(RESUME_DELAY_MS);
  const out = await deliverWhenSafe(agent, req.resume, { host, scope: 'self-clear', settled: true });
  const msg = out.sent
    ? `${agent.name}: cleared its context at its own request and was sent its resume prompt`
    : `${agent.name}: cleared its context at its own request, but the resume prompt was refused (${out.reason})`;
  console.log(`self-clear: ${msg}`);
  try { logActivity('agent_self_clear', agent.project_id, agent.id, msg); } catch { /* log is best-effort */ }
  return 'done';
}

async function tick() {
  for (const [agentId, req] of pending) {
    if (Date.now() - req.at > EXPIRE_MS) {
      pending.delete(agentId);
      console.log(`self-clear: request from agent ${agentId} expired unexecuted`);
      continue;
    }
    try {
      const r = await attempt(agentId, req);
      if (r !== 'wait') pending.delete(agentId);
    } catch (err) {
      /* unreachable host and the like: try again next tick */
    }
  }
}

let timer = null;
let running = false;
export function startSelfClear(intervalMs = 5000) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } finally { running = false; }
  }, intervalMs);
  timer.unref?.();
}
