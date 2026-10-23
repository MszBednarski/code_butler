self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// Network only: a newly merged commit must be visible after a refresh.
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
