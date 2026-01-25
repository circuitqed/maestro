const bcrypt = require('bcrypt');
const db = require('./db');

const SALT_ROUNDS = 10;
const DEFAULT_PASSWORD = 'maestro'; // Change on first login

// Initialize default password if not set
function initializeAuth() {
  const existingHash = db.getSetting('password_hash');
  if (!existingHash) {
    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, SALT_ROUNDS);
    db.setSetting('password_hash', hash);
    console.log('Initialized default password. Please change it after login.');
  }
}

// Verify password
async function verifyPassword(password) {
  const hash = db.getSetting('password_hash');
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

// Set new password
async function setPassword(newPassword) {
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  db.setSetting('password_hash', hash);
}

// Check if password needs to be changed (still default)
function isDefaultPassword() {
  const hash = db.getSetting('password_hash');
  if (!hash) return true;
  return bcrypt.compareSync(DEFAULT_PASSWORD, hash);
}

// Session-based authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }

  // For API requests, return 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // For page requests, redirect to login
  res.redirect('/login.html');
}

// WebSocket authentication check
function isAuthenticatedWs(req) {
  // Extract session from cookie for WebSocket upgrade
  return req.session && req.session.authenticated;
}

module.exports = {
  initializeAuth,
  verifyPassword,
  setPassword,
  isDefaultPassword,
  requireAuth,
  isAuthenticatedWs
};
