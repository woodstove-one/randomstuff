const CACHE_NAME = 'time-management-v1';
const urlsToCache = [
    '/time%20management/index.html',
    '/time%20management/styles.css',
    '/time%20management/app.js',
    '/time%20management/manifest.json',
    'https://cdn.jsdelivr.net/npm/chart.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
    );
});