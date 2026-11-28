'use strict';

/*
 * Offline shell for krishi-voice.
 *
 * Only the shell (index.html) and kb.json are cached. Both are network-first,
 * so a new deploy is picked up as soon as the phone is online and the cache is
 * used only when the network fails; that keeps the app from going stale.
 * Requests are limited to this origin, so the optional LLM proxy is never
 * intercepted or cached.
 *
 * Bump CACHE_VERSION on every release to retire the previous cache.
 */

const CACHE_VERSION = 'krishi-voice-v5';
const SHELL = ['./', './index.html', './kb.json'];
const OPTIONAL_ASSETS = [
  './src/assets/images/hero_chilli_field_1795851503543.jpg',
  './src/assets/images/chilli_leaves_macro_1795851503569.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        cache
          .addAll(SHELL)
          .then(() => Promise.allSettled(OPTIONAL_ASSETS.map((u) => cache.add(u))))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

function store(request, response) {
  const copy = response.clone();
  caches
    .open(CACHE_VERSION)
    .then((cache) => cache.put(request, copy))
    .catch(() => {});
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) store(request, response);
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Cross-origin (the optional LLM proxy) and the worker itself are never cached.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      networkFirst(request).catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  if (url.pathname.endsWith('/kb.json')) {
    event.respondWith(networkFirst(request));
  }
});
