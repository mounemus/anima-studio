/**
 * Parametric surface primitives for MORPHOGENESIS STUDIO. Unlike the SDF/field nodes,
 * these are (u,v) → xyz immersions producing a mesh directly (Klein bottle & surface,
 * Möbius band, Plücker's conoid, geodesic dome). They output a `mesh` and feed the mesh
 * pipeline (smooth / output). Each is normalised to a unit box then scaled.
 */
import * as THREE from 'three'

export type PFn = (u: number, v: number) => [number, number, number]

/** Sample a parametric surface on a (uN×vN) grid → indexed BufferGeometry (double-sided). */
export function paramSurface(fn: PFn, uN: number, vN: number, uMin: number, uMax: number, vMin: number, vMax: number): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [], W = uN + 1
  for (let j = 0; j <= vN; j++) for (let i = 0; i <= uN; i++) { const u = uMin + (uMax - uMin) * i / uN, v = vMin + (vMax - vMin) * j / vN; const p = fn(u, v); pos.push(p[0], p[1], p[2]) }
  for (let j = 0; j < vN; j++) for (let i = 0; i < uN; i++) { const a = j * W + i, b = j * W + i + 1, c = (j + 1) * W + i, d = (j + 1) * W + i + 1; idx.push(a, c, b, b, c, d) }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals()
  return fitUnit(g)
}
/** Centre + scale a geometry so its largest extent ≈ 1.7 (fits the viewport / bound). */
export function fitUnit(g: THREE.BufferGeometry, target = 1.7): THREE.BufferGeometry {
  g.computeBoundingBox(); const bb = g.boundingBox!; const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3())
  const k = target / Math.max(s.x, s.y, s.z, 1e-4)
  g.translate(-c.x, -c.y, -c.z); g.scale(k, k, k); g.computeVertexNormals(); g.computeBoundingBox()
  return g
}

const PI = Math.PI

/** Classic (immersed) Klein bottle — the "bottle" shape. u,v ∈ [0,2π]. */
export const kleinBottle: PFn = (u, v) => {
  const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v)
  let x: number, z: number
  if (u < PI) { x = 3 * cu * (1 + su) + 2 * (1 - cu / 2) * cu * cv; z = -8 * su - 2 * (1 - cu / 2) * su * cv }
  else { x = 3 * cu * (1 + su) + 2 * (1 - cu / 2) * Math.cos(v + PI); z = -8 * su }
  const y = -2 * (1 - cu / 2) * sv
  return [x * 0.12, z * 0.12, y * 0.12]   // remap so the bottle stands up (z→height)
}
/** Figure-8 immersion of the Klein bottle — the "Klein surface". */
export const kleinSurface: PFn = (u, v) => {
  const r = 2, a = r + Math.cos(u / 2) * Math.sin(v) - Math.sin(u / 2) * Math.sin(2 * v)
  return [a * Math.cos(u), Math.sin(u / 2) * Math.sin(v) + Math.cos(u / 2) * Math.sin(2 * v), a * Math.sin(u)]
}
/** Möbius band. u ∈ [0,2π], v ∈ [-1,1]. `w` = half-width. */
export const mobius = (w: number, twists: number): PFn => (u, v) => {
  const t = (u / 2) * twists
  return [(1 + w * v * Math.cos(t)) * Math.cos(u), w * v * Math.sin(t), (1 + w * v * Math.cos(t)) * Math.sin(u)]
}
/** Plücker's conoid (ruled). u ∈ [0,2π] angle, v ∈ [-1,1] radius. `n` = blades. */
export const plucker = (n: number, height: number): PFn => (u, v) => [v * Math.cos(u), Math.sin(n * u) * height, v * Math.sin(u)]

/** Geodesic dome — subdivided icosahedron, sliced to a dome above the base. */
export function geodesicDome(detail: number, dome: boolean): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, Math.max(0, Math.min(4, Math.round(detail))))
  if (!dome) return fitUnit(ico)
  // keep only faces whose centroid is above the equator → a dome
  const pos = ico.getAttribute('position'); const keep: number[] = []
  for (let i = 0; i < pos.count; i += 3) { const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3; if (y > -0.15) { keep.push(i, i + 1, i + 2) } }
  const np: number[] = []; for (const i of keep) np.push(pos.getX(i), pos.getY(i), pos.getZ(i))
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(np, 3)); g.computeVertexNormals(); ico.dispose()
  return fitUnit(g)
}
