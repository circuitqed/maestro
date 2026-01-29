import { getSetting } from '../services/db.js';

export function requireAuth(req, res, next) {
  // Check if password is configured
  const passwordHash = getSetting('password_hash');

  // If no password is set, allow access (first-time setup)
  if (!passwordHash) {
    return next();
  }

  // Check if user is authenticated
  if (req.session && req.session.authenticated) {
    return next();
  }

  return res.status(401).json({ error: 'Authentication required' });
}

export function optionalAuth(req, res, next) {
  // Always allow, just attach auth status
  req.isAuthenticated = !!(req.session && req.session.authenticated);
  next();
}
