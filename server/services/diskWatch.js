/**
 * Phone push when a host's disk is filling.
 *
 * The Hosts tab has always shown disk, but only to someone looking, and oracle reached
 * 97% (6 GB free) twice before anyone noticed: a full disk there takes down Maestro,
 * the tunnel and every site at once. Every 10 min this reads the same stats the tab
 * shows (hostStats.js) and pushes to admins when a disk crosses 90%, again at 95%,
 * and then at most every 12 h while it stays above. Dropping back under 85% re-arms it.
 *
 * Same disk, two hosts: oracle-allen is oracle under another login, so a disk is keyed
 * by its exact size in bytes and alerted once, under the first host that reports it.
 */
import { getHosts, getSetting } from './db.js';
import { allHostStats } from './hostStats.js';
import { sendToAll } from './push.js';

const EVERY_MS = 10 * 60 * 1000;
const LEVELS = [90, 95];
const REARM_PCT = 85;
const REPEAT_MS = 12 * 60 * 60 * 1000;
const state = new Map(); // `${size}` -> { level, at }

const gb = (n) => `${Math.round(n / 1e9)} GB`;

export async function checkDisks() {
  if (getSetting('disk_watch') === 'off') return [];
  const stats = await allHostStats();
  const hosts = getHosts();
  const seen = new Set();
  const alerts = [];
  for (const h of hosts) {
    const s = stats[h.id];
    if (!s || s.error) continue;
    for (const d of s.disks || []) {
      if (!d.size || seen.has(d.size)) continue;
      seen.add(d.size);
      const pct = 100 * (1 - d.avail / d.size);
      const key = String(d.size);
      const prev = state.get(key) || { level: 0, at: 0 };
      if (pct < REARM_PCT) { state.delete(key); continue; }
      const level = [...LEVELS].reverse().find((l) => pct >= l) || 0;
      if (!level) continue;
      const due = level > prev.level || Date.now() - prev.at >= REPEAT_MS;
      if (!due) continue;
      state.set(key, { level, at: Date.now() });
      alerts.push({ host: h.name, mount: d.mount, pct: Math.round(pct), avail: d.avail });
    }
  }
  for (const a of alerts) {
    await sendToAll({
      title: `${a.host} disk ${a.pct}% full`,
      body: `${gb(a.avail)} free on ${a.mount}. Open Hosts to see it.`,
      tag: `disk-${a.host}`,
      url: '/',
    }, { admins: true }).catch((err) => console.error('diskWatch: push failed', err.message));
    console.log(`diskWatch: ${a.host} ${a.mount} ${a.pct}% (${gb(a.avail)} free)`);
  }
  return alerts;
}

export function startDiskWatch() {
  setTimeout(() => checkDisks().catch(() => {}), 60 * 1000);
  setInterval(() => checkDisks().catch((err) => console.error('diskWatch', err.message)), EVERY_MS);
}
