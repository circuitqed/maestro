import { Router } from 'express';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { requireAuth } from '../middleware/auth.js';
import {
  getProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  getAgentsByProject,
  getProjectsForUser,
  getProjectContributors,
  addProjectContributor,
  removeProjectContributor,
  userHasProjectAccess,
  isProjectOwner,
  getUserById,
  getUsers,
  getHosts,
  getHost,
  getProjectHostPaths,
  setProjectHostPath,
  deleteProjectHostPath,
  createAgent,
  PROJECT_COLORS,
} from '../services/db.js';
import { isRemote, execOnHost, shellQuote } from '../services/hosts.js';
import { ensureDirOnHost } from '../services/projectPaths.js';
import { scaffoldProject, appendAgentLane } from '../services/scaffold.js';
import { sanitizeSessionName, uniqueSessionName } from '../services/sessions.js';

const execAsync = promisify(exec);
const router = Router();

// Working directories get spliced into shell commands (mkdir/tmux -c); require
// a non-empty absolute path so we never fall back to $HOME or expand a tilde.
function isValidProjectPath(p) {
  return typeof p === 'string' && p.trim().length > 0 && p.trim().startsWith('/');
}

// Build the per-host paths view for a project: one entry for every host row.
// Local host => projects.path; remote host => project_host_paths path or null.
function buildProjectPaths(project) {
  const hosts = getHosts();
  const rows = getProjectHostPaths(project.id);
  const byHost = new Map(rows.map((r) => [r.host_id, r.path]));
  return hosts.map((h) => {
    const local = !isRemote(h);
    return {
      hostId: h.id,
      hostName: h.name,
      sshTarget: h.ssh_target || null,
      isLocal: local,
      path: local ? (project.path || null) : (byHost.get(h.id) || null),
    };
  });
}

// Apply auth middleware to all routes
router.use(requireAuth);

function parseGithubUrl(remoteUrl) {
  if (!remoteUrl) return null;
  const ssh = remoteUrl.match(/git@github\.com:(.+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1].replace(/\.git$/, '')}`;
  const https = remoteUrl.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (https) return `https://github.com/${https[1].replace(/\.git$/, '')}`;
  return null;
}

/**
 * Probe git at a single (host, path) in ONE round-trip: branch, origin, dirty.
 * host null => local (container fs); remote => over SSH. Returns null when the
 * path isn't a git repo or the host is unreachable.
 */
async function gitProbe(host, projectPath) {
  if (!projectPath) return null;
  const script =
    `cd ${shellQuote(projectPath)} 2>/dev/null && ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ` +
    `printf 'BRANCH=%s\\nORIGIN=%s\\nDIRTY=%s\\n' ` +
    `"$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" ` +
    `"$(git remote get-url origin 2>/dev/null)" ` +
    `"$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')" ` +
    `|| echo NOTREPO`;
  let stdout;
  try {
    ({ stdout } = isRemote(host) ? await execOnHost(host, script) : await execAsync(script));
  } catch {
    return null;
  }
  if (!stdout || stdout.includes('NOTREPO')) return null;
  const get = (k) => {
    const m = stdout.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const branch = get('BRANCH');
  if (!branch) return null;
  const remoteUrl = get('ORIGIN') || null;
  return {
    branch,
    hasChanges: parseInt(get('DIRTY'), 10) > 0,
    remoteUrl,
    githubUrl: parseGithubUrl(remoteUrl),
  };
}

/**
 * Host-aware git info for a project. Tries the local project path first (fast),
 * then falls back to the project's per-host paths — so a project whose repo lives
 * on the mac mini or garage-wsl still reports its branch/GitHub link/dirty state.
 */
async function getGitInfo(project) {
  if (!project) return null;
  const local = await gitProbe(null, project.path);
  if (local) return local;
  try {
    for (const hp of getProjectHostPaths(project.id)) {
      const host = getHost(hp.host_id);
      if (host) {
        const info = await gitProbe(host, hp.path);
        if (info) return info;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// List projects (scoped to user's contributions, admins see all)
router.get('/', async (req, res) => {
  try {
    let projects;
    if (req.user) {
      if (req.user.role === 'admin') {
        projects = getProjects();
      } else {
        projects = getProjectsForUser(req.user.id);
      }
    } else {
      projects = getProjects(); // fresh install, no users yet
    }

    const projectsWithGit = await Promise.all(
      projects.map(async (project) => {
        const gitInfo = await getGitInfo(project);
        const contributors = getProjectContributors(project.id);
        return { ...project, git: gitInfo, contributors };
      })
    );

    res.json(projectsWithGit);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get project colors
router.get('/colors', (req, res) => {
  res.json(PROJECT_COLORS);
});

// Get single project
router.get('/:id', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (req.user && req.user.role !== 'admin' && !userHasProjectAccess(req.user.id, project.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const gitInfo = await getGitInfo(project);
    const contributors = getProjectContributors(project.id);
    res.json({ ...project, git: gitInfo, contributors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get project agents
router.get('/:id/agents', (req, res) => {
  try {
    const agents = getAgentsByProject(req.params.id);
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create project. Beyond the DB row we (best-effort) scaffold the directory with
// the Maestro conventions — git init + AGENTS.md (canonical) + CLAUDE.md pointer +
// docs/ + .gitignore — and seed a default Claude agent so it's ready to run.
router.post('/', async (req, res) => {
  try {
    const { name, description, color, scaffold = true, seedAgent = true } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const projectName = name.trim();
    const path =
      req.body.path && req.body.path.trim()
        ? req.body.path.trim()
        : `/home/projects/${projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    if (!isValidProjectPath(path)) {
      return res.status(400).json({ error: 'Project path must be a non-empty absolute path' });
    }
    try {
      fs.mkdirSync(path, { recursive: true });
    } catch (mkErr) {
      return res.status(400).json({
        error: `Could not create project directory ${path}: ${mkErr.message}`,
      });
    }
    const userId = req.user ? req.user.id : null;
    const project = createProject(projectName, path, description, color, userId);

    // Scaffold the directory. Best-effort: a scaffold hiccup must not fail creation.
    let scaffoldResult = null;
    if (scaffold) {
      try {
        scaffoldResult = await scaffoldProject(null, path, { name: projectName, description });
      } catch (e) {
        scaffoldResult = { error: e.message };
      }
    }

    // Seed a default Claude agent (stopped) so the project appears ready to start.
    let seededAgent = null;
    if (seedAgent) {
      try {
        const session = uniqueSessionName(null, sanitizeSessionName(projectName) || 'agent');
        seededAgent = createAgent(project.id, projectName, session, 'stopped', { provider: 'claude' }, null);
        appendAgentLane(path, projectName, 'claude');
      } catch {
        /* best-effort */
      }
    }

    res.status(201).json({ ...project, scaffold: scaffoldResult, seededAgent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update project (owner or admin only)
router.patch('/:id', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    if (req.user && req.user.role !== 'admin' && !isProjectOwner(req.user.id, projectId)) {
      return res.status(403).json({ error: 'Only the project owner or an admin can edit this project' });
    }
    const { name, path, description, color } = req.body;
    const project = updateProject(projectId, { name, path, description, color });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete project (owner or admin only)
router.delete('/:id', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    if (req.user && req.user.role !== 'admin' && !isProjectOwner(req.user.id, projectId)) {
      return res.status(403).json({ error: 'Only the project owner or an admin can delete this project' });
    }
    deleteProject(projectId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add contributor to project (owner or admin only)
router.post('/:id/contributors', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    if (req.user && req.user.role !== 'admin' && !isProjectOwner(req.user.id, projectId)) {
      return res.status(403).json({ error: 'Only the project owner or an admin can manage contributors' });
    }

    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const targetUser = getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    addProjectContributor(projectId, userId, 'contributor');
    const contributors = getProjectContributors(projectId);
    res.json({ success: true, contributors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove contributor from project (owner or admin only)
router.delete('/:id/contributors/:userId', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    if (req.user && req.user.role !== 'admin' && !isProjectOwner(req.user.id, projectId)) {
      return res.status(403).json({ error: 'Only the project owner or an admin can manage contributors' });
    }

    const targetUserId = parseInt(req.params.userId);
    const contributors = getProjectContributors(projectId);
    const owners = contributors.filter(c => c.project_role === 'owner');
    const isOwnerTarget = owners.some(o => o.id === targetUserId);
    if (isOwnerTarget && owners.length <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last project owner' });
    }

    removeProjectContributor(projectId, targetUserId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List per-host working directories for a project (one entry per host)
router.get('/:id/paths', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const project = getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (req.user && req.user.role !== 'admin' && !userHasProjectAccess(req.user.id, projectId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(buildProjectPaths(project));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set the working directory for a project on a specific host (owner or admin only)
router.put('/:id/paths/:hostId', async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    if (req.user && req.user.role !== 'admin' && !isProjectOwner(req.user.id, projectId)) {
      return res.status(403).json({ error: 'Only the project owner or an admin can edit this project' });
    }
    const project = getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const host = getHost(parseInt(req.params.hostId));
    if (!host) {
      return res.status(400).json({ error: 'Unknown host' });
    }

    const { path: newPath, create } = req.body;
    if (!isValidProjectPath(newPath)) {
      return res.status(400).json({ error: 'Path must be a non-empty absolute path' });
    }
    const dir = newPath.trim();

    if (create) {
      try {
        await ensureDirOnHost(host, dir);
      } catch (err) {
        const detail = (err.stderr || err.message || '').toString().trim().split('\n')[0];
        return res.status(400).json({
          error: `Could not create directory ${dir} on host ${host.name}: ${detail || 'command failed'}`,
        });
      }
    }

    if (isRemote(host)) {
      setProjectHostPath(projectId, host.id, dir);
    } else {
      // Local host path lives on projects.path
      updateProject(projectId, { path: dir });
    }

    const refreshed = getProject(projectId);
    res.json(buildProjectPaths(refreshed));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a project's per-host working directory (owner or admin only)
router.delete('/:id/paths/:hostId', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    if (req.user && req.user.role !== 'admin' && !isProjectOwner(req.user.id, projectId)) {
      return res.status(403).json({ error: 'Only the project owner or an admin can edit this project' });
    }
    const host = getHost(parseInt(req.params.hostId));
    if (!host) {
      return res.status(400).json({ error: 'Unknown host' });
    }
    if (!isRemote(host)) {
      return res.status(400).json({ error: 'The local host path is managed via the project path and cannot be removed here' });
    }
    deleteProjectHostPath(projectId, host.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all users (for contributor picker)
router.get('/:id/available-users', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    if (req.user && req.user.role !== 'admin' && !isProjectOwner(req.user.id, projectId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const allUsers = getUsers();
    const contributors = getProjectContributors(projectId);
    const contributorIds = new Set(contributors.map(c => c.id));
    const available = allUsers.filter(u => !contributorIds.has(u.id));
    res.json(available);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
