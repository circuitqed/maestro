import { Router } from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
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
import { isRemote, isValidSessionName, execOnHost, shellQuote, sshBaseArgs, remoteWrap, isHostUnreachable, describeHostError } from '../services/hosts.js';
import { sanitizeSessionName, uniqueSessionName } from '../services/sessions.js';
import { appendAgentLane } from '../services/scaffold.js';
import { resolveWorkingDir, ensureDirOnHost } from '../services/projectPaths.js';
import { pinnedTranscriptExists } from '../services/transcript.js';
import { resolveTranscriptFile, readTranscriptTail } from '../services/transcript.js';

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

// Agents name files the way people do — "committed `treatment.md`", "see
// `providers.js`" — and the chat linkifies those bare names. Resolved literally they
// land at <workingDir>/treatment.md and 404 unless the file happens to sit at the
// repo root, so a correct reference reads as a broken link (this is what made a
// quantum-courseware brief unreachable: it lived in content/concepts/quantum-lc/).
// So when the literal path isn't a file, search the working dir for that basename.
// Only an unambiguous single hit is served — several same-named files (index.mdx,
// __init__.py) must not resolve to an arbitrary one. Depth- and count-bounded, with
// the usual heavy dirs pruned, so this stays cheap on a large repo. No new exposure:
// hits are inside the working dir, which is already served in full.
const FIND_MAX_DEPTH = 6;
const FIND_PRUNE_DIRS = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache'];

// POSIX-sh fragment that sets `f` to the unique match, or leaves it empty.
function findByBaseSh(wd, base) {
  const prune = FIND_PRUNE_DIRS.map((d) => `-name ${shellQuote(d)}`).join(' -o ');
  return (
    `hits=$(find ${shellQuote(wd)} -maxdepth ${FIND_MAX_DEPTH} \\( ${prune} \\) -prune -o ` +
    `-type f -name ${shellQuote(base)} -print 2>/dev/null | head -5); ` +
    `if [ "$(printf '%s\\n' "$hits" | grep -c .)" = 1 ]; then ` +
    `f=$(realpath "$hits" 2>/dev/null); else f=""; fi;`
  );
}

// Same search for a local agent: bounded walk, unique hit or null.
async function findByBaseLocal(wd, base) {
  const hits = [];
  const walk = async (dir, depth) => {
    if (depth > FIND_MAX_DEPTH || hits.length > 1) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length > 1) return;
      const full = path.posix.join(dir, e.name);
      if (e.isDirectory()) {
        if (!FIND_PRUNE_DIRS.includes(e.name)) await walk(full, depth + 1);
      } else if (e.name === base && (e.isFile() || e.isSymbolicLink())) {
        hits.push(full);
      }
    }
  };
  await walk(wd, 0);
  return hits.length === 1 ? hits[0] : null;
}

// Report a failure that involved a (possibly remote) host. An unreachable host is
// a 503, not a 500 — it's transient and says nothing about the request. Never
// returns err.message for a remote failure: execFile puts the whole ssh argv in it.
function failHost(res, err, host) {
  if (isRemote(host)) {
    return res.status(isHostUnreachable(err) ? 503 : 500).json({ error: describeHostError(err, host) });
  }
  return res.status(500).json({ error: err.message });
}

// Is `child` the same path as `parent`, or inside it? (posix, already normalized)
const within = (child, parent) => child === parent || child.startsWith(parent + '/');

// Roots outside the project tree that file links may point into, colon-separated.
// Defaults to the host temp dir because that is where agents put scratch artifacts
// they then show in chat. Set MAESTRO_FILE_ROOTS='' to confine strictly to the
// project tree. Note /tmp is shared: any file there becomes readable by a Maestro
// user with access to this agent (symlinks out are still refused — see the route).
const EXTRA_FILE_ROOTS = (process.env.MAESTRO_FILE_ROOTS ?? '/tmp')
  .split(':')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter((s) => s.startsWith('/'));

// Canonical extension-less text files, matched by whole (lowercased) name.
const TEXT_FILENAMES = new Set([
  'dockerfile','makefile','rakefile','gemfile','procfile','jenkinsfile','vagrantfile','brewfile',
  'license','readme','changelog','authors','notice','copying','todo','install','manifest',
]);

// An SVG is a picture AND an executable document — it can carry <script> and
// remote references. It used to be served as text/plain with the other text-likes,
// which was safe but meant an agent's diagram showed up as angle brackets. Serve
// the real type so it renders, and take the teeth out with CSP instead:
// `sandbox` drops it into a unique opaque origin even when opened as a top-level
// document (the pop-out button), so it can't reach Maestro's cookies, storage or
// DOM; `default-src 'none'` blocks scripts and any outbound fetch. The viewer also
// renders it via <img>, where browsers don't run SVG script at all — belt and braces.
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

// Conservative content type: images/pdf inline; text-likes (incl. html) as
// text/plain so nothing executes in our origin; everything else is a download.
function fileServeType(name) {
  const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
  if (IMAGE_TYPES[ext]) return { type: IMAGE_TYPES[ext], inline: true };
  if (ext === 'svg') return { type: 'image/svg+xml', inline: true, csp: SVG_CSP };
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

async function hostIsDir(host, p) {
  try {
    if (isRemote(host)) {
      const { stdout } = await execOnHost(host, `test -d ${shellQuote(p)} && echo y`);
      return String(stdout).trim() === 'y';
    }
    return fs.statSync(p).isDirectory();
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
    const explicitSession = !!(screenSession && screenSession.trim());
    const sessionBase = explicitSession ? screenSession.trim() : sanitizeSessionName(name);
    if (!sessionBase) {
      return res.status(400).json({ error: 'Could not derive a session name from the agent name; set one explicitly.' });
    }
    // A derived name must also dodge sessions that exist on the host but aren't
    // Maestro's — otherwise the new agent adopts a stranger's session (see
    // startProviderSession). An explicit name is an intentional attach, so it is
    // only de-duped against other agents. Best-effort: an unreachable host just
    // falls back to the DB-only check rather than blocking agent creation.
    let hostSessions = [];
    if (!explicitSession) {
      try {
        hostSessions = (await getTmuxSessions(host)).map((s) => s.name);
      } catch {
        hostSessions = [];
      }
    }
    const session = uniqueSessionName(host ? host.id : null, sessionBase, hostSessions);
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
          return res.status(503).json({ error: describeHostError(err, host) });
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
        return res.status(isHostUnreachable(err) ? 503 : 500).json({ error: describeHostError(err, host) });
      }
      throw err;
    }

    // A non-monitorable provider (shell) has no pane parsing behind it, so nothing
    // would ever move it off 'running' — it would sit in the dashboard's Active
    // section forever. A bare shell is up-but-not-working, which is what 'idle'
    // means; 'running' is reserved for providers we can actually observe working.
    const startedStatus = provider.monitorable ? 'running' : 'idle';

    if (result.alreadyRunning || !result.created) {
      updateAgentStatus(req.params.id, startedStatus);
      if (provider.monitorable) registerAgent(agent.id, agent.screen_session, host);
      return res.json({ success: true, message: 'Session already running', agent: getAgent(req.params.id) });
    }

    if (result.adopted) {
      updateAgentStatus(req.params.id, startedStatus);
      if (provider.monitorable) registerAgent(agent.id, agent.screen_session, host);
      return res.json({
        success: true,
        message: `${provider.name} started in the existing session`,
        agent: getAgent(req.params.id),
      });
    }

    updateAgentStatus(req.params.id, startedStatus);
    if (provider.monitorable) registerAgent(agent.id, agent.screen_session, host);

    // Codex is NOT pinned here: it creates its rollout file on the first user message,
    // not at launch, so there is nothing to capture yet. resolveTranscriptFile reads it
    // off the running process instead and refreshes the pin then.

    res.json({ success: true, message: `${provider.name} started`, agent: getAgent(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop agent (kill tmux session)
router.post('/:id/stop', async (req, res) => {
  let errHost = null; // captured for the catch: `agent`/`host` are try-scoped
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

    errHost = host;
    const result = await killSession(agent.screen_session, host);

    // Update agent status to stopped and unregister from monitoring
    unregisterAgent(agent.id);
    const updatedAgent = updateAgentStatus(req.params.id, 'stopped');
    res.json({ success: true, message: result.killed ? 'Agent stopped' : 'Session not found', agent: updatedAgent });
  } catch (err) {
    failHost(res, err, errHost);
  }
});

// Inject text into the agent's tmux session (used by the chat view send box)
router.post('/:id/input', async (req, res) => {
  let errHost = null; // captured for the catch: `agent`/`host` are try-scoped
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
    errHost = host;

    await sendText(agent.screen_session, text, host);
    updateAgentUserActivity(agent.id); // track most-recent user input for sorting
    res.json({ success: true });
  } catch (err) {
    failHost(res, err, errHost);
  }
});

// Chat file attachments are stored under this dir inside the agent's own working dir
// (which is per-project, so uploads never leak across projects) so the agent can read
// them by path; the chat then references the returned relative path.
const UPLOAD_SUBDIR = 'uploads';
// Generous by default (attachments can be zips/datasets); override with MAESTRO_MAX_UPLOAD_MB.
const MAX_UPLOAD_MB = Number(process.env.MAESTRO_MAX_UPLOAD_MB) || 2048;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// Sanitize a client filename to a safe basename: no path separators/traversal, a tight
// charset, no leading dot (avoid hidden/".." names). Preserves the extension.
function safeUploadName(name) {
  let n = path.posix.basename(String(name || '').replace(/\\/g, '/')).trim();
  n = n.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!n) n = 'file';
  return n.slice(0, 120);
}

// Upload one file into the agent's working dir (<wd>/uploads/<name>) so a chat
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
      return done(413, { error: `File exceeds the ${MAX_UPLOAD_MB} MB upload limit` });
    }

    const wd = workingDir.replace(/\/+$/, '');
    const dir = `${wd}/${UPLOAD_SUBDIR}`;
    // Only self-manage a .gitignore when WE first create the uploads dir, so a project
    // that already keeps a tracked uploads/ of its own is never clobbered.
    const dirPreexisted = await hostIsDir(host, dir);
    await ensureDirOnHost(host, dir);
    if (!dirPreexisted) {
      // Keep chat attachments out of the user's git history (agents run `git add .`).
      try {
        await execOnHost(host, `printf '*\\n' > ${shellQuote(`${dir}/.gitignore`)}`);
      } catch {
        /* non-fatal */
      }
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
        if (aborted) return done(413, { error: `File exceeds the ${MAX_UPLOAD_MB} MB upload limit` });
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
        if (aborted) { try { fs.unlinkSync(absPath); } catch { /* ignore */ } return done(413, { error: `File exceeds the ${MAX_UPLOAD_MB} MB upload limit` }); }
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
  let errHost = null; // captured for the catch: `agent`/`host` are try-scoped
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

    errHost = host;
    await sendAnswer(agent.screen_session, choice, host);
    updateAgentUserActivity(agent.id);
    res.json({ success: true });
  } catch (err) {
    failHost(res, err, errHost);
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
    // Re-read: resolving a Codex agent can refresh the pin (it is discovered from the
    // running session, not at start), so `agent` may hold a stale id by now.
    res.json({ available: !!filePath, sessionId: getAgent(agent.id)?.claude_session_id || null });
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
    // …and agents stage scratch artifacts in the host temp dir — a preview render, an
    // exported plot — then link them in chat. Those 403'd even though the file is
    // exactly what the agent just told the user to look at. Symlink escapes are still
    // blocked: confinement is re-checked against the RESOLVED path below, so a link in
    // /tmp pointing at /etc/shadow resolves outside every root and is refused.
    const roots = [root, ...EXTRA_FILE_ROOTS.filter((r) => !within(r, root))];
    const candidate = rawPath.startsWith('/')
      ? path.posix.normalize(rawPath)
      : path.posix.normalize(path.posix.join(wd, rawPath));

    if (!roots.some((r) => within(candidate, r))) {
      return res.status(403).json({ error: 'Path is outside the allowed directory' });
    }

    const base = path.posix.basename(candidate);
    const { type, inline, csp } = fileServeType(base);
    const forceDownload = req.query.download === '1' || req.query.download === 'true';
    const setHeaders = () => {
      res.setHeader('Content-Type', type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (csp) res.setHeader('Content-Security-Policy', csp);
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
        `f=$(realpath ${shellQuote(candidate)} 2>/dev/null); ` +
        `if [ -z "$f" ] || [ ! -f "$f" ]; then ${findByBaseSh(wd, base)} fi; ` +
        `[ -n "$f" ] || exit 3; ` +
        `ok=0; for r in ${roots.map(shellQuote).join(' ')}; do ` +
        `rr=$(realpath "$r" 2>/dev/null) || continue; ` +
        `case "$f" in "$rr"/*) ok=1; break;; esac; done; ` +
        `[ "$ok" = 1 ] || exit 4; ` +
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
      let realTarget = await hostRealpath(host, candidate);
      if (!realTarget || !(await hostIsFile(host, realTarget))) {
        const found = await findByBaseLocal(wd, base); // bare-name fallback, see findByBaseSh
        realTarget = found ? await hostRealpath(host, found) : null;
      }
      if (!realTarget) return res.status(404).json({ error: 'File not found' });
      const realRoots = (await Promise.all(roots.map((r) => hostRealpath(host, r)))).filter(Boolean);
      if (!realRoots.some((r) => within(realTarget, r))) {
        return res.status(403).json({ error: 'Path is outside the allowed directory' });
      }
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
