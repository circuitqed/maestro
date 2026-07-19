import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
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
import { isRemote, isValidSessionName, execOnHost, shellQuote, sshBaseArgs, remoteWrap } from '../services/hosts.js';
import { sanitizeSessionName, uniqueSessionName } from '../services/sessions.js';
import { appendAgentLane } from '../services/scaffold.js';
import { resolveWorkingDir, ensureDirOnHost } from '../services/projectPaths.js';
import { pinnedTranscriptExists } from '../services/transcript.js';
import { resolveTranscriptFile, readTranscriptTail, listCodexRolloutIdsForCwd, captureCodexRolloutId } from '../services/transcript.js';

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

// --- File serving (clickable file links in the chat) -----------------------
const TEXT_FILE_EXTS = new Set([
  'txt','md','markdown','rst','csv','tsv','log','json','jsonl','ndjson','yaml','yml','toml','ini','cfg','conf','env',
  'xml','html','htm','svg','css','scss','less','py','js','jsx','ts','tsx','mjs','cjs','c','cc','cpp','h','hpp',
  'sh','bash','zsh','fish','rb','go','rs','java','kt','swift','php','pl','r','m','mm','sql','lua','dart','scala',
  'clj','ex','exs','erl','hs','ml','vue','svelte','tex','bib','make','mk','dockerfile','gitignore','diff','patch',
  'v','sv','vhd','tcl','awk','sed','asm','s','f','f90','proto','gradle','properties','bat','ps1','nix','zig','cs',
]);
const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

// Canonical extension-less text files, matched by whole (lowercased) name.
const TEXT_FILENAMES = new Set([
  'dockerfile','makefile','rakefile','gemfile','procfile','jenkinsfile','vagrantfile','brewfile',
  'license','readme','changelog','authors','notice','copying','todo','install','manifest',
]);

// Conservative content type: images/pdf inline; text-likes (incl. html/svg) as
// text/plain so nothing executes in our origin; everything else is a download.
function fileServeType(name) {
  const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
  if (IMAGE_TYPES[ext]) return { type: IMAGE_TYPES[ext], inline: true };
  if (ext === 'pdf') return { type: 'application/pdf', inline: true };
  if (TEXT_FILE_EXTS.has(ext) || (!name.includes('.') && TEXT_FILENAMES.has(name.toLowerCase()))) {
    return { type: 'text/plain; charset=utf-8', inline: true };
  }
  return { type: 'application/octet-stream', inline: false };
}

// realpath on the agent's host (resolves symlinks + normalizes; fails if missing).
async function hostRealpath(host, p) {
  try {
    if (isRemote(host)) {
      const { stdout } = await execOnHost(host, `realpath ${shellQuote(p)}`);
      return String(stdout).trim() || null;
    }
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

async function hostIsFile(host, p) {
  try {
    if (isRemote(host)) {
      const { stdout } = await execOnHost(host, `test -f ${shellQuote(p)} && echo y`);
      return String(stdout).trim() === 'y';
    }
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
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
    if (!name || !name.trim()) {
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

    // Derive a VALID, UNIQUE session name. An explicit screenSession is honored as
    // the base; otherwise we slugify the agent name. uniqueSessionName auto-suffixes
    // (-2, -3, ...) so a second agent that would collide can't silently attach to
    // (hijack) an existing agent's tmux session.
    const sessionBase = (screenSession && screenSession.trim()) || sanitizeSessionName(name);
    if (!sessionBase) {
      return res.status(400).json({ error: 'Could not derive a session name from the agent name; set one explicitly.' });
    }
    const session = uniqueSessionName(host ? host.id : null, sessionBase);
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

    const agent = createAgent(projectId, name, session, status, config, host ? host.id : null);

    // Record this agent's ownership lane in the project's canonical AGENTS.md
    // (local project path). Best-effort — never blocks agent creation.
    if (projectId) {
      const project = getProject(projectId);
      if (project && project.path) {
        appendAgentLane(project.path, name.trim(), (config && config.provider) || 'claude');
      }
    }

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

    // Codex has no --session-id to pin ahead of time, so snapshot the rollout ids for
    // this cwd BEFORE launching; after start we diff to find the one this launch made.
    // Best-effort — never blocks or fails the start.
    let codexBeforeIds = [];
    if (provider.id === 'codex' && workingDir) {
      try {
        codexBeforeIds = await listCodexRolloutIdsForCwd(host, workingDir);
      } catch {
        codexBeforeIds = [];
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

    updateAgentStatus(req.params.id, 'running');
    if (provider.monitorable) registerAgent(agent.id, agent.screen_session, host);

    // Pin the freshly created Codex rollout so this agent's chat resolves to ITS OWN
    // transcript rather than the newest one in a shared working dir. Bounded poll,
    // best-effort: on timeout the resolver falls back to the newest-cwd match.
    if (provider.id === 'codex' && workingDir) {
      try {
        const rolloutId = await captureCodexRolloutId(host, workingDir, codexBeforeIds);
        if (rolloutId) setAgentClaudeSessionId(agent.id, rolloutId);
      } catch {
        /* leave unpinned */
      }
    }

    res.json({ success: true, message: `${provider.name} started`, agent: getAgent(req.params.id) });
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

// Chat file attachments are stored under this dir (relative to the working dir) so the
// agent can read them by path; the chat then references the returned relative path.
const UPLOAD_SUBDIR = '.maestro/uploads';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Sanitize a client filename to a safe basename: no path separators/traversal, a tight
// charset, no leading dot (avoid hidden/".." names). Preserves the extension.
function safeUploadName(name) {
  let n = path.posix.basename(String(name || '').replace(/\\/g, '/')).trim();
  n = n.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!n) n = 'file';
  return n.slice(0, 120);
}

// Upload one file into the agent's working dir (<wd>/.maestro/uploads/<name>) so a chat
// message can reference it for the agent to read. The body is the raw file bytes
// (express.json skips non-JSON content types); streamed to disk locally or piped over
// SSH (`cat >`) remotely — never fully buffered. Returns the working-dir-relative path.
router.post('/:id/upload', async (req, res) => {
  let responded = false;
  const done = (code, body) => { if (!responded) { responded = true; res.status(code).json(body); } };
  try {
    const agent = getAgent(req.params.id);
    if (!agent) return done(404, { error: 'Agent not found' });
    if (!checkAgentAccess(req, res, agent)) return;

    const host = agent.host_id ? getHost(agent.host_id) : null;
    if (agent.host_id && !host) return done(400, { error: 'Unknown host' });

    const project = agent.project_id ? getProject(agent.project_id) : null;
    const workingDir = project ? resolveWorkingDir(project, host) : null;
    if (!workingDir) return done(400, { error: 'No working directory for this agent' });

    const name = safeUploadName(req.query.name);
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD_BYTES) {
      return done(413, { error: 'File exceeds the 50 MB upload limit' });
    }

    const wd = workingDir.replace(/\/+$/, '');
    const dir = `${wd}/${UPLOAD_SUBDIR}`;
    await ensureDirOnHost(host, dir);
    // Keep uploads out of the user's git history (agents run `git add .`): drop a
    // self-contained .maestro/.gitignore ignoring everything under it. Best-effort.
    try {
      const gitignore = `${wd}/.maestro/.gitignore`;
      if (!(await hostIsFile(host, gitignore))) {
        await execOnHost(host, `printf '*\\n' > ${shellQuote(gitignore)}`);
      }
    } catch {
      /* non-fatal */
    }

    // Don't clobber an existing upload with the same name.
    let finalName = name;
    if (await hostIsFile(host, `${dir}/${finalName}`)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      finalName = `${stem}-${randomUUID().slice(0, 8)}${ext}`;
    }
    const relPath = `${UPLOAD_SUBDIR}/${finalName}`;
    const absPath = `${dir}/${finalName}`;

    // Enforce the cap even when Content-Length is absent/lying.
    let received = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (!aborted && received > MAX_UPLOAD_BYTES) { aborted = true; req.destroy(); }
    });

    if (isRemote(host)) {
      const child = spawn(
        'ssh',
        [...sshBaseArgs(host), host.ssh_target, remoteWrap(host, `cat > ${shellQuote(absPath)}`)],
        { stdio: ['pipe', 'ignore', 'pipe'] }
      );
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => done(502, { error: `Upload failed: ${e.message}` }));
      child.on('close', (code) => {
        if (aborted) return done(413, { error: 'File exceeds the 50 MB upload limit' });
        if (code === 0) return done(200, { name: finalName, path: relPath, absPath });
        return done(502, { error: `Upload failed (ssh ${code}): ${stderr.trim()}` });
      });
      child.stdin.on('error', () => { /* EPIPE if ssh dies first */ });
      req.on('error', () => { try { child.kill('SIGTERM'); } catch { /* gone */ } });
      req.pipe(child.stdin);
    } else {
      const ws = fs.createWriteStream(absPath);
      ws.on('error', (e) => done(500, { error: `Upload failed: ${e.message}` }));
      ws.on('close', () => {
        if (aborted) { try { fs.unlinkSync(absPath); } catch { /* ignore */ } return done(413, { error: 'File exceeds the 50 MB upload limit' }); }
        return done(200, { name: finalName, path: relPath, absPath });
      });
      req.on('error', () => ws.destroy());
      req.pipe(ws);
    }
  } catch (err) {
    done(500, { error: err.message });
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

// Load earlier transcript history on demand: returns the last `tail` lines parsed
// to records, plus atStart (true once the whole file fits in `tail`). The chat
// requests a growing tail and prepends the newly-revealed older records.
router.get('/:id/transcript', async (req, res) => {
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

    const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 500, 1), 20000);
    const { records, atStart } = await readTranscriptTail(agent, host, tail);
    res.json({ records, atStart });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve a file from an agent's working directory so file links in the chat are
// clickable. Path-confined to the working dir, symlink-safe via realpath, and
// served with a conservative content type (text as text/plain + nosniff; images/
// pdf inline; everything else as a download) so agent-authored files can't execute
// in the app's origin.
router.get('/:id/file', async (req, res) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!checkAgentAccess(req, res, agent)) return;

    const host = agent.host_id ? getHost(agent.host_id) : null;
    if (agent.host_id && !host) return res.status(400).json({ error: 'Unknown host' });

    const project = agent.project_id ? getProject(agent.project_id) : null;
    const workingDir = project ? resolveWorkingDir(project, host) : null;
    if (!workingDir) return res.status(400).json({ error: 'No working directory for this agent' });

    const rawPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!rawPath) return res.status(400).json({ error: 'path is required' });
    if (rawPath.includes('\0')) return res.status(400).json({ error: 'Invalid path' });

    // Relative paths resolve against the working dir (hosts are unix; posix semantics).
    // Absolute paths (and the resolved realpath) are confined to `root`. Remote agents
    // routinely `cd` into sibling project dirs under the host's default_root — e.g. an
    // agent whose Claude cwd is .../qubit-designer that writes files in .../awr-qubit-sim
    // — so widen the confinement root to default_root when it's an ancestor of the
    // working dir; otherwise a correct absolute link into a sibling dir is wrongly 403'd.
    const wd = workingDir.replace(/\/+$/, '');
    let root = wd;
    if (isRemote(host) && host.default_root) {
      const dr = host.default_root.replace(/\/+$/, '');
      if (dr && (wd === dr || wd.startsWith(dr + '/'))) root = dr;
    }
    const candidate = rawPath.startsWith('/')
      ? path.posix.normalize(rawPath)
      : path.posix.normalize(path.posix.join(wd, rawPath));

    const within = (child, parent) => child === parent || child.startsWith(parent + '/');
    if (!within(candidate, root)) {
      return res.status(403).json({ error: 'Path is outside the allowed directory' });
    }

    const base = path.posix.basename(candidate);
    const { type, inline } = fileServeType(base);
    const forceDownload = req.query.download === '1' || req.query.download === 'true';
    const setHeaders = () => {
      res.setHeader('Content-Type', type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `${inline && !forceDownload ? 'inline' : 'attachment'}; filename="${base.replace(/[\r\n"\\]/g, '_')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
    };
    const failNow = (code) => {
      if (!res.headersSent) res.status(code).end();
      else res.end();
    };

    if (isRemote(host)) {
      // One SSH round-trip does resolve + confine + is-file + cat atomically: this
      // closes the cross-round-trip TOCTOU window and turns a failed read into an
      // HTTP error (exit code) instead of a silent empty/truncated 200. Path-based
      // confinement still can't detect hardlinks — bounded by the agent's own trust
      // boundary (it can already read any same-fs file it has access to).
      setHeaders();
      const script =
        `root=$(realpath ${shellQuote(root)} 2>/dev/null) || exit 2; ` +
        `f=$(realpath ${shellQuote(candidate)} 2>/dev/null) || exit 3; ` +
        `case "$f" in "$root"/*) ;; *) exit 4;; esac; ` +
        `[ -f "$f" ] || exit 5; ` +
        `exec cat -- "$f"`;
      const child = spawn('ssh', [...sshBaseArgs(host), host.ssh_target, remoteWrap(host, script)], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.on('error', () => failNow(502));
      child.stdout.on('error', () => failNow(502));
      child.stdout.pipe(res, { end: false }); // we end() ourselves in 'close' based on exit code
      child.on('close', (code) => {
        if (res.headersSent) return res.end();     // bytes streamed -> just finish
        if (code === 0) return res.end();           // empty file, success (200)
        failNow(code === 4 ? 403 : 404);            // 4=outside dir; 2/3/5/other=not found/unreadable
      });
      req.on('close', () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } });
    } else {
      // Local: re-confine after resolving symlinks. (The realpath->open window is a
      // sub-ms in-process race; same hardlink caveat as above.)
      const realRoot = await hostRealpath(host, root);
      const realTarget = await hostRealpath(host, candidate);
      if (!realTarget) return res.status(404).json({ error: 'File not found' });
      if (!realRoot || !within(realTarget, realRoot)) return res.status(403).json({ error: 'Path is outside the allowed directory' });
      if (!(await hostIsFile(host, realTarget))) return res.status(404).json({ error: 'Not a file' });
      setHeaders();
      const stream = fs.createReadStream(realTarget);
      stream.on('error', () => failNow(500));
      req.on('close', () => stream.destroy());
      stream.pipe(res);
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
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
