import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { execOnHostWithInput, shellQuote } from '../services/hosts.js';
import { getHosts, getSetting, getAgents } from '../services/db.js';

/**
 * Speech to text for the chat's mic button: POST raw audio, get {text}.
 *
 * The browser's own recogniser (Web Speech) is refused outright in an iOS Home
 * Screen app ("service-not-allowed") and mangles our vocabulary ("M-SIM", "YAPQ"),
 * so the chat records audio instead and this route transcribes it with whisper.cpp
 * (large-v3-turbo) on the mac mini's GPU: ~1 s hot for a sentence.
 *
 * whisper-server listens on the mini's LOOPBACK only (launchd com.maestro.whisper,
 * 127.0.0.1:8178); the audio rides the existing SSH ControlMaster on stdin, so there is
 * no new port, no token and nothing reachable from the network. Host: setting
 * `stt_host` (a Maestro host name), default mac-mini.
 */
const router = express.Router();
router.use(requireAuth);

const EXT = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };

// Whisper's prompt biases spelling toward words it has "seen": our names are
// otherwise heard as ordinary words.
function vocabulary() {
  const base = ['Maestro', 'em-sim', 'yap', 'zlmc', 'whistler', 'lithium', 'oracle', 'qubit', 'Sherlock', 'tmux', 'Claude', 'Codex'];
  let names = [];
  try { names = getAgents().map((a) => a.name).filter((n) => n && n.length < 30); } catch { /* base only */ }
  const words = [...new Set([...base, ...names])];
  let out = '';
  for (const w of words) { if ((out + w).length > 400) break; out += (out ? ', ' : '') + w; }
  return out;
}

router.post('/', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
  const audio = req.body;
  if (!Buffer.isBuffer(audio) || audio.length < 100) return res.status(400).json({ error: 'no audio' });
  const name = getSetting('stt_host') || 'mac-mini';
  const host = getHosts().find((h) => h.name === name);
  if (!host) return res.status(503).json({ error: `speech host "${name}" is not a Maestro host` });
  const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = EXT[type] || 'bin';
  const cmd = [
    'curl -sS --max-time 90 http://127.0.0.1:8178/inference',
    `-F ${shellQuote(`file=@-;filename=audio.${ext}`)}`,
    '-F response_format=json -F temperature=0.0',
    `-F ${shellQuote(`prompt=${vocabulary()}`)}`,
  ].join(' ');
  const t0 = Date.now();
  try {
    const { stdout } = await execOnHostWithInput(host, cmd, audio, { timeout: 100000 });
    let out;
    try { out = JSON.parse(stdout); } catch { out = null; }
    if (!out || typeof out.text !== 'string') {
      return res.status(502).json({ error: `transcriber answered: ${String((out && out.error) || stdout).slice(0, 200)}` });
    }
    res.json({ text: out.text.replace(/\s+/g, ' ').trim(), ms: Date.now() - t0 }); // segments come joined by newlines
  } catch (err) {
    const why = err.code === 255 ? `${name} is not reachable` : (err.stderr || err.message || 'failed').toString().trim().slice(0, 200);
    res.status(502).json({ error: `Transcription failed: ${why}` });
  }
});

export default router;
