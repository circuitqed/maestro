import { Router } from 'express';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import {
  getAgents,
  getAgent,
  getProject,
  getHost,
  createAgent,
  updateAgent,
  updateAgentStatus,
  updateAgentUserActivity,
  setAgentClaudeSessionId,
  setProjectHostPath,
  deleteAgent,
  getAgentsForUser,
  userHasProjectAccess,
} from '../services/db.js';
import { getTmuxSessions, startProviderSession, createSession, killSession, sessionExists, sendText, sendAnswer, capturePane } from '../services/tmux.js';
import { registerAgent, unregisterAgent } from '../services/agentMonitor.js';
import { getProvider, getProviderList } from '../services/providers.js';
import { isRemote, isValidSessionName, execOnHost, shellQuote } from '../services/hosts.js';
import { resolveWorkingDir, ensureDirOnHost } from '../services/projectPaths.js';
import { pinnedTranscriptExists } from '../services/transcript.js';
import { resolveTranscriptFile } from '../services/transcript.js';

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

// Working directories get spliced into shell commands (mkdir/tmux -c); require
// a non-empty absolute path so we never fall back to $HOME or expand a tilde.
function isValidProjectPath(p) {
  return typeof p === 'string' && p.trim().length > 0 && p.trim().startsWith('/');
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

// List available tmux sessions (optionally on a specific host)
router.get('/sessions', async (req, res) => {
  try {
    let host = null;
    if (req.query.hostId !== undefined && req.query.hostId !== '') {
      host = getHost(req.query.hostId);
      if (!host) {
        return res.status(400).json({ error: 'Unknown host' });
      }
    }
    const sessions = await getTmuxSessions(host);
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
router.post('/', async (req, res) => {
  try {
    const { projectId, name, screenSession, status, config, hostId, workingDir } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Agent name is required' });
    }
    if (screenSession && !isValidSessionName(screenSession)) {
      return res.status(400).json({ error: 'Invalid session name (allowed: letters, numbers, . _ -)' });
    }
    let host = null;
    if (hostId !== undefined && hostId !== null) {
      host = getHost(hostId);
      if (!host) {
        return res.status(400).json({ error: 'Unknown host' });
      }
    }
    if (projectId && req.user && req.user.role !== 'admin' && !userHasProjectAccess(req.user.id, projectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }

    // Optionally pin a per-host working directory for a remote agent so it is
    // immediately startable. Validate + create the dir on that host first; only
    // persist the mapping (and the agent) once the host accepts it.
    if (projectId && host && isRemote(host) && typeof workingDir === 'string' && workingDir.trim()) {
      const dir = workingDir.trim();
      if (!isValidProjectPath(dir)) {
        return res.status(400).json({ error: 'Working directory must be an absolute path' });
      }
      try {
        await ensureDirOnHost(host, dir);
      } catch (err) {
        const detail = (err.stderr || err.message || '').toString().trim().split('\n')[0];
        return res.status(400).json({
          error: `Could not create working directory ${dir} on host ${host.name}: ${detail || 'command failed'}`,
        });
      }
      setProjectHostPath(projectId, host.id, dir);
    }

    const agent = createAgent(projectId, name, screenSession, status, config, host ? host.id : null);
    res.status(201).json(agent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update agent (name only, for now)
router.patch('/:id', (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!checkAgentAccess(req, res, agent)) return;

    const { name } = req.body;
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Valid name required' });
    }

    const updated = updateAgent(req.params.id, { name });
    res.json(updated);
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

    if (!isValidSessionName(agent.screen_session)) {
      return res.status(400).json({ error: 'Invalid session name (allowed: letters, numbers, . _ -)' });
    }

    // Resolve the agent's host (null => local)
    const host = agent.host_id ? getHost(agent.host_id) : null;
    if (agent.host_id && !host) {
      return res.status(400).json({ error: 'Agent references an unknown host' });
    }

    // Resolve the working directory for this agent's (project, host):
    // local host => project.path; remote host => the per-host configured path.
    let workingDir = null;
    if (agent.project_id) {
      const project = getProject(agent.project_id);
      if (project) {
        workingDir = resolveWorkingDir(project, host);
        if (workingDir === null && isRemote(host)) {
          return res.status(400).json({
            error: `No working directory is set for project "${project.name}" on host ${host.name}. Set a working directory for this host in the project settings before starting the agent.`,
          });
        }
      }
    }

    // tmux silently falls back to $HOME when `-c <dir>` doesn't exist — catch it here instead
    if (workingDir) {
      if (isRemote(host)) {
        try {
          await execOnHost(host, `test -d ${shellQuote(workingDir)}`);
        } catch (err) {
          // `test -d` exits 1 when the dir is missing; anything else is an ssh failure
          if (err.code === 1) {
            return res.status(400).json({
              error: `Project path does not exist: ${workingDir}. Update the project settings.`,
            });
          }
          return res.status(503).json({ error: `Cannot reach host ${host.name}: ${err.message}` });
        }
      } else if (!fs.existsSync(workingDir)) {
        return res.status(400).json({
          error: `Project path does not exist: ${workingDir}. Update the project settings.`,
        });
      }
    }

    const provider = getProvider(agent.config?.provider);

    // For the claude provider, pin a transcript session id so the chat view can
    // locate the exact JSONL file (and so a restart resumes the same transcript).
    // This must NEVER cause a start to fail — on any error we simply skip pinning
    // and rely on the newest-mtime transcript locator fallback.
    let claudeSessionId = null;
    let claudeResume = false;
    if (provider.id === 'claude') {
      try {
        if (agent.claude_session_id) {
          claudeSessionId = agent.claude_session_id;
          // Claude rejects --session-id when the transcript already exists and
          // rejects --resume when it doesn't, so choose by the file's presence:
          // resume a real prior conversation, otherwise (re)create the session.
          claudeResume = await pinnedTranscriptExists(host, claudeSessionId);
        } else {
          claudeSessionId = randomUUID();
          setAgentClaudeSessionId(agent.id, claudeSessionId);
        }
      } catch (err) {
        claudeSessionId = null; // fall back to the locator
        claudeResume = false;
      }
    }

    let result;
    try {
      if (provider.id === 'shell') {
        result = await createSession(agent.screen_session, workingDir, null, host);
      } else {
        const command = provider.buildCommand(
          { ...(agent.config || {}), claudeSessionId, claudeResume },
          agent.name,
          host
        );
        result = await startProviderSession(agent.screen_session, command, workingDir, host);
      }
    } catch (err) {
      if (isRemote(host)) {
        return res.status(503).json({ error: `Failed to start on host ${host.name}: ${err.message}` });
      }
      throw err;
    }

    if (result.alreadyRunning || !result.created) {
      updateAgentStatus(req.params.id, 'running');
      if (provider.monitorable) registerAgent(agent.id, agent.screen_session, host);
      return res.json({ success: true, message: 'Session already running', agent: getAgent(req.params.id) });
    }

    const updatedAgent = updateAgentStatus(req.params.id, 'running');
    if (provider.monitorable) registerAgent(agent.id, agent.screen_session, host);
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

    if (!isValidSessionName(agent.screen_session)) {
      return res.status(400).json({ error: 'Invalid session name (allowed: letters, numbers, . _ -)' });
    }

    const host = agent.host_id ? getHost(agent.host_id) : null;
    if (agent.host_id && !host) {
      return res.status(400).json({ error: 'Agent references an unknown host' });
    }

    const result = await killSession(agent.screen_session, host);

    // Update agent status to stopped and unregister from monitoring
    unregisterAgent(agent.id);
    const updatedAgent = updateAgentStatus(req.params.id, 'stopped');
    res.json({ success: true, message: result.killed ? 'Agent stopped' : 'Session not found', agent: updatedAgent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inject text into the agent's tmux session (used by the chat view send box)
router.post('/:id/input', async (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!checkAgentAccess(req, res, agent)) return;

    const { text } = req.body;
    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required' });
    }

    if (!agent.screen_session || !isValidSessionName(agent.screen_session)) {
      return res.status(400).json({ error: 'Agent has no valid session' });
    }

    const host = agent.host_id ? getHost(agent.host_id) : null;
    if (agent.host_id && !host) {
      return res.status(400).json({ error: 'Agent references an unknown host' });
    }

    await sendText(agent.screen_session, text, host);
    updateAgentUserActivity(agent.id); // track most-recent user input for sorting
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current pane content (to detect an active interactive prompt / question)
router.get('/:id/pane', async (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!checkAgentAccess(req, res, agent)) return;
    if (!agent.screen_session || !isValidSessionName(agent.screen_session)) {
      return res.json({ text: '' });
    }
    const host = agent.host_id ? getHost(agent.host_id) : null;
    if (agent.host_id && !host) return res.status(400).json({ error: 'Unknown host' });
    let text = '';
    try {
      text = await capturePane(agent.screen_session, host);
    } catch {
      text = ''; // session gone / unreachable — treat as no prompt
    }
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Answer an active question (e.g. AskUserQuestion) by pressing an option number
router.post('/:id/answer', async (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!checkAgentAccess(req, res, agent)) return;

    const choice = parseInt(req.body?.choice, 10);
    if (!Number.isInteger(choice) || choice < 1 || choice > 9) {
      return res.status(400).json({ error: 'choice must be an integer 1-9' });
    }
    if (!agent.screen_session || !isValidSessionName(agent.screen_session)) {
      return res.status(400).json({ error: 'Agent has no valid session' });
    }
    const host = agent.host_id ? getHost(agent.host_id) : null;
    if (agent.host_id && !host) return res.status(400).json({ error: 'Agent references an unknown host' });

    await sendAnswer(agent.screen_session, choice, host);
    updateAgentUserActivity(agent.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transcript availability metadata for the chat view
router.get('/:id/transcript/meta', async (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!checkAgentAccess(req, res, agent)) return;

    const host = agent.host_id ? getHost(agent.host_id) : null;
    if (agent.host_id && !host) {
      return res.status(400).json({ error: 'Agent references an unknown host' });
    }

    const filePath = await resolveTranscriptFile(agent, host);
    res.json({ available: !!filePath, sessionId: agent.claude_session_id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete agent
router.delete('/:id', async (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!checkAgentAccess(req, res, agent)) return;

    // Kill the agent's tmux session before dropping the row, so deleting an
    // agent never orphans a live session on its host (which then lingers as a
    // stray, mis-attributed session). Best-effort: an unreachable host or a
    // since-gone session must not block deletion of the DB row.
    if (agent.screen_session && isValidSessionName(agent.screen_session)) {
      const host = agent.host_id ? getHost(agent.host_id) : null;
      if (!(agent.host_id && !host)) {
        try {
          await killSession(agent.screen_session, host);
        } catch {
          // host unreachable / tmux gone — proceed with row deletion anyway
        }
      }
    }
    unregisterAgent(agent.id);
    deleteAgent(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
