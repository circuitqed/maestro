/**
 * Identity for the agent-facing API (/api/agent), shared by every router mounted
 * there.
 *
 * Authentication is deliberately two-part, because "which agent is this?" matters
 * as much as "is this allowed?":
 *
 *   - a shared token proves the caller is something Maestro installed, not any
 *     process that happens to reach the port;
 *   - the tmux session name proves WHICH agent is calling, and the server resolves
 *     it against the agents table rather than trusting a name in the body.
 *
 * The session name is read by the CLI from its own $TMUX context, so an agent
 * cannot claim to be a different agent just by passing a flag. That is load-bearing
 * twice over: the task allowlist and the swarm grant are both checked against the
 * sender's identity, and a spoofable identity would make both decorative.
 *
 * It lives here rather than in one router because swarms and tasks must agree about
 * who the caller is; two copies of this would be two places to get it wrong.
 */
import { getDb } from '../services/db.js';

export function agentTokenOk(req) {
  const expected = getDb().prepare("SELECT value FROM settings WHERE key = 'agent_api_token'").get();
  if (!expected || !expected.value) return false;
  const got = req.get('X-Maestro-Agent-Token') || '';
  // Length-independent compare is overkill for a localhost/tailnet token, but the
  // cost is nil and it avoids a trivially timeable equality.
  if (got.length !== expected.value.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.value.charCodeAt(i);
  return diff === 0;
}

/** Sets req.agent, or answers the request itself. */
export function requireAgentIdentity(req, res, next) {
  if (!agentTokenOk(req)) return res.status(401).json({ error: 'bad or missing agent token' });
  const session = req.get('X-Maestro-Session');
  if (!session) return res.status(400).json({ error: 'missing X-Maestro-Session' });
  // Session names are unique per HOST, not globally -- `aws-awr` exists on both
  // oracle and garage-wsl today. A .get() silently picked whichever row SQLite
  // returned first, so one agent could be answered as another. Refuse instead.
  const rows = getDb().prepare('SELECT * FROM agents WHERE screen_session = ?').all(session);
  if (rows.length === 0) return res.status(404).json({ error: `no agent registered for session ${session}` });
  if (rows.length > 1) {
    return res.status(409).json({
      error: `session name ${session} exists on ${rows.length} hosts (${rows.map((r) => r.host_id ?? 'local').join(', ')}) — cannot tell which agent is calling`,
      code: 'AMBIGUOUS_SESSION',
    });
  }
  req.agent = rows[0];
  next();
}
