/**
 * ORNAMENT — what is ADDED to a body (the perforations of organic.ts take matter away).
 *
 * Two families, because the references split the same way :
 *
 *  - LATTICE reliefs (cannelures, écailles, méandres) are a height map laid over the body,
 *    in angle × height coordinates : regular, « designed », they follow the body's twist.
 *    They displace the body BEFORE it is shelled, so a thin wall undulates on both faces.
 *
 *  - SCATTERED elements (polypes, épines, rosettes, perles) are real little solids planted
 *    on points sampled ON the surface, each one aimed along the surface normal — the way a
 *    ceramist attaches cups and spines to a form. Because the points are sampled on the
 *    actual surface, this works on ANY body, a hand-sculpted or imported mesh included.
 *    The points are spread by farthest-point sampling (even but not gridded), and an
 *    element's radius is a fraction of the spacing : they cannot overlap by construction.
 *
 * Adding matter can only keep a solid connected and closed : unlike a perforation it never
 * sheds debris. Everything here is a pure function of the params (seeded, no Math.random).
 */
import type { Field } from '../morpho/marching'
import { noise3, smin } from '../morpho/fields'
import type { OrganicParams } from './organic'

export type OrgRelief = 'aucun' | 'cannelures' | 'ecailles' | 'meandres' | 'polypes' | 'epines' | 'rosettes' | 'perles'
export const ORG_RELIEFS: { kind: OrgRelief; label: string }[] = [
  { kind: 'aucun', label: '— Aucun (surface nue)' },
  { kind: 'polypes', label: '🪸 Polypes (tubes et coupes)' },
  { kind: 'epines', label: '🦔 Épines (oursin)' },
  { kind: 'rosettes', label: '🌼 Rosettes cannelées (anémones)' },
  { kind: 'perles', label: '🫧 Perles / bourgeons' },
  { kind: 'ecailles', label: '🍃 Écailles / pétales imbriqués' },
  { kind: 'cannelures', label: '🐚 Cannelures (côtes)' },
  { kind: 'meandres', label: '🧠 Méandres (corail cerveau)' },
]
const SCATTERED: OrgRelief[] = ['polypes', 'epines', 'rosettes', 'perles']
export const isScattered = (r: OrgRelief) => SCATTERED.includes(r)

const TAU = Math.PI * 2
const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const sstep = (a: number, b: number, v: number) => { const t = sat((v - a) / (b - a)); return t * t * (3 - 2 * t) }

/** What the density slider (0..1) means for each relief : ribs, columns, frequency or
 *  number of elements. One slider, one meaning the panel can print. */
export function reliefCount(p: Pick<OrganicParams, 'relief' | 'reliefDensity'>): number {
  const d = sat(p.reliefDensity)
  switch (p.relief) {
    case 'aucun': return 0
    case 'cannelures': return Math.round(4 + d * 36)
    case 'ecailles': return Math.round(5 + d * 23)
    case 'meandres': return Math.round(8 + d * 26)
    default: return Math.round(8 + d * d * 250)
  }
}

/** Height map of a lattice relief (≥ 0, world units), or null if the relief is not one. */
export function latticeRelief(p: OrganicParams): Field | null {
  const H = Math.max(0, p.reliefHeight), size = sat(p.reliefSize), n = reliefCount(p)
  // Une côte ou une écaille plus étroite qu'une maille ne se polygonise pas : elle
  // s'émiette. Le relief s'efface donc là où le corps devient trop étroit pour lui.
  const vox = 2.3 / Math.max(24, p.res)
  const fits = (rad: number) => sat(((TAU * rad) / n - 1.2 * vox) / (1.5 * vox))
  if (H < 1e-4) return null
  if (p.relief === 'cannelures') {
    // Côtes le long des méridiens. « Taille » règle leur largeur : fines lames ↔ côtes pleines.
    const e = 0.7 + (1 - size) * 3.3
    return (x, _y, z) => {
      const rad = Math.hypot(x, z)
      return H * Math.pow(0.5 + 0.5 * Math.cos(n * Math.atan2(z, x)), e) * fits(rad)
    }
  }
  if (p.relief === 'ecailles') {
    // Pétales en quinconce, chacun long de deux rangs : il recouvre la base du suivant.
    // La hauteur monte de la base vers la pointe, avec une nervure centrale.
    const pitch = TAU / n, rowH = ((TAU * 0.42) / n) * 1.1
    return (x, y, z) => {
      const rad = Math.hypot(x, z)
      const u = Math.atan2(z, x) / pitch
      const j0 = Math.floor(y / rowH)
      let best = 0
      for (let j = j0 - 1; j <= j0; j++) {
        const bb = (y - j * rowH) / (2 * rowH)          // 0 à la base du pétale, 1 à sa pointe
        if (bb < 0 || bb > 1) continue
        const hw = 0.58 * size * Math.pow(Math.sin(Math.PI * bb), 0.6)
        if (hw < 1e-4) continue
        const c = u - (((j % 2) + 2) % 2) * 0.5
        const a = Math.abs(c - Math.round(c))
        if (a >= hw) continue
        const v = Math.pow(1 - a / hw, 0.8) * (0.2 + 0.8 * bb)
        if (v > best) best = v
      }
      return H * best * fits(rad)
    }
  }
  if (p.relief === 'meandres') {
    // Les lignes de niveau d'un gyroïde, coupées par la surface, dessinent un labyrinthe.
    // Un léger gauchissement de l'espace leur enlève leur régularité de cristal.
    // Le relief suit la ligne où le gyroïde s'annule : des crêtes sinueuses d'égale largeur.
    const f = n, w = 0.16 + size * 0.5
    return (x, y, z) => {
      const wx = x + 0.07 * noise3(x * 2.3 + 5, y * 2.3, z * 2.3)
      const wy = y + 0.07 * noise3(x * 2.3, y * 2.3 + 9, z * 2.3)
      const wz = z + 0.07 * noise3(x * 2.3, y * 2.3, z * 2.3 + 3)
      const g = Math.sin(f * wx) * Math.cos(f * wy) + Math.sin(f * wy) * Math.cos(f * wz) + Math.sin(f * wz) * Math.cos(f * wx)
      return H * (1 - sstep(w * 0.45, w, Math.abs(g)))
    }
  }
  return null
}

// ── Scattered elements ──────────────────────────────────────────────────────

/** A point on the surface with its frame : position, normal, two tangents. */
export interface Anchor { p: [number, number, number]; n: [number, number, number]; t: [number, number, number]; b: [number, number, number] }

const rng = (seed: number) => { let s = (Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }

/**
 * `count` points evenly spread on the zero set of `surface`.
 * Random points are pulled onto the surface along its gradient, then thinned by
 * farthest-point sampling. `spacing` is the smallest distance between two kept points.
 * `accept` filters candidates (a flat base, the cut-off top…).
 */
export function sampleSurface(
  surface: Field, count: number, seed: number,
  opts: { xPositive?: boolean; accept?: (p: [number, number, number], n: [number, number, number]) => boolean; bound?: number } = {},
): { anchors: Anchor[]; spacing: number } {
  const B = opts.bound ?? 1.05, rnd = rng(seed), E = 0.01
  const want = Math.max(1, Math.round(count))
  const tries = Math.max(900, Math.min(4500, want * 14))
  const cp: number[] = [], cn: number[] = []
  for (let c = 0; c < tries; c++) {
    let x = opts.xPositive ? rnd() * B : (rnd() * 2 - 1) * B, y = (rnd() * 2 - 1) * B, z = (rnd() * 2 - 1) * B
    let gx = 0, gy = 0, gz = 0, d = 1, ok = false
    for (let it = 0; it < 12; it++) {
      d = surface(x, y, z)
      gx = surface(x + E, y, z) - surface(x - E, y, z); gy = surface(x, y + E, z) - surface(x, y - E, z); gz = surface(x, y, z + E) - surface(x, y, z - E)
      const gl = Math.hypot(gx, gy, gz)
      if (gl < 1e-9) break
      gx /= gl; gy /= gl; gz /= gl
      if (Math.abs(d) < 0.002) { ok = true; break }
      // gl / 2E est la pente réelle : un champ qui n'est pas une vraie distance avance moins.
      const step = Math.max(-0.3, Math.min(0.3, d / Math.max(0.3, gl / (2 * E))))
      x -= gx * step; y -= gy * step; z -= gz * step
    }
    if (!ok || Math.abs(x) > B || Math.abs(y) > B || Math.abs(z) > B) continue
    if (opts.xPositive && x < 0) continue
    if (opts.accept && !opts.accept([x, y, z], [gx, gy, gz])) continue
    cp.push(x, y, z); cn.push(gx, gy, gz)
  }
  const M = cp.length / 3
  if (!M) return { anchors: [], spacing: 0 }
  const N = Math.min(want, M)
  const dist = new Float64Array(M).fill(Infinity)
  const picked: number[] = []
  let cur = 0, spacing = Infinity
  for (let k = 0; k < N; k++) {
    picked.push(cur)
    let far = -1, fd = -1
    for (let i = 0; i < M; i++) {
      const dx = cp[i * 3] - cp[cur * 3], dy = cp[i * 3 + 1] - cp[cur * 3 + 1], dz = cp[i * 3 + 2] - cp[cur * 3 + 2]
      const dd = dx * dx + dy * dy + dz * dz
      if (dd < dist[i]) dist[i] = dd
      if (dist[i] > fd) { fd = dist[i]; far = i }
    }
    if (k < N - 1) { spacing = Math.min(spacing, Math.sqrt(fd)); cur = far }
  }
  if (!Number.isFinite(spacing)) spacing = 0.6            // un seul point : une taille raisonnable
  const anchors: Anchor[] = picked.map((i) => {
    const n: [number, number, number] = [cn[i * 3], cn[i * 3 + 1], cn[i * 3 + 2]]
    // repère tangent : n × (axe le moins aligné)
    const ax: [number, number, number] = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
    let tx = n[1] * ax[2] - n[2] * ax[1], ty = n[2] * ax[0] - n[0] * ax[2], tz = n[0] * ax[1] - n[1] * ax[0]
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl
    return { p: [cp[i * 3], cp[i * 3 + 1], cp[i * 3 + 2]], n, t: [tx, ty, tz], b: [n[1] * tz - n[2] * ty, n[2] * tx - n[0] * tz, n[0] * ty - n[1] * tx] }
  })
  return { anchors, spacing }
}

/**
 * Plant the elements : returns a function that takes the body field and gives it back with
 * the elements fused on (smooth union — they look grown, not glued) and, for polypes, their
 * bore drilled out. Elements live in a uniform hash grid, so a sample only ever looks at the
 * one or two elements around it.
 */
export function plantElements(p: OrganicParams, anchors: Anchor[], spacing: number): ((base: Field) => Field) | null {
  if (!anchors.length || !isScattered(p.relief)) return null
  const kind = p.relief
  const R = Math.max(0.012, 0.5 * spacing * (0.25 + 0.75 * sat(p.reliefSize)))
  const H = Math.max(0.005, p.reliefHeight)
  const k = 0.008 + Math.max(0, p.blend) * 0.2
  const reach = Math.hypot(R * 1.25, H) + R * 0.3 + k + 0.012
  const cs = Math.max(0.03, reach), OFF = 2
  const cell = (v: number) => Math.floor((v + OFF) / cs)
  const grid = new Map<number, number[]>()
  anchors.forEach((a, i) => {
    for (let ix = cell(a.p[0] - reach); ix <= cell(a.p[0] + reach); ix++)
      for (let iy = cell(a.p[1] - reach); iy <= cell(a.p[1] + reach); iy++)
        for (let iz = cell(a.p[2] - reach); iz <= cell(a.p[2] + reach); iz++) {
          const key = ix + iy * 256 + iz * 65536
          const l = grid.get(key); if (l) l.push(i); else grid.set(key, [i])
        }
  })
  // Polypes : le forage traverse la paroi si le corps est une coque, sinon il fait une coupe.
  // La paroi d'un tube garde au moins deux mailles d'épaisseur ; un tube trop petit pour
  // être foré reste plein (mesuré : 54 fragments avec 149 tubes à la résolution 110).
  const vox = 2.3 / Math.max(24, p.res)
  const Ro = R * 0.82, rr = Math.min(Ro * 0.3, 0.02), Ri = Math.min(Ro * 0.6, Ro - 2 * vox), bored = Ri > 1.2 * vox
  const boreFrom = p.shell > 0.001 ? -(2 * p.shell + 0.04) : H - Math.min(H * 0.75, 0.14)
  // épines : cône à bout rond. Une pointe plus fine qu'une maille s'émiette (56 fragments mesurés).
  const Rs = R * 0.55, rt = Math.min(Rs, Math.max(0.014, R * 0.12)), cosA = H / Math.hypot(H, Rs - rt)
  const rp = R * 0.85, hc = Math.max(H - rp, -rp * 0.5)   // perles

  return (base) => (x, y, z) => {
    const d0 = base(x, y, z)
    const list = grid.get(cell(x) + cell(y) * 256 + cell(z) * 65536)
    if (!list) return d0
    let add = 1e9, bore = 1e9
    for (const i of list) {
      const a = anchors[i]
      const vx = x - a.p[0], vy = y - a.p[1], vz = z - a.p[2]
      const h = vx * a.n[0] + vy * a.n[1] + vz * a.n[2]
      const rho = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - h * h))
      let d: number
      if (kind === 'perles') d = Math.hypot(rho, h - hc) - rp
      else if (kind === 'epines') d = h > H ? Math.hypot(rho, h - H) - rt : Math.max((rho - (Rs + (rt - Rs) * (h / H))) * cosA, -h - R * 0.5)
      else if (kind === 'polypes') {
        const qx = rho - (Ro - rr), qy = h - (H - rr)
        d = Math.max(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr, -h - R)
        if (bored) { const bd = Math.max(rho - Ri, boreFrom - h, h - (H + 0.05)); if (bd < bore) bore = bd }
      } else {
        // rosette : une coupelle basse au bord cannelé, un bouton au centre
        const u = rho / R
        const phi = Math.atan2(vx * a.b[0] + vy * a.b[1] + vz * a.b[2], vx * a.t[0] + vy * a.t[1] + vz * a.t[2])
        const prof = H * (sstep(0.12, 0.7, u) * (1 - sstep(0.82, 1.08, u)) * (0.8 + 0.2 * Math.cos(12 * phi)) + 0.75 * (1 - sstep(0, 0.26, u)))
        d = Math.max((h - prof) * 0.6, -h - R * 0.4, rho - R * 1.15)
      }
      if (d < add) add = d
    }
    let out = smin(d0, add, k)
    if (bore < 1e8) out = Math.max(out, -bore)
    return out
  }
}
