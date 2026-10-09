/**
 * The shared secret the agent CLI presents. Generated once and kept in settings, so
 * it survives restarts; written to a file only by the installer, never logged.
 */
import { randomBytes } from 'crypto';
import { getDb } from './db.js';

export function ensureAgentApiToken() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'agent_api_token'").get();
  if (row && row.value) return row.value;
  const token = randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('agent_api_token', ?)").run(token);
  console.log('[tasks] generated agent API token (install it on hosts with scripts/install-agent-cli.sh)');
  return token;
}

export function getAgentApiToken() {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'agent_api_token'").get();
  return row ? row.value : null;
}
