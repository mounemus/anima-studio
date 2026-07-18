/**
 * Scalar / signed-distance field library for MORPHOGENESIS STUDIO.
 * Every field is `(x,y,z) => value` ; the iso-surface (value = iso) is meshed by
 * marchingCubes. Primitives are signed distances (negative inside) ; combinators are
 * boolean/blend operators ; domain ops warp space (twist, radial, mirror) ; and there
 * are procedural fields (gyroid/TPMS, voronoï walls, metaballs, noise displacement).
 */
import type { Field } from './marching'

const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

// ── Procedural noise (shared with the sculpt studio's noise types) ──
function h01(i: number, j: number, k: number): number { let h = (i * 374761393 + j * 668265263 + k * 1274126177) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296 }
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf)
  const lp = (a: number, b: number, t: number) => a + (b - a) * t, c = (dx: number, dy: number, dz: number) => h01(xi + dx, yi + dy, zi + dz) * 2 - 1
  const x00 = lp(c(0, 0, 0), c(1, 0, 0), u), x10 = lp(c(0, 1, 0), c(1, 1, 0), u), x01 = lp(c(0, 0, 1), c(1, 0, 1), u), x11 = lp(c(0, 1, 1), c(1, 1, 1), u)
  return lp(lp(x00, x10, v), lp(x01, x11, v), w)
}
export type NoiseType = 'value' | 'fbm' | 'ridged' | 'turbulence' | 'worley'
export function cellular3(x: number, y: number, z: number, second = false): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z); let f1 = 9, f2 = 9
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz
    const fx = cx + h01(cx, cy, cz), fy = cy + h01(cy, cz, cx), fz = cz + h01(cz, cx, cy)
    const ex = fx - x, ey = fy - y, ez = fz - z, d = ex * ex + ey * ey + ez * ez
    if (d < f1) { f2 = f1; f1 = d } else if (d < f2) f2 = d
  }
  return Math.min(1, Math.sqrt(second ? f2 : f1))
}
export function noiseField(type: NoiseType, x: number, y: number, z: number): number {
  if (type === 'fbm') { let a = 0.5, f = 1, s = 0; for (let i = 0; i < 4; i++) { s += a * noise3(x * f, y * f, z * f); f *= 2; a *= 0.5 } return clamp(-1, 1, s * 1.3) }
  if (type === 'ridged') { let a = 0.5, f = 1, s = 0; for (let i = 0; i < 4; i++) { s += a * (1 - 2 * Math.abs(noise3(x * f, y * f, z * f))); f *= 2; a *= 0.5 } return clamp(-1, 1, s) }
  if (type === 'turbulence') { let a = 0.5, f = 1, s = 0; for (let i = 0; i < 4; i++) { s += a * Math.abs(noise3(x * f, y * f, z * f)); f *= 2; a *= 0.5 } return clamp(-1, 1, s * 2 - 0.6) }
  if (type === 'worley') return clamp(-1, 1, cellular3(x, y, z) * 2 - 1)
  return noise3(x, y, z)
}

// ── SDF primitives (negative inside) ──
export const sdSphere = (r: number): Field => (x, y, z) => Math.hypot(x, y, z) - r
export const sdBox = (bx: number, by: number, bz: number): Field => (x, y, z) => { const qx = Math.abs(x) - bx, qy = Math.abs(y) - by, qz = Math.abs(z) - bz; const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0); return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) }
export const sdTorus = (R: number, r: number): Field => (x, y, z) => { const q = Math.hypot(x, z) - R; return Math.hypot(q, y) - r }
export const sdCylinder = (r: number, h: number): Field => (x, y, z) => { const d = Math.hypot(x, z) - r, dy = Math.abs(y) - h; const ox = Math.max(d, 0), oy = Math.max(dy, 0); return Math.min(Math.max(d, dy), 0) + Math.hypot(ox, oy) }
export const sdCapsuleY = (h: number, r: number): Field => (x, y, z) => { const yy = Math.max(-h, Math.min(h, y)); return Math.hypot(x, y - yy, z) - r }

// ── Point-set generators (for metaballs) — different distributions → different silhouettes ──
export type PointShape = 'sphere' | 'column' | 'disc' | 'ring' | 'helix'
function srng(seed: number) { let s = (seed | 0) || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }
export function shapedPoints(shape: PointShape, n: number, spread: number, seed: number, extra = 0.5): [number, number, number][] {
  const r = srng(seed), pts: [number, number, number][] = []
  for (let i = 0; i < n; i++) {
    if (shape === 'column') { const t = i / Math.max(1, n - 1); const a = r() * Math.PI * 2, rr = (0.15 + r() * 0.35) * spread; pts.push([Math.cos(a) * rr, (t - 0.5) * 2 * (0.6 + extra), Math.sin(a) * rr]) }
    else if (shape === 'disc') { const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * spread; pts.push([Math.cos(a) * rr, (r() - 0.5) * 0.28, Math.sin(a) * rr]) }
    else if (shape === 'ring') { const a = (i / n) * Math.PI * 2 + r() * 0.15, rr = spread * (0.85 + r() * 0.2); pts.push([Math.cos(a) * rr, (r() - 0.5) * 0.3 * spread, Math.sin(a) * rr]) }
    else if (shape === 'helix') { const t = i / Math.max(1, n - 1); const a = t * (2 + extra * 6) * Math.PI * 2, rr = spread * (0.25 + t * 0.75); pts.push([Math.cos(a) * rr, (t - 0.5) * 2 * (0.4 + extra), Math.sin(a) * rr]) }
    else { const u = r() * 2 - 1, a = r() * Math.PI * 2, rr = Math.cbrt(r()) * spread, ph = Math.acos(u); pts.push([rr * Math.sin(ph) * Math.cos(a), rr * Math.sin(ph) * Math.sin(a), rr * Math.cos(ph)]) }
  }
  return pts
}

// ── TPMS (triply-periodic minimal surfaces) — bounded to a sphere to make a finite object ──
export const gyroid = (freq: number, thick: number, bound: number): Field => (x, y, z) => { const f = freq; const g = Math.sin(f * x) * Math.cos(f * y) + Math.sin(f * y) * Math.cos(f * z) + Math.sin(f * z) * Math.cos(f * x); const shell = Math.abs(g) - thick; return Math.max(shell, Math.hypot(x, y, z) - bound) }
export const schwarzP = (freq: number, thick: number, bound: number): Field => (x, y, z) => { const f = freq; const g = Math.cos(f * x) + Math.cos(f * y) + Math.cos(f * z); const shell = Math.abs(g) - thick; return Math.max(shell, Math.hypot(x, y, z) - bound) }

// ── Voronoï / cellular WALLS (thin lattice of cell borders) inside a bound ──
export const voronoiWalls = (scale: number, thick: number, bound: number): Field => (x, y, z) => { const w = cellular3(x * scale, y * scale, z * scale, true) - cellular3(x * scale, y * scale, z * scale, false); const wall = w / scale - thick; return Math.max(-wall, Math.hypot(x, y, z) - bound) }

// ── Metaballs : smooth blobby union of points ──
export const metaballs = (pts: [number, number, number][], radius: number): Field => (x, y, z) => { let d = 1e9; for (const p of pts) { const dd = Math.hypot(x - p[0], y - p[1], z - p[2]) - radius; d = smin(d, dd, radius * 0.9) } return d }

// ── Combinators ──
function smin(a: number, b: number, k: number): number { if (k <= 1e-5) return Math.min(a, b); const h = clamp(0, 1, 0.5 + 0.5 * (b - a) / k); return b + (a - b) * h - k * h * (1 - h) }
export const fUnion = (a: Field, b: Field, k = 0): Field => (x, y, z) => smin(a(x, y, z), b(x, y, z), k)
export const fSubtract = (a: Field, b: Field, k = 0): Field => (x, y, z) => { const A = a(x, y, z), B = -b(x, y, z); return k <= 1e-5 ? Math.max(A, B) : -smin(-A, -B, k) }
export const fIntersect = (a: Field, b: Field, k = 0): Field => (x, y, z) => { const A = a(x, y, z), B = b(x, y, z); return k <= 1e-5 ? Math.max(A, B) : -smin(-A, -B, k) }
export const fShell = (a: Field, t: number): Field => (x, y, z) => Math.abs(a(x, y, z)) - t

// ── Displacement : add a noise field to a distance field → organic bumps / relief ──
export const fDisplace = (a: Field, type: NoiseType, amp: number, freq: number): Field => (x, y, z) => a(x, y, z) - amp * noiseField(type, x * freq + 11, y * freq + 3, z * freq + 7)

// ── Domain operations (warp space before sampling) ──
export const opTwist = (a: Field, k: number): Field => (x, y, z) => { const c = Math.cos(k * y), s = Math.sin(k * y); return a(c * x - s * z, y, s * x + c * z) }
export const opTaper = (a: Field, k: number): Field => (x, y, z) => { const s = clamp(0.05, 3, 1 - k * (y * 0.5)); return a(x / s, y, z / s) * s }
export const opScale = (a: Field, s: number): Field => (x, y, z) => a(x / s, y / s, z / s) * s
export const opMirrorX = (a: Field): Field => (x, y, z) => a(Math.abs(x), y, z)
export const opRadial = (a: Field, n: number): Field => (x, y, z) => { const k = Math.max(1, Math.round(n)); const seg = (Math.PI * 2) / k; let ang = Math.atan2(z, x); ang = ang - seg * Math.round(ang / seg); const r = Math.hypot(x, z); return a(r * Math.cos(ang), y, r * Math.sin(ang)) }
export const opBend = (a: Field, k: number): Field => (x, y, z) => { const c = Math.cos(k * x), s = Math.sin(k * x); return a(x, c * y - s * z, s * y + c * z) }
// Non-uniform stretch → turns a spherical field into a column / disc / ellipsoid.
export const opStretch = (a: Field, sx: number, sy: number, sz: number): Field => { const m = Math.min(sx, sy, sz); return (x, y, z) => a(x / sx, y / sy, z / sz) * m }
// Relief : keep only a slab (thin in Z) → the field reads as a wall panel, not a ball.
export const fReliefSlab = (a: Field, thick: number, bound: number): Field => fIntersect(a, sdBox(bound, bound, thick), 0.03)

// Phyllotaxis point set (golden-angle spiral on a sphere/disc) — for Fractal Bloom / metaballs.
export function phyllotaxis(n: number, spread: number, rise: number): [number, number, number][] {
  const ga = Math.PI * (3 - Math.sqrt(5)), out: [number, number, number][] = []
  for (let i = 0; i < n; i++) { const t = i / Math.max(1, n - 1); const r = spread * Math.sqrt(t); const a = i * ga; out.push([Math.cos(a) * r, (t - 0.5) * 2 * rise, Math.sin(a) * r]) }
  return out
}
