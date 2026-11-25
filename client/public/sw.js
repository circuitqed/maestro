// Maestro service worker: push notifications only.
//
// Deliberately NO fetch handler and no caching. The dashboard is live state over
// WebSockets; a cached shell would serve a stale bundle after a deploy, which is the
// exact problem index.html's no-cache header exists to prevent.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  // iOS revokes a subscription whose pushes don't show a notification, so every push
  // shows one, even when a Maestro window is open (the tag merges it with the page's).
  event.waitUntil(self.registration.showNotification(data.title || 'Maestro', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/', agentId: data.agentId ?? null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = '/', agentId = null } = event.notification.data || {};
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      if (agentId != null) win.postMessage({ type: 'open-agent', agentId });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
