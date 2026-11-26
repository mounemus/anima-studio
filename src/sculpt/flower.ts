/**
 * FLEUR MÉCANIQUE — a body made of parts instead of one silhouette : ribbon petals that
 * leave the heart, twist on themselves and curl back, stamens (bent rods ending in a ball)
 * and a toothed wheel at the centre. It faces +z, so it opens toward the default camera.
 *
 * A ribbon is a flat band swept along a curve. The curve is integrated in the (radius,
 * depth) plane with a turning rate that grows along it — it starts almost straight and ends
 * in a loop — while the band rolls about its own axis ; « curl » drives both.
 * Petals of a ring are rotations of one template, so only the three nearest are evaluated.
 *
 * `part` tells the three families apart for the glaze (see shade.ts) : petals read as the
 * body, stamens as relief, the wheel as hollow — three colours without painting anything.
 */
import type { Field } from '../morpho/marching'
import { smin } from '../morpho/fields'

const TAU = Math.PI * 2
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

interface Seg { px: number; py: number; pz: number; tx: number; ty: number; tz: number; wx: number; wy: number; wz: number; nx: number; ny: number; nz: number; len: number; w0: number; w1: number }

/** One petal's centreline as segments with a frame, in a frame where the petal leaves along +x. */
function petalTemplate(length: number, curl: number, width: number, sweep: number, lift: number): { segs: Seg[]; cx: number; cy: number; cz: number; r: number } {
  const K = 16, pts: number[][] = [], frames: number[][] = []
  let rho = 0.07, z = 0.02
  for (let i = 0; i <= K; i++) {
    const s = i / K
    const th = lift + Math.PI * 1.45 * curl * s * s          // direction dans le plan (rayon, profondeur)
    const phi = sweep * s * s                                 // dérive dans le plan de la fleur
    const roll = 3.1 * curl * (s - 0.2)                      // la bande tourne sur son axe
    const c = Math.cos(phi), sn = Math.sin(phi)
    pts.push([rho * c, rho * sn, z])
    // largeur d'abord tangente au cercle (pétale vu de face), puis basculée par le roulis
    const nr = [-Math.sin(th) * c, -Math.sin(th) * sn, Math.cos(th)], wt = [-sn, c, 0]
    const cr = Math.cos(roll), sr = Math.sin(roll)
    frames.push([wt[0] * cr + nr[0] * sr, wt[1] * cr + nr[1] * sr, wt[2] * cr + nr[2] * sr])
    rho += (length / K) * Math.cos(th); z += (length / K) * Math.sin(th)
  }
  const wAt = (s: number) => width * (0.18 + 0.82 * Math.pow(Math.sin(Math.PI * Math.pow(s, 0.75)), 0.7))
  const segs: Seg[] = []
  let cx = 0, cy = 0, cz = 0
  for (let i = 0; i < K; i++) {
    const a = pts[i], b = pts[i + 1]
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2]
    const len = Math.hypot(tx, ty, tz) || 1e-6; tx /= len; ty /= len; tz /= len
    // largeur rendue perpendiculaire à la tangente du segment
    let [wx, wy, wz] = frames[i]
    const d = wx * tx + wy * ty + wz * tz; wx -= d * tx; wy -= d * ty; wz -= d * tz
    const wl = Math.hypot(wx, wy, wz) || 1; wx /= wl; wy /= wl; wz /= wl
    segs.push({ px: a[0], py: a[1], pz: a[2], tx, ty, tz, wx, wy, wz, nx: ty * wz - tz * wy, ny: tz * wx - tx * wz, nz: tx * wy - ty * wx, len, w0: wAt(i / K), w1: wAt((i + 1) / K) })
    cx += a[0]; cy += a[1]; cz += a[2]
  }
  cx /= K; cy /= K; cz /= K
  let r = 0
  for (const p of pts) r = Math.max(r, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz))
  return { segs, cx, cy, cz, r: r + width }
}

function ribbon(t: ReturnType<typeof petalTemplate>, half: number): Field {
  return (x, y, z) => {
    const far = Math.hypot(x - t.cx, y - t.cy, z - t.cz) - t.r
    if (far > 0.12) return far
    let best = 1e9
    for (const s of t.segs) {
      const vx = x - s.px, vy = y - s.py, vz = z - s.pz
      const along = vx * s.tx + vy * s.ty + vz * s.tz
      const u = clamp(0, 1, along / s.len)
      const a = Math.abs(vx * s.wx + vy * s.wy + vz * s.wz) - (s.w0 + (s.w1 - s.w0) * u)
      const b = Math.abs(vx * s.nx + vy * s.ny + vz * s.nz) - half
      const c = along - u * s.len                                // dépassement aux deux bouts
      const d = Math.hypot(Math.max(a, 0), Math.max(b, 0), c) + Math.min(Math.max(a, b), 0)
      if (d < best) best = d
    }
    return best - 0.006
  }
}

/** A ring of `n` copies of `f` around z : only the sector the point is in, and its two
 *  neighbours (a petal sweeps sideways, so it trespasses on the next sector). */
function ring(f: Field, n: number, phase: number): Field {
  const step = TAU / n
  return (x, y, z) => {
    const k = Math.round((Math.atan2(y, x) - phase) / step)
    let best = 1e9
    for (let dk = -1; dk <= 1; dk++) {
      const a = -((k + dk) * step + phase), c = Math.cos(a), s = Math.sin(a)
      const d = f(c * x - s * y, s * x + c * y, z)
      if (d < best) best = d
    }
    return best
  }
}

export interface FlowerOpts { petals: number; curl: number; stamens: number; res: number; bound: number }

export function flowerParts(o: FlowerOpts): { field: Field; part: Field } {
  const N = Math.round(clamp(3, 16, o.petals)), curl = clamp(0, 1.5, o.curl), M = Math.round(clamp(0, 40, o.stamens))
  // Une bande plus fine qu'une maille et demie se déchire à la polygonisation.
  const half = Math.max(0.016, 0.8 * ((2 * o.bound) / Math.max(24, o.res)))
  const width = Math.min(0.16, (Math.PI * 0.42) / N * 0.85)
  const outer = ring(ribbon(petalTemplate(1.25, curl, width, 0.55, -0.12), half), N, 0)
  const inner = ring(ribbon(petalTemplate(0.62, curl * 1.25, width * 0.7, -0.5, 0.35), half), Math.max(3, Math.round(N * 0.75)), Math.PI / N)
  const hub: Field = (x, y, z) => Math.hypot(x, y, (z - 0.02) * 1.6) - 0.13
  const petals: Field = (x, y, z) => smin(Math.min(outer(x, y, z), inner(x, y, z)), hub(x, y, z), 0.05)

  // Étamines : une tige courbée (trois tronçons) et sa boule, réparties par l'angle d'or.
  const rod = Math.max(0.014, half * 0.8), caps: number[][] = [], balls: number[][] = []
  for (let i = 0; i < M; i++) {
    const a = i * 2.39996, t = (i + 0.5) / M
    const reach = 0.2 + 0.24 * t, rise = 0.44 - 0.16 * t
    const c = Math.cos(a), s = Math.sin(a)
    const p = (u: number) => { const r = 0.05 + reach * u * u, h = 0.06 + rise * (1 - (1 - u) * (1 - u)); return [r * c, r * s, h] }
    const q = [p(0), p(0.4), p(0.75), p(1)]
    for (let j = 0; j < 3; j++) caps.push([...q[j], ...q[j + 1]])
    balls.push([...q[3], rod * 2.6])
  }
  const stamens: Field = (x, y, z) => {
    if (!M) return 1e9
    const far = Math.hypot(x, y, z - 0.25) - 0.62
    if (far > 0.1) return far
    let best = 1e9
    for (const k of caps) {
      const ex = k[3] - k[0], ey = k[4] - k[1], ez = k[5] - k[2]
      const u = clamp(0, 1, ((x - k[0]) * ex + (y - k[1]) * ey + (z - k[2]) * ez) / (ex * ex + ey * ey + ez * ez))
      const d = Math.hypot(x - k[0] - ex * u, y - k[1] - ey * u, z - k[2] - ez * u) - rod
      if (d < best) best = d
    }
    for (const b of balls) { const d = Math.hypot(x - b[0], y - b[1], z - b[2]) - b[3]; if (d < best) best = d }
    return best
  }
  // Roue dentée au cœur, percée.
  const gear: Field = (x, y, z) => {
    const rho = Math.hypot(x, y)
    const teeth = 0.088 + 0.016 * clamp(-1, 1, 2.2 * Math.cos(14 * Math.atan2(y, x)))
    return Math.max(rho - teeth, Math.abs(z - 0.115) - 0.04, 0.034 - rho)
  }
  const field: Field = (x, y, z) => Math.min(smin(petals(x, y, z), stamens(x, y, z), 0.012), gear(x, y, z))
  const part: Field = (x, y, z) => {
    const dp = petals(x, y, z), ds = stamens(x, y, z), dg = gear(x, y, z)
    return dg <= dp && dg <= ds ? -0.2 : ds < dp ? 0.2 : 0
  }
  return { field, part }
}
