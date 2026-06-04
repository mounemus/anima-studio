/**
 * Client-side validator for Claude's `actions` payload.
 *
 * The AI is instructed to return a schema, but it can hallucinate or be
 * prompt-injected into producing pathological values (10k particles, 1k-point
 * polygons, nested objects that lock the browser). This module clamps every
 * field to safe ranges BEFORE the actions are dispatched into the Zustand store
 * or persisted to localStorage.
 *
 * Philosophy: never throw. If a field is malformed, silently drop or clamp it.
 * Returning a partial valid Actions object is always better than crashing.
 */
import type {
  OrganismKind, OrganismParams, Palette, MappingShape, FlowField, Vec2,
  ShapeKind, Melody, MelodyNote,
} from '../types/scene'

export interface SafeActions {
  organismValues?: Record<string, number>
  organism?: OrganismParams
  palette?: Palette
  visual?: { feedback?: number; blendMode?: 'add' | 'normal' | 'screen'; bloom?: number; textureIntensity?: number }
  flow?: Partial<FlowField>
  mappingShapes?: MappingShape[]
  melody?: Melody
  newScene?: any
}

const MAX_MELODY_NOTES = 128

function safeMelody(raw: any): Melody | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.notes)) return undefined
  const tempo = clamp(raw.tempo, 30, 280, 120)!
  const loop = raw.loop !== false
  const notes: MelodyNote[] = []
  for (const n of raw.notes.slice(0, MAX_MELODY_NOTES)) {
    if (!n || typeof n !== 'object') continue
    const note = clamp(n.note, 21, 108)
    const time = clamp(n.time, 0, 1024)
    const dur = clamp(n.dur, 0.01, 64)
    if (note === undefined || time === undefined || dur === undefined) continue
    const vel = clamp(n.vel, 0, 1)
    notes.push({ note: Math.round(note), time, dur, vel: vel ?? 0.7 })
  }
  if (notes.length === 0) return undefined
  // Sort by time for deterministic playback
  notes.sort((a, b) => a.time - b.time)
  const out: Melody = { tempo, loop, notes }
  if (typeof raw.key === 'string') out.key = raw.key.slice(0, 20)
  if (typeof raw.scale === 'string') out.scale = raw.scale.slice(0, 20)
  if (typeof raw.description === 'string') out.description = raw.description.slice(0, 200)
  return out
}

const ORG_KINDS: OrganismKind[] = ['boids', 'particles', 'tendrils', 'cells', 'worms', 'spores', 'psychedelic', 'mandala', 'fractal', 'mathcurve']
const CURVE_FORMULAS = ['lissajous', 'rose', 'spirograph', 'butterfly', 'lorenz', 'heart'] as const
const SHAPE_KINDS: ShapeKind[] = ['quad', 'polygon']
const BLEND_MODES = ['add', 'normal', 'screen'] as const

const MAX_SHAPES = 16
const MAX_POLY_POINTS = 64        // matches the GLSL shader array size
const MAX_PARAM_COUNT = 5000      // hard cap on any "count" field
const MAX_NEW_SCENE_DEPTH = 6     // crude bomb protection

function clamp(n: unknown, min: number, max: number, fallback?: number): number | undefined {
  const v = typeof n === 'number' ? n : parseFloat(String(n))
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, v))
}

function isHexColor(s: unknown): s is string {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s)
}

function safePalette(raw: any): Palette | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Partial<Palette> = {}
  for (const k of ['bg', 'primary', 'secondary', 'glow'] as const) {
    if (isHexColor(raw[k])) out[k] = raw[k]
  }
  // Need all four for a valid palette swap
  if (out.bg && out.primary && out.secondary && out.glow) return out as Palette
  return undefined
}

function safeOrganismValues(kind: OrganismKind, raw: any): Record<string, any> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, any> = {}
  // mathcurve: 'formula' is a string enum, not a number — pass through if valid
  if (kind === 'mathcurve' && typeof raw.formula === 'string' && (CURVE_FORMULAS as readonly string[]).includes(raw.formula)) {
    out.formula = raw.formula
  }
  // Per-kind sane ranges (mirror the SYSTEM prompt in api/claude.ts)
  const ranges: Record<string, Record<string, [number, number]>> = {
    boids: {
      count: [50, MAX_PARAM_COUNT], cohesion: [0, 3], separation: [0, 3], alignment: [0, 3],
      speed: [0.05, 5], vision: [0.05, 1.5], size: [0.001, 0.1], trail: [0.5, 0.999],
    },
    particles: {
      count: [50, 8000], speed: [0.05, 5], size: [0.05, 6], spread: [0.1, 3],
      gravity: [-2, 2], turbulence: [0, 3], trail: [0.5, 0.999],
    },
    tendrils: {
      count: [2, 120], length: [4, 96], speed: [0.05, 4], twist: [0, 6], thickness: [0.001, 0.05], trail: [0.5, 0.999],
    },
    cells: {
      count: [2, 300], pulse: [0, 5], size: [0.1, 5], attraction: [0, 3], repulsion: [0, 3], trail: [0.5, 0.999],
    },
    worms: {
      count: [1, 60], segments: [4, 64], speed: [0.05, 4], twist: [0, 4], thickness: [0.001, 0.05],
      trail: [0.5, 0.999], segLen: [0.005, 0.1],
    },
    spores: {
      count: [50, 4000], speed: [0.05, 3], size: [0.002, 0.05], bloomGain: [0, 2], bloomDecay: [0.1, 5],
      reactToObstacles: [0, 1], trail: [0.5, 0.999],
    },
    psychedelic: {
      count: [400, 6400], speed: [0.1, 3], freq: [1, 10], scale: [0.3, 2.5], trail: [0.5, 0.999], size: [0.5, 8],
    },
    mandala: {
      arms: [3, 24], pointsPerArm: [8, 128], outerRadius: [0.1, 1.4], innerRadius: [0, 0.6],
      waves: [0, 8], freq: [0.05, 4], rotation: [-3, 3], thickness: [0.001, 0.03],
      layers: [1, 3], connectors: [0, 6], connectorOpacity: [0, 1],
    },
    fractal: {
      iterations: [16, 256], zoom: [0.1, 8], cx: [-1.5, 1.5], cy: [-1.5, 1.5],
      followHand: [0, 1], bailout: [2, 30], brightness: [0.2, 3],
      orbitSpeed: [0, 2], orbitRadius: [0, 0.5], rotation: [-1, 1], zoomBreath: [0, 0.5],
    },
    mathcurve: {
      samples: [100, 4000], cycles: [0.1, 20], a: [-12, 12], b: [-12, 12], c: [-5, 5], d: [-Math.PI * 2, Math.PI * 2],
      scale: [0.05, 2.5], speed: [0, 4], thickness: [0.001, 0.025], lineOpacity: [0, 1],
    },
  }
  const r = ranges[kind]
  if (!r) return undefined
  for (const [k, [lo, hi]] of Object.entries(r)) {
    if (k in raw) {
      const v = clamp(raw[k], lo, hi)
      if (v !== undefined) out[k] = v
    }
  }
  return Object.keys(out).length ? out : undefined
}

function safeOrganism(raw: any): OrganismParams | undefined {
  if (!raw || typeof raw !== 'object' || !ORG_KINDS.includes(raw.kind)) return undefined
  const values = safeOrganismValues(raw.kind, raw.values)
  if (!values) return undefined
  return { kind: raw.kind, values } as unknown as OrganismParams
}

function safeVec2(raw: any): Vec2 | null {
  const x = clamp(raw?.x, -0.2, 1.2)
  const y = clamp(raw?.y, -0.2, 1.2)
  if (x === undefined || y === undefined) return null
  return { x, y }
}

function safeShape(raw: any, i: number): MappingShape | null {
  if (!raw || typeof raw !== 'object') return null
  const kind: ShapeKind = SHAPE_KINDS.includes(raw.kind) ? raw.kind : 'quad'
  const id = typeof raw.id === 'string' ? raw.id.slice(0, 64) : `ai-${Date.now().toString(36)}-${i}`
  const name = typeof raw.name === 'string' ? raw.name.slice(0, 60) : `Zone IA ${i + 1}`
  const corners: [Vec2, Vec2, Vec2, Vec2] = Array.isArray(raw.corners) && raw.corners.length === 4
    ? raw.corners.map(safeVec2).filter((v: Vec2 | null): v is Vec2 => v !== null) as any
    : [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }]
  if (corners.length !== 4) return null
  const shape: MappingShape = {
    id, name, kind, corners,
    enabled: raw.enabled !== false,
    source: { x: 0, y: 0, w: 1, h: 1 },
  }
  if (kind === 'polygon' && Array.isArray(raw.points)) {
    const pts = raw.points.slice(0, MAX_POLY_POINTS).map(safeVec2).filter((p: Vec2 | null): p is Vec2 => p !== null)
    if (pts.length >= 3) shape.points = pts as Vec2[]
    else return null  // polygon needs at least 3 valid points
  }
  const smooth = clamp(raw.smooth, 0, 1)
  if (smooth !== undefined) shape.smooth = smooth
  const rotation = clamp(raw.rotation, -Math.PI * 2, Math.PI * 2)
  if (rotation !== undefined) shape.rotation = rotation
  return shape
}

function safeShapes(raw: any): MappingShape[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: MappingShape[] = []
  for (let i = 0; i < Math.min(raw.length, MAX_SHAPES); i++) {
    const s = safeShape(raw[i], i)
    if (s) out.push(s)
  }
  return out.length ? out : undefined
}

function safeFlow(raw: any): Partial<FlowField> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Partial<FlowField> = {}
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  const angle = clamp(raw.angle, -Math.PI * 2, Math.PI * 2)
  if (angle !== undefined) out.angle = angle
  const strength = clamp(raw.strength, 0, 5)
  if (strength !== undefined) out.strength = strength
  const turbulence = clamp(raw.turbulence, 0, 3)
  if (turbulence !== undefined) out.turbulence = turbulence
  return Object.keys(out).length ? out : undefined
}

function depth(obj: any, lvl = 0): number {
  if (lvl > MAX_NEW_SCENE_DEPTH) return MAX_NEW_SCENE_DEPTH + 1
  if (!obj || typeof obj !== 'object') return lvl
  let m = lvl
  for (const v of Object.values(obj)) m = Math.max(m, depth(v, lvl + 1))
  return m
}

export function validateActions(raw: any): SafeActions {
  if (!raw || typeof raw !== 'object') return {}
  const out: SafeActions = {}

  // organismValues: anonymous record — clamp to a tight range so AI can't trash perf
  if (raw.organismValues && typeof raw.organismValues === 'object') {
    const vals: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw.organismValues)) {
      // tightest neutral range covering all kinds
      const c = clamp(v, k === 'count' ? 1 : 0, k === 'count' ? MAX_PARAM_COUNT : 10)
      if (c !== undefined) vals[k] = c
    }
    if (Object.keys(vals).length) out.organismValues = vals
  }
  const org = safeOrganism(raw.organism)
  if (org) out.organism = org
  const pal = safePalette(raw.palette)
  if (pal) out.palette = pal
  if (raw.visual && typeof raw.visual === 'object') {
    const v: SafeActions['visual'] = {}
    const feedback = clamp(raw.visual.feedback, 0.5, 0.999)
    if (feedback !== undefined) v.feedback = feedback
    const bloom = clamp(raw.visual.bloom, 0, 2)
    if (bloom !== undefined) v.bloom = bloom
    const ti = clamp(raw.visual.textureIntensity, 0, 1)
    if (ti !== undefined) v.textureIntensity = ti
    if (BLEND_MODES.includes(raw.visual.blendMode)) v.blendMode = raw.visual.blendMode
    if (Object.keys(v).length) out.visual = v
  }
  const flow = safeFlow(raw.flow)
  if (flow) out.flow = flow
  const shapes = safeShapes(raw.mappingShapes)
  if (shapes) out.mappingShapes = shapes
  const melody = safeMelody(raw.melody)
  if (melody) out.melody = melody
  // newScene: keep loose but bound the depth and apply the same validator pieces
  if (raw.newScene && typeof raw.newScene === 'object' && depth(raw.newScene) <= MAX_NEW_SCENE_DEPTH) {
    out.newScene = raw.newScene
  }
  return out
}
