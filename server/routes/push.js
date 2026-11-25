import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { publicKey, saveSubscription, removeSubscription, hasSubscription, sendToAll } from '../services/push.js';

// Browser-facing Web Push registration (see services/push.js). Session-authed.
const router = express.Router();
router.use(requireAuth);

router.get('/key', (req, res) => {
  const key = publicKey();
  if (!key) return res.status(503).json({ error: 'push not initialised' });
  res.json({ publicKey: key });
});

// Whether this device's subscription is still known here (the browser can keep one
// that the server dropped, e.g. after a 410).
router.post('/status', (req, res) => {
  res.json({ subscribed: !!(req.body && req.body.endpoint && hasSubscription(req.body.endpoint)) });
});

router.post('/subscribe', (req, res) => {
  try {
    saveSubscription(req.body && req.body.subscription, req.user && req.user.id, req.get('user-agent'));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/unsubscribe', (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  res.json({ removed: removeSubscription(endpoint) });
});

// Sends only to the calling device, so testing one phone never buzzes the others.
router.post('/test', async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  const r = await sendToAll({
    title: 'Maestro',
    body: 'Notifications work. An agent stopped on a question will show up like this.',
    tag: 'test',
    url: '/',
  }, { endpoint });
  res.json(r);
});

export default router;
