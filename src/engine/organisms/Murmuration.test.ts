import { describe, it, expect } from 'vitest'
import { MurmurationOrganism, type MurmurationParams } from './Murmuration'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

const VISUAL: VisualParams = {
  palette: { bg: '#06070d', primary: '#00ffa3', secondary: '#00d4ff', glow: '#7c3aed' },
  bloom: 0.5, feedback: 0.92, blendMode: 'add', texture: null,
}

function makeParams(over: Partial<MurmurationParams> = {}): MurmurationParams {
  return {
    count: 1500, cohesion: 0.4, separation: 1.2, alignment: 1.8, swirl: 0.6,
    speed: 0.9, vision: 0.18, size: 0.015, flapSpeed: 14, flapAmplitude: 0.6,
    predatorResponse: 1.5, depthSpread: 0.6, trail: 0.9, ...over,
  }
}

/** Mean cosine similarity of each bird's velocity with its nearest neighbour.
 *  ~0 = random dust ; →1 = strongly coordinated (real murmuration). */
function coherence(o: MurmurationOrganism): number {
  const n = o.count
  const px = o.positions, vx = o.velocities
  let acc = 0, cnt = 0
  for (let i = 0; i < n; i++) {
    let best = -1, bestD = Infinity
    const xi = px[i * 3], yi = px[i * 3 + 1]
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const dx = px[j * 3] - xi, dy = px[j * 3 + 1] - yi
      const d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = j }
    }
    if (best < 0) continue
    const ax = vx[i * 2], ay = vx[i * 2 + 1]
    const bx = vx[best * 2], by = vx[best * 2 + 1]
    const am = Math.hypot(ax, ay), bm = Math.hypot(bx, by)
    if (am < 1e-6 || bm < 1e-6) continue
    acc += (ax * bx + ay * by) / (am * bm)
    cnt++
  }
  return cnt ? acc / cnt : 0
}

const allFinite = (o: MurmurationOrganism) => {
  const n = o.count
  for (let i = 0; i < n * 3; i++) if (!Number.isFinite(o.positions[i])) return false
  for (let i = 0; i < n * 2; i++) if (!Number.isFinite(o.velocities[i])) return false
  return true
}

function spread(o: MurmurationOrganism) {
  const n = o.count
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const x = o.positions[i * 3], y = o.positions[i * 3 + 1]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  return { w: maxX - minX, h: maxY - minY }
}

describe('Murmuration — topological flocking (Ballerini k-nearest)', () => {
  it('never produces NaN over 600 frames', () => {
    const o = new MurmurationOrganism(makeParams({ count: 800 }), VISUAL)
    o.setAspect(16 / 9)
    for (let f = 0; f < 600; f++) o.update(1 / 60)
    expect(allFinite(o)).toBe(true)
  })

  it('produces STRONG local coordination (not random dust)', () => {
    const o = new MurmurationOrganism(makeParams({ count: 1200 }), VISUAL)
    o.setAspect(16 / 9)
    // warm up so the flock organises
    for (let f = 0; f < 300; f++) o.update(1 / 60)
    const c = coherence(o)
    // real murmuration coordination : neighbours fly largely the same way.
    expect(c).toBeGreaterThan(0.5)
  })

  it('stays cohesive AND spread — neither explodes nor collapses to a point', () => {
    const o = new MurmurationOrganism(makeParams({ count: 1000 }), VISUAL)
    o.setAspect(16 / 9)
    for (let f = 0; f < 400; f++) o.update(1 / 60)
    const { w, h } = spread(o)
    // Not collapsed to a dot…
    expect(w).toBeGreaterThan(0.1)
    expect(h).toBeGreaterThan(0.1)
    // …and not blown outside the visible box (aspect≈1.78, so |x|<~2, |y|<~1.2)
    expect(w).toBeLessThan(2 * (16 / 9) + 1)
    expect(h).toBeLessThan(2 + 1)
  })

  it('does not hang or corrupt at 6000 birds with strong cohesion (anti-freeze)', () => {
    const o = new MurmurationOrganism(makeParams({ count: 6000, cohesion: 2, separation: 0.2 }), VISUAL)
    o.setAspect(16 / 9)
    const t0 = Date.now()
    for (let f = 0; f < 120; f++) o.update(1 / 60)
    const ms = Date.now() - t0
    expect(allFinite(o)).toBe(true)
    // 120 frames of 6000 birds must complete well under a naive-O(N²) budget.
    // (O(N²) here would be ~4.3B ops → many seconds. Bounded scan → sub-second.)
    expect(ms).toBeLessThan(4000)
  })

  it('predator (hand) does not fragment the flock into NaN or explosion', () => {
    const o = new MurmurationOrganism(makeParams({ count: 1000, predatorResponse: 3 }), VISUAL)
    o.setAspect(16 / 9)
    for (let f = 0; f < 200; f++) o.update(1 / 60)
    // simulate a pinched hand sweeping through the flock
    senseBus.hands.detected = true
    senseBus.hands.pinch = 1
    for (let f = 0; f < 200; f++) {
      senseBus.hands.indexTip.x = 0.3 + (f / 200) * 0.4
      senseBus.hands.indexTip.y = 0.5
      o.update(1 / 60)
    }
    senseBus.hands.detected = false
    expect(allFinite(o)).toBe(true)
    const { w, h } = spread(o)
    expect(w).toBeLessThan(2 * (16 / 9) + 1)
    expect(h).toBeLessThan(2 + 1)
  })
})
