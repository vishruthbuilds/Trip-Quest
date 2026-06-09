// TripQuest PWA Service Worker
const CACHE_NAME = 'tripquest-cache-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './js/app.js',
  './js/supabase.js',
  './icon.svg',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Pass-through for external maps & database APIs
  if (
    event.request.url.includes('supabase.co') || 
    event.request.url.includes('basemaps.cartocdn.com') ||
    event.request.url.includes('nominatim.openstreetmap.org') ||
    event.request.url.includes('api.allorigins.win') ||
    event.request.url.includes('unpkg.com')
  ) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
