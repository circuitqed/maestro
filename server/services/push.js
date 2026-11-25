/**
 * Web Push: "an agent needs you" on a phone whose screen is off.
 *
 * The notifications WebSocket only reaches an open, foregrounded tab, and iOS
 * suspends a backgrounded one within seconds, so an agent stopped on a prompt sat
 * unnoticed until someone happened to open Maestro. Web Push goes through the
 * browser vendor's push service (Apple's, for an iPhone) to the device itself.
 *
 * - iOS delivers Web Push only to a site added to the Home Screen (16.4+), and only
 *   after the person allowed notifications from a tap inside it.
 * - VAPID keys are generated once and kept in the `push_vapid` setting. The private
 *   key never leaves this process; only the public key is served (it is what the
 *   browser binds the subscription to). Regenerating them orphans every subscription.
 * - Subscriptions live in `push_subscriptions`, one per device, owned by the user who
 *   subscribed. A 404/410 from the push service means the device dropped it: deleted.
 * - Only "needs you" pushes, not "agent finished": that one fires dozens of times an
 *   hour and would train the person to ignore the phone. One per agent per
 *   COOLDOWN_MS, since a widget that flickers would otherwise buzz on each redraw.
 */
import webpush from 'web-push';
import { getDb, getSetting, setSetting, getAgent } from './db.js';

const COOLDOWN_MS = 2 * 60 * 1000;
const lastSent = new Map(); // agentId -> ms
let ready = false;

function subject() {
  // VAPID wants a contact URL; the dashboard's own public address is enough, and
  // keeps any personal address out of every request to the push services.
  return process.env.MAESTRO_PUBLIC_URL || 'https://maestro.lazybrains.com';
}

export function initPush() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_id INTEGER,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_ok_at DATETIME,
      last_error TEXT
    )
  `);
  let keys = null;
  try { keys = JSON.parse(getSetting('push_vapid') || 'null'); } catch { keys = null; }
  if (!keys || !keys.publicKey || !keys.privateKey) {
    keys = webpush.generateVAPIDKeys();
    setSetting('push_vapid', JSON.stringify(keys));
    console.log('push: generated VAPID keys');
  }
  webpush.setVapidDetails(subject(), keys.publicKey, keys.privateKey);
  ready = true;
}

export function publicKey() {
  try { return JSON.parse(getSetting('push_vapid') || 'null')?.publicKey || null; } catch { return null; }
}

export function saveSubscription(sub, userId, userAgent) {
  const { endpoint, keys } = sub || {};
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || !keys || !keys.p256dh || !keys.auth) {
    throw new Error('not a push subscription');
  }
  getDb().prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id, user_agent)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
      user_id = excluded.user_id, user_agent = excluded.user_agent, last_error = NULL
  `).run(endpoint, keys.p256dh, keys.auth, userId ?? null, String(userAgent || '').slice(0, 300));
}

export function removeSubscription(endpoint) {
  return getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes;
}

export function hasSubscription(endpoint) {
  return !!getDb().prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
}

/** Send one payload to every subscription (or only `endpoint`). Returns counts. */
export async function sendToAll(payload, { endpoint } = {}) {
  if (!ready || getSetting('push') === 'off') return { sent: 0, failed: 0, removed: 0, disabled: true };
  const db = getDb();
  const subs = endpoint
    ? db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').all(endpoint)
    : db.prepare('SELECT * FROM push_subscriptions').all();
  const body = JSON.stringify(payload);
  let sent = 0, failed = 0, removed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      // urgency high: iOS otherwise may hold a push for a sleeping phone.
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 3600, urgency: 'high', topic: payload.tag ? String(payload.tag).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) : undefined }
      );
      db.prepare('UPDATE push_subscriptions SET last_ok_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?').run(s.id);
      sent++;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        removed++;
      } else {
        db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?')
          .run(`${code || ''} ${(err && (err.body || err.message)) || err}`.slice(0, 300), s.id);
        failed++;
      }
    }
  }));
  return { sent, failed, removed };
}

/** Monitor hook: an agent started (since) or stopped (null) waiting on a prompt. */
export function onAgentWaiting(event) {
  if (!event || event.type !== 'agent_waiting' || !event.since) return;
  const now = Date.now();
  if (now - (lastSent.get(event.agentId) || 0) < COOLDOWN_MS) return;
  lastSent.set(event.agentId, now);
  let name = event.sessionName;
  try { name = getAgent(event.agentId)?.name || name; } catch { /* keep session name */ }
  sendToAll({
    title: `${name} needs you`,
    body: 'Stopped on a question. Tap to answer.',
    tag: `waiting-${event.agentId}`,
    agentId: event.agentId,
    url: `/?agent=${encodeURIComponent(event.agentId)}`,
  }).catch((err) => console.error('push: send failed', err.message));
}
