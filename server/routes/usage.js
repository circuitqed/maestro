/**
 * Plan usage for the browser: every account in the fleet and what is drawing on it.
 *
 * The per-agent view already exists at /api/agents/:id/usage and renders as the
 * badge on an agent row. This is the other half -- the question you ask when work
 * has stalled and you want to know which plan ran out, not which agent stopped.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { planUsage } from '../services/planUsage.js';
import { PRICING_VERIFIED_ON, PRICING_SOURCES, pricedModels } from '../services/pricing.js';

const router = Router();
router.use(requireAuth);

router.get('/plans', async (req, res) => {
  try {
    res.json(await planUsage({ includeAgents: req.query.agents !== '0' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// What this build believes things cost, so a surprising dollar figure can be traced
// to its table rather than argued about.
router.get('/pricing', (_req, res) => {
  res.json({ verifiedOn: PRICING_VERIFIED_ON, sources: PRICING_SOURCES, models: pricedModels() });
});

export default router;
