import { Router } from 'express';
import bcrypt from 'bcrypt';
import {
  getUserByUsername, getUserById, getUserCount, getUsers,
  createUser, updateUser, deleteUser, getAdminCount,
  addProjectContributor, getOrphanedProjectIds,
} from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

// Check current auth status
router.get('/session', (req, res) => {
  const userCount = getUserCount();
  const setupRequired = userCount === 0;

  if (setupRequired) {
    return res.json({ authenticated: false, user: null, setupRequired: true });
  }

  if (req.session && req.session.user_id) {
    const user = getUserById(req.session.user_id);
    if (user) {
      return res.json({
        authenticated: true,
        user: { id: user.id, username: user.username, role: user.role },
        setupRequired: false,
      });
    }
  }

  res.json({ authenticated: false, user: null, setupRequired: false });
});

// First-time admin setup
router.post('/setup', async (req, res) => {
  const userCount = getUserCount();
  if (userCount > 0) {
    return res.status(403).json({ error: 'Setup already completed' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const hash = await bcrypt.hash(password, 10);
  const user = createUser(username, hash, 'admin');

  req.session.user_id = user.id;
  res.json({ success: true, user });
});

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.user_id = user.id;
  res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ success: true });
  });
});

// Change password
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }

  const user = getUserByUsername(req.user.username);
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  updateUser(req.user.id, { password_hash: hash });
  res.json({ success: true });
});

// --- User management (admin only) ---

// List all users
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  res.json(getUsers());
});

// Create user
router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const existing = getUserByUsername(username);
  if (existing) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  const hash = await bcrypt.hash(password, 10);
  const user = createUser(username, hash, role || 'user');
  res.status(201).json(user);
});

// Update user (role or password)
router.patch('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  const target = getUserById(targetId);
  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  const updates = {};

  if (req.body.role) {
    if (target.role === 'admin' && req.body.role !== 'admin' && getAdminCount() <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last admin' });
    }
    updates.role = req.body.role;
  }

  if (req.body.password) {
    updates.password_hash = await bcrypt.hash(req.body.password, 10);
  }

  const updated = updateUser(targetId, updates);
  res.json(updated);
});

// Delete user
router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id);

  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  const target = getUserById(targetId);
  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (target.role === 'admin' && getAdminCount() <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  }

  deleteUser(targetId);

  // Reassign orphaned projects to the admin performing the deletion
  const orphanedIds = getOrphanedProjectIds();
  for (const projectId of orphanedIds) {
    addProjectContributor(projectId, req.user.id, 'owner');
  }

  res.json({ success: true });
});

export default router;
