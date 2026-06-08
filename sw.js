// TripQuest PWA Service Worker
const CACHE_NAME = 'tripquest-cache-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './js/app.js',
  './js/state.js',
  './js/sync.js',
  './js/itinerary.js',
  './js/game.js',
  './js/maps.js',
  './js/mockData.js',
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
  // Pass-through for Supabase requests (real-time websockets/REST shouldn't be cached)
  if (event.request.url.includes('supabase.co') || event.request.url.includes('basemaps.cartocdn.com')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Return cache or fetch fresh
      return cachedResponse || fetch(event.request);
    })
  );
});
