import { create } from 'zustand'
import type { Scene, OrganismParams, VisualParams, MappingConfig, AITexture, Evolution, MappingShape, TestPattern, Obstacle, ObstacleKind, FlowField } from '../types/scene'
import { defaultScenes } from '../lib/defaultScenes'
import { defaultShape, defaultObstacle, defaultFlow } from '../types/scene'
import { saveScene, loadAllScenes, deleteScene as dbDelete, migrateFromIndexedDB } from '../lib/persistence'
import { hasStorage } from '../lib/storage'

interface SceneStoreState {
  scenes: Scene[]
  currentId: string | null
  dbStatus: 'init' | 'ok' | 'fallback'  // fallback = in-memory only, no persistence
  dbError: string | null
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
  addMappingShape: (kind?: 'quad' | 'polygon') => void
  addMappingShapes: (shapes: MappingShape[]) => void
  removeMappingShape: (id: string) => void
  updateMappingShape: (id: string, patch: Partial<MappingShape>) => void
  selectMappingShape: (idx: number) => void
  setTestPattern: (p: TestPattern) => void
  addObstacle: (kind: ObstacleKind, patch?: Partial<Obstacle>) => string | null
  removeObstacle: (id: string) => void
  updateObstacle: (id: string, patch: Partial<Obstacle>) => void
  updateFlow: (patch: Partial<FlowField>) => void
  setTexture: (tex: AITexture | null) => void
  setTextureIntensity: (v: number) => void
  updateEvolution: (e: Partial<Evolution>) => void
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
  dbStatus: 'init',
  dbError: null,

  current: () => {
    const { scenes, currentId } = get()
    return scenes.find((s) => s.id === currentId) ?? null
  },

  load: async () => {
    if (!hasStorage()) {
      // Private browsing in Safari can disable localStorage. Use in-memory defaults.
      console.warn('localStorage unavailable — in-memory only')
      set({
        scenes: [...defaultScenes],
        currentId: defaultScenes[0]?.id ?? null,
        dbStatus: 'fallback',
        dbError: 'localStorage indisponible (mode privé ?)',
      })
      return
    }
    let existing = await loadAllScenes()
    if (existing.length === 0) {
      // Try one-shot migration from a pre-existing IndexedDB (legacy users).
      const migrated = await migrateFromIndexedDB()
      if (migrated > 0) {
        console.info(`Migrated ${migrated} scenes from IndexedDB → localStorage`)
        existing = await loadAllScenes()
      }
    }
    if (existing.length === 0) {
      // seed with defaults
      for (const s of defaultScenes) await saveScene(s)
      existing = [...defaultScenes]
    }
    set({ scenes: existing, currentId: existing[0]?.id ?? null, dbStatus: 'ok', dbError: null })
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

  addMappingShape: (kind = 'quad' as 'quad' | 'polygon') => {
    set((st) => {
      const next = st.scenes.map((s) => {
        if (s.id !== st.currentId) return s
        const shapes = [...(s.mapping.shapes ?? []), defaultShape(s.mapping.shapes?.length ?? 0, kind)]
        return { ...s, mapping: { ...s.mapping, shapes, selectedShape: shapes.length - 1, enabled: true }, updatedAt: Date.now() }
      })
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  addMappingShapes: (newShapes: MappingShape[]) => {
    set((st) => {
      const next = st.scenes.map((s) => {
        if (s.id !== st.currentId) return s
        const shapes = [...(s.mapping.shapes ?? []), ...newShapes]
        return { ...s, mapping: { ...s.mapping, shapes, selectedShape: shapes.length - 1, enabled: true }, updatedAt: Date.now() }
      })
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  removeMappingShape: (id) => {
    set((st) => {
      const next = st.scenes.map((s) => {
        if (s.id !== st.currentId) return s
        const shapes = (s.mapping.shapes ?? []).filter((sh) => sh.id !== id)
        const sel = Math.max(0, Math.min((s.mapping.selectedShape ?? 0), shapes.length - 1))
        return { ...s, mapping: { ...s.mapping, shapes, selectedShape: sel }, updatedAt: Date.now() }
      })
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  updateMappingShape: (id, patch) => {
    set((st) => {
      const next = st.scenes.map((s) => {
        if (s.id !== st.currentId) return s
        const shapes = (s.mapping.shapes ?? []).map((sh) => sh.id === id ? { ...sh, ...patch } : sh)
        return { ...s, mapping: { ...s.mapping, shapes }, updatedAt: Date.now() }
      })
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  selectMappingShape: (idx) => {
    set((st) => {
      const next = st.scenes.map((s) => s.id === st.currentId ? { ...s, mapping: { ...s.mapping, selectedShape: idx } } : s)
      return { scenes: next }
    })
  },

  setTestPattern: (p) => {
    set((st) => {
      const next = st.scenes.map((s) => s.id === st.currentId ? { ...s, mapping: { ...s.mapping, testPattern: p } } : s)
      return { scenes: next }
    })
  },

  addObstacle: (kind, patch) => {
    // Build the obstacle synchronously so we can return its ID for the caller
    // to chain updates without race-prone setTimeout hacks.
    const cur = get().current()
    if (!cur) return null
    const fresh = { ...defaultObstacle(kind, (cur.obstacles ?? []).length), ...(patch ?? {}) }
    set((st) => {
      const next = st.scenes.map((s) => {
        if (s.id !== st.currentId) return s
        return { ...s, obstacles: [...(s.obstacles ?? []), fresh], updatedAt: Date.now() }
      })
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
    return fresh.id
  },

  removeObstacle: (id) => {
    set((st) => {
      const next = st.scenes.map((s) => s.id === st.currentId ? { ...s, obstacles: (s.obstacles ?? []).filter((o) => o.id !== id), updatedAt: Date.now() } : s)
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  updateObstacle: (id, patch) => {
    set((st) => {
      const next = st.scenes.map((s) => {
        if (s.id !== st.currentId) return s
        const obs = (s.obstacles ?? []).map((o) => o.id === id ? { ...o, ...patch } : o)
        return { ...s, obstacles: obs, updatedAt: Date.now() }
      })
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  updateFlow: (patch) => {
    set((st) => {
      const next = st.scenes.map((s) => {
        if (s.id !== st.currentId) return s
        const base = s.flow ?? defaultFlow()
        return { ...s, flow: { ...base, ...patch }, updatedAt: Date.now() }
      })
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  setTexture: (tex) => {
    set((st) => {
      const next = st.scenes.map((s) => s.id === st.currentId ? { ...s, visual: { ...s.visual, texture: tex }, updatedAt: Date.now() } : s)
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  setTextureIntensity: (v) => {
    set((st) => {
      const next = st.scenes.map((s) => s.id === st.currentId ? { ...s, visual: { ...s.visual, textureIntensity: v }, updatedAt: Date.now() } : s)
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
  },

  updateEvolution: (e) => {
    set((st) => {
      const next = st.scenes.map((s) => s.id === st.currentId ? { ...s, evolution: { ...s.evolution, ...e }, updatedAt: Date.now() } : s)
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

// Multi-tab synchronization: when another tab writes a scene to localStorage,
// hydrate it into this tab's store so both stay consistent (last-write-wins).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key || !e.key.startsWith('scene:') || !e.newValue) return
    try {
      const updated = JSON.parse(e.newValue) as Scene
      if (!updated.id) return
      const st = useSceneStore.getState()
      const local = st.scenes.find((s) => s.id === updated.id)
      // Only accept if remote is newer (avoid stomping in-flight local edits)
      if (local && updated.updatedAt > local.updatedAt) {
        useSceneStore.setState({
          scenes: st.scenes.map((s) => (s.id === updated.id ? updated : s)),
        })
      } else if (!local) {
        useSceneStore.setState({ scenes: [...st.scenes, updated] })
      }
    } catch { /* ignore parse errors */ }
  })
}
