/**
 * Interactive SSH logins (Sherlock) driven from the chat.
 * See services/sshConnect.js for why this exists at all.
 */
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getHost } from '../services/db.js';
import {
  listConnections, getConnection, connectionStatus, beginConnect,
  connectionPane, connectionInput, connectionKeys, disconnect,
} from '../services/sshConnect.js';

const router = express.Router();

// Everything here can start an ssh login or read its pane — never unauthenticated.
router.use(requireAuth);

// Which connection, and on which host. The master socket is per-host, so every
// endpoint takes ?host=<id> (absent => oracle/local, matching the rest of Maestro).
const find = (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) { res.status(404).json({ error: 'Unknown connection' }); return null; }
  const raw = req.query.host ?? req.body?.hostId;
  if (raw === undefined || raw === null || raw === '' || String(raw) === '1') return { conn, host: null };
  const host = getHost(parseInt(raw, 10));
  if (!host) { res.status(400).json({ error: 'Unknown host' }); return null; }
  return { conn, host: host.ssh_target ? host : null };
};

router.get('/', (req, res) => res.json(listConnections()));

router.get('/:id/status', async (req, res) => {
  const f = find(req, res); if (!f) return;
  try {
    res.json({
      id: f.conn.id, label: f.conn.label, hint: f.conn.hint,
      host: f.host ? f.host.name : 'oracle',
      ...(await connectionStatus(f.conn, f.host)),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/connect', async (req, res) => {
  const f = find(req, res); if (!f) return;
  try { res.json({ success: true, ...(await beginConnect(f.conn, f.host)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/pane', async (req, res) => {
  const f = find(req, res); if (!f) return;
  try { res.json({ text: (await connectionPane(f.conn, f.host)) ?? null }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// The password comes through here. It is pasted into the pane and never logged,
// stored, or written to any transcript — same path as a chat message, and ssh does
// not echo it, so it does not appear in the pane either.
router.post('/:id/input', async (req, res) => {
  const f = find(req, res); if (!f) return;
  const text = req.body?.text;
  if (typeof text !== 'string' || !text) return res.status(400).json({ error: 'text is required' });
  try { res.json({ success: true, ...(await connectionInput(f.conn, text, f.host)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/keys', async (req, res) => {
  const f = find(req, res); if (!f) return;
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ error: 'keys must be a non-empty array' });
  try { res.json({ success: true, ...(await connectionKeys(f.conn, keys, f.host)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/disconnect', async (req, res) => {
  const f = find(req, res); if (!f) return;
  try { res.json(await disconnect(f.conn, f.host)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
