/** Robust mesh boolean operations for MORPHOGENESIS STUDIO via three-bvh-csg
 *  (BVH-accelerated, exact CSG on triangle meshes — union / soustraction / intersection).
 *  Works on ANY mesh, including imports, so it can truly pierce/carve solids (real
 *  moucharabieh ajouré) rather than only field-space booleans on SDFs. */
import * as THREE from 'three'
import { Evaluator, Brush, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg'

export type BoolOp = 'union' | 'subtract' | 'intersect'
const OPS = { union: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION } as const

// One shared evaluator (worker/main are single-threaded → sequential use is safe).
const evaluator = new Evaluator()
evaluator.attributes = ['position', 'normal']   // carry only these → no uv/attr mismatch between operands

/** Brush wants clean position+normal and nothing else. Clone, drop extra attrs, ensure normals. */
function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = new THREE.BufferGeometry()
  c.setAttribute('position', (g.getAttribute('position') as THREE.BufferAttribute).clone())
  if (g.getIndex()) c.setIndex((g.getIndex() as THREE.BufferAttribute).clone())
  const n = g.getAttribute('normal')
  if (n) c.setAttribute('normal', (n as THREE.BufferAttribute).clone()); else c.computeVertexNormals()
  return c
}

/** A op B → new geometry. Falls back to A on any failure so it can never blank the pipeline. */
export function meshBoolean(a: THREE.BufferGeometry, b: THREE.BufferGeometry, op: BoolOp): THREE.BufferGeometry {
  try {
    const ba = new Brush(prep(a)); ba.updateMatrixWorld()
    const bb = new Brush(prep(b)); bb.updateMatrixWorld()
    const result = evaluator.evaluate(ba, bb, OPS[op] ?? SUBTRACTION)
    const src = result.geometry
    const posAttr = src.getAttribute('position')
    if (!posAttr || posAttr.count < 3) return a
    // Rebuild into OUR THREE.BufferGeometry — three-bvh-csg may resolve a different `three`
    // instance, so its result would fail `instanceof THREE.BufferGeometry` downstream.
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(posAttr.array as ArrayLike<number>), 3))
    const idx = src.getIndex()
    if (idx) geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx.array as ArrayLike<number>), 1))
    geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere()
    return geo
  } catch { return a }
}
