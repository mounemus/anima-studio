/** Mesh utilities for MORPHOGENESIS STUDIO : welding, smoothing, and a fabrication /
 *  quality analysis (poly count, bounds, volume, watertightness). */
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** Weld coincident marching-cubes vertices → shared topology + SMOOTH normals.
 *  Must strip the flat per-face `normal` first: mergeVertices compares *all*
 *  attributes, so leaving the (differing) flat normals in place prevents merging
 *  and the surface stays faceted ("fragmented"). Bulletproof — on any failure or
 *  empty result it returns the original geometry, never a blank mesh. */
export function weld(g: THREE.BufferGeometry): THREE.BufferGeometry {
  try {
    const g2 = g.clone()
    g2.deleteAttribute('normal'); g2.deleteAttribute('uv')
    const w = mergeVertices(g2, 1e-4)
    if (!w.getAttribute('position') || w.getAttribute('position').count < 3) return g
    w.computeVertexNormals()
    return w
  } catch { return g }
}

/** Laplacian smoothing (n passes) on an indexed geometry. */
export function laplacianSmooth(g: THREE.BufferGeometry, iterations: number, lambda = 0.5): THREE.BufferGeometry {
  const geo = g.getIndex() ? g : weld(g)
  const idx = geo.getIndex()!.array as ArrayLike<number>
  const pos = geo.getAttribute('position').array as Float32Array
  const V = geo.getAttribute('position').count
  const adj: number[][] = Array.from({ length: V }, () => [])
  for (let i = 0; i < idx.length; i += 3) { const t = [idx[i], idx[i + 1], idx[i + 2]]; for (let j = 0; j < 3; j++) { const a = t[j], b = t[(j + 1) % 3]; if (!adj[a].includes(b)) adj[a].push(b); if (!adj[b].includes(a)) adj[b].push(a) } }
  for (let it = 0; it < iterations; it++) {
    const src = pos.slice()
    for (let v = 0; v < V; v++) { const nb = adj[v]; if (!nb.length) continue; let ax = 0, ay = 0, az = 0; for (const n of nb) { ax += src[n * 3]; ay += src[n * 3 + 1]; az += src[n * 3 + 2] }; ax /= nb.length; ay /= nb.length; az /= nb.length; pos[v * 3] += (ax - src[v * 3]) * lambda; pos[v * 3 + 1] += (ay - src[v * 3 + 1]) * lambda; pos[v * 3 + 2] += (az - src[v * 3 + 2]) * lambda }
  }
  geo.getAttribute('position').needsUpdate = true; geo.computeVertexNormals()
  return geo
}

const clampN = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

/** Vertex-clustering decimation / uniform remesh : snap vertices to a grid of `cells`
 *  per axis, merge each cell to its centroid, remap & drop degenerate triangles. Robust
 *  and topology-agnostic — lowers the polycount a lot. */
export function decimate(g: THREE.BufferGeometry, cells: number): THREE.BufferGeometry {
  const geo = g.getIndex() ? g : weld(g)
  const pos = geo.getAttribute('position').array as Float32Array
  const idx = geo.getIndex()!.array as ArrayLike<number>
  const V = geo.getAttribute('position').count
  geo.computeBoundingBox(); const bb = geo.boundingBox!, min = bb.min, size = bb.getSize(new THREE.Vector3())
  const n = clampN(4, 220, Math.round(cells))
  const cx = (size.x || 1) / n, cy = (size.y || 1) / n, cz = (size.z || 1) / n
  const key = (x: number, y: number, z: number) => `${Math.floor((x - min.x) / cx)}_${Math.floor((y - min.y) / cy)}_${Math.floor((z - min.z) / cz)}`
  const cellOf = new Map<string, { sx: number; sy: number; sz: number; c: number; id: number }>()
  const vCell = new Int32Array(V)
  let next = 0
  for (let v = 0; v < V; v++) { const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2], k = key(x, y, z); let e = cellOf.get(k); if (!e) { e = { sx: 0, sy: 0, sz: 0, c: 0, id: next++ }; cellOf.set(k, e) } e.sx += x; e.sy += y; e.sz += z; e.c++; vCell[v] = e.id }
  const rep = new Float32Array(next * 3); for (const e of cellOf.values()) { rep[e.id * 3] = e.sx / e.c; rep[e.id * 3 + 1] = e.sy / e.c; rep[e.id * 3 + 2] = e.sz / e.c }
  const ni: number[] = []; for (let i = 0; i < idx.length; i += 3) { const a = vCell[idx[i]], b = vCell[idx[i + 1]], c = vCell[idx[i + 2]]; if (a !== b && b !== c && a !== c) ni.push(a, b, c) }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(rep, 3)); out.setIndex(ni); out.computeVertexNormals()
  return out
}

/** Solidify : offset a (thin) surface both ways along its normals + stitch the boundary
 *  edges into side walls → a closed, printable shell. For open surfaces (Möbius, relief…). */
export function thicken(g: THREE.BufferGeometry, t: number): THREE.BufferGeometry {
  const geo = weld(g)
  const pos = geo.getAttribute('position').array as Float32Array
  const nrm = geo.getAttribute('normal').array as Float32Array
  const idx = geo.getIndex()!.array as ArrayLike<number>
  const V = geo.getAttribute('position').count, h = t / 2
  const P: number[] = []
  for (let v = 0; v < V; v++) P.push(pos[v * 3] + nrm[v * 3] * h, pos[v * 3 + 1] + nrm[v * 3 + 1] * h, pos[v * 3 + 2] + nrm[v * 3 + 2] * h)
  for (let v = 0; v < V; v++) P.push(pos[v * 3] - nrm[v * 3] * h, pos[v * 3 + 1] - nrm[v * 3 + 1] * h, pos[v * 3 + 2] - nrm[v * 3 + 2] * h)
  const I: number[] = []
  const edges = new Map<string, { p: number; q: number; c: number }>()
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2]
    I.push(a, b, c, V + a, V + c, V + b)   // front + reversed back
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = p < q ? `${p}_${q}` : `${q}_${p}`; const e = edges.get(k); if (e) e.c++; else edges.set(k, { p, q, c: 1 }) }
  }
  for (const e of edges.values()) if (e.c === 1) I.push(e.p, e.q, V + e.q, e.p, V + e.q, V + e.p)   // side wall
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); out.setIndex(I); out.computeVertexNormals()
  return out
}

export interface MeshStats { tris: number; verts: number; size: [number, number, number]; volume: number; area: number; watertight: boolean; openEdges: number }
export function analyze(g: THREE.BufferGeometry): MeshStats {
  const geo = g.getIndex() ? g : weld(g)
  const idx = geo.getIndex()!.array as ArrayLike<number>
  const pos = geo.getAttribute('position').array as Float32Array
  const tris = idx.length / 3
  const bb = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute)
  const size = bb.getSize(new THREE.Vector3())
  // signed volume (divergence) + area
  let vol = 0, area = 0
  const edges = new Map<string, number>()
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2]
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2], bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2], cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2]
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { const key = p < q ? `${p}_${q}` : `${q}_${p}`; edges.set(key, (edges.get(key) ?? 0) + 1) }
  }
  let openEdges = 0; for (const n of edges.values()) if (n !== 2) openEdges++
  return { tris, verts: geo.getAttribute('position').count, size: [size.x, size.y, size.z], volume: Math.abs(vol), area, watertight: openEdges === 0, openEdges }
}
