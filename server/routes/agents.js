import { Router } from 'express';
import fs from 'fs';
import { requireAuth } from '../middleware/auth.js';
import {
  getAgents,
  getAgent,
  getProject,
  createAgent,
  updateAgentStatus,
  deleteAgent,
  getAgentsForUser,
  userHasProjectAccess,
} from '../services/db.js';
import { getTmuxSessions, startProviderSession, createSession, killSession, sessionExists } from '../services/tmux.js';
import { registerAgent, unregisterAgent } from '../services/agentMonitor.js';
import { getProvider, getProviderList } from '../services/providers.js';

const router = Router();

// Apply auth middleware to all routes
router.use(requireAuth);

function checkAgentAccess(req, res, agent) {
  if (!req.user) return true; // fresh install
  if (req.user.role === 'admin') return true;
  if (agent.project_id && userHasProjectAccess(req.user.id, agent.project_id)) return true;
  res.status(403).json({ error: 'Access denied' });
  return false;
}

// List agents (scoped to user's accessible projects)
router.get('/', (req, res) => {
  try {
    let agents;
    if (req.user) {
      if (req.user.role === 'admin') {
        agents = getAgents();
      } else {
        agents = getAgentsForUser(req.user.id);
      }
    } else {
      agents = getAgents(); // fresh install
    }
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List available providers
router.get('/providers', (req, res) => {
  const providers = getProviderList().map(p => ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    envVars: p.envVars,
    defaultFlags: p.defaultFlags,
    monitorable: p.monitorable,
  }));
  res.json(providers);
});

// List available tmux sessions
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await getTmuxSessions();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single agent
router.get('/:id', (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json(agent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create agent
router.post('/', (req, res) => {
  try {
    const { projectId, name, screenSession, status, config } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Agent name is required' });
    }
    if (projectId && req.user && req.user.role !== 'admin' && !userHasProjectAccess(req.user.id, projectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    const agent = createAgent(projectId, name, screenSession, status, config);
    res.status(201).json(agent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update agent status
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!status || !['running', 'stopped', 'idle', 'busy'].includes(status)) {
      return res.status(400).json({ error: 'Valid status required (running, stopped, idle, busy)' });
    }
    const agent = updateAgentStatus(req.params.id, status);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json(agent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start agent (create tmux session with claude)
router.post('/:id/start', async (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!checkAgentAccess(req, res, agent)) return;

    if (!agent.screen_session) {
      return res.status(400).json({ error: 'Agent has no session name configured' });
    }

    // Get project path for working directory
    let workingDir = null;
    if (agent.project_id) {
      const project = getProject(agent.project_id);
      if (project && project.path) {
        workingDir = project.path;
      }
    }

    // tmux silently falls back to $HOME when `-c <dir>` doesn't exist — catch it here instead
    if (workingDir && !fs.existsSync(workingDir)) {
      return res.status(400).json({
        error: `Project path does not exist: ${workingDir}. Update the project settings.`,
      });
    }

    const provider = getProvider(agent.config?.provider);

    let result;
    if (provider.id === 'shell') {
      result = await createSession(agent.screen_session, workingDir);
    } else {
      const command = provider.buildCommand(agent.config || {});
      result = await startProviderSession(agent.screen_session, command, workingDir);
    }

    if (result.alreadyRunning || !result.created) {
      updateAgentStatus(req.params.id, 'running');
      if (provider.monitorable) registerAgent(agent.id, agent.screen_session);
      return res.json({ success: true, message: 'Session already running', agent: getAgent(req.params.id) });
    }

    const updatedAgent = updateAgentStatus(req.params.id, 'running');
    if (provider.monitorable) registerAgent(agent.id, agent.screen_session);
    res.json({ success: true, message: `${provider.name} started`, agent: updatedAgent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop agent (kill tmux session)
router.post('/:id/stop', async (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!checkAgentAccess(req, res, agent)) return;

    if (!agent.screen_session) {
      return res.status(400).json({ error: 'Agent has no session name configured' });
    }

    const result = await killSession(agent.screen_session);

    // Update agent status to stopped and unregister from monitoring
    unregisterAgent(agent.id);
    const updatedAgent = updateAgentStatus(req.params.id, 'stopped');
    res.json({ success: true, message: result.killed ? 'Agent stopped' : 'Session not found', agent: updatedAgent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete agent
router.delete('/:id', (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!checkAgentAccess(req, res, agent)) return;
    deleteAgent(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
