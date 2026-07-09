export type OrganismKind = 'boids' | 'particles' | 'tendrils' | 'cells' | 'worms' | 'spores' | 'psychedelic' | 'mandala' | 'fractal' | 'mathcurve' | 'reactiondiffusion' | 'cellularautomata' | 'hilbert' | 'menger' | 'supershape3d' | 'swarm3d' | 'crystal' | 'murmuration' | 'instrument'

export interface InstrumentParams { strings: number; root: number; scale: string; waveSpeed: number; decay: number; size: number; velScale: number; osc: number }
export interface MurmurationParams { count: number; cohesion: number; separation: number; alignment: number; swirl: number; speed: number; vision: number; size: number; flapSpeed: number; flapAmplitude: number; predatorResponse: number; depthSpread: number; trail: number }
export interface ParticleSwarm3DParams { count: number; speed: number; cohesion: number; separation: number; alignment: number; vision: number; bounds: number; pointSize: number; autoOrbitSpeed: number; fov: number; trail: number }
export interface CrystalGrowthParams { maxCubes: number; growthRate: number; cubeSize: number; gridResolution: number; autoOrbitSpeed: number; fov: number; ambient: number; emissive: number }
export interface MengerSpongeParams { depth: number; autoOrbitSpeed: number; fov: number; twistAmount: number; cubeSize: number; ambient: number; bloom: number }
export interface SuperShape3DParams { m1: number; n1: number; n2: number; n3: number; m2: number; n4: number; n5: number; n6: number; resolution: number; scale: number; autoOrbitSpeed: number; fov: number; morphSpeed: number; pointSize: number; wireframe: number }
export type RDPreset = 'spots' | 'coral' | 'mitosis' | 'fingerprint' | 'worms' | 'maze' | 'pulse'
export type CARule = 'conway' | 'highlife' | 'seeds' | 'daedalus' | 'maze' | 'replicator'
export interface ReactionDiffusionParams { preset: RDPreset; F: number; k: number; du: number; dv: number; resolution: number; stepsPerFrame: number; splatSize: number; splatStrength: number; contrast: number }
export interface CellularAutomataParams { rule: CARule; resolution: number; ticksPerSec: number; ageDecay: number; brushSize: number; brushStrength: number; autoReseed: number }
export interface HilbertCurveParams { order: number; scale: number; progress: number; autoProgress: number; rotation: number; thickness: number; handPull: number; showPoints: number; hueAlongCurve: number }

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
  /** Boundary behavior when a particle leaves the visible area.
   *  - 'respawn' (default) : age out + restart from the spawn disc — original behavior
   *  - 'wrap'              : teleport to the opposite edge (toroidal) — for endless rain/snow
   *  - 'kill'              : let them fall out forever (will deplete) */
  boundary?: 'respawn' | 'wrap' | 'kill'
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
  /** Boundary behavior when a cell hits the canvas edge.
   *  - 'bounce'  (default) : soft bounce, halves velocity — original behavior
   *  - 'wrap'              : teleport to the opposite edge (toroidal) */
  boundary?: 'bounce' | 'wrap'
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
  | { kind: 'reactiondiffusion'; values: ReactionDiffusionParams }
  | { kind: 'cellularautomata'; values: CellularAutomataParams }
  | { kind: 'hilbert'; values: HilbertCurveParams }
  | { kind: 'menger'; values: MengerSpongeParams }
  | { kind: 'supershape3d'; values: SuperShape3DParams }
  | { kind: 'murmuration'; values: MurmurationParams }
  | { kind: 'swarm3d'; values: ParticleSwarm3DParams }
  | { kind: 'crystal'; values: CrystalGrowthParams }
  | { kind: 'instrument'; values: InstrumentParams }

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

export type ShapeKind = 'quad' | 'polygon' | 'mesh'

/** Warp mesh : a (cols+1)×(rows+1) grid of control points (canvas 0..1, row-major).
 *  The source texture is subdivided across the grid; dragging interior points bends
 *  it onto curved surfaces (domes, cylinders, corners) that a flat 4-corner quad
 *  can't follow. */
export interface MeshGrid {
  cols: number
  rows: number
  points: Vec2[]
}

export interface MappingShape {
  id: string
  name: string
  /** 'quad' = 4 corners with perspective inverse-bilinear warp.
   *  'polygon' = N points polygon mask (no warp, just shape clip + bbox UV).
   *  'mesh' = subdivided grid warp for curved surfaces. */
  kind?: ShapeKind
  /** Used when kind === 'quad' (default) */
  corners: [Vec2, Vec2, Vec2, Vec2]
  /** Used when kind === 'polygon' — list of vertices in canvas 0..1 space, CCW order. */
  points?: Vec2[]
  /** Used when kind === 'mesh' — subdivided control-point grid. */
  mesh?: MeshGrid
  /** Chroma-key (green screen) : the zone's content is shown only where the LIVE
   *  webcam matches this color (per-pixel), so it sticks to and moves with a
   *  colored object (e.g. a white t-shirt). Pick the color with the pipette.
   *  invert = show everywhere EXCEPT the color. */
  chromaKey?: { h: number; s: number; v: number; tolerance: number; feather: number; invert?: boolean }
  /** Make this zone's OUTLINE a physical obstacle : organisms avoid / are attracted
   *  to / bounce off / are killed by the zone shape (quad or polygon). */
  obstacle?: { interaction: ObstacleInteraction; strength: number; margin: number }
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
  /** for silhouette: threshold + invert + how visible the overlay is on screen */
  silhouette?: {
    invert: boolean
    /** 0..1 — opacity of the visual silhouette overlay on the stage.
     *  0 hides the cyan glow completely while keeping the obstacle physics active. */
    overlayOpacity?: number
    /** When true, skip drawing the overlay entirely (same as opacity 0 but
     *  short-circuits the rAF loop). Physics still apply to organisms. */
    hideOverlay?: boolean
  }
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
  kind: 'vortex' | 'gravityWell' | 'colorCycle' | 'pulseGate' | 'magneticBands' | 'zoneWalls'
  [k: string]: any
}

/** One note of a generated melody. Time + dur are expressed in BEATS (quarter notes). */
export interface MelodyNote {
  /** MIDI note number, 21 (A0) .. 108 (C8). Middle C = 60. */
  note: number
  /** Start time, in beats from melody origin. */
  time: number
  /** Duration in beats. */
  dur: number
  /** Velocity 0..1 (defaults 0.7 if absent). */
  vel?: number
}

export interface Melody {
  /** Beats per minute (40..240). */
  tempo: number
  /** Loop back to 0 when reaching end. */
  loop: boolean
  /** Note list, sorted by `time` ascending. Max 128 notes per validation. */
  notes: MelodyNote[]
  /** Optional metadata for UI display only. */
  key?: string
  scale?: string
  description?: string
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
  melody?: Melody
  notes?: string
  /** Live webcam shader filter for the AR mirror layer. See engine/WebcamFilters. */
  webcamFilter?: WebcamFilterRef
  /** Restrict the whole organism layer to the SelfieSegmenter silhouette.
   *  Independent from webcamFilter — you can have the body filtered AND only
   *  show particles inside the body (or only outside). 'all' = no clipping. */
  organismMask?: {
    mode: 'all' | 'body' | 'background'
    /** 0..1 — soft transition width around the silhouette edge. */
    feather?: number
  }
}

/** Reference into the WebcamFilters module. Kept stringly-typed in the type layer
 *  so scene.ts doesn't import engine code (engine imports scene types). */
export interface WebcamFilterRef {
  kind: string
  intensity: number
  param0?: number
  param1?: number
  color?: string
  audioReact?: number
  poseReact?: number
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

/** Build an evenly-spaced control-point grid spanning ~[0.15, 0.85] of the canvas. */
export const defaultMeshGrid = (cols = 3, rows = 3, off = 0): MeshGrid => {
  const x0 = 0.15 + off * 0.03, x1 = 0.85 + off * 0.03
  const y0 = 0.15 + off * 0.03, y1 = 0.85 + off * 0.03
  const points: Vec2[] = []
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      points.push({ x: x0 + (x1 - x0) * (c / cols), y: y0 + (y1 - y0) * (r / rows) })
    }
  }
  return { cols, rows, points }
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
  } else if (kind === 'mesh') {
    base.mesh = defaultMeshGrid(3, 3, i)
  }
  return base
}
