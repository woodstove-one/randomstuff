const CACHE_NAME = 'audioflow-cache-v1';
const ASSETS_TO_CACHE = [
  'https://woodstove-one.github.io/randomstuff/audio/',
  'https://woodstove-one.github.io/randomstuff/audio/audiov15.html',
  'https://woodstove-one.github.io/randomstuff/audio/manifest.json',
  'https://woodstove-one.github.io/randomstuff/audio/icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).catch(() =>
        caches.match('https://woodstove-one.github.io/randomstuff/audio/audiov15.html')
      );
    })
  );
});