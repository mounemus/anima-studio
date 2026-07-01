import type { Scene, OrganismKind } from '../types/scene'
import { defaultMapping, defaultFlow } from '../types/scene'
import { ORGANISM_DEFAULTS } from '../engine/OrganismFactory'
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

/** Return a safe organism {kind, values} even if the input is missing or malformed.
 *  Backfills missing `values` from ORGANISM_DEFAULTS for the declared kind, so a
 *  scene serialized with just `{ organism: { kind: 'boids' } }` (no values) doesn't
 *  crash the Engine which reads e.g. `values.count`. */
function safeOrganism(rawOrg: any): { kind: OrganismKind; values: Record<string, number> } {
  const kind: OrganismKind = (rawOrg?.kind && (ORGANISM_DEFAULTS as any)[rawOrg.kind])
    ? rawOrg.kind
    : 'boids'
  const defaults = ORGANISM_DEFAULTS[kind]
  // Merge : defaults first (so every expected field exists), then the incoming
  // values (so user edits win). Non-numeric fields (formula, preset, rule…) pass
  // through untouched from the raw values.
  const values = { ...defaults, ...(rawOrg?.values ?? {}) }
  return { kind, values }
}

/** Forward-migrate older saved scenes (add missing fields with sane defaults).
 *  Exported so the import path can reuse the exact same hardening as load. */
export function migrateScene(s: any): Scene {
  const v = s.visual ?? {}
  return {
    ...s,
    organism: safeOrganism(s.organism),
    mapping: { ...defaultMapping(), ...(s.mapping ?? {}) },
    obstacles: Array.isArray(s.obstacles) ? s.obstacles : [],
    flow: s.flow ?? defaultFlow(),
    visual: {
      bloom: 0.5, feedback: 0.92, blendMode: 'add' as const, texture: null, textureIntensity: 0,
      ...v,
      // Palette must be DEEP-merged : a partial palette (e.g. only {primary})
      // from an old/external file would otherwise wipe bg/secondary/glow and
      // crash the Engine which reads palette.bg/primary/secondary/glow.
      palette: {
        bg: '#000000', primary: '#00ffa3', secondary: '#00d4ff', glow: '#7c3aed',
        ...(v.palette ?? {}),
      },
    },
    evolution: s.evolution ?? { enabled: false, driftSpeed: 0.1, amplitude: 0.2 },
    senses: (() => {
      const sn = s.senses ?? { hands: true, audio: false, light: false, bindings: [] }
      if (!Array.isArray(sn.bindings)) sn.bindings = []
      return sn
    })(),
    // Fields added after launch — preserve when present, default to empty when
    // missing. Without these, an older scene saved before a feature shipped
    // would silently lose data on every reload (modifiers vanish, melody gone).
    modifiers: Array.isArray(s.modifiers) ? s.modifiers : [],
    timeline: s.timeline,
    melody: s.melody,
    notes: typeof s.notes === 'string' ? s.notes : '',
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
  // Strip blob:/transient sources so the exported file doesn't carry dead
  // references that break on re-import or on another machine.
  const clean = sanitizeForSave(s)
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${s.id}.scene.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function importSceneJSON(file: File): Promise<Scene> {
  const text = await file.text()
  const raw = JSON.parse(text)
  if (!raw || !raw.id || !raw.organism) throw new Error('Invalid scene file')
  // Run the imported object through the SAME hardening as the load path, so an
  // old or partial JSON (missing palette/mapping/visual) can't crash the Engine.
  return sanitizeForSave(migrateScene(raw))
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
