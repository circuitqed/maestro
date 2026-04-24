import { Router } from 'express';
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
  PROJECT_COLORS,
} from '../services/db.js';

const execAsync = promisify(exec);
const router = Router();

// Apply auth middleware to all routes
router.use(requireAuth);

/**
 * Get git info for a project path
 */
async function getGitInfo(projectPath) {
  if (!projectPath) return null;

  try {
    // Check if it's a git repo
    await execAsync(`git -C "${projectPath}" rev-parse --git-dir 2>/dev/null`);

    // Get current branch
    const { stdout: branch } = await execAsync(
      `git -C "${projectPath}" rev-parse --abbrev-ref HEAD 2>/dev/null`
    );

    // Get remote origin URL
    let remoteUrl = null;
    let githubUrl = null;
    try {
      const { stdout: remote } = await execAsync(
        `git -C "${projectPath}" remote get-url origin 2>/dev/null`
      );
      remoteUrl = remote.trim();

      // Parse GitHub URL from remote
      if (remoteUrl) {
        // Handle SSH format: git@github.com:user/repo.git
        const sshMatch = remoteUrl.match(/git@github\.com:(.+?)(?:\.git)?$/);
        if (sshMatch) {
          githubUrl = `https://github.com/${sshMatch[1].replace(/\.git$/, '')}`;
        }
        // Handle HTTPS format: https://github.com/user/repo.git
        const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
        if (httpsMatch) {
          githubUrl = `https://github.com/${httpsMatch[1].replace(/\.git$/, '')}`;
        }
      }
    } catch {
      // No remote configured
    }

    // Check for uncommitted changes
    const { stdout: status } = await execAsync(
      `git -C "${projectPath}" status --porcelain 2>/dev/null`
    );
    const hasChanges = status.trim().length > 0;

    return {
      branch: branch.trim(),
      hasChanges,
      remoteUrl,
      githubUrl,
    };
  } catch {
    return null;
  }
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
        const gitInfo = await getGitInfo(project.path);
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
    const gitInfo = await getGitInfo(project.path);
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

// Create project
router.post('/', (req, res) => {
  try {
    const { name, description, color } = req.body;
    const path = req.body.path || `/home/projects/${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    if (!name) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const userId = req.user ? req.user.id : null;
    const project = createProject(name, path, description, color, userId);
    res.status(201).json(project);
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
