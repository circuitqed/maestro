/**
 * Agent-to-agent tasks: one agent assigns work to another and gets the result back
 * without a human relaying messages.
 *
 * The delivery mechanism is the one Maestro already has -- text injected into the
 * target's tmux session -- so the worker keeps its own session, context and
 * Anthropic account. What is new here is durable state around that: an assignment
 * survives a Maestro restart, a retry does not run the work twice, and the requester
 * is told when it finishes instead of polling.
 *
 * Deliberately narrow for a first cut, following the requesting agent's own advice:
 * one orchestrator talking to one worker, an explicit allowlist of who may address
 * whom, and a daily cap. Delegation spends real model usage on someone's
 * subscription, so the blast radius of a loop that does not converge is a weekly
 * limit -- the cap exists before the feature is useful, not after.
 *
 * What this does NOT do, on purpose:
 *   - promise exactly-once execution (see reconcile note on deliverQueued)
 *   - answer trust/approval prompts; those surface as a blocker for a human
 *   - grant the worker any permission the user has not already given it
 */
import { randomUUID } from 'crypto';
import { getDb } from './db.js';

// A task may only be delivered to an agent that has looked idle for this many
// consecutive monitor ticks. Busy/idle is inferred from pane text, not a real
// signal, so a single idle reading is not evidence the worker finished a turn.
const IDLE_TICKS_REQUIRED = 2;

// Per requester, per rolling day. A runaway delegation loop burns a weekly usage
// limit unattended; this bounds it.
const DAILY_TASK_CAP = 40;

export const TERMINAL_STATES = ['completed', 'blocked', 'failed', 'cancelled'];

export function initTaskTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      requester_agent_id INTEGER NOT NULL,
      target_agent_id INTEGER NOT NULL,
      idempotency_key TEXT,
      state TEXT NOT NULL DEFAULT 'queued',
      instructions TEXT NOT NULL,
      working_dir TEXT,
      deliverables TEXT,
      result TEXT,
      blocker TEXT,
      artifacts TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      delivered_at DATETIME,
      finished_at DATETIME,
      notified_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS agent_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      state TEXT NOT NULL,
      note TEXT,
      at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Who may assign work to whom. An explicit pair list rather than a general
    -- capability: one agent writing into another's session is prompt injection with
    -- extra steps, so the set of senders a worker will accept is enumerated.
    CREATE TABLE IF NOT EXISTS agent_delegation (
      requester_agent_id INTEGER NOT NULL,
      target_agent_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (requester_agent_id, target_agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_state ON agent_tasks(state);
    CREATE INDEX IF NOT EXISTS idx_tasks_target ON agent_tasks(target_agent_id, state);
  `);
  // Retrying a submission must return the original task, not create a second one.
  // Unique on (requester, key) so two requesters can reuse the same key safely.
  try {
    db.exec('CREATE UNIQUE INDEX idx_tasks_idem ON agent_tasks(requester_agent_id, idempotency_key)');
  } catch {
    /* already there */
  }
}

function logEvent(taskId, state, note = null) {
  getDb().prepare('INSERT INTO agent_task_events (task_id, state, note) VALUES (?, ?, ?)')
    .run(taskId, state, note);
}

function touch(taskId, fields = {}) {
  const sets = ['updated_at = CURRENT_TIMESTAMP'];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(taskId);
  getDb().prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function getTask(id) {
  const row = getDb().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id);
  if (!row) return null;
  row.artifacts = row.artifacts ? JSON.parse(row.artifacts) : [];
  row.history = getDb()
    .prepare('SELECT state, note, at FROM agent_task_events WHERE task_id = ? ORDER BY id')
    .all(id);
  return row;
}

export function listDelegates(requesterId) {
  return getDb()
    .prepare(`SELECT a.id, a.name, a.status, a.working_dir, a.config, a.host_id
              FROM agent_delegation d JOIN agents a ON a.id = d.target_agent_id
              WHERE d.requester_agent_id = ?`)
    .all(requesterId)
    .map((r) => ({ ...r, config: typeof r.config === 'string' ? JSON.parse(r.config || '{}') : (r.config || {}) }));
}

export function mayDelegate(requesterId, targetId) {
  return !!getDb()
    .prepare('SELECT 1 FROM agent_delegation WHERE requester_agent_id = ? AND target_agent_id = ?')
    .get(requesterId, targetId);
}

export function allowDelegation(requesterId, targetId) {
  getDb().prepare('INSERT OR IGNORE INTO agent_delegation (requester_agent_id, target_agent_id) VALUES (?, ?)')
    .run(requesterId, targetId);
}

export function revokeDelegation(requesterId, targetId) {
  getDb().prepare('DELETE FROM agent_delegation WHERE requester_agent_id = ? AND target_agent_id = ?')
    .run(requesterId, targetId);
}

function tasksToday(requesterId) {
  return getDb()
    .prepare("SELECT COUNT(*) n FROM agent_tasks WHERE requester_agent_id = ? AND created_at > datetime('now','-1 day')")
    .get(requesterId).n;
}

/**
 * Submit an assignment. Returns { task, reused } -- reused:true means an existing
 * task was returned for this idempotency key and nothing new was created.
 */
export function submitTask({ requesterId, targetId, instructions, workingDir = null, deliverables = null, idempotencyKey = null }) {
  if (!instructions || !String(instructions).trim()) throw errWith('EMPTY', 'instructions are required');
  if (requesterId === targetId) throw errWith('SELF', 'an agent cannot assign work to itself');
  if (!mayDelegate(requesterId, targetId)) {
    throw errWith('NOT_PERMITTED', 'no delegation link from this agent to that one');
  }
  if (idempotencyKey) {
    const existing = getDb()
      .prepare('SELECT id FROM agent_tasks WHERE requester_agent_id = ? AND idempotency_key = ?')
      .get(requesterId, idempotencyKey);
    if (existing) return { task: getTask(existing.id), reused: true };
  }
  const used = tasksToday(requesterId);
  if (used >= DAILY_TASK_CAP) {
    throw errWith('CAP', `daily task cap reached (${used}/${DAILY_TASK_CAP}) — delegation spends model usage, so this is bounded`);
  }

  const id = randomUUID();
  getDb().prepare(`INSERT INTO agent_tasks
      (id, requester_agent_id, target_agent_id, idempotency_key, state, instructions, working_dir, deliverables)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`)
    .run(id, requesterId, targetId, idempotencyKey, String(instructions), workingDir, deliverables);
  logEvent(id, 'queued');
  return { task: getTask(id), reused: false };
}

export function acknowledgeTask(id, byAgentId) {
  const t = getTask(id);
  if (!t) throw errWith('NO_TASK', 'unknown task');
  if (t.target_agent_id !== byAgentId) throw errWith('NOT_YOURS', 'that task is not assigned to you');
  if (t.state === 'acknowledged' || t.state === 'running') return getTask(id);
  if (TERMINAL_STATES.includes(t.state)) throw errWith('FINISHED', `task already ${t.state}`);
  touch(id, { state: 'acknowledged' });
  logEvent(id, 'acknowledged');
  return getTask(id);
}

export function finishTask(id, byAgentId, { state, result = null, blocker = null, artifacts = [] }) {
  const t = getTask(id);
  if (!t) throw errWith('NO_TASK', 'unknown task');
  if (t.target_agent_id !== byAgentId) throw errWith('NOT_YOURS', 'that task is not assigned to you');
  if (TERMINAL_STATES.includes(t.state)) throw errWith('FINISHED', `task already ${t.state}`);
  touch(id, {
    state,
    result,
    blocker,
    artifacts: JSON.stringify(artifacts || []),
    finished_at: new Date().toISOString(),
  });
  logEvent(id, state, result || blocker || null);
  return getTask(id);
}

export function cancelTask(id, byAgentId) {
  const t = getTask(id);
  if (!t) throw errWith('NO_TASK', 'unknown task');
  if (t.requester_agent_id !== byAgentId) throw errWith('NOT_YOURS', 'only the requester can cancel');
  if (TERMINAL_STATES.includes(t.state)) return t;
  touch(id, { state: 'cancelled', finished_at: new Date().toISOString() });
  logEvent(id, 'cancelled');
  return getTask(id);
}

export function inboxFor(agentId) {
  return getDb()
    .prepare(`SELECT * FROM agent_tasks WHERE target_agent_id = ?
              AND state NOT IN ('completed','blocked','failed','cancelled')
              ORDER BY created_at`)
    .all(agentId);
}

export function outboxFor(agentId) {
  return getDb()
    .prepare('SELECT * FROM agent_tasks WHERE requester_agent_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(agentId);
}

/** Tasks waiting to go out, and finished tasks whose requester has not been told. */
export function pendingDeliveries() {
  return getDb().prepare("SELECT * FROM agent_tasks WHERE state = 'queued' ORDER BY created_at").all();
}

export function pendingNotifications() {
  return getDb()
    .prepare(`SELECT * FROM agent_tasks
              WHERE state IN ('completed','blocked','failed') AND notified_at IS NULL
              ORDER BY finished_at`)
    .all();
}

export function markDelivered(id) {
  touch(id, { state: 'delivered', delivered_at: new Date().toISOString() });
  logEvent(id, 'delivered');
}

export function markNotified(id) {
  touch(id, { notified_at: new Date().toISOString() });
}


/**
 * Record why a task is sitting where it is, without changing its state. Deduped on
 * the last note so a condition that persists for an hour does not write 720 rows.
 */
export function noteTask(taskId, note) {
  const db = getDb();
  const last = db.prepare('SELECT note FROM agent_task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId);
  if (last && last.note === note) return;
  db.prepare('INSERT INTO agent_task_events (task_id, state, note) VALUES (?, ?, ?)').run(taskId, 'waiting', note);
}

export const config = { IDLE_TICKS_REQUIRED, DAILY_TASK_CAP };

function errWith(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
