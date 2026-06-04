export type OrganismKind = 'boids' | 'particles' | 'tendrils' | 'cells' | 'worms' | 'spores' | 'psychedelic' | 'mandala' | 'fractal' | 'mathcurve'

export interface PsychedelicParams { count: number; speed: number; freq: number; scale: number; trail: number; size: number }
export interface MandalaParams { arms: number; pointsPerArm: number; outerRadius: number; innerRadius: number; waves: number; freq: number; rotation: number; thickness: number; layers: number; connectors: number; connectorOpacity: number }
export interface FractalParams { iterations: number; zoom: number; cx: number; cy: number; followHand: number; bailout: number; brightness: number; orbitSpeed: number; orbitRadius: number; rotation: number; zoomBreath: number }
export type CurveFormula = 'lissajous' | 'rose' | 'spirograph' | 'butterfly' | 'lorenz' | 'heart'
export interface MathCurveParams { formula: CurveFormula; samples: number; cycles: number; a: number; b: number; c: number; d: number; scale: number; speed: number; thickness: number; lineOpacity: number }

export interface WormsParams {
  count: number
  segments: number
  speed: number
  twist: number
  thickness: number
  trail: number
  segLen: number
}

export interface SporesParams {
  count: number
  speed: number
  size: number
  bloomGain: number      // how much they expand when blooming
  bloomDecay: number     // 0..1 per frame
  reactToObstacles: boolean
  trail: number
}

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
  | { kind: 'worms'; values: WormsParams }
  | { kind: 'spores'; values: SporesParams }
  | { kind: 'psychedelic'; values: PsychedelicParams }
  | { kind: 'mandala'; values: MandalaParams }
  | { kind: 'fractal'; values: FractalParams }
  | { kind: 'mathcurve'; values: MathCurveParams }

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

/** A sense source = a string read by readSense().
 *  Built-ins:  'hand.index.y' | 'hand.index.x' | 'hand.palm.y' | 'hand.pinch' | 'hand.openness'
 *              'audio.level' | 'audio.bass' | 'audio.mid' | 'audio.high'
 *              'light'
 *              'midi.mod' | 'midi.cc<N>' (e.g. 'midi.cc1') | 'midi.note<N>' (e.g. 'midi.note60')
 *              'midi.notes.any' (max velocity of all currently-on notes)
 */
export type SenseSource = string

export interface SenseBinding {
  id?: string            // optional UI key
  source: SenseSource
  target: string         // dotted path inside organism.values OR visual.*
  range: [number, number]
  invert?: boolean
}

export interface SenseConfig {
  hands: boolean
  audio: boolean
  light: boolean
  midi?: boolean
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

export type ContentType = 'organism' | 'video' | 'image' | 'webcam'

export interface ShapeContent {
  type: ContentType
  /** URL for video/image (blob: or http:). Ignored for organism/webcam. */
  src?: string
  /** Display name (filename for uploads) */
  label?: string
  /** Opacity 0..1 within this zone */
  opacity?: number
  /** For type='organism': if set, this zone runs its OWN organism instance instead of mirroring the scene's main organism. */
  organismKind?: OrganismKind
  /** Custom params for this zone's organism (defaults applied if absent). */
  organismValues?: Record<string, number>
  /** Optional palette override per zone. */
  organismPalette?: Palette
}

export type ShapeKind = 'quad' | 'polygon'

export interface MappingShape {
  id: string
  name: string
  /** 'quad' = 4 corners with perspective inverse-bilinear warp.
   *  'polygon' = N points polygon mask (no warp, just shape clip + bbox UV). */
  kind?: ShapeKind
  /** Used when kind === 'quad' (default) */
  corners: [Vec2, Vec2, Vec2, Vec2]
  /** Used when kind === 'polygon' — list of vertices in canvas 0..1 space, CCW order. */
  points?: Vec2[]
  /** 0..1 — how much to smooth the polygon with Catmull-Rom subdivision (polygon kind only). */
  smooth?: number
  /** Rotation in radians around the shape's centroid (applied at render time only, points stay clean) */
  rotation?: number
  source: SourceRect
  enabled: boolean
  content?: ShapeContent
}

export interface MappingConfig {
  enabled: boolean
  corners: [Vec2, Vec2, Vec2, Vec2]
  shapes?: MappingShape[]
  selectedShape?: number
  edgeBlend: {
    left: number; right: number; top: number; bottom: number; gamma: number
  }
  testPattern?: TestPattern
  /** AR scoping: when true, the fullscreen AR webcam background is hidden — webcam only appears INSIDE zones that have content.type === 'webcam'. */
  arClipToZones?: boolean
  /** Mask all webcam content with SelfieSegmenter silhouette → only the body shows, environment is transparent. */
  arMaskBody?: boolean
}

export type ObstacleKind = 'circle' | 'polygon' | 'hand' | 'silhouette' | 'pose' | 'tracker'
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
  /** 0..1 — how much mic FFT (bass→vol, high→cutoff) modulates this voice */
  audioReactivity?: number
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
  /** for pose: which joints to use (MediaPipe indices) + per-joint radius */
  pose?: { joints: number[]; radius: number }
  /** for tracker: HSV target color + tolerance + radius. Position auto-updated by color tracker. */
  tracker?: { h: number; s: number; v: number; tolerance: number; radius: number; label?: string }
  /** visual hint on stage when overlay is on */
  visible: boolean
  /** sonification (optional) */
  sound?: SoundConfig
}

export interface FlowField {
  enabled: boolean
  /** angle in radians (0 = right, π/2 = down, π = left, 3π/2 = up) */
  angle: number
  /** 0..3 — magnitude of the directional push */
  strength: number
  /** 0..2 — additional Perlin-style swirl on top of the base direction */
  turbulence: number
}

export const defaultFlow = (): FlowField => ({
  enabled: false, angle: 0, strength: 0.6, turbulence: 0.2,
})

/** Inline reference to keep this file the single source of truth without circular imports. */
export interface TimelineKeyframe { t: number; v: number | string; easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'spring' | 'step' }
export interface TimelineTrack {
  id: string; path: string; label: string; color: string
  easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'spring' | 'step'
  keyframes: TimelineKeyframe[]
}
export interface TimelineConfig { duration: number; loop: boolean; tracks: TimelineTrack[] }

/** Behavior modifier — loose-typed here to avoid circular deps with engine/Modifiers.ts */
export interface SceneModifier {
  id: string
  enabled: boolean
  kind: 'vortex' | 'gravityWell' | 'colorCycle' | 'pulseGate' | 'magneticBands'
  [k: string]: any
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
  flow?: FlowField
  timeline?: TimelineConfig
  modifiers?: SceneModifier[]
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
  if (kind === 'pose') base.pose = { joints: [15, 16, 11, 12], radius: 0.08 }  // wrists + shoulders
  if (kind === 'tracker') base.tracker = { h: 0, s: 0.7, v: 0.7, tolerance: 0.18, radius: 0.1 }
  base.sound = { enabled: false, note: 'auto', waveform: 'sine', volume: 0.5, density: true, cutoff: 2000, audioReactivity: 0 }
  return base
}

export const defaultShape = (i = 0, kind: ShapeKind = 'quad'): MappingShape => {
  const base: MappingShape = {
    id: `shape-${Date.now().toString(36)}-${i}`,
    name: `Zone ${i + 1}`,
    kind,
    corners: [
      { x: 0.1 + i * 0.05, y: 0.1 + i * 0.05 },
      { x: 0.9 + i * 0.05, y: 0.1 + i * 0.05 },
      { x: 0.9 + i * 0.05, y: 0.9 + i * 0.05 },
      { x: 0.1 + i * 0.05, y: 0.9 + i * 0.05 },
    ],
    source: { x: 0, y: 0, w: 1, h: 1 },
    enabled: true,
    content: { type: 'organism', opacity: 1 },
  }
  if (kind === 'polygon') {
    // Default = 6-sided polygon (hexagon)
    const cx = 0.5 + i * 0.05, cy = 0.5 + i * 0.05, r = 0.3
    base.points = Array.from({ length: 6 }, (_, k) => {
      const a = (k / 6) * Math.PI * 2 - Math.PI / 2
      return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }
    })
  }
  return base
}
