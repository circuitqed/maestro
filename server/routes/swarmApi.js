/**
 * The swarm half of the agent-facing API: a granted agent asks for a budget-capped
 * batch of workers, then polls it and collects the results.
 *
 * Mounted at /api/agent alongside agentApi.js and behind the same identity
 * middleware, because the grant is checked against the SPAWNER -- an agent that
 * could name its own identity could name one that has a grant.
 *
 * Nothing in this file spends money. Creation lands in `pending_approval` and a
 * human approves it elsewhere; admission (the only path that costs anything) lives
 * in swarm.js and is called by the runner. This router is a thin typed shell, and
 * its one real job is to make refusals legible: an agent must be able to tell
 * "wait and retry" from "a human has to change something", or it will loop.
 */
import { Router } from 'express';
import { getDb } from '../services/db.js';
import { requireAgentIdentity } from '../middleware/agentIdentity.js';
import {
  createSwarm, getSwarm, swarmLedger, listWorkers, haltSwarm, logSwarmEvent,
  estimateSwarm, getGrant, globalLedger, TERMINAL_WORKER_STATES, COLD_START_USD,
} from '../services/swarm.js';

const router = Router();
router.use(requireAgentIdentity);

// Items become prompt text, and this router is the only thing between an agent's
// loop and a 10MB request body. The caps are generous for real batches (a 500-item
// audit) and still bound what one POST can cost to parse and store.
const MAX_ITEMS = 500;
const MAX_ITEM_CHARS = 4000;

const STATUS = {
  // authorization: the agent is not allowed to do this at all
  NOT_PERMITTED: 403, NOT_GRANTED: 403, NOT_YOURS: 403,
  // capacity and brakes: 429 says "not now"
  DISABLED: 429, GLOBAL_CONCURRENCY: 429, DAILY_SPEND: 429, MONTHLY_SPEND: 429,
  SWARM_WORKERS: 429, SWARM_CONCURRENCY: 429, SWARM_SPEND: 429, PAUSED: 429,
  NO_SWARM: 404,
  EMPTY: 400,
  // lifecycle
  HALTED: 409, NOT_RUNNING: 409, STATE: 409,
};

// The status code alone cannot carry this: DISABLED is a 429 (nothing will run)
// but retrying it is pointless, because only a human turning the kill switch back
// on changes the answer. The capacity gates do clear on their own. An agent that
// cannot tell these apart either hammers a dead system or gives up on a queue.
const RETRYABLE = new Set([
  'GLOBAL_CONCURRENCY', 'DAILY_SPEND', 'MONTHLY_SPEND',
  'SWARM_WORKERS', 'SWARM_CONCURRENCY', 'SWARM_SPEND', 'PAUSED',
]);

const fail = (res, err) => {
  const code = err.code || 'ERROR';
  const status = STATUS[code] ?? (code.startsWith('BAD_') ? 400 : 500);
  res.status(status).json({ error: err.message, code, retryable: RETRYABLE.has(code) });
};

const refuse = (res, code, message) =>
  res.status(STATUS[code] ?? (code.startsWith('BAD_') ? 400 : 500))
    .json({ error: message, code, retryable: RETRYABLE.has(code) });

/** The swarm named in the URL, or null after answering the request. */
function ownSwarm(req, res) {
  const s = getSwarm(req.params.id);
  if (!s) { refuse(res, 'NO_SWARM', 'unknown swarm'); return null; }
  // A swarm is a spend authorization, so only the agent that holds it may read or
  // stop it. Humans use the admin/UI routes, which are session-authed instead.
  if (s.spawner_agent_id !== req.agent.id) { refuse(res, 'NOT_YOURS', 'not your swarm'); return null; }
  return s;
}

const money = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4;
const dollars = (n) => `$${(Number(n) || 0).toFixed(2)}`;

const swarmView = (s) => ({
  id: s.id,
  name: s.name,
  state: s.state,
  paused: !!s.paused,
  haltReason: s.halt_reason,
  model: s.model,
  maxWorkers: s.max_workers,
  maxConcurrent: s.max_concurrent,
  maxSpendUsd: s.max_spend_usd,
  perWorkerUsd: s.per_worker_usd,
  perWorkerSeconds: s.per_worker_seconds,
  itemsPerWorker: s.items_per_worker,
  createdAt: s.created_at,
  finishedAt: s.finished_at,
});

const workerView = (w) => ({
  id: w.id,
  idx: w.idx,
  state: w.state,
  session: w.session_name,
  costUsd: w.cost_usd,
  terminalReason: w.terminal_reason,
  errorSignature: w.error_signature,
  finishedAt: w.finished_at,
  // Full text is what GET /results is for; a status poll every few seconds should
  // not drag every worker's answer along with it.
  resultChars: w.result ? w.result.length : 0,
});

// --------------------------------------------------------------- creation ---

router.post('/swarms', (req, res) => {
  const b = req.body || {};

  // v1 runs workers on oracle only. A remote SPAWNER is fine (it collects results
  // over HTTP like everyone else), but a request that explicitly asks for workers
  // somewhere else is refused rather than silently downgraded to local.
  if (b.hostId !== undefined && b.hostId !== null && Number(b.hostId) !== 0) {
    return refuse(res, 'BAD_HOST', 'v1 runs workers on the local host only; drop hostId');
  }

  if (!Array.isArray(b.items)) return refuse(res, 'BAD_ITEMS', 'items must be an array of strings');
  const items = b.items.map((i) => String(i ?? '').trim()).filter(Boolean);
  if (!items.length) return refuse(res, 'EMPTY', 'a swarm needs at least one item');
  if (items.length > MAX_ITEMS) {
    return refuse(res, 'BAD_ITEMS', `${items.length} items exceeds the ${MAX_ITEMS}-item limit`);
  }
  const oversized = items.findIndex((i) => i.length > MAX_ITEM_CHARS);
  if (oversized >= 0) {
    return refuse(res, 'BAD_ITEMS', `item ${oversized} is ${items[oversized].length} chars (limit ${MAX_ITEM_CHARS})`);
  }

  // Advisory pre-flight, not a gate -- admitWorker() remains the authority on
  // whether a worker may run. It catches only the case where the answer is already
  // no for the rest of the day, because a swarm created then is an approval request
  // a human reads, thinks about, and approves into a system that cannot run it. The
  // `enabled` guard keeps a tripped kill switch answering DISABLED (from
  // createSwarm) instead of being masked by a spent cap.
  const g = globalLedger();
  if (g.enabled && g.spentToday >= g.dailyCap) {
    return refuse(res, 'DAILY_SPEND', `${dollars(g.spentToday)} of today's ${dollars(g.dailyCap)} is already spent; nothing will run until it rolls over`);
  }
  if (g.enabled && g.spentMonth >= g.monthlyCap) {
    return refuse(res, 'MONTHLY_SPEND', `${dollars(g.spentMonth)} of the ${dollars(g.monthlyCap)} monthly cap is already spent`);
  }

  try {
    const swarm = createSwarm({
      name: b.name,
      spawnerAgentId: req.agent.id,
      hostId: null,
      items,
      maxWorkers: b.maxWorkers,
      maxSpendUsd: b.maxSpendUsd,
      perWorkerUsd: b.perWorkerUsd,
      perWorkerSeconds: b.perWorkerSeconds,
      itemsPerWorker: b.itemsPerWorker,
      model: b.model || null,
    });

    // swarm.js stores the shape of the batch but not the batch itself (it only ever
    // reads items.length), and the runner needs the items AFTER approval, which can
    // be minutes later in another process. One event row carries them across that
    // gap without a second table to migrate: the runner reads the newest `items`
    // event for the swarm and chunks it itself.
    logSwarmEvent(swarm.id, 'items', JSON.stringify(items));

    const grant = getGrant(req.agent.id);
    const askedWorkers = Number(b.maxWorkers) || Math.ceil(items.length / swarm.items_per_worker);
    const clamped = [];
    if (swarm.max_workers < askedWorkers) {
      clamped.push(`workers: asked ${askedWorkers}, grant allows ${grant.max_workers}`);
    }
    if (b.maxSpendUsd && swarm.max_spend_usd < Number(b.maxSpendUsd)) {
      clamped.push(`budget: asked ${dollars(b.maxSpendUsd)}, grant allows ${dollars(grant.max_spend_usd)}`);
    }
    if (b.perWorkerUsd && swarm.per_worker_usd > Number(b.perWorkerUsd)) {
      clamped.push(`per-worker: asked ${dollars(b.perWorkerUsd)}, floor is ${dollars(swarm.per_worker_usd)}`);
    }

    // Warnings are about what the numbers MEAN, which the clamps alone do not say.
    // Both of these have a failure mode that looks like a bug from the lead's side:
    // a swarm that reports success having touched a fifth of the batch, and a swarm
    // whose every worker dies over_budget before producing a line.
    const capacity = swarm.max_workers * swarm.items_per_worker;
    const warnings = [];
    if (capacity < items.length) {
      warnings.push(`coverage: ${swarm.max_workers} workers x ${swarm.items_per_worker} items covers ${capacity} of ${items.length} items — raise --items-per-worker or split the batch`);
    }
    if (swarm.per_worker_usd < COLD_START_USD) {
      warnings.push(`per-worker budget ${dollars(swarm.per_worker_usd)} is under the ${dollars(COLD_START_USD)} a worker spends before it reads anything; expect over_budget`);
    }
    if (warnings.length) logSwarmEvent(swarm.id, 'warned', warnings.join('; '));

    res.json({
      ...swarmView(swarm),
      items: items.length,
      coverage: { items: items.length, capacity },
      clamped,
      warnings,
      estimate: estimateSwarm({ workers: swarm.max_workers, perWorkerUsd: swarm.per_worker_usd }),
      approvalRequired: swarm.state === 'pending_approval',
      note: 'nothing runs until a human approves this swarm in Maestro',
    });
  } catch (err) { fail(res, err); }
});

// ----------------------------------------------------------------- reading ---

router.get('/swarms', (req, res) => {
  // Scoped query rather than listSwarms(): that one returns the newest 50 swarms
  // across the whole system, so a busy day could hide this agent's own swarm from
  // it entirely -- and an agent that cannot see its swarm spawns another.
  const rows = getDb()
    .prepare('SELECT * FROM swarms WHERE spawner_agent_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(req.agent.id);
  res.json(rows.map((s) => {
    const l = swarmLedger(s.id);
    return { ...swarmView(s), spentUsd: money(l.spent), reservedUsd: money(l.reserved), live: l.live, launched: l.launched };
  }));
});

router.get('/swarms/:id', (req, res) => {
  const s = ownSwarm(req, res);
  if (!s) return;
  const l = swarmLedger(s.id);
  res.json({
    ...swarmView(s),
    ledger: { ...l, spent: money(l.spent), reserved: money(l.reserved) },
    // Global state is here because it explains a swarm that is approved and still
    // not spawning: the day cap, not this swarm, is the thing holding it.
    global: globalLedger(),
    workers: listWorkers(s.id).map(workerView),
  });
});

/**
 * What the lead collates. Failures are included on purpose: a result set with
 * holes in it is the normal outcome of a swarm, and a lead that only sees the
 * successes writes a confident summary of two thirds of the work.
 */
router.get('/swarms/:id/results', (req, res) => {
  const s = ownSwarm(req, res);
  if (!s) return;
  const workers = listWorkers(s.id);
  const terminal = workers.filter((w) => TERMINAL_WORKER_STATES.includes(w.state));
  const pending = workers.length - terminal.length;
  res.json({
    id: s.id,
    name: s.name,
    state: s.state,
    // `complete` is the question the lead is really asking: is it safe to collate
    // yet? Terminal workers alone cannot answer it -- a running swarm may not have
    // launched its last worker.
    complete: pending === 0 && ['done', 'halted', 'cancelled'].includes(s.state),
    pending,
    counts: terminal.reduce((acc, w) => ({ ...acc, [w.state]: (acc[w.state] || 0) + 1 }), {}),
    spentUsd: money(swarmLedger(s.id).spent),
    results: terminal.map((w) => ({
      workerId: w.id,
      idx: w.idx,
      state: w.state,
      prompt: w.prompt,
      result: w.result,
      costUsd: w.cost_usd,
      terminalReason: w.terminal_reason,
      errorSignature: w.error_signature,
    })),
  });
});

// ---------------------------------------------------------------- stopping ---

router.post('/swarms/:id/cancel', (req, res) => {
  const s = ownSwarm(req, res);
  if (!s) return;
  if (['done', 'halted', 'cancelled'].includes(s.state)) {
    return res.json({ ...swarmView(s), alreadyFinished: true });
  }
  // swarm.js exposes no cancel verb, only haltSwarm() -- which is the part that
  // matters, since admission refuses `halted` and `cancelled` identically. The
  // state is then narrowed, because a ledger that calls a deliberate stop the same
  // thing as a tripped brake teaches nobody anything.
  haltSwarm(s.id, `cancelled by ${req.agent.name}`);
  getDb().prepare("UPDATE swarms SET state = 'cancelled' WHERE id = ? AND state = 'halted'").run(s.id);

  const l = swarmLedger(s.id);
  res.json({
    ...swarmView(getSwarm(s.id)),
    // Cancelling stops ADMISSION. Workers already running own tmux sessions, and
    // only the runner may kill those -- marking them dead here while the process
    // kept billing would make the ledger lie in the one direction that matters.
    live: l.live,
    note: l.live ? `${l.live} worker(s) still finishing; no new ones will start` : 'no workers were live',
  });
});

export default router;
