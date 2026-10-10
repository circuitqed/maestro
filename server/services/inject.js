/**
 * Putting text into a live agent's session, and the judgement about WHEN that is
 * safe to do.
 *
 * This was the interesting half of taskRunner.js. It lives on its own because
 * swarms need exactly the same thing -- a finished swarm reports back to the agent
 * that spawned it the way an assignment goes out to a worker -- and this is the one
 * rule in Maestro that must not exist in two copies. The day a second caller learns
 * to inject text without checking the pane first, it answers somebody's trust
 * dialog with whatever option happened to be highlighted.
 *
 * The rule, unchanged from the task runner:
 *
 *   - busy/idle is INFERRED from pane text, not reported by the agent, so a single
 *     idle reading is not evidence that a turn ended. An agent must look idle on
 *     several consecutive observations before anything is injected. That is slower
 *     and much harder to get wrong.
 *   - a session showing an interactive select is unavailable at any idle count. The
 *     trailing Enter of a delivery would answer it.
 */
import { getDb } from './db.js';
import { capturePane, sendText } from './tmux.js';

// Consecutive idle observations required before a delivery. Callers with their own
// configured value pass it in; this is the floor everything else inherits.
export const IDLE_TICKS_REQUIRED = 2;

/**
 * Is this session sitting on an interactive prompt (a model switch, a trust
 * dialog, an AskUserQuestion)?
 *
 * Found the hard way: em-sim-claude reported `idle` while blocked on a "Switch
 * model?" dialog. Delivering into it lost the message entirely -- the widget has no
 * text input -- and the trailing Enter could just as easily have ANSWERED the
 * dialog, picking whatever option happened to be highlighted. A task delivery must
 * never double as a keystroke on someone else's prompt.
 *
 * Matches the shape rather than the wording: a cursor line plus numbered options is
 * what every one of these widgets looks like, and matching words would miss the
 * next dialog someone adds.
 */
export function looksLikePrompt(pane) {
  const lines = String(pane || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-18);
  const numbered = lines.filter((l) => /^(❯\s*)?\d+[.)]\s+\S/.test(l)).length;
  const cursor = lines.some((l) => l.startsWith('❯'));
  return cursor && numbered >= 2;
}

// Idle streaks are kept per CALLER, not globally. Each poller observes on its own
// timer, and one shared counter would be advanced by all of them at once: with a 5s
// task runner and a 5s swarm runner, "two consecutive idle ticks" would be reached
// in one 5s cycle instead of two, quietly halving the only guard against delivering
// mid-turn. markBusy() is deliberately the other way round and clears EVERY scope --
// whoever did the injecting, the agent is now busy for all of them.
const streaks = new Map(); // scope -> Map<agentId, consecutive idle observations>

function streakFor(scope) {
  let m = streaks.get(scope);
  if (!m) {
    m = new Map();
    streaks.set(scope, m);
  }
  return m;
}

/** Take one reading of every agent's status. Call once per poll, from one caller. */
export function observeIdle(scope = 'default') {
  const m = streakFor(scope);
  for (const r of getDb().prepare('SELECT id, status FROM agents').all()) {
    // 'idle' means the session is up and not mid-turn. 'busy' resets the streak.
    if (r.status === 'idle') m.set(r.id, (m.get(r.id) || 0) + 1);
    else m.set(r.id, 0);
  }
}

export function isSettled(agentId, { scope = 'default', ticks = IDLE_TICKS_REQUIRED } = {}) {
  return (streakFor(scope).get(agentId) || 0) >= ticks;
}

/** This agent is (or is about to be) mid-turn: nobody may deliver into it yet. */
export function markBusy(agentId) {
  for (const m of streaks.values()) m.set(agentId, 0);
}

/**
 * Deliver `text` into an agent's session, but only if that is safe right now.
 *
 * @returns {Promise<{sent: boolean, reason: string|null, result?: object}>}
 *   sent:false with reason 'no_session' | 'busy' | 'prompt' -- try again later; the
 *   caller keeps whatever durable state it had, so nothing is lost.
 *
 *   sent:true means the injection was attempted and did not throw -- NOT that
 *   sendText verified the paste landed. Callers mark their own delivery state on
 *   `sent`, which keeps delivery at-least-once: trusting `result.delivered` instead
 *   would silently drop a message whenever the pane could not be read back, and a
 *   repeat is the failure these callers are built to absorb.
 */
export async function deliverWhenSafe(
  agent,
  text,
  { host = null, scope = 'default', ticks = IDLE_TICKS_REQUIRED, onPrompt = null } = {}
) {
  if (!agent || !agent.screen_session) return { sent: false, reason: 'no_session' };
  if (!isSettled(agent.id, { scope, ticks })) return { sent: false, reason: 'busy' };

  // A prompting session is not available, whatever its status says.
  const pane = await capturePane(agent.screen_session, host).catch(() => '');
  if (looksLikePrompt(pane)) {
    if (onPrompt) onPrompt('target is showing an interactive prompt — needs a human');
    return { sent: false, reason: 'prompt' };
  }

  const result = await sendText(agent.screen_session, text, host);
  markBusy(agent.id); // it is about to be busy
  return { sent: true, reason: null, result };
}
