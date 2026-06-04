/**
 * Behavior Modifiers — orthogonal effects layered on top of any organism.
 *
 * The 6 base organisms (Boids, Particles, Tendrils, Cells, Worms, Spores) provide
 * the BASE behavior (movement, geometry, rendering). Modifiers add cross-cutting
 * effects that mutate positions / velocities AFTER the organism's own update step.
 *
 * This gives us 6 base × N modifiers worth of variation without rewriting any
 * organism: "Boids + Vortex around hand" or "Spores + Mitosis + Color cycle".
 *
 * Modifiers are pure transformations: they read the agent state and senseBus,
 * mutate positions/velocities in-place. They can be chained.
 *
 * The engine loops through scene.modifiers and applies each one per frame.
 */
import { senseBus } from '../senses/SenseBus'

export type ModifierKind = 'vortex' | 'gravityWell' | 'colorCycle' | 'pulseGate' | 'magneticBands'

export interface ModifierVortex {
  id: string
  enabled: boolean
  kind: 'vortex'
  /** 0..1 normalized stage coordinates, or 'hand' to track the user's index finger. */
  center: { x: number; y: number } | 'hand'
  /** Radians/second rotation magnitude. */
  omega: number
  /** Falloff radius — outside this, no effect. */
  radius: number
  /** Whether attraction is also applied toward the center (negative = repulsion). */
  pull: number
}

export interface ModifierGravityWell {
  id: string
  enabled: boolean
  kind: 'gravityWell'
  /** Multiple wells composed additively. */
  wells: { x: number; y: number; strength: number; radius: number }[]
}

export interface ModifierColorCycle {
  id: string
  enabled: boolean
  kind: 'colorCycle'
  /** Hue cycles per second across the whole palette. */
  speedHz: number
  /** 0..1 — how much hue is shifted (0 = no effect, 1 = full hue rotation). */
  amount: number
}

export interface ModifierPulseGate {
  id: string
  enabled: boolean
  kind: 'pulseGate'
  /** Beat frequency in Hz (0.5 = every 2s, 2 = 4x per second). */
  bpm: number
  /** Speed multiplier on the beat (1 = unchanged, 2 = double on the pulse). */
  intensity: number
  /** 0..1 width of the beat pulse (1 = always on, 0.05 = sharp click). */
  width: number
}

export interface ModifierMagneticBands {
  id: string
  enabled: boolean
  kind: 'magneticBands'
  /** Number of horizontal bands across the screen. */
  bands: number
  /** Push agents toward band centers (positive) or repel from them (negative). */
  strength: number
}

export type Modifier =
  | ModifierVortex
  | ModifierGravityWell
  | ModifierColorCycle
  | ModifierPulseGate
  | ModifierMagneticBands

const newId = () => `mod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export function defaultModifier(kind: ModifierKind): Modifier {
  switch (kind) {
    case 'vortex': return { id: newId(), enabled: true, kind, center: 'hand', omega: 2, radius: 0.5, pull: 0.3 }
    case 'gravityWell': return { id: newId(), enabled: true, kind, wells: [{ x: 0.5, y: 0.5, strength: 1, radius: 0.4 }] }
    case 'colorCycle': return { id: newId(), enabled: true, kind, speedHz: 0.1, amount: 0.5 }
    case 'pulseGate': return { id: newId(), enabled: true, kind, bpm: 1, intensity: 1.5, width: 0.15 }
    case 'magneticBands': return { id: newId(), enabled: true, kind, bands: 4, strength: 0.3 }
  }
}

/** Convert hand coords (0..1 with y inverted) into [-1,1] normalized world coords. */
function handWorldPos(aspect: number): { x: number; y: number } | null {
  const h = senseBus.hands
  if (!h.detected) return null
  return { x: (h.indexTip.x - 0.5) * 2 * aspect, y: -(h.indexTip.y - 0.5) * 2 }
}

/** Apply all enabled modifiers to a flat positions[] (in [-1, 1] world space) and velocities[]. */
export function applyModifiers(
  positions: Float32Array,        // x,y,(z) interleaved at stride 3 (z ignored)
  velocities: Float32Array | null, // x,y interleaved at stride 2 — null = positions-only mode
  count: number,
  dt: number,
  aspect: number,
  modifiers: Modifier[],
): void {
  if (!modifiers.length) return
  const t = performance.now() * 0.001
  for (const m of modifiers) {
    if (!m.enabled) continue
    switch (m.kind) {
      case 'vortex': {
        const c = m.center === 'hand' ? handWorldPos(aspect) : { x: (m.center.x - 0.5) * 2 * aspect, y: -(m.center.y - 0.5) * 2 }
        if (!c) break
        // Guard radius=0 : without it, an agent exactly at the center divides
        // 0/0 → NaN, and NaN positions propagate forever (the agent vanishes
        // permanently). Imported / AI-authored scenes can carry radius=0 even
        // though the UI slider clamps it.
        const radius = Math.max(1e-3, m.radius)
        const r2max = radius * radius
        for (let i = 0; i < count; i++) {
          const px = positions[i * 3] - c.x
          const py = positions[i * 3 + 1] - c.y
          const d2 = px * px + py * py
          if (d2 > r2max) continue
          const fall = 1 - Math.sqrt(d2) / radius
          // Tangential rotation
          const omega = m.omega * fall * dt
          const cos = Math.cos(omega), sin = Math.sin(omega)
          const nx = px * cos - py * sin
          const ny = px * sin + py * cos
          positions[i * 3] = c.x + nx
          positions[i * 3 + 1] = c.y + ny
          // Radial pull
          if (m.pull !== 0 && velocities) {
            const inv = 1 / Math.max(0.001, Math.sqrt(d2))
            velocities[i * 2] -= px * inv * m.pull * fall * dt
            velocities[i * 2 + 1] -= py * inv * m.pull * fall * dt
          }
        }
        break
      }
      case 'gravityWell': {
        if (!velocities) break
        for (const w of m.wells) {
          const cx = (w.x - 0.5) * 2 * aspect
          const cy = -(w.y - 0.5) * 2
          const r2max = w.radius * w.radius
          for (let i = 0; i < count; i++) {
            const dx = cx - positions[i * 3]
            const dy = cy - positions[i * 3 + 1]
            const d2 = dx * dx + dy * dy
            if (d2 > r2max || d2 < 1e-6) continue
            const fall = 1 - Math.sqrt(d2) / w.radius
            const f = w.strength * fall * dt
            const inv = 1 / Math.sqrt(d2)
            velocities[i * 2] += dx * inv * f
            velocities[i * 2 + 1] += dy * inv * f
          }
        }
        break
      }
      case 'pulseGate': {
        if (!velocities) break
        // Guard width=0 : when phase hits exactly 0 or 1, (phase-edge)/0 = 0/0 =
        // NaN → beat=NaN → k=NaN → every velocity becomes NaN permanently.
        const width = Math.max(1e-3, m.width)
        // beat function: 1 at the pulse, ~0 elsewhere, with `width` controlling sharpness
        const phase = (t * m.bpm) % 1
        let beat = Math.exp(-Math.pow((phase - 0) / width, 2)) + Math.exp(-Math.pow((phase - 1) / width, 2))
        if (!Number.isFinite(beat)) beat = 0
        if (beat < 0.05) continue
        const k = 1 + (m.intensity - 1) * beat
        // Cap the velocity magnitude so a high intensity applied across several
        // consecutive frames can't exponentially blow agents off-screen.
        const VMAX = 4
        for (let i = 0; i < count; i++) {
          let vx = velocities[i * 2] * k
          let vy = velocities[i * 2 + 1] * k
          const sp = Math.hypot(vx, vy)
          if (sp > VMAX) { const s = VMAX / sp; vx *= s; vy *= s }
          velocities[i * 2] = vx
          velocities[i * 2 + 1] = vy
        }
        break
      }
      case 'magneticBands': {
        if (!velocities || m.bands < 1) break
        const step = 2 / m.bands  // band height in world Y
        for (let i = 0; i < count; i++) {
          const y = positions[i * 3 + 1]
          // nearest band center: snap to step grid
          const bandIdx = Math.round((y + 1) / step - 0.5)
          const targetY = bandIdx * step + step * 0.5 - 1
          const dy = targetY - y
          velocities[i * 2 + 1] += dy * m.strength * dt
        }
        break
      }
      case 'colorCycle': {
        // colorCycle is purely visual — handled in applyVisual hook below
        break
      }
    }
  }
}

/** Returns a per-frame hue shift to be applied to the palette by the visual pipeline. */
export function getColorCycleShift(modifiers: Modifier[]): number {
  let total = 0
  for (const m of modifiers) {
    if (m.enabled && m.kind === 'colorCycle') {
      total += Math.sin(performance.now() * 0.001 * m.speedHz * 2 * Math.PI) * m.amount * 0.5
    }
  }
  return total
}

/** Rotate a hex color's hue by `shift` (full turn = 1). Saturation/lightness preserved.
 *  Used by the engine loop to apply colorCycle modifiers to scene palettes without
 *  requiring every organism to expose a hue-shift uniform. */
export function rotateHueHex(hex: string, shift: number): string {
  if (!shift) return hex
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 0xff) / 255
  const g = ((n >> 8) & 0xff) / 255
  const b = (n & 0xff) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return hex   // grey — hue undefined
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  h = (h + shift + 1) % 1
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const rr = Math.round(hue2rgb(p, q, h + 1 / 3) * 255)
  const gg = Math.round(hue2rgb(p, q, h) * 255)
  const bb = Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  return '#' + ((rr << 16) | (gg << 8) | bb).toString(16).padStart(6, '0')
}
