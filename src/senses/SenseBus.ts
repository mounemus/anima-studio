/**
 * SenseBus — shared live values updated at 60+ Hz by sensors,
 * read directly by the Engine. Lives outside React state to avoid re-renders.
 */
export interface HandLandmark { x: number; y: number; z: number }

export interface HandData {
  detected: boolean
  // normalized 0..1 in clip space (origin top-left) — x is ALREADY mirrored
  // to match the visually-flipped webcam (matches what the user sees).
  indexTip: { x: number; y: number; z: number }
  palm: { x: number; y: number; z: number }
  pinch: number        // 0..1 — 0 = open, 1 = pinched
  openness: number     // 0..1 hand openness
  /** Full 21 MediaPipe hand landmarks. Same mirrored-x convention as indexTip/palm.
   *  Indices: 0=wrist, 1-4=thumb (CMC,MCP,IP,TIP), 5-8=index, 9-12=middle,
   *  13-16=ring, 17-20=pinky. */
  landmarks: HandLandmark[]
}

export interface AudioData {
  level: number        // 0..1 RMS
  bass: number         // 0..1
  mid: number          // 0..1
  high: number         // 0..1
  spectrum: Float32Array  // raw FFT 0..1
}

export interface LightData {
  brightness: number   // 0..1
  warmth: number       // 0..1 (red-blue tilt)
}

export interface MidiData {
  available: boolean
  device: string
  /** 0..1 normalized values for each CC */
  cc: Float32Array
  /** 0..1 velocity (0 = off) per note */
  notes: Float32Array
  /** mod wheel CC1 mirrored for convenience */
  mod: number
}

/** MediaPipe Pose landmark — normalized 0..1 (origin top-left), z relative to hips */
export interface PoseLandmark { x: number; y: number; z: number; vis: number }

export interface PoseData {
  detected: boolean
  /** 33 landmarks. Indices: 0=nose, 11/12=shoulders, 13/14=elbows, 15/16=wrists,
   *  23/24=hips, 25/26=knees, 27/28=ankles, 31/32=feet */
  landmarks: PoseLandmark[]
}

export const senseBus = {
  hands: {
    detected: false,
    indexTip: { x: 0.5, y: 0.5, z: 0 },
    palm: { x: 0.5, y: 0.5, z: 0 },
    pinch: 0,
    openness: 0.5,
    // Pre-allocated 21-entry buffer reused frame-to-frame (no GC pressure)
    landmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 })),
  } as HandData,
  audio: {
    level: 0, bass: 0, mid: 0, high: 0,
    spectrum: new Float32Array(64),
  } as AudioData,
  light: { brightness: 0.5, warmth: 0.5 } as LightData,
  midi: {
    available: false,
    device: '',
    cc: new Float32Array(128),
    notes: new Float32Array(128),
    mod: 0,
  } as MidiData,
  pose: {
    detected: false,
    landmarks: Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, vis: 0 })),
  } as PoseData,
}

/** MediaPipe pose joint indices, named for readability. */
export const JOINT = {
  NOSE: 0,
  LEFT_EYE: 2, RIGHT_EYE: 5,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_FOOT: 31, RIGHT_FOOT: 32,
} as const

export const JOINT_LABELS: Record<number, string> = {
  0: 'Tête', 11: 'Épaule G', 12: 'Épaule D',
  13: 'Coude G', 14: 'Coude D', 15: 'Poignet G', 16: 'Poignet D',
  23: 'Hanche G', 24: 'Hanche D', 25: 'Genou G', 26: 'Genou D',
  27: 'Cheville G', 28: 'Cheville D', 31: 'Pied G', 32: 'Pied D',
}

export type SenseSource = string

export function readSense(path: SenseSource): number {
  switch (path) {
    case 'hand.index':
    case 'hand.index.y': return senseBus.hands.indexTip.y
    case 'hand.index.x': return senseBus.hands.indexTip.x
    case 'hand.palm':
    case 'hand.palm.y': return senseBus.hands.palm.y
    case 'hand.palm.x': return senseBus.hands.palm.x
    case 'hand.pinch': return senseBus.hands.pinch
    case 'hand.openness': return senseBus.hands.openness
    case 'audio.level': return senseBus.audio.level
    case 'audio.bass': return senseBus.audio.bass
    case 'audio.mid': return senseBus.audio.mid
    case 'audio.high': return senseBus.audio.high
    case 'light': return senseBus.light.brightness
    case 'midi.mod': return senseBus.midi.mod
    case 'midi.notes.any': {
      let m = 0
      for (let i = 0; i < 128; i++) if (senseBus.midi.notes[i] > m) m = senseBus.midi.notes[i]
      return m
    }
    default: {
      // midi.cc<N>  /  midi.note<N>
      const cc = /^midi\.cc(\d{1,3})$/.exec(path)
      if (cc) {
        const n = parseInt(cc[1], 10)
        return n >= 0 && n < 128 ? senseBus.midi.cc[n] : 0
      }
      const note = /^midi\.note(\d{1,3})$/.exec(path)
      if (note) {
        const n = parseInt(note[1], 10)
        return n >= 0 && n < 128 ? senseBus.midi.notes[n] : 0
      }
      // Unknown path : warn ONCE per path so a typo in a binding (e.g. 'midi.cc7x')
      // surfaces in DevTools instead of silently returning 0 forever.
      if (!warnedUnknownSources.has(path)) {
        warnedUnknownSources.add(path)
        console.warn(`[SenseBus] unknown source "${path}" — returning 0. Check your binding source spelling.`)
      }
      return 0
    }
  }
}

// Track-once warnings so a binding with a typo doesn't spam the console.
const warnedUnknownSources = new Set<string>()

/** Pick a numeric value out of a deep object via dotted path. Returns undefined if missing. */
export function getDeepPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj)
}

/** Set a value at a dotted path, creating intermediate objects as needed. Mutates in place. */
export function setDeepPath(obj: any, path: string, value: any): void {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}
