/**
 * The interface agents themselves call, as opposed to the one the browser calls.
 *
 * Who the caller is matters as much as whether it is allowed -- the delegation
 * allowlist is checked against the sender's identity -- so identity comes from the
 * caller's tmux session, never from the body. That middleware is shared with the
 * other routers mounted at /api/agent; see middleware/agentIdentity.js.
 */
import { Router } from 'express';
import { getDb, getAgent } from '../services/db.js';
import { requireAgentIdentity } from '../middleware/agentIdentity.js';
import {
  submitTask, getTask, acknowledgeTask, finishTask, cancelTask,
  inboxFor, outboxFor, listDelegates, config,
} from '../services/tasks.js';

const router = Router();

router.use(requireAgentIdentity);

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
