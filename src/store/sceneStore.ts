import { create } from 'zustand'
import type { Scene, OrganismParams, VisualParams, MappingConfig, AITexture, Evolution, MappingShape, TestPattern, Obstacle, ObstacleKind } from '../types/scene'
import { defaultScenes } from '../lib/defaultScenes'
import { defaultShape, defaultObstacle } from '../types/scene'
import { saveScene, loadAllScenes, deleteScene as dbDelete } from '../lib/persistence'

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
  addMappingShape: () => void
  removeMappingShape: (id: string) => void
  updateMappingShape: (id: string, patch: Partial<MappingShape>) => void
  selectMappingShape: (idx: number) => void
  setTestPattern: (p: TestPattern) => void
  addObstacle: (kind: ObstacleKind) => void
  removeObstacle: (id: string) => void
  updateObstacle: (id: string, patch: Partial<Obstacle>) => void
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
    try {
      let existing = await loadAllScenes()
      if (existing.length === 0) {
        // seed with defaults
        for (const s of defaultScenes) {
          try { await saveScene(s) } catch (e) { console.warn('seed save failed', e) }
        }
        existing = [...defaultScenes]
      }
      set({ scenes: existing, currentId: existing[0]?.id ?? null, dbStatus: 'ok', dbError: null })
    } catch (e: any) {
      // DB unavailable (locked, blocked, version mismatch) — fall back to in-memory defaults
      console.error('IndexedDB load failed, using in-memory defaults', e)
      set({
        scenes: [...defaultScenes],
        currentId: defaultScenes[0]?.id ?? null,
        dbStatus: 'fallback',
        dbError: e?.message ?? 'IndexedDB unavailable',
      })
    }
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

  addMappingShape: () => {
    set((st) => {
      const next = st.scenes.map((s) => {
        if (s.id !== st.currentId) return s
        const shapes = [...(s.mapping.shapes ?? []), defaultShape(s.mapping.shapes?.length ?? 0)]
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

  addObstacle: (kind) => {
    set((st) => {
      const next = st.scenes.map((s) => {
        if (s.id !== st.currentId) return s
        const obs = [...(s.obstacles ?? []), defaultObstacle(kind, (s.obstacles ?? []).length)]
        return { ...s, obstacles: obs, updatedAt: Date.now() }
      })
      return { scenes: next }
    })
    debouncePersist(() => get().persistCurrent())
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
