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

// List all projects (with git info)
router.get('/', async (req, res) => {
  try {
    const projects = getProjects();

    // Add git info to each project
    const projectsWithGit = await Promise.all(
      projects.map(async (project) => {
        const gitInfo = await getGitInfo(project.path);
        return { ...project, git: gitInfo };
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
    const gitInfo = await getGitInfo(project.path);
    res.json({ ...project, git: gitInfo });
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
    const { name, path, description, color } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const project = createProject(name, path, description, color);
    res.status(201).json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update project
router.patch('/:id', (req, res) => {
  try {
    const { name, path, description, color } = req.body;
    const project = updateProject(req.params.id, { name, path, description, color });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete project
router.delete('/:id', (req, res) => {
  try {
    deleteProject(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
