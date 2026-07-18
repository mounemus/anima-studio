/**
 * Studio de Sculpture générative — métamorphoses itérées façon XenoDream (webcam + MediaPipe).
 *
 * PRINCIPE (comme XenoDream). Un HOLON de base (cube, sphère, cône…) est répété par une
 * pile de MÉTAMORPHOSES itérées : à chaque itération, chaque copie est re-transformée
 * (translation + rotation + échelle + torsion/courbure), ce qui fait CROÎTRE une forme
 * fractale/organique. On y ajoute une SYMÉTRIE (radiale N + miroir) → formes bioniques.
 *
 * MANUEL + GÉNÉRATIF. Les deux mains pilotent en direct les règles de transformation :
 * l'écartement des mains ouvre/ferme la structure, leur hauteur tord (spirale), leur
 * inclinaison courbe, la pince densifie. La sculpture se métamorphose pendant qu'on bouge
 * les mains. Presets de style, mutation générative aléatoire, matériaux, export .glb/.stl.
 *
 * Rendu par InstancedMesh (des milliers d'holons) → temps réel.
 *
 * Studio autonome. Route /sculpt, protégée par FrontGate.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import * as THREE from 'three'
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const GESTURE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'
const TIP_THUMB = 4, TIP_INDEX = 8, MID_MCP = 9, WRIST = 0
const FINGER_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))
const CAP = 16000   // instance capacity

type StyleKind = 'gyre' | 'spikes' | 'radial' | 'fractal' | 'warp' | 'mirror'
const STYLES: { kind: StyleKind; label: string; maps: number; baseTwist: number; baseBend: number; radial: number; mirror: boolean; holon: HolonKind; depth: number }[] = [
  { kind: 'gyre', label: '🌀 Gyre (spirales)', maps: 2, baseTwist: 0.55, baseBend: 0.22, radial: 3, mirror: false, holon: 'ico', depth: 7 },
  { kind: 'spikes', label: '🦔 Spikes (oursin)', maps: 3, baseTwist: 0.3, baseBend: 0.1, radial: 6, mirror: false, holon: 'cone', depth: 4 },
  { kind: 'radial', label: '🌸 Radial (fleur)', maps: 2, baseTwist: 0.4, baseBend: 0.3, radial: 8, mirror: true, holon: 'ico', depth: 5 },
  { kind: 'fractal', label: '🧬 Fractal (grappe)', maps: 3, baseTwist: 0.7, baseBend: 0.5, radial: 1, mirror: false, holon: 'box', depth: 5 },
  { kind: 'warp', label: '🪸 Warp (organique)', maps: 2, baseTwist: 0.5, baseBend: 0.6, radial: 4, mirror: false, holon: 'torus', depth: 6 },
  { kind: 'mirror', label: '🦋 Miroir (bionique)', maps: 2, baseTwist: 0.35, baseBend: 0.4, radial: 1, mirror: true, holon: 'capsule', depth: 6 },
]
type HolonKind = 'ico' | 'box' | 'cone' | 'torus' | 'capsule'
const HOLONS: { kind: HolonKind; label: string }[] = [
  { kind: 'ico', label: '⬡ Sphère facettée' }, { kind: 'box', label: '⬛ Cube' }, { kind: 'cone', label: '🔺 Épine' },
  { kind: 'torus', label: '🍩 Tore' }, { kind: 'capsule', label: '💊 Capsule' },
]
type MatKind = 'chrome' | 'bio' | 'clay' | 'matte'
const MATERIALS: { kind: MatKind; label: string; metal: number; rough: number }[] = [
  { kind: 'chrome', label: '🪞 Chrome', metal: 0.95, rough: 0.15 }, { kind: 'bio', label: '🫧 Bio-plastique', metal: 0.3, rough: 0.35 },
  { kind: 'clay', label: '🟫 Terre cuite', metal: 0.0, rough: 0.85 }, { kind: 'matte', label: '⚪ Mat', metal: 0.05, rough: 0.6 },
]

function holonGeometry(kind: HolonKind): THREE.BufferGeometry {
  switch (kind) {
    case 'box': return new THREE.BoxGeometry(0.9, 0.9, 0.9)
    case 'cone': return new THREE.ConeGeometry(0.5, 1.4, 10).translate(0, 0.2, 0)
    case 'torus': return new THREE.TorusGeometry(0.45, 0.2, 10, 20)
    case 'capsule': return new THREE.CapsuleGeometry(0.35, 0.7, 4, 10)
    case 'ico': default: return new THREE.IcosahedronGeometry(0.55, 1)
  }
}

/** Metamorph maps (the iterated transform set) from a style + live morph params. */
function buildMaps(style: (typeof STYLES)[number], twist: number, bend: number, spread: number, growth: number): THREE.Matrix4[] {
  const s = 0.4 + 0.3 * clamp(0, 1, growth)   // child scale ratio 0.4..0.7 (converges)
  const up = 0.6 + spread                       // translation per iteration
  const maps: THREE.Matrix4[] = []
  const T = new THREE.Matrix4(), Ry = new THREE.Matrix4(), Rz = new THREE.Matrix4(), S = new THREE.Matrix4()
  for (let m = 0; m < style.maps; m++) {
    const a = (m / style.maps) * Math.PI * 2
    T.makeTranslation(Math.sin(a) * 0.15 * up, up, Math.cos(a) * 0.15 * up)
    Ry.makeRotationY(twist + a * 0.5)
    Rz.makeRotationZ(bend * (m % 2 ? 1 : -1))
    S.makeScale(s, s, s)
    maps.push(new THREE.Matrix4().multiply(T).multiply(Ry).multiply(Rz).multiply(S))
  }
  return maps
}

/** Iterated function system : grow the transform tree from the root holon. */
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

  const [style, setStyle] = useState<StyleKind>('gyre')
  const [holon, setHolon] = useState<HolonKind>('ico')
  const [depth, setDepth] = useState(6)
  const [radial, setRadial] = useState(3)
  const [mirror, setMirror] = useState(false)
  const [twist, setTwist] = useState(0.55)
  const [bend, setBend] = useState(0.22)
  const [spread, setSpread] = useState(0.5)
  const [growth, setGrowth] = useState(0.5)
  const [colorA, setColorA] = useState('#ff3d9a')
  const [colorB, setColorB] = useState('#2bd4a0')
  const [material, setMaterial] = useState<MatKind>('bio')
  const [handDrive, setHandDrive] = useState(true)
  const [turntable, setTurntable] = useState(true)
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [bgMode, setBgMode] = useState<'webcam' | 'black'>('black')
  const [panelOpen, setPanelOpen] = useState(true)
  const [recording, setRecording] = useState(false)
  const [count, setCount] = useState(0)
  const [status, setStatus] = useState('Initialisation de la caméra et du modèle…')
  const [error, setError] = useState<string | null>(null)

  const paramsRef = useRef({ style, holon, depth, radial, mirror, twist, bend, spread, growth, colorA, colorB, material, handDrive, turntable, showSkeleton, bgMode })
  paramsRef.current = { style, holon, depth, radial, mirror, twist, bend, spread, growth, colorA, colorB, material, handDrive, turntable, showSkeleton, bgMode }
  const exportRef = useRef<null | 'stl' | 'glb'>(null)
  const recCtl = useRef<{ start: () => void; stop: () => void } | null>(null)

  // Randomize the generative parameters (a fresh species).
  const mutate = () => {
    const st = STYLES[Math.floor(Math.random() * STYLES.length)]
    setStyle(st.kind); setHolon(st.holon); setDepth(st.depth); setRadial(st.radial); setMirror(st.mirror)
    setTwist(+(st.baseTwist + (Math.random() - 0.5) * 1.6).toFixed(2)); setBend(+(st.baseBend + (Math.random() - 0.5) * 1.2).toFixed(2))
    setSpread(+(0.3 + Math.random() * 1.0).toFixed(2)); setGrowth(+(0.3 + Math.random() * 0.6).toFixed(2))
    const hue = Math.random() * 360; setColorA(`hsl(${hue}, 80%, 60%)`); setColorB(`hsl(${(hue + 140) % 360}, 70%, 55%)`)
    setStatus('🧬 Mutation — nouvelle espèce générée.')
  }
  const reset = () => { const st = STYLES.find((s) => s.kind === 'gyre')!; setStyle('gyre'); setHolon(st.holon); setDepth(st.depth); setRadial(st.radial); setMirror(st.mirror); setTwist(st.baseTwist); setBend(st.baseBend); setSpread(0.5); setGrowth(0.5); setStatus('Réinitialisé.') }

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
    scene.add(new THREE.HemisphereLight(0xffffff, 0x223044, 0.9))
    const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(2, 3, 2.5); scene.add(key)
    const rim = new THREE.DirectionalLight(0x88bbff, 0.5); rim.position.set(-2, 1, -2); scene.add(rim)

    const group = new THREE.Group(); scene.add(group)
    let mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.35, side: THREE.DoubleSide })
    let inst = new THREE.InstancedMesh(holonGeometry(paramsRef.current.holon), mat, CAP)
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage); inst.count = 0; inst.frustumCulled = false; group.add(inst)
    inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3)
    let curHolon = paramsRef.current.holon

    const rebuildHolon = (h: HolonKind) => { group.remove(inst); inst.dispose(); inst = new THREE.InstancedMesh(holonGeometry(h), mat, CAP); inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage); inst.count = 0; inst.frustumCulled = false; inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3); group.add(inst); curHolon = h }

    // Camera : full orbit around the sculpture.
    const target = new THREE.Vector3(0, 0, 0)
    let camDist = 4.2, camAz = 0.4, camPolar = 1.15
    const applyCam = () => { const sp = Math.sin(camPolar), cp = Math.cos(camPolar); camera.position.set(target.x + camDist * sp * Math.sin(camAz), target.y + camDist * cp, target.z + camDist * sp * Math.cos(camAz)); camera.lookAt(target) }
    applyCam()
    const resize = () => { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); overlay.width = w; overlay.height = h }
    resize(); window.addEventListener('resize', resize)
    let dragging = false, lastX = 0, lastY = 0
    const onDown = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY }
    const onMove = (e: PointerEvent) => { if (!dragging) return; camAz -= (e.clientX - lastX) * 0.006; camPolar = clamp(0.2, 1.6, camPolar - (e.clientY - lastY) * 0.006); lastX = e.clientX; lastY = e.clientY }
    const onUp = () => { dragging = false }
    const onWheel = (e: WheelEvent) => { camDist = clamp(2, 10, camDist + e.deltaY * 0.003) }
    renderer.domElement.addEventListener('pointerdown', onDown); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); renderer.domElement.addEventListener('wheel', onWheel, { passive: true })

    let skelHands: { x: number; y: number }[][] = []
    const cA = new THREE.Color(), cB = new THREE.Color(), cTmp = new THREE.Color()
    const _m = new THREE.Matrix4(), _rk = new THREE.Matrix4(), _mir = new THREE.Matrix4().makeScale(-1, 1, 1)

    // Regenerate the whole sculpture from the effective morph params.
    let lastSig = ''
    const regen = (p: typeof paramsRef.current, tw: number, be: number, sp: number, gr: number) => {
      const st = STYLES.find((s) => s.kind === p.style)!
      if (p.holon !== curHolon) rebuildHolon(p.holon)
      const N = Math.max(1, Math.round(p.radial)), symCopies = N * (p.mirror ? 2 : 1)
      const maxNodes = Math.max(4, Math.floor(CAP / symCopies))
      const maps = buildMaps({ ...st, maps: st.maps }, tw, be, sp, gr)
      const nodes = grow(maps, clamp(2, 8, Math.round(p.depth)), maxNodes)
      cA.set(p.colorA); cB.set(p.colorB)
      let idx = 0
      const bb = new THREE.Box3(), v = new THREE.Vector3()
      for (const node of nodes) {
        for (let k = 0; k < N; k++) {
          _rk.makeRotationY((k / N) * Math.PI * 2)
          const base = new THREE.Matrix4().multiplyMatrices(_rk, node.mat)
          const variants = p.mirror ? [base, new THREE.Matrix4().multiplyMatrices(_mir, base)] : [base]
          for (const mm of variants) {
            if (idx >= CAP) break
            inst.setMatrixAt(idx, mm)
            cTmp.copy(cA).lerp(cB, clamp(0, 1, node.d / Math.max(1, p.depth)))
            inst.setColorAt(idx, cTmp)
            v.setFromMatrixPosition(mm); bb.expandByPoint(v)
            idx++
          }
        }
        if (idx >= CAP) break
      }
      inst.count = idx
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      // Fit : centre + scale the group so the sculpture fills the view.
      if (idx > 0) { const c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3()); const ext = Math.max(sz.x, sz.y, sz.z, 0.5); const sc = 3.4 / ext; group.scale.setScalar(sc); group.position.set(-c.x * sc, -c.y * sc, -c.z * sc) }
      count !== idx && setCount(idx)
      return idx
    }

    const matPreset = (k: MatKind) => { const m = MATERIALS.find((x) => x.kind === k)!; mat.metalness = m.metal; mat.roughness = m.rough }

    const doExport = (fmt: 'stl' | 'glb') => {
      // Bake instances into one merged geometry (coloured for GLB).
      const base = holonGeometry(curHolon); const geoms: THREE.BufferGeometry[] = []
      const m4 = new THREE.Matrix4(), col = new THREE.Color()
      const n = Math.min(inst.count, 6000)   // cap export size
      for (let i = 0; i < n; i++) { inst.getMatrixAt(i, m4); const g = base.clone().applyMatrix4(m4); if (fmt === 'glb' && inst.instanceColor) { inst.getColorAt(i, col); const c = new Float32Array(g.getAttribute('position').count * 3); for (let j = 0; j < c.length; j += 3) { c[j] = col.r; c[j + 1] = col.g; c[j + 2] = col.b } g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)) } geoms.push(g) }
      base.dispose()
      if (!geoms.length) { setStatus('Rien à exporter.'); return }
      const merged = mergeGeometries(geoms, false); geoms.forEach((g) => g.dispose())
      if (!merged) { setStatus('Export impossible (géométrie).'); return }
      if (fmt === 'stl') { const stl = new STLExporter().parse(new THREE.Mesh(merged, new THREE.MeshStandardMaterial()), { binary: false }); downloadBlob(new Blob([stl], { type: 'model/stl' }), `sculpt-${Date.now()}.stl`); merged.dispose(); setStatus(`Export STL (${n} holons).`) }
      else { const g = new THREE.Group(); g.add(new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }))); new GLTFExporter().parse(g, (res) => { downloadBlob(new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' }), `sculpt-${Date.now()}.glb`); merged.dispose() }, () => setStatus('Échec GLB.'), { binary: true }); setStatus(`Export GLB (${n} holons, couleurs).`) }
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

    let lastT = performance.now(), spinT = 0
    const smx = { tw: paramsRef.current.twist, be: paramsRef.current.bend, sp: paramsRef.current.spread, gr: paramsRef.current.growth }
    const loop = () => {
      if (!running) return
      const p = paramsRef.current
      const nowT = performance.now(), dt = clamp(0.001, 0.05, (nowT - lastT) / 1000); lastT = nowT
      if (exportRef.current) { doExport(exportRef.current); exportRef.current = null }
      matPreset(p.material)

      // Hand-driven morph parameters (override sliders when hands drive & are present).
      let tw = p.twist, be = p.bend, sp = p.spread, gr = p.growth, driving = false
      if (video.readyState >= 2 && video.currentTime !== lastVideoTime && landmarker) {
        lastVideoTime = video.currentTime
        const res = landmarker.recognizeForVideo(video, performance.now())
        const hands = res.landmarks ?? []
        skelHands = hands.slice(0, 2).map((lm) => lm.map((k: { x: number; y: number }) => ({ x: (1 - k.x) * overlay.width, y: k.y * overlay.height })))
        if (p.handDrive && hands.length) {
          driving = true
          const H = hands.map((lm) => { const hs = Math.max(0.02, Math.hypot(lm[WRIST].x - lm[MID_MCP].x, lm[WRIST].y - lm[MID_MCP].y)); const pinch = Math.hypot(lm[TIP_THUMB].x - lm[TIP_INDEX].x, lm[TIP_THUMB].y - lm[TIP_INDEX].y) / hs; return { x: lm[MID_MCP].x, y: lm[MID_MCP].y, open: clamp(0, 1, (pinch - 0.3) / 0.7) } })
          if (H.length >= 2) {
            const sep = Math.hypot(H[0].x - H[1].x, H[0].y - H[1].y)
            sp = clamp(0.2, 1.6, sep * 2.2)
            tw = clamp(-2.2, 2.2, (1 - (H[0].y + H[1].y) / 2 - 0.5) * 4)
            be = clamp(-1.6, 1.6, (H[1].y - H[0].y) * 4)
            gr = clamp(0, 1, (H[0].open + H[1].open) / 2)
          } else {
            sp = clamp(0.2, 1.6, (1 - H[0].y) * 1.6); tw = clamp(-2.2, 2.2, (0.5 - H[0].y) * 4); be = clamp(-1.6, 1.6, (H[0].x - 0.5) * 3); gr = H[0].open
          }
        }
        if (!hands.length) skelHands = []
      }
      // Smooth the hand-driven morph toward targets (avoids jitter) ; sliders are used as-is.
      if (driving) { tw = smx.tw += (tw - smx.tw) * 0.18; be = smx.be += (be - smx.be) * 0.18; sp = smx.sp += (sp - smx.sp) * 0.18; gr = smx.gr += (gr - smx.gr) * 0.18 }
      else { smx.tw = tw; smx.be = be; smx.sp = sp; smx.gr = gr }

      const sig = `${p.style}|${p.holon}|${p.depth}|${p.radial}|${p.mirror}|${p.colorA}|${p.colorB}|${tw.toFixed(3)}|${be.toFixed(3)}|${sp.toFixed(3)}|${gr.toFixed(3)}`
      if (sig !== lastSig) { regen(p, tw, be, sp, gr); lastSig = sig }

      if (p.turntable) { spinT += dt * 0.35; group.rotation.y = spinT }
      applyCam(); renderer.render(scene, camera)

      // Overlay : skeleton + hand-drive hint.
      octx.clearRect(0, 0, overlay.width, overlay.height)
      if (p.showSkeleton) {
        octx.lineWidth = 2; octx.strokeStyle = 'rgba(255,255,255,0.4)'
        for (const hnd of skelHands) { for (const chain of FINGER_CHAINS) { octx.beginPath(); chain.forEach((idx, k) => { const pt = hnd[idx]; if (!pt) return; if (k === 0) octx.moveTo(pt.x, pt.y); else octx.lineTo(pt.x, pt.y) }); octx.stroke() } for (const pt of hnd) { octx.beginPath(); octx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2); octx.fillStyle = 'rgba(255,60,150,0.6)'; octx.fill() } }
      }
      if (driving && skelHands.length) { octx.fillStyle = 'rgba(255,60,150,0.9)'; octx.font = 'bold 13px system-ui'; octx.textAlign = 'center'; const h0 = skelHands[0][MID_MCP]; if (h0) octx.fillText('✋ métamorphose active', h0.x, h0.y - 30) }
      if (recActive && recCtx && recCanvas) {
        const w = recCanvas.width, h = recCanvas.height
        if (p.bgMode === 'webcam' && video.readyState >= 2) { recCtx.save(); recCtx.translate(w, 0); recCtx.scale(-1, 1); recCtx.drawImage(video, 0, 0, w, h); recCtx.restore() } else { recCtx.fillStyle = '#07080d'; recCtx.fillRect(0, 0, w, h) }
        recCtx.drawImage(renderer.domElement, 0, 0, w, h); recCtx.drawImage(overlay, 0, 0, w, h)
      }
      rafId = requestAnimationFrame(loop)
    }

    const init = async () => {
      loop()   // render immediately (works even without a camera)
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }))
        video.srcObject = stream; await new Promise<void>((res) => { video.onloadedmetadata = () => res() }); await video.play()
        const files = await FilesetResolver.forVisionTasks(WASM_BASE)
        landmarker = await GestureRecognizer.createFromOptions(files, { baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3 })
        setStatus('Prêt — écarte/monte/incline les mains pour métamorphoser la sculpture ✦')
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
      inst.dispose(); mat.dispose(); renderer.dispose(); if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  const exportPng = () => {
    const three = mountRef.current?.querySelector('canvas') as HTMLCanvasElement | null; if (!three) return
    const out = document.createElement('canvas'); out.width = three.width; out.height = three.height; const c = out.getContext('2d')!
    if (bgMode === 'webcam' && videoRef.current && videoRef.current.readyState >= 2) { c.save(); c.translate(out.width, 0); c.scale(-1, 1); c.drawImage(videoRef.current, 0, 0, out.width, out.height); c.restore() } else { c.fillStyle = '#07080d'; c.fillRect(0, 0, out.width, out.height) }
    c.drawImage(three, 0, 0, out.width, out.height); out.toBlob((b) => { if (b) downloadBlob(b, `sculpt-${Date.now()}.png`) }, 'image/png')
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#07080d', overflow: 'hidden', userSelect: 'none', fontFamily: 'system-ui' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)', zIndex: 1, opacity: bgMode === 'webcam' ? 1 : 0 }} />
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 3 }} />
      <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', zIndex: 4, pointerEvents: 'none' }} />
      {!panelOpen && <button onClick={() => setPanelOpen(true)} style={{ position: 'absolute', top: 16, left: 16, zIndex: 11, ...selStyle, width: 'auto', padding: '8px 12px' }}>☰</button>}
      {panelOpen && (
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, width: 300, background: 'rgba(10,10,16,0.9)', padding: 18, borderRadius: 16, backdropFilter: 'blur(10px)', border: '1px solid rgba(255,60,150,0.22)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', color: '#e8e2ee' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ color: '#ff5aa8', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>🧬 Sculpture · Métamorphe</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link><button onClick={() => setPanelOpen(false)} style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16 }}>«</button></div>
          </div>
          <div style={{ color: error ? '#ff6b6b' : '#8a8598', fontSize: 11, marginBottom: 10, lineHeight: 1.3 }}>{error ?? status} · {count} holons</div>
          <div style={{ fontSize: 10, color: '#ffb0d8', marginBottom: 12, lineHeight: 1.35, background: 'rgba(255,60,150,0.08)', padding: 7, borderRadius: 6 }}>✋ <b>Écarte</b> les mains = ouvre la structure · <b>hauteur</b> = torsion (spirale) · <b>inclinaison</b> = courbure · <b>pince</b> = densité. Ou règle tout aux curseurs.</div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button onClick={mutate} style={{ ...selStyle, flex: 2, background: 'rgba(255,60,150,0.25)', borderColor: 'rgba(255,60,150,0.6)' }}>🧬 Muter</button>
            <button onClick={reset} style={{ ...selStyle, flex: 1 }}>⟲ Zéro</button>
          </div>

          <Field label="Style de métamorphose"><select value={style} onChange={(e) => { const k = e.target.value as StyleKind; const st = STYLES.find((s) => s.kind === k)!; setStyle(k); setHolon(st.holon); setDepth(st.depth); setRadial(st.radial); setMirror(st.mirror); setTwist(st.baseTwist); setBend(st.baseBend) }} style={selStyle}>{STYLES.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}</select></Field>
          <Field label="Holon (forme de base)"><select value={holon} onChange={(e) => setHolon(e.target.value as HolonKind)} style={selStyle}>{HOLONS.map((h) => <option key={h.kind} value={h.kind}>{h.label}</option>)}</select></Field>
          <Field label={`Itérations — ${depth}`}><input type="range" min={2} max={8} step={1} value={depth} onChange={(e) => setDepth(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`Symétrie radiale — ${radial}`}><input type="range" min={1} max={10} step={1} value={radial} onChange={(e) => setRadial(+e.target.value)} style={rngStyle} /></Field>
          <label style={chkRow}><input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} style={{ accentColor: '#ff5aa8' }} /> 🦋 Miroir (symétrie bilatérale)</label>

          <div style={{ fontSize: 10, color: '#ff5aa8', textTransform: 'uppercase', letterSpacing: 1, margin: '12px 0 6px' }}>Métamorphose (mains ou curseurs)</div>
          <label style={chkRow}><input type="checkbox" checked={handDrive} onChange={(e) => setHandDrive(e.target.checked)} style={{ accentColor: '#ff5aa8' }} /> ✋ Piloter aux mains</label>
          <Field label={`Torsion — ${twist.toFixed(2)}`}><input type="range" min={-2.2} max={2.2} step={0.02} value={twist} onChange={(e) => setTwist(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`Courbure — ${bend.toFixed(2)}`}><input type="range" min={-1.6} max={1.6} step={0.02} value={bend} onChange={(e) => setBend(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`Écartement — ${spread.toFixed(2)}`}><input type="range" min={0.2} max={1.6} step={0.02} value={spread} onChange={(e) => setSpread(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`Densité — ${Math.round(growth * 100)}%`}><input type="range" min={0} max={1} step={0.02} value={growth} onChange={(e) => setGrowth(+e.target.value)} style={rngStyle} /></Field>

          <div style={{ fontSize: 10, color: '#ff5aa8', textTransform: 'uppercase', letterSpacing: 1, margin: '12px 0 6px' }}>Matière</div>
          <Field label="Matériau"><select value={material} onChange={(e) => setMaterial(e.target.value as MatKind)} style={selStyle}>{MATERIALS.map((m) => <option key={m.kind} value={m.kind}>{m.label}</option>)}</select></Field>
          <Field label="Couleurs (dégradé par profondeur)"><div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input type="color" value={hexOf(colorA)} onChange={(e) => setColorA(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} /><input type="color" value={hexOf(colorB)} onChange={(e) => setColorB(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} /></div></Field>
          <label style={chkRow}><input type="checkbox" checked={turntable} onChange={(e) => setTurntable(e.target.checked)} style={{ accentColor: '#ff5aa8' }} /> 🎠 Rotation auto</label>
          <label style={chkRow}><input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} style={{ accentColor: '#ff5aa8' }} /> ✋ Squelette des mains</label>
          <Field label="Fond"><select value={bgMode} onChange={(e) => setBgMode(e.target.value as 'webcam' | 'black')} style={selStyle}><option value="black">⬛ Noir</option><option value="webcam">📷 Webcam</option></select></Field>

          <div style={{ fontSize: 10, color: '#ff5aa8', textTransform: 'uppercase', letterSpacing: 1, margin: '12px 0 6px' }}>Export</div>
          <button onClick={() => { recording ? recCtl.current?.stop() : recCtl.current?.start() }} style={{ ...selStyle, marginBottom: 8, background: recording ? 'rgba(255,40,60,0.35)' : 'rgba(255,255,255,0.1)', borderColor: recording ? '#ff2840' : 'rgba(255,255,255,0.2)' }}>{recording ? '⏹ Arrêter l\'enregistrement' : '🔴 Enregistrer une vidéo'}</button>
          <div style={{ display: 'flex', gap: 8 }}><button onClick={exportPng} style={{ ...selStyle, flex: 1 }}>📸 PNG</button><button onClick={() => { exportRef.current = 'glb' }} style={{ ...selStyle, flex: 1 }}>🧬 .glb</button><button onClick={() => { exportRef.current = 'stl' }} style={{ ...selStyle, flex: 1 }} title="Maillage pour impression 3D">🖨️ .stl</button></div>
          <p style={{ color: '#6a6578', fontSize: 10, marginTop: 10, marginBottom: 0, lineHeight: 1.4 }}>Souris : glisser = orbiter · molette = zoom. « Muter » génère une nouvelle espèce.</p>
        </div>
      )}
    </div>
  )
}

function downloadBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500) }
/** color inputs need a #rrggbb — convert an hsl() string if a mutation produced one. */
function hexOf(c: string): string { if (c.startsWith('#')) return c; const m = c.match(/hsl\(([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%/); if (!m) return '#ffffff'; const col = new THREE.Color().setHSL(+m[1] / 360, +m[2] / 100, +m[3] / 100); return '#' + col.getHexString() }
const selStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: 8, borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }
const rngStyle: React.CSSProperties = { width: '100%', accentColor: '#ff5aa8' }
const chkRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#e8e2ee', marginTop: 8, marginBottom: 8, cursor: 'pointer' }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return (<div style={{ marginBottom: 12 }}><div style={{ fontSize: 11, color: '#ff5aa8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>{children}</div>) }
