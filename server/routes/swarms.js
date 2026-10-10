/**
 * The browser's half of swarms: a human approving, watching and stopping them.
 *
 * A separate router from swarmApi.js because the two have different authorities.
 * That one authenticates an AGENT and refuses anything outside the agent's own
 * swarm; this one authenticates a SESSION and may approve spend -- which is exactly
 * what an agent must never reach. Nothing here is mounted under /api/agent, and
 * POST /grants (the authorization boundary itself) is admin-only on top of that.
 *
 * Everything that costs money still lives in swarm.js, and the runner is still the
 * only thing that kills a worker. This router approves, narrows, pauses and halts;
 * it never spawns and never reaches into tmux.
 *
 * The read endpoints are shaped by the UI's poll, not by the tables: one request per
 * band, with every derived number (ages, attention, counts, previews) computed here
 * so the client is never doing arithmetic on a timestamp or inventing a rule of its
 * own about what "stuck" means.
 */
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getAgent, getDb } from '../services/db.js';
import {
  approveSwarm, estimateSwarm, getGrant, getSwarm, globalLedger, grantSwarm,
  haltSwarm, initSwarmTables, listSwarms, listWorkers, logSwarmEvent,
  revokeSwarmGrant, setSwarmPaused, swarmLedger,
  pendingAuthorizations, listAuthorizations, decideAuthorization, revokeAuthorization,
} from '../services/swarm.js';
import { swarmItemStats, killSwarmWorkers, killOneWorker} from '../services/swarmRunner.js';

const router = Router();
router.use(requireAuth);

// The dashboard polls this router before anything has ever created a swarm, so it is
// routinely the first code to touch these tables, and "no such table: swarms" is not
// a useful first impression. CREATE TABLE IF NOT EXISTS is idempotent, so running it
// here costs one statement per boot.
//
// On the first request, not at import: index.js imports every router before it calls
// initDb(), so getDb() at module scope throws "database not initialised".
let tablesReady = false;
router.use((req, res, next) => {
  if (!tablesReady) {
    initSwarmTables();
    tablesReady = true;
  }
  next();
});

const LIVE_STATES = ['admitted', 'launching', 'running'];
const DEAD_STATES = ['failed', 'timeout', 'over_budget'];
const FINISHED_STATES = ['done', 'halted', 'cancelled'];

// Mirrors swarmRunner's LAUNCH_GRACE_S. An admitted worker has no session yet, which
// is not "stuck" -- until it has been that way for longer than a launch ever takes.
const LAUNCH_STALL_S = 90;

// A status poll must stay a status poll: dragging 20 workers' complete answers across
// every 2s tick is how a dashboard becomes the most expensive thing on the box. The
// preview is enough to judge a result; the spawning agent collects the full text from
// GET /api/agent/swarms/:id/results, which is what it is for.
const RESULT_PREVIEW_CHARS = 1200;
const PROMPT_PREVIEW_CHARS = 400;
const EVENT_NOTE_CHARS = 300;

const STATUS = {
  NO_SWARM: 404, NO_AGENT: 404,
  STATE: 409, HALTED: 409,
  BAD_ACCOUNT: 400, BAD_REQUEST: 400, EMPTY: 400,
  DISABLED: 409, NOT_PERMITTED: 403,
};

const fail = (res, err) => {
  const code = err.code || 'ERROR';
  res.status(STATUS[code] ?? 500).json({ error: err.message, code });
};

const refuse = (res, code, message) =>
  res.status(STATUS[code] ?? 500).json({ error: message, code });

const money = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4;

/**
 * SQLite writes CURRENT_TIMESTAMP as naive UTC ("YYYY-MM-DD HH:MM:SS") while
 * admitWorker() stores deadline_at as an ISO string with a Z. Date.parse() reads the
 * first as LOCAL time -- hours in the future for anyone west of UTC, which would
 * render every live worker as "0s old" and every deadline as already missed. So the
 * server normalizes once and the client only ever receives seconds.
 */
const msOf = (v) => {
  if (!v) return null;
  const s = typeof v === 'string' && !/[TZ]/.test(v) ? `${v.replace(' ', 'T')}Z` : v;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};
const agoS = (v) => {
  const t = msOf(v);
  return t === null ? null : Math.max(0, Math.round((Date.now() - t) / 1000));
};
const untilS = (v) => {
  const t = msOf(v);
  return t === null ? null : Math.round((t - Date.now()) / 1000);
};

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s || null);

/**
 * One definition of "stalled", in SQL, serving both the per-swarm badge and the
 * per-worker NEEDS YOU band. Two implementations of this predicate would drift, and
 * the UI would then disagree with itself about which worker is stuck.
 *
 * It exists at all because the two states a human goes looking for are invisible in
 * `state`: a worker wedged before launch, and one past its deadline that the runner
 * has not reaped yet. Both still read as alive.
 */
const stalledStmt = () => getDb().prepare(`
  SELECT id, swarm_id FROM swarm_workers
   WHERE state IN ('admitted','launching','running')
     AND (@swarmId IS NULL OR swarm_id = @swarmId)
     AND (
       (state = 'running'
          AND deadline_at IS NOT NULL
          AND strftime('%s', deadline_at) < strftime('%s','now'))
       OR (state IN ('admitted','launching')
          AND strftime('%s','now') - strftime('%s', created_at) > @graceS)
     )`);

const stalledRows = (swarmId = null) =>
  stalledStmt().all({ swarmId, graceS: LAUNCH_STALL_S });

// The five numbers a human reads, plus the raw per-state tally under `byState`. The
// summaries are kept out of that map on purpose: `done` as both a roll-up and a
// state name in one object double-counts the moment anything adds them together.
const emptyCounts = () => ({ live: 0, done: 0, failures: 0, cancelled: 0, stalled: 0, byState: {} });

function tally(counts, state, n = 1) {
  if (LIVE_STATES.includes(state)) counts.live += n;
  else if (state === 'done') counts.done += n;
  else if (DEAD_STATES.includes(state)) counts.failures += n;
  else if (state === 'cancelled') counts.cancelled += n;
  counts.byState[state] = (counts.byState[state] || 0) + n;
  return counts;
}

/** Worker state counts for every swarm at once: the list view needs 50 of these. */
function countsBySwarm() {
  const out = {};
  const at = (id) => out[id] || (out[id] = emptyCounts());
  for (const r of getDb()
    .prepare('SELECT swarm_id, state, COUNT(*) n FROM swarm_workers GROUP BY swarm_id, state')
    .all()) {
    tally(at(r.swarm_id), r.state, r.n);
  }
  for (const r of stalledRows()) at(r.swarm_id).stalled += 1;
  return out;
}

/** Items live in swarmRunner's table, which only exists once the runner has run. */
function itemStats(swarmId) {
  try {
    const s = swarmItemStats(swarmId);
    return s.total > 0 ? s : null;
  } catch {
    return null; // no swarm_items table yet; the swarm is simply too new to show items
  }
}

function spawnerView(agentId) {
  const a = getAgent(agentId);
  // A deleted spawner must not blank the card: its swarm may still be spending, and
  // "who asked for this" is the first thing a human wants when deciding to halt it.
  if (!a) return { id: agentId, name: `agent #${agentId}`, deleted: true };
  return { id: a.id, name: a.name, projectName: a.project_name || null, session: a.screen_session };
}

function grantView(agentId, isAdmin) {
  const g = getGrant(agentId);
  if (!g) return null;
  return {
    maxWorkers: g.max_workers,
    maxSpendUsd: money(g.max_spend_usd),
    // The account dir is a filesystem path only an admin can change. Everyone sees
    // the limits, which is what the approval decision actually rests on.
    ...(isAdmin ? { accountDir: g.account_dir } : {}),
  };
}

function swarmView(s, counts, isAdmin) {
  const l = swarmLedger(s.id);
  return {
    id: s.id,
    name: s.name,
    state: s.state,
    paused: !!s.paused,
    haltReason: s.halt_reason,
    model: s.model,
    maxWorkers: s.max_workers,
    maxConcurrent: s.max_concurrent,
    maxSpendUsd: money(s.max_spend_usd),
    perWorkerUsd: money(s.per_worker_usd),
    perWorkerSeconds: s.per_worker_seconds,
    itemsPerWorker: s.items_per_worker,
    createdAt: s.created_at,
    finishedAt: s.finished_at,
    createdAgoS: agoS(s.created_at),
    finishedAgoS: agoS(s.finished_at),
    spawner: spawnerView(s.spawner_agent_id),
    // spent and reserved are never summed for the client. The admission gate compares
    // spent + reserved against the cap, so a swarm refuses spawns with money
    // apparently unspent -- and a single "$1.20 / $4.00" would make that look broken.
    ledger: { ...l, spent: money(l.spent), reserved: money(l.reserved), cap: money(l.cap) },
    counts: counts || emptyCounts(),
    items: itemStats(s.id),
    estimate: estimateSwarm({ workers: s.max_workers, perWorkerUsd: s.per_worker_usd }),
    grant: grantView(s.spawner_agent_id, isAdmin),
    finished: FINISHED_STATES.includes(s.state),
  };
}

function workerView(w, stalled) {
  const attention = DEAD_STATES.includes(w.state)
    ? w.state
    : (stalled.has(w.id) ? 'stalled' : null);
  return {
    id: w.id,
    idx: w.idx,
    state: w.state,
    attention,
    session: w.session_name,
    costUsd: w.cost_usd === null ? null : money(w.cost_usd),
    terminalReason: w.terminal_reason,
    errorSignature: w.error_signature,
    claudeSessionId: w.claude_session_id,
    ageS: agoS(w.created_at),
    // Negative once the deadline has passed: that is the state the runner is about to
    // reap, and a countdown that stops at zero hides it.
    remainingS: LIVE_STATES.includes(w.state) ? untilS(w.deadline_at) : null,
    finishedAgoS: agoS(w.finished_at),
    promptPreview: clip(w.prompt, PROMPT_PREVIEW_CHARS),
    result: clip(w.result, RESULT_PREVIEW_CHARS),
    resultChars: w.result ? w.result.length : 0,
    resultTruncated: !!(w.result && w.result.length > RESULT_PREVIEW_CHARS),
  };
}

/**
 * The event tail, minus the batch itself. POST /api/agent/swarms records every item
 * as one `items` event, which for a 500-item swarm is megabytes of JSON -- shipping
 * that on a 2s poll would be the single heaviest request in Maestro.
 */
function eventsView(swarmId, limit = 60) {
  return getDb().prepare(
    `SELECT id, kind, note, worker_id, at FROM swarm_worker_events
      WHERE swarm_id = ? AND kind != 'items' ORDER BY id DESC LIMIT ?`
  ).all(swarmId, limit).map((e) => ({
    id: e.id,
    kind: e.kind,
    note: clip(e.note, EVENT_NOTE_CHARS),
    workerId: e.worker_id,
    at: e.at,
    agoS: agoS(e.at),
  }));
}

/** The swarm named in the URL, or null after answering the request. */
function namedSwarm(req, res) {
  const s = getSwarm(req.params.id);
  if (!s) { refuse(res, 'NO_SWARM', 'unknown swarm'); return null; }
  return s;
}

const isAdmin = (req) => req.user?.role === 'admin';

// ----------------------------------------------------------------- reading ---

router.get('/', (req, res) => {
  try {
    const counts = countsBySwarm();
    const admin = isAdmin(req);
    const swarms = listSwarms({ activeOnly: req.query.activeOnly === '1' })
      .map((s) => swarmView(s, counts[s.id], admin));
    // The global ledger rides along because it is the answer to "approved and still
    // not spawning": the day cap or the kill switch, not this swarm.
    res.json({ swarms, global: globalLedger() });
  } catch (err) { fail(res, err); }
});

// ------------------------------------------------------------------ grants ---

/**
 * Who may spawn workers at all. This is THE authorization boundary: a grant is the
 * difference between an agent that can ask for money and one that cannot, so it is
 * admin-only and lives nowhere an agent can reach. createSwarm() clamps every
 * request to these numbers.
 *
 * Declared ahead of GET /:id deliberately -- Express matches in order, and a bare
 * `/grants` otherwise arrives as a swarm id and 404s.
 */
router.get('/grants', requireAdmin, (req, res) => {
  try {
    const rows = getDb().prepare('SELECT * FROM swarm_grants ORDER BY created_at').all();
    res.json(rows.map((g) => ({
      agentId: g.agent_id,
      agent: spawnerView(g.agent_id),
      maxWorkers: g.max_workers,
      maxSpendUsd: money(g.max_spend_usd),
      accountDir: g.account_dir,
      createdAt: g.created_at,
    })));
  } catch (err) { fail(res, err); }
});

router.post('/grants', requireAdmin, (req, res) => {
    // A shell agent's pane executes what is pasted into it, and swarm summaries
    // quote worker output, so granting one swarm rights creates a command-injection
    // path from any worker. Refuse at the boundary rather than silently withholding
    // the summary later.
    const tgt = getAgent(Number(req.body && req.body.agentId));
    if (tgt && ((tgt.config && tgt.config.provider) || 'claude') === 'shell') {
      return res.status(400).json({ error: 'shell agents cannot be granted swarm rights', code: 'BAD_PROVIDER' });
    }
  try {
    const { agentId, maxWorkers, maxSpendUsd, accountDir } = req.body || {};
    // Checked before the lookup: better-sqlite3 refuses to bind undefined or NaN, so
    // a missing agentId would come back as a 500 about parameter binding rather than
    // "unknown agent".
    const id = Number(agentId);
    const agent = Number.isInteger(id) ? getAgent(id) : null;
    if (!agent) return refuse(res, 'NO_AGENT', 'unknown agent');
    const workers = Math.floor(Number(maxWorkers));
    const spend = Number(maxSpendUsd);
    if (!Number.isFinite(workers) || workers < 1) {
      return refuse(res, 'BAD_REQUEST', 'maxWorkers must be at least 1');
    }
    if (!Number.isFinite(spend) || spend <= 0) {
      return refuse(res, 'BAD_REQUEST', 'maxSpendUsd must be greater than 0');
    }
    const grant = grantSwarm(agent.id, { maxWorkers: workers, maxSpendUsd: spend, accountDir  });
    res.json({
      agentId: grant.agent_id,
      agent: spawnerView(grant.agent_id),
      maxWorkers: grant.max_workers,
      maxSpendUsd: money(grant.max_spend_usd),
      accountDir: grant.account_dir,
    });
  } catch (err) { fail(res, err); }
});

router.delete('/grants/:agentId', requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.agentId);
    if (!Number.isInteger(id)) return refuse(res, 'BAD_REQUEST', 'agentId must be a number');
    // Revoking does not stop a swarm that is already running: admission re-checks the
    // grant on every worker (NOT_GRANTED), so the current batch finishes and no new
    // worker is admitted. Stopping one now is what /cancel is for.
    revokeSwarmGrant(id);
    res.json({ success: true });
  } catch (err) { fail(res, err); }
});

// ------------------------------------------------------------ one swarm ---

router.get('/:id', (req, res) => {
  try {
    const s = namedSwarm(req, res);
    if (!s) return;
    const stalled = new Set(stalledRows(s.id).map((r) => r.id));
    const workers = listWorkers(s.id);
    const counts = workers.reduce((c, w) => tally(c, w.state), { ...emptyCounts(), stalled: stalled.size });
    res.json({
      ...swarmView(s, counts, isAdmin(req)),
      workers: workers.map((w) => workerView(w, stalled)),
      events: eventsView(s.id),
      global: globalLedger(),
    });
  } catch (err) { fail(res, err); }
});

// ------------------------------------------------------------ the decision ---

/**
 * Approve, optionally smaller.
 *
 * maxWorkers/maxSpendUsd may only NARROW what the agent asked for. Widening here
 * would route around createSwarm()'s clamp to the grant, which is the one number an
 * agent is not allowed to choose -- so an out-of-range value is ignored rather than
 * rejected, and the swarm still runs at its original size.
 */
router.post('/:id/approve', (req, res) => {
  try {
    const s = namedSwarm(req, res);
    if (!s) return;
    if (s.state !== 'pending_approval') return refuse(res, 'STATE', `swarm is ${s.state}`);

    const db = getDb();
    const workers = Number(req.body?.maxWorkers);
    const spend = Number(req.body?.maxSpendUsd);
    const narrowed = [];
    if (Number.isFinite(workers) && workers >= 1 && workers < s.max_workers) {
      // max_concurrent cannot exceed the worker count, or the swarm advertises a
      // parallelism it can never reach and the panel's +/- lies about its ceiling.
      db.prepare('UPDATE swarms SET max_workers = ?, max_concurrent = MIN(max_concurrent, ?) WHERE id = ?')
        .run(Math.floor(workers), Math.floor(workers), s.id);
      narrowed.push(`workers ${s.max_workers} -> ${Math.floor(workers)}`);
    }
    if (Number.isFinite(spend) && spend > 0 && spend < s.max_spend_usd) {
      db.prepare('UPDATE swarms SET max_spend_usd = ? WHERE id = ?').run(spend, s.id);
      narrowed.push(`cap $${s.max_spend_usd} -> $${spend}`);
    }
    if (narrowed.length) logSwarmEvent(s.id, 'narrowed', `${req.user?.username || 'a user'}: ${narrowed.join(', ')}`);

    approveSwarm(s.id);
    logSwarmEvent(s.id, 'approved_by', req.user?.username || 'unknown user');
    const counts = countsBySwarm();
    res.json(swarmView(getSwarm(s.id), counts[s.id], isAdmin(req)));
  } catch (err) { fail(res, err); }
});

router.post('/:id/pause', (req, res) => {
  try {
    const s = namedSwarm(req, res);
    if (!s) return;
    if (FINISHED_STATES.includes(s.state)) return refuse(res, 'STATE', `swarm is ${s.state}`);
    const paused = !!req.body?.paused;
    setSwarmPaused(s.id, paused);
    const counts = countsBySwarm();
    res.json(swarmView(getSwarm(s.id), counts[s.id], isAdmin(req)));
  } catch (err) { fail(res, err); }
});

/**
 * Stop admitting. Live workers are NOT marked dead here: they own tmux sessions and
 * are still billing, and only the runner may kill them. Reporting them as finished
 * while the processes kept spending would make the ledger lie in the one direction
 * that matters.
 */
router.post('/:id/cancel', async (req, res) => {
  try {
    const s = namedSwarm(req, res);
    if (!s) return;
    if (FINISHED_STATES.includes(s.state)) {
      const counts = countsBySwarm();
      return res.json({ ...swarmView(s, counts[s.id], isAdmin(req)), alreadyFinished: true });
    }
    const who = req.user?.username || 'a user';
    const denied = s.state === 'pending_approval';
    // swarm.js exposes no cancel verb, only haltSwarm() -- which is the part that
    // matters, since admission refuses `halted` and `cancelled` identically. The
    // state is then narrowed, because a ledger that calls a deliberate stop the same
    // thing as a tripped brake teaches nobody anything. Same two steps as the
    // agent-facing cancel route.
    haltSwarm(s.id, denied ? `denied by ${who}` : `cancelled by ${who}`);
    getDb().prepare("UPDATE swarms SET state = 'cancelled' WHERE id = ? AND state = 'halted'").run(s.id);
    // Halting only stops NEW workers. Someone pressing cancel is trying to stop
    // spending, so the live ones must die too -- otherwise a cancelled swarm keeps
    // billing while the UI cheerfully calls it "still finishing".
    const killed = await killSwarmWorkers(s.id, `cancelled by ${who}`);

    const counts = countsBySwarm();
    const view = swarmView(getSwarm(s.id), counts[s.id], isAdmin(req));
    res.json({
      ...view,
      note: killed ? `${killed} running worker(s) killed` : 'no workers were live',
    });
  } catch (err) { fail(res, err); }
});
/**
 * Kill one worker. Separate from cancelling the swarm because the common case is a
 * single wedged worker holding a concurrency slot while the rest of the batch is
 * fine -- killing the whole swarm to clear it would throw away good work.
 */
router.post('/:id/workers/:workerId/kill', async (req, res) => {
  try {
    const s = namedSwarm(req, res);
    if (!s) return;
    const who = req.user?.username || 'a user';
    const w = await killOneWorker(req.params.workerId, `killed by ${who}`);
    if (!w) return res.status(404).json({ error: 'unknown worker' });
    if (w.swarm_id !== s.id) return res.status(400).json({ error: 'worker is not in this swarm' });
    const counts = countsBySwarm();
    res.json({ worker: w, swarm: swarmView(getSwarm(s.id), counts[s.id], isAdmin(req)) });
  } catch (err) { fail(res, err); }
});


/** How many of this swarm's workers may run at once. The cheapest brake there is. */
router.post('/:id/concurrency', (req, res) => {
  try {
    const s = namedSwarm(req, res);
    if (!s) return;
    if (FINISHED_STATES.includes(s.state)) return refuse(res, 'STATE', `swarm is ${s.state}`);
    const n = Math.floor(Number(req.body?.n));
    if (!Number.isFinite(n) || n < 1) return refuse(res, 'BAD_REQUEST', 'n must be at least 1');
    // Clamped, not refused: the ceiling is the swarm's own worker count, and a +
    // button that errors at the top of its range instead of stopping is just noise.
    // Raising it never widens spend -- the budget gates are unchanged by this.
    const next = Math.min(n, s.max_workers);
    getDb().prepare('UPDATE swarms SET max_concurrent = ? WHERE id = ?').run(next, s.id);
    if (next !== s.max_concurrent) {
      logSwarmEvent(s.id, 'concurrency', `${s.max_concurrent} -> ${next} by ${req.user?.username || 'a user'}`);
    }
    const counts = countsBySwarm();
    res.json(swarmView(getSwarm(s.id), counts[s.id], isAdmin(req)));
  } catch (err) { fail(res, err); }
});

// --- standing authorizations (the human side) -------------------------------

router.get('/authorizations/pending', (req, res) => res.json(pendingAuthorizations()));
router.get('/authorizations', (req, res) => res.json(listAuthorizations()));

router.post('/authorizations/:id/decide', (req, res) => {
  const { approved, usd, hours } = req.body || {};
  try {
    res.json(decideAuthorization(req.params.id, !!approved, { usd, hours }));
  } catch (err) {
    res.status(err.code === 'NO_AUTH' ? 404 : 400).json({ error: err.message, code: err.code });
  }
});

router.post('/authorizations/:id/revoke', (req, res) => {
  res.json(revokeAuthorization(req.params.id, (req.body && req.body.reason) || 'revoked'));
});

export default router;
