export type OrganismKind = 'boids' | 'particles' | 'tendrils' | 'cells'

export interface Vec2 { x: number; y: number }

export interface BoidsParams {
  count: number
  cohesion: number
  separation: number
  alignment: number
  speed: number
  vision: number
  size: number
  trail: number
}

export interface ParticleParams {
  count: number
  speed: number
  size: number
  spread: number
  trail: number
  gravity: number
  turbulence: number
}

export interface TendrilsParams {
  count: number
  length: number
  speed: number
  twist: number
  thickness: number
  trail: number
}

export interface CellsParams {
  count: number
  pulse: number
  size: number
  attraction: number
  repulsion: number
  trail: number
}

export type OrganismParams =
  | { kind: 'boids'; values: BoidsParams }
  | { kind: 'particles'; values: ParticleParams }
  | { kind: 'tendrils'; values: TendrilsParams }
  | { kind: 'cells'; values: CellsParams }

export interface Palette {
  bg: string
  primary: string
  secondary: string
  glow: string
}

export interface AITexture {
  url: string
  prompt: string
  model: string
  seed?: number
  generatedAt: number
}

export interface VisualParams {
  palette: Palette
  bloom: number
  feedback: number       // 0..1 trail fade
  blendMode: 'add' | 'normal' | 'screen'
  texture?: AITexture | null
  textureIntensity?: number   // 0..1, 0 = pure palette, 1 = pure texture
}

export interface SenseBinding {
  source: 'hand.index' | 'hand.palm' | 'hand.pinch' | 'audio.bass' | 'audio.mid' | 'audio.high' | 'audio.level' | 'light'
  target: string         // dotted path inside organism.values OR visual.*
  range: [number, number]
  invert?: boolean
}

export interface SenseConfig {
  hands: boolean
  audio: boolean
  light: boolean
  bindings: SenseBinding[]
}

export interface Evolution {
  enabled: boolean
  driftSpeed: number     // 0..1, how fast organic Perlin-like drift mutates params
  amplitude: number      // 0..1 max delta from base
}

export type TestPattern = 'none' | 'grid' | 'white' | 'black' | 'colorbars' | 'crosshair' | 'gradient'

/** Source rectangle on the input texture (uv 0..1). Lets a shape sample only a portion of the rendered scene. */
export interface SourceRect { x: number; y: number; w: number; h: number }

export interface MappingShape {
  id: string
  name: string
  /** TL, TR, BR, BL in canvas 0..1 — where on the projector it lands */
  corners: [Vec2, Vec2, Vec2, Vec2]
  /** Which portion of the source texture this shape samples */
  source: SourceRect
  enabled: boolean
}

export interface MappingConfig {
  enabled: boolean
  /** Legacy single-quad: kept for compatibility with old scenes. */
  corners: [Vec2, Vec2, Vec2, Vec2]
  /** Multi-shape Kantan-style mapping. When empty, falls back to `corners`. */
  shapes?: MappingShape[]
  /** Currently selected shape index (UI state, persisted for convenience) */
  selectedShape?: number
  edgeBlend: {
    left: number; right: number; top: number; bottom: number; gamma: number
  }
  testPattern?: TestPattern
}

export interface Scene {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  organism: OrganismParams
  visual: VisualParams
  senses: SenseConfig
  evolution: Evolution
  mapping: MappingConfig
  notes?: string
}

export const defaultMapping = (): MappingConfig => ({
  enabled: false,
  corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  shapes: [],
  selectedShape: 0,
  edgeBlend: { left: 0, right: 0, top: 0, bottom: 0, gamma: 2.2 },
  testPattern: 'none',
})

export const defaultShape = (i = 0): MappingShape => ({
  id: `shape-${Date.now().toString(36)}-${i}`,
  name: `Zone ${i + 1}`,
  corners: [
    { x: 0.1 + i * 0.05, y: 0.1 + i * 0.05 },
    { x: 0.9 + i * 0.05, y: 0.1 + i * 0.05 },
    { x: 0.9 + i * 0.05, y: 0.9 + i * 0.05 },
    { x: 0.1 + i * 0.05, y: 0.9 + i * 0.05 },
  ],
  source: { x: 0, y: 0, w: 1, h: 1 },
  enabled: true,
})
