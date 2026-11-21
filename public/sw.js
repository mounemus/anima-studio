// DigiArt — service worker minimal : l'application installée s'ouvre même sans réseau.
// Pages : le réseau d'abord (toujours la dernière version), la copie gardée seulement en secours.
// Fichiers /assets/ : leur nom change à chaque version, on peut donc les garder tels quels.
// ponytail: les anciens /assets/ restent en cache jusqu'au prochain changement de CACHE ; purger par date si le cache grossit.
const CACHE = 'digiart-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
))

const keep = (key, res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)) } return res }

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (req.mode === 'navigate') {   // toutes les routes servent la même page
    e.respondWith(fetch(req).then((res) => keep('/', res)).catch(() => caches.match('/').then((hit) => hit || Response.error())))
  } else if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(req, res))))
  }
})
