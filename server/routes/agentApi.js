/**
 * The interface agents themselves call, as opposed to the one the browser calls.
 *
 * Who the caller is matters as much as whether it is allowed -- the delegation
 * allowlist is checked against the sender's identity -- so identity comes from the
 * caller's tmux session, never from the body. That middleware is shared with the
 * other routers mounted at /api/agent; see middleware/agentIdentity.js.
 */
import { Router } from 'express';
import { getDb, getAgent, getHost } from '../services/db.js';
import { requireAgentIdentity } from '../middleware/agentIdentity.js';
import { usageForAgent } from '../services/usage.js';
import { planUsage, accountKindFor } from '../services/planUsage.js';
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

// --- Plan usage: the `/usage` equivalent, reachable from outside the TUI ---------
//
// `/usage` is a slash command, so the numbers it draws are only available to a human
// looking at that pane. An agent deciding whether to start a long job, or asking why
// it just got rate-limited, has no way to see them. These two routes are that view:
// `/usage` for the caller's own plan, `/usage/plans` for every plan in the fleet.
//
// Deliberately read-only and deliberately not a budget. Dave's standing position is
// that a number handed to an agent becomes a target it optimises, so this reports
// and never enforces: no caps, no "you have N left, stop", no advice.
router.get('/usage', async (req, res) => {
  const host = req.agent.host_id ? getHost(req.agent.host_id) : null;
  const configDir = (req.agent.config || {}).claudeConfigDir || '';
  // Copied, not used in place: usageForAccount returns the very object it cached,
  // shared by every agent on that account, and the reason is rewritten below.
  const usage = { ...(await usageForAgent(req.agent, host)) };

  // Say WHY there is no window when there is none. The probe answers "no
  // subscription credential" for a gateway account, which reads as a broken login
  // -- but an API or Bedrock account is billed per token and simply has no plan to
  // report. Only on the failure path, so the normal answer costs nothing extra.
  if (!usage.ok) {
    const account = await accountKindFor(host, configDir);
    if (account && account.kind !== 'oauth') {
      usage.reason = `${account.kind} account — billed per token, no plan window`;
      usage.kind = account.kind;
      usage.detail = account.detail || null;
    }
  }

  res.json({
    agent: req.agent.name,
    account: configDir || 'default',
    host: host ? host.name : 'local',
    ...usage,
  });
});

router.get('/usage/plans', async (req, res) => {
  try {
    res.json(await planUsage({ includeAgents: req.query.agents !== '0' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
