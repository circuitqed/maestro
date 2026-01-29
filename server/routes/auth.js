import { Router } from 'express';
import bcrypt from 'bcrypt';
import { getSetting, setSetting } from '../services/db.js';

const router = Router();

// Check current auth status
router.get('/session', (req, res) => {
  const passwordHash = getSetting('password_hash');
  const isPasswordSet = !!passwordHash;
  const isAuthenticated = !!(req.session && req.session.authenticated);

  res.json({
    authenticated: isAuthenticated || !isPasswordSet,
    passwordRequired: isPasswordSet,
  });
});

// Login
router.post('/login', async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  const passwordHash = getSetting('password_hash');

  // If no password set, this is initial setup
  if (!passwordHash) {
    const hash = await bcrypt.hash(password, 10);
    setSetting('password_hash', hash);
    req.session.authenticated = true;
    return res.json({ success: true, message: 'Password set successfully' });
  }

  // Verify password
  const valid = await bcrypt.compare(password, passwordHash);

  if (!valid) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  req.session.authenticated = true;
  res.json({ success: true });
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
router.post('/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!newPassword) {
    return res.status(400).json({ error: 'New password required' });
  }

  const passwordHash = getSetting('password_hash');

  // If password exists, verify current password
  if (passwordHash) {
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password required' });
    }

    const valid = await bcrypt.compare(currentPassword, passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }

  const hash = await bcrypt.hash(newPassword, 10);
  setSetting('password_hash', hash);

  res.json({ success: true, message: 'Password changed successfully' });
});

export default router;
