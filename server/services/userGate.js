/**
 * Non-admin users are DEFAULT-DENY.
 *
 * An audit on 2026-11-26 found 23 routes a plain 'user' could misuse, 7 critical:
 * repoint their own agent's working dir at / and read the DB and session secret, open
 * an account-login pane that leaves a shell on any host, adopt any tmux session,
 * approve agents' spending, drive the Sherlock connection. Patching each route left
 * the next new route open by default, so instead a non-admin session may call only
 * what a person needs to use the agents of projects they belong to (those per-agent
 * routes still check project access themselves), and everything else is 403.
 *
 * Requests with no session (agents using their token, the public view pages) are
 * not affected here: their routes authenticate them their own way.
 */
import { getUserById } from './db.js';

const ALLOW = [
  ['GET', /^\/api\/auth\/session$/],
  ['POST', /^\/api\/auth\/(login|logout|change-password)$/],
  ['GET', /^\/api\/projects$/],
  ['GET', /^\/api\/projects\/colors$/],
  ['GET', /^\/api\/projects\/\d+$/],
  ['GET', /^\/api\/agents$/],
  ['GET', /^\/api\/agents\/\d+\/(usage|pane|transcript|transcript\/meta|file|view)$/],
  ['POST', /^\/api\/agents\/\d+\/(start|stop|input|upload|keys|answer)$/],
  ['POST', /^\/api\/transcribe$/],
  ['*', /^\/api\/push\//],
  ['GET', /^\/api\/view\//],
  ['GET', /^\/api\/hosts$/], // names only, see below
];

// Lists the dashboard loads on every page: answer "nothing" rather than an error, so
// the page works; the data itself is admin-only.
const EMPTY = [
  ['GET', /^\/api\/swarms$/],
  ['GET', /^\/api\/swarms\/authorizations\/pending$/],
];

const match = (list, req) => list.some(([m, re]) => (m === '*' || m === req.method) && re.test(req.path));

export function userGate() {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const uid = req.session && req.session.user_id;
    if (!uid) return next();
    const user = getUserById(uid);
    if (!user || user.role === 'admin') return next();
    if (match(EMPTY, req)) return res.json([]);
    if (!match(ALLOW, req)) return res.status(403).json({ error: 'Not available to your account.' });
    if (req.method === 'GET' && req.path === '/api/hosts') {
      // Host labels for the agent rows; not ssh targets, paths or prefixes.
      const json = res.json.bind(res);
      res.json = (body) => json(Array.isArray(body) ? body.map((h) => ({ id: h.id, name: h.name, status: h.status })) : body);
    }
    next();
  };
}
