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
// Radial symmetry = UNION of N rotated copies of the field (min of the field sampled at N
// rotations of the query point). Correct "repeat" — never fragments point-based fields
// (the old domain-fold only kept one sector, which shattered metaballs/bloom).
export const opRadial = (a: Field, n: number): Field => { const k = Math.max(1, Math.round(n)); const seg = (Math.PI * 2) / k; return (x, y, z) => { const r = Math.hypot(x, z), ang = Math.atan2(z, x); let best = 1e9; for (let i = 0; i < k; i++) { const aa = ang + i * seg; const v = a(r * Math.cos(aa), y, r * Math.sin(aa)); if (v < best) best = v } return best } }
export const opBend = (a: Field, k: number): Field => (x, y, z) => { const c = Math.cos(k * x), s = Math.sin(k * x); return a(x, c * y - s * z, s * y + c * z) }
// Non-uniform stretch → turns a spherical field into a column / disc / ellipsoid.
export const opStretch = (a: Field, sx: number, sy: number, sz: number): Field => { const m = Math.min(sx, sy, sz); return (x, y, z) => a(x / sx, y / sy, z / sz) * m }
// Relief : keep only a slab (thin in Z) → the field reads as a wall panel, not a ball.
export const fReliefSlab = (a: Field, thick: number, bound: number): Field => fIntersect(a, sdBox(bound, bound, thick), 0.03)

/** Mandelbulb — distance-estimated 3D fractal (power p, iteration count). Bounded field. */
export const mandelbulb = (power: number, iters: number, scale: number): Field => (X, Y, Z) => {
  const x = X / scale, y = Y / scale, z = Z / scale
  let zx = x, zy = y, zz = z, dr = 1, r = 0
  for (let i = 0; i < iters; i++) {
    r = Math.hypot(zx, zy, zz)
    if (r > 2) break
    const theta = Math.acos(clamp(-1, 1, zz / (r || 1e-9))) * power
    const phi = Math.atan2(zy, zx) * power
    const zr = Math.pow(r, power)
    dr = Math.pow(r, power - 1) * power * dr + 1
    const st = Math.sin(theta)
    zx = zr * st * Math.cos(phi) + x; zy = zr * st * Math.sin(phi) + y; zz = zr * Math.cos(theta) + z
  }
  return (0.5 * Math.log(r || 1e-9) * r / dr) * scale
}

/** Diffusion-Limited Aggregation — particles random-walk and stick to a growing cluster
 *  → branching coral/frost structure. Simulated once, returned as a metaballs field. */
export const dla = (particles: number, ballR: number, seed: number): Field => {
  const rng = srng(seed)
  const cluster: [number, number, number][] = [[0, 0, 0]]
  const stick = 0.06, step = 0.05, gsz = stick * 1.6
  const grid = new Map<string, number[]>()
  const gkey = (x: number, y: number, z: number) => `${Math.floor(x / gsz)}_${Math.floor(y / gsz)}_${Math.floor(z / gsz)}`
  const add = (i: number, p: [number, number, number]) => { const k = gkey(p[0], p[1], p[2]); let a = grid.get(k); if (!a) { a = []; grid.set(k, a) } a.push(i) }
  add(0, cluster[0]); let maxR = 0.05
  const nearStick = (x: number, y: number, z: number) => { const ci = Math.floor(x / gsz), cj = Math.floor(y / gsz), ck = Math.floor(z / gsz); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const a = grid.get(`${ci + dx}_${cj + dy}_${ck + dz}`); if (!a) continue; for (const idx of a) { const p = cluster[idx]; if (Math.hypot(x - p[0], y - p[1], z - p[2]) < stick) return true } } return false }
  const N = Math.round(clamp(20, 800, particles))
  for (let i = 0; i < N; i++) {
    const spawnR = maxR + 0.12, killR = spawnR * 1.9
    let u = rng() * 2 - 1, a = rng() * Math.PI * 2, ph = Math.acos(u)
    let x = spawnR * Math.sin(ph) * Math.cos(a), y = spawnR * Math.sin(ph) * Math.sin(a), z = spawnR * Math.cos(ph)
    for (let s = 0; s < 700; s++) {
      const du = rng() * 2 - 1, aa = rng() * Math.PI * 2, pp = Math.acos(du)
      x += step * Math.sin(pp) * Math.cos(aa); y += step * Math.sin(pp) * Math.sin(aa); z += step * Math.cos(pp)
      const rr = Math.hypot(x, y, z)
      if (rr > killR) { const sc = spawnR / rr; x *= sc; y *= sc; z *= sc }
      if (nearStick(x, y, z)) { const idx = cluster.length; cluster.push([x, y, z]); add(idx, [x, y, z]); if (rr > maxR) maxR = rr; break }
    }
  }
  return metaballs(cluster, ballR)
}

/** Gray-Scott reaction-diffusion baked on a 3D grid → organic Turing patterns (coral,
 *  mitosis, spots, maze). The V concentration is sampled trilinearly as the field. */
export const reactionDiffusion = (F: number, k: number, steps: number, thresh: number, seed: number): Field => {
  const R = 30, S = R * R * R, at = (i: number, j: number, kk: number) => i + j * R + kk * R * R
  let U = new Float32Array(S).fill(1), V = new Float32Array(S)
  const rng = srng(seed)
  for (let n = 0; n < 16; n++) { const ci = 4 + Math.floor(rng() * (R - 8)), cj = 4 + Math.floor(rng() * (R - 8)), ck = 4 + Math.floor(rng() * (R - 8)); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) { const idx = at(ci + a, cj + b, ck + c); U[idx] = 0.5; V[idx] = 0.9 } }
  const Du = 0.16, Dv = 0.08, nU = new Float32Array(S), nV = new Float32Array(S)
  const ST = Math.round(clamp(50, 2000, steps))
  for (let s = 0; s < ST; s++) {
    for (let kk = 1; kk < R - 1; kk++) for (let j = 1; j < R - 1; j++) for (let i = 1; i < R - 1; i++) {
      const idx = at(i, j, kk), u = U[idx], v = V[idx]
      const lu = U[at(i - 1, j, kk)] + U[at(i + 1, j, kk)] + U[at(i, j - 1, kk)] + U[at(i, j + 1, kk)] + U[at(i, j, kk - 1)] + U[at(i, j, kk + 1)] - 6 * u
      const lv = V[at(i - 1, j, kk)] + V[at(i + 1, j, kk)] + V[at(i, j - 1, kk)] + V[at(i, j + 1, kk)] + V[at(i, j, kk - 1)] + V[at(i, j, kk + 1)] - 6 * v
      const uvv = u * v * v
      nU[idx] = u + (Du * lu - uvv + F * (1 - u)); nV[idx] = v + (Dv * lv + uvv - (F + k) * v)
    }
    U.set(nU); V.set(nV)
  }
  const Vg = V
  return (x, y, z) => {
    const fx = (x * 0.5 + 0.5) * (R - 1), fy = (y * 0.5 + 0.5) * (R - 1), fz = (z * 0.5 + 0.5) * (R - 1)
    let val = 0
    if (fx >= 0 && fx <= R - 1 && fy >= 0 && fy <= R - 1 && fz >= 0 && fz <= R - 1) { const i = Math.floor(fx), j = Math.floor(fy), kk = Math.floor(fz); val = Vg[at(Math.min(R - 1, i), Math.min(R - 1, j), Math.min(R - 1, kk))] }
    return Math.max(thresh - val, Math.hypot(x, y, z) - 0.95)
  }
}

// Phyllotaxis point set (golden-angle spiral on a sphere/disc) — for Fractal Bloom / metaballs.
export function phyllotaxis(n: number, spread: number, rise: number): [number, number, number][] {
  const ga = Math.PI * (3 - Math.sqrt(5)), out: [number, number, number][] = []
  for (let i = 0; i < n; i++) { const t = i / Math.max(1, n - 1); const r = spread * Math.sqrt(t); const a = i * ga; out.push([Math.cos(a) * r, (t - 0.5) * 2 * rise, Math.sin(a) * r]) }
  return out
}
