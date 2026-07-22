/**
 * Arbitrary MESH → signed-distance FIELD, so a sculpted blob or an imported model can be
 * fed into the organic-parametric pipeline (shelled, perforated, twisted) exactly like the
 * built-in primitives.
 *
 * Two halves, both needed:
 *  - MAGNITUDE : nearest-surface distance via a BVH (three-mesh-bvh) — exact and fast.
 *  - SIGN      : scanline ray parity. One ray per (y,z) row instead of one per grid point
 *    (dim² casts instead of dim³ — ~50× fewer at dim 56), then each sample along the row
 *    counts the crossings ahead of it: odd ⇒ inside. Exact for watertight meshes, and it
 *    degrades gracefully rather than inverting whole regions the way a flood fill can.
 *
 * The result is BAKED into a grid once, then sampled trilinearly — so marching cubes can
 * run at high resolution over it cheaply, and the costly mesh queries happen a single time.
 */
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { Field } from '../morpho/marching'

export interface MeshFieldOpts {
  grid?: number          // résolution du grid SDF (56 ≈ bon compromis détail/temps)
  bound?: number         // demi-étendue du domaine échantillonné
  fit?: number           // plus grande dimension après recentrage/mise à l'échelle
  onProgress?: (t: number) => void
}

/** Center + uniformly scale a geometry so its largest dimension equals `fit`. */
export function fitGeometry(g: THREE.BufferGeometry, fit: number): THREE.BufferGeometry {
  const out = g.clone()
  out.computeBoundingBox()
  const bb = out.boundingBox!
  const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3())
  const k = fit / Math.max(s.x, s.y, s.z, 1e-4)
  out.translate(-c.x, -c.y, -c.z)
  out.scale(k, k, k)
  out.computeBoundingBox()
  return out
}

/**
 * Bake `geo` into a signed distance grid and return a trilinear sampler (negative inside).
 * Throws if the geometry has no triangles.
 */
export function meshToField(geo: THREE.BufferGeometry, opts: MeshFieldOpts = {}): Field {
  const grid = Math.max(16, Math.min(96, Math.round(opts.grid ?? 56)))
  const bound = opts.bound ?? 1.15
  const fit = opts.fit ?? bound * 1.35
  const onProgress = opts.onProgress

  const src = fitGeometry(geo, fit)
  if (!src.getAttribute('position') || src.getAttribute('position').count < 3) throw new Error('Maillage vide')
  if (!src.getIndex()) {
    // BVH wants an index; a raw triangle soup gets a trivial one.
    const n = src.getAttribute('position').count
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n)
    for (let i = 0; i < n; i++) idx[i] = i
    src.setIndex(new THREE.BufferAttribute(idx, 1))
  }
  const bvh = new MeshBVH(src)

  const dim = grid + 1
  const step = (bound * 2) / grid
  const dist = new Float32Array(dim * dim * dim)
  const inside = new Uint8Array(dim * dim * dim)
  const at = (i: number, j: number, k: number) => i + j * dim + k * dim * dim

  // ── SIGN : one ray per (y,z) scanline, crossings sorted along +X ──
  // Two degeneracies must be handled or the parity silently inverts:
  //  - a ray exactly on the lattice runs along SHARED EDGES and each crossing is reported
  //    twice → the count turns even and the interior reads as exterior. A sub-cell,
  //    non-commensurate JITTER moves the ray off every edge/vertex it would otherwise hit.
  //  - belt and braces: collapse crossings that are still coincident within 1e-6.
  const JY = 7.3e-5, JZ = 3.1e-5   // « irrationnels » vis-à-vis du pas de grille
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(1, 0, 0))
  const x0 = -bound - 1
  for (let k = 0; k < dim; k++) {
    const z = -bound + k * step
    for (let j = 0; j < dim; j++) {
      const y = -bound + j * step
      ray.origin.set(x0, y + JY, z + JZ)
      let xs: number[]
      try {
        const raw = (bvh.raycast(ray, THREE.DoubleSide) as { point: THREE.Vector3 }[]).map((h) => h.point.x).sort((a, b) => a - b)
        xs = []
        for (const v of raw) if (!xs.length || v - xs[xs.length - 1] > 1e-6) xs.push(v)
      } catch { xs = [] }
      if (!xs.length) continue
      let c = 0
      for (let i = 0; i < dim; i++) {
        const x = -bound + i * step
        while (c < xs.length && xs[c] < x) c++
        if ((xs.length - c) % 2 === 1) inside[at(i, j, k)] = 1   // nombre impair de traversées devant ⇒ dedans
      }
    }
    if (onProgress && (k % 4 === 0)) onProgress((k / dim) * 0.25)
  }

  // ── MAGNITUDE : nearest point on the surface, per grid node ──
  const pt = new THREE.Vector3()
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }
  for (let k = 0; k < dim; k++) {
    const z = -bound + k * step
    for (let j = 0; j < dim; j++) {
      const y = -bound + j * step
      for (let i = 0; i < dim; i++) {
        pt.set(-bound + i * step, y, z)
        let d = bound * 2
        try { const hit = bvh.closestPointToPoint(pt, target); if (hit) d = target.distance } catch { /* garde la valeur par défaut */ }
        dist[at(i, j, k)] = inside[at(i, j, k)] ? -d : d
      }
    }
    if (onProgress && (k % 2 === 0)) onProgress(0.25 + (k / dim) * 0.75)
  }
  onProgress?.(1)

  // ── Trilinear sampler ; outside the baked domain we extrapolate outward so marching
  //    cubes never sees a spurious surface at the domain wall. ──
  return (x, y, z) => {
    const fx = (x + bound) / step, fy = (y + bound) / step, fz = (z + bound) / step
    if (fx < 0 || fy < 0 || fz < 0 || fx > dim - 1 || fy > dim - 1 || fz > dim - 1) {
      return Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) - bound + 0.01
    }
    const i0 = Math.min(dim - 2, Math.floor(fx)), j0 = Math.min(dim - 2, Math.floor(fy)), k0 = Math.min(dim - 2, Math.floor(fz))
    const tx = fx - i0, ty = fy - j0, tz = fz - k0
    const g = (i: number, j: number, k: number) => dist[at(i, j, k)]
    const c00 = g(i0, j0, k0) * (1 - tx) + g(i0 + 1, j0, k0) * tx
    const c10 = g(i0, j0 + 1, k0) * (1 - tx) + g(i0 + 1, j0 + 1, k0) * tx
    const c01 = g(i0, j0, k0 + 1) * (1 - tx) + g(i0 + 1, j0, k0 + 1) * tx
    const c11 = g(i0, j0 + 1, k0 + 1) * (1 - tx) + g(i0 + 1, j0 + 1, k0 + 1) * tx
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz
  }
}
