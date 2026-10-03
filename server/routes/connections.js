/**
 * Interactive SSH logins (Sherlock) driven from the chat.
 * See services/sshConnect.js for why this exists at all.
 */
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  listConnections, getConnection, connectionStatus, beginConnect,
  connectionPane, connectionInput, connectionKeys, disconnect,
} from '../services/sshConnect.js';

const router = express.Router();

// Everything here can start an ssh login or read its pane — never unauthenticated.
router.use(requireAuth);

const find = (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) { res.status(404).json({ error: 'Unknown connection' }); return null; }
  return conn;
};

router.get('/', (req, res) => res.json(listConnections()));

router.get('/:id/status', async (req, res) => {
  const conn = find(req, res); if (!conn) return;
  try { res.json({ id: conn.id, label: conn.label, hint: conn.hint, ...(await connectionStatus(conn)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/connect', async (req, res) => {
  const conn = find(req, res); if (!conn) return;
  try { res.json({ success: true, ...(await beginConnect(conn)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/pane', async (req, res) => {
  const conn = find(req, res); if (!conn) return;
  try { res.json({ text: (await connectionPane(conn)) ?? null }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// The password comes through here. It is pasted into the pane and never logged,
// stored, or written to any transcript — same path as a chat message, and ssh does
// not echo it, so it does not appear in the pane either.
router.post('/:id/input', async (req, res) => {
  const conn = find(req, res); if (!conn) return;
  const text = req.body?.text;
  if (typeof text !== 'string' || !text) return res.status(400).json({ error: 'text is required' });
  try { res.json({ success: true, ...(await connectionInput(conn, text)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/keys', async (req, res) => {
  const conn = find(req, res); if (!conn) return;
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ error: 'keys must be a non-empty array' });
  try { res.json({ success: true, ...(await connectionKeys(conn, keys)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/disconnect', async (req, res) => {
  const conn = find(req, res); if (!conn) return;
  try { res.json(await disconnect(conn)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
