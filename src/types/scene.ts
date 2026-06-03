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

export type ObstacleKind = 'circle' | 'polygon' | 'hand' | 'silhouette'
export type ObstacleInteraction = 'avoid' | 'attract' | 'bounce' | 'kill'

export type Waveform = 'sine' | 'triangle' | 'sawtooth' | 'square'

export interface SoundConfig {
  enabled: boolean
  /** MIDI note number (60 = C4). If 'auto', derived from obstacle index. */
  note: number | 'auto'
  waveform: Waveform
  /** 0..1 volume scaler */
  volume: number
  /** if true: continuous tone modulated by density; if false: pulse on entry */
  density: boolean
  /** lowpass cutoff Hz (200..8000) */
  cutoff: number
}

export interface Obstacle {
  id: string
  name: string
  kind: ObstacleKind
  enabled: boolean
  interaction: ObstacleInteraction
  strength: number              // 0..2
  /** how much "soft margin" around the obstacle the force extends, in world units (~0.05–0.4) */
  margin: number
  /** for circle */
  circle?: { cx: number; cy: number; r: number }   // 0..1 normalized
  /** for polygon */
  polygon?: { points: Vec2[] }
  /** for hand: which landmark to use as center (default = palm), and radius */
  hand?: { source: 'palm' | 'index'; radius: number }
  /** for silhouette: threshold + invert */
  silhouette?: { invert: boolean }
  /** visual hint on stage when overlay is on */
  visible: boolean
  /** sonification (optional) */
  sound?: SoundConfig
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
  obstacles?: Obstacle[]
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

export const defaultObstacle = (kind: ObstacleKind, i = 0): Obstacle => {
  const base: Obstacle = {
    id: `obs-${Date.now().toString(36)}-${i}`,
    name: kind === 'hand' ? 'Main' : kind === 'silhouette' ? 'Silhouette' : `Obstacle ${i + 1}`,
    kind, enabled: true,
    interaction: 'avoid',
    strength: 1,
    margin: 0.15,
    visible: true,
  }
  if (kind === 'circle') base.circle = { cx: 0.5, cy: 0.5, r: 0.15 }
  if (kind === 'polygon') base.polygon = { points: [
    { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 },
  ] }
  if (kind === 'hand') base.hand = { source: 'palm', radius: 0.12 }
  if (kind === 'silhouette') base.silhouette = { invert: false }
  base.sound = { enabled: false, note: 'auto', waveform: 'sine', volume: 0.5, density: true, cutoff: 2000 }
  return base
}

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
