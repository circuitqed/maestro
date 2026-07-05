import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getHosts, getHost, createHost, deleteHost, countAgentsOnHost } from '../services/db.js';
import { testHost } from '../services/hosts.js';

const router = Router();

// Apply auth middleware to all routes
router.use(requireAuth);

const NAME_RE = /^[\w .-]{1,64}$/;
const SSH_TARGET_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

// List hosts
router.get('/', (req, res) => {
  try {
    res.json(getHosts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a remote host (admin only)
router.post('/', requireAdmin, (req, res) => {
  try {
    const { name, sshTarget, pathPrefix } = req.body;
    if (!name || !NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Valid host name required (1-64 chars: letters, numbers, spaces, . _ -)' });
    }
    if (!sshTarget || !SSH_TARGET_RE.test(sshTarget)) {
      return res.status(400).json({ error: 'Valid SSH target required (user@hostname)' });
    }
    const host = createHost(name, sshTarget, pathPrefix || null);
    res.status(201).json(host);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'A host with that name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Delete a host (admin only; not the local host, not one with agents)
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const host = getHost(req.params.id);
    if (!host) {
      return res.status(404).json({ error: 'Host not found' });
    }
    if (!host.ssh_target) {
      return res.status(400).json({ error: 'Cannot delete the local host' });
    }
    const agentCount = countAgentsOnHost(host.id);
    if (agentCount > 0) {
      return res.status(400).json({ error: `Host has ${agentCount} agent(s); reassign or delete them first` });
    }
    deleteHost(host.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test connectivity (runs `tmux -V` on the host, persists status)
router.post('/:id/test', async (req, res) => {
  try {
    const host = getHost(req.params.id);
    if (!host) {
      return res.status(404).json({ error: 'Host not found' });
    }
    const result = await testHost(host);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
