import type { Scene } from '../types/scene'
import { defaultMapping, defaultFlow } from '../types/scene'
import { getItem, setItem, removeItem, listKeys } from './storage'

const KEY = (id: string) => `scene:${id}`
const PREFIX = 'scene:'

/**
 * Strip values that don't survive a reload (blob: URLs from local uploads)
 * and replace them with `undefined` while keeping `label` as a breadcrumb so
 * the user can re-pick the file. Also runs lightweight forward migrations for
 * older saved scenes that pre-date newer fields.
 */
function sanitizeForSave(s: Scene): Scene {
  const next: Scene = JSON.parse(JSON.stringify(s))
  const shapes = next.mapping?.shapes ?? []
  for (const sh of shapes) {
    if (sh.content?.src?.startsWith('blob:')) {
      // can't survive a reload — strip but keep the filename hint
      sh.content.src = undefined
    }
  }
  return next
}

/** Forward-migrate older saved scenes (add missing fields with sane defaults). */
function migrateScene(s: any): Scene {
  return {
    ...s,
    mapping: { ...defaultMapping(), ...(s.mapping ?? {}) },
    obstacles: Array.isArray(s.obstacles) ? s.obstacles : [],
    flow: s.flow ?? defaultFlow(),
    visual: {
      palette: { bg: '#000000', primary: '#00ffa3', secondary: '#00d4ff', glow: '#7c3aed' },
      bloom: 0.5, feedback: 0.92, blendMode: 'add' as const, texture: null, textureIntensity: 0,
      ...(s.visual ?? {}),
    },
    evolution: s.evolution ?? { enabled: false, driftSpeed: 0.1, amplitude: 0.2 },
    senses: s.senses ?? { hands: true, audio: false, light: false, bindings: [] },
  } as Scene
}

export async function saveScene(s: Scene) {
  setItem(KEY(s.id), { ...sanitizeForSave(s), updatedAt: Date.now() })
}

export async function loadAllScenes(): Promise<Scene[]> {
  const keys = listKeys(PREFIX)
  const out: Scene[] = []
  for (const k of keys) {
    const s = getItem<Scene>(k)
    if (s && s.id && s.organism) out.push(migrateScene(s))
  }
  return out
}

export async function deleteScene(id: string) {
  removeItem(KEY(id))
}

export async function clearAll() {
  const keys = listKeys(PREFIX)
  for (const k of keys) removeItem(k)
}

export function exportSceneJSON(s: Scene) {
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${s.id}.scene.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function importSceneJSON(file: File): Promise<Scene> {
  const text = await file.text()
  const s = JSON.parse(text) as Scene
  if (!s.id || !s.organism) throw new Error('Invalid scene file')
  return s
}

/**
 * One-shot best-effort migration from a pre-existing IndexedDB ('anima-studio' v2).
 * Runs with a strict timeout — never blocks app boot.
 * Called by the store on first load if no scenes exist in localStorage yet.
 */
export async function migrateFromIndexedDB(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0
  const TIMEOUT = 1200
  return new Promise<number>((resolve) => {
    let settled = false
    const done = (n: number) => { if (!settled) { settled = true; resolve(n) } }
    const timer = setTimeout(() => done(0), TIMEOUT)

    try {
      const req = indexedDB.open('anima-studio')
      req.onsuccess = () => {
        const d = req.result
        try {
          if (!d.objectStoreNames.contains('scenes')) { d.close(); clearTimeout(timer); done(0); return }
          const tx = d.transaction('scenes', 'readonly')
          const store = tx.objectStore('scenes')
          const all = store.getAll()
          all.onsuccess = () => {
            const scenes = (all.result ?? []) as Scene[]
            for (const s of scenes) {
              if (s?.id) setItem(KEY(s.id), s)
            }
            try { d.close() } catch { /* noop */ }
            clearTimeout(timer)
            done(scenes.length)
          }
          all.onerror = () => { try { d.close() } catch {} ; clearTimeout(timer); done(0) }
        } catch { try { d.close() } catch {} ; clearTimeout(timer); done(0) }
      }
      req.onerror = () => { clearTimeout(timer); done(0) }
      req.onblocked = () => { /* let the timeout decide */ }
    } catch { clearTimeout(timer); done(0) }
  })
}
