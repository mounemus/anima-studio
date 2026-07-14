/**
 * Sketch AR Studio PRO — dessin 3D dans l'espace avec les doigts (webcam + MediaPipe).
 *
 * Inspiré de Gravity Sketch + Sketchar. On trace des tubes 3D lumineux qui suivent
 * le bout de l'index ; la profondeur z vient de la distance main↔caméra.
 *
 * NAVIGATION À LA MAIN (nouveau) : FERME LE POING → mode orbite. Bouge la main pour
 * tourner la vue, avance/recule pour zoomer. Le tracé se fait TOUJOURS dans le plan
 * qui fait face à la caméra → après avoir tourné, tu dessines dans ce nouveau plan.
 *
 * PRO : 5 pinceaux, calligraphie (épaisseur selon la vitesse), gomme 3D, symétrie
 * miroir OU radiale (N branches), formes primitives (ligne/cercle/rect/boîte 3D),
 * image de référence, grille, et export 3D étanche (.glb / .stl imprimable).
 *
 * Studio autonome. Route /sketch, protégée par FrontGate.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import * as THREE from 'three'
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { ArcballControls } from 'three/examples/jsm/controls/ArcballControls.js'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
// Gesture Recognizer = MediaPipe's on-device ML model that classifies hand gestures
// (Closed_Fist, Open_Palm, Pointing_Up, Victory…) in real time — far more robust than
// geometric heuristics. It also returns the 21 landmarks, so it fully replaces the plain
// HandLandmarker while giving us a reliable fist signal for orbit mode.
const GESTURE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'

const TIP_THUMB = 4, TIP_INDEX = 8, TIP_MIDDLE = 12, PIP_INDEX = 6
const FINGER_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const UP = new THREE.Vector3(0, 1, 0)
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

type BrushKind = 'tube' | 'neon' | 'marker' | 'metal' | 'wire' | 'calligA' | 'airbrush' | 'light'
type LightGradient = 'warm' | 'rainbow' | 'mono'
interface LightOpt { mode: LightGradient; cycle: number; hex: string; glow: number }
type DrawMode = 'pinch' | 'index'
type BgMode = 'webcam' | 'black'
type ShapeKind = 'free' | 'line' | 'circle' | 'rect' | 'box'
type SymKind = 'none' | 'mirror' | 'radial'

const BRUSHES: { kind: BrushKind; label: string; rMul: number }[] = [
  { kind: 'tube', label: '🩵 Tube mat', rMul: 1 },
  { kind: 'neon', label: '💡 Néon lumineux', rMul: 0.9 },
  { kind: 'marker', label: '🖊️ Marqueur plat', rMul: 1.1 },
  { kind: 'metal', label: '⚙️ Métal chromé', rMul: 1 },
  { kind: 'wire', label: '✨ Fil fin', rMul: 0.45 },
  { kind: 'calligA', label: '✒️ Calligraphie arabe (plume large)', rMul: 1.35 },
  { kind: 'airbrush', label: '💨 Aérographe (spray doux)', rMul: 1.4 },
  { kind: 'light', label: '🔦 Light painting (traînée lumineuse)', rMul: 1 },
]
const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: 'free', label: '✏️ Libre (main levée)' }, { kind: 'line', label: '📏 Ligne droite' },
  { kind: 'circle', label: '⭕ Cercle' }, { kind: 'rect', label: '▭ Rectangle' }, { kind: 'box', label: '📦 Boîte 3D (profondeur)' },
]

// Radial (marking) menu wedges — opened by the OTHER hand's Open_Palm gesture.
type Wedge = { type: 'color'; hex: string } | { type: 'brush'; label: string } | { type: 'eraser'; label: string }
const WEDGES: Wedge[] = [
  { type: 'color', hex: '#00f0ff' }, { type: 'color', hex: '#ff2d78' }, { type: 'color', hex: '#ffd200' },
  { type: 'color', hex: '#7cff00' }, { type: 'color', hex: '#ff7a00' }, { type: 'color', hex: '#ffffff' },
  { type: 'brush', label: '⟳ Pinceau' }, { type: 'eraser', label: '🧽 Gomme' },
]

function makeBrushMaterial(kind: BrushKind, hex: string): THREE.Material {
  const color = new THREE.Color(hex)
  switch (kind) {
    case 'neon': return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    case 'marker': return new THREE.MeshBasicMaterial({ color })
    case 'metal': return new THREE.MeshStandardMaterial({ color, metalness: 0.95, roughness: 0.22 })
    case 'wire': return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    case 'light': return new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.96, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
    case 'calligA': return new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.5 })
    case 'tube': default: return new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.55 })
  }
}

/** Constant-radius tube (TubeGeometry) or, when `r` is an array, a variable-radius
 *  tube (calligraphie). Optionally closed by end-cap spheres → maillage étanche. */
/** Color of a light-painting trail at a normalized position `frac` (0→1 along the
 *  stroke). Warm = orange→pale-yellow bands ; rainbow = hue sweep ; mono = base hue
 *  with brightness bands. `cycle` sets how many bands run along the trail. */
function lightGradientColor(frac: number, mode: LightGradient, cycle: number, base: THREE.Color): THREE.Color {
  if (mode === 'rainbow') return new THREE.Color().setHSL(((frac * cycle) % 1 + 1) % 1, 1, 0.55)
  const band = 0.5 + 0.5 * Math.sin(frac * cycle * Math.PI * 2)
  if (mode === 'warm') return new THREE.Color().setHSL(0.055 + 0.055 * band, 1, 0.42 + 0.4 * band)
  const hsl = { h: 0, s: 0, l: 0 }; base.getHSL(hsl)
  return new THREE.Color().setHSL(hsl.h, Math.max(0.4, hsl.s), clamp(0.3, 0.85, hsl.l * (0.7 + 0.9 * band)))
}

/** Light-painting trail : a bright emissive tube with a gradient along its length,
 *  wrapped in a dimmer, fatter halo tube — additive blending fakes the long-exposure
 *  bloom of real light painting. One merged geometry (fits the one-mesh-per-copy pipeline). */
function buildLightGeometry(pts: THREE.Vector3[], r: number, light: LightOpt, full: boolean): THREE.BufferGeometry | null {
  const base = new THREE.Color(light.hex)
  const colorAt = (frac: number) => lightGradientColor(frac, light.mode, Math.max(1, light.cycle), base)
  // colour every vertex of an already-built geometry by a constant fraction (for caps).
  const paintUniform = (g: THREE.BufferGeometry, frac: number, intensity: number) => {
    const cnt = g.getAttribute('position').count, cols = new Float32Array(cnt * 3), c = colorAt(frac)
    for (let i = 0; i < cnt; i++) { cols[i * 3] = Math.min(1, c.r * intensity); cols[i * 3 + 1] = Math.min(1, c.g * intensity); cols[i * 3 + 2] = Math.min(1, c.b * intensity) }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); return g
  }
  if (pts.length === 1) { const s = new THREE.SphereGeometry(Math.max(0.004, r), 12, 10); s.translate(pts[0].x, pts[0].y, pts[0].z); return paintUniform(s, 0, 1) }
  if (pts.length < 2) return null
  const curve = new THREE.CatmullRomCurve3(pts)
  const tub = Math.max(4, Math.min(700, pts.length * 4))
  // one tube shell, coloured along its length; radial resolution scales with radius.
  const mk = (radius: number, intensity: number, rad: number) => {
    const ringV = rad + 1
    const g = new THREE.TubeGeometry(curve, tub, Math.max(0.002, radius), rad, false)
    const cnt = g.getAttribute('position').count, cols = new Float32Array(cnt * 3)
    for (let idx = 0; idx < cnt; idx++) { const frac = tub > 0 ? Math.floor(idx / ringV) / tub : 0; const c = colorAt(frac); cols[idx * 3] = Math.min(1, c.r * intensity); cols[idx * 3 + 1] = Math.min(1, c.g * intensity); cols[idx * 3 + 2] = Math.min(1, c.b * intensity) }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); return g
  }
  // Live preview (full=false) : just a smooth bright core — cheap to rebuild each frame.
  if (!full) return mk(r, 1, 12)
  // Finalized : bright smooth core + concentric dimmer shells → soft glow with no hard
  // edge (fakes long-exposure bloom), plus rounded end caps so trails don't cut flat.
  const g = clamp(0, 1, light.glow)
  const geoms: THREE.BufferGeometry[] = [
    mk(r * (3.2 + g * 5), 0.09 + g * 0.07, 8),
    mk(r * (2.0 + g * 2.5), 0.16 + g * 0.10, 10),
    mk(r * (1.35 + g * 1.0), 0.30, 12),
    mk(r, 1, 16),
  ]
  for (const [pt, fr] of [[pts[0], 0], [pts[pts.length - 1], 1]] as [THREE.Vector3, number][]) { const s = new THREE.SphereGeometry(r, 12, 10); s.translate(pt.x, pt.y, pt.z); geoms.push(paintUniform(s, fr, 1)) }
  return mergeGeometries(geoms, false)
}

function buildStrokeGeometry(pts: THREE.Vector3[], r: number | number[], capped: boolean, light?: LightOpt): THREE.BufferGeometry | null {
  if (light) return buildLightGeometry(pts, Array.isArray(r) ? (r[0] ?? 0.01) : r, light, capped)
  if (Array.isArray(r)) return buildVarTube(pts, r, 8, capped)
  const geoms: THREE.BufferGeometry[] = []
  if (pts.length >= 2) {
    const curve = new THREE.CatmullRomCurve3(pts)
    geoms.push(new THREE.TubeGeometry(curve, Math.max(4, Math.min(700, pts.length * 4)), r, 8, false))
    if (capped) for (const e of [pts[0], pts[pts.length - 1]]) { const s = new THREE.SphereGeometry(r, 10, 8); s.translate(e.x, e.y, e.z); geoms.push(s) }
  } else if (pts.length === 1) { const s = new THREE.SphereGeometry(r, 10, 8); s.translate(pts[0].x, pts[0].y, pts[0].z); geoms.push(s) }
  if (!geoms.length) return null
  return geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false)
}

/** Resample a polyline to exactly `n` points, evenly spaced by arc length. */
function resamplePolyline(pts: THREE.Vector3[], n: number): THREE.Vector3[] {
  if (pts.length === 0) return []
  if (pts.length === 1 || n <= 1) return Array.from({ length: Math.max(1, n) }, () => pts[0].clone())
  const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + pts[i].distanceTo(pts[i - 1]))
  const total = L[L.length - 1]
  if (total < 1e-6) return Array.from({ length: n }, () => pts[0].clone())
  const out: THREE.Vector3[] = []
  for (let k = 0; k < n; k++) {
    const d = (k / (n - 1)) * total
    let i = 1; while (i < pts.length && L[i] < d) i++
    const i0 = i - 1, seg = (L[i] - L[i0]) || 1, t = clamp(0, 1, (d - L[i0]) / seg)
    out.push(pts[i0].clone().lerp(pts[i], t))
  }
  return out
}

/** Loft a filled membrane (ruled surface) between two strokes. Corresponding points
 *  along the two arc-length-resampled curves are bridged with quads. When `thick` > 0
 *  the sheet is extruded into a watertight thin shell (a closed manifold: front +
 *  back sheets stitched by boundary walls) so the result exports as a solid. */
function buildLoftGeometry(aPts: THREE.Vector3[], bPts: THREE.Vector3[], thick: number): THREE.BufferGeometry | null {
  const N = clamp(2, 220, Math.round(Math.max(aPts.length, bPts.length, 2)))
  const A = resamplePolyline(aPts, N), B = resamplePolyline(bPts, N)
  if (A.length < 2 || B.length < 2) return null
  // ruled sheet : row A = verts 0..N-1, row B = verts N..2N-1
  const sheetPos: number[] = [], sheetIdx: number[] = []
  for (const v of A) sheetPos.push(v.x, v.y, v.z)
  for (const v of B) sheetPos.push(v.x, v.y, v.z)
  for (let i = 0; i < N - 1; i++) { const a0 = i, a1 = i + 1, b0 = N + i, b1 = N + i + 1; sheetIdx.push(a0, b0, a1, a1, b0, b1) }
  if (thick <= 0) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(sheetPos, 3)); g.setIndex(sheetIdx); g.computeVertexNormals()
    return g
  }
  const base = new THREE.BufferGeometry()
  base.setAttribute('position', new THREE.Float32BufferAttribute(sheetPos, 3)); base.setIndex(sheetIdx); base.computeVertexNormals()
  const nrm = base.getAttribute('normal') as THREE.BufferAttribute
  const V = 2 * N, h = thick * 0.5
  const pos: number[] = [], idx: number[] = []
  for (let k = 0; k < V; k++) pos.push(sheetPos[k * 3] + nrm.getX(k) * h, sheetPos[k * 3 + 1] + nrm.getY(k) * h, sheetPos[k * 3 + 2] + nrm.getZ(k) * h)   // front 0..V-1
  for (let k = 0; k < V; k++) pos.push(sheetPos[k * 3] - nrm.getX(k) * h, sheetPos[k * 3 + 1] - nrm.getY(k) * h, sheetPos[k * 3 + 2] - nrm.getZ(k) * h)   // back  V..2V-1
  for (let i = 0; i < sheetIdx.length; i += 3) { const a = sheetIdx[i], b = sheetIdx[i + 1], c = sheetIdx[i + 2]; idx.push(a, b, c); idx.push(V + a, V + c, V + b) }   // front + reversed back
  const edges: [number, number][] = []
  for (let i = 0; i < N - 1; i++) edges.push([i, i + 1])            // A rail boundary
  for (let i = 0; i < N - 1; i++) edges.push([N + i + 1, N + i])    // B rail boundary
  edges.push([N, 0]); edges.push([N - 1, 2 * N - 1])               // start + end cap edges
  for (const [u, v] of edges) { idx.push(u, v, V + v); idx.push(u, V + v, V + u) }   // side walls
  base.dispose()
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals()
  return g
}

/** Double-sided lit material for lofted surfaces. */
function makeSurfaceMaterial(hex: string): THREE.Material {
  const c = new THREE.Color(hex)
  return new THREE.MeshStandardMaterial({ color: c, side: THREE.DoubleSide, metalness: 0.35, roughness: 0.5, transparent: true, opacity: 0.94, emissive: c.clone().multiplyScalar(0.18) })
}

/** Variable-radius tube via parallel-transport frames + optional sphere caps. */
function buildVarTube(pts: THREE.Vector3[], radii: number[], radial = 8, capped = false): THREE.BufferGeometry | null {
  const N = pts.length
  if (N < 2) return null
  const tan: THREE.Vector3[] = []
  for (let i = 0; i < N; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N - 1, i + 1)]
    const t = new THREE.Vector3().subVectors(b, a); if (t.lengthSq() < 1e-9) t.set(0, 0, 1); tan.push(t.normalize())
  }
  let normal = Math.abs(tan[0].y) < 0.99 ? new THREE.Vector3().crossVectors(tan[0], UP).normalize() : new THREE.Vector3(1, 0, 0)
  const pos: number[] = [], rings: number[][] = []
  for (let i = 0; i < N; i++) {
    normal = normal.clone().sub(tan[i].clone().multiplyScalar(normal.dot(tan[i])))
    if (normal.lengthSq() < 1e-9) normal = Math.abs(tan[i].y) < 0.99 ? new THREE.Vector3().crossVectors(tan[i], UP) : new THREE.Vector3(1, 0, 0)
    normal.normalize()
    const binormal = new THREE.Vector3().crossVectors(tan[i], normal).normalize()
    const ri = Math.max(0.002, radii[i]); const ring: number[] = []
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2
      const off = normal.clone().multiplyScalar(Math.cos(a) * ri).add(binormal.clone().multiplyScalar(Math.sin(a) * ri))
      const p = pts[i].clone().add(off); ring.push(pos.length / 3); pos.push(p.x, p.y, p.z)
    }
    rings.push(ring)
  }
  const idx: number[] = []
  for (let i = 0; i < N - 1; i++) for (let j = 0; j < radial; j++) { const a = rings[i][j], b = rings[i][(j + 1) % radial], c = rings[i + 1][j], d = rings[i + 1][(j + 1) % radial]; idx.push(a, c, b, b, c, d) }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals()
  if (capped) {
    const geoms: THREE.BufferGeometry[] = [g]
    for (const [e, ri] of [[pts[0], radii[0]], [pts[N - 1], radii[N - 1]]] as [THREE.Vector3, number][]) { const s = new THREE.SphereGeometry(Math.max(0.002, ri), 8, 6); s.translate(e.x, e.y, e.z); geoms.push(s) }
    return mergeGeometries(geoms, false)
  }
  return g
}

/** Broad-nib (calligraphie arabe) radii : thick when the stroke is perpendicular to
 *  the pen nib direction, thin when parallel — the classic thick/thin modulation. */
function calligRadii(pts: THREE.Vector3[], base: number, nibRef: THREE.Vector3): number[] {
  const N = pts.length, out: number[] = []
  for (let i = 0; i < N; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N - 1, i + 1)]
    const t = new THREE.Vector3().subVectors(b, a); let mul = 0.25
    if (t.lengthSq() > 1e-9) { t.normalize(); mul = 0.2 + 0.95 * new THREE.Vector3().crossVectors(t, nibRef).length() }
    out.push(base * mul)
  }
  return out
}

let _sprayTex: THREE.Texture | null = null
function sprayTexture(): THREE.Texture {
  if (_sprayTex) return _sprayTex
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d')!
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,0.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64)
  _sprayTex = new THREE.CanvasTexture(c); return _sprayTex
}

/** Symmetric copies of a point (main + mirror or radial branches). */
function expandPoint(v: THREE.Vector3, sym: SymKind, n: number): THREE.Vector3[] {
  if (sym === 'mirror') return [v.clone(), new THREE.Vector3(-v.x, v.y, v.z)]
  if (sym === 'radial') { const k = Math.max(2, n), out: THREE.Vector3[] = []; for (let i = 0; i < k; i++) out.push(v.clone().applyAxisAngle(Z_AXIS, (i / k) * Math.PI * 2)); return out }
  return [v.clone()]
}
function symCount(sym: SymKind, n: number) { return sym === 'mirror' ? 2 : sym === 'radial' ? Math.max(2, n) : 1 }
function expandPolyline(pl: THREE.Vector3[], sym: SymKind, n: number): THREE.Vector3[][] {
  const k = symCount(sym, n); const outs: THREE.Vector3[][] = Array.from({ length: k }, () => [])
  for (const v of pl) { const cs = expandPoint(v, sym, n); for (let i = 0; i < k; i++) outs[i].push(cs[i]) }
  return outs
}

function shapePolylines(a: THREE.Vector3, b: THREE.Vector3, shape: ShapeKind): THREE.Vector3[][] {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  if (shape === 'line') return [[a.clone(), b.clone()]]
  if (shape === 'circle') { const r = Math.max(0.01, Math.hypot(b.x - a.x, b.y - a.y)); const ring: THREE.Vector3[] = []; for (let i = 0; i <= 48; i++) { const t = (i / 48) * Math.PI * 2; ring.push(V(a.x + Math.cos(t) * r, a.y + Math.sin(t) * r, a.z)) } return [ring] }
  if (shape === 'rect') { const z = a.z; return [[V(a.x, a.y, z), V(b.x, a.y, z), V(b.x, b.y, z), V(a.x, b.y, z), V(a.x, a.y, z)]] }
  if (shape === 'box') {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y)
    const z0 = a.z, z1 = Math.abs(b.z - a.z) > 0.02 ? b.z : a.z + (x1 - x0) * 0.7
    const c = [V(x0, y0, z0), V(x1, y0, z0), V(x1, y1, z0), V(x0, y1, z0), V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1)]
    return [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].map(([i, j]) => [c[i].clone(), c[j].clone()])
  }
  return []
}

interface StrokeRec { copies: THREE.Vector3[][]; radii: number[] | null; radius: number; hex: string; brush: BrushKind; group: THREE.Group; layerId: string; kind?: 'surface'; closed?: boolean; light?: LightOpt }

/** A camera-pose keyframe on the animation timeline (spherical coords around target). */
interface Keyframe { id: string; az: number; polar: number; radius: number }

export function SketchStudio() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [color, setColor] = useState('#00f0ff')
  const [brush, setBrush] = useState<BrushKind>('tube')
  const [shape, setShape] = useState<ShapeKind>('free')
  const [eraser, setEraser] = useState(false)
  const [caligraphy, setCaligraphy] = useState(false)
  const [smooth, setSmooth] = useState(0.35)
  const [nibAngle, setNibAngle] = useState(45)
  const [size, setSize] = useState(6)
  const [drawMode, setDrawMode] = useState<DrawMode>('pinch')
  const [sym, setSym] = useState<SymKind>('none')
  const [radialN, setRadialN] = useState(6)
  const [depthScale, setDepthScale] = useState(1)
  const [showGrid, setShowGrid] = useState(true)
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [manualNav, setManualNav] = useState(false)
  const [surfaceClosed, setSurfaceClosed] = useState(false)
  const [lightGradient, setLightGradient] = useState<LightGradient>('warm')
  const [lightBands, setLightBands] = useState(3)
  const [lightGlow, setLightGlow] = useState(0.5)
  const [keyframes, setKeyframes] = useState<Keyframe[]>([])
  const [tlPlaying, setTlPlaying] = useState(false)
  const [tlDuration, setTlDuration] = useState(8)
  const [tlLoop, setTlLoop] = useState(true)
  const [turntable, setTurntable] = useState(false)
  const [turntableSpeed, setTurntableSpeed] = useState(0.4)
  const [bgMode, setBgMode] = useState<BgMode>('webcam')
  const [refUrl, setRefUrl] = useState<string | null>(null)
  const [refOpacity, setRefOpacity] = useState(0.5)
  const [layers, setLayers] = useState<{ id: string; name: string; visible: boolean }[]>([{ id: 'L1', name: 'Calque 1', visible: true }])
  const [activeLayer, setActiveLayer] = useState('L1')
  const [xform, setXform] = useState<null | 'translate' | 'rotate' | 'scale'>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [count, setCount] = useState(0)
  const [recording, setRecording] = useState(false)
  const recCtl = useRef<{ start: () => void; stop: () => void } | null>(null)
  const [status, setStatus] = useState('Initialisation de la caméra et du modèle…')
  const [error, setError] = useState<string | null>(null)

  const paramsRef = useRef({ color, brush, shape, eraser, caligraphy, smooth, nibAngle, size, drawMode, sym, radialN, depthScale, showGrid, showSkeleton, manualNav, surfaceClosed, lightGradient, lightBands, lightGlow, keyframes, tlDuration, tlLoop, turntable, turntableSpeed, layers, activeLayer, xform, bgMode })
  paramsRef.current = { color, brush, shape, eraser, caligraphy, smooth, nibAngle, size, drawMode, sym, radialN, depthScale, showGrid, showSkeleton, manualNav, surfaceClosed, lightGradient, lightBands, lightGlow, keyframes, tlDuration, tlLoop, turntable, turntableSpeed, layers, activeLayer, xform, bgMode }

  const clearRef = useRef(false), undoRef = useRef(false), recenterRef = useRef(false), surfaceRef = useRef(false)
  const tlAddRef = useRef(false), tlCmdRef = useRef<null | 'play' | 'stop'>(null), kfSeqRef = useRef(0)
  const exportRef = useRef<null | 'stl' | 'glb'>(null)
  const strokesRef = useRef<StrokeRec[]>([])

  useEffect(() => {
    const video = videoRef.current!, mount = mountRef.current!, overlay = overlayRef.current!
    const octx = overlay.getContext('2d')!
    let landmarker: GestureRecognizer | null = null, stream: MediaStream | null = null
    let rafId = 0, running = true, lastVideoTime = -1

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100)
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
    renderer.setClearColor(0x000000, 0); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement); renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100vw;height:100vh;'
    scene.add(new THREE.AmbientLight(0xffffff, 0.65))
    const dir = new THREE.DirectionalLight(0xffffff, 0.9); dir.position.set(1.2, 2, 2.5); scene.add(dir)
    const dir2 = new THREE.DirectionalLight(0x88bbff, 0.35); dir2.position.set(-2, -1, -1); scene.add(dir2)
    const grid = new THREE.GridHelper(4, 16, 0x2a6f7a, 0x14343a)
    ;(grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.35
    grid.position.y = -1.4; scene.add(grid)
    const strokeGroup = new THREE.Group(); scene.add(strokeGroup)
    const target = new THREE.Vector3(0, 0, 0)

    // ── Calques : un THREE.Group par calque, sous strokeGroup ──
    const layerGroups = new Map<string, THREE.Group>()
    const ensureLayer = (id: string) => { let g = layerGroups.get(id); if (!g) { g = new THREE.Group(); strokeGroup.add(g); layerGroups.set(id, g) } return g }
    ensureLayer('L1')
    const activeLayerGroup = () => ensureLayer(paramsRef.current.activeLayer)
    // Light-painting geometry options for a given brush/color (undefined = normal brush).
    const lightArg = (brush: BrushKind, hex: string): LightOpt | undefined => {
      const pp = paramsRef.current
      return brush === 'light' ? { mode: pp.lightGradient, cycle: pp.lightBands, hex, glow: pp.lightGlow } : undefined
    }

    // ── Gizmo de transformation (TransformControls) sur tout le croquis ──
    let gizmo: TransformControls | null = null, gizmoHelper: THREE.Object3D | null = null
    const bakeTransform = () => {
      strokeGroup.updateMatrix()
      const M = strokeGroup.matrix
      if (M.equals(new THREE.Matrix4())) return
      for (const s of strokesRef.current) {
        for (const cp of s.copies) for (const v of cp) v.applyMatrix4(M)
        if (s.kind === 'surface') {
          const child = s.group.children[0] as THREE.Mesh | undefined
          if (child) { const geo = buildLoftGeometry(s.copies[0], s.copies[1] ?? s.copies[0], s.closed ? s.radius : 0); if (geo) { child.geometry.dispose(); child.geometry = geo } }
          continue
        }
        let mi = 0
        for (const child of s.group.children) { const m = child as THREE.Mesh; const geo = buildStrokeGeometry(s.copies[mi] ?? s.copies[0], s.radii ?? s.radius, true, s.light); if (geo) { m.geometry.dispose(); m.geometry = geo } mi++ }
      }
      strokeGroup.position.set(0, 0, 0); strokeGroup.rotation.set(0, 0, 0); strokeGroup.scale.set(1, 1, 1); strokeGroup.updateMatrix()
    }
    try {
      gizmo = new TransformControls(camera, renderer.domElement)
      gizmoHelper = (gizmo as any).getHelper ? (gizmo as any).getHelper() : (gizmo as unknown as THREE.Object3D)
      scene.add(gizmoHelper!)
      gizmo.addEventListener('dragging-changed', (e: any) => { orbitEnabled = !e.value; if (!e.value) bakeTransform() })
      gizmo.attach(strokeGroup)
      gizmo.enabled = false; if (gizmoHelper) gizmoHelper.visible = false
    } catch { gizmo = null }

    const cam = { radius: 3.2, az: 0, polar: Math.PI / 2, targetAz: 0, targetPolar: Math.PI / 2 }
    const applyCam = () => {
      const sp = Math.sin(cam.polar), cp = Math.cos(cam.polar)
      camera.position.set(cam.radius * sp * Math.sin(cam.az), cam.radius * cp, cam.radius * sp * Math.cos(cam.az))
      camera.lookAt(target)
    }
    // Animation timeline : keyframe playback state (drives the camera when active).
    let tlActive = false, tlStart = 0
    const smoothstep = (x: number) => { const t = clamp(0, 1, x); return t * t * (3 - 2 * t) }
    /** Current camera pose as spherical coords around target — robust regardless of who
     *  currently owns the camera (gesture orbit, arcball, or playback). */
    const camPose = (): Keyframe => {
      const r = camera.position.distanceTo(target)
      return { id: '', az: Math.atan2(camera.position.x - target.x, camera.position.z - target.z), polar: Math.acos(clamp(-1, 1, (camera.position.y - target.y) / Math.max(1e-3, r))), radius: r }
    }
    const resize = () => { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); overlay.width = w; overlay.height = h }
    resize(); window.addEventListener('resize', resize)

    let dragging = false, lastX = 0, lastY = 0, orbitEnabled = true
    const onDown = (e: PointerEvent) => { if (!orbitEnabled) return; dragging = true; lastX = e.clientX; lastY = e.clientY }
    const onMove = (e: PointerEvent) => { if (!dragging) return; cam.targetAz -= (e.clientX - lastX) * 0.008; cam.targetPolar = clamp(0.2, Math.PI - 0.2, cam.targetPolar - (e.clientY - lastY) * 0.008); lastX = e.clientX; lastY = e.clientY }
    const onUp = () => { dragging = false }
    const onWheel = (e: WheelEvent) => { cam.radius = clamp(1.2, 9, cam.radius + e.deltaY * 0.002) }
    renderer.domElement.addEventListener('pointerdown', onDown); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); renderer.domElement.addEventListener('wheel', onWheel, { passive: true })

    // Manual-navigation manipulator (ArcballControls) : a visible 3D gizmo (sphere + rings)
    // to orbit/zoom the view with the mouse, toggled by the "Manipuler la vue" option.
    let arcball: ArcballControls | null = null
    try {
      arcball = new ArcballControls(camera, renderer.domElement, scene)
      arcball.enabled = false
      arcball.setGizmosVisible(false)
      arcball.enablePan = false
    } catch { arcball = null }
    let arcActive = false   // tracks the on/off transition to re-sync the spherical cam

    const disposeGroup = (g: THREE.Group) => { g.parent?.remove(g); g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() }) }

    // fingertip → world point in the plane FACING THE CURRENT CAMERA (so orbiting
    // reorients the drawing plane). depth from hand near/far shifts along the view axis.
    const drawPoint = (ndcX: number, ndcY: number, depthNorm: number, dScale: number) => {
      const forward = new THREE.Vector3().subVectors(target, camera.position).normalize()
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize()
      const up = new THREE.Vector3().crossVectors(right, forward).normalize()
      const halfH = Math.tan((55 * Math.PI / 180) / 2) * cam.radius, halfW = halfH * camera.aspect
      const depth = (depthNorm - 0.5) * 1.7 * dScale
      return target.clone().add(right.multiplyScalar(ndcX * halfW * 0.92)).add(up.multiplyScalar(ndcY * halfH * 0.92)).add(forward.multiplyScalar(-depth))
    }

    // ── active freehand stroke (with symmetry copies + optional per-point radii) ──
    let aCopies: THREE.Vector3[][] = [], aRadii: number[] = [], aMeshes: THREE.Mesh[] = []
    let aGroup: THREE.Group | null = null, aMat: THREE.Material | null = null, aRadius = 0.01, aLayerId = 'L1'
    let aNibRef = new THREE.Vector3(1, 0, 0)
    let aIsAir = false, aAir: THREE.Points | null = null, aAirPts: THREE.Vector3[] = []
    let wasDrawing = false
    // active primitive shape
    let sAnchor = new THREE.Vector3(), sEnd = new THREE.Vector3(), sKind: ShapeKind = 'free'
    let sPreview: THREE.Group | null = null, sMat: THREE.Material | null = null, sRadius = 0.01
    // fist-navigation
    let navPrev: { x: number; y: number; hs: number } | null = null
    let lastRawWp: THREE.Vector3 | null = null
    // Gesture hysteresis + gap bridging (fixes strokes breaking on brief detection flicker)
    let onState = false, graceLeft = 0
    const GRACE = 9
    // Primary-hand lock + adaptive depth (works far / standing)
    let primaryPos: { x: number; y: number } | null = null
    let handScaleMax = 0.16   // running max palm size → auto-calibrates near/far
    let fistFrames = 0   // debounce on the ML Closed_Fist gesture
    // Radial (marking) menu — opened by a hand's Open_Palm, selected by flicking out + dwell
    // Radial menu (seconds-based, hysteretic — stable & easy to aim).
    let menuOpen = false, menuCenter = { x: 0, y: 0 }, menuArmed = -1, menuDwell = 0, menuCooldown = 0, menuGrace = 0, menuProg = 0
    const MENU_R = 92, MENU_ENTER = 48, MENU_STAY = 30, MENU_DWELL = 0.5, MENU_GRACE = 0.28, MENU_COOLDOWN = 0.6, MENU_CUT = 2.4
    const applyWedge = (i: number) => {
      const w = WEDGES[i]; if (!w) return
      if (w.type === 'color') { setColor(w.hex); setEraser(false); setStatus('Couleur : ' + w.hex) }
      else if (w.type === 'brush') { const list = BRUSHES.map((b) => b.kind); const cur = list.indexOf(paramsRef.current.brush); const nx = list[(cur + 1) % list.length]; setBrush(nx); setEraser(false); setStatus('Pinceau : ' + nx) }
      else if (w.type === 'eraser') { setEraser((v) => !v); setStatus('Gomme basculée') }
    }
    const drawRadialMenu = (armed: number, progress: number, ptr: { x: number; y: number } | null) => {
      const cx = menuCenter.x, cy = menuCenter.y, R = MENU_R, n = WEDGES.length
      octx.save()
      octx.beginPath(); octx.arc(cx, cy, R + 26, 0, Math.PI * 2); octx.fillStyle = 'rgba(8,10,16,0.6)'; octx.fill()
      // dead-zone hub + pointer line for orientation
      octx.beginPath(); octx.arc(cx, cy, MENU_ENTER, 0, Math.PI * 2); octx.strokeStyle = 'rgba(255,255,255,0.18)'; octx.lineWidth = 1.5; octx.stroke()
      if (ptr) { octx.beginPath(); octx.moveTo(cx, cy); octx.lineTo(ptr.x, ptr.y); octx.strokeStyle = 'rgba(0,240,255,0.5)'; octx.lineWidth = 2; octx.stroke(); octx.beginPath(); octx.arc(ptr.x, ptr.y, 6, 0, Math.PI * 2); octx.fillStyle = '#00f0ff'; octx.fill() }
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, w = WEDGES[i]
        const wx = cx + Math.cos(a) * R, wy = cy + Math.sin(a) * R
        const on = i === armed
        octx.beginPath(); octx.arc(wx, wy, on ? 27 : 20, 0, Math.PI * 2)
        octx.fillStyle = w.type === 'color' ? w.hex : (on ? '#00f0ff' : 'rgba(255,255,255,0.18)')
        octx.globalAlpha = on ? 1 : 0.85; octx.fill(); octx.globalAlpha = 1
        octx.lineWidth = on ? 4 : 2; octx.strokeStyle = on ? '#fff' : 'rgba(255,255,255,0.5)'; octx.stroke()
        // dwell progress ring around the armed wedge
        if (on && progress > 0) { octx.beginPath(); octx.arc(wx, wy, 33, -Math.PI / 2, -Math.PI / 2 + Math.min(1, progress) * Math.PI * 2); octx.strokeStyle = '#fff'; octx.lineWidth = 4; octx.stroke() }
        if (w.type !== 'color') { octx.fillStyle = on ? '#001018' : '#ccc'; octx.font = 'bold 11px system-ui'; octx.textAlign = 'center'; octx.fillText(w.label.slice(0, 8), wx, wy + 3) }
      }
      octx.fillStyle = 'rgba(255,255,255,0.85)'; octx.font = 'bold 11px system-ui'; octx.textAlign = 'center'
      octx.fillText('pousse la paume vers un secteur, maintiens', cx, cy - R - 14)
      octx.restore()
    }
    let lastFrameT = performance.now()
    // One-Euro filter (precise, low-lag) — per-hand state object so each hand smooths itself.
    type Euro = { first: boolean; x: number; y: number; z: number; dx: number; dy: number; dz: number }
    const mkEuro = (): Euro => ({ first: true, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 })
    const euAlpha = (cut: number, dt: number) => { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt) }
    const oneEuro = (e: Euro, v: THREE.Vector3, minCut: number, dt: number): THREE.Vector3 => {
      if (e.first) { e.x = v.x; e.y = v.y; e.z = v.z; e.dx = e.dy = e.dz = 0; e.first = false; return v.clone() }
      const beta = 0.02, dcut = 1.2, aD = euAlpha(dcut, dt)
      e.dx = aD * ((v.x - e.x) / dt) + (1 - aD) * e.dx
      e.dy = aD * ((v.y - e.y) / dt) + (1 - aD) * e.dy
      e.dz = aD * ((v.z - e.z) / dt) + (1 - aD) * e.dz
      e.x += euAlpha(minCut + beta * Math.abs(e.dx), dt) * (v.x - e.x)
      e.y += euAlpha(minCut + beta * Math.abs(e.dy), dt) * (v.y - e.y)
      e.z += euAlpha(minCut + beta * Math.abs(e.dz), dt) * (v.z - e.z)
      return new THREE.Vector3(e.x, e.y, e.z)
    }
    const eu1 = mkEuro()
    const menuEuro = mkEuro()

    const rArgFor = (p: typeof paramsRef.current): number | number[] => {
      if (p.brush === 'calligA' && p.shape === 'free') return calligRadii(aCopies[0], aRadius, aNibRef)
      if (p.caligraphy && p.shape === 'free') return aRadii
      return aRadius
    }
    const rebuildActive = () => {
      if (!aGroup || aIsAir) return
      const rArg = rArgFor(paramsRef.current)
      const la = lightArg(paramsRef.current.brush, paramsRef.current.color)
      for (let c = 0; c < aMeshes.length; c++) { const g = buildStrokeGeometry(aCopies[c], rArg, false, la); if (g) { aMeshes[c].geometry.dispose(); aMeshes[c].geometry = g } }
    }
    const finalizeFree = () => {
      const p = paramsRef.current
      if (aIsAir) {
        if (aAir && aAirPts.length && aGroup) { strokesRef.current.push({ copies: [aAirPts], radii: null, radius: aRadius, hex: p.color, brush: 'airbrush', group: aGroup, layerId: aLayerId }); setCount(strokesRef.current.length) }
        else if (aGroup) disposeGroup(aGroup)
        aIsAir = false; aAir = null; aAirPts = []; aGroup = null; aMat = null; return
      }
      if (aGroup && aCopies[0]?.length >= 2) {
        const rArg = rArgFor(p); const rArr = Array.isArray(rArg) ? rArg : null
        const la = lightArg(p.brush, p.color)
        for (let c = 0; c < aMeshes.length; c++) { const g = buildStrokeGeometry(aCopies[c], rArg, true, la); if (g) { aMeshes[c].geometry.dispose(); aMeshes[c].geometry = g } }
        strokesRef.current.push({ copies: aCopies, radii: rArr, radius: aRadius, hex: p.color, brush: p.brush, group: aGroup, layerId: aLayerId, light: la })
        setCount(strokesRef.current.length)
      } else if (aGroup) disposeGroup(aGroup)
      aGroup = null; aMat = null; aCopies = []; aRadii = []; aMeshes = []
    }
    const commitShape = () => {
      const p = paramsRef.current
      if (sPreview) disposeGroup(sPreview); sPreview = null
      const polys = shapePolylines(sAnchor, sEnd, sKind)
      for (const pl of polys) {
        const copies = expandPolyline(pl, p.sym, p.radialN)
        const grp = new THREE.Group(); const meshes: THREE.Mesh[] = []
        const la = lightArg(p.brush, p.color)
        for (const cp of copies) { const geo = buildStrokeGeometry(cp, sRadius, true, la); if (geo) { const m = new THREE.Mesh(geo, makeBrushMaterial(p.brush, p.color)); m.frustumCulled = false; grp.add(m); meshes.push(m) } }
        if (meshes.length) { activeLayerGroup().add(grp); strokesRef.current.push({ copies, radii: null, radius: sRadius, hex: p.color, brush: p.brush, group: grp, layerId: p.activeLayer, light: la }) }
      }
      setCount(strokesRef.current.length)
    }

    // ── SECOND HAND (bimanuel) : tracé libre simultané, état indépendant. Le chemin
    // principal (formes / gomme / aérographe / orbite / menu) reste inchangé ; la 2ᵉ main
    // fait du tracé libre en tube avec la couleur/pinceau/taille/symétrie courants. ──
    type LM = { x: number; y: number; z: number }[]
    interface Hand2 { copies: THREE.Vector3[][]; radii: number[]; meshes: THREE.Mesh[]; group: THREE.Group | null; mat: THREE.Material | null; radius: number; layerId: string; nibRef: THREE.Vector3; drawing: boolean; onState: boolean; grace: number; lastWp: THREE.Vector3 | null; euro: Euro }
    const h2: Hand2 = { copies: [], radii: [], meshes: [], group: null, mat: null, radius: 0.01, layerId: 'L1', nibRef: new THREE.Vector3(1, 0, 0), drawing: false, onState: false, grace: 0, lastWp: null, euro: mkEuro() }
    const rArg2 = (): number | number[] => { const p = paramsRef.current; if (p.brush === 'calligA') return calligRadii(h2.copies[0], h2.radius, h2.nibRef); if (p.caligraphy) return h2.radii; return h2.radius }
    const rebuild2 = () => { if (!h2.group) return; const r = rArg2(); const la = lightArg(paramsRef.current.brush, paramsRef.current.color); for (let c = 0; c < h2.meshes.length; c++) { const g = buildStrokeGeometry(h2.copies[c], r, false, la); if (g) { h2.meshes[c].geometry.dispose(); h2.meshes[c].geometry = g } } }
    const finalize2 = () => {
      const p = paramsRef.current
      if (h2.group && h2.copies[0]?.length >= 2) {
        const r = rArg2(); const rArr = Array.isArray(r) ? r : null
        const la = lightArg(p.brush, p.color)
        for (let c = 0; c < h2.meshes.length; c++) { const g = buildStrokeGeometry(h2.copies[c], r, true, la); if (g) { h2.meshes[c].geometry.dispose(); h2.meshes[c].geometry = g } }
        strokesRef.current.push({ copies: h2.copies, radii: rArr, radius: h2.radius, hex: p.color, brush: p.brush, group: h2.group, layerId: h2.layerId, light: la }); setCount(strokesRef.current.length)
      } else if (h2.group) disposeGroup(h2.group)
      h2.group = null; h2.mat = null; h2.copies = []; h2.radii = []; h2.meshes = []; h2.drawing = false
    }
    const drawSecondHand = (lm2: LM, hs2: number, r2: number, dt: number) => {
      const p = paramsRef.current
      if (p.shape !== 'free' || p.eraser || p.brush === 'airbrush') { if (h2.drawing) finalize2(); return }
      const pinch = Math.hypot(lm2[TIP_THUMB].x - lm2[TIP_INDEX].x, lm2[TIP_THUMB].y - lm2[TIP_INDEX].y) / hs2
      let rawOn: boolean
      if (p.drawMode === 'pinch') rawOn = h2.onState ? pinch < 0.62 : pinch < 0.42
      else { const idxUp = (lm2[PIP_INDEX].y - lm2[TIP_INDEX].y) / hs2; const midFold = (lm2[TIP_MIDDLE].y - lm2[PIP_INDEX].y) / hs2; rawOn = h2.onState ? (idxUp > -0.15) : (idxUp > 0.25 && midFold > -0.15) }
      h2.onState = rawOn; if (rawOn) h2.grace = GRACE
      const ndcX = (1 - lm2[TIP_INDEX].x) * 2 - 1, ndcY = -(lm2[TIP_INDEX].y * 2 - 1)
      const depthNorm2 = clamp(0, 1, (hs2 / handScaleMax - 0.45) / 0.55)
      const wp = drawPoint(ndcX, ndcY, depthNorm2, p.depthScale)
      const dp = oneEuro(h2.euro, wp, 0.35 + (1 - p.smooth) * 6.5, dt)
      const speed = h2.lastWp ? dp.distanceTo(h2.lastWp) : 0; h2.lastWp = dp.clone()
      const calR = r2 * clamp(0.32, 1.6, 1.45 - speed * 6)
      if (rawOn) {
        if (!h2.drawing) {
          h2.mat = makeBrushMaterial(p.brush, p.color); h2.radius = r2; h2.layerId = p.activeLayer
          const fwd = new THREE.Vector3().subVectors(target, camera.position).normalize(); const rgt = new THREE.Vector3().crossVectors(fwd, camera.up).normalize(); const upv = new THREE.Vector3().crossVectors(rgt, fwd).normalize(); const ang = p.nibAngle * Math.PI / 180
          h2.nibRef = rgt.multiplyScalar(Math.cos(ang)).add(upv.multiplyScalar(Math.sin(ang))).normalize()
          const k = symCount(p.sym, p.radialN)
          h2.copies = expandPoint(dp, p.sym, p.radialN).map((v) => [v]); h2.radii = [calR]
          h2.group = new THREE.Group(); h2.meshes = []
          for (let c = 0; c < k; c++) { const m = new THREE.Mesh(new THREE.BufferGeometry(), h2.mat); m.frustumCulled = false; h2.group.add(m); h2.meshes.push(m) }
          activeLayerGroup().add(h2.group)
        } else {
          const last = h2.copies[0][h2.copies[0].length - 1]
          if (dp.distanceTo(last) > Math.max(0.006, r2 * 0.55)) { const cs = expandPoint(dp, p.sym, p.radialN); for (let c = 0; c < h2.copies.length; c++) { h2.copies[c].push(cs[c]); if (h2.copies[c].length > 500) h2.copies[c].shift() } h2.radii.push(calR); if (h2.radii.length > 500) h2.radii.shift() }
        }
        rebuild2(); h2.drawing = true
      } else if (h2.drawing) { if (h2.grace > 0) h2.grace--; else finalize2() }
      const sx = (1 - lm2[TIP_INDEX].x) * overlay.width, sy = lm2[TIP_INDEX].y * overlay.height
      octx.beginPath(); octx.arc(sx, sy, rawOn ? 13 : 7, 0, Math.PI * 2); octx.globalAlpha = 0.7; octx.fillStyle = rawOn ? p.color : 'rgba(255,255,255,0.5)'; octx.fill(); octx.globalAlpha = 1; octx.lineWidth = 2; octx.strokeStyle = p.color; octx.stroke()
    }

    const doExport = (fmt: 'stl' | 'glb') => {
      const recs = strokesRef.current
      if (!recs.length) { setStatus('Rien à exporter — trace d\'abord un croquis.'); return }
      const build = (s: StrokeRec): THREE.BufferGeometry[] => {
        if (s.kind === 'surface') {
          const g = buildLoftGeometry(s.copies[0], s.copies[1] ?? s.copies[0], s.closed ? Math.max(0.012, s.radius) : 0.012)
          return g ? [g] : []   // always give exports a solid shell so the mesh stays watertight
        }
        if (s.brush === 'airbrush') {
          const pts = s.copies[0] ?? [], step = Math.max(1, Math.ceil(pts.length / 800)), geoms: THREE.BufferGeometry[] = []
          for (let i = 0; i < pts.length; i += step) { const v = pts[i]; const sph = new THREE.SphereGeometry(s.radius * 1.4, 6, 5); sph.translate(v.x, v.y, v.z); geoms.push(sph) }
          return geoms
        }
        return s.copies.map((cp) => buildStrokeGeometry(cp, s.radii ?? s.radius, true)).filter(Boolean) as THREE.BufferGeometry[]
      }
      if (fmt === 'stl') {
        const geoms: THREE.BufferGeometry[] = []; for (const s of recs) geoms.push(...build(s))
        if (!geoms.length) return
        const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false)
        const stl = new STLExporter().parse(new THREE.Mesh(merged, new THREE.MeshStandardMaterial()), { binary: false })
        downloadBlob(new Blob([stl], { type: 'model/stl' }), `sketch-${Date.now()}.stl`); merged.dispose()
        setStatus(`Export STL : ${recs.length} traits (maillage étanche imprimable).`)
      } else {
        const g = new THREE.Group()
        for (const s of recs) for (const geo of build(s)) g.add(new THREE.Mesh(geo, makeBrushMaterial(s.brush, s.hex)))
        new GLTFExporter().parse(g, (res) => { downloadBlob(new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' }), `sketch-${Date.now()}.glb`); g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() }) }, () => setStatus('Échec export GLB.'), { binary: true })
        setStatus(`Export GLB : ${recs.length} traits (couleurs conservées).`)
      }
    }

    // ── Enregistrement vidéo : composite webcam + 3D + overlay → WebM ──
    let recCanvas: HTMLCanvasElement | null = null, recCtx: CanvasRenderingContext2D | null = null
    let recorder: MediaRecorder | null = null, recChunks: Blob[] = [], recActive = false
    const startRec = () => {
      if (recActive) return
      recCanvas = document.createElement('canvas'); recCanvas.width = overlay.width; recCanvas.height = overlay.height
      recCtx = recCanvas.getContext('2d')
      const stream = recCanvas.captureStream(30)
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
      recChunks = []
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
      recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data) }
      recorder.onstop = () => { downloadBlob(new Blob(recChunks, { type: 'video/webm' }), `sketch-ar-${Date.now()}.webm`); recChunks = []; setStatus('Vidéo enregistrée (WebM).') }
      recorder.start(); recActive = true; setRecording(true); setStatus('● Enregistrement…')
    }
    const stopRec = () => { if (recActive && recorder) { recorder.stop(); recActive = false; setRecording(false) } }
    recCtl.current = { start: startRec, stop: stopRec }   // called directly from the button (instant)

    const loop = () => {
      if (!running) return
      const p = paramsRef.current
      const nowT = performance.now()
      const frameDt = clamp(0.001, 0.05, (nowT - lastFrameT) / 1000)
      lastFrameT = nowT
      if (clearRef.current) { strokesRef.current = strokesRef.current.filter((s) => { if (s.layerId === p.activeLayer) { disposeGroup(s.group); return false } return true }); setCount(strokesRef.current.length); if (aGroup) disposeGroup(aGroup); if (sPreview) disposeGroup(sPreview); aGroup = sPreview = null; aCopies = []; aMeshes = []; aIsAir = false; aAir = null; aAirPts = []; wasDrawing = false; onState = false; graceLeft = 0; eu1.first = true; if (h2.group) disposeGroup(h2.group); h2.group = null; h2.copies = []; h2.meshes = []; h2.drawing = false; h2.euro.first = true; clearRef.current = false }
      if (undoRef.current) { for (let i = strokesRef.current.length - 1; i >= 0; i--) { if (strokesRef.current[i].layerId === p.activeLayer) { disposeGroup(strokesRef.current[i].group); strokesRef.current.splice(i, 1); setCount(strokesRef.current.length); break } } undoRef.current = false }
      if (recenterRef.current) { cam.targetAz = 0; cam.targetPolar = Math.PI / 2; recenterRef.current = false }
      if (surfaceRef.current) {
        surfaceRef.current = false
        const solids = strokesRef.current.filter((s) => s.brush !== 'airbrush' && s.kind !== 'surface')
        if (solids.length < 2) setStatus('Trace au moins 2 traits pour tendre une surface.')
        else {
          const s1 = solids[solids.length - 2], s2 = solids[solids.length - 1]
          const thick = p.surfaceClosed ? Math.max(0.012, (s1.radius + s2.radius) * 0.5) : 0
          const geo = buildLoftGeometry(s1.copies[0], s2.copies[0], thick)
          if (geo) {
            const grp = new THREE.Group(); const m = new THREE.Mesh(geo, makeSurfaceMaterial(p.color)); m.frustumCulled = false; grp.add(m)
            activeLayerGroup().add(grp)
            strokesRef.current.push({ copies: [s1.copies[0].map((v) => v.clone()), s2.copies[0].map((v) => v.clone())], radii: null, radius: thick, hex: p.color, brush: 'tube', group: grp, layerId: p.activeLayer, kind: 'surface', closed: p.surfaceClosed })
            setCount(strokesRef.current.length)
            setStatus(p.surfaceClosed ? '🧊 Surface fermée (étanche) tendue entre les 2 derniers traits.' : '🧊 Membrane tendue entre les 2 derniers traits.')
          } else setStatus('Traits trop courts pour tendre une surface.')
        }
      }
      if (tlAddRef.current) {
        tlAddRef.current = false
        const kf = { ...camPose(), id: 'kf' + (++kfSeqRef.current) }
        setKeyframes((k) => [...k, kf]); setStatus(`⏱️ Vue ${'#'}${kfSeqRef.current} ajoutée à la timeline.`)
      }
      if (tlCmdRef.current) {
        const cmd = tlCmdRef.current; tlCmdRef.current = null
        if (cmd === 'play' && (p.keyframes?.length ?? 0) >= 2) { tlActive = true; tlStart = nowT; setTlPlaying(true); setStatus('▶️ Lecture de l\'animation…') }
        else if (cmd === 'play') { setStatus('Ajoute au moins 2 vues pour animer.') }
        else { tlActive = false; setTlPlaying(false); setStatus('⏸️ Animation arrêtée.') }
      }
      if (exportRef.current) { doExport(exportRef.current); exportRef.current = null }
      // sync layers + gizmo from React state
      { const wanted = new Set(p.layers.map((l) => l.id)); for (const l of p.layers) ensureLayer(l.id).visible = l.visible; for (const [id, g] of layerGroups) { if (!wanted.has(id)) { disposeGroup(g); layerGroups.delete(id); strokesRef.current = strokesRef.current.filter((s) => s.layerId !== id); setCount(strokesRef.current.length) } } }
      if (gizmo) { const want = !!p.xform; gizmo.enabled = want; if (gizmoHelper) gizmoHelper.visible = want; if (want && p.xform) gizmo.setMode(p.xform) }
      grid.visible = p.showGrid
      octx.clearRect(0, 0, overlay.width, overlay.height)
      let cursor: { x: number; y: number; on: boolean; mode: 'draw' | 'erase' | 'nav' } | null = null
      let depthNorm = 0.5

      if (video.readyState >= 2 && video.currentTime !== lastVideoTime && landmarker) {
        lastVideoTime = video.currentTime
        const res = landmarker.recognizeForVideo(video, performance.now())
        const hands = res.landmarks ?? []
        const gestures = res.gestures ?? []
        if (hands.length > 0) {
          // PRIMARY-HAND LOCK : keep the hand whose wrist is nearest to last frame's → we
          // never switch to a second hand that wanders into frame. Track its INDEX so we
          // can read its ML gesture too.
          let pi = 0
          if (primaryPos && hands.length > 1) {
            let best = 1e9
            for (let i = 0; i < hands.length; i++) { const d = Math.hypot(hands[i][0].x - primaryPos.x, hands[i][0].y - primaryPos.y); if (d < best) { best = d; pi = i } }
          }
          const lm = hands[pi]
          const gName = gestures[pi]?.[0]?.categoryName ?? 'None'
          primaryPos = { x: lm[0].x, y: lm[0].y }
          const idx = lm[TIP_INDEX], thumb = lm[TIP_THUMB]
          const ndcX = (1 - idx.x) * 2 - 1, ndcY = -(idx.y * 2 - 1)
          // Palm size (scale-invariant). Auto-calibrating depth : near = hand close to its
          // recent max size, far = small → works standing / far away.
          const hs = Math.max(0.02, Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y))
          handScaleMax = Math.max(hs, handScaleMax * 0.97)
          depthNorm = clamp(0, 1, (hs / handScaleMax - 0.45) / 0.55)
          // FIST (orbit) straight from the ML gesture classifier → reliable, no open-palm/
          // pinch false triggers. Small debounce only. (No !onState guard : a closed fist has
          // thumb+index close, which the pinch hysteresis would read as "still drawing" and
          // wrongly block the fist — the ML gesture already separates fist from pinch.)
          const rawFist = gName === 'Closed_Fist'
          fistFrames = rawFist ? Math.min(fistFrames + 1, 12) : 0
          const fist = fistFrames >= 2
          if (fist) onState = false   // a fist cancels any lingering draw-gesture state
          const sx = (1 - idx.x) * overlay.width, sy = idx.y * overlay.height
          const radius = Math.max(0.004, p.size * 0.0016 * cam.radius * (BRUSHES.find((b) => b.kind === p.brush)?.rMul ?? 1))

          if (p.xform) {
            // transform mode : le gizmo (souris) gère la pose ; pas de dessin à la main
            navPrev = null
            if (wasDrawing) { if (sPreview) commitShape(); else finalizeFree(); wasDrawing = false }
            if (h2.drawing) finalize2()
          } else if (fist) {
            // ── NAVIGATE : poing fermé → orbite + zoom par la main ──
            if (wasDrawing) { if (sPreview) commitShape(); else finalizeFree(); wasDrawing = false }
            if (h2.drawing) finalize2()
            const hx = lm[9].x, hy = lm[9].y
            if (navPrev) {
              cam.targetAz -= (hx - navPrev.x) * 4
              cam.targetPolar = clamp(0.18, Math.PI - 0.18, cam.targetPolar - (hy - navPrev.y) * 4)
              // ZOOM from RAW palm-size delta (approche = plus grand → zoom in). The adaptive
              // depthNorm can't drive zoom (it self-cancels), so we use hs directly.
              cam.radius = clamp(1.2, 9, cam.radius - (hs - navPrev.hs) * 26)
            }
            navPrev = { x: hx, y: hy, hs }
            cursor = { x: (1 - lm[9].x) * overlay.width, y: lm[9].y * overlay.height, on: true, mode: 'nav' }
          } else {
            navPrev = null
            // Gestures NORMALIZED by palm size (hs) → same feel close-up or far/standing.
            const pinch = Math.hypot(idx.x - thumb.x, idx.y - thumb.y) / hs
            let rawOn: boolean
            if (p.drawMode === 'pinch') rawOn = onState ? pinch < 0.62 : pinch < 0.42   // hysteresis
            else {
              const idxUp = (lm[PIP_INDEX].y - lm[TIP_INDEX].y) / hs    // >0 : index tip above its knuckle
              const midFold = (lm[TIP_MIDDLE].y - lm[PIP_INDEX].y) / hs // >0 : middle folded below index knuckle
              rawOn = onState ? (idxUp > -0.15) : (idxUp > 0.25 && midFold > -0.15)
            }
            onState = rawOn
            if (rawOn) graceLeft = GRACE
            const on = rawOn
            cursor = { x: sx, y: sy, on, mode: p.eraser ? 'erase' : 'draw' }
            const wp = drawPoint(ndcX, ndcY, depthNorm, p.depthScale)
            // One-Euro : suivi précis et peu laggé (le slider Lissage règle le cutoff)
            const minCut = 0.35 + (1 - p.smooth) * 6.5
            const dp = oneEuro(eu1, wp, minCut, frameDt)
            const speed = lastRawWp ? dp.distanceTo(lastRawWp) : 0; lastRawWp = dp.clone()
            const calR = radius * clamp(0.32, 1.6, 1.45 - speed * 6)

            if (on && p.eraser) {
              const er = Math.max(0.05, radius * 6)
              for (let i = strokesRef.current.length - 1; i >= 0; i--) { const s = strokesRef.current[i]; if (s.copies.some((cp) => cp.some((q) => q.distanceTo(wp) < er))) { disposeGroup(s.group); strokesRef.current.splice(i, 1) } }
              setCount(strokesRef.current.length); wasDrawing = false
            } else if (on && p.brush === 'airbrush') {
              // aérographe : nuage de points doux accumulé autour du doigt
              if (!wasDrawing) {
                aIsAir = true; aRadius = radius; aLayerId = p.activeLayer
                aMat = new THREE.PointsMaterial({ color: new THREE.Color(p.color), map: sprayTexture(), size: radius * 4, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
                aAirPts = []; aGroup = new THREE.Group(); aAir = new THREE.Points(new THREE.BufferGeometry(), aMat as THREE.PointsMaterial); aAir.frustumCulled = false; aGroup.add(aAir); activeLayerGroup().add(aGroup)
              }
              for (let s = 0; s < 5; s++) { const j = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(radius * 2.4); aAirPts.push(dp.clone().add(j)) }
              if (aAirPts.length > 4000) aAirPts.splice(0, aAirPts.length - 4000)
              const arr = new Float32Array(aAirPts.length * 3); for (let i = 0; i < aAirPts.length; i++) { arr[i * 3] = aAirPts[i].x; arr[i * 3 + 1] = aAirPts[i].y; arr[i * 3 + 2] = aAirPts[i].z }
              if (aAir) { aAir.geometry.dispose(); const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(arr, 3)); aAir.geometry = bg }
              wasDrawing = true
            } else if (on && p.shape !== 'free') {
              sEnd = wp
              if (!wasDrawing) { sAnchor = wp.clone(); sKind = p.shape; sRadius = radius; sMat = makeBrushMaterial(p.brush, p.color); sPreview = new THREE.Group(); strokeGroup.add(sPreview) }
              if (sPreview) {
                for (let i = sPreview.children.length - 1; i >= 0; i--) { const m = sPreview.children[i] as THREE.Mesh; m.geometry?.dispose(); sPreview.remove(m) }
                { const la = lightArg(p.brush, p.color); for (const pl of shapePolylines(sAnchor, sEnd, sKind)) for (const cp of expandPolyline(pl, p.sym, p.radialN)) { const geo = buildStrokeGeometry(cp, sRadius, false, la); if (geo) { const m = new THREE.Mesh(geo, sMat!); m.frustumCulled = false; sPreview.add(m) } } }
              }
              wasDrawing = true
            } else if (on) {
              if (!wasDrawing) {
                aMat = makeBrushMaterial(p.brush, p.color); aRadius = radius
                { const fwd = new THREE.Vector3().subVectors(target, camera.position).normalize(); const rgt = new THREE.Vector3().crossVectors(fwd, camera.up).normalize(); const upv = new THREE.Vector3().crossVectors(rgt, fwd).normalize(); const ang = p.nibAngle * Math.PI / 180; aNibRef = rgt.multiplyScalar(Math.cos(ang)).add(upv.multiplyScalar(Math.sin(ang))).normalize() }
                const k = symCount(p.sym, p.radialN)
                aCopies = expandPoint(dp, p.sym, p.radialN).map((v) => [v]); aRadii = [calR]
                aGroup = new THREE.Group(); aMeshes = []
                for (let c = 0; c < k; c++) { const m = new THREE.Mesh(new THREE.BufferGeometry(), aMat); m.frustumCulled = false; aGroup.add(m); aMeshes.push(m) }
                aLayerId = p.activeLayer; activeLayerGroup().add(aGroup)
              } else {
                const last = aCopies[0][aCopies[0].length - 1]
                if (dp.distanceTo(last) > Math.max(0.006, radius * 0.55)) {
                  const cs = expandPoint(dp, p.sym, p.radialN)
                  for (let c = 0; c < aCopies.length; c++) { aCopies[c].push(cs[c]); if (aCopies[c].length > 500) aCopies[c].shift() }
                  aRadii.push(calR); if (aRadii.length > 500) aRadii.shift()
                }
              }
              rebuildActive(); wasDrawing = true
            } else if (wasDrawing) {
              // Gesture briefly released → keep the stroke alive for GRACE frames so a
              // one-frame detection flicker doesn't split it. Only commit after grace.
              if (graceLeft > 0 && !p.eraser) { graceLeft-- }
              else { if (sPreview) commitShape(); else finalizeFree(); wasDrawing = false }
            }
            // SECOND HAND (bimanuel) : tracé libre simultané avec une 2e main (≠ primaire,
            // ni paume-menu ni poing). Elle dessine en même temps que la main principale.
            let sIdx = -1
            for (let i = 0; i < hands.length; i++) { const g = gestures[i]?.[0]?.categoryName; if (i !== pi && g !== 'Open_Palm' && g !== 'Closed_Fist') { sIdx = i; break } }
            if (sIdx >= 0) { const lm2 = hands[sIdx] as unknown as LM; const hs2 = Math.max(0.02, Math.hypot(lm2[0].x - lm2[9].x, lm2[0].y - lm2[9].y)); drawSecondHand(lm2, hs2, radius, frameDt) }
            else if (h2.drawing) { if (h2.grace > 0) h2.grace--; else finalize2() }
          }

          if (p.showSkeleton) {
            octx.strokeStyle = fist ? 'rgba(255,200,0,0.5)' : 'rgba(0,240,255,0.35)'; octx.lineWidth = 2
            for (const chain of FINGER_CHAINS) { octx.beginPath(); chain.forEach((i, k) => { const px = (1 - lm[i].x) * overlay.width, py = lm[i].y * overlay.height; if (k === 0) octx.moveTo(px, py); else octx.lineTo(px, py) }); octx.stroke() }
          }

          // ── RADIAL MENU : n'importe quelle main en PAUME OUVERTE l'ouvre (l'autre main
          // continue de dessiner). Pousse la paume vers un secteur et maintiens pour choisir.
          if (menuCooldown > 0) menuCooldown = Math.max(0, menuCooldown - frameDt)
          let palmLm: typeof lm | null = null
          for (let i = 0; i < hands.length; i++) { if (gestures[i]?.[0]?.categoryName === 'Open_Palm') { palmLm = hands[i]; break } }
          if (palmLm && menuCooldown === 0) {
            menuGrace = MENU_GRACE
            // smoothed pointer (palm centre = wrist↔middle-MCP midpoint) → stable aiming
            const rawx = (1 - (palmLm[0].x + palmLm[9].x) / 2) * overlay.width, rawy = ((palmLm[0].y + palmLm[9].y) / 2) * overlay.height
            const sp = oneEuro(menuEuro, new THREE.Vector3(rawx, rawy, 0), MENU_CUT, frameDt)
            if (!menuOpen) { menuOpen = true; menuCenter = { x: clamp(MENU_R + 34, overlay.width - MENU_R - 34, sp.x), y: clamp(MENU_R + 34, overlay.height - MENU_R - 34, sp.y) }; menuArmed = -1; menuDwell = 0 }
            const dx = sp.x - menuCenter.x, dy = sp.y - menuCenter.y, dist = Math.hypot(dx, dy)
            const n = WEDGES.length, sector = (Math.PI * 2) / n
            // arm only past the enter-radius ; once armed, keep it until below the (smaller)
            // stay-radius → radial hysteresis kills the on/off flicker near the dead-zone edge.
            let armed = menuArmed
            if (dist > MENU_ENTER || (menuArmed >= 0 && dist > MENU_STAY)) {
              let a = Math.atan2(dy, dx); if (a < 0) a += Math.PI * 2
              let nearest = Math.round(a / sector) % n; if (nearest < 0) nearest += n
              // angular hysteresis : stick to the current sector unless clearly inside another
              if (menuArmed >= 0 && nearest !== menuArmed) { let d = Math.abs(a - menuArmed * sector) % (Math.PI * 2); d = Math.min(d, Math.PI * 2 - d); if (d < sector / 2 + 0.16) nearest = menuArmed }
              armed = nearest
            } else armed = -1
            if (armed >= 0 && armed === menuArmed) menuDwell += frameDt
            else if (armed >= 0) { menuArmed = armed; menuDwell = 0 }
            else menuDwell = Math.max(0, menuDwell - frameDt * 1.5)   // back in dead-zone → decay, don't hard-reset
            if (menuArmed >= 0 && menuDwell >= MENU_DWELL) { applyWedge(menuArmed); menuOpen = false; menuArmed = -1; menuDwell = 0; menuProg = 0; menuCooldown = MENU_COOLDOWN; menuEuro.first = true }
            if (menuOpen) { menuProg += (menuDwell / MENU_DWELL - menuProg) * 0.3; drawRadialMenu(menuArmed, menuProg, { x: sp.x, y: sp.y }) }
          } else if (menuOpen && menuGrace > 0) {
            // Open_Palm briefly misclassified → hold the menu (frozen) instead of closing/reopening
            menuGrace -= frameDt; menuDwell = Math.max(0, menuDwell - frameDt)
            menuProg += (menuDwell / MENU_DWELL - menuProg) * 0.3
            drawRadialMenu(menuArmed, menuProg, null)
          } else { menuOpen = false; menuArmed = -1; menuDwell = 0; menuProg = 0; menuEuro.first = true }
        } else if (wasDrawing) {
          // Hand momentarily lost → bridge with grace too, then commit.
          if (graceLeft > 0) { graceLeft-- }
          else { if (sPreview) commitShape(); else finalizeFree(); wasDrawing = false; onState = false }
          navPrev = null; lastRawWp = null; eu1.first = true
        }
        if (hands.length === 0) { fistFrames = 0; if (h2.drawing) { if (h2.grace > 0) h2.grace--; else finalize2() } h2.euro.first = true; if (menuOpen) { menuGrace -= frameDt; menuDwell = Math.max(0, menuDwell - frameDt); if (menuGrace <= 0) { menuOpen = false; menuArmed = -1; menuDwell = 0; menuProg = 0; menuEuro.first = true } } }
      }

      if (cursor) {
        octx.beginPath(); octx.arc(cursor.x, cursor.y, cursor.mode === 'nav' ? 20 : cursor.on ? 15 : 8, 0, Math.PI * 2)
        octx.fillStyle = cursor.mode === 'nav' ? 'rgba(255,200,0,0.35)' : cursor.mode === 'erase' ? 'rgba(255,80,80,0.5)' : (cursor.on ? p.color : 'rgba(255,255,255,0.55)')
        octx.globalAlpha = 0.8; octx.fill(); octx.globalAlpha = 1
        octx.lineWidth = 2; octx.strokeStyle = cursor.mode === 'nav' ? '#ffc800' : cursor.mode === 'erase' ? '#ff5050' : p.color; octx.stroke()
        if (cursor.mode === 'nav') { octx.fillStyle = '#ffc800'; octx.font = 'bold 12px system-ui'; octx.fillText('ORBITE (poing) — tourne · avance/recule = zoom', cursor.x + 24, cursor.y) }
      }
      // depth gauge
      const gx = overlay.width - 34, gy0 = overlay.height * 0.28, gh = overlay.height * 0.44
      octx.fillStyle = 'rgba(255,255,255,0.12)'; octx.fillRect(gx, gy0, 8, gh)
      octx.fillStyle = p.color; octx.fillRect(gx - 3, gy0 + gh * (1 - depthNorm) - 3, 14, 6)
      octx.fillStyle = 'rgba(255,255,255,0.55)'; octx.font = '10px system-ui'; octx.fillText('proche', gx - 34, gy0 + 4); octx.fillText('loin', gx - 24, gy0 + gh)

      // Camera : timeline playback owns it first ; then the manual manipulator (arcball) ;
      // otherwise the gesture/mouse spherical orbit (with optional turntable) does.
      if (tlActive && (p.keyframes?.length ?? 0) >= 2) {
        if (arcball && arcActive) { arcActive = false; arcball.enabled = false; arcball.setGizmosVisible(false); orbitEnabled = true }
        const kfs = p.keyframes
        let t = ((nowT - tlStart) / 1000) / Math.max(0.5, p.tlDuration)
        if (p.tlLoop) t = t - Math.floor(t)
        else if (t >= 1) { t = 1; tlActive = false; setTlPlaying(false); setStatus('✓ Animation terminée.') }
        const seg = clamp(0, 1, t) * (kfs.length - 1)
        const i = Math.min(kfs.length - 2, Math.floor(seg)), f = smoothstep(seg - i)
        const a = kfs[i], b = kfs[i + 1]
        let daz = b.az - a.az; while (daz > Math.PI) daz -= 2 * Math.PI; while (daz < -Math.PI) daz += 2 * Math.PI
        cam.az = a.az + daz * f
        cam.polar = clamp(0.15, Math.PI - 0.15, a.polar + (b.polar - a.polar) * f)
        cam.radius = clamp(1.0, 12, a.radius + (b.radius - a.radius) * f)
        cam.targetAz = cam.az; cam.targetPolar = cam.polar
        applyCam()
      } else if (arcball && p.manualNav) {
        if (!arcActive) { arcActive = true; orbitEnabled = false; arcball.enabled = true; arcball.setGizmosVisible(true) }
        arcball.update()
        cam.radius = camera.position.distanceTo(target)   // keep the draw-plane scale in sync
      } else {
        if (p.turntable) cam.targetAz += p.turntableSpeed * frameDt   // 🎠 auto-rotation
        if (arcActive) {
          arcActive = false; if (arcball) { arcball.enabled = false; arcball.setGizmosVisible(false) }
          orbitEnabled = true
          cam.radius = clamp(1.2, 9, camera.position.distanceTo(target) || cam.radius)
          cam.polar = Math.acos(clamp(-1, 1, camera.position.y / Math.max(1e-3, cam.radius)))
          cam.az = Math.atan2(camera.position.x, camera.position.z)
          cam.targetAz = cam.az; cam.targetPolar = cam.polar
        }
        cam.az += (cam.targetAz - cam.az) * 0.15; cam.polar += (cam.targetPolar - cam.polar) * 0.15
        applyCam()
      }
      renderer.render(scene, camera)
      // composite the recording frame (webcam + 3D + hand overlay)
      if (recActive && recCtx && recCanvas) {
        const w = recCanvas.width, h = recCanvas.height
        if (p.bgMode === 'webcam' && video.readyState >= 2) { recCtx.save(); recCtx.translate(w, 0); recCtx.scale(-1, 1); recCtx.drawImage(video, 0, 0, w, h); recCtx.restore() }
        else { recCtx.fillStyle = '#05060f'; recCtx.fillRect(0, 0, w, h) }
        recCtx.drawImage(renderer.domElement, 0, 0, w, h)
        recCtx.drawImage(overlay, 0, 0, w, h)
      }
      rafId = requestAnimationFrame(loop)
    }

    const init = async () => {
      try {
        // Higher resolution → the hand stays detectable when you're far / standing
        // (a small hand in the frame has enough pixels). Falls back if 720p is refused.
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }))
        video.srcObject = stream; await new Promise<void>((res) => { video.onloadedmetadata = () => res() }); await video.play()
        const files = await FilesetResolver.forVisionTasks(WASM_BASE)
        // numHands:2 → we can ASSOCIATE the primary drawing hand across frames (nearest
        // to last position) instead of MediaPipe arbitrarily switching to the other hand.
        // Low presence/tracking confidence keeps the hand through marginal frames; the
        // One-Euro filter + hysteresis absorb the extra noise.
        landmarker = await GestureRecognizer.createFromOptions(files, { baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3 })
        setStatus('Prêt — trace, ferme le POING pour tourner la vue, dessine dans le nouveau plan ✦'); loop()
      } catch (e: any) { setError(`Caméra ou modèle indisponible : ${e?.message ?? e}`) }
    }
    init()

    return () => {
      running = false; if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointerdown', onDown); renderer.domElement.removeEventListener('wheel', onWheel)
      try { landmarker?.close() } catch { /* noop */ }
      if (stream) stream.getTracks().forEach((t) => t.stop()); video.srcObject = null
      for (const s of strokesRef.current) s.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() })
      strokesRef.current = []; try { gizmo?.dispose() } catch { /* noop */ }
      try { arcball?.dispose() } catch { /* noop */ }
      if (h2.group) h2.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() })
      try { if (recActive && recorder) recorder.stop() } catch { /* noop */ }
      renderer.dispose(); if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (!f) return; if (refUrl) URL.revokeObjectURL(refUrl); setRefUrl(URL.createObjectURL(f)); e.target.value = '' }
  const exportPng = () => {
    const three = mountRef.current?.querySelector('canvas') as HTMLCanvasElement | null; if (!three) return
    const out = document.createElement('canvas'); out.width = three.width; out.height = three.height; const c = out.getContext('2d')!
    if (bgMode === 'webcam' && videoRef.current && videoRef.current.readyState >= 2) { c.save(); c.translate(out.width, 0); c.scale(-1, 1); c.drawImage(videoRef.current, 0, 0, out.width, out.height); c.restore() } else { c.fillStyle = '#05060f'; c.fillRect(0, 0, out.width, out.height) }
    c.drawImage(three, 0, 0, out.width, out.height); out.toBlob((b) => { if (b) downloadBlob(b, `sketch-ar-${Date.now()}.png`) }, 'image/png')
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden', userSelect: 'none', fontFamily: 'system-ui' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)', zIndex: 1, opacity: bgMode === 'webcam' ? 1 : 0 }} />
      {refUrl && <img src={refUrl} alt="" style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'contain', zIndex: 2, opacity: refOpacity, pointerEvents: 'none' }} />}
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 3 }} />
      <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', zIndex: 4, pointerEvents: 'none' }} />
      {!panelOpen && <button onClick={() => setPanelOpen(true)} style={{ position: 'absolute', top: 16, left: 16, zIndex: 11, ...selStyle, width: 'auto', padding: '8px 12px' }}>☰</button>}
      {panelOpen && (
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, width: 300, background: 'rgba(10,10,15,0.86)', padding: 18, borderRadius: 16, backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', color: '#ccc' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>Sketch AR 3D · Pro</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link><button onClick={() => setPanelOpen(false)} style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16 }}>«</button></div>
          </div>
          <div style={{ color: error ? '#ff6b6b' : '#7a7a85', fontSize: 11, marginBottom: 10, lineHeight: 1.3 }}>{error ?? status}</div>
          <div style={{ fontSize: 10, color: '#ffc800', marginBottom: 12, lineHeight: 1.35, background: 'rgba(255,200,0,0.08)', padding: 7, borderRadius: 6 }}>✊ <b>Poing</b> = orbite (bouge/zoom). 🖐 <b>Paume ouverte</b> (2ᵉ main) = menu radial : pousse la paume vers un secteur (couleur / pinceau / gomme) et maintiens.</div>

          <Field label="Pinceau"><select value={brush} onChange={(e) => { setBrush(e.target.value as BrushKind); setEraser(false) }} style={selStyle}>{BRUSHES.map((b) => <option key={b.kind} value={b.kind}>{b.label}</option>)}</select></Field>
          {brush === 'calligA' && <Field label={`Angle de plume — ${nibAngle}°`}><input type="range" min={0} max={180} value={nibAngle} onChange={(e) => setNibAngle(+e.target.value)} style={rngStyle} /></Field>}
          {brush === 'light' && <div style={{ background: 'rgba(0,240,255,0.06)', border: '1px solid rgba(0,240,255,0.2)', borderRadius: 8, padding: 10, marginBottom: 12 }}>
            <Field label="Dégradé de la traînée"><select value={lightGradient} onChange={(e) => setLightGradient(e.target.value as LightGradient)} style={selStyle}><option value="warm">🔥 Chaud (orange→jaune)</option><option value="rainbow">🌈 Arc-en-ciel</option><option value="mono">🎨 Ma couleur (dégradée)</option></select></Field>
            <Field label={`Bandes de lumière — ${lightBands}`}><input type="range" min={1} max={12} step={1} value={lightBands} onChange={(e) => setLightBands(+e.target.value)} style={rngStyle} /></Field>
            <div style={{ marginBottom: 0 }}><div style={{ fontSize: 11, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{`Lueur (halo) — ${Math.round(lightGlow * 100)}%`}</div><input type="range" min={0} max={1} step={0.05} value={lightGlow} onChange={(e) => setLightGlow(+e.target.value)} style={rngStyle} /></div>
            <p style={{ color: '#888', fontSize: 10, margin: '8px 0 0', lineHeight: 1.35 }}>Traînée lumineuse additive facon photo longue-exposition — superbe sur fond noir.</p>
          </div>}
          {brush !== 'airbrush' && <label style={chkRow}><input type="checkbox" checked={caligraphy} onChange={(e) => setCaligraphy(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ✒️ Épaisseur selon vitesse</label>}
          <Field label={`Lissage de ligne — ${Math.round(smooth * 100)}%`}><input type="range" min={0} max={0.9} step={0.05} value={smooth} onChange={(e) => setSmooth(+e.target.value)} style={rngStyle} /></Field>
          <Field label="Forme (posée aux deux points)"><select value={shape} onChange={(e) => { setShape(e.target.value as ShapeKind); setEraser(false) }} style={selStyle}>{SHAPES.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}</select></Field>
          <button onClick={() => setEraser((v) => !v)} style={{ ...selStyle, marginBottom: 12, background: eraser ? 'rgba(255,80,80,0.28)' : 'rgba(255,255,255,0.1)', borderColor: eraser ? 'rgba(255,80,80,0.6)' : 'rgba(255,255,255,0.2)' }}>🧽 Gomme 3D {eraser ? '— ACTIVE' : ''}</button>

          <button onClick={() => { surfaceRef.current = true }} title="Tend une membrane pleine entre les deux derniers traits tracés" style={{ ...selStyle, marginBottom: 6, background: 'rgba(0,240,255,0.14)', borderColor: 'rgba(0,240,255,0.4)' }}>🧊 Surface entre 2 traits</button>
          <label style={{ ...chkRow, marginBottom: 12 }} title="Extrude la membrane en une coque fermée épaisse (maillage étanche imprimable)"><input type="checkbox" checked={surfaceClosed} onChange={(e) => setSurfaceClosed(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> 🧱 Surface fermée (étanche, volume)</label>

          <Field label="Couleur & épaisseur"><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} /><input type="range" min={2} max={24} value={size} onChange={(e) => setSize(+e.target.value)} style={{ ...rngStyle, flex: 1 }} /><span style={{ fontSize: 12, width: 20, textAlign: 'right' }}>{size}</span></div></Field>
          <Field label="Geste de tracé"><select value={drawMode} onChange={(e) => setDrawMode(e.target.value as DrawMode)} style={selStyle}><option value="pinch">✌️ Pince (pouce + index)</option><option value="index">☝️ Index levé</option></select></Field>

          <Field label="Symétrie"><select value={sym} onChange={(e) => setSym(e.target.value as SymKind)} style={selStyle}><option value="none">Aucune</option><option value="mirror">⇋ Miroir</option><option value="radial">✳️ Radiale (N branches)</option></select></Field>
          {sym === 'radial' && <Field label={`Branches — ${radialN}`}><input type="range" min={2} max={16} value={radialN} onChange={(e) => setRadialN(+e.target.value)} style={rngStyle} /></Field>}

          <Field label={`Profondeur 3D (main proche/loin) — ×${depthScale.toFixed(1)}`}><input type="range" min={0} max={3} step={0.1} value={depthScale} onChange={(e) => setDepthScale(+e.target.value)} style={rngStyle} /></Field>
          <label style={chkRow}><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ▦ Grille de repère</label>
          <label style={chkRow}><input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ✋ Squelette de la main</label>
          <label style={chkRow} title="Affiche un manipulateur 3D (sphère + anneaux) : glisse pour orbiter, molette pour zoomer"><input type="checkbox" checked={manualNav} onChange={(e) => setManualNav(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> 🧭 Manipuler la vue (souris)</label>

          <Field label="Image de référence (à décalquer)">
            <div style={{ display: 'flex', gap: 6 }}><button onClick={() => fileRef.current?.click()} style={{ ...selStyle, flex: 1 }}>📥 Importer</button>{refUrl && <button onClick={() => { URL.revokeObjectURL(refUrl); setRefUrl(null) }} style={{ ...selStyle, flex: 1, background: 'rgba(255,40,100,0.2)', borderColor: 'rgba(255,40,100,0.4)' }}>Retirer</button>}</div>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
            {refUrl && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}><span style={{ fontSize: 11, color: '#aaa' }}>Opacité</span><input type="range" min={0.05} max={1} step={0.05} value={refOpacity} onChange={(e) => setRefOpacity(+e.target.value)} style={{ ...rngStyle, flex: 1 }} /></div>}
          </Field>
          <Field label="Fond"><select value={bgMode} onChange={(e) => setBgMode(e.target.value as BgMode)} style={selStyle}><option value="webcam">📷 Webcam (AR)</option><option value="black">⬛ Noir</option></select></Field>

          <div style={{ fontSize: 10, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, margin: '4px 0 6px' }}>Calques</div>
          {layers.map((l) => (
            <div key={l.id} onClick={() => setActiveLayer(l.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', marginBottom: 4, borderRadius: 6, cursor: 'pointer', border: `1px solid ${activeLayer === l.id ? '#00f0ff' : 'rgba(255,255,255,0.15)'}`, background: activeLayer === l.id ? 'rgba(0,240,255,0.12)' : 'transparent' }}>
              <button onClick={(e) => { e.stopPropagation(); setLayers((ls) => ls.map((x) => x.id === l.id ? { ...x, visible: !x.visible } : x)) }} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13 }}>{l.visible ? '👁' : '🚫'}</button>
              <span style={{ flex: 1, fontSize: 12 }}>{l.name}</span>
              {layers.length > 1 && <button onClick={(e) => { e.stopPropagation(); setLayers((ls) => { const nx = ls.filter((x) => x.id !== l.id); if (activeLayer === l.id) setActiveLayer(nx[0].id); return nx }) }} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#ff6b6b', fontSize: 12 }}>🗑</button>}
            </div>
          ))}
          <button onClick={() => { const id = 'L' + Date.now(); setLayers((ls) => [...ls, { id, name: 'Calque ' + (ls.length + 1), visible: true }]); setActiveLayer(id) }} style={{ ...selStyle, marginBottom: 12 }}>+ Nouveau calque</button>

          <div style={{ fontSize: 10, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, margin: '4px 0 6px' }}>Transformer (gizmo souris)</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {(['translate', 'rotate', 'scale'] as const).map((mode) => (
              <button key={mode} onClick={() => setXform((x) => x === mode ? null : mode)} style={{ ...selStyle, flex: 1, fontSize: 11, padding: 6, background: xform === mode ? 'rgba(0,240,255,0.28)' : 'rgba(255,255,255,0.1)', borderColor: xform === mode ? '#00f0ff' : 'rgba(255,255,255,0.2)' }}>{mode === 'translate' ? '↔ Placer' : mode === 'rotate' ? '⟳ Tourner' : '⤢ Échelle'}</button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8 }}><button onClick={() => { undoRef.current = true }} style={{ ...selStyle, flex: 1 }}>↶ Annuler</button><button onClick={() => { recenterRef.current = true }} style={{ ...selStyle, flex: 1 }}>⊙ Vue</button><button onClick={() => { clearRef.current = true }} style={{ ...selStyle, flex: 1, background: 'rgba(255,40,100,0.2)', borderColor: 'rgba(255,40,100,0.4)' }} title="Efface le calque actif">Effacer</button></div>
          <div style={{ fontSize: 10, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' }}>⏱️ Animation de la vue</div>
          <label style={{ ...chkRow, marginTop: 2 }} title="Rotation continue automatique de la vue autour du croquis"><input type="checkbox" checked={turntable} onChange={(e) => setTurntable(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> 🎠 Turntable (rotation auto)</label>
          {turntable && <Field label={`Vitesse — ${turntableSpeed.toFixed(2)} rad/s`}><input type="range" min={0.05} max={1.5} step={0.05} value={turntableSpeed} onChange={(e) => setTurntableSpeed(+e.target.value)} style={rngStyle} /></Field>}
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <button onClick={() => { tlAddRef.current = true }} style={{ ...selStyle, flex: 2 }} title="Mémorise l'angle et le zoom actuels comme étape de l'animation">＋ Vue actuelle</button>
            <button onClick={() => { kfSeqRef.current = 0; setKeyframes([]); if (tlPlaying) tlCmdRef.current = 'stop' }} disabled={!keyframes.length} style={{ ...selStyle, flex: 1, opacity: keyframes.length ? 1 : 0.4 }}>Vider</button>
          </div>
          {keyframes.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>{keyframes.map((k, i) => (<span key={k.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'rgba(0,240,255,0.14)', border: '1px solid rgba(0,240,255,0.3)', borderRadius: 5, padding: '2px 6px' }}>Vue {i + 1}<button onClick={() => setKeyframes((ks) => ks.filter((x) => x.id !== k.id))} style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>✕</button></span>))}</div>}
          <Field label={`Durée — ${tlDuration}s`}><input type="range" min={2} max={30} step={1} value={tlDuration} onChange={(e) => setTlDuration(+e.target.value)} style={rngStyle} /></Field>
          <label style={chkRow}><input type="checkbox" checked={tlLoop} onChange={(e) => setTlLoop(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> 🔁 Boucle</label>
          <button onClick={() => { tlCmdRef.current = tlPlaying ? 'stop' : 'play' }} disabled={keyframes.length < 2} style={{ ...selStyle, marginBottom: 4, opacity: keyframes.length < 2 ? 0.4 : 1, background: tlPlaying ? 'rgba(255,180,0,0.28)' : 'rgba(0,240,255,0.16)', borderColor: tlPlaying ? 'rgba(255,180,0,0.6)' : 'rgba(0,240,255,0.4)' }} title="Anime la caméra entre les vues mémorisées — enregistrable en vidéo">{tlPlaying ? '⏸ Arrêter l\'animation' : '▶️ Lire l\'animation'}</button>
          <p style={{ color: '#777', fontSize: 10, marginTop: 2, marginBottom: 0, lineHeight: 1.35 }}>Place la vue puis « ＋ Vue actuelle » à chaque étape (≥ 2), puis ▶️. Lance l'enregistrement vidéo pendant la lecture pour capturer le rendu.</p>

          <div style={{ fontSize: 10, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' }}>Export ({count} traits)</div>
          <button onClick={() => { recording ? recCtl.current?.stop() : recCtl.current?.start() }} style={{ ...selStyle, marginBottom: 8, background: recording ? 'rgba(255,40,60,0.35)' : 'rgba(255,255,255,0.1)', borderColor: recording ? '#ff2840' : 'rgba(255,255,255,0.2)' }}>
            {recording ? '⏹ Arrêter l\'enregistrement' : '🔴 Enregistrer une vidéo (WebM)'}
          </button>
          <div style={{ display: 'flex', gap: 8 }}><button onClick={exportPng} style={{ ...selStyle, flex: 1 }}>📸 PNG</button><button onClick={() => { exportRef.current = 'glb' }} style={{ ...selStyle, flex: 1 }}>🧊 .glb</button><button onClick={() => { exportRef.current = 'stl' }} style={{ ...selStyle, flex: 1 }} title="Maillage étanche pour impression 3D">🖨️ .stl</button></div>
          <p style={{ color: '#777', fontSize: 10, marginTop: 10, marginBottom: 0, lineHeight: 1.4 }}>Poing = orbite/zoom · main proche/loin = profondeur z · souris = tourner · molette = zoom · .stl = solide imprimable</p>
        </div>
      )}
    </div>
  )
}

function downloadBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500) }
const selStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: 8, borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }
const rngStyle: React.CSSProperties = { width: '100%', accentColor: '#00f0ff' }
const chkRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#ccc', marginTop: 8, marginBottom: 8, cursor: 'pointer' }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return (<div style={{ marginBottom: 12 }}><div style={{ fontSize: 11, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>{children}</div>) }
