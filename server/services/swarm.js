/**
 * Agent swarms: a named agent spawns a budget-capped batch of short-lived headless
 * workers that bill against the metered gateway key.
 *
 * This file is the whole correctness argument. It is pure SQLite -- no SSH, no
 * spawning -- so every brake can be tested exhaustively for nothing, and
 * `admitWorker()` is the ONLY function in the codebase that creates a worker row.
 * Everything that costs money passes through it first.
 *
 * Why the brakes are this paranoid, in measured numbers:
 *
 *   - A trivial worker costs $0.19 before doing any work: Claude Code writes a
 *     37,883-token system prompt, and this gateway bills cache-writes at the OUTPUT
 *     rate ($5/M). Cost scales with spawn count, not task difficulty. 20 trivial
 *     workers = $3.80 of pure startup.
 *   - A measured sub-agent round trip was $0.24.
 *   - The key's monthly budget is $2000, and LiteLLM's refusal is the only brake
 *     Maestro cannot be wrong about.
 *
 * Reservation is IMPLICIT -- computed per call, never stored. A stored counter
 * leaks permanently on a crash between reserve and launch, on a worker that never
 * reports, and on every admit-then-fail path; the swarm then refuses spawns forever
 * against money it never spent. A computed gate has no leak class and is
 * restart-safe by construction. The cost is pessimism: each in-flight worker is
 * charged at its full ceiling, so a swarm stops admitting with money unspent --
 * which is why the UI must show spent and reserved as separate numbers.
 */
import { randomUUID } from 'crypto';
import { getDb, getSetting, setSetting } from './db.js';

// Unavoidable startup cost of one worker, measured on this gateway. Used for
// estimates shown to a human before approval, never for the ledger.
export const SPAWN_FLOOR_USD = 0.19;

// Defaults. Every one is overridable per swarm (within the grant) or in settings.
export const DEFAULTS = {
  per_worker_usd: 0.4, // ~2 spawn floors of headroom
  per_worker_seconds: 480,
  max_concurrent: 4,
  items_per_worker: 3, // batching is what makes the $0.19 floor tolerable
};

const SETTING_DEFAULTS = {
  swarm_enabled: '0', // ships OFF; turned on only after the validation run
  swarm_max_live_workers: '8',
  swarm_daily_usd: '25',
  swarm_monthly_usd: '200',
};

export const TERMINAL_WORKER_STATES = ['done', 'failed', 'timeout', 'over_budget', 'cancelled'];
const LIVE_WORKER_STATES = ['admitted', 'launching', 'running'];

export function initSwarmTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      spawner_agent_id INTEGER NOT NULL,
      host_id INTEGER,
      account_dir TEXT NOT NULL,
      model TEXT,
      state TEXT NOT NULL DEFAULT 'pending_approval',
      paused INTEGER NOT NULL DEFAULT 0,
      halt_reason TEXT,
      max_workers INTEGER NOT NULL,
      max_concurrent INTEGER NOT NULL,
      max_spend_usd REAL NOT NULL,
      per_worker_usd REAL NOT NULL,
      per_worker_seconds INTEGER NOT NULL,
      items_per_worker INTEGER NOT NULL DEFAULT 1,
      workers_launched INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS swarm_workers (
      id TEXT PRIMARY KEY,
      swarm_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'admitted',
      session_name TEXT,
      prompt TEXT,
      result TEXT,
      error_signature TEXT,
      terminal_reason TEXT,
      cost_usd REAL,
      claude_session_id TEXT,
      report_token TEXT,
      deadline_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS swarm_worker_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swarm_id TEXT NOT NULL,
      worker_id TEXT,
      kind TEXT NOT NULL,
      note TEXT,
      at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Who may spawn workers at all, and the ceiling they may ask for. Written only
    -- by the admin router: an agent must not be able to widen its own authorization.
    CREATE TABLE IF NOT EXISTS swarm_grants (
      agent_id INTEGER PRIMARY KEY,
      max_workers INTEGER NOT NULL DEFAULT 4,
      max_spend_usd REAL NOT NULL DEFAULT 4.0,
      account_dir TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sw_state ON swarm_workers(swarm_id, state);
    CREATE INDEX IF NOT EXISTS idx_sw_live ON swarm_workers(state);
  `);
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
    if (getSetting(k) === null || getSetting(k) === undefined) setSetting(k, v);
  }
}

const num = (k) => Number(getSetting(k) ?? SETTING_DEFAULTS[k]);

function err(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

export function logSwarmEvent(swarmId, kind, note = null, workerId = null) {
  getDb().prepare('INSERT INTO swarm_worker_events (swarm_id, worker_id, kind, note) VALUES (?, ?, ?, ?)')
    .run(swarmId, workerId, kind, note);
}

// ---------------------------------------------------------------- grants ---

export function getGrant(agentId) {
  return getDb().prepare('SELECT * FROM swarm_grants WHERE agent_id = ?').get(agentId) || null;
}

export function maySwarm(agentId) {
  return !!getGrant(agentId);
}

export function grantSwarm(agentId, { maxWorkers = 4, maxSpendUsd = 4.0, accountDir }) {
  if (!accountDir || !String(accountDir).startsWith('/')) {
    throw err('BAD_ACCOUNT', 'accountDir must be an absolute path');
  }
  getDb().prepare(`INSERT INTO swarm_grants (agent_id, max_workers, max_spend_usd, account_dir)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(agent_id) DO UPDATE SET
                     max_workers = excluded.max_workers,
                     max_spend_usd = excluded.max_spend_usd,
                     account_dir = excluded.account_dir`)
    .run(agentId, maxWorkers, maxSpendUsd, accountDir);
  return getGrant(agentId);
}

export function revokeSwarmGrant(agentId) {
  getDb().prepare('DELETE FROM swarm_grants WHERE agent_id = ?').run(agentId);
}

// ------------------------------------------------------------- accounting ---

const liveWorkersAll = () =>
  getDb().prepare(
    `SELECT COUNT(*) n FROM swarm_workers WHERE state IN (${LIVE_WORKER_STATES.map(() => '?').join(',')})`
  ).get(...LIVE_WORKER_STATES).n;

const liveWorkers = (swarmId) =>
  getDb().prepare(
    `SELECT COUNT(*) n FROM swarm_workers WHERE swarm_id = ?
     AND state IN (${LIVE_WORKER_STATES.map(() => '?').join(',')})`
  ).get(swarmId, ...LIVE_WORKER_STATES).n;

const spentSwarm = (swarmId) =>
  getDb().prepare('SELECT COALESCE(SUM(cost_usd),0) s FROM swarm_workers WHERE swarm_id = ?').get(swarmId).s;

const spentSince = (sqlInterval) =>
  getDb().prepare(
    `SELECT COALESCE(SUM(w.cost_usd),0) s FROM swarm_workers w
     WHERE w.created_at > datetime('now', ?)`
  ).get(sqlInterval).s;

/** Everything the UI and the approval card need, without creating anything. */
export function swarmLedger(swarmId) {
  const s = getSwarm(swarmId);
  if (!s) return null;
  const live = liveWorkers(swarmId);
  return {
    spent: spentSwarm(swarmId),
    reserved: live * s.per_worker_usd,
    cap: s.max_spend_usd,
    live,
    launched: s.workers_launched,
    maxWorkers: s.max_workers,
  };
}

export function globalLedger() {
  return {
    liveWorkers: liveWorkersAll(),
    maxLiveWorkers: num('swarm_max_live_workers'),
    spentToday: spentSince('-1 day'),
    dailyCap: num('swarm_daily_usd'),
    spentMonth: spentSince('-30 days'),
    monthlyCap: num('swarm_monthly_usd'),
    enabled: getSetting('swarm_enabled') === '1',
  };
}

// ----------------------------------------------------------------- swarms ---

export function getSwarm(id) {
  return getDb().prepare('SELECT * FROM swarms WHERE id = ?').get(id) || null;
}

export function listSwarms({ activeOnly = false } = {}) {
  const sql = activeOnly
    ? "SELECT * FROM swarms WHERE state NOT IN ('done','halted','cancelled') ORDER BY created_at"
    : 'SELECT * FROM swarms ORDER BY created_at DESC LIMIT 50';
  return getDb().prepare(sql).all();
}

/**
 * Create a swarm in `pending_approval`. Requests above the grant are CLAMPED, not
 * rejected: a refusal teaches the lead to route around the gate (it has
 * unrestricted bash and can find the account dir), whereas a smaller swarm that
 * still runs keeps it inside the system where the brakes apply.
 */
export function createSwarm({
  name, spawnerAgentId, hostId = null, items = [],
  maxWorkers, maxSpendUsd, perWorkerUsd, perWorkerSeconds, itemsPerWorker, model = null,
}) {
  const grant = getGrant(spawnerAgentId);
  if (getSetting('swarm_enabled') !== '1') throw err('DISABLED', 'swarms are disabled');
  if (!grant) throw err('NOT_PERMITTED', 'this agent has no swarm grant');
  if (!name || !String(name).trim()) throw err('EMPTY', 'a swarm needs a name');

  const perWorker = Math.max(0.05, Number(perWorkerUsd) || DEFAULTS.per_worker_usd);
  const ipw = Math.max(1, Number(itemsPerWorker) || DEFAULTS.items_per_worker);
  const wanted = Math.max(1, Number(maxWorkers) || Math.ceil((items.length || 1) / ipw));
  const workers = Math.min(wanted, grant.max_workers);
  const spend = Math.min(Number(maxSpendUsd) || grant.max_spend_usd, grant.max_spend_usd);

  const id = randomUUID();
  getDb().prepare(`INSERT INTO swarms
      (id, name, spawner_agent_id, host_id, account_dir, model, state,
       max_workers, max_concurrent, max_spend_usd, per_worker_usd, per_worker_seconds, items_per_worker)
      VALUES (?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?)`)
    .run(id, String(name).trim(), spawnerAgentId, hostId, grant.account_dir, model,
      workers, Math.min(DEFAULTS.max_concurrent, workers), spend, perWorker,
      Math.max(30, Number(perWorkerSeconds) || DEFAULTS.per_worker_seconds), ipw);

  logSwarmEvent(id, 'created', `${items.length} items, ${workers} workers, cap $${spend.toFixed(2)}`);
  if (workers < wanted) {
    logSwarmEvent(id, 'clamped', `asked for ${wanted} workers, grant allows ${grant.max_workers}`);
  }
  return getSwarm(id);
}

export function approveSwarm(id) {
  const s = getSwarm(id);
  if (!s) throw err('NO_SWARM', 'unknown swarm');
  if (s.state !== 'pending_approval') throw err('STATE', `swarm is ${s.state}`);
  getDb().prepare("UPDATE swarms SET state = 'running' WHERE id = ?").run(id);
  logSwarmEvent(id, 'approved');
  return getSwarm(id);
}

export function setSwarmPaused(id, paused) {
  getDb().prepare('UPDATE swarms SET paused = ? WHERE id = ?').run(paused ? 1 : 0, id);
  logSwarmEvent(id, paused ? 'paused' : 'resumed');
  return getSwarm(id);
}

export function haltSwarm(id, reason) {
  getDb().prepare("UPDATE swarms SET state = 'halted', halt_reason = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(reason, id);
  logSwarmEvent(id, 'halted', reason);
  return getSwarm(id);
}

/**
 * Global stop. The gateway refusing on budget is not a transient error -- LiteLLM
 * tags it rate_limit_type=BUDGET at HTTP 429, so retrying hammers a dead key
 * forever. Everything stops and a human has to turn it back on.
 */
export function tripKillSwitch(reason) {
  setSetting('swarm_enabled', '0');
  const live = getDb().prepare(
    `SELECT * FROM swarm_workers WHERE state IN (${LIVE_WORKER_STATES.map(() => '?').join(',')})`
  ).all(...LIVE_WORKER_STATES);
  getDb().prepare(
    `UPDATE swarms SET state='halted', halt_reason=?, finished_at=CURRENT_TIMESTAMP
     WHERE state NOT IN ('done','halted','cancelled')`
  ).run(reason);
  return { reason, liveWorkers: live };
}

// ------------------------------------------------------- the admission gate ---

/**
 * The only path that creates a worker. Every check runs inside one transaction so
 * two concurrent spawns cannot both pass a gate that only one of them fits through.
 *
 * Order matters: cheapest and most absolute first, so a disabled system never
 * touches the ledger, and the daily/monthly gates (which bound real money across
 * all swarms) come before the per-swarm ones.
 */
export function admitWorker(swarmId, { idx, prompt = null, sessionName = null }) {
  const db = getDb();
  const run = db.transaction(() => {
    if (getSetting('swarm_enabled') !== '1') throw err('DISABLED', 'swarms are disabled');

    const s = getSwarm(swarmId);
    if (!s) throw err('NO_SWARM', 'unknown swarm');
    if (!maySwarm(s.spawner_agent_id)) throw err('NOT_GRANTED', 'spawner has no swarm grant');
    if (s.state === 'halted' || s.state === 'cancelled') throw err('HALTED', `swarm is ${s.state}`);
    if (s.state !== 'running') throw err('NOT_RUNNING', `swarm is ${s.state}`);
    if (s.paused) throw err('PAUSED', 'spawning is paused');

    const liveAll = liveWorkersAll();
    const maxLive = num('swarm_max_live_workers');
    if (liveAll >= maxLive) {
      throw err('GLOBAL_CONCURRENCY', `${liveAll}/${maxLive} workers already live across all swarms`);
    }

    // In-flight workers are charged at their full ceiling, and the daily/monthly
    // gates count them ACROSS swarms -- without that, a lead looping `spawn`
    // creates N swarms that each pass the day gate at $0 observed.
    const projected = (liveAll + 1) * s.per_worker_usd;

    const today = spentSince('-1 day');
    const dailyCap = num('swarm_daily_usd');
    if (today + projected > dailyCap) {
      throw err('DAILY_SPEND', `daily cap: $${today.toFixed(2)} spent + $${projected.toFixed(2)} reserved > $${dailyCap}`);
    }

    const month = spentSince('-30 days');
    const monthlyCap = num('swarm_monthly_usd');
    if (month + projected > monthlyCap) {
      throw err('MONTHLY_SPEND', `monthly cap: $${month.toFixed(2)} + $${projected.toFixed(2)} > $${monthlyCap}`);
    }

    if (s.workers_launched >= s.max_workers) {
      throw err('SWARM_WORKERS', `swarm already launched ${s.workers_launched}/${s.max_workers}`);
    }

    const live = liveWorkers(swarmId);
    if (live >= s.max_concurrent) {
      throw err('SWARM_CONCURRENCY', `${live}/${s.max_concurrent} concurrent in this swarm`);
    }

    const spent = spentSwarm(swarmId);
    const swarmProjected = (live + 1) * s.per_worker_usd;
    if (spent + swarmProjected > s.max_spend_usd) {
      throw err('SWARM_SPEND',
        `swarm cap: $${spent.toFixed(2)} spent + $${swarmProjected.toFixed(2)} reserved > $${s.max_spend_usd}`);
    }

    const id = randomUUID();
    const deadline = new Date(Date.now() + s.per_worker_seconds * 1000).toISOString();
    db.prepare(`INSERT INTO swarm_workers (id, swarm_id, idx, state, prompt, session_name, report_token, deadline_at)
                VALUES (?, ?, ?, 'admitted', ?, ?, ?, ?)`)
      .run(id, swarmId, idx, prompt, sessionName, randomUUID(), deadline);
    db.prepare('UPDATE swarms SET workers_launched = workers_launched + 1 WHERE id = ?').run(swarmId);
    return id;
  });
  const workerId = run();
  return getWorker(workerId);
}

export function getWorker(id) {
  return getDb().prepare('SELECT * FROM swarm_workers WHERE id = ?').get(id) || null;
}

export function setWorkerState(id, state, fields = {}) {
  const sets = ['state = ?'];
  const vals = [state];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
  if (TERMINAL_WORKER_STATES.includes(state)) sets.push('finished_at = CURRENT_TIMESTAMP');
  vals.push(id);
  getDb().prepare(`UPDATE swarm_workers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getWorker(id);
}

/**
 * A worker reporting its own result. cost_usd is CLAMPED: it is a client-side
 * estimate from a price table the vendor says not to bill from, produced by a
 * process whose prompt the lead wrote. Clamping at 1.5x the ceiling means a lying
 * worker can make the dashboard optimistic but can never raise anyone's headroom.
 */
export function finishWorker(id, { state, result = null, costUsd = null, terminalReason = null, errorSignature = null, claudeSessionId = null }) {
  const w = getWorker(id);
  if (!w) throw err('NO_WORKER', 'unknown worker');
  if (TERMINAL_WORKER_STATES.includes(w.state)) return w; // idempotent: reports retry
  const s = getSwarm(w.swarm_id);
  const ceiling = (s ? s.per_worker_usd : DEFAULTS.per_worker_usd) * 1.5;
  // Rounded to 6dp: these are dollars, and the clamp arithmetic otherwise stores
  // artefacts like 0.6000000000000001 in a money column.
  const cost = costUsd === null
    ? null
    : Math.round(Math.min(Math.max(0, Number(costUsd) || 0), ceiling) * 1e6) / 1e6;
  return setWorkerState(id, state, {
    result,
    cost_usd: cost,
    terminal_reason: terminalReason,
    error_signature: errorSignature,
    claude_session_id: claudeSessionId,
  });
}

export function listWorkers(swarmId) {
  return getDb().prepare('SELECT * FROM swarm_workers WHERE swarm_id = ? ORDER BY idx').all(swarmId);
}

/** What the approval card shows. Floor is separate from ceiling on purpose: it is
 *  what makes one-worker-per-item visibly uneconomic before anyone approves it. */
export function estimateSwarm({ workers, perWorkerUsd }) {
  return {
    workers,
    floorUsd: +(workers * SPAWN_FLOOR_USD).toFixed(2),
    ceilingUsd: +(workers * perWorkerUsd).toFixed(2),
    spawnFloorEach: SPAWN_FLOOR_USD,
  };
}
