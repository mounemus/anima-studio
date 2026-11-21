/**
 * Installation de DigiArt comme application (Chrome, Edge : fenêtre à part, icône dans le menu Démarrer).
 * Le navigateur annonce que l'installation est possible par `beforeinstallprompt`, parfois avant que
 * l'interface soit montée : on garde l'événement ici, et le bouton le rejoue au clic.
 */
import { useEffect, useState } from 'react'

let deferred: any = null
const listeners = new Set<() => void>()
const tell = () => listeners.forEach((f) => f())
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; tell() })
  window.addEventListener('appinstalled', () => { deferred = null; tell() })
}

/** Renvoie la fonction qui ouvre la fenêtre d'installation, ou `null` si ce n'est pas possible (déjà installée, navigateur sans cette fonction). */
export function useInstall(): (() => void) | null {
  const [can, setCan] = useState(!!deferred)
  useEffect(() => { const f = () => setCan(!!deferred); listeners.add(f); f(); return () => { listeners.delete(f) } }, [])
  return can ? () => { const d = deferred; deferred = null; tell(); d?.prompt() } : null
}

/** Le service worker ne tourne qu'en production : en développement il servirait d'anciens fichiers. */
export function registerServiceWorker() {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* pas d'installation hors ligne, l'app marche quand même */ }) })
}
