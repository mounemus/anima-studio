/** Mesh-space METAMORPHOSES for MORPHOGENESIS STUDIO — parametric geometric deformers
 *  that act directly on ANY mesh (including an imported STL/OBJ/SVG), unlike the field
 *  operators (twist/taper/radial…) which only transform SDF fields. Each returns a NEW
 *  geometry with freshly computed normals, so they chain like any other mesh node. */
import * as THREE from 'three'
import { noiseField } from './fields'

interface Frame { minY: number; h: number; cx: number; cy: number; cz: number; R: number }
function frame(g: THREE.BufferGeometry): Frame {
  g.computeBoundingBox(); const bb = g.boundingBox!
  const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z
  return { minY: bb.min.y, h: Math.max(1e-3, sy), cx: (bb.min.x + bb.max.x) / 2, cy: (bb.min.y + bb.max.y) / 2, cz: (bb.min.z + bb.max.z) / 2, R: Math.max(1e-3, 0.5 * Math.max(sx, sy, sz)) }
}

/** Apply a per-vertex map (position + its normal) → new position; recompute smooth normals. */
function mapVerts(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => [number, number, number]): THREE.BufferGeometry {
  const out = g.clone()
  let nrm = out.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!nrm) { out.computeVertexNormals(); nrm = out.getAttribute('normal') as THREE.BufferAttribute }
  const pos = out.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const r = fn(pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i))
    pos.setXYZ(i, r[0], r[1], r[2])
  }
  pos.needsUpdate = true
  out.computeVertexNormals()
  return out
}

/** Torsion : rotate around Y by an angle growing with height. */
export function twistMesh(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const f = frame(g)
  return mapVerts(g, (x, y, z) => { const a = k * (y - f.cy); const c = Math.cos(a), s = Math.sin(a); const dx = x - f.cx, dz = z - f.cz; return [f.cx + dx * c - dz * s, y, f.cz + dx * s + dz * c] })
}

/** Effiler : shrink the cross-section from bottom (t=0) to top (t=1). */
export function taperMesh(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const f = frame(g)
  return mapVerts(g, (x, y, z) => { const t = (y - f.minY) / f.h; const s = Math.max(0.04, 1 - k * t); return [f.cx + (x - f.cx) * s, y, f.cz + (z - f.cz) * s] })
}

/** Courber : progressive curl — each vertex rotates in the XY plane by an angle set by its height. */
export function bendMesh(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const f = frame(g)
  return mapVerts(g, (x, y, z) => { const dx = x - f.cx, dy = y - f.cy; const a = k * (dy / f.h); const c = Math.cos(a), s = Math.sin(a); return [f.cx + dx * c - dy * s, f.cy + dx * s + dy * c, z] })
}

/** Cisailler : lateral shift proportional to height (leans the form). */
export function shearMesh(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const f = frame(g)
  return mapVerts(g, (x, y, z) => [x + k * (y - f.cy), y, z])
}

/** Gonfler / dégonfler : push every vertex along its normal (k>0 inflate, k<0 shrink). */
export function inflateMesh(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  return mapVerts(g, (x, y, z, nx, ny, nz) => [x + nx * k, y + ny * k, z + nz * k])
}

/** Sphérifier : morph toward the bounding sphere by amount k∈[0,1]. */
export function spherifyMesh(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const f = frame(g)
  return mapVerts(g, (x, y, z) => {
    const dx = x - f.cx, dy = y - f.cy, dz = z - f.cz, len = Math.hypot(dx, dy, dz) || 1e-6
    const sx = f.cx + (dx / len) * f.R, sy = f.cy + (dy / len) * f.R, sz = f.cz + (dz / len) * f.R
    return [x + (sx - x) * k, y + (sy - y) * k, z + (sz - z) * k]
  })
}

/** Arabesque : interlacing sinusoidal relief along the surface normal — two interfering
 *  waves (around the vertical axis × along the height) weave an ornamental pattern. */
export function arabesqueMesh(g: THREE.BufferGeometry, amp: number, freq: number, twist: number): THREE.BufferGeometry {
  const f = frame(g)
  return mapVerts(g, (x, y, z, nx, ny, nz) => {
    const ang = Math.atan2(z - f.cz, x - f.cx), t = (y - f.minY) / f.h
    const d = amp * 0.5 * (Math.sin(freq * ang + twist * Math.PI * 2 * t) + Math.sin(freq * 2 * Math.PI * t - ang))
    return [x + nx * d, y + ny * d, z + nz * d]
  })
}

/** Organique : fractal-noise (fBm) displacement along the normal — living, irregular skin. */
export function organicMesh(g: THREE.BufferGeometry, amp: number, freq: number, seed: number): THREE.BufferGeometry {
  const o = (seed % 97) * 1.37
  return mapVerts(g, (x, y, z, nx, ny, nz) => {
    const d = amp * noiseField('fbm', x * freq + o, y * freq + o * 1.3, z * freq + o * 2.1)
    return [x + nx * d, y + ny * d, z + nz * d]
  })
}

/** Onduler : concentric ripples (height + radius) along the normal. */
export function rippleMesh(g: THREE.BufferGeometry, amp: number, freq: number): THREE.BufferGeometry {
  const f = frame(g)
  return mapVerts(g, (x, y, z, nx, ny, nz) => {
    const r = Math.hypot(x - f.cx, z - f.cz), t = (y - f.minY) / f.h
    const d = amp * Math.sin(freq * (r + t) * Math.PI * 2)
    return [x + nx * d, y + ny * d, z + nz * d]
  })
}

/** Moucharabieh : radial interlaced lattice — two counter-rotating angular×height wave
 *  families multiply into a diamond net of raised ribs (pierced-screen ornament). */
export function moucharabiehMesh(g: THREE.BufferGeometry, amp: number, nrad: number, nh: number): THREE.BufferGeometry {
  const f = frame(g)
  return mapVerts(g, (x, y, z, nx, ny, nz) => {
    const ang = Math.atan2(z - f.cz, x - f.cx), t = (y - f.minY) / f.h
    const a = Math.cos(nrad * ang + nh * Math.PI * 2 * t), b = Math.cos(nrad * ang - nh * Math.PI * 2 * t)
    const grid = a * b                       // diamond lattice in [-1,1]
    const d = amp * Math.sign(grid) * Math.sqrt(Math.abs(grid))   // crisper ribs
    return [x + nx * d, y + ny * d, z + nz * d]
  })
}

/** Plissé : accordion pleats — a triangular wave of the azimuth displaces vertices
 *  radially into sharp vertical folds (fan / pleated-skirt look). */
export function pleatMesh(g: THREE.BufferGeometry, amp: number, folds: number): THREE.BufferGeometry {
  const f = frame(g)
  return mapVerts(g, (x, y, z) => {
    const dx = x - f.cx, dz = z - f.cz, r = Math.hypot(dx, dz)
    const ang = Math.atan2(dz, dx)
    const ph = folds * (ang / (Math.PI * 2))
    const tri = 2 * Math.abs(ph - Math.round(ph)) - 0.5   // triangle wave, centered
    const d = amp * tri * 2
    if (r < 1e-5) return [x, y, z]
    return [x + (dx / r) * d, y, z + (dz / r) * d]
  })
}

/** Cristallin : facet the surface by snapping vertices toward a coarse 3D lattice
 *  (k = amount, cells = lattice fineness) → angular, gem-like faceting. */
export function crystallizeMesh(g: THREE.BufferGeometry, k: number, cells: number): THREE.BufferGeometry {
  const f = frame(g)
  const s = Math.max(2, cells) / (2 * f.R)   // lattice spacing relative to size
  return mapVerts(g, (x, y, z) => {
    const qx = Math.round(x * s) / s, qy = Math.round(y * s) / s, qz = Math.round(z * s) / s
    return [x + (qx - x) * k, y + (qy - y) * k, z + (qz - z) * k]
  })
}
