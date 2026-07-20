/**
 * Studio de Poterie virtuel — tour de potier tourné aux deux mains (webcam + MediaPipe).
 *
 * SIMULATION FIABLE. Une argile qui tourne vite sur un tour est, par nature, une SURFACE
 * DE RÉVOLUTION : sa forme = un profil radial. On la modélise donc par deux profils —
 * rayon extérieur rOut[i] et rayon intérieur rIn[i] pour chaque anneau de hauteur i —
 * et le maillage est la révolution de ces profils. C'est stable, rapide, et toujours
 * parfaitement symétrique (comme du vrai tournage), sans soft-body 3D coûteux.
 *
 * DEUX MAINS = calipers. La main proche de l'axe pousse la paroi INTÉRIEURE, la main
 * éloignée pousse la paroi EXTÉRIEURE, à la hauteur des mains. Monter les mains ensemble
 * « monte » la paroi. La conservation du volume (option) fait grandir la pièce quand on
 * affine les parois — exactement comme l'argile réelle.
 *
 * Options avancées : vitesse du tour, masse d'argile, lissage (eau), conservation du
 * volume, et outils de sculpture (monter, ouvrir, élargir, resserrer, lisser, trancher).
 * Export .stl / .glb (vase étanche), capture PNG, enregistrement vidéo WebM.
 *
 * Studio autonome. Route /pottery, protégée par FrontGate.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import * as THREE from 'three'
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const GESTURE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'

const TIP_THUMB = 4, TIP_INDEX = 8, MID_MCP = 9, WRIST = 0
const FINGER_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

// ── Clay profile discretisation ──────────────────────────────────────────────
export const NR = 140          // height rings
const NS = 80           // angular segments
const Y0 = -0.9         // wheel plate height (world Y of the base)
const HMAX = 1.7        // max clay height (world units)
export const DY = HMAX / (NR - 1)
const MAXR = 1.15       // max radius
const MINWALL = 0.03    // min wall thickness (clay can't tear to zero)
const FLOOR_RINGS = 4   // bottom rings kept solid (closed floor)
const EPS = 0.006
export const VOL_K = 0.245     // world-volume per "kg" of clay (mass 1 → a ~0.5-radius lump)

type Tool = 'pull' | 'open' | 'widen' | 'collar' | 'rib' | 'trim'
const TOOLS: { kind: Tool; label: string; hint: string }[] = [
  { kind: 'pull', label: '✋ Monter / centrer', hint: 'Deux mains en pince encadrent la paroi (int. + ext.) ; monte les mains pour monter la paroi.' },
  { kind: 'open', label: '👇 Ouvrir', hint: 'Une main au centre, descends : creuse le godet depuis le haut.' },
  { kind: 'widen', label: '🫄 Élargir (ventre)', hint: 'Pousse la paroi vers l\'extérieur à la hauteur des mains.' },
  { kind: 'collar', label: '🫗 Resserrer (col)', hint: 'Referme la paroi (col de vase) à la hauteur des mains.' },
  { kind: 'rib', label: '🧽 Lisser', hint: 'Lisse fortement la paroi localement.' },
  { kind: 'trim', label: '🔪 Trancher', hint: 'Coupe l\'argile au-dessus de la main (araser le bord).' },
]

export type DecorType = 'none' | 'flutes' | 'facets' | 'martele' | 'strie'
export const DECORS: { type: DecorType; label: string }[] = [
  { type: 'none', label: 'Lisse' }, { type: 'flutes', label: 'Cannelures' }, { type: 'facets', label: 'Facettes' },
  { type: 'martele', label: 'Martelé' }, { type: 'strie', label: 'Strié' },
]
export interface Deco { type: DecorType; count: number; depth: number; foot: number; spout: number; handles: number; handleSize: number }
export const DECO0: Deco = { type: 'none', count: 8, depth: 0.06, foot: 0, spout: 0, handles: 0, handleSize: 0.5 }
const hash2 = (a: number, b: number) => { let h = (a * 374761393 + b * 668265263) >>> 0; h = ((h ^ (h >> 13)) * 1274126177) >>> 0; return (h >>> 0) / 4294967296 }

/** Radius factor at (angle a, ring i) from the surface décor + foot + spout. */
function wallFactor(a: number, i: number, top: number, d: Deco): number {
  let f = 1
  const t = top > 0 ? i / top : 0
  if (d.depth > 0.001 && d.count >= 2) {
    if (d.type === 'flutes') f *= 1 + d.depth * Math.cos(d.count * a)
    else if (d.type === 'facets') { const seg = (Math.PI * 2) / d.count, aa = (((a % seg) + seg) % seg) - seg / 2; f *= 1 - d.depth + d.depth * (Math.cos(Math.PI / d.count) / Math.cos(aa)) }
    else if (d.type === 'strie') f *= 1 + d.depth * 0.6 * Math.sin(t * d.count * Math.PI * 2)
    else if (d.type === 'martele') f *= 1 + d.depth * (hash2(Math.floor((a / (Math.PI * 2)) * d.count * 2), Math.floor(t * d.count * 2)) - 0.5) * 1.4
  }
  if (d.foot > 0.001 && t < 0.14) f *= 1 - d.foot * 0.45 * Math.sin((t / 0.14) * Math.PI)   // recess above base → foot ring
  if (d.spout > 0.001 && t > 0.78) f *= 1 + d.spout * 0.55 * Math.pow(Math.max(0, Math.cos(a)), 6) * ((t - 0.78) / 0.22)   // pour lip sector
  return f
}
const rimLift = (a: number, i: number, top: number, d: Deco): number => (d.spout > 0.001 && top > 0 && i / top > 0.9 ? d.spout * 0.16 * Math.pow(Math.max(0, Math.cos(a)), 6) * ((i / top - 0.9) / 0.1) : 0)

/** Curved tube handles (anses) bowing out from the outer wall, `n` evenly around. */
function appendHandles(pos: number[], idx: number[], rOut: Float32Array, top: number, d: Deco) {
  const n = Math.round(d.handles); if (n < 1 || top < 8) return
  const TUBE = 8, ARC = 16, tubeR = 0.028 + d.handleSize * 0.045, bow = 0.26 + d.handleSize * 0.4
  const iUp = Math.round(top * 0.72), iLo = Math.round(top * 0.4)
  const yUp = Y0 + iUp * DY, yLo = Y0 + iLo * DY
  for (let h = 0; h < n; h++) {
    const ang = (h / n) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang)
    const p0 = new THREE.Vector3(ca * rOut[iUp], yUp, sa * rOut[iUp]), p3 = new THREE.Vector3(ca * rOut[iLo], yLo, sa * rOut[iLo])
    const rMid = Math.max(rOut[iUp], rOut[iLo]) + bow, mid = new THREE.Vector3(ca * rMid, (yUp + yLo) / 2, sa * rMid)
    const centers: THREE.Vector3[] = []
    for (let s = 0; s <= ARC; s++) { const u = s / ARC; centers.push(p0.clone().lerp(mid, u).lerp(mid.clone().lerp(p3, u), u)) }
    const base = pos.length / 3
    for (let s = 0; s <= ARC; s++) {
      const c = centers[s], tan = centers[Math.min(ARC, s + 1)].clone().sub(centers[Math.max(0, s - 1)]).normalize()
      const up = Math.abs(tan.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
      const nrm = new THREE.Vector3().crossVectors(tan, up).normalize(), bnm = new THREE.Vector3().crossVectors(tan, nrm).normalize()
      for (let k = 0; k < TUBE; k++) { const th = (k / TUBE) * Math.PI * 2, ox = nrm.x * Math.cos(th) * tubeR + bnm.x * Math.sin(th) * tubeR, oy = nrm.y * Math.cos(th) * tubeR + bnm.y * Math.sin(th) * tubeR, oz = nrm.z * Math.cos(th) * tubeR + bnm.z * Math.sin(th) * tubeR; pos.push(c.x + ox, c.y + oy, c.z + oz) }
    }
    for (let s = 0; s < ARC; s++) for (let k = 0; k < TUBE; k++) { const kn = (k + 1) % TUBE, a0 = base + s * TUBE + k, b0 = base + s * TUBE + kn, c0 = base + (s + 1) * TUBE + k, d0 = base + (s + 1) * TUBE + kn; idx.push(a0, c0, b0, b0, c0, d0) }
  }
}

/** Surface-of-revolution mesh from the outer/inner radial profiles + décor (texture,
 *  foot, spout, handles). Outer wall + inner wall + base + rim. Double-sided. */
export function buildPotGeometry(rOut: Float32Array, rIn: Float32Array, top: number, deco: Deco = DECO0): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = []
  const outerBase: number[] = [], innerBase: number[] = [], hasInner: boolean[] = []
  for (let i = 0; i <= top; i++) {
    const y = Y0 + i * DY
    outerBase[i] = pos.length / 3
    for (let j = 0; j < NS; j++) { const a = (j / NS) * Math.PI * 2, r = rOut[i] * wallFactor(a, i, top, deco); pos.push(Math.cos(a) * r, y + rimLift(a, i, top, deco), Math.sin(a) * r) }
    const inner = rIn[i] > EPS
    hasInner[i] = inner
    if (inner) { innerBase[i] = pos.length / 3; for (let j = 0; j < NS; j++) { const a = (j / NS) * Math.PI * 2, r = rIn[i] * wallFactor(a, i, top, deco); pos.push(Math.cos(a) * r, y + rimLift(a, i, top, deco), Math.sin(a) * r) } }
    else innerBase[i] = -1
  }
  // outer wall
  for (let i = 0; i < top; i++) for (let j = 0; j < NS; j++) { const jn = (j + 1) % NS; const a = outerBase[i] + j, b = outerBase[i] + jn, c = outerBase[i + 1] + j, d = outerBase[i + 1] + jn; idx.push(a, c, b, b, c, d) }
  // inner wall (bore) where both consecutive rings are open
  for (let i = 0; i < top; i++) if (hasInner[i] && hasInner[i + 1]) for (let j = 0; j < NS; j++) { const jn = (j + 1) % NS; const a = innerBase[i] + j, b = innerBase[i] + jn, c = innerBase[i + 1] + j, d = innerBase[i + 1] + jn; idx.push(a, b, c, b, d, c) }
  // base disc (solid floor)
  { const cy = pos.length / 3; pos.push(0, Y0, 0); for (let j = 0; j < NS; j++) { const jn = (j + 1) % NS; idx.push(cy, outerBase[0] + jn, outerBase[0] + j) } }
  let boreBottom = -1
  for (let i = 0; i <= top; i++) if (hasInner[i]) { boreBottom = i; break }
  if (boreBottom >= 0) {
    // cap the bottom of the bore
    const y = Y0 + boreBottom * DY, cy = pos.length / 3; pos.push(0, y, 0)
    for (let j = 0; j < NS; j++) { const jn = (j + 1) % NS; idx.push(cy, innerBase[boreBottom] + j, innerBase[boreBottom] + jn) }
    if (hasInner[top]) { for (let j = 0; j < NS; j++) { const jn = (j + 1) % NS; const o = outerBase[top] + j, on = outerBase[top] + jn, ii = innerBase[top] + j, in2 = innerBase[top] + jn; idx.push(o, ii, on, on, ii, in2) } }
    else { const cy2 = pos.length / 3; pos.push(0, Y0 + top * DY, 0); for (let j = 0; j < NS; j++) { const jn = (j + 1) % NS; idx.push(cy2, outerBase[top] + j, outerBase[top] + jn) } }
  } else { const cy2 = pos.length / 3; pos.push(0, Y0 + top * DY, 0); for (let j = 0; j < NS; j++) { const jn = (j + 1) % NS; idx.push(cy2, outerBase[top] + jn, outerBase[top] + j) } }
  appendHandles(pos, idx, rOut, top, deco)
  // UVs (u = angle around, v = height) so glaze/Raku textures map & export in the GLB.
  const uv: number[] = []
  for (let vi = 0; vi < pos.length / 3; vi++) { const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2]; uv.push(Math.atan2(z, x) / (Math.PI * 2) + 0.5, (y - Y0) / HMAX) }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals()
  return g
}

export type StartShape = 'motte' | 'cylindre' | 'bol' | 'assiette' | 'vase' | 'bouteille'
export const START_SHAPES: { kind: StartShape; label: string }[] = [
  { kind: 'motte', label: '🟤 Motte' }, { kind: 'cylindre', label: '⬛ Cylindre' }, { kind: 'bol', label: '🥣 Bol' },
  { kind: 'assiette', label: '🍽 Assiette' }, { kind: 'vase', label: '⚱️ Vase' }, { kind: 'bouteille', label: '🍾 Bouteille' },
]
/** Write a starting profile into rOut/rIn (length NR) and return `top`. Hollow shapes get a
 *  wall + solid floor. All are volume-normalised to VOL_K·mass so the conservation loop
 *  keeps them intact instead of extruding/shaving the rim. */
export function startProfile(kind: StartShape, mass: number, rOut: Float32Array, rIn: Float32Array): number {
  const V0 = VOL_K * mass
  rOut.fill(0); rIn.fill(0)
  const scale = clamp(0.7, 1.4, Math.cbrt(mass))
  if (kind === 'motte') {
    const R = Math.min(0.72, Math.cbrt(V0 / (0.625 * Math.PI))), domeH = R * 1.25
    const top = clamp(6, NR - 2, Math.round(domeH / DY))
    for (let i = 0; i <= top; i++) { const h = i * DY; rOut[i] = Math.max(0.02, R * Math.sqrt(clamp(0, 1, 1 - h / domeH))); rIn[i] = 0 }
    return top
  }
  let H: number, fOut: (t: number) => number, wall = 0.06 * scale
  if (kind === 'cylindre') { H = 1.15 * scale; fOut = () => 0.5 * scale }
  else if (kind === 'bol') { H = 0.62 * scale; fOut = (t) => (0.34 + 0.55 * Math.sqrt(t)) * scale }
  else if (kind === 'assiette') { H = 0.3 * scale; fOut = (t) => (0.32 + 0.78 * t) * scale; wall = 0.05 * scale }
  else if (kind === 'vase') { H = 1.42 * scale; fOut = (t) => (0.26 + 0.44 * Math.sin(Math.PI * clamp(0, 1, t * 0.92 + 0.06))) * scale }
  else { H = 1.5 * scale; fOut = (t) => (t < 0.7 ? 0.3 + 0.3 * Math.sin(Math.PI * (t / 0.7)) : 0.12) * scale }   // bouteille
  const top = clamp(6, NR - 2, Math.round(Math.min(HMAX * 0.98, H) / DY))
  for (let i = 0; i <= top; i++) {
    const ro = clamp(0.05, MAXR, fOut(i / top))
    rOut[i] = ro
    rIn[i] = i < FLOOR_RINGS ? 0 : Math.max(0, ro - Math.max(MINWALL, wall))
  }
  // Normalise to the target volume by scaling radii (area ∝ r²), keeping the silhouette.
  let v = 0; for (let i = 0; i <= top; i++) v += Math.PI * Math.max(0, rOut[i] * rOut[i] - rIn[i] * rIn[i]) * DY
  if (v > 1e-6) { const s = clamp(0.5, 1.8, Math.sqrt(V0 / v)); for (let i = 0; i <= top; i++) { rOut[i] = clamp(0.02, MAXR, rOut[i] * s); rIn[i] = i < FLOOR_RINGS ? 0 : clamp(0, rOut[i] - MINWALL, rIn[i] * s) } }
  return top
}

// ── Cuisson & émaillage ────────────────────────────────────────────────────────
export type Glaze = 'terre' | 'brillant' | 'mat' | 'celadon' | 'metal' | 'raku'
export const GLAZES: { kind: Glaze; label: string }[] = [
  { kind: 'terre', label: '🟫 Terre crue' }, { kind: 'brillant', label: '✨ Émail brillant' }, { kind: 'mat', label: '🥚 Émail mat' },
  { kind: 'celadon', label: '🫧 Céladon' }, { kind: 'metal', label: '🪙 Métallique' }, { kind: 'raku', label: '🔥 Raku' },
]
export interface GlazeOpts { crackle: number; carbon: number; lustre: number }

// ── Procedural noise (JS) for BAKING the Raku into a texture (so it exports in the GLB
//    and can be multi-scale/fractal, not a flat monotone Voronoï). ──
const smooth01 = (a: number, b: number, x: number) => { const t = clamp(0, 1, (x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t) }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const hi = (x: number, y: number, z: number) => { let h = ((x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647) >>> 0; h = ((h ^ (h >> 13)) * 1274126177) >>> 0; return (h >>> 0) / 4294967296 }
function vnoise(x: number, y: number, z: number) { const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi; const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf); const lp = (a: number, b: number, t: number) => a + (b - a) * t; const c = (dx: number, dy: number, dz: number) => hi(xi + dx, yi + dy, zi + dz); return lp(lp(lp(c(0, 0, 0), c(1, 0, 0), u), lp(c(0, 1, 0), c(1, 1, 0), u), v), lp(lp(c(0, 0, 1), c(1, 0, 1), u), lp(c(0, 1, 1), c(1, 1, 1), u), v), w) }
function fbm3(x: number, y: number, z: number) { let a = 0.5, s = 0; for (let i = 0; i < 5; i++) { s += a * vnoise(x, y, z); x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5 } return s }
function cellEdge(x: number, y: number, z: number) { const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z); let f1 = 9, f2 = 9; for (let dx = -1; dx <= 1; dx++)for (let dy = -1; dy <= 1; dy++)for (let dz = -1; dz <= 1; dz++) { const gx = xi + dx, gy = yi + dy, gz = zi + dz, ox = hi(gx, gy, gz), oy = hi(gy, gz, gx), oz = hi(gz, gx, gy), ex = gx + ox - x, ey = gy + oy - y, ez = gz + oz - z, d = ex * ex + ey * ey + ez * ez; if (d < f1) { f2 = f1; f1 = d } else if (d < f2) f2 = d } return Math.sqrt(f2) - Math.sqrt(f1) }

/** Bake a realistic Raku glaze into a seamless texture (cylinder-sampled) — multi-scale
 *  crackle (big + fine cracks), carbon smoke zones, copper lustre patches. Exportable. */
export function bakeRakuTexture(color: string, o: GlazeOpts, seed: number, res = 512): THREE.Texture | null {
  if (typeof document === 'undefined') return null
  const H = clamp(128, 1024, res), W = H * 2, cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const ctx = cv.getContext('2d'); if (!ctx) return null
  const img = ctx.createImageData(W, H), d = img.data, S = (seed % 500) * 0.137 + 1.7
  const base = new THREE.Color(color), cream = new THREE.Color(0xeae3d2)
  const bR = lerp(cream.r, base.r, 0.28), bG = lerp(cream.g, base.g, 0.28), bB = lerp(cream.b, base.b, 0.28)
  const scales = [[3.0, 0.05, 1.0], [6.2, 0.032, 0.85], [12.5, 0.02, 0.6], [22, 0.013, 0.4]]   // fractal crack octaves
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const u = px / W, v = py / H, ang = u * Math.PI * 2, cx = Math.cos(ang), cz = Math.sin(ang), yy = v * 1.7
    const warp = fbm3(cx * 2.2 + S, yy * 2.2 + S, cz * 2.2 + S) * 0.35            // domain warp → irregular cells
    const mott = fbm3(cx * 4 + S * 2, yy * 4 + S * 2, cz * 4 + S * 2)
    let R = bR - mott * 0.05, G = bG - mott * 0.05, B = bB - mott * 0.06
    let crack = 0
    for (const [sc, th, amt] of scales) { const e = cellEdge(cx * sc + warp + S, yy * sc + warp + S, cz * sc + warp + S); crack = Math.max(crack, (1 - smooth01(0, th, e)) * amt) }
    const ck = crack * o.crackle
    const carbon = smooth01(0.52, 0.86, fbm3(cx * 1.7 + S * 3, yy * 1.7 + S * 3, cz * 1.7 + S * 3)) * o.carbon
    const cu = smooth01(0.58, 0.9, fbm3(cx * 2.6 + S * 4, yy * 2.6 + S * 4, cz * 2.6 + S * 4)) * o.lustre
    R = lerp(R, 0.09, ck); G = lerp(G, 0.06, ck); B = lerp(B, 0.05, ck)                 // carbon-filled crack lines
    R = lerp(R, 0.045, carbon); G = lerp(G, 0.045, carbon); B = lerp(B, 0.052, carbon)  // smoked black zones
    R = lerp(R, 0.74, cu * 0.55); G = lerp(G, 0.42, cu * 0.55); B = lerp(B, 0.30, cu * 0.55) // copper patches
    const off = (py * W + px) * 4; d[off] = R * 255; d[off + 1] = G * 255; d[off + 2] = B * 255; d[off + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.RepeatWrapping; tex.anisotropy = 4
  return tex
}

export function makeGlaze(kind: Glaze, color: string, o: GlazeOpts, seed: number, rakuRes = 384): THREE.Material {
  const c = new THREE.Color(color)
  if (kind === 'terre') return new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide })
  if (kind === 'mat') return new THREE.MeshStandardMaterial({ color: c, roughness: 0.96, metalness: 0.0, side: THREE.DoubleSide })
  if (kind === 'brillant') return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.12, metalness: 0.0, clearcoat: 0.9, clearcoatRoughness: 0.08, envMapIntensity: 1.1, side: THREE.DoubleSide })
  if (kind === 'celadon') return new THREE.MeshPhysicalMaterial({ color: new THREE.Color(0x9fd8c8).lerp(c, 0.35), roughness: 0.14, metalness: 0, transmission: 0.34, thickness: 0.6, ior: 1.5, clearcoat: 0.85, clearcoatRoughness: 0.1, envMapIntensity: 1.1, transparent: true, side: THREE.FrontSide })
  if (kind === 'metal') return new THREE.MeshStandardMaterial({ color: c, roughness: 0.28, metalness: 0.95, envMapIntensity: 1.3, side: THREE.DoubleSide })
  // ── Raku ── baked into a texture → realistic multi-scale crackle AND exportable (GLB).
  const tex = bakeRakuTexture(color, o, seed, rakuRes)
  const m = new THREE.MeshPhysicalMaterial({ color: tex ? new THREE.Color(0xffffff) : c, map: tex, roughness: 0.42, metalness: 0.22 + 0.4 * o.lustre, clearcoat: 0.5, clearcoatRoughness: 0.28, envMapIntensity: 1.15, side: THREE.DoubleSide })
  m.iridescence = clamp(0, 1, o.lustre * 0.6); m.iridescenceIOR = 1.3; m.iridescenceThicknessRange = [120, 400]
  m.userData.raku = true
  return m
}

export function PotteryStudio() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const [wheelSpeed, setWheelSpeed] = useState(1.2)
  const [clayMass, setClayMass] = useState(1)
  const [smoothing, setSmoothing] = useState(0.5)
  const [conserve, setConserve] = useState(true)
  const [tool, setTool] = useState<Tool>('pull')
  const [strength, setStrength] = useState(0.6)
  const [firmness, setFirmness] = useState(0.5)
  const [decorType, setDecorType] = useState<DecorType>('none')   // surface texture
  const [flutes, setFlutes] = useState(8)          // décor count (flutes / facets / density)
  const [fluteDepth, setFluteDepth] = useState(0.06)
  const [foot, setFoot] = useState(0)              // pied tourné (0 = off)
  const [spout, setSpout] = useState(0)            // bec verseur (0 = off)
  const [handles, setHandles] = useState(0)        // anses (0-3)
  const [handleSize, setHandleSize] = useState(0.5)
  const [glaze, setGlaze] = useState<Glaze>('terre')   // cuisson & émaillage
  const [crackle, setCrackle] = useState(0.6)      // raku : craquelure
  const [carbon, setCarbon] = useState(0.5)        // raku : enfumage
  const [lustre, setLustre] = useState(0.7)        // raku : lustre métallique irisé
  const [rakuSeed, setRakuSeed] = useState(1)      // re-roll on each "cuire" → aléatoire
  const [clayColor, setClayColor] = useState('#b5651d')
  const [wireframe, setWireframe] = useState(false)
  const [showGuides, setShowGuides] = useState(true)
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [showMeasure, setShowMeasure] = useState(true)
  const [bgMode, setBgMode] = useState<'webcam' | 'black'>('webcam')
  const [panelOpen, setPanelOpen] = useState(true)
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState('Initialisation de la caméra et du modèle…')
  const [error, setError] = useState<string | null>(null)

  const paramsRef = useRef({ wheelSpeed, clayMass, smoothing, conserve, tool, strength, firmness, decorType, flutes, fluteDepth, foot, spout, handles, handleSize, glaze, crackle, carbon, lustre, rakuSeed, clayColor, wireframe, showGuides, showSkeleton, showMeasure, bgMode })
  paramsRef.current = { wheelSpeed, clayMass, smoothing, conserve, tool, strength, firmness, decorType, flutes, fluteDepth, foot, spout, handles, handleSize, glaze, crackle, carbon, lustre, rakuSeed, clayColor, wireframe, showGuides, showSkeleton, showMeasure, bgMode }
  const resetRef = useRef(false)         // reset to a fresh lump
  const startRef = useRef<StartShape | null>(null)   // apply a starting shape
  const trueRef = useRef(false)          // "régulariser" : strongly true-up the profile
  const undoRef = useRef(false), redoRef = useRef(false)
  const exportRef = useRef<null | 'stl' | 'glb'>(null)
  const recCtl = useRef<{ start: () => void; stop: () => void } | null>(null)

  useEffect(() => {
    const video = videoRef.current!, mount = mountRef.current!, overlay = overlayRef.current!
    const octx = overlay.getContext('2d')!
    let landmarker: GestureRecognizer | null = null, stream: MediaStream | null = null
    let rafId = 0, running = true, lastVideoTime = -1

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100)
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
    renderer.setClearColor(0x000000, 0); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement); renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100vw;height:100vh;touch-action:none;user-select:none;'
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const key = new THREE.DirectionalLight(0xfff2e0, 1.0); key.position.set(1.5, 2.5, 2.2); scene.add(key)
    const fill = new THREE.DirectionalLight(0x88bbff, 0.35); fill.position.set(-2, 0.5, -1); scene.add(fill)
    // IBL environment — makes émail/métallique/Raku reflections & iridescence read properly.
    const pmrem = new THREE.PMREMGenerator(renderer); pmrem.compileEquirectangularShader()
    let envTex: THREE.Texture | null = null
    try { envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environment = envTex } catch { /* noop */ }

    // Spinning wheel : plate + a notch marker + the clay mesh, all rotating about Y.
    const spin = new THREE.Group(); scene.add(spin)
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.0, 0.09, 64), new THREE.MeshStandardMaterial({ color: 0x333842, roughness: 0.7, metalness: 0.3 }))
    plate.position.y = Y0 - 0.055; spin.add(plate)
    const notch = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.14), new THREE.MeshStandardMaterial({ color: 0x00e0c0, roughness: 0.4 }))
    notch.position.set(0.78, Y0 - 0.03, 0); spin.add(notch)
    const clayMesh = new THREE.Mesh(new THREE.BufferGeometry(), makeGlaze('terre', clayColor, { crackle, carbon, lustre }, 1)); clayMesh.frustumCulled = false; spin.add(clayMesh)
    let lastGlazeSig = ''

    // ── Clay state (radial profiles) ──
    const rOut = new Float32Array(NR), rIn = new Float32Array(NR)
    let top = 10, V0 = 0.245, wheelAngle = 0

    const volume = () => { let v = 0; for (let i = 0; i <= top; i++) v += Math.PI * Math.max(0, rOut[i] * rOut[i] - rIn[i] * rIn[i]) * DY; return v }
    const applyStart = (kind: StartShape, mass: number) => { top = startProfile(kind, mass, rOut, rIn); V0 = volume() }
    const resetClay = (mass: number) => applyStart('motte', mass)
    resetClay(clayMass)

    // Full 3D orbit around the pot. The shaping plane follows the camera azimuth, so
    // changing the view angle genuinely changes where/how the fingers sculpt.
    const target = new THREE.Vector3(0, Y0 + HMAX * 0.42, 0)
    let camDist = 3.0, camAz = 0, camPolar = 1.12   // polar : 0.3 (top-down) … 1.5 (side)
    const applyCam = () => { const sp = Math.sin(camPolar), cp = Math.cos(camPolar); camera.position.set(target.x + camDist * sp * Math.sin(camAz), target.y + camDist * cp, target.z + camDist * sp * Math.cos(camAz)); camera.lookAt(target) }
    applyCam()

    const resize = () => { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); overlay.width = w; overlay.height = h }
    resize(); window.addEventListener('resize', resize)

    // Souris + tactile — pilotage SANS webcam. 1 doigt / clic gauche = façonner (le loop
    // ci-dessous synthétise un contact depuis `mouseNDC`) ; clic droit / 2 doigts = orbite
    // + pinch-zoom. Molette = zoom.
    let mouseNDC: { x: number; y: number } | null = null
    const el = renderer.domElement
    const ptrs = new Map<number, { x: number; y: number }>()
    let orbitDrag = false, lastX = 0, lastY = 0, pinchD = 0
    const toNDC = (e: PointerEvent) => { mouseNDC = { x: (e.clientX / window.innerWidth) * 2 - 1, y: -((e.clientY / window.innerHeight) * 2 - 1) } }
    const onDown = (e: PointerEvent) => { el.setPointerCapture?.(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (ptrs.size === 2) { const p = [...ptrs.values()]; pinchD = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); lastX = (p[0].x + p[1].x) / 2; lastY = (p[0].y + p[1].y) / 2; mouseNDC = null; orbitDrag = false; return }
      if (e.pointerType === 'mouse' && e.button === 2) { orbitDrag = true; lastX = e.clientX; lastY = e.clientY } else toNDC(e) }
    const onMove = (e: PointerEvent) => { if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (ptrs.size >= 2) { const p = [...ptrs.values()]; const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); const mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2; if (pinchD > 0) camDist = clamp(1.6, 6, camDist * (pinchD / Math.max(1, d))); camAz -= (mx - lastX) * 0.006; camPolar = clamp(0.32, 1.5, camPolar - (my - lastY) * 0.006); pinchD = d; lastX = mx; lastY = my; return }
      if (orbitDrag) { camAz -= (e.clientX - lastX) * 0.006; camPolar = clamp(0.32, 1.5, camPolar - (e.clientY - lastY) * 0.006); lastX = e.clientX; lastY = e.clientY } else if (mouseNDC) toNDC(e) }
    const onUp = (e: PointerEvent) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinchD = 0; if (ptrs.size === 0) { orbitDrag = false; mouseNDC = null } }
    const onWheel = (e: WheelEvent) => { camDist = clamp(1.6, 6, camDist + e.deltaY * 0.002) }
    el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp); el.addEventListener('wheel', onWheel, { passive: true }); el.addEventListener('contextmenu', (ev) => ev.preventDefault())

    // One-Euro smoothing per hand (screen space).
    type Euro = { first: boolean; x: number; y: number; dx: number; dy: number }
    const mkEuro = (): Euro => ({ first: true, x: 0, y: 0, dx: 0, dy: 0 })
    const euA = (cut: number, dt: number) => { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt) }
    const euro2 = (e: Euro, x: number, y: number, dt: number) => {
      if (e.first) { e.x = x; e.y = y; e.dx = e.dy = 0; e.first = false; return { x, y } }
      const beta = 0.01, aD = euA(1.0, dt)
      e.dx = aD * ((x - e.x) / dt) + (1 - aD) * e.dx; e.dy = aD * ((y - e.y) / dt) + (1 - aD) * e.dy
      e.x += euA(1.6 + beta * Math.abs(e.dx), dt) * (x - e.x); e.y += euA(1.6 + beta * Math.abs(e.dy), dt) * (y - e.y)
      return { x: e.x, y: e.y }
    }
    const euroA = mkEuro(), euroB = mkEuro()

    const proj = (x: number, y: number, z: number) => { const p = new THREE.Vector3(x, y, z).project(camera); return { x: (p.x * 0.5 + 0.5) * overlay.width, y: (1 - (p.y * 0.5 + 0.5)) * overlay.height } }

    // Precise finger → clay mapping. Cast a ray from the camera through the fingertip and
    // intersect the CUTTING PLANE — the vertical plane through the wheel axis that faces
    // the camera. As the view orbits, this plane rotates with it, so the inclination of the
    // view genuinely changes where the finger lands (height + radius) on the clay.
    const raycaster = new THREE.Raycaster()
    const _plane = new THREE.Plane()
    const mapFinger = (ndcX: number, ndcY: number): { rad: number; ring: number } | null => {
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera)
      // Frontal cross-section plane : contains the Y axis, normal points TOWARD the camera
      // (sin az,0,cos az). The camera is NOT in this plane, so a fingertip ray crosses it at
      // a real point on the pot's near face. (Using the perpendicular normal put the camera
      // in the plane → the ray only ever met it at the camera itself : sculpting did nothing.)
      _plane.set(new THREE.Vector3(Math.sin(camAz), 0, Math.cos(camAz)), 0)
      const hit = raycaster.ray.intersectPlane(_plane, new THREE.Vector3())
      if (!hit) return null
      const rad = Math.abs(hit.x * Math.cos(camAz) - hit.z * Math.sin(camAz))   // distance from axis, across the face
      const g = clamp(0, 1, (hit.y - Y0) / HMAX)
      return { rad, ring: clamp(0, NR - 1, Math.round(g * (NR - 1))) }
    }
    let skelHands: { x: number; y: number }[][] = []   // last landmarks (screen px, mirrored) for the skeleton

    type Contact = { rad: number; ring: number; press: number; sx: number; sy: number; inner: boolean; resist: number }
    let hud: { contacts: Contact[]; toolLabel: string } = { contacts: [], toolLabel: '' }

    // ── Undo / redo history (snapshots of the radial profiles) ──
    type Snap = { o: Float32Array; i: Float32Array; top: number }
    const snapOf = (): Snap => ({ o: rOut.slice(), i: rIn.slice(), top })
    const applySnap = (s: Snap) => { rOut.set(s.o); rIn.set(s.i); top = s.top }
    let past: Snap[] = [], future: Snap[] = []
    const pushHistory = () => { past.push(snapOf()); if (past.length > 40) past.shift(); future = [] }

    // Gaussian falloff over ~ band width in rings.
    const bandW = (k: number, center: number, sigma: number) => Math.exp(-((k - center) * (k - center)) / (2 * sigma * sigma))

    // Material force-feedback : firmer/thicker clay resists — the wall yields LESS per unit
    // press. `resist` (0..1, on the contact) is displayed ; `yF` is the yield multiplier.
    const yF = (c: Contact) => 1 - 0.72 * c.resist
    const applyTool = (contacts: Contact[], p: typeof paramsRef.current, dt: number) => {
      const eng = contacts.filter((c) => c.press > 0.15)
      if (!eng.length) return
      const rate = clamp(0, 0.9, p.strength * Math.min(1, dt * 12))   // responsive
      // STABILITY : cap how far any ring can move per frame (framerate-independent). Before,
      // a slow frame (large dt) or a jumpy fingertip could snap the wall → jittery. Now the
      // wall eases toward the target smoothly whatever the frame time.
      const cap = (0.22 + p.strength * 1.1) * dt
      const stepTo = (arr: Float32Array, k: number, target: number, w: number) => { const d = (target - arr[k]) * w; arr[k] += d < -cap ? -cap : d > cap ? cap : d }
      const sigma = 4   // tighter band → finger-level precision
      if (p.tool === 'pull') {
        if (eng.length >= 2) {
          const s = [...eng].sort((a, b) => a.rad - b.rad); const inn = s[0], out = s[s.length - 1]
          const center = Math.round((inn.ring + out.ring) / 2), press = Math.min(inn.press, out.press), yf = (yF(inn) + yF(out)) * 0.5
          for (let k = FLOOR_RINGS; k <= top; k++) { const w = bandW(k, center, sigma) * rate * press * yf; if (w < 1e-3) continue; stepTo(rOut, k, clamp(0.02, MAXR, out.rad), w); stepTo(rIn, k, clamp(0, MAXR, inn.rad), w) }
        } else {
          const c = eng[0], mid = (rOut[c.ring] + rIn[c.ring]) * 0.5, inner = c.rad < mid, yf = yF(c)
          for (let k = FLOOR_RINGS; k <= top; k++) { const w = bandW(k, c.ring, sigma) * rate * c.press * yf; if (w < 1e-3) continue; if (inner) stepTo(rIn, k, clamp(0, MAXR, c.rad), w); else stepTo(rOut, k, clamp(0.02, MAXR, c.rad), w) }
        }
      } else if (p.tool === 'open') {
        const c = eng.reduce((a, b) => (a.rad < b.rad ? a : b)), yf = yF(c)    // hand nearest the axis
        for (let k = Math.max(FLOOR_RINGS, c.ring); k <= top; k++) { const w = rate * c.press * yf * (k >= c.ring ? 1 : 0.4); const tgt = clamp(0, rOut[k] - MINWALL, c.rad); stepTo(rIn, k, tgt, w) }
      } else if (p.tool === 'widen' || p.tool === 'collar') {
        const dir = p.tool === 'widen' ? 1 : -1
        for (const c of eng) { const yf = yF(c); for (let k = FLOOR_RINGS; k <= top; k++) { const w = bandW(k, c.ring, sigma) * rate * c.press * yf; if (w < 1e-3) continue; const d = clamp(-cap, cap, dir * 0.06 * w); rOut[k] = clamp(0.02, MAXR, rOut[k] + d); if (rIn[k] > EPS) rIn[k] = clamp(0, rOut[k] - MINWALL, rIn[k] + d) } }
      } else if (p.tool === 'rib') {
        for (const c of eng) for (let k = FLOOR_RINGS + 1; k < top; k++) { const w = bandW(k, c.ring, sigma) * rate * c.press; if (w < 1e-3) continue; rOut[k] += ((rOut[k - 1] + rOut[k + 1]) * 0.5 - rOut[k]) * w; rIn[k] += ((rIn[k - 1] + rIn[k + 1]) * 0.5 - rIn[k]) * w }
      } else if (p.tool === 'trim') {
        const c = eng.reduce((a, b) => (a.ring < b.ring ? a : b))   // lowest hand = cut height
        const cut = Math.max(FLOOR_RINGS + 2, c.ring)
        if (cut < top) { for (let k = cut + 1; k <= top; k++) { rOut[k] = 0; rIn[k] = 0 } top = cut }
      }
    }

    const relaxAndConstrain = (p: typeof paramsRef.current, dt: number) => {
      // Wet-clay relaxation : the spinning wheel evens the wall out. Rate scales with
      // smoothing × wheel speed → a fast wheel auto-centres, a slow one keeps marks.
      const relax = clamp(0, 0.5, p.smoothing * (0.08 + 0.22 * clamp(0, 1, p.wheelSpeed / 3)) * Math.min(1, dt * 60))
      if (relax > 1e-4) {
        const oO = rOut.slice(0, top + 1), oI = rIn.slice(0, top + 1)
        for (let i = 1; i < top; i++) { rOut[i] += ((oO[i - 1] + oO[i + 1]) * 0.5 - oO[i]) * relax; rIn[i] += ((oI[i - 1] + oI[i + 1]) * 0.5 - oI[i]) * relax }
      }
      // Constraints : radii bounds, wall thickness, solid closed floor.
      for (let i = 0; i <= top; i++) {
        rOut[i] = clamp(0.0, MAXR, rOut[i])
        if (i < FLOOR_RINGS) rIn[i] = 0
        else rIn[i] = clamp(0, Math.max(0, rOut[i] - MINWALL), rIn[i])
      }
      // Volume conservation : hold V≈V0 by extruding the rim upward (thinning → taller) or
      // shaving it (widening → shorter). STABILITY : at most ONE ring/frame with a ±1 %
      // dead-band (was 4 rings/frame at ±0.3 % → the rim flickered up/down visibly).
      if (p.conserve) {
        const v = volume()
        if (v < V0 * 0.99 && top < NR - 2) { top++; rOut[top] = Math.max(0.02, rOut[top - 1] * 0.98); rIn[top] = clamp(0, rOut[top] - MINWALL, rIn[top - 1] * 0.98) }
        else if (v > V0 * 1.01 && top > FLOOR_RINGS + 3) { rOut[top] = 0; rIn[top] = 0; top-- }
      }
    }

    const decoFrom = (p: typeof paramsRef.current): Deco => ({ type: p.decorType, count: Math.round(p.flutes), depth: p.fluteDepth, foot: p.foot, spout: p.spout, handles: Math.round(p.handles), handleSize: p.handleSize })
    const doExport = (fmt: 'stl' | 'glb') => {
      const pp = paramsRef.current
      const geo = buildPotGeometry(rOut, rIn, top, decoFrom(pp))
      if (fmt === 'stl') {
        const stl = new STLExporter().parse(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()), { binary: false })
        downloadBlob(new Blob([stl], { type: 'model/stl' }), `poterie-${Date.now()}.stl`); setStatus('Export STL (vase étanche imprimable).')
      } else {
        // GLB carries the FIRED look : the glaze material (incl. a crisp high-res baked Raku texture) is embedded.
        const mat = makeGlaze(pp.glaze, pp.clayColor, { crackle: pp.crackle, carbon: pp.carbon, lustre: pp.lustre }, pp.rakuSeed, 512)
        const g = new THREE.Group(); g.add(new THREE.Mesh(geo, mat))
        new GLTFExporter().parse(g, (res) => { downloadBlob(new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' }), `poterie-${Date.now()}.glb`); geo.dispose() }, () => setStatus('Échec export GLB.'), { binary: true })
        setStatus(pp.glaze === 'raku' ? 'Export GLB (Raku cuit dans la texture).' : 'Export GLB (émail conservé).')
      }
    }

    // ── Recording : webcam + 3D + overlay → WebM ──
    let recCanvas: HTMLCanvasElement | null = null, recCtx: CanvasRenderingContext2D | null = null
    let recorder: MediaRecorder | null = null, recChunks: Blob[] = [], recActive = false
    const startRec = () => {
      if (recActive) return
      recCanvas = document.createElement('canvas'); recCanvas.width = overlay.width; recCanvas.height = overlay.height; recCtx = recCanvas.getContext('2d')
      const st = recCanvas.captureStream(30)
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
      recChunks = []; recorder = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
      recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data) }
      recorder.onstop = () => { downloadBlob(new Blob(recChunks, { type: 'video/webm' }), `poterie-${Date.now()}.webm`); recChunks = []; setStatus('Vidéo enregistrée (WebM).') }
      recorder.start(); recActive = true; setRecording(true); setStatus('● Enregistrement…')
    }
    const stopRec = () => { if (recActive && recorder) { recorder.stop(); recActive = false; setRecording(false) } }
    recCtl.current = { start: startRec, stop: stopRec }

    let lastT = performance.now(), wasSculpting = false
    const loop = () => {
      if (!running) return
      const p = paramsRef.current
      const nowT = performance.now(), dt = clamp(0.001, 0.05, (nowT - lastT) / 1000); lastT = nowT
      if (resetRef.current) { pushHistory(); resetClay(p.clayMass); resetRef.current = false; setStatus('Remise à zéro — nouvelle motte centrée.') }
      if (startRef.current) { pushHistory(); const k = startRef.current; startRef.current = null; applyStart(k, p.clayMass); setStatus(`Forme de départ : ${START_SHAPES.find((s) => s.kind === k)?.label ?? k}.`) }
      if (trueRef.current) { trueRef.current = false; pushHistory(); for (let pass = 0; pass < 6; pass++) { const oO = rOut.slice(0, top + 1), oI = rIn.slice(0, top + 1); for (let i = 1; i < top; i++) { rOut[i] = oO[i] * 0.4 + (oO[i - 1] + oO[i + 1]) * 0.3; rIn[i] = oI[i] * 0.4 + (oI[i - 1] + oI[i + 1]) * 0.3 } } setStatus('Régularisé — paroi lissée et centrée.') }
      if (undoRef.current) { undoRef.current = false; if (past.length) { future.push(snapOf()); applySnap(past.pop()!); setStatus('↶ Annulé.') } else setStatus('Rien à annuler.') }
      if (redoRef.current) { redoRef.current = false; if (future.length) { past.push(snapOf()); applySnap(future.pop()!); setStatus('↷ Refait.') } else setStatus('Rien à refaire.') }
      if (exportRef.current) { doExport(exportRef.current); exportRef.current = null }
      V0 = VOL_K * p.clayMass    // live target : changing mass adds/removes clay

      // Glaze / firing : rebuild the material only on glaze / colour / seed change — NOT on
      // the raku sliders (baking the crackle texture is heavy → re-baking every slider tick
      // would freeze). Craquelure/enfumage/lustre are read at bake time and applied on the
      // next « Enfourner » (new seed), which is also truer to real raku : set up, then fire.
      const gsig = `${p.glaze}|${p.clayColor}|${p.rakuSeed}`
      if (gsig !== lastGlazeSig) { lastGlazeSig = gsig; clayMesh.material.dispose(); clayMesh.material = makeGlaze(p.glaze, p.clayColor, { crackle: p.crackle, carbon: p.carbon, lustre: p.lustre }, p.rakuSeed, 256) }
      ;(clayMesh.material as THREE.Material & { wireframe: boolean }).wireframe = p.wireframe

      // Axis guide endpoints (projected — the line can slant when the view is inclined).
      const sBase = proj(0, Y0, 0), sTop = proj(0, Y0 + HMAX, 0)

      let newFrame = false
      const contacts: Contact[] = []
      if (video.readyState >= 2 && video.currentTime !== lastVideoTime && landmarker) {
        lastVideoTime = video.currentTime; newFrame = true
        const res = landmarker.recognizeForVideo(video, performance.now())
        const hands = res.landmarks ?? []
        skelHands = hands.slice(0, 2).map((lm) => lm.map((k: { x: number; y: number }) => ({ x: (1 - k.x) * overlay.width, y: k.y * overlay.height })))
        for (let i = 0; i < Math.min(2, hands.length); i++) {
          const lm = hands[i]
          const handSize = Math.max(0.02, Math.hypot(lm[WRIST].x - lm[MID_MCP].x, lm[WRIST].y - lm[MID_MCP].y))
          const pinch = Math.hypot(lm[TIP_THUMB].x - lm[TIP_INDEX].x, lm[TIP_THUMB].y - lm[TIP_INDEX].y) / handSize
          const press = clamp(0, 1, (0.75 - pinch) / 0.5)
          // INDEX FINGERTIP = the precise sculpting point (smoothed in screen space).
          const rawX = (1 - lm[TIP_INDEX].x) * overlay.width, rawY = lm[TIP_INDEX].y * overlay.height
          const sm = euro2(i === 0 ? euroA : euroB, rawX, rawY, dt)
          const ndcX = (sm.x / overlay.width) * 2 - 1, ndcY = -((sm.y / overlay.height) * 2 - 1)
          const m = mapFinger(ndcX, ndcY)
          if (!m) continue
          // Local material resistance : thicker / firmer clay resists more (force feedback).
          const thick = rIn[m.ring] > EPS ? Math.max(0, rOut[m.ring] - rIn[m.ring]) : rOut[m.ring]
          const resist = clamp(0, 1, p.firmness * (0.2 + 2.0 * thick))
          contacts.push({ rad: m.rad, ring: m.ring, press, sx: sm.x, sy: sm.y, inner: false, resist })
        }
        if (!hands.length) skelHands = []
        if (contacts.length >= 2) { const mn = contacts.reduce((a, b) => (a.rad < b.rad ? a : b)); mn.inner = true }
      }
      // Souris / tactile : injecte un contact synthétique depuis le pointeur (fonctionne
      // AVEC ou SANS webcam) — réutilise exactement le même chemin outil + historique.
      if (mouseNDC) { const m = mapFinger(mouseNDC.x, mouseNDC.y); if (m) { const thick = rIn[m.ring] > EPS ? Math.max(0, rOut[m.ring] - rIn[m.ring]) : rOut[m.ring]; const resist = clamp(0, 1, p.firmness * (0.2 + 2.0 * thick)); contacts.push({ rad: m.rad, ring: m.ring, press: 1, sx: (mouseNDC.x * 0.5 + 0.5) * overlay.width, sy: (-mouseNDC.y * 0.5 + 0.5) * overlay.height, inner: false, resist }) } }
      if (newFrame || mouseNDC) {
        const sculptingNow = contacts.some((c) => c.press > 0.15)
        if (sculptingNow && !wasSculpting) pushHistory()   // snapshot the pre-stroke state → undo restores it
        wasSculpting = sculptingNow
        applyTool(contacts, p, dt)
      }
      if (contacts.length) hud = { contacts, toolLabel: TOOLS.find((t) => t.kind === p.tool)?.label ?? '' }
      else if (newFrame) hud = { contacts: [], toolLabel: hud.toolLabel }

      relaxAndConstrain(p, dt)

      // Rebuild the clay mesh from the profiles (+ live décor : texture, foot, spout, handles).
      const geo = buildPotGeometry(rOut, rIn, top, decoFrom(p)); clayMesh.geometry.dispose(); clayMesh.geometry = geo

      wheelAngle += p.wheelSpeed * dt * 2.2; spin.rotation.y = wheelAngle
      applyCam(); renderer.render(scene, camera)

      // ── Overlay HUD ──
      octx.clearRect(0, 0, overlay.width, overlay.height)
      if (p.showGuides) {
        octx.strokeStyle = 'rgba(0,224,192,0.35)'; octx.lineWidth = 1.5; octx.setLineDash([6, 6])
        octx.beginPath(); octx.moveTo(sTop.x, sTop.y); octx.lineTo(sBase.x, sBase.y); octx.stroke(); octx.setLineDash([])
        octx.fillStyle = 'rgba(0,224,192,0.6)'; octx.font = '11px system-ui'; octx.textAlign = 'center'
        octx.fillText('axe du tour', sTop.x, sTop.y - 8)
      }
      // Hand skeleton (both hands) — see exactly where your fingers are.
      if (p.showSkeleton) {
        octx.lineWidth = 2; octx.strokeStyle = 'rgba(255,255,255,0.4)'
        for (const hnd of skelHands) {
          for (const chain of FINGER_CHAINS) { octx.beginPath(); chain.forEach((idx, k) => { const pt = hnd[idx]; if (!pt) return; if (k === 0) octx.moveTo(pt.x, pt.y); else octx.lineTo(pt.x, pt.y) }); octx.stroke() }
          for (const pt of hnd) { octx.beginPath(); octx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2); octx.fillStyle = 'rgba(0,224,192,0.55)'; octx.fill() }
        }
      }
      for (const c of hud.contacts) {
        const on = c.press > 0.15
        // Force-feedback ring : as you press into firm/thick clay, an outer "resistance"
        // ring swells and reddens (green = yields easily → red = pushing back hard).
        if (on) {
          const rr = 16 + c.press * 22 + c.resist * 16
          const col = `hsl(${Math.round(150 - c.resist * 150)},90%,55%)`   // green→red by resistance
          octx.beginPath(); octx.arc(c.sx, c.sy, rr, 0, Math.PI * 2); octx.strokeStyle = col; octx.lineWidth = 2 + c.resist * 4; octx.globalAlpha = 0.5 + 0.4 * c.press; octx.stroke(); octx.globalAlpha = 1
        }
        octx.beginPath(); octx.arc(c.sx, c.sy, on ? 12 : 8, 0, Math.PI * 2)
        octx.fillStyle = on ? (c.inner ? 'rgba(255,180,0,0.7)' : 'rgba(0,224,192,0.7)') : 'rgba(255,255,255,0.4)'
        octx.globalAlpha = 0.9; octx.fill(); octx.globalAlpha = 1
        octx.lineWidth = 3; octx.strokeStyle = c.inner ? '#ffb400' : '#00e0c0'; octx.stroke()
        if (on) { octx.fillStyle = '#fff'; octx.font = 'bold 11px system-ui'; octx.textAlign = 'center'; octx.fillText(`${c.inner ? 'INT.' : 'EXT.'} · ${Math.round(c.resist * 100)}%`, c.sx, c.sy - 24) }
      }
      // ── Measurements HUD (bottom-right) : height / diameter / wall / capacity ──
      if (p.showMeasure) {
        const SCALE = 18   // 1 world unit ≈ 18 cm
        let maxOut = 0, minWall = 1e9
        for (let i = 0; i <= top; i++) { if (rOut[i] > maxOut) maxOut = rOut[i]; if (rIn[i] > EPS) { const w = rOut[i] - rIn[i]; if (w < minWall) minWall = w } }
        const wall = minWall < 1e9 ? minWall : Math.max(0, rOut[0])
        const litres = volume() * 0.18 * 0.18 * 0.18 * 1000
        const lines = [`H ${(top * DY * SCALE).toFixed(0)} cm`, `Ø ${(2 * maxOut * SCALE).toFixed(0)} cm`, `paroi ${(wall * SCALE * 10).toFixed(0)} mm`, `≈ ${litres.toFixed(2)} L`]
        octx.textAlign = 'right'; octx.font = '12px system-ui'
        const bx = overlay.width - 14; let by = overlay.height - 14 - (lines.length - 1) * 17
        octx.fillStyle = 'rgba(10,8,6,0.5)'; octx.fillRect(bx - 92, by - 15, 100, lines.length * 17 + 7)
        octx.fillStyle = 'rgba(255,222,186,0.95)'
        for (const ln of lines) { octx.fillText(ln, bx, by); by += 17 }
      }
      if (recActive && recCtx && recCanvas) {
        const w = recCanvas.width, h = recCanvas.height
        if (p.bgMode === 'webcam' && video.readyState >= 2) { recCtx.save(); recCtx.translate(w, 0); recCtx.scale(-1, 1); recCtx.drawImage(video, 0, 0, w, h); recCtx.restore() }
        else { recCtx.fillStyle = '#0a0806'; recCtx.fillRect(0, 0, w, h) }
        recCtx.drawImage(renderer.domElement, 0, 0, w, h); recCtx.drawImage(overlay, 0, 0, w, h)
      }
      rafId = requestAnimationFrame(loop)
    }

    const init = async () => {
      // Start rendering immediately (the wheel + clay show even before/without a camera).
      loop()
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }))
        video.srcObject = stream; await new Promise<void>((res) => { video.onloadedmetadata = () => res() }); await video.play()
        const files = await FilesetResolver.forVisionTasks(WASM_BASE)
        landmarker = await GestureRecognizer.createFromOptions(files, { baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3 })
        setStatus('Prêt — pince des deux mains autour de la paroi, monte pour la faire monter ✦')
      } catch (e: any) { setError(`Caméra ou modèle indisponible : ${e?.message ?? e}`) }
    }
    init()

    return () => {
      running = false; if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp); el.removeEventListener('wheel', onWheel)
      try { landmarker?.close() } catch { /* noop */ }
      if (stream) stream.getTracks().forEach((t) => t.stop()); video.srcObject = null
      try { if (recActive && recorder) recorder.stop() } catch { /* noop */ }
      clayMesh.geometry.dispose(); envTex?.dispose(); pmrem.dispose(); renderer.dispose(); if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  const exportPng = () => {
    const three = mountRef.current?.querySelector('canvas') as HTMLCanvasElement | null; if (!three) return
    const out = document.createElement('canvas'); out.width = three.width; out.height = three.height; const c = out.getContext('2d')!
    if (bgMode === 'webcam' && videoRef.current && videoRef.current.readyState >= 2) { c.save(); c.translate(out.width, 0); c.scale(-1, 1); c.drawImage(videoRef.current, 0, 0, out.width, out.height); c.restore() } else { c.fillStyle = '#0a0806'; c.fillRect(0, 0, out.width, out.height) }
    c.drawImage(three, 0, 0, out.width, out.height); out.toBlob((b) => { if (b) downloadBlob(b, `poterie-${Date.now()}.png`) }, 'image/png')
  }

  const toolHint = TOOLS.find((t) => t.kind === tool)?.hint ?? ''

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0806', overflow: 'hidden', userSelect: 'none', fontFamily: 'system-ui' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)', zIndex: 1, opacity: bgMode === 'webcam' ? 1 : 0 }} />
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 3 }} />
      <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', zIndex: 4, pointerEvents: 'none' }} />
      {!panelOpen && <button onClick={() => setPanelOpen(true)} style={{ position: 'absolute', top: 16, left: 16, zIndex: 11, ...selStyle, width: 'auto', padding: '8px 12px' }}>☰</button>}
      {panelOpen && (
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, width: 300, background: 'rgba(14,10,8,0.88)', padding: 18, borderRadius: 16, backdropFilter: 'blur(10px)', border: '1px solid rgba(255,180,120,0.18)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', color: '#e8dccc' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ color: '#ffb47a', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>🏺 Poterie · Tour</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link><button onClick={() => setPanelOpen(false)} style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16 }}>«</button></div>
          </div>
          <div style={{ color: error ? '#ff6b6b' : '#9a8a78', fontSize: 11, marginBottom: 10, lineHeight: 1.3 }}>{error ?? status}</div>
          <div style={{ fontSize: 10, color: '#ffcf9a', marginBottom: 12, lineHeight: 1.35, background: 'rgba(255,180,0,0.08)', padding: 7, borderRadius: 6 }}>☝️ Le <b>bout de l'index</b> est l'outil. Pince pouce+index pour <b>presser</b> l'argile (ouvre la main pour repositionner). Deux mains = paroi <b>int.</b> (proche de l'axe) + <b>ext.</b><br />🖱️/👆 <b>Sans caméra</b> : 1 doigt / clic gauche = <b>façonner</b> · clic droit ou 2 doigts = <b>tourner + zoom</b> · molette = zoom.</div>

          <Field label="Forme de départ">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              {START_SHAPES.map((s) => (
                <button key={s.kind} onClick={() => { startRef.current = s.kind }} style={{ ...selStyle, fontSize: 11, padding: 6 }} title="Partir d'une forme prête (volume conservé)">{s.label}</button>
              ))}
            </div>
          </Field>

          <Field label="Outil de tournage">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {TOOLS.map((t) => (
                <button key={t.kind} onClick={() => setTool(t.kind)} style={{ ...selStyle, fontSize: 11, padding: 7, background: tool === t.kind ? 'rgba(255,150,60,0.28)' : 'rgba(255,255,255,0.08)', borderColor: tool === t.kind ? 'rgba(255,150,60,0.6)' : 'rgba(255,255,255,0.18)' }}>{t.label}</button>
              ))}
            </div>
            <p style={{ color: '#9a8a78', fontSize: 10, margin: '6px 0 0', lineHeight: 1.35 }}>{toolHint}</p>
          </Field>

          <Field label={`Force de l'outil — ${Math.round(strength * 100)}%`}><input type="range" min={0.1} max={1} step={0.05} value={strength} onChange={(e) => setStrength(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`Fermeté de l'argile — ${Math.round(firmness * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={firmness} onChange={(e) => setFirmness(+e.target.value)} style={rngStyle} /><p style={{ color: '#9a8a78', fontSize: 10, margin: '4px 0 0', lineHeight: 1.3 }}>Retour de force : plus l'argile est ferme/épaisse, plus elle résiste (anneau rouge autour du doigt).</p></Field>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <button onClick={() => { undoRef.current = true }} style={{ ...selStyle, flex: 1, fontSize: 12 }}>↶ Annuler</button>
            <button onClick={() => { redoRef.current = true }} style={{ ...selStyle, flex: 1, fontSize: 12 }}>↷ Refaire</button>
            <button onClick={() => { resetRef.current = true }} style={{ ...selStyle, flex: 1, fontSize: 12, background: 'rgba(255,80,80,0.2)', borderColor: 'rgba(255,80,80,0.45)' }}>⟲ Zéro</button>
          </div>
          <button onClick={() => { trueRef.current = true }} style={{ ...selStyle, marginBottom: 6, fontSize: 12, background: 'rgba(120,200,255,0.16)', borderColor: 'rgba(120,200,255,0.4)' }} title="Lisse et recentre toute la paroi (rattrape une pièce voilée)">✨ Régulariser (centrer & lisser)</button>

          <div style={{ fontSize: 10, color: '#ffb47a', textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' }}>Le tour & l'argile</div>
          <Field label={`Vitesse du tour — ${wheelSpeed.toFixed(1)}`}><input type="range" min={0} max={3} step={0.1} value={wheelSpeed} onChange={(e) => setWheelSpeed(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`Masse d'argile — ${clayMass.toFixed(1)} kg`}><input type="range" min={0.3} max={3} step={0.1} value={clayMass} onChange={(e) => setClayMass(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`Lissage (eau) — ${Math.round(smoothing * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={smoothing} onChange={(e) => setSmoothing(+e.target.value)} style={rngStyle} /></Field>
          <label style={chkRow} title="L'argile est incompressible : affiner la paroi la fait monter (comme au tournage réel)."><input type="checkbox" checked={conserve} onChange={(e) => setConserve(e.target.checked)} style={{ accentColor: '#ffb47a' }} /> 🧱 Conservation du volume (monte les parois)</label>

          <div style={{ fontSize: 10, color: '#ffb47a', textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' }}>Décor & forme</div>
          <Field label="Texture de surface"><select value={decorType} onChange={(e) => setDecorType(e.target.value as DecorType)} style={selStyle}>{DECORS.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}</select></Field>
          {decorType !== 'none' && <>
            <Field label={`Motifs — ${flutes}`}><input type="range" min={2} max={24} step={1} value={flutes} onChange={(e) => setFlutes(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Profondeur — ${Math.round(fluteDepth * 100)}%`}><input type="range" min={0.01} max={0.2} step={0.01} value={fluteDepth} onChange={(e) => setFluteDepth(+e.target.value)} style={rngStyle} /></Field>
          </>}
          <Field label={`🦶 Pied tourné — ${foot === 0 ? 'aucun' : Math.round(foot * 100) + '%'}`}><input type="range" min={0} max={1} step={0.05} value={foot} onChange={(e) => setFoot(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`🫗 Bec verseur — ${spout === 0 ? 'aucun' : Math.round(spout * 100) + '%'}`}><input type="range" min={0} max={1} step={0.05} value={spout} onChange={(e) => setSpout(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`🫧 Anses — ${handles === 0 ? 'aucune' : handles}`}><input type="range" min={0} max={3} step={1} value={handles} onChange={(e) => setHandles(+e.target.value)} style={rngStyle} /></Field>
          {handles >= 1 && <Field label={`Taille des anses — ${Math.round(handleSize * 100)}%`}><input type="range" min={0.2} max={1} step={0.05} value={handleSize} onChange={(e) => setHandleSize(+e.target.value)} style={rngStyle} /></Field>}

          <div style={{ fontSize: 10, color: '#ffb47a', textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' }}>Cuisson & émaillage</div>
          <Field label="Émail / finition"><select value={glaze} onChange={(e) => setGlaze(e.target.value as Glaze)} style={selStyle}>{GLAZES.map((g) => <option key={g.kind} value={g.kind}>{g.label}</option>)}</select></Field>
          {glaze === 'raku' && <>
            <Field label={`Craquelure — ${Math.round(crackle * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={crackle} onChange={(e) => setCrackle(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Enfumage (carbone) — ${Math.round(carbon * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={carbon} onChange={(e) => setCarbon(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Lustre métallique irisé — ${Math.round(lustre * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={lustre} onChange={(e) => setLustre(+e.target.value)} style={rngStyle} /></Field>
            <button onClick={() => setRakuSeed(Math.floor(Math.random() * 99999) + 1)} style={{ ...selStyle, marginBottom: 8, background: 'rgba(255,120,40,0.22)', borderColor: 'rgba(255,120,40,0.55)' }} title="Chaque cuisson Raku donne un craquelage et un enfumage uniques">🔥 Enfourner — nouveau tirage Raku</button>
          </>}
          <p style={{ color: '#9a8a78', fontSize: 10, margin: '0 0 4px', lineHeight: 1.35 }}>Raku procédural : craquelure fractale multi-échelle + enfumage + lustre, cuit dans une texture (exporté dans le .glb). Règle les curseurs puis clique <b>Enfourner</b> → chaque cuisson est unique.</p>

          <div style={{ fontSize: 10, color: '#ffb47a', textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' }}>Rendu</div>
          <Field label="Couleur de l'argile"><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="color" value={clayColor} onChange={(e) => setClayColor(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} /><div style={{ display: 'flex', gap: 5 }}>{['#b5651d', '#c8794a', '#8a5a3c', '#d9c7a3', '#3a3f4a', '#e8e2d6'].map((h) => <button key={h} onClick={() => setClayColor(h)} style={{ width: 22, height: 22, borderRadius: 5, background: h, border: '1px solid rgba(255,255,255,0.25)', cursor: 'pointer' }} />)}</div></div></Field>
          <label style={chkRow}><input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} style={{ accentColor: '#ffb47a' }} /> 🕸️ Fil de fer (maillage)</label>
          <label style={chkRow}><input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} style={{ accentColor: '#ffb47a' }} /> 📐 Repères (axe)</label>
          <label style={chkRow}><input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} style={{ accentColor: '#ffb47a' }} /> ✋ Squelette des mains</label>
          <label style={chkRow}><input type="checkbox" checked={showMeasure} onChange={(e) => setShowMeasure(e.target.checked)} style={{ accentColor: '#ffb47a' }} /> 📏 Cotes (hauteur / Ø / paroi / volume)</label>
          <Field label="Fond"><select value={bgMode} onChange={(e) => setBgMode(e.target.value as 'webcam' | 'black')} style={selStyle}><option value="webcam">📷 Webcam</option><option value="black">⬛ Atelier sombre</option></select></Field>

          <div style={{ fontSize: 10, color: '#ffb47a', textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' }}>Export</div>
          <button onClick={() => { recording ? recCtl.current?.stop() : recCtl.current?.start() }} style={{ ...selStyle, marginBottom: 8, background: recording ? 'rgba(255,40,60,0.35)' : 'rgba(255,255,255,0.1)', borderColor: recording ? '#ff2840' : 'rgba(255,255,255,0.2)' }}>{recording ? '⏹ Arrêter l\'enregistrement' : '🔴 Enregistrer une vidéo'}</button>
          <div style={{ display: 'flex', gap: 8 }}><button onClick={exportPng} style={{ ...selStyle, flex: 1 }}>📸 PNG</button><button onClick={() => { exportRef.current = 'glb' }} style={{ ...selStyle, flex: 1 }}>🏺 .glb</button><button onClick={() => { exportRef.current = 'stl' }} style={{ ...selStyle, flex: 1 }} title="Vase étanche pour impression 3D">🖨️ .stl</button></div>
          <p style={{ color: '#7a6a58', fontSize: 10, marginTop: 10, marginBottom: 0, lineHeight: 1.4 }}>Souris : glisser = orbiter (azimut + inclinaison) · molette = zoom. Incliner la vue change l'impact des doigts sur l'argile.</p>
        </div>
      )}
    </div>
  )
}

function downloadBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500) }
const selStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: 8, borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }
const rngStyle: React.CSSProperties = { width: '100%', accentColor: '#ffb47a' }
const chkRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#e8dccc', marginTop: 8, marginBottom: 8, cursor: 'pointer' }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return (<div style={{ marginBottom: 12 }}><div style={{ fontSize: 11, color: '#ffb47a', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>{children}</div>) }
