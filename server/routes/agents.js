import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  getAgents,
  getAgent,
  getProject,
  createAgent,
  updateAgentStatus,
  deleteAgent,
} from '../services/db.js';
import { getTmuxSessions, startAgentSession, killSession, sessionExists } from '../services/tmux.js';
import { registerAgent, unregisterAgent } from '../services/agentMonitor.js';

const router = Router();

// Apply auth middleware to all routes
router.use(requireAuth);

// List all agents
router.get('/', (req, res) => {
  try {
    const agents = getAgents();
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    const result = await startAgentSession(agent.screen_session, workingDir);

    if (result.alreadyRunning) {
      // Session exists, just update status
      updateAgentStatus(req.params.id, 'running');
      registerAgent(agent.id, agent.screen_session);
      return res.json({ success: true, message: 'Session already running', agent: getAgent(req.params.id) });
    }

    // Update agent status to running and register for monitoring
    const updatedAgent = updateAgentStatus(req.params.id, 'running');
    registerAgent(agent.id, agent.screen_session);
    res.json({ success: true, message: 'Agent started', agent: updatedAgent });
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
    deleteAgent(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
