/**
 * SenseBus — shared live values updated at 60+ Hz by sensors,
 * read directly by the Engine. Lives outside React state to avoid re-renders.
 */
export interface HandData {
  detected: boolean
  // normalized 0..1 in clip space (origin top-left)
  indexTip: { x: number; y: number; z: number }
  palm: { x: number; y: number; z: number }
  pinch: number        // 0..1 — 0 = open, 1 = pinched
  openness: number     // 0..1 hand openness
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

export const senseBus = {
  hands: {
    detected: false,
    indexTip: { x: 0.5, y: 0.5, z: 0 },
    palm: { x: 0.5, y: 0.5, z: 0 },
    pinch: 0,
    openness: 0.5,
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
}

export type SenseSource = string

export function readSense(path: SenseSource): number {
  switch (path) {
    case 'hand.index': return senseBus.hands.indexTip.y
    case 'hand.palm': return senseBus.hands.palm.y
    case 'hand.pinch': return senseBus.hands.pinch
    case 'audio.level': return senseBus.audio.level
    case 'audio.bass': return senseBus.audio.bass
    case 'audio.mid': return senseBus.audio.mid
    case 'audio.high': return senseBus.audio.high
    case 'light': return senseBus.light.brightness
    default: return 0
  }
}
