import { describe, it, expect, beforeEach } from 'vitest'
import { solveObstacles, resetCounters, obstacleCounters, type SilhouetteMask } from './Obstacles'

const circle = (interaction: string) => [{
  id: 'o', name: 'o', enabled: true, kind: 'circle', strength: 1, margin: 0.05,
  interaction, circle: { cx: 0.5, cy: 0.5, r: 0.2 },
} as any]

// IMPORTANT : solveObstacles returns a SINGLETON scratch object that is reset on
// every call. Tests must snapshot fields immediately, never hold the reference.
const snap = (x: number, y: number, list: any[], mask: SilhouetteMask | null = null) => {
  const r = solveObstacles(x, y, 1, list, mask)
  return { fx: r.fx, fy: r.fy, kill: r.kill, hit: r.hit, bounceNx: r.bounceNx, bounceNy: r.bounceNy }
}

describe('Obstacles — interactions', () => {
  beforeEach(() => resetCounters())

  it('avoid pushes the agent away from the obstacle center', () => {
    const r = snap(0.2, 0, circle('avoid'))   // agent to the +x side of center (world 0,0)
    expect(r.fx).toBeGreaterThan(0)
    expect(r.hit).toBe(true)
  })

  it('attract pulls the agent toward the center', () => {
    const r = snap(0.2, 0, circle('attract'))
    expect(r.fx).toBeLessThan(0)
  })

  it('bounce produces a strong extraction force + a surface normal', () => {
    const r = snap(0.1, 0, circle('bounce'))
    expect(Math.abs(r.fx)).toBeGreaterThan(0)
    expect(r.hit).toBe(true)
  })

  it('kill flags the agent when inside', () => {
    const r = snap(0.1, 0, circle('kill'))
    expect(r.kill).toBe(true)
  })

  it('produces no force when the agent is far outside', () => {
    const r = snap(0.95, 0, circle('avoid'))
    expect(r.fx).toBe(0)
    expect(r.fy).toBe(0)
    expect(r.hit).toBe(false)
  })

  it('returns zero for empty / undefined obstacle lists', () => {
    expect(snap(0, 0, [])).toMatchObject({ fx: 0, fy: 0, kill: false })
    expect(snap(0, 0, undefined as any)).toMatchObject({ fx: 0, fy: 0 })
  })

  it('skips disabled obstacles', () => {
    const r = snap(0.1, 0, [{ ...circle('avoid')[0], enabled: false }])
    expect(r.fx).toBe(0)
    expect(r.hit).toBe(false)
  })

  it('bumps the per-obstacle counter when an agent is inside', () => {
    resetCounters()
    snap(0, 0, circle('avoid'))
    expect(obstacleCounters.get('o')).toBeGreaterThanOrEqual(1)
  })
})

describe('Obstacles — silhouette gradient + deep-inside fallback', () => {
  // Synthetic 100x100 person rectangle at canvas (0.3..0.7) × (0.2..0.8).
  function makeMask(): SilhouetteMask {
    const w = 100, h = 100
    const data = new Uint8Array(w * h)
    for (let y = 20; y < 80; y++) for (let x = 30; x < 70; x++) data[y * w + x] = 255
    return {
      w, h, data,
      isPersonAt(nx, ny) {
        const ix = Math.max(0, Math.min(w - 1, Math.floor(nx * w)))
        const iy = Math.max(0, Math.min(h - 1, Math.floor(ny * h)))
        return data[iy * w + ix] > 127
      },
    }
  }
  const silObs = [{ id: 's', name: 's', enabled: true, kind: 'silhouette', strength: 2, margin: 0.05, interaction: 'bounce', silhouette: { invert: false } } as any]

  it('pushes OUT toward the nearest edge from each side', () => {
    const mask = makeMask()
    // World coords: body x∈(-0.4,0.4), y∈(-0.6,0.6)
    expect(snap(0.35, 0, silObs, mask).fx).toBeGreaterThan(0)   // right edge → +x
    expect(snap(-0.35, 0, silObs, mask).fx).toBeLessThan(0)     // left edge  → -x
    expect(snap(0, 0.55, silObs, mask).fy).toBeGreaterThan(0)   // top edge   → +y (world up)
    expect(snap(0, -0.55, silObs, mask).fy).toBeLessThan(0)     // bottom     → -y
  })

  it('deep-inside agent still gets a non-zero escape force (spiral fallback)', () => {
    const mask = makeMask()
    const r = snap(0, 0, silObs, mask)   // dead center of the body
    expect(Math.hypot(r.fx, r.fy)).toBeGreaterThan(1)
  })

  it('outside the silhouette → no hit', () => {
    const mask = makeMask()
    expect(snap(0.9, 0, silObs, mask).hit).toBe(false)
  })
})
