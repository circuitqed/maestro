/**
 * The interface agents themselves call, as opposed to the one the browser calls.
 *
 * Authentication is deliberately two-part, because "which agent is this?" matters
 * as much as "is this allowed?":
 *
 *   - a shared token proves the caller is something Maestro installed, not any
 *     process that happens to reach the port;
 *   - the tmux session name proves WHICH agent is calling, and the server resolves
 *     it against the agents table rather than trusting a name in the body.
 *
 * The session name is read by the CLI from its own $TMUX context, so an agent
 * cannot claim to be a different agent just by passing a flag. That matters: the
 * sender's identity is what the delegation allowlist is checked against.
 */
import { Router } from 'express';
import { getDb, getAgent } from '../services/db.js';
import {
  submitTask, getTask, acknowledgeTask, finishTask, cancelTask,
  inboxFor, outboxFor, listDelegates, config,
} from '../services/tasks.js';

const router = Router();

function tokenOk(req) {
  const expected = getDb().prepare("SELECT value FROM settings WHERE key = 'agent_api_token'").get();
  if (!expected || !expected.value) return false;
  const got = req.get('X-Maestro-Agent-Token') || '';
  // Length-independent compare is overkill for a localhost/tailnet token, but the
  // cost is nil and it avoids a trivially timeable equality.
  if (got.length !== expected.value.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.value.charCodeAt(i);
  return diff === 0;
}

router.use((req, res, next) => {
  if (!tokenOk(req)) return res.status(401).json({ error: 'bad or missing agent token' });
  const session = req.get('X-Maestro-Session');
  if (!session) return res.status(400).json({ error: 'missing X-Maestro-Session' });
  // Session names are unique per HOST, not globally -- `aws-awr` exists on both
  // oracle and garage-wsl today. A .get() silently picked whichever row SQLite
  // returned first, so one agent could be answered as another. Refuse instead.
  const rows = getDb().prepare('SELECT * FROM agents WHERE screen_session = ?').all(session);
  if (rows.length === 0) return res.status(404).json({ error: `no agent registered for session ${session}` });
  if (rows.length > 1) {
    return res.status(409).json({
      error: `session name ${session} exists on ${rows.length} hosts (${rows.map((r) => r.host_id ?? 'local').join(', ')}) — cannot tell which agent is calling`,
      code: 'AMBIGUOUS_SESSION',
    });
  }
  const row = rows[0];
  req.agent = row;
  next();
});

const fail = (res, err) => {
  const map = { NOT_PERMITTED: 403, NOT_YOURS: 403, NO_TASK: 404, CAP: 429, SELF: 400, EMPTY: 400, FINISHED: 409 };
  res.status(map[err.code] || 500).json({ error: err.message, code: err.code || 'ERROR' });
};

router.get('/whoami', (req, res) => {
  res.json({ id: req.agent.id, name: req.agent.name, session: req.agent.screen_session, caps: config });
});

router.get('/agents', (req, res) => {
  res.json(listDelegates(req.agent.id).map((a) => ({
    id: a.id, name: a.name, status: a.status, workingDir: a.working_dir,
    provider: (a.config && a.config.provider) || 'claude',
  })));
});

router.post('/tasks', (req, res) => {
  const { to, instructions, workingDir, deliverables, idempotencyKey } = req.body || {};
  const target = typeof to === 'number'
    ? getAgent(to)
    : getDb().prepare('SELECT * FROM agents WHERE name = ?').get(String(to || ''));
  if (!target) return res.status(404).json({ error: `no agent named ${to}`, code: 'NO_TARGET' });
  try {
    const { task, reused } = submitTask({
      requesterId: req.agent.id, targetId: target.id,
      instructions, workingDir, deliverables, idempotencyKey,
    });
    res.json({ id: task.id, state: task.state, reused, to: target.name });
  } catch (err) { fail(res, err); }
});

router.get('/tasks/:id', (req, res) => {
  const t = getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'unknown task' });
  if (t.requester_agent_id !== req.agent.id && t.target_agent_id !== req.agent.id) {
    return res.status(403).json({ error: 'not your task' });
  }
  res.json(t);
});

router.post('/tasks/:id/ack', (req, res) => {
  try { res.json(acknowledgeTask(req.params.id, req.agent.id)); } catch (err) { fail(res, err); }
});

router.post('/tasks/:id/complete', (req, res) => {
  const { result, artifacts } = req.body || {};
  try {
    res.json(finishTask(req.params.id, req.agent.id, { state: 'completed', result, artifacts }));
  } catch (err) { fail(res, err); }
});

router.post('/tasks/:id/block', (req, res) => {
  const { reason } = req.body || {};
  try {
    res.json(finishTask(req.params.id, req.agent.id, { state: 'blocked', blocker: reason }));
  } catch (err) { fail(res, err); }
});

router.post('/tasks/:id/cancel', (req, res) => {
  try { res.json(cancelTask(req.params.id, req.agent.id)); } catch (err) { fail(res, err); }
});

router.get('/inbox', (req, res) => res.json(inboxFor(req.agent.id)));
router.get('/outbox', (req, res) => res.json(outboxFor(req.agent.id)));

export default router;
