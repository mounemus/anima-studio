/** Catmull-Rom subdivision: turn a sparse polygon into a smooth closed curve. */
import type { Vec2 } from '../types/scene'

/**
 * Generates a smoothed closed polygon by subdividing each segment with N samples
 * using uniform Catmull-Rom interpolation. smoothness 0 = original points, 1 = max smoothing.
 */
export function smoothPolygon(pts: Vec2[], smoothness: number): Vec2[] {
  if (smoothness <= 0 || pts.length < 3) return pts
  const N = pts.length
  const samplesPerSegment = Math.max(2, Math.round(2 + smoothness * 8))
  const out: Vec2[] = []
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % N]
    const p3 = pts[(i + 2) % N]
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment
      const tt = t * t, ttt = tt * t
      // Centripetal-ish: just uniform Catmull-Rom for simplicity
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tt + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * ttt)
      const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tt + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * ttt)
      // Blend the smoothed point with the original at low smoothness for a finer dial
      const px = p1.x + (x - p1.x) * Math.min(1, smoothness * 1.5)
      const py = p1.y + (y - p1.y) * Math.min(1, smoothness * 1.5)
      out.push({ x: px, y: py })
    }
  }
  return out
}

/** Geometric centroid of a polygon (simple mean — sufficient for translate handle). */
export function centroid(pts: Vec2[]): Vec2 {
  if (pts.length === 0) return { x: 0.5, y: 0.5 }
  let x = 0, y = 0
  for (const p of pts) { x += p.x; y += p.y }
  return { x: x / pts.length, y: y / pts.length }
}

/** Rotate points around a center by angle radians. */
export function rotateAround(pts: Vec2[], center: Vec2, angle: number): Vec2[] {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  return pts.map((p) => ({
    x: center.x + (p.x - center.x) * cos - (p.y - center.y) * sin,
    y: center.y + (p.x - center.x) * sin + (p.y - center.y) * cos,
  }))
}
