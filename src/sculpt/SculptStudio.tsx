/**
 * Studio de Sculpture — pâte à modeler virtuelle + métamorphose (webcam + MediaPipe).
 *
 * DEUX TEMPS.
 * 1) SCULPTER : une boule de pâte déformable (icosphère). Les doigts sont des outils qui
 *    déforment directement le maillage — Étirer (tirer la matière), Pousser (creuser),
 *    Pincer (crête/pointe), Gonfler, Lisser. Pince pouce+index = presser ; symétrie
 *    bilatérale optionnelle. C'est du vrai modelage : on tire des pointes, on creuse, on lisse.
 * 2) MÉTAMORPHOSER : la forme sculptée devient le "holon" d'un système de métamorphoses
 *    itérées façon XenoDream — symétrie radiale N, miroir, torsion, réplication fractale —
 *    piloté aux mains (écartement/hauteur/inclinaison/pince) ou aux curseurs.
 *
 * Export .glb/.stl (impression 3D), PNG, vidéo WebM.
 * Studio autonome. Route /sculpt, protégée par FrontGate.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import * as THREE from 'three'
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const GESTURE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'
const TIP_THUMB = 4, TIP_INDEX = 8, MID_MCP = 9, WRIST = 0
const FINGER_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))
const SUBDIV = 14         // icosphere detail → ~2300 welded verts (sculptable)
const MCAP = 800          // metamorphose instance cap

type Tool = 'grab' | 'push' | 'pinch' | 'inflate' | 'smooth'
const TOOLS: { kind: Tool; label: string; hint: string }[] = [
  { kind: 'grab', label: '✊ Étirer', hint: 'Attrape et tire la matière avec le doigt (fais des pointes, des bras).' },
  { kind: 'push', label: '👇 Pousser', hint: 'Enfonce la surface vers l\'intérieur (creuse, aplatit).' },
  { kind: 'pinch', label: '🤏 Pincer', hint: 'Ramène la matière vers un point (crêtes, pointes fines).' },
  { kind: 'inflate', label: '🎈 Gonfler', hint: 'Repousse la surface vers l\'extérieur (bosses, renflements).' },
  { kind: 'smooth', label: '🧽 Lisser', hint: 'Adoucit et égalise la surface.' },
]
type MatKind = 'clay' | 'chrome' | 'bio' | 'matte'
const MATERIALS: { kind: MatKind; label: string; metal: number; rough: number }[] = [
  { kind: 'clay', label: '🟫 Pâte / terre', metal: 0.0, rough: 0.85 }, { kind: 'chrome', label: '🪞 Chrome', metal: 0.95, rough: 0.15 },
  { kind: 'bio', label: '🫧 Bio-plastique', metal: 0.3, rough: 0.35 }, { kind: 'matte', label: '⚪ Mat', metal: 0.05, rough: 0.6 },
]

/** IFS growth of the metamorph transform tree. */
function grow(maps: THREE.Matrix4[], depth: number, maxNodes: number): { mat: THREE.Matrix4; d: number }[] {
  let cur = [{ mat: new THREE.Matrix4(), d: 0 }]
  const all = [...cur]
  for (let d = 0; d < depth; d++) {
    const next: { mat: THREE.Matrix4; d: number }[] = []
    for (const node of cur) { for (const map of maps) { next.push({ mat: new THREE.Matrix4().multiplyMatrices(node.mat, map), d: d + 1 }); if (all.length + next.length >= maxNodes) break } if (all.length + next.length >= maxNodes) break }
    all.push(...next); cur = next
    if (all.length >= maxNodes || !next.length) break
  }
  return all
}

export function SculptStudio() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const [mode, setMode] = useState<'sculpt' | 'morph'>('sculpt')
  const [tool, setTool] = useState<Tool>('grab')
  const [brushSize, setBrushSize] = useState(0.35)
  const [strength, setStrength] = useState(0.6)
  const [symX, setSymX] = useState(true)
  // metamorphose params
  const [depth, setDepth] = useState(1)
  const [radial, setRadial] = useState(5)
  const [mirror, setMirror] = useState(true)
  const [twist, setTwist] = useState(0.6)
  const [spread, setSpread] = useState(0.5)
  const [childScale, setChildScale] = useState(0.55)
  const [handDrive, setHandDrive] = useState(true)
  // render
  const [colorA, setColorA] = useState('#c8794a')
  const [colorB, setColorB] = useState('#7a3f2c')
  const [material, setMaterial] = useState<MatKind>('clay')
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [bgMode, setBgMode] = useState<'webcam' | 'black'>('black')
  const [panelOpen, setPanelOpen] = useState(true)
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState('Initialisation de la caméra et du modèle…')
  const [error, setError] = useState<string | null>(null)

  const paramsRef = useRef({ mode, tool, brushSize, strength, symX, depth, radial, mirror, twist, spread, childScale, handDrive, colorA, colorB, material, showSkeleton, bgMode })
  paramsRef.current = { mode, tool, brushSize, strength, symX, depth, radial, mirror, twist, spread, childScale, handDrive, colorA, colorB, material, showSkeleton, bgMode }
  const resetRef = useRef(false), undoRef = useRef(false), redoRef = useRef(false)
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
    scene.add(new THREE.HemisphereLight(0xffffff, 0x223044, 0.85))
    const keyL = new THREE.DirectionalLight(0xffffff, 1.15); keyL.position.set(2, 3, 2.5); scene.add(keyL)
    const rimL = new THREE.DirectionalLight(0x88bbff, 0.5); rimL.position.set(-2, 1, -2); scene.add(rimL)

    // ── Deformable clay blob : icosphere WELDED into an indexed geometry (shared vertices)
    // so deforming a vertex moves the whole surface continuously (no cracks). ──
    const geo = mergeVertices(new THREE.IcosahedronGeometry(1, SUBDIV))
    geo.computeVertexNormals()
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute
    const V = posAttr.count
    const rest = new Float32Array(posAttr.array as Float32Array)   // original (for reset)
    const clayMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#c8794a'), roughness: 0.85, metalness: 0, flatShading: false })
    const blob = new THREE.Mesh(geo, clayMat); blob.frustumCulled = false; scene.add(blob)
    // adjacency for the smooth tool
    const adj: number[][] = Array.from({ length: V }, () => [])
    { const idx = geo.getIndex(); if (idx) { const a = idx.array as ArrayLike<number>; for (let i = 0; i < a.length; i += 3) { const t = [a[i], a[i + 1], a[i + 2]]; for (let j = 0; j < 3; j++) { const x = t[j], y = t[(j + 1) % 3]; if (!adj[x].includes(y)) adj[x].push(y) } } } }

    // Metamorphose instances (share the blob geometry so they reflect the sculpt live).
    const instMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide })
    const inst = new THREE.InstancedMesh(geo, instMat, MCAP)
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage); inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MCAP * 3), 3)
    inst.count = 0; inst.frustumCulled = false; inst.visible = false; scene.add(inst)

    // Camera orbit
    const target = new THREE.Vector3(0, 0, 0)
    let camDist = 4.0, camAz = 0.3, camPolar = 1.2
    const applyCam = () => { const sp = Math.sin(camPolar), cp = Math.cos(camPolar); camera.position.set(target.x + camDist * sp * Math.sin(camAz), target.y + camDist * cp, target.z + camDist * sp * Math.cos(camAz)); camera.lookAt(target) }
    applyCam()
    const resize = () => { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); overlay.width = w; overlay.height = h }
    resize(); window.addEventListener('resize', resize)
    let dragging = false, lastX = 0, lastY = 0
    const onDown = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY }
    const onMove = (e: PointerEvent) => { if (!dragging) return; camAz -= (e.clientX - lastX) * 0.006; camPolar = clamp(0.2, 1.6, camPolar - (e.clientY - lastY) * 0.006); lastX = e.clientX; lastY = e.clientY }
    const onUp = () => { dragging = false }
    const onWheel = (e: WheelEvent) => { camDist = clamp(2, 9, camDist + e.deltaY * 0.003) }
    renderer.domElement.addEventListener('pointerdown', onDown); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); renderer.domElement.addEventListener('wheel', onWheel, { passive: true })

    const raycaster = new THREE.Raycaster()
    const v2 = new THREE.Vector2(), tmp = new THREE.Vector3(), fwd = new THREE.Vector3()
    const rayToMesh = (nx: number, ny: number) => { v2.set(nx, ny); raycaster.setFromCamera(v2, camera); const h = raycaster.intersectObject(blob, false); return h[0] ?? null }
    const _plane = new THREE.Plane()
    const rayToPlane = (nx: number, ny: number, pl: THREE.Plane) => { v2.set(nx, ny); raycaster.setFromCamera(v2, camera); return raycaster.ray.intersectPlane(pl, new THREE.Vector3()) }

    let skelHands: { x: number; y: number }[][] = []

    // ── Undo / redo (position snapshots) ──
    let past: Float32Array[] = [], future: Float32Array[] = []
    const pushHistory = () => { past.push(new Float32Array(posAttr.array as Float32Array)); if (past.length > 30) past.shift(); future = [] }
    const restore = (s: Float32Array) => { (posAttr.array as Float32Array).set(s); posAttr.needsUpdate = true; geo.computeVertexNormals() }

    // Apply a brush at a world point. `delta` used by grab (drag). Returns nothing.
    const grabSets = new Map<number, { i: number; f: number }[]>()   // per-hand sticky grab set
    const grabPlane = new Map<number, THREE.Plane>(), grabLast = new Map<number, THREE.Vector3>()
    const applyBrush = (center: THREE.Vector3, hand: number, tool: Tool, radius: number, str: number, deltaV: THREE.Vector3 | null, mirrorX: boolean) => {
      const arr = posAttr.array as Float32Array
      const nrm = geo.getAttribute('normal').array as Float32Array
      const doOne = (cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, gset: { i: number; f: number }[] | null) => {
        if (tool === 'grab' && gset) { for (const g of gset) { arr[g.i * 3] += dx * g.f; arr[g.i * 3 + 1] += dy * g.f; arr[g.i * 3 + 2] += dz * g.f }; return }
        const r2 = radius * radius
        for (let i = 0; i < V; i++) {
          const px = arr[i * 3], py = arr[i * 3 + 1], pz = arr[i * 3 + 2]
          const ex = px - cx, ey = py - cy, ez = pz - cz, d2 = ex * ex + ey * ey + ez * ez
          if (d2 > r2) continue
          const t = Math.sqrt(d2) / radius, f = (1 - t) * (1 - t) * str
          if (tool === 'push') { arr[i * 3] -= nrm[i * 3] * radius * 0.6 * f; arr[i * 3 + 1] -= nrm[i * 3 + 1] * radius * 0.6 * f; arr[i * 3 + 2] -= nrm[i * 3 + 2] * radius * 0.6 * f }
          else if (tool === 'inflate') { arr[i * 3] += nrm[i * 3] * radius * 0.6 * f; arr[i * 3 + 1] += nrm[i * 3 + 1] * radius * 0.6 * f; arr[i * 3 + 2] += nrm[i * 3 + 2] * radius * 0.6 * f }
          else if (tool === 'pinch') { arr[i * 3] += (cx - px) * 0.5 * f; arr[i * 3 + 1] += (cy - py) * 0.5 * f; arr[i * 3 + 2] += (cz - pz) * 0.5 * f }
          else if (tool === 'smooth') { const nb = adj[i]; if (nb.length) { let ax = 0, ay = 0, az = 0; for (const j of nb) { ax += arr[j * 3]; ay += arr[j * 3 + 1]; az += arr[j * 3 + 2] } ax /= nb.length; ay /= nb.length; az /= nb.length; arr[i * 3] += (ax - px) * f; arr[i * 3 + 1] += (ay - py) * f; arr[i * 3 + 2] += (az - pz) * f } }
        }
      }
      const gset = tool === 'grab' ? (grabSets.get(hand) ?? null) : null
      const dx = deltaV?.x ?? 0, dy = deltaV?.y ?? 0, dz = deltaV?.z ?? 0
      doOne(center.x, center.y, center.z, dx, dy, dz, gset)
      if (mirrorX) { const gm = tool === 'grab' ? (grabSets.get(hand + 100) ?? null) : null; doOne(-center.x, center.y, center.z, -dx, dy, dz, gm) }
    }

    // ── Metamorphose : replicate the sculpted blob (radial + mirror + twist + IFS) ──
    const cA = new THREE.Color(), cB = new THREE.Color(), cTmp = new THREE.Color()
    const _rk = new THREE.Matrix4(), _mir = new THREE.Matrix4().makeScale(-1, 1, 1)
    let lastSig = ''
    const regenMorph = (p: typeof paramsRef.current, tw: number, sp: number, cs: number) => {
      const N = Math.max(1, Math.round(p.radial)), symCopies = N * (p.mirror ? 2 : 1)
      const maxNodes = Math.max(2, Math.floor(MCAP / symCopies))
      // 2 maps : scaled children rotated + lifted → fractal metamorphosis of the blob
      const maps: THREE.Matrix4[] = []
      for (let m = 0; m < 2; m++) { const a = m * Math.PI + tw; const mm = new THREE.Matrix4(); mm.multiply(new THREE.Matrix4().makeTranslation(Math.cos(a) * sp, sp * 0.6, Math.sin(a) * sp)).multiply(new THREE.Matrix4().makeRotationY(tw + a)).multiply(new THREE.Matrix4().makeScale(cs, cs, cs)); maps.push(mm) }
      const nodes = grow(maps, clamp(1, 4, Math.round(p.depth)), maxNodes)
      cA.set(p.colorA); cB.set(p.colorB)
      const bb = new THREE.Box3(), pv = new THREE.Vector3()
      let idx = 0
      for (const node of nodes) { for (let k = 0; k < N; k++) { _rk.makeRotationY((k / N) * Math.PI * 2); const base = new THREE.Matrix4().multiplyMatrices(_rk, node.mat); const variants = p.mirror ? [base, new THREE.Matrix4().multiplyMatrices(_mir, base)] : [base]; for (const mm of variants) { if (idx >= MCAP) break; inst.setMatrixAt(idx, mm); cTmp.copy(cA).lerp(cB, clamp(0, 1, node.d / Math.max(1, p.depth))); inst.setColorAt(idx, cTmp); pv.setFromMatrixPosition(mm); bb.expandByPoint(pv); idx++ } } if (idx >= MCAP) break }
      inst.count = idx; inst.instanceMatrix.needsUpdate = true; if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      if (idx > 0) { const c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3()); const ext = Math.max(sz.x, sz.y, sz.z, 1); const sc = 3.2 / (ext + 2); inst.scale.setScalar(sc); inst.position.set(-c.x * sc, -c.y * sc, -c.z * sc) }
    }

    const doExport = (fmt: 'stl' | 'glb') => {
      const p = paramsRef.current
      let merged: THREE.BufferGeometry | null
      if (p.mode === 'morph' && inst.count > 0) { const geoms: THREE.BufferGeometry[] = []; const m4 = new THREE.Matrix4(); const n = Math.min(inst.count, 400); for (let i = 0; i < n; i++) { inst.getMatrixAt(i, m4); const g = geo.clone().applyMatrix4(m4); geoms.push(g) } merged = mergeGeometries(geoms, false); geoms.forEach((g) => g.dispose()) }
      else merged = geo.clone()
      if (!merged) { setStatus('Export impossible.'); return }
      if (fmt === 'stl') { const stl = new STLExporter().parse(new THREE.Mesh(merged, new THREE.MeshStandardMaterial()), { binary: false }); downloadBlob(new Blob([stl], { type: 'model/stl' }), `sculpt-${Date.now()}.stl`); merged.dispose(); setStatus('Export STL.') }
      else { const g = new THREE.Group(); g.add(new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: new THREE.Color(p.colorA), roughness: 0.8, side: THREE.DoubleSide }))); new GLTFExporter().parse(g, (res) => { downloadBlob(new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' }), `sculpt-${Date.now()}.glb`); merged!.dispose() }, () => setStatus('Échec GLB.'), { binary: true }); setStatus('Export GLB.') }
    }

    // ── Recording ──
    let recCanvas: HTMLCanvasElement | null = null, recCtx: CanvasRenderingContext2D | null = null
    let recorder: MediaRecorder | null = null, recChunks: Blob[] = [], recActive = false
    const startRec = () => {
      if (recActive) return
      recCanvas = document.createElement('canvas'); recCanvas.width = overlay.width; recCanvas.height = overlay.height; recCtx = recCanvas.getContext('2d')
      const st = recCanvas.captureStream(30); const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
      recChunks = []; recorder = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
      recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data) }
      recorder.onstop = () => { downloadBlob(new Blob(recChunks, { type: 'video/webm' }), `sculpt-${Date.now()}.webm`); recChunks = []; setStatus('Vidéo enregistrée (WebM).') }
      recorder.start(); recActive = true; setRecording(true); setStatus('● Enregistrement…')
    }
    const stopRec = () => { if (recActive && recorder) { recorder.stop(); recActive = false; setRecording(false) } }
    recCtl.current = { start: startRec, stop: stopRec }

    // per-hand engagement state (for grab & stroke undo)
    const engaged = [false, false]; let anySculpt = false, wasSculpt = false
    let lastT = performance.now(), spinT = 0, geoDirty = false
    const smx = { tw: twist, sp: spread, cs: childScale }
    const loop = () => {
      if (!running) return
      const p = paramsRef.current
      const nowT = performance.now(), dt = clamp(0.001, 0.05, (nowT - lastT) / 1000); lastT = nowT
      if (exportRef.current) { doExport(exportRef.current); exportRef.current = null }
      if (resetRef.current) { pushHistory(); (posAttr.array as Float32Array).set(rest); posAttr.needsUpdate = true; geo.computeVertexNormals(); resetRef.current = false; setStatus('Boule de pâte réinitialisée.') }
      if (undoRef.current) { undoRef.current = false; if (past.length) { future.push(new Float32Array(posAttr.array as Float32Array)); restore(past.pop()!); setStatus('↶ Annulé.') } else setStatus('Rien à annuler.') }
      if (redoRef.current) { redoRef.current = false; if (future.length) { past.push(new Float32Array(posAttr.array as Float32Array)); restore(future.pop()!); setStatus('↷ Refait.') } else setStatus('Rien à refaire.') }
      { const m = MATERIALS.find((x) => x.kind === p.material)!; clayMat.metalness = m.metal; clayMat.roughness = m.rough; clayMat.color.set(p.colorA) }
      blob.visible = p.mode === 'sculpt'; inst.visible = p.mode === 'morph'

      anySculpt = false
      let hpar = { sp: p.spread, tw: p.twist, cs: p.childScale, driving: false }
      if (video.readyState >= 2 && video.currentTime !== lastVideoTime && landmarker) {
        lastVideoTime = video.currentTime
        const res = landmarker.recognizeForVideo(video, performance.now())
        const hands = res.landmarks ?? []
        skelHands = hands.slice(0, 2).map((lm) => lm.map((k: { x: number; y: number }) => ({ x: (1 - k.x) * overlay.width, y: k.y * overlay.height })))
        if (!hands.length) skelHands = []
        blob.updateMatrixWorld()
        for (let i = 0; i < Math.min(2, hands.length); i++) {
          const lm = hands[i]
          const hs = Math.max(0.02, Math.hypot(lm[WRIST].x - lm[MID_MCP].x, lm[WRIST].y - lm[MID_MCP].y))
          const pinch = Math.hypot(lm[TIP_THUMB].x - lm[TIP_INDEX].x, lm[TIP_THUMB].y - lm[TIP_INDEX].y) / hs
          const press = clamp(0, 1, (0.7 - pinch) / 0.45)
          const nx = (1 - lm[TIP_INDEX].x) * 2 - 1, ny = -(lm[TIP_INDEX].y * 2 - 1)
          if (p.mode === 'sculpt') {
            if (press > 0.2) {
              anySculpt = true
              const radius = p.brushSize, str = clamp(0, 1, p.strength) * clamp(0, 1, (press - 0.2) / 0.6) * Math.min(1, dt * 12)
              if (!engaged[i]) {
                // engage : raycast to the blob to anchor the brush / grab set
                const hit = rayToMesh(nx, ny)
                if (hit) {
                  engaged[i] = true
                  if (p.tool === 'grab') {
                    const build = (cx: number, cy: number, cz: number, key: number) => { const arr = posAttr.array as Float32Array; const set: { i: number; f: number }[] = []; const r2 = radius * radius; for (let q = 0; q < V; q++) { const ex = arr[q * 3] - cx, ey = arr[q * 3 + 1] - cy, ez = arr[q * 3 + 2] - cz, d2 = ex * ex + ey * ey + ez * ez; if (d2 <= r2) { const t = Math.sqrt(d2) / radius; set.push({ i: q, f: (1 - t) * (1 - t) }) } } grabSets.set(key, set) }
                    build(hit.point.x, hit.point.y, hit.point.z, i); if (p.symX) build(-hit.point.x, hit.point.y, hit.point.z, i + 100)
                    camera.getWorldDirection(fwd); _plane.setFromNormalAndCoplanarPoint(fwd, hit.point); grabPlane.set(i, _plane.clone()); grabLast.set(i, hit.point.clone())
                  }
                }
              }
              if (engaged[i]) {
                if (p.tool === 'grab') {
                  const pl = grabPlane.get(i)!; const cur = rayToPlane(nx, ny, pl)
                  if (cur) { const last = grabLast.get(i)!; tmp.subVectors(cur, last).multiplyScalar(clamp(0, 1.2, str * 3)); applyBrush(last, i, 'grab', radius, str, tmp, p.symX); grabLast.set(i, cur) }
                } else {
                  const hit = rayToMesh(nx, ny)
                  if (hit) applyBrush(hit.point, i, p.tool, radius, str, null, p.symX)
                }
                geoDirty = true
              }
            } else { engaged[i] = false; grabSets.delete(i); grabSets.delete(i + 100) }
          }
        }
        // Metamorphose driven by hands (écartement/hauteur/inclinaison/pince)
        if (p.mode === 'morph' && p.handDrive && hands.length) {
          hpar.driving = true
          const H = hands.map((lm) => ({ x: lm[MID_MCP].x, y: lm[MID_MCP].y }))
          if (H.length >= 2) { const sep = Math.hypot(H[0].x - H[1].x, H[0].y - H[1].y); hpar.sp = clamp(0.15, 1.4, sep * 2); hpar.tw = clamp(-2.5, 2.5, (0.5 - (H[0].y + H[1].y) / 2) * 5); hpar.cs = clamp(0.35, 0.72, 0.4 + (1 - Math.abs(H[0].y - H[1].y)) * 0.3) }
          else { hpar.sp = clamp(0.15, 1.4, (1 - H[0].y) * 1.4); hpar.tw = clamp(-2.5, 2.5, (0.5 - H[0].y) * 5) }
        }
      }
      if (p.mode === 'sculpt' && geoDirty) { posAttr.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere(); geoDirty = false }
      // stroke-based undo snapshot (before a new stroke)
      if (p.mode === 'sculpt') { if (anySculpt && !wasSculpt) pushHistory(); wasSculpt = anySculpt }

      if (p.mode === 'morph') {
        let tw = hpar.tw, sp = hpar.sp, cs = hpar.cs
        if (hpar.driving) { tw = smx.tw += (tw - smx.tw) * 0.15; sp = smx.sp += (sp - smx.sp) * 0.15; cs = smx.cs += (cs - smx.cs) * 0.15 } else { smx.tw = tw; smx.sp = sp; smx.cs = cs }
        const sig = `${p.depth}|${p.radial}|${p.mirror}|${p.colorA}|${p.colorB}|${tw.toFixed(3)}|${sp.toFixed(3)}|${cs.toFixed(3)}|${geo.attributes.position.version}`
        if (sig !== lastSig) { regenMorph(p, tw, sp, cs); lastSig = sig }
      }

      if (p.mode === 'sculpt') { blob.rotation.y = 0 } else { spinT += dt * 0.3; inst.rotation.y = spinT }
      applyCam(); renderer.render(scene, camera)

      // Overlay
      octx.clearRect(0, 0, overlay.width, overlay.height)
      if (p.showSkeleton) { octx.lineWidth = 2; octx.strokeStyle = 'rgba(255,255,255,0.4)'; for (const hnd of skelHands) { for (const chain of FINGER_CHAINS) { octx.beginPath(); chain.forEach((ci, k) => { const pt = hnd[ci]; if (!pt) return; if (k === 0) octx.moveTo(pt.x, pt.y); else octx.lineTo(pt.x, pt.y) }); octx.stroke() } for (const pt of hnd) { octx.beginPath(); octx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2); octx.fillStyle = 'rgba(255,140,60,0.6)'; octx.fill() } } }
      // fingertip tool markers
      for (let i = 0; i < skelHands.length; i++) { const tip = skelHands[i][TIP_INDEX]; if (!tip) continue; const on = engaged[i]; octx.beginPath(); octx.arc(tip.x, tip.y, on ? 13 : 8, 0, Math.PI * 2); octx.fillStyle = on ? 'rgba(255,140,60,0.6)' : 'rgba(255,255,255,0.35)'; octx.globalAlpha = 0.9; octx.fill(); octx.globalAlpha = 1; octx.lineWidth = 2.5; octx.strokeStyle = '#ff8c3c'; octx.stroke() }
      if (recActive && recCtx && recCanvas) { const w = recCanvas.width, h = recCanvas.height; if (p.bgMode === 'webcam' && video.readyState >= 2) { recCtx.save(); recCtx.translate(w, 0); recCtx.scale(-1, 1); recCtx.drawImage(video, 0, 0, w, h); recCtx.restore() } else { recCtx.fillStyle = '#0a0806'; recCtx.fillRect(0, 0, w, h) } recCtx.drawImage(renderer.domElement, 0, 0, w, h); recCtx.drawImage(overlay, 0, 0, w, h) }
      rafId = requestAnimationFrame(loop)
    }

    const init = async () => {
      loop()
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }))
        video.srcObject = stream; await new Promise<void>((res) => { video.onloadedmetadata = () => res() }); await video.play()
        const files = await FilesetResolver.forVisionTasks(WASM_BASE)
        landmarker = await GestureRecognizer.createFromOptions(files, { baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3 })
        setStatus('Prêt — pince pour toucher la pâte, tire/pousse avec le doigt ✦')
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
      geo.dispose(); clayMat.dispose(); instMat.dispose(); inst.dispose(); renderer.dispose(); if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  const exportPng = () => {
    const three = mountRef.current?.querySelector('canvas') as HTMLCanvasElement | null; if (!three) return
    const out = document.createElement('canvas'); out.width = three.width; out.height = three.height; const c = out.getContext('2d')!
    if (bgMode === 'webcam' && videoRef.current && videoRef.current.readyState >= 2) { c.save(); c.translate(out.width, 0); c.scale(-1, 1); c.drawImage(videoRef.current, 0, 0, out.width, out.height); c.restore() } else { c.fillStyle = '#0a0806'; c.fillRect(0, 0, out.width, out.height) }
    c.drawImage(three, 0, 0, out.width, out.height); out.toBlob((b) => { if (b) downloadBlob(b, `sculpt-${Date.now()}.png`) }, 'image/png')
  }

  const toolHint = TOOLS.find((t) => t.kind === tool)?.hint ?? ''

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0806', overflow: 'hidden', userSelect: 'none', fontFamily: 'system-ui' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)', zIndex: 1, opacity: bgMode === 'webcam' ? 1 : 0 }} />
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 3 }} />
      <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', zIndex: 4, pointerEvents: 'none' }} />
      {!panelOpen && <button onClick={() => setPanelOpen(true)} style={{ position: 'absolute', top: 16, left: 16, zIndex: 11, ...selStyle, width: 'auto', padding: '8px 12px' }}>☰</button>}
      {panelOpen && (
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, width: 300, background: 'rgba(12,9,8,0.9)', padding: 18, borderRadius: 16, backdropFilter: 'blur(10px)', border: '1px solid rgba(255,140,60,0.22)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', color: '#ece2d8' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>🗿 Sculpture · Pâte</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link><button onClick={() => setPanelOpen(false)} style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16 }}>«</button></div>
          </div>
          <div style={{ color: error ? '#ff6b6b' : '#9a8a78', fontSize: 11, marginBottom: 10, lineHeight: 1.3 }}>{error ?? status}</div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <button onClick={() => setMode('sculpt')} style={{ ...selStyle, flex: 1, background: mode === 'sculpt' ? 'rgba(255,140,60,0.3)' : 'rgba(255,255,255,0.08)', borderColor: mode === 'sculpt' ? 'rgba(255,140,60,0.6)' : 'rgba(255,255,255,0.18)' }}>🖐️ Sculpter</button>
            <button onClick={() => setMode('morph')} style={{ ...selStyle, flex: 1, background: mode === 'morph' ? 'rgba(255,140,60,0.3)' : 'rgba(255,255,255,0.08)', borderColor: mode === 'morph' ? 'rgba(255,140,60,0.6)' : 'rgba(255,255,255,0.18)' }}>🧬 Métamorphoser</button>
          </div>

          {mode === 'sculpt' && <>
            <div style={{ fontSize: 10, color: '#ffcf9a', marginBottom: 10, lineHeight: 1.35, background: 'rgba(255,140,0,0.08)', padding: 7, borderRadius: 6 }}>☝️ <b>Pince</b> pouce+index pour toucher la pâte, puis <b>bouge le doigt</b> pour la travailler. Deux mains = deux outils.</div>
            <Field label="Outil de modelage">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>{TOOLS.map((t) => (<button key={t.kind} onClick={() => setTool(t.kind)} style={{ ...selStyle, fontSize: 12, padding: 7, background: tool === t.kind ? 'rgba(255,140,60,0.28)' : 'rgba(255,255,255,0.08)', borderColor: tool === t.kind ? 'rgba(255,140,60,0.6)' : 'rgba(255,255,255,0.18)' }}>{t.label}</button>))}</div>
              <p style={{ color: '#9a8a78', fontSize: 10, margin: '6px 0 0', lineHeight: 1.35 }}>{toolHint}</p>
            </Field>
            <Field label={`Taille de l'outil — ${Math.round(brushSize * 100)}`}><input type="range" min={0.12} max={0.8} step={0.02} value={brushSize} onChange={(e) => setBrushSize(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Force — ${Math.round(strength * 100)}%`}><input type="range" min={0.1} max={1} step={0.05} value={strength} onChange={(e) => setStrength(+e.target.value)} style={rngStyle} /></Field>
            <label style={chkRow}><input type="checkbox" checked={symX} onChange={(e) => setSymX(e.target.checked)} style={{ accentColor: '#ff8c3c' }} /> 🦋 Symétrie gauche/droite</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button onClick={() => { undoRef.current = true }} style={{ ...selStyle, flex: 1, fontSize: 12 }}>↶ Annuler</button>
              <button onClick={() => { redoRef.current = true }} style={{ ...selStyle, flex: 1, fontSize: 12 }}>↷ Refaire</button>
              <button onClick={() => { resetRef.current = true }} style={{ ...selStyle, flex: 1, fontSize: 12, background: 'rgba(255,80,80,0.2)', borderColor: 'rgba(255,80,80,0.45)' }}>⟲ Boule</button>
            </div>
          </>}

          {mode === 'morph' && <>
            <div style={{ fontSize: 10, color: '#ffcf9a', marginBottom: 10, lineHeight: 1.35, background: 'rgba(255,140,0,0.08)', padding: 7, borderRadius: 6 }}>✋ Ta forme sculptée est répliquée. <b>Écarte</b> les mains = déploie · <b>hauteur</b> = torsion. Ou règle aux curseurs.</div>
            <label style={chkRow}><input type="checkbox" checked={handDrive} onChange={(e) => setHandDrive(e.target.checked)} style={{ accentColor: '#ff8c3c' }} /> ✋ Piloter aux mains</label>
            <Field label={`Itérations — ${depth}`}><input type="range" min={1} max={4} step={1} value={depth} onChange={(e) => setDepth(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Symétrie radiale — ${radial}`}><input type="range" min={1} max={8} step={1} value={radial} onChange={(e) => setRadial(+e.target.value)} style={rngStyle} /></Field>
            <label style={chkRow}><input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} style={{ accentColor: '#ff8c3c' }} /> 🦋 Miroir bilatéral</label>
            <Field label={`Torsion — ${twist.toFixed(2)}`}><input type="range" min={-2.5} max={2.5} step={0.02} value={twist} onChange={(e) => setTwist(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Déploiement — ${spread.toFixed(2)}`}><input type="range" min={0.15} max={1.4} step={0.02} value={spread} onChange={(e) => setSpread(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Échelle enfants — ${childScale.toFixed(2)}`}><input type="range" min={0.35} max={0.72} step={0.01} value={childScale} onChange={(e) => setChildScale(+e.target.value)} style={rngStyle} /></Field>
          </>}

          <div style={{ fontSize: 10, color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, margin: '12px 0 6px' }}>Matière</div>
          <Field label="Matériau"><select value={material} onChange={(e) => setMaterial(e.target.value as MatKind)} style={selStyle}>{MATERIALS.map((m) => <option key={m.kind} value={m.kind}>{m.label}</option>)}</select></Field>
          <Field label={mode === 'morph' ? 'Couleurs (dégradé par profondeur)' : 'Couleur'}><div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input type="color" value={colorA} onChange={(e) => setColorA(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} />{mode === 'morph' && <input type="color" value={colorB} onChange={(e) => setColorB(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} />}</div></Field>
          <label style={chkRow}><input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} style={{ accentColor: '#ff8c3c' }} /> ✋ Squelette des mains</label>
          <Field label="Fond"><select value={bgMode} onChange={(e) => setBgMode(e.target.value as 'webcam' | 'black')} style={selStyle}><option value="black">⬛ Noir</option><option value="webcam">📷 Webcam</option></select></Field>

          <div style={{ fontSize: 10, color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, margin: '12px 0 6px' }}>Export</div>
          <button onClick={() => { recording ? recCtl.current?.stop() : recCtl.current?.start() }} style={{ ...selStyle, marginBottom: 8, background: recording ? 'rgba(255,40,60,0.35)' : 'rgba(255,255,255,0.1)', borderColor: recording ? '#ff2840' : 'rgba(255,255,255,0.2)' }}>{recording ? '⏹ Arrêter l\'enregistrement' : '🔴 Enregistrer une vidéo'}</button>
          <div style={{ display: 'flex', gap: 8 }}><button onClick={exportPng} style={{ ...selStyle, flex: 1 }}>📸 PNG</button><button onClick={() => { exportRef.current = 'glb' }} style={{ ...selStyle, flex: 1 }}>🗿 .glb</button><button onClick={() => { exportRef.current = 'stl' }} style={{ ...selStyle, flex: 1 }} title="Maillage pour impression 3D">🖨️ .stl</button></div>
          <p style={{ color: '#7a6a58', fontSize: 10, marginTop: 10, marginBottom: 0, lineHeight: 1.4 }}>Souris : glisser = orbiter · molette = zoom.</p>
        </div>
      )}
    </div>
  )
}

function downloadBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500) }
const selStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: 8, borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }
const rngStyle: React.CSSProperties = { width: '100%', accentColor: '#ff8c3c' }
const chkRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#ece2d8', marginTop: 8, marginBottom: 8, cursor: 'pointer' }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return (<div style={{ marginBottom: 12 }}><div style={{ fontSize: 11, color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>{children}</div>) }
