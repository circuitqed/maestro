/**
 * Where workers report home. The only router in Maestro with neither a session nor
 * the shared agent token.
 *
 * A worker is a `claude -p` process in a detached tmux session; it is not an agent,
 * has no row in `agents`, and must not hold a credential that could do anything
 * else. So it carries one capability minted for it at admission --
 * swarm_workers.report_token -- and that token's entire authority is "close out
 * this one worker".
 *
 * What follows from that, all deliberate:
 *   - the token IS the identity. `worker_id` in the body is cross-checked and never
 *     trusted, so a worker cannot close out a sibling's row;
 *   - one shot. cost_usd is what every budget gate is computed from, so a report
 *     that could be replayed could be replayed with a smaller number;
 *   - a malformed report is still recorded, never dropped. A live worker row is a
 *     budget reservation and a concurrency slot; losing the report would hold both
 *     until something else reaped them;
 *   - it must be mounted OUTSIDE requireAuth, which is why it is its own file.
 */
import { Router } from 'express';
import { getDb } from '../services/db.js';
import {
  finishWorker, logSwarmEvent, tripKillSwitch, TERMINAL_WORKER_STATES,
} from '../services/swarm.js';

const router = Router();

function handle(req, res) {
  const token = (req.get('X-Maestro-Worker-Token') || '').trim();
  if (!token) return res.status(401).json({ error: 'missing X-Maestro-Worker-Token' });

  // A lookup by token, not a compare against a known row: the server does not know
  // who is calling until the token says so. The token is a v4 uuid, so there is
  // nothing to brute-force and nothing a timing difference would reveal beyond
  // "that token does not exist", which an attacker already knows.
  const w = getDb().prepare('SELECT * FROM swarm_workers WHERE report_token = ?').get(token);
  if (!w) return res.status(401).json({ error: 'unknown worker token' });

  const b = req.body || {};
  if (b.worker_id && String(b.worker_id) !== w.id) {
    // Either a bug in the runner's flag wiring or a worker relaying someone else's
    // report. Both are worth failing loudly instead of writing to the wrong row.
    return res.status(400).json({
      error: `token belongs to worker ${w.id}, body claims ${b.worker_id}`,
      code: 'WORKER_MISMATCH',
    });
  }
  if (TERMINAL_WORKER_STATES.includes(w.state)) {
    return res.status(409).json({
      error: `worker ${w.id} already reported ${w.state}`,
      code: 'ALREADY_REPORTED',
      state: w.state,
    });
  }

  // The gateway refusing on budget is not a per-worker failure, it is the end of
  // all spending: LiteLLM tags it rate_limit_type=BUDGET at 429, so every other
  // worker is about to fail the same way. maestro-worker signals it as
  // terminal_reason=gateway_budget_exceeded (its own exit 3 is not what lands in
  // this body, since exit_code here is claude's). `over_budget` is explicitly NOT
  // this: that is the per-worker --max-budget-usd brake working as intended.
  const gatewayDead = Number(b.exit_code) === 3 || b.terminal_reason === 'gateway_budget_exceeded';

  const reported = String(b.state || '');
  const state = TERMINAL_WORKER_STATES.includes(reported) ? reported : 'failed';
  const terminalReason = state === reported
    ? (b.terminal_reason || null)
    : `bad_report:${reported || 'missing'}`;

  const worker = finishWorker(w.id, {
    state,
    result: b.result ?? null,
    costUsd: b.cost_usd ?? null,
    terminalReason,
    errorSignature: b.error_signature ?? (b.error ? String(b.error).slice(0, 120) : null),
    claudeSessionId: b.claude_session_id ?? null,
  });

  // The token counts are the only record of them -- there is no column -- and they
  // are what the cost model was measured from, so they are worth keeping.
  const t = b.tokens || {};
  const bits = [
    `${state}`,
    terminalReason ? `(${terminalReason})` : null,
    b.elapsed_s != null ? `${b.elapsed_s}s` : null,
    worker.cost_usd != null ? `$${worker.cost_usd}` : null,
    t.cache_creation_input_tokens != null ? `${t.cache_creation_input_tokens} cache-write` : null,
    t.cache_read_input_tokens != null ? `${t.cache_read_input_tokens} cache-read` : null,
    t.output_tokens != null ? `${t.output_tokens} out` : null,
  ].filter(Boolean);
  logSwarmEvent(w.swarm_id, `worker_${state}`, bits.join(' '), w.id);

  if (gatewayDead) {
    const reason = `gateway budget exhausted (reported by worker ${w.id})`;
    logSwarmEvent(w.swarm_id, 'kill_switch', reason, w.id);
    tripKillSwitch(reason);
  }

  res.json({ ok: true, workerId: w.id, swarmId: w.swarm_id, state: worker.state, killSwitch: gatewayDead });
}

// Registered under both paths so the mount point can be either `/api/swarm-report`
// (the URL maestro-worker posts to) or `/api`, without the router and index.js
// having to agree on which.
router.post(['/', '/swarm-report'], handle);

export default router;
