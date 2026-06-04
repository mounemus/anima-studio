/**
 * Obstacle force solver — shared by all organism types.
 * Converts (x, y, aspect) → force vector (fx, fy) + kill flag.
 * Coordinates are in world space (x ∈ [-aspect, aspect], y ∈ [-1, 1]).
 *
 * Obstacle definition is normalized 0..1 in canvas space (top-left origin).
 * We convert at solve time.
 */
import type { Obstacle } from '../types/scene'
import { senseBus } from '../senses/SenseBus'
import { trackerStates } from './ColorTracker'

const tmp = { fx: 0, fy: 0, kill: false, bounceNx: 0, bounceNy: 0, hit: false }

/** Per-obstacle hit counter for sonification. Reset by resetCounters(), incremented when an agent is inside. */
export const obstacleCounters = new Map<string, number>()
export function resetCounters() {
  obstacleCounters.clear()
}
function bumpCounter(id: string) {
  obstacleCounters.set(id, (obstacleCounters.get(id) ?? 0) + 1)
}

/** Convert normalized canvas point (0..1, top-left origin) to world (x ∈ [-aspect, aspect], y ∈ [-1, 1]) */
function toWorldX(nx: number, aspect: number): number { return (nx - 0.5) * 2 * aspect }
function toWorldY(ny: number): number { return -(ny - 0.5) * 2 }
function toWorldR(nr: number, aspect: number): number { return nr * 2 * Math.max(1, aspect) }

/** Returns force to apply at point (x,y) in world space + kill flag */
export function solveObstacles(
  x: number,
  y: number,
  aspect: number,
  obstacles: Obstacle[] | undefined,
  silhouetteMask: SilhouetteMask | null,
): { fx: number; fy: number; kill: boolean; bounceNx: number; bounceNy: number; hit: boolean } {
  tmp.fx = 0; tmp.fy = 0; tmp.kill = false; tmp.bounceNx = 0; tmp.bounceNy = 0; tmp.hit = false
  if (!obstacles || obstacles.length === 0) return tmp
  for (const o of obstacles) {
    if (!o.enabled) continue
    applyObstacle(o, x, y, aspect, silhouetteMask)
  }
  return tmp
}

function applyObstacle(o: Obstacle, x: number, y: number, aspect: number, mask: SilhouetteMask | null) {
  if (o.kind === 'circle' && o.circle) {
    const cx = toWorldX(o.circle.cx, aspect)
    const cy = toWorldY(o.circle.cy)
    const r = toWorldR(o.circle.r, aspect)
    const m = toWorldR(o.margin, aspect)
    const dx = x - cx, dy = y - cy
    const d = Math.hypot(dx, dy)
    const total = r + m
    if (d < total) {
      const inside = d < r
      const t = inside ? 1 : 1 - (d - r) / m  // 0..1
      if (inside) bumpCounter(o.id)
      pushForce(o, dx, dy, d, t, inside)
    }
  } else if (o.kind === 'polygon' && o.polygon) {
    const pts = o.polygon.points
    // Bounding box for cheap reject
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of pts) {
      const wx = toWorldX(p.x, aspect), wy = toWorldY(p.y)
      if (wx < minX) minX = wx
      if (wy < minY) minY = wy
      if (wx > maxX) maxX = wx
      if (wy > maxY) maxY = wy
    }
    const m = toWorldR(o.margin, aspect)
    if (x < minX - m || x > maxX + m || y < minY - m || y > maxY + m) return
    // Distance to polygon edges
    let minDist = Infinity, nx = 0, ny = 0
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length]
      const ax = toWorldX(a.x, aspect), ay = toWorldY(a.y)
      const bx = toWorldX(b.x, aspect), by = toWorldY(b.y)
      const ex = bx - ax, ey = by - ay
      const len2 = ex * ex + ey * ey
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / Math.max(1e-6, len2)))
      const px = ax + t * ex, py = ay + t * ey
      const dx = x - px, dy = y - py
      const d = Math.hypot(dx, dy)
      if (d < minDist) { minDist = d; nx = dx / Math.max(1e-6, d); ny = dy / Math.max(1e-6, d) }
    }
    const inside = pointInPolygon(x, y, pts, aspect)
    if (inside || minDist < m) {
      const t = inside ? 1 : 1 - minDist / m
      if (inside) bumpCounter(o.id)
      pushForce(o, nx, ny, 1, t, inside)
    }
  } else if (o.kind === 'hand' && o.hand) {
    if (!senseBus.hands.detected) return
    const src = o.hand.source === 'index' ? senseBus.hands.indexTip : senseBus.hands.palm
    const cx = toWorldX(src.x, aspect)
    const cy = toWorldY(src.y)
    const r = toWorldR(o.hand.radius, aspect)
    const m = toWorldR(o.margin, aspect)
    const dx = x - cx, dy = y - cy
    const d = Math.hypot(dx, dy)
    const total = r + m
    if (d < total) {
      const inside = d < r
      const t = inside ? 1 : 1 - (d - r) / m
      if (inside) bumpCounter(o.id)
      pushForce(o, dx, dy, d, t, inside)
    }
  } else if (o.kind === 'tracker' && o.tracker) {
    const state = trackerStates.get(o.id)
    if (!state || state.confidence < 0.1) return
    const cx = toWorldX(state.x, aspect)
    const cy = toWorldY(state.y)
    const r = toWorldR(o.tracker.radius, aspect)
    const m = toWorldR(o.margin, aspect)
    const dx = x - cx, dy = y - cy
    const d = Math.hypot(dx, dy)
    const total = r + m
    if (d < total) {
      const inside = d < r
      const t = inside ? 1 : 1 - (d - r) / m
      if (inside) bumpCounter(o.id)
      pushForce(o, dx, dy, d, t * state.confidence, inside)
    }
  } else if (o.kind === 'pose' && o.pose && senseBus.pose.detected) {
    const r = toWorldR(o.pose.radius, aspect)
    const m = toWorldR(o.margin, aspect)
    const total = r + m
    // Check against each enabled joint
    for (const ji of o.pose.joints) {
      const j = senseBus.pose.landmarks[ji]
      if (!j || j.vis < 0.3) continue
      const cx = toWorldX(j.x, aspect)
      const cy = toWorldY(j.y)
      const dx = x - cx, dy = y - cy
      const d = Math.hypot(dx, dy)
      if (d < total) {
        const inside = d < r
        const t = inside ? 1 : 1 - (d - r) / m
        if (inside) bumpCounter(o.id)
        pushForce(o, dx, dy, d, t, inside)
      }
    }
  } else if (o.kind === 'silhouette' && mask) {
    // Sample mask at this world position (canvas-normalized 0..1)
    const nx = (x / aspect) * 0.5 + 0.5
    const ny = 0.5 - y * 0.5
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return
    const invert = !!o.silhouette?.invert
    const inside = mask.isPersonAt(nx, ny) !== invert
    if (inside) {
      // 8-direction Sobel-style gradient with a wider kernel so the normal
      // estimate is stable enough for bounce. The original 1.5px kernel was
      // too tight — agents deep in the body silhouette got a (0,0) normal
      // and never received any push, looking like "the bounce doesn't work".
      const eps = 4 / mask.w
      const sample = (sx: number, sy: number) => (mask.isPersonAt(sx, sy) !== invert) ? 1 : 0
      const l  = sample(nx - eps, ny);          const r  = sample(nx + eps, ny)
      const u  = sample(nx, ny - eps);          const d  = sample(nx, ny + eps)
      const nl = sample(nx - eps, ny - eps);    const nr = sample(nx + eps, ny - eps)
      const sl = sample(nx - eps, ny + eps);    const sr = sample(nx + eps, ny + eps)
      // Sobel : convention matches the original 4-neighbor version — gx > 0
      // when the *outside* of the obstacle is to the LEFT of the agent (so
      // pushForce receives the push direction directly without resigning).
      // Same for gy (positive = outside is upward in mask coords, which the
      // existing -gy flip in the pushForce call converts to world space).
      let gx = (nl + 2*l + sl) - (nr + 2*r + sr)
      let gy = (nl + 2*u + nr) - (sl + 2*d + sr)
      let len = Math.hypot(gx, gy)
      // Deep-inside fallback: if no gradient is detected (the agent is far
      // from any edge), spiral outward to find the nearest "outside" pixel
      // and push toward it. Without this, agents stuck in the middle of the
      // silhouette never escape, which is exactly the "force pas assez" bug.
      if (len < 1e-3) {
        let found = false
        for (let ring = 2; ring <= 32 && !found; ring += 2) {
          const stepEps = ring / mask.w
          for (let a = 0; a < 8; a++) {
            const ang = (a / 8) * Math.PI * 2
            const sx = nx + Math.cos(ang) * stepEps
            const sy = ny + Math.sin(ang) * stepEps
            if (sx < 0 || sx > 1 || sy < 0 || sy > 1) continue
            if (sample(sx, sy) === 0) {
              // Outside-of-zone pixel found at angle `ang` from the agent.
              // Push direction = same direction the spiral search probed,
              // so (gx, gy) literally equals (cos ang, sin ang) — pushForce
              // applies it directly (with the standard -gy flip for world y).
              gx = Math.cos(ang); gy = Math.sin(ang)
              len = 1; found = true; break
            }
          }
        }
        if (!found) return  // truly trapped — give up this frame
      }
      bumpCounter(o.id)
      // Note: mask y axis grows downward; world y grows upward → flip y normal
      pushForce(o, gx / len, -gy / len, 1, 1, true)
    }
  }
}

function pushForce(o: Obstacle, nx: number, ny: number, d: number, t: number, inside: boolean) {
  const dn = Math.max(1e-4, d)
  const nxN = d > 1 ? nx : nx / dn
  const nyN = d > 1 ? ny : ny / dn
  const k = o.strength * t
  if (o.interaction === 'avoid') {
    tmp.fx += nxN * k * 3.0
    tmp.fy += nyN * k * 3.0
    tmp.hit = tmp.hit || inside
  } else if (o.interaction === 'attract') {
    tmp.fx -= nxN * k * 2.0
    tmp.fy -= nyN * k * 2.0
  } else if (o.interaction === 'bounce') {
    if (inside) {
      tmp.bounceNx += nxN
      tmp.bounceNy += nyN
      tmp.hit = true
      // 12× multiplier (was 5×) — silhouette's coarse mask + per-organism
      // damping (e.g. Cells scales obstacle force by 0.2 by default) was
      // eating most of the bounce. Higher base lets the user dial the
      // visible behavior with the regular Force slider 0..2.
      tmp.fx += nxN * k * 12.0
      tmp.fy += nyN * k * 12.0
    }
  } else if (o.interaction === 'kill') {
    if (inside) tmp.kill = true
  }
}

function pointInPolygon(x: number, y: number, pts: { x: number; y: number }[], aspect: number): boolean {
  // ray casting in world coords (we re-convert pts to world)
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = toWorldX(pts[i].x, aspect), yi = toWorldY(pts[i].y)
    const xj = toWorldX(pts[j].x, aspect), yj = toWorldY(pts[j].y)
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / Math.max(1e-6, yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

// ============ Silhouette mask ============

export interface SilhouetteMask {
  w: number
  h: number
  data: Uint8Array            // 1 byte per pixel, 255 = person, 0 = background
  isPersonAt(nx: number, ny: number): boolean
}

export function createMask(w: number, h: number): SilhouetteMask {
  const data = new Uint8Array(w * h)
  return {
    w, h, data,
    isPersonAt(nx, ny) {
      const ix = Math.max(0, Math.min(w - 1, Math.floor(nx * w)))
      const iy = Math.max(0, Math.min(h - 1, Math.floor(ny * h)))
      return data[iy * w + ix] > 127
    },
  }
}
