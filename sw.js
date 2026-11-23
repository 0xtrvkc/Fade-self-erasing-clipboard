'use strict';
// Fade service worker: receives the Android share sheet and keeps a network-first copy of the app shell.
// Clip content never passes through here; Firebase traffic is cross-origin and is not intercepted.
const SHELL = 'fade-shell-v1';
const SHARE = 'fade-share';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('fade-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function receiveShare(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARE);
  for (const key of await cache.keys()) await cache.delete(key);
  const files = form.getAll('files').filter(file => file && typeof file === 'object' && file.size > 0);
  await Promise.all(files.map((file, index) => cache.put('shared/file/' + index, new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } }))));
  const meta = {
    title: String(form.get('title') || ''), text: String(form.get('text') || ''), url: String(form.get('url') || ''),
    files: files.map((file, index) => ({ index, name: file.name || 'shared-file', type: file.type || 'application/octet-stream' }))
  };
  await cache.put('shared/meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  // Network first, so a new deploy is picked up immediately; the cached copy only covers offline starts.
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(SHELL).then(cache => cache.put(request, copy)).catch(() => {});
      }
      return response;
    } catch (err) {
      const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (cached) return cached;
      throw err;
    }
  })());
});
