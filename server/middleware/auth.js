import { getUserById, getUserCount } from '../services/db.js';

export function requireAuth(req, res, next) {
  // If no users exist yet (fresh install), allow access for initial setup
  const userCount = getUserCount();
  if (userCount === 0) {
    return next();
  }

  if (!req.session || !req.session.user_id) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = getUserById(req.session.user_id);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'User not found' });
  }

  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export function optionalAuth(req, res, next) {
  if (req.session && req.session.user_id) {
    req.user = getUserById(req.session.user_id);
  }
  req.isAuthenticated = !!req.user;
  next();
}
