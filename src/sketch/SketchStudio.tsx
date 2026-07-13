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
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

const TIP_THUMB = 4, TIP_INDEX = 8, TIP_MIDDLE = 12, PIP_INDEX = 6
const FINGER_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const UP = new THREE.Vector3(0, 1, 0)
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

type BrushKind = 'tube' | 'neon' | 'marker' | 'metal' | 'wire' | 'calligA' | 'airbrush'
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
]
const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: 'free', label: '✏️ Libre (main levée)' }, { kind: 'line', label: '📏 Ligne droite' },
  { kind: 'circle', label: '⭕ Cercle' }, { kind: 'rect', label: '▭ Rectangle' }, { kind: 'box', label: '📦 Boîte 3D (profondeur)' },
]

function makeBrushMaterial(kind: BrushKind, hex: string): THREE.Material {
  const color = new THREE.Color(hex)
  switch (kind) {
    case 'neon': return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    case 'marker': return new THREE.MeshBasicMaterial({ color })
    case 'metal': return new THREE.MeshStandardMaterial({ color, metalness: 0.95, roughness: 0.22 })
    case 'wire': return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    case 'calligA': return new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.5 })
    case 'tube': default: return new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.55 })
  }
}

/** Constant-radius tube (TubeGeometry) or, when `r` is an array, a variable-radius
 *  tube (calligraphie). Optionally closed by end-cap spheres → maillage étanche. */
function buildStrokeGeometry(pts: THREE.Vector3[], r: number | number[], capped: boolean): THREE.BufferGeometry | null {
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

interface StrokeRec { copies: THREE.Vector3[][]; radii: number[] | null; radius: number; hex: string; brush: BrushKind; group: THREE.Group; layerId: string }

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

  const paramsRef = useRef({ color, brush, shape, eraser, caligraphy, smooth, nibAngle, size, drawMode, sym, radialN, depthScale, showGrid, showSkeleton, layers, activeLayer, xform, bgMode })
  paramsRef.current = { color, brush, shape, eraser, caligraphy, smooth, nibAngle, size, drawMode, sym, radialN, depthScale, showGrid, showSkeleton, layers, activeLayer, xform, bgMode }

  const clearRef = useRef(false), undoRef = useRef(false), recenterRef = useRef(false)
  const exportRef = useRef<null | 'stl' | 'glb'>(null)
  const strokesRef = useRef<StrokeRec[]>([])

  useEffect(() => {
    const video = videoRef.current!, mount = mountRef.current!, overlay = overlayRef.current!
    const octx = overlay.getContext('2d')!
    let landmarker: HandLandmarker | null = null, stream: MediaStream | null = null
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

    // ── Gizmo de transformation (TransformControls) sur tout le croquis ──
    let gizmo: TransformControls | null = null, gizmoHelper: THREE.Object3D | null = null
    const bakeTransform = () => {
      strokeGroup.updateMatrix()
      const M = strokeGroup.matrix
      if (M.equals(new THREE.Matrix4())) return
      for (const s of strokesRef.current) {
        for (const cp of s.copies) for (const v of cp) v.applyMatrix4(M)
        let mi = 0
        for (const child of s.group.children) { const m = child as THREE.Mesh; const geo = buildStrokeGeometry(s.copies[mi] ?? s.copies[0], s.radii ?? s.radius, true); if (geo) { m.geometry.dispose(); m.geometry = geo } mi++ }
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
    const resize = () => { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); overlay.width = w; overlay.height = h }
    resize(); window.addEventListener('resize', resize)

    let dragging = false, lastX = 0, lastY = 0, orbitEnabled = true
    const onDown = (e: PointerEvent) => { if (!orbitEnabled) return; dragging = true; lastX = e.clientX; lastY = e.clientY }
    const onMove = (e: PointerEvent) => { if (!dragging) return; cam.targetAz -= (e.clientX - lastX) * 0.008; cam.targetPolar = clamp(0.2, Math.PI - 0.2, cam.targetPolar - (e.clientY - lastY) * 0.008); lastX = e.clientX; lastY = e.clientY }
    const onUp = () => { dragging = false }
    const onWheel = (e: WheelEvent) => { cam.radius = clamp(1.2, 9, cam.radius + e.deltaY * 0.002) }
    renderer.domElement.addEventListener('pointerdown', onDown); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); renderer.domElement.addEventListener('wheel', onWheel, { passive: true })

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
    let navPrev: { x: number; y: number; d: number } | null = null
    let lastRawWp: THREE.Vector3 | null = null
    // Gesture hysteresis + gap bridging (fixes strokes breaking on brief detection flicker)
    let onState = false, graceLeft = 0
    const GRACE = 9
    // Primary-hand lock + adaptive depth (works far / standing)
    let primaryPos: { x: number; y: number } | null = null
    let handScaleMax = 0.16   // running max palm size → auto-calibrates near/far
    let fistState = false, fistFrames = 0   // robust fist detection (hysteresis + debounce)
    let lastFrameT = performance.now()
    // One-Euro filter (precise, low-lag hand smoothing) — per world component
    let euFirst = true, euX = 0, euY = 0, euZ = 0, euDX = 0, euDY = 0, euDZ = 0
    const euAlpha = (cut: number, dt: number) => { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt) }
    const oneEuro = (v: THREE.Vector3, minCut: number, dt: number): THREE.Vector3 => {
      if (euFirst) { euX = v.x; euY = v.y; euZ = v.z; euDX = euDY = euDZ = 0; euFirst = false; return v.clone() }
      const beta = 0.02, dcut = 1.2, aD = euAlpha(dcut, dt)
      euDX = aD * ((v.x - euX) / dt) + (1 - aD) * euDX
      euDY = aD * ((v.y - euY) / dt) + (1 - aD) * euDY
      euDZ = aD * ((v.z - euZ) / dt) + (1 - aD) * euDZ
      euX += euAlpha(minCut + beta * Math.abs(euDX), dt) * (v.x - euX)
      euY += euAlpha(minCut + beta * Math.abs(euDY), dt) * (v.y - euY)
      euZ += euAlpha(minCut + beta * Math.abs(euDZ), dt) * (v.z - euZ)
      return new THREE.Vector3(euX, euY, euZ)
    }

    const rArgFor = (p: typeof paramsRef.current): number | number[] => {
      if (p.brush === 'calligA' && p.shape === 'free') return calligRadii(aCopies[0], aRadius, aNibRef)
      if (p.caligraphy && p.shape === 'free') return aRadii
      return aRadius
    }
    const rebuildActive = () => {
      if (!aGroup || aIsAir) return
      const rArg = rArgFor(paramsRef.current)
      for (let c = 0; c < aMeshes.length; c++) { const g = buildStrokeGeometry(aCopies[c], rArg, false); if (g) { aMeshes[c].geometry.dispose(); aMeshes[c].geometry = g } }
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
        for (let c = 0; c < aMeshes.length; c++) { const g = buildStrokeGeometry(aCopies[c], rArg, true); if (g) { aMeshes[c].geometry.dispose(); aMeshes[c].geometry = g } }
        strokesRef.current.push({ copies: aCopies, radii: rArr, radius: aRadius, hex: p.color, brush: p.brush, group: aGroup, layerId: aLayerId })
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
        for (const cp of copies) { const geo = buildStrokeGeometry(cp, sRadius, true); if (geo) { const m = new THREE.Mesh(geo, makeBrushMaterial(p.brush, p.color)); m.frustumCulled = false; grp.add(m); meshes.push(m) } }
        if (meshes.length) { activeLayerGroup().add(grp); strokesRef.current.push({ copies, radii: null, radius: sRadius, hex: p.color, brush: p.brush, group: grp, layerId: p.activeLayer }) }
      }
      setCount(strokesRef.current.length)
    }

    const doExport = (fmt: 'stl' | 'glb') => {
      const recs = strokesRef.current
      if (!recs.length) { setStatus('Rien à exporter — trace d\'abord un croquis.'); return }
      const build = (s: StrokeRec): THREE.BufferGeometry[] => {
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
      if (clearRef.current) { strokesRef.current = strokesRef.current.filter((s) => { if (s.layerId === p.activeLayer) { disposeGroup(s.group); return false } return true }); setCount(strokesRef.current.length); if (aGroup) disposeGroup(aGroup); if (sPreview) disposeGroup(sPreview); aGroup = sPreview = null; aCopies = []; aMeshes = []; aIsAir = false; aAir = null; aAirPts = []; wasDrawing = false; onState = false; graceLeft = 0; euFirst = true; clearRef.current = false }
      if (undoRef.current) { for (let i = strokesRef.current.length - 1; i >= 0; i--) { if (strokesRef.current[i].layerId === p.activeLayer) { disposeGroup(strokesRef.current[i].group); strokesRef.current.splice(i, 1); setCount(strokesRef.current.length); break } } undoRef.current = false }
      if (recenterRef.current) { cam.targetAz = 0; cam.targetPolar = Math.PI / 2; recenterRef.current = false }
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
        const hands = (landmarker.detectForVideo(video, performance.now()).landmarks) ?? []
        if (hands.length > 0) {
          // PRIMARY-HAND LOCK : among detected hands, keep the one nearest to last frame's
          // wrist → we never switch to a second hand that wanders into frame.
          let lm = hands[0]
          if (primaryPos && hands.length > 1) {
            let best = 1e9
            for (const h of hands) { const d = Math.hypot(h[0].x - primaryPos.x, h[0].y - primaryPos.y); if (d < best) { best = d; lm = h } }
          }
          primaryPos = { x: lm[0].x, y: lm[0].y }
          const idx = lm[TIP_INDEX], thumb = lm[TIP_THUMB]
          const ndcX = (1 - idx.x) * 2 - 1, ndcY = -(idx.y * 2 - 1)
          // Palm size (scale-invariant reference). Auto-calibrating depth : near = when the
          // hand is close to its recent max size, far = small → works standing / far away.
          const hs = Math.max(0.02, Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y))
          handScaleMax = Math.max(hs, handScaleMax * 0.97)   // recalibrates the near-ref in ~0.5s
          depthNorm = clamp(0, 1, (hs / handScaleMax - 0.45) / 0.55)
          // Robust FIST (orbit) : all fingertips curled INTO the palm AND the thumb/index
          // are clearly APART. The pinch draw-gesture also curls the index, so we require
          // thumb-index separation (a pinch brings them together) → a pinch is never read
          // as a fist. Also never fires while a draw gesture is active (onState). Hysteresis
          // + 4-frame debounce so a stray frame can't flip into orbit mid-stroke.
          const tipDist = (t: number) => Math.hypot(lm[t].x - lm[9].x, lm[t].y - lm[9].y) / hs
          const thumbIndexApart = Math.hypot(lm[TIP_THUMB].x - lm[TIP_INDEX].x, lm[TIP_THUMB].y - lm[TIP_INDEX].y) / hs
          const curlT = fistState ? 1.25 : 0.9
          const allCurled = tipDist(8) < curlT && tipDist(12) < curlT && tipDist(16) < curlT && tipDist(20) < curlT
          const rawFist = allCurled && thumbIndexApart > 0.7
          fistState = rawFist
          fistFrames = rawFist ? Math.min(fistFrames + 1, 12) : 0
          const fist = fistFrames >= 4 && !onState
          const sx = (1 - idx.x) * overlay.width, sy = idx.y * overlay.height
          const radius = Math.max(0.004, p.size * 0.0016 * cam.radius * (BRUSHES.find((b) => b.kind === p.brush)?.rMul ?? 1))

          if (p.xform) {
            // transform mode : le gizmo (souris) gère la pose ; pas de dessin à la main
            navPrev = null
            if (wasDrawing) { if (sPreview) commitShape(); else finalizeFree(); wasDrawing = false }
          } else if (fist) {
            // ── NAVIGATE : poing fermé → orbite + zoom par la main ──
            if (wasDrawing) { if (sPreview) commitShape(); else finalizeFree(); wasDrawing = false }
            const hx = lm[9].x, hy = lm[9].y
            if (navPrev) {
              cam.targetAz -= (hx - navPrev.x) * 5
              cam.targetPolar = clamp(0.18, Math.PI - 0.18, cam.targetPolar - (hy - navPrev.y) * 5)
              cam.radius = clamp(1.2, 9, cam.radius + (navPrev.d - depthNorm) * 4)
            }
            navPrev = { x: hx, y: hy, d: depthNorm }
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
            const dp = oneEuro(wp, minCut, frameDt)
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
                for (const pl of shapePolylines(sAnchor, sEnd, sKind)) for (const cp of expandPolyline(pl, p.sym, p.radialN)) { const geo = buildStrokeGeometry(cp, sRadius, false); if (geo) { const m = new THREE.Mesh(geo, sMat!); m.frustumCulled = false; sPreview.add(m) } }
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
          }

          if (p.showSkeleton) {
            octx.strokeStyle = fist ? 'rgba(255,200,0,0.5)' : 'rgba(0,240,255,0.35)'; octx.lineWidth = 2
            for (const chain of FINGER_CHAINS) { octx.beginPath(); chain.forEach((i, k) => { const px = (1 - lm[i].x) * overlay.width, py = lm[i].y * overlay.height; if (k === 0) octx.moveTo(px, py); else octx.lineTo(px, py) }); octx.stroke() }
          }
        } else if (wasDrawing) {
          // Hand momentarily lost → bridge with grace too, then commit.
          if (graceLeft > 0) { graceLeft-- }
          else { if (sPreview) commitShape(); else finalizeFree(); wasDrawing = false; onState = false }
          navPrev = null; lastRawWp = null; euFirst = true
        }
        if (hands.length === 0) { fistFrames = 0; fistState = false }
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

      cam.az += (cam.targetAz - cam.az) * 0.15; cam.polar += (cam.targetPolar - cam.polar) * 0.15
      applyCam(); renderer.render(scene, camera)
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
        landmarker = await HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3 })
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
          <div style={{ fontSize: 10, color: '#ffc800', marginBottom: 12, lineHeight: 1.35, background: 'rgba(255,200,0,0.08)', padding: 7, borderRadius: 6 }}>✊ Ferme le <b>poing</b> = mode orbite : bouge pour tourner, avance/recule pour zoomer, puis dessine dans le nouveau plan.</div>

          <Field label="Pinceau"><select value={brush} onChange={(e) => { setBrush(e.target.value as BrushKind); setEraser(false) }} style={selStyle}>{BRUSHES.map((b) => <option key={b.kind} value={b.kind}>{b.label}</option>)}</select></Field>
          {brush === 'calligA' && <Field label={`Angle de plume — ${nibAngle}°`}><input type="range" min={0} max={180} value={nibAngle} onChange={(e) => setNibAngle(+e.target.value)} style={rngStyle} /></Field>}
          {brush !== 'airbrush' && <label style={chkRow}><input type="checkbox" checked={caligraphy} onChange={(e) => setCaligraphy(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ✒️ Épaisseur selon vitesse</label>}
          <Field label={`Lissage de ligne — ${Math.round(smooth * 100)}%`}><input type="range" min={0} max={0.9} step={0.05} value={smooth} onChange={(e) => setSmooth(+e.target.value)} style={rngStyle} /></Field>
          <Field label="Forme (posée aux deux points)"><select value={shape} onChange={(e) => { setShape(e.target.value as ShapeKind); setEraser(false) }} style={selStyle}>{SHAPES.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}</select></Field>
          <button onClick={() => setEraser((v) => !v)} style={{ ...selStyle, marginBottom: 12, background: eraser ? 'rgba(255,80,80,0.28)' : 'rgba(255,255,255,0.1)', borderColor: eraser ? 'rgba(255,80,80,0.6)' : 'rgba(255,255,255,0.2)' }}>🧽 Gomme 3D {eraser ? '— ACTIVE' : ''}</button>

          <Field label="Couleur & épaisseur"><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} /><input type="range" min={2} max={24} value={size} onChange={(e) => setSize(+e.target.value)} style={{ ...rngStyle, flex: 1 }} /><span style={{ fontSize: 12, width: 20, textAlign: 'right' }}>{size}</span></div></Field>
          <Field label="Geste de tracé"><select value={drawMode} onChange={(e) => setDrawMode(e.target.value as DrawMode)} style={selStyle}><option value="pinch">✌️ Pince (pouce + index)</option><option value="index">☝️ Index levé</option></select></Field>

          <Field label="Symétrie"><select value={sym} onChange={(e) => setSym(e.target.value as SymKind)} style={selStyle}><option value="none">Aucune</option><option value="mirror">⇋ Miroir</option><option value="radial">✳️ Radiale (N branches)</option></select></Field>
          {sym === 'radial' && <Field label={`Branches — ${radialN}`}><input type="range" min={2} max={16} value={radialN} onChange={(e) => setRadialN(+e.target.value)} style={rngStyle} /></Field>}

          <Field label={`Profondeur 3D (main proche/loin) — ×${depthScale.toFixed(1)}`}><input type="range" min={0} max={3} step={0.1} value={depthScale} onChange={(e) => setDepthScale(+e.target.value)} style={rngStyle} /></Field>
          <label style={chkRow}><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ▦ Grille de repère</label>
          <label style={chkRow}><input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ✋ Squelette de la main</label>

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
