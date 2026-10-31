/**
 * Signing an extra Anthropic account in on a host, from the UI.
 * See services/accountLogin.js for why this is a guided flow and not one request.
 */
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getHost } from '../services/db.js';
import { listAccounts } from '../services/accounts.js';
import {
  beginAccountLogin, accountLoginPane, accountLoginInput, accountLoginKeys,
  accountLoginStatus, cancelAccountLogin, finishAccountLogin, isValidAccountName,
} from '../services/accountLogin.js';

const router = express.Router();

// Starting a login, reading its pane, or typing into it are all privileged.
router.use(requireAuth);

/**
 * Resolve the target host. `hostId` absent, empty or 1 => the local host, matching
 * the convention in routes/connections.js and the rest of Maestro.
 */
function resolveHost(req, res) {
  const raw = req.query.hostId ?? req.body?.hostId;
  if (raw === undefined || raw === null || raw === '' || String(raw) === '1') return { host: null };
  const host = getHost(parseInt(raw, 10));
  if (!host) {
    res.status(400).json({ error: 'Unknown host' });
    return null;
  }
  return { host: host.ssh_target ? host : null };
}

/** Pull and validate the account name shared by every endpoint below. */
function resolveName(req, res) {
  const name = String(req.query.name ?? req.body?.name ?? '').trim();
  if (!isValidAccountName(name)) {
    res.status(400).json({ error: 'Account name must be lowercase letters, numbers, . _ or - (max 31)' });
    return null;
  }
  return name;
}

/** Accounts already on the host, so the UI can refuse a name that is taken. */
router.get('/', async (req, res) => {
  const h = resolveHost(req, res);
  if (!h) return;
  try {
    res.json(await listAccounts(h.host));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const h = resolveHost(req, res);
  if (!h) return;
  const name = resolveName(req, res);
  if (!name) return;
  try {
    // Refuse to reuse a name that already holds a signed-in account: starting a
    // login there would overwrite a working credential, which is the exact failure
    // this whole feature exists to prevent — just one level in.
    const existing = (await listAccounts(h.host)).find((a) => a.dir.endsWith(`/.claude-accts/${name}`));
    if (existing && existing.loggedIn) {
      return res.status(409).json({
        error: `"${name}" is already signed in${existing.email ? ` as ${existing.email}` : ''}. ` +
               `Pick another name, or remove that account first.`,
      });
    }
    res.json({ success: true, ...(await beginAccountLogin(h.host, name)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/login/pane', async (req, res) => {
  const h = resolveHost(req, res);
  if (!h) return;
  const name = resolveName(req, res);
  if (!name) return;
  try {
    res.json({ text: (await accountLoginPane(h.host, name)) ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/login/status', async (req, res) => {
  const h = resolveHost(req, res);
  if (!h) return;
  const name = resolveName(req, res);
  if (!name) return;
  try {
    res.json(await accountLoginStatus(h.host, name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The OAuth code arrives here. Pasted into the pane exactly like a chat message and
// never logged, stored, or written to a transcript.
router.post('/login/input', async (req, res) => {
  const h = resolveHost(req, res);
  if (!h) return;
  const name = resolveName(req, res);
  if (!name) return;
  const text = req.body?.text;
  if (typeof text !== 'string' || !text) return res.status(400).json({ error: 'text is required' });
  try {
    res.json({ success: true, ...(await accountLoginInput(h.host, name, text)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login/keys', async (req, res) => {
  const h = resolveHost(req, res);
  if (!h) return;
  const name = resolveName(req, res);
  if (!name) return;
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ error: 'keys must be a non-empty array' });
  try {
    res.json({ success: true, ...(await accountLoginKeys(h.host, name, keys)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login/finish', async (req, res) => {
  const h = resolveHost(req, res);
  if (!h) return;
  const name = resolveName(req, res);
  if (!name) return;
  try {
    res.json(await finishAccountLogin(h.host, name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login/cancel', async (req, res) => {
  const h = resolveHost(req, res);
  if (!h) return;
  const name = resolveName(req, res);
  if (!name) return;
  try {
    res.json(await cancelAccountLogin(h.host, name, { discard: !!req.body?.discard }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
