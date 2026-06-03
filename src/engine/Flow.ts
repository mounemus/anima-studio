/**
 * Global flow field — a directional push (wind / current) optionally combined with
 * a low-frequency swirl. Organism updates consult this via the shared `flowState`.
 */
import type { FlowField } from '../types/scene'

export const flowState: { vx: number; vy: number; turbulence: number; enabled: boolean } = {
  vx: 0, vy: 0, turbulence: 0, enabled: false,
}

export function setFlow(f: FlowField | undefined) {
  if (!f || !f.enabled) {
    flowState.enabled = false
    flowState.vx = 0; flowState.vy = 0; flowState.turbulence = 0
    return
  }
  flowState.enabled = true
  flowState.vx = Math.cos(f.angle) * f.strength
  flowState.vy = Math.sin(f.angle) * f.strength
  flowState.turbulence = f.turbulence
}

/** Compute a per-position flow vector (base direction + Perlin-ish swirl). */
export function sampleFlow(x: number, y: number, t: number): { fx: number; fy: number } {
  if (!flowState.enabled) return { fx: 0, fy: 0 }
  let fx = flowState.vx
  let fy = flowState.vy
  if (flowState.turbulence > 0) {
    const k = flowState.turbulence
    fx += Math.sin(x * 2.0 + t * 0.4) * k * 0.6
    fy += Math.cos(y * 2.3 - t * 0.3) * k * 0.6
  }
  return { fx, fy }
}
