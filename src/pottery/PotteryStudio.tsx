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

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const GESTURE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'

const TIP_THUMB = 4, TIP_INDEX = 8, MID_MCP = 9, WRIST = 0
const FINGER_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

// ── Clay profile discretisation ──────────────────────────────────────────────
const NR = 140          // height rings
const NS = 80           // angular segments
const Y0 = -0.9         // wheel plate height (world Y of the base)
const HMAX = 1.7        // max clay height (world units)
const DY = HMAX / (NR - 1)
const MAXR = 1.15       // max radius
const MINWALL = 0.03    // min wall thickness (clay can't tear to zero)
const FLOOR_RINGS = 4   // bottom rings kept solid (closed floor)
const EPS = 0.006
const VOL_K = 0.245     // world-volume per "kg" of clay (mass 1 → a ~0.5-radius lump)

type Tool = 'pull' | 'open' | 'widen' | 'collar' | 'rib' | 'trim'
const TOOLS: { kind: Tool; label: string; hint: string }[] = [
  { kind: 'pull', label: '✋ Monter / centrer', hint: 'Deux mains en pince encadrent la paroi (int. + ext.) ; monte les mains pour monter la paroi.' },
  { kind: 'open', label: '👇 Ouvrir', hint: 'Une main au centre, descends : creuse le godet depuis le haut.' },
  { kind: 'widen', label: '🫄 Élargir (ventre)', hint: 'Pousse la paroi vers l\'extérieur à la hauteur des mains.' },
  { kind: 'collar', label: '🫗 Resserrer (col)', hint: 'Referme la paroi (col de vase) à la hauteur des mains.' },
  { kind: 'rib', label: '🧽 Lisser', hint: 'Lisse fortement la paroi localement.' },
  { kind: 'trim', label: '🔪 Trancher', hint: 'Coupe l\'argile au-dessus de la main (araser le bord).' },
]

/** Surface-of-revolution mesh from the outer/inner radial profiles. Outer wall + inner
 *  wall (bore) + base disc + bore-bottom cap + rim (annulus or apex). Double-sided. */
function buildPotGeometry(rOut: Float32Array, rIn: Float32Array, top: number): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = []
  const outerBase: number[] = [], innerBase: number[] = [], hasInner: boolean[] = []
  for (let i = 0; i <= top; i++) {
    const y = Y0 + i * DY
    outerBase[i] = pos.length / 3
    for (let j = 0; j < NS; j++) { const a = (j / NS) * Math.PI * 2; pos.push(Math.cos(a) * rOut[i], y, Math.sin(a) * rOut[i]) }
    const inner = rIn[i] > EPS
    hasInner[i] = inner
    if (inner) { innerBase[i] = pos.length / 3; for (let j = 0; j < NS; j++) { const a = (j / NS) * Math.PI * 2; pos.push(Math.cos(a) * rIn[i], y, Math.sin(a) * rIn[i]) } }
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
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals()
  return g
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
  const [clayColor, setClayColor] = useState('#b5651d')
  const [wireframe, setWireframe] = useState(false)
  const [showGuides, setShowGuides] = useState(true)
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [bgMode, setBgMode] = useState<'webcam' | 'black'>('webcam')
  const [panelOpen, setPanelOpen] = useState(true)
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState('Initialisation de la caméra et du modèle…')
  const [error, setError] = useState<string | null>(null)

  const paramsRef = useRef({ wheelSpeed, clayMass, smoothing, conserve, tool, strength, clayColor, wireframe, showGuides, showSkeleton, bgMode })
  paramsRef.current = { wheelSpeed, clayMass, smoothing, conserve, tool, strength, clayColor, wireframe, showGuides, showSkeleton, bgMode }
  const resetRef = useRef(true)          // rebuild the lump
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
    mount.appendChild(renderer.domElement); renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100vw;height:100vh;'
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const key = new THREE.DirectionalLight(0xfff2e0, 1.0); key.position.set(1.5, 2.5, 2.2); scene.add(key)
    const fill = new THREE.DirectionalLight(0x88bbff, 0.35); fill.position.set(-2, 0.5, -1); scene.add(fill)

    // Spinning wheel : plate + a notch marker + the clay mesh, all rotating about Y.
    const spin = new THREE.Group(); scene.add(spin)
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.0, 0.09, 64), new THREE.MeshStandardMaterial({ color: 0x333842, roughness: 0.7, metalness: 0.3 }))
    plate.position.y = Y0 - 0.055; spin.add(plate)
    const notch = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.14), new THREE.MeshStandardMaterial({ color: 0x00e0c0, roughness: 0.4 }))
    notch.position.set(0.78, Y0 - 0.03, 0); spin.add(notch)
    const clayMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(clayColor), roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide })
    const clayMesh = new THREE.Mesh(new THREE.BufferGeometry(), clayMat); clayMesh.frustumCulled = false; spin.add(clayMesh)

    // ── Clay state (radial profiles) ──
    const rOut = new Float32Array(NR), rIn = new Float32Array(NR)
    let top = 10, V0 = 0.245, wheelAngle = 0

    const volume = () => { let v = 0; for (let i = 0; i <= top; i++) v += Math.PI * Math.max(0, rOut[i] * rOut[i] - rIn[i] * rIn[i]) * DY; return v }
    const resetClay = (mass: number) => {
      V0 = VOL_K * mass
      const R = Math.min(0.72, Math.cbrt(V0 / (0.625 * Math.PI)))   // mound of volume V0
      const domeH = R * 1.25
      top = clamp(6, NR - 2, Math.round(domeH / DY))
      for (let i = 0; i < NR; i++) {
        if (i <= top) { const h = i * DY; rOut[i] = Math.max(0.02, R * Math.sqrt(clamp(0, 1, 1 - h / domeH))); rIn[i] = 0 }
        else { rOut[i] = 0; rIn[i] = 0 }
      }
      V0 = volume()
    }
    resetClay(clayMass)

    // Full 3D orbit around the pot. The shaping plane follows the camera azimuth, so
    // changing the view angle genuinely changes where/how the fingers sculpt.
    const target = new THREE.Vector3(0, Y0 + HMAX * 0.42, 0)
    let camDist = 3.0, camAz = 0, camPolar = 1.12   // polar : 0.3 (top-down) … 1.5 (side)
    const applyCam = () => { const sp = Math.sin(camPolar), cp = Math.cos(camPolar); camera.position.set(target.x + camDist * sp * Math.sin(camAz), target.y + camDist * cp, target.z + camDist * sp * Math.cos(camAz)); camera.lookAt(target) }
    applyCam()

    const resize = () => { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); overlay.width = w; overlay.height = h }
    resize(); window.addEventListener('resize', resize)

    // Mouse : drag = orbit (azimuth + inclination), wheel = zoom.
    let dragging = false, lastX = 0, lastY = 0
    const onDown = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY }
    const onMove = (e: PointerEvent) => { if (!dragging) return; camAz -= (e.clientX - lastX) * 0.006; camPolar = clamp(0.32, 1.5, camPolar - (e.clientY - lastY) * 0.006); lastX = e.clientX; lastY = e.clientY }
    const onUp = () => { dragging = false }
    const onWheel = (e: WheelEvent) => { camDist = clamp(1.6, 6, camDist + e.deltaY * 0.002) }
    renderer.domElement.addEventListener('pointerdown', onDown); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); renderer.domElement.addEventListener('wheel', onWheel, { passive: true })

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
      _plane.set(new THREE.Vector3(Math.cos(camAz), 0, -Math.sin(camAz)), 0)   // contains the Y axis + camera
      const hit = raycaster.ray.intersectPlane(_plane, new THREE.Vector3())
      if (!hit) return null
      const rad = Math.max(0, hit.x * Math.sin(camAz) + hit.z * Math.cos(camAz))   // horizontal distance from axis
      const g = clamp(0, 1, (hit.y - Y0) / HMAX)
      return { rad, ring: clamp(0, NR - 1, Math.round(g * (NR - 1))) }
    }
    let skelHands: { x: number; y: number }[][] = []   // last landmarks (screen px, mirrored) for the skeleton

    type Contact = { rad: number; ring: number; press: number; sx: number; sy: number; inner: boolean }
    let hud: { contacts: Contact[]; toolLabel: string } = { contacts: [], toolLabel: '' }

    // Gaussian falloff over ~ band width in rings.
    const bandW = (k: number, center: number, sigma: number) => Math.exp(-((k - center) * (k - center)) / (2 * sigma * sigma))

    const applyTool = (contacts: Contact[], p: typeof paramsRef.current, dt: number) => {
      const eng = contacts.filter((c) => c.press > 0.15)
      if (!eng.length) return
      const rate = clamp(0, 0.9, p.strength * Math.min(1, dt * 9))
      const sigma = 4   // tighter band → finger-level precision
      if (p.tool === 'pull') {
        if (eng.length >= 2) {
          const s = [...eng].sort((a, b) => a.rad - b.rad); const inn = s[0], out = s[s.length - 1]
          const center = Math.round((inn.ring + out.ring) / 2), press = Math.min(inn.press, out.press)
          for (let k = FLOOR_RINGS; k <= top; k++) { const w = bandW(k, center, sigma) * rate * press; if (w < 1e-3) continue; rOut[k] += (clamp(0.02, MAXR, out.rad) - rOut[k]) * w; rIn[k] += (clamp(0, MAXR, inn.rad) - rIn[k]) * w }
        } else {
          const c = eng[0], mid = (rOut[c.ring] + rIn[c.ring]) * 0.5, inner = c.rad < mid
          for (let k = FLOOR_RINGS; k <= top; k++) { const w = bandW(k, c.ring, sigma) * rate * c.press; if (w < 1e-3) continue; if (inner) rIn[k] += (clamp(0, MAXR, c.rad) - rIn[k]) * w; else rOut[k] += (clamp(0.02, MAXR, c.rad) - rOut[k]) * w }
        }
      } else if (p.tool === 'open') {
        const c = eng.reduce((a, b) => (a.rad < b.rad ? a : b))    // hand nearest the axis
        for (let k = Math.max(FLOOR_RINGS, c.ring); k <= top; k++) { const w = rate * c.press * (k >= c.ring ? 1 : 0.4); const tgt = clamp(0, rOut[k] - MINWALL, c.rad); rIn[k] += (tgt - rIn[k]) * w }
      } else if (p.tool === 'widen' || p.tool === 'collar') {
        const dir = p.tool === 'widen' ? 1 : -1
        for (const c of eng) for (let k = FLOOR_RINGS; k <= top; k++) { const w = bandW(k, c.ring, sigma) * rate * c.press; if (w < 1e-3) continue; const d = dir * 0.06 * w; rOut[k] = clamp(0.02, MAXR, rOut[k] + d); if (rIn[k] > EPS) rIn[k] = clamp(0, rOut[k] - MINWALL, rIn[k] + d) }
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
      // Volume conservation : hold V≈V0 by extruding the rim upward (thinning → taller)
      // or shaving it (widening → shorter). A few rings/frame → smooth & stable.
      if (p.conserve) {
        for (let guard = 0; guard < 4; guard++) {
          const v = volume()
          if (v < V0 * 0.997 && top < NR - 2) { top++; rOut[top] = Math.max(0.02, rOut[top - 1] * 0.985); rIn[top] = clamp(0, rOut[top] - MINWALL, rIn[top - 1] * 0.985) }
          else if (v > V0 * 1.003 && top > FLOOR_RINGS + 3) { rOut[top] = 0; rIn[top] = 0; top-- }
          else break
        }
      }
    }

    const doExport = (fmt: 'stl' | 'glb') => {
      const geo = buildPotGeometry(rOut, rIn, top)
      if (fmt === 'stl') {
        const stl = new STLExporter().parse(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()), { binary: false })
        downloadBlob(new Blob([stl], { type: 'model/stl' }), `poterie-${Date.now()}.stl`); setStatus('Export STL (vase étanche imprimable).')
      } else {
        const g = new THREE.Group(); g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(paramsRef.current.clayColor), roughness: 0.85, side: THREE.DoubleSide })))
        new GLTFExporter().parse(g, (res) => { downloadBlob(new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' }), `poterie-${Date.now()}.glb`); geo.dispose() }, () => setStatus('Échec export GLB.'), { binary: true })
        setStatus('Export GLB (couleur conservée).')
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

    let lastT = performance.now()
    const loop = () => {
      if (!running) return
      const p = paramsRef.current
      const nowT = performance.now(), dt = clamp(0.001, 0.05, (nowT - lastT) / 1000); lastT = nowT
      if (resetRef.current) { resetClay(p.clayMass); resetRef.current = false }
      if (exportRef.current) { doExport(exportRef.current); exportRef.current = null }
      V0 = VOL_K * p.clayMass    // live target : changing mass adds/removes clay

      clayMat.color.set(p.clayColor); clayMat.wireframe = p.wireframe

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
          contacts.push({ rad: m.rad, ring: m.ring, press, sx: sm.x, sy: sm.y, inner: false })
        }
        if (!hands.length) skelHands = []
        if (contacts.length >= 2) { const mn = contacts.reduce((a, b) => (a.rad < b.rad ? a : b)); mn.inner = true }
      }
      if (newFrame) applyTool(contacts, p, dt)
      if (newFrame && contacts.length) hud = { contacts, toolLabel: TOOLS.find((t) => t.kind === p.tool)?.label ?? '' }
      else if (!contacts.length && newFrame) hud = { contacts: [], toolLabel: hud.toolLabel }

      relaxAndConstrain(p, dt)

      // Rebuild the clay mesh from the profiles.
      const geo = buildPotGeometry(rOut, rIn, top); clayMesh.geometry.dispose(); clayMesh.geometry = geo

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
        octx.beginPath(); octx.arc(c.sx, c.sy, on ? 14 : 8, 0, Math.PI * 2)
        octx.fillStyle = on ? (c.inner ? 'rgba(255,180,0,0.6)' : 'rgba(0,224,192,0.6)') : 'rgba(255,255,255,0.4)'
        octx.globalAlpha = 0.85; octx.fill(); octx.globalAlpha = 1
        octx.lineWidth = 3; octx.strokeStyle = c.inner ? '#ffb400' : '#00e0c0'; octx.stroke()
        if (on) { octx.fillStyle = '#fff'; octx.font = 'bold 11px system-ui'; octx.textAlign = 'center'; octx.fillText(c.inner ? 'INT.' : 'EXT.', c.sx, c.sy - 20) }
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
      window.removeEventListener('resize', resize); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointerdown', onDown); renderer.domElement.removeEventListener('wheel', onWheel)
      try { landmarker?.close() } catch { /* noop */ }
      if (stream) stream.getTracks().forEach((t) => t.stop()); video.srcObject = null
      try { if (recActive && recorder) recorder.stop() } catch { /* noop */ }
      clayMesh.geometry.dispose(); renderer.dispose(); if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
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
          <div style={{ fontSize: 10, color: '#ffcf9a', marginBottom: 12, lineHeight: 1.35, background: 'rgba(255,180,0,0.08)', padding: 7, borderRadius: 6 }}>☝️ Le <b>bout de l'index</b> est l'outil. Pince pouce+index pour <b>presser</b> l'argile (ouvre la main pour repositionner). Deux mains = paroi <b>int.</b> (proche de l'axe) + <b>ext.</b> · 🖱️ glisse pour <b>tourner la vue</b> — l'angle change la sculpture.</div>

          <Field label="Outil de tournage">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {TOOLS.map((t) => (
                <button key={t.kind} onClick={() => setTool(t.kind)} style={{ ...selStyle, fontSize: 11, padding: 7, background: tool === t.kind ? 'rgba(255,150,60,0.28)' : 'rgba(255,255,255,0.08)', borderColor: tool === t.kind ? 'rgba(255,150,60,0.6)' : 'rgba(255,255,255,0.18)' }}>{t.label}</button>
              ))}
            </div>
            <p style={{ color: '#9a8a78', fontSize: 10, margin: '6px 0 0', lineHeight: 1.35 }}>{toolHint}</p>
          </Field>

          <Field label={`Force de l'outil — ${Math.round(strength * 100)}%`}><input type="range" min={0.1} max={1} step={0.05} value={strength} onChange={(e) => setStrength(+e.target.value)} style={rngStyle} /></Field>

          <div style={{ fontSize: 10, color: '#ffb47a', textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' }}>Le tour & l'argile</div>
          <Field label={`Vitesse du tour — ${wheelSpeed.toFixed(1)}`}><input type="range" min={0} max={3} step={0.1} value={wheelSpeed} onChange={(e) => setWheelSpeed(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`Masse d'argile — ${clayMass.toFixed(1)} kg`}><input type="range" min={0.3} max={3} step={0.1} value={clayMass} onChange={(e) => setClayMass(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`Lissage (eau) — ${Math.round(smoothing * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={smoothing} onChange={(e) => setSmoothing(+e.target.value)} style={rngStyle} /></Field>
          <label style={chkRow} title="L'argile est incompressible : affiner la paroi la fait monter (comme au tournage réel)."><input type="checkbox" checked={conserve} onChange={(e) => setConserve(e.target.checked)} style={{ accentColor: '#ffb47a' }} /> 🧱 Conservation du volume (monte les parois)</label>

          <div style={{ fontSize: 10, color: '#ffb47a', textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' }}>Rendu</div>
          <Field label="Couleur de l'argile"><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="color" value={clayColor} onChange={(e) => setClayColor(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} /><div style={{ display: 'flex', gap: 5 }}>{['#b5651d', '#c8794a', '#8a5a3c', '#d9c7a3', '#3a3f4a', '#e8e2d6'].map((h) => <button key={h} onClick={() => setClayColor(h)} style={{ width: 22, height: 22, borderRadius: 5, background: h, border: '1px solid rgba(255,255,255,0.25)', cursor: 'pointer' }} />)}</div></div></Field>
          <label style={chkRow}><input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} style={{ accentColor: '#ffb47a' }} /> 🕸️ Fil de fer (maillage)</label>
          <label style={chkRow}><input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} style={{ accentColor: '#ffb47a' }} /> 📐 Repères (axe)</label>
          <label style={chkRow}><input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} style={{ accentColor: '#ffb47a' }} /> ✋ Squelette des mains</label>
          <Field label="Fond"><select value={bgMode} onChange={(e) => setBgMode(e.target.value as 'webcam' | 'black')} style={selStyle}><option value="webcam">📷 Webcam</option><option value="black">⬛ Atelier sombre</option></select></Field>

          <button onClick={() => { resetRef.current = true }} style={{ ...selStyle, marginBottom: 8, marginTop: 6, background: 'rgba(255,150,60,0.18)', borderColor: 'rgba(255,150,60,0.45)' }}>♻️ Nouvelle motte d'argile</button>
          <div style={{ fontSize: 10, color: '#ffb47a', textTransform: 'uppercase', letterSpacing: 1, margin: '10px 0 6px' }}>Export</div>
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
