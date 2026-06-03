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
    // Sample mask at this world position
    const nx = (x / aspect) * 0.5 + 0.5            // 0..1
    const ny = 0.5 - y * 0.5                        // 0..1
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return
    const inside = mask.isPersonAt(nx, ny) !== !!o.silhouette?.invert
    if (inside) {
      // Compute approximate normal via mask gradient
      const eps = 1.5 / mask.w
      const left = mask.isPersonAt(nx - eps, ny) ? 1 : 0
      const right = mask.isPersonAt(nx + eps, ny) ? 1 : 0
      const up = mask.isPersonAt(nx, ny - eps) ? 1 : 0
      const down = mask.isPersonAt(nx, ny + eps) ? 1 : 0
      const gx = left - right
      const gy = up - down
      const len = Math.max(1e-3, Math.hypot(gx, gy))
      bumpCounter(o.id)
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
      // also a strong push to extract
      tmp.fx += nxN * k * 5.0
      tmp.fy += nyN * k * 5.0
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
