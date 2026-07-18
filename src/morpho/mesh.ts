/** Mesh utilities for MORPHOGENESIS STUDIO : welding, smoothing, and a fabrication /
 *  quality analysis (poly count, bounds, volume, watertightness). */
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export function weld(g: THREE.BufferGeometry): THREE.BufferGeometry { const w = mergeVertices(g, 1e-4); w.computeVertexNormals(); return w }

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
