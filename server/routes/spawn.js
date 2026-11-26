import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { draft, spawn } from '../services/spawn.js';
import { registerAgent } from '../services/agentMonitor.js';

// The dashboard's idea box (services/spawn.js). Admin only: it creates projects,
// directories and agents on any host, and issues yap identities.
const router = express.Router();
router.use(requireAuth, requireAdmin);

router.post('/draft', async (req, res) => {
  try {
    res.json(await draft(req.body && req.body.idea));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/go', async (req, res) => {
  try {
    const out = await spawn(req.body || {}, { userId: req.user && req.user.id, registerAgent });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
