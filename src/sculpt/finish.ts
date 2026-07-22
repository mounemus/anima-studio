/**
 * Mesh FINISHING for the organic module — what turns a raw marching-cubes result into a
 * clean, printable object.
 *
 * Measured on the raw output (not assumed):
 *   - boundary edges: 0. There are no holes.
 *   - DISCONNECTED components: up to 75 — floating debris shed where the perforation field
 *     grazes the shell (worst on lattice/voronoï + noise). THIS is the "torn ribbons" look.
 *   - non-manifold edges: 12–24, created by weld() fusing two sheets that merely touch.
 *
 * So the cure is debris removal, not hole filling. Order still matters: close any genuine
 * boundary BEFORE smoothing, because Laplacian smoothing drags boundary vertices toward
 * their neighbours' average and shreds open rims.
 */
import * as THREE from 'three'
import { weld, laplacianSmooth, fillHoles } from '../morpho/mesh'



export interface FinishStats { components: number; removed: number; boundary: number; nonManifold: number; tris: number; watertight: boolean }

/**
 * Edge census. Boundary (an edge used ONCE) and non-manifold (used 3+ times) are different
 * defects with different cures — lumping them into one "open edges" number hides which one
 * you actually have. Measured on real output: holes 0, non-manifold 12–13.
 */
export function edgeCensus(g: THREE.BufferGeometry): { boundary: number; nonManifold: number } {
  const idx = g.getIndex(); if (!idx) return { boundary: -1, nonManifold: -1 }
  const a = idx.array as ArrayLike<number>
  const m = new Map<number, number>()
  for (let i = 0; i < a.length; i += 3) {
    const t = [a[i], a[i + 1], a[i + 2]]
    for (let j = 0; j < 3; j++) { const p = t[j], q = t[(j + 1) % 3]; const key = p < q ? p * 4294967296 + q : q * 4294967296 + p; m.set(key, (m.get(key) ?? 0) + 1) }
  }
  let b = 0, n = 0
  for (const c of m.values()) { if (c === 1) b++; else if (c > 2) n++ }
  return { boundary: b, nonManifold: n }
}

/** Total defective edges (boundary + non-manifold) — 0 means a clean closed manifold. */
export function openEdgeCount(g: THREE.BufferGeometry): number {
  const c = edgeCensus(g); return c.boundary < 0 ? -1 : c.boundary + c.nonManifold
}

/**
 * NOTE — re-baking through an SDF grid was tried as a cure for the non-manifold pinches and
 * MEASURED TO MAKE THEM WORSE (cellules 15→32, lattice 22→59, boucles 24→52 defective edges,
 * because a finer re-extraction creates more coincident-sheet vertices, not fewer). It is
 * deliberately not offered. The non-manifold edges come from weld() fusing two sheets that
 * merely touch; the raw marching-cubes soup is geometrically closed, which is why the
 * exported STL still reads as "1 closed mesh" in Rhino.
 */

/** Label connected components (by shared vertices) and return each triangle's component id. */
function labelComponents(g: THREE.BufferGeometry): { label: Int32Array; sizes: Map<number, number> } {
  const idx = g.getIndex()!.array as ArrayLike<number>
  const V = g.getAttribute('position').count
  const parent = new Int32Array(V)
  for (let i = 0; i < V; i++) parent[i] = i
  const find = (x: number): number => { let r = x; while (parent[r] !== r) r = parent[r]; while (parent[x] !== r) { const n = parent[x]; parent[x] = r; x = n } return r }
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  for (let i = 0; i < idx.length; i += 3) { union(idx[i], idx[i + 1]); union(idx[i], idx[i + 2]) }
  const tris = idx.length / 3
  const label = new Int32Array(tris)
  const sizes = new Map<number, number>()
  for (let t = 0; t < tris; t++) { const r = find(idx[t * 3]); label[t] = r; sizes.set(r, (sizes.get(r) ?? 0) + 1) }
  return { label, sizes }
}

/**
 * Drop floating debris: keep only components with at least `minFrac` of the LARGEST
 * component's triangle count. `minFrac = 1` would keep the single biggest shell only.
 */
export function keepMainComponents(g: THREE.BufferGeometry, minFrac = 0.05): { geo: THREE.BufferGeometry; components: number; removed: number } {
  const src = g.getIndex() ? g : weld(g)
  const idx = src.getIndex()!.array as ArrayLike<number>
  const { label, sizes } = labelComponents(src)
  const total = sizes.size
  if (total <= 1) return { geo: src, components: total, removed: 0 }
  let biggest = 0; for (const n of sizes.values()) if (n > biggest) biggest = n
  const threshold = Math.max(1, biggest * minFrac)
  const keep = new Set<number>(); for (const [id, n] of sizes) if (n >= threshold) keep.add(id)

  const pos = src.getAttribute('position').array as ArrayLike<number>
  const remap = new Int32Array(src.getAttribute('position').count).fill(-1)
  const outPos: number[] = [], outIdx: number[] = []
  const tris = idx.length / 3
  for (let t = 0; t < tris; t++) {
    if (!keep.has(label[t])) continue
    for (let j = 0; j < 3; j++) {
      const v = idx[t * 3 + j]
      if (remap[v] < 0) { remap[v] = outPos.length / 3; outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]) }
      outIdx.push(remap[v])
    }
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  out.setIndex(outIdx)
  out.computeVertexNormals()
  return { geo: out, components: total, removed: total - keep.size }
}

/**
 * Full finishing pass. Order is load-bearing (see file header):
 * weld → drop debris → close any genuine boundary → smooth → normals.
 */
export function finishMesh(
  g: THREE.BufferGeometry,
  opts: { smooth?: number; minFrac?: number; close?: boolean } = {},
): { geo: THREE.BufferGeometry; stats: FinishStats } {
  const smooth = Math.max(0, Math.min(6, Math.round(opts.smooth ?? 0)))
  const minFrac = opts.minFrac ?? 0.05
  const close = opts.close !== false

  let w = g.getIndex() ? g : weld(g)
  // 1) débris flottants
  const { geo, components, removed } = keepMainComponents(w, minFrac)
  w = geo
  // 2) boucher d’éventuels vrais trous, PUIS seulement lisser (lisser un bord le déchire)
  if (close && edgeCensus(w).boundary > 0) { try { w = fillHoles(w) } catch { /* noop */ } }
  if (smooth > 0) w = laplacianSmooth(w, smooth, 0.5)
  w.computeVertexNormals()
  const { boundary, nonManifold } = edgeCensus(w)
  const tris = (w.getIndex()?.count ?? w.getAttribute('position').count) / 3
  return { geo: w, stats: { components, removed, boundary, nonManifold, tris, watertight: boundary === 0 && nonManifold === 0 } }
}
