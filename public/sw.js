// DigiArt — service worker minimal : l'application installée s'ouvre même sans réseau.
// Pages : le réseau d'abord (toujours la dernière version), la copie gardée seulement en secours.
// Fichiers /assets/ : leur nom change à chaque version, on peut donc les garder tels quels.
// ponytail: les anciens /assets/ restent en cache jusqu'au prochain changement de CACHE ; purger par date si le cache grossit.
const CACHE = 'digiart-v2'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const old = (await caches.keys()).filter((k) => k !== CACHE)
  await Promise.all(old.map((k) => caches.delete(k)))
  await self.clients.claim()
  // Une version précédente tournait : ses fenêtres ouvertes montrent peut-être une vieille page, on les recharge.
  if (old.length) for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url).catch(() => { /* fenêtre fermée entre-temps */ })
})()))

const keep = (key, res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)) } return res }

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (req.mode === 'navigate') {
    if (/\.[a-z0-9]+$/i.test(url.pathname)) return   // un fichier ouvert directement (image, JSON) : pas la page
    // Toutes les routes servent la même page. On la redemande au serveur sans passer par le cache du navigateur :
    // en rouvrant une fenêtre restaurée ou mise en veille, Chrome accepte sinon une copie périmée, et l'application
    // installée repartait sur une ancienne version alors que la nouvelle était en ligne.
    e.respondWith(fetch('/', { cache: 'no-store' }).then((res) => res.ok ? keep('/', res) : Promise.reject(new Error(String(res.status))))
      .catch(() => caches.match('/').then((hit) => hit || fetch(req))))
  } else if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(req, res))))
  }
})
