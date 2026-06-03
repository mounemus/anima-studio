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
        const r2max = m.radius * m.radius
        for (let i = 0; i < count; i++) {
          const px = positions[i * 3] - c.x
          const py = positions[i * 3 + 1] - c.y
          const d2 = px * px + py * py
          if (d2 > r2max) continue
          const fall = 1 - Math.sqrt(d2) / m.radius
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
        // beat function: 1 at the pulse, ~0 elsewhere, with `width` controlling sharpness
        const phase = (t * m.bpm) % 1
        const beat = Math.exp(-Math.pow((phase - 0) / m.width, 2)) + Math.exp(-Math.pow((phase - 1) / m.width, 2))
        if (beat < 0.05) continue
        const k = 1 + (m.intensity - 1) * beat
        for (let i = 0; i < count; i++) {
          velocities[i * 2] *= k
          velocities[i * 2 + 1] *= k
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
