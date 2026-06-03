import { create } from 'zustand'
import type { Scene, OrganismParams, VisualParams, MappingConfig } from '../types/scene'
import { defaultScenes } from '../lib/defaultScenes'
import { saveScene, loadAllScenes, deleteScene as dbDelete } from '../lib/persistence'

interface SceneStoreState {
  scenes: Scene[]
  currentId: string | null
  current: () => Scene | null

  load: () => Promise<void>
  select: (id: string) => void
  duplicate: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  add: (s: Scene) => Promise<void>

  updateOrganism: (params: OrganismParams) => void
  patchOrganismValues: (patch: Record<string, number>) => void
  updateVisual: (v: Partial<VisualParams>) => void
  updatePalette: (p: Partial<VisualParams['palette']>) => void
  updateMapping: (m: Partial<MappingConfig>) => void
  rename: (name: string) => void
  setNotes: (notes: string) => void

  persistCurrent: () => Promise<void>
}

let persistTimer = 0
const debouncePersist = (fn: () => void) => {
  clearTimeout(persistTimer)
  persistTimer = window.setTimeout(fn, 300)
}

export const useSceneStore = create<SceneStoreState>((set, get) => ({
  scenes: [],
  currentId: null,

  current: () => {
    const { scenes, currentId } = get()
    return scenes.find((s) => s.id === currentId) ?? null
  },

  load: async () => {
    let existing = await loadAllScenes()
    if (existing.length === 0) {
      // seed with defaults
      for (const s of defaultScenes) await saveScene(s)
      existing = [...defaultScenes]
    }
    set({ scenes: existing, currentId: existing[0]?.id ?? null })
  },

  select: (id) => set({ currentId: id }),

  add: async (s) => {
    await saveScene(s)
    set((st) => ({ scenes: [...st.scenes.filter((x) => x.id !== s.id), s], currentId: s.id }))
  },

  duplicate: async (id) => {
    const src = get().scenes.find((s) => s.id === id)
    if (!src) return
    const copy: Scene = {
      ...JSON.parse(JSON.stringify(src)),
      id: `${src.id}-${Date.now().toString(36)}`,
      name: `${src.name} (copie)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await saveScene(copy)
    set((st) => ({ scenes: [...st.scenes, copy], currentId: copy.id }))
  },

  remove: async (id) => {
    await dbDelete(id)
    set((st) => {
      const next = st.scenes.filter((s) => s.id !== id)
      return { scenes: next, currentId: next[0]?.id ?? null }
    })
  },

  updateOrganism: (params) => {
    set((st) => {
      const next = st.scenes.map((s) => s.id === st.currentId ? { ...s, organism: params, updatedAt: Date.now() } : s)
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  patchOrganismValues: (patch) => {
    set((st) => {
      const next = st.scenes.map((s) => {
        if (s.id !== st.currentId) return s
        const v = { ...s.organism.values, ...patch }
        return { ...s, organism: { ...s.organism, values: v } as OrganismParams, updatedAt: Date.now() }
      })
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  updateVisual: (v) => {
    set((st) => {
      const next = st.scenes.map((s) => s.id === st.currentId ? { ...s, visual: { ...s.visual, ...v }, updatedAt: Date.now() } : s)
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  updatePalette: (p) => {
    set((st) => {
      const next = st.scenes.map((s) => s.id === st.currentId
        ? { ...s, visual: { ...s.visual, palette: { ...s.visual.palette, ...p } }, updatedAt: Date.now() }
        : s,
      )
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  updateMapping: (m) => {
    set((st) => {
      const next = st.scenes.map((s) => s.id === st.currentId ? { ...s, mapping: { ...s.mapping, ...m }, updatedAt: Date.now() } : s)
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  rename: (name) => {
    set((st) => ({ scenes: st.scenes.map((s) => s.id === st.currentId ? { ...s, name } : s) }))
    debouncePersist(() => get().persistCurrent())
  },

  setNotes: (notes) => {
    set((st) => ({ scenes: st.scenes.map((s) => s.id === st.currentId ? { ...s, notes } : s) }))
    debouncePersist(() => get().persistCurrent())
  },

  persistCurrent: async () => {
    const s = get().current()
    if (s) await saveScene(s)
  },
}))
