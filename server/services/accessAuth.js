/**
 * Google sign-in for Maestro, through Cloudflare Access.
 *
 * maestro.lazybrains.com sits behind an Access app (Google, an allow list), so no
 * request reaches Maestro through the tunnel without a Google login. Access adds a
 * signed JWT (Cf-Access-Jwt-Assertion); this verifies it -- RS256 against the team's
 * published keys, audience = the app's AUD (setting `access_aud`), issuer, expiry --
 * and maps its email to a Maestro user (users.emails, comma separated). The session
 * is then created as if the person had typed their password.
 *
 * Verifying the signature is the whole point: the header alone could be sent by
 * anyone who reaches the port directly (the tailnet), the signature can't.
 *
 * Password login still works for requests that did NOT come through Cloudflare
 * (localhost, the tailnet), so Maestro stays reachable if Cloudflare or Google is
 * down. Through the tunnel it is refused unless setting `password_login_public`=on.
 */
import crypto from 'crypto';
import { getSetting, getDb } from './db.js';

const TEAM = 'https://lazybrains.cloudflareaccess.com';
let keys = { at: 0, byKid: new Map() };

async function signingKeys(force = false) {
  if (!force && Date.now() - keys.at < 3600 * 1000 && keys.byKid.size) return keys.byKid;
  const r = await fetch(`${TEAM}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10000) });
  const d = await r.json();
  const byKid = new Map();
  for (const jwk of d.keys || []) {
    try { byKid.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* skip */ }
  }
  keys = { at: Date.now(), byKid };
  return byKid;
}

function b64json(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** The verified email in an Access JWT, or null. */
export async function verifiedEmail(token) {
  const aud = getSetting('access_aud');
  if (!token || !aud) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch { return null; }
  if (header.alg !== 'RS256') return null;
  let key = (await signingKeys()).get(header.kid);
  if (!key) key = (await signingKeys(true)).get(header.kid); // keys rotate
  if (!key) return null;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== TEAM) return null;
  if (!payload.exp || payload.exp < now - 30) return null;
  if (payload.nbf && payload.nbf > now + 30) return null;
  return typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
}

export function ensureEmailsColumn() {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('emails')) db.exec('ALTER TABLE users ADD COLUMN emails TEXT');
}

export function userByEmail(email) {
  if (!email) return null;
  const rows = getDb().prepare("SELECT * FROM users WHERE emails IS NOT NULL AND emails != ''").all();
  return rows.find((u) => u.emails.split(',').map((e) => e.trim().toLowerCase()).includes(email)) || null;
}

/** Came through Cloudflare (the public URL) rather than localhost / the tailnet. */
export function viaTunnel(req) {
  return !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

/**
 * Express middleware, after the session parser: a request with a valid Access JWT
 * and no session gets the matching user's session. Never throws.
 */
export function accessLogin() {
  return async (req, res, next) => {
    try {
      const token = req.headers['cf-access-jwt-assertion'];
      if (token && req.session) {
        const email = await verifiedEmail(token);
        if (email) {
          const user = userByEmail(email);
          if (user && req.session.user_id !== user.id) {
            req.session.user_id = user.id;
            req.session.via = 'google';
          }
          if (!user) req.accessUnknownEmail = email;
        }
      }
    } catch (err) {
      console.error('access login:', err.message);
    }
    next();
  };
}

export function passwordAllowed(req) {
  return !viaTunnel(req) || getSetting('password_login_public') === 'on';
}
