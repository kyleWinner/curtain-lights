// Network first, cached copy as a fallback, so the home screen and remotes
// still open if the Wi-Fi drops (Bluetooth control doesn't need the internet).
// Other sites (weather, Spotify, fonts) are never cached here.
const CACHE = 'home-v10';
const CORE = ['./home.html', './home.css?v=16', './home.js?v=16', './img/home-bg.jpg', './', './strip.html', './manifest.webmanifest', './icons/icon-192.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // no-cache: always check GitHub for a newer copy, so a page and its script never get out of step
  e.respondWith(fetch(req, {cache: 'no-cache'}).then(res => {
    if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, {ignoreSearch: true})));
});
